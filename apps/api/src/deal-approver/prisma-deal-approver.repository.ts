// Prisma adapter for DealApproverRepository (M2 #88).
//
// Background: ticket #88 requires a Personal-Workspace-only
// self-service command that creates a `DealApprover` authorization
// AND a `DealApproverAcceptance` evidence row in one PostgreSQL
// transaction. This module is the only place the provisioning
// boundary touches Prisma. Higher layers depend on
// `DealApproverRepository`; tests can swap in the in-memory
// adapter without changing the service or route code.
//
// Architectural split:
//
//   - The application owns the authorization policy (see
//     `./deal-approver-authorization-policy.ts`). The pure
//     evaluator (Personal-Workspace + Active + current member + no
//     existing DealApprover) lives there and is invoked by the
//     service's use-case closure.
//
//   - The repository owns the transaction boundary and the
//     locked-fact reads. Inside one `$transaction` it acquires
//     `SELECT ... FOR UPDATE` row locks on the Workspace row +
//     the WorkspaceMembership row + the (workspaceId, userId)
//     `deal_approvers` UNIQUE index, and pre-checks the
//     (workspaceId, idempotencyKey) `deal_approver_acceptances`
//     UNIQUE index for same-attempt retry convergence. The
//     adapter then invokes the supplied `useCase` with the
//     assembled snapshot. The use case evaluates the policy
//     helper and returns either `persist` or `reject`. The
//     repository persists only when the use case persists; the
//     transaction rolls back on any rejection.
//
//   - The Prisma adapter never decides whether the facts authorize
//     the command. The application-owned policy is the only
//     decision point.
//
// All consequential writes are wrapped in the same transaction.
// The (deal_approvers(workspaceId, userId)) UNIQUE index and the
// (deal_approver_acceptances(workspaceId, idempotencyKey)) UNIQUE
// index are the second defenses against retries creating duplicate
// authorizations or duplicate evidence rows.
//
// Serializable concurrency (P1-001):
//
//   The transactional command method opens a PostgreSQL transaction
//   with `Serializable` isolation. A conflicting commit on any row
//   the transaction read produces a Prisma `P2034`
//   (serialization_failure / write conflict) error on COMMIT. The
//   adapter retries the bounded transaction a small fixed number
//   of times; each retry re-reads authoritative current facts via
//   FOR UPDATE so a revocation that committed between attempts is
//   reflected in the next snapshot. After the retry budget is
//   exhausted the adapter surfaces a safe typed failure reason
//   (CONCURRENCY_RETRY_EXHAUSTED) so the application route layer
//   maps it onto the existing safe envelope. NO partial
//   `DealApprover` or `DealApproverAcceptance` row may remain
//   from a failed attempt — the bounded transaction guarantees an
//   all-or-nothing outcome on every attempt.

import type { PrismaClient } from "@soundhub/db";
import { PrismaClientKnownRequestError } from "@soundhub/db/dist/generated/internal/prismaNamespace.js";
import type {
  DealApproverAuthoritySnapshot,
  DealApproverRepository,
  PersistProvisionDealApproverInput,
  PersistedDealApprover,
  PersistedDealApproverAcceptance,
  ProvisionDealApproverFailureReason,
  ProvisionDealApproverResult,
  ProvisionDealApproverTransactionInput,
  ProvisionDealApproverUseCase,
  ProvisionDealApproverUseCaseOutcome,
  ProvisionDealApproverUseCaseTools,
} from "./deal-approver.repository.js";

// Small fixed maximum. Mirrors the BG4 retry budget; not a
// generalized retry framework.
const P2034_RETRY_BUDGET = 3;

const CONCURRENCY_RETRY_EXHAUSTED: ProvisionDealApproverFailureReason =
  "CONCURRENCY_RETRY_EXHAUSTED";

/**
 * Returns true when the Prisma error is a serialization_failure
 * (write conflict) under PostgreSQL Serializable isolation. See
 * `apps/api/src/project-request/prisma-project-request.repository.ts`
 * for the rationale and the fallback pattern.
 */
function isSerializationConflict(err: unknown): boolean {
  if (err instanceof PrismaClientKnownRequestError) {
    if (err.code === "P2034" || err.code === "40001" || err.code === "40P01") return true;
  }
  if (
    err instanceof Error &&
    /40001|serialization_failure|write conflict|P2034/i.test(err.message)
  ) {
    return true;
  }
  return false;
}

interface BoundedRetryEnvelope<TValue, TFailure> {
  readonly outcome:
    | { readonly kind: "value"; readonly value: TValue }
    | { readonly kind: "exhausted"; readonly failure: TFailure };
}
async function runWithBoundedP2034Retry<TValue, TFailure>(
  attempt: () => Promise<TValue>,
  buildFailure: () => TFailure,
): Promise<BoundedRetryEnvelope<TValue, TFailure>> {
  for (let attemptIndex = 0; attemptIndex < P2034_RETRY_BUDGET; attemptIndex += 1) {
    try {
      return { outcome: { kind: "value", value: await attempt() } };
    } catch (err) {
      if (!isSerializationConflict(err)) throw err;
    }
  }
  return { outcome: { kind: "exhausted", failure: buildFailure() } };
}

export class PrismaDealApproverRepository implements DealApproverRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async provisionDealApproverInTransaction(
    input: ProvisionDealApproverTransactionInput,
    useCase: ProvisionDealApproverUseCase,
  ): Promise<
    | { readonly ok: true; readonly value: ProvisionDealApproverResult }
    | { readonly ok: false; readonly reason: ProvisionDealApproverFailureReason }
  > {
    const envelope = await runWithBoundedP2034Retry<
      | { readonly ok: true; readonly value: ProvisionDealApproverResult }
      | { readonly ok: false; readonly reason: ProvisionDealApproverFailureReason },
      ProvisionDealApproverFailureReason
    >(
      () => this.runProvisionTransactionOnce(input, useCase),
      () => CONCURRENCY_RETRY_EXHAUSTED,
    );
    if (envelope.outcome.kind === "exhausted") {
      return { ok: false, reason: envelope.outcome.failure };
    }
    return envelope.outcome.value;
  }

  private async runProvisionTransactionOnce(
    input: ProvisionDealApproverTransactionInput,
    useCase: ProvisionDealApproverUseCase,
  ): Promise<
    | { readonly ok: true; readonly value: ProvisionDealApproverResult }
    | { readonly ok: false; readonly reason: ProvisionDealApproverFailureReason }
  > {
    try {
      const result = await this.prisma.$transaction(
        async (tx) => {
          // Step 1: FOR UPDATE-lock the Workspace row + the
          // (workspaceId, userId) `deal_approvers` index. We
          // intentionally read the Workspace fields + lock the
          // `deal_approvers` UNIQUE index in a single raw query so
          // a concurrent revoke / suspension / capability change
          // blocks until our transaction completes.
          const workspaceRows = await tx.$queryRaw<
            {
              readonly id: string;
              readonly status: "Active" | "Suspended";
              readonly type: "Personal" | "Organization";
            }[]
          >`SELECT id, status, type FROM workspaces WHERE id = ${input.actingWorkspaceId} FOR UPDATE`;
          const workspace = workspaceRows[0];

          // Lock the WorkspaceMembership row for the acting
          // (userId, workspaceId) tuple. A concurrent revoke
          // must wait for our transaction.
          const membershipRows = await tx.$queryRaw<{ readonly id: string }[]>`
            SELECT id FROM workspace_memberships
            WHERE "userId" = ${input.userAccountId} AND "workspaceId" = ${input.actingWorkspaceId}
            FOR UPDATE
          `;
          const isMember = membershipRows.length > 0;

          // Lock the (workspaceId, userId) `deal_approvers` UNIQUE
          // index. A concurrent provisioning attempt for the same
          // tuple blocks until our transaction completes.
          const existingApproverRows = await tx.$queryRaw<
            { readonly id: string }[]
          >`SELECT id FROM deal_approvers
             WHERE "workspaceId" = ${input.actingWorkspaceId}
               AND "userId" = ${input.userAccountId}
             FOR UPDATE`;
          const dealApproverExists = existingApproverRows.length > 0;
          const dealApproverId = existingApproverRows[0]?.id ?? null;

          // Pre-check the (workspaceId, idempotencyKey) UNIQUE
          // index for same-attempt retry convergence. A same-key
          // retry converges on the existing row by the
          // application policy: we short-circuit and return the
          // pre-existing pair without re-running the use case.
          // The UNIQUE index remains the second defense — a
          // race that slips past the pre-check fails the INSERT
          // and is mapped to `CONFLICT`.
          const existingAcceptanceRows = await tx.$queryRaw<
            {
              readonly id: string;
              readonly dealApproverId: string;
              readonly confirmationVersion: string;
            }[]
          >`SELECT id, "dealApproverId", "confirmationVersion"
             FROM deal_approver_acceptances
             WHERE "workspaceId" = ${input.actingWorkspaceId}
               AND "idempotencyKey" = ${input.idempotencyKey}
             FOR UPDATE`;
          const existingAcceptance = existingAcceptanceRows[0] ?? null;

          if (existingAcceptance !== null) {
            // M2 (#88) Codex finding (post 8d1ac3b): same-key
            // replay MUST revalidate current Workspace
            // membership + status + the persisted row's
            // (workspaceId, userId) tuple. A revoked member,
            // suspended Workspace, or tuple-mismatched
            // acceptance fails closed instead of returning a
            // stale authorization.
            //
            // Re-verify the Workspace is Active.
            const workspaceStatusRows = await tx.$queryRaw<
              { readonly status: "Active" | "Suspended" }[]
            >`SELECT status FROM workspaces WHERE id = ${input.actingWorkspaceId} FOR UPDATE`;
            if (workspaceStatusRows.length === 0 || workspaceStatusRows[0]?.status !== "Active") {
              return { ok: false as const, reason: "WORKSPACE_INELIGIBLE" as const };
            }
            // Re-verify current membership for the EXACT
            // (userId, workspaceId) tuple.
            const membershipRows = await tx.$queryRaw<{ readonly id: string }[]>`
              SELECT id FROM workspace_memberships
              WHERE "userId" = ${input.userAccountId}
                AND "workspaceId" = ${input.actingWorkspaceId}
              FOR UPDATE`;
            if (membershipRows.length === 0) {
              return { ok: false as const, reason: "NOT_A_MEMBER" as const };
            }
            // Look up the persisted `DealApprover` row and
            // verify its (workspaceId, userId) tuple still
            // matches the current command — defends against a
            // historic write that was created under a different
            // tuple (e.g. the user re-keyed the idempotencyKey
            // path while the database was migrated).
            const existingDa = await tx.dealApprover.findUnique({
              where: { id: existingAcceptance.dealApproverId },
            });
            if (existingDa === null) {
              return { ok: false as const, reason: "CONFLICT" as const };
            }
            if (
              existingDa.workspaceId !== input.actingWorkspaceId ||
              existingDa.userId !== input.userAccountId
            ) {
              return { ok: false as const, reason: "CONFLICT" as const };
            }
            return {
              ok: true as const,
              value: {
                dealApprover: toPersistedDealApprover(existingDa),
                acceptance: {
                  id: existingAcceptance.id,
                  dealApproverId: existingAcceptance.dealApproverId,
                  workspaceId: input.actingWorkspaceId,
                  userId: input.userAccountId,
                  grantedByUserId: input.userAccountId,
                  confirmationVersion: existingAcceptance.confirmationVersion,
                  acceptedAt: existingDa.grantedAt,
                  idempotencyKey: input.idempotencyKey,
                  requestId: input.requestId,
                },
              },
            };
          }

          const snapshot: DealApproverAuthoritySnapshot = {
            userAccountId: input.userAccountId,
            actingWorkspaceId: input.actingWorkspaceId,
            workspaceStatus: workspace?.status ?? null,
            workspaceType: workspace?.type ?? null,
            isMember,
            dealApproverExists,
            dealApproverId,
            existingAcceptanceId: null,
            existingAcceptanceVersion: null,
          };

          // Step 2: hand the snapshot to the application-owned use
          // case. The repository MUST NOT decide whether the
          // facts authorize the command.
          const tools: ProvisionDealApproverUseCaseTools = {
            reject: (reason): ProvisionDealApproverUseCaseOutcome => ({
              kind: "reject",
              reason,
            }),
            persist: (persistInput): ProvisionDealApproverUseCaseOutcome => ({
              kind: "persist",
              input: persistInput,
            }),
          };
          const outcome = useCase({ authority: snapshot }, tools);

          if (outcome.kind === "reject") {
            return { ok: false as const, reason: outcome.reason };
          }

          // Step 3: persist both rows in the same transaction. The
          // (deal_approvers(workspaceId, userId)) UNIQUE index +
          // (deal_approver_acceptances(workspaceId, idempotencyKey))
          // UNIQUE index are the second defenses against retries
          // creating duplicate rows.
          try {
            const dealApprover = await tx.dealApprover.create({
              data: {
                workspaceId: outcome.input.workspaceId,
                userId: outcome.input.userId,
                grantedByUserId: outcome.input.grantedByUserId,
                grantedAt: outcome.input.now,
              },
            });
            const acceptance = await tx.dealApproverAcceptance.create({
              data: {
                dealApproverId: dealApprover.id,
                workspaceId: outcome.input.workspaceId,
                userId: outcome.input.userId,
                grantedByUserId: outcome.input.grantedByUserId,
                confirmationVersion: outcome.input.confirmationVersion,
                acceptedAt: outcome.input.now,
                idempotencyKey: outcome.input.idempotencyKey,
                requestId: outcome.input.requestId,
              },
            });
            return {
              ok: true as const,
              value: {
                dealApprover: toPersistedDealApprover(dealApprover),
                acceptance: toPersistedDealApproverAcceptance(acceptance),
              },
            };
          } catch (err) {
            if (err instanceof PrismaClientKnownRequestError && err.code === "P2002") {
              return { ok: false as const, reason: "CONFLICT" as const };
            }
            throw err;
          }
        },
        { isolationLevel: "Serializable" },
      );
      return result;
    } catch (err) {
      if (err instanceof PrismaClientKnownRequestError && err.code === "P2002") {
        return { ok: false, reason: "CONFLICT" };
      }
      throw err;
    }
  }

  async findDealApprover(input: {
    readonly workspaceId: string;
    readonly userId: string;
  }): Promise<PersistedDealApprover | null> {
    // Read-only lookup against the durable (workspaceId, userId)
    // index. The query does NOT take FOR UPDATE locks; it is
    // served from a fresh snapshot. The (workspaceId, userId)
    // UNIQUE index guarantees the result is at most one row.
    const row = await this.prisma.dealApprover.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId: input.workspaceId,
          userId: input.userId,
        },
      },
    });
    if (row === null) return null;
    return toPersistedDealApprover(row);
  }
}

function toPersistedDealApprover(row: {
  readonly id: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly grantedByUserId: string;
  readonly grantedAt: Date;
}): PersistedDealApprover {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    userId: row.userId,
    grantedByUserId: row.grantedByUserId,
    grantedAt: row.grantedAt,
  };
}

function toPersistedDealApproverAcceptance(row: {
  readonly id: string;
  readonly dealApproverId: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly grantedByUserId: string;
  readonly confirmationVersion: string;
  readonly acceptedAt: Date;
  readonly idempotencyKey: string;
  readonly requestId: string;
}): PersistedDealApproverAcceptance {
  return {
    id: row.id,
    dealApproverId: row.dealApproverId,
    workspaceId: row.workspaceId,
    userId: row.userId,
    grantedByUserId: row.grantedByUserId,
    confirmationVersion: row.confirmationVersion,
    acceptedAt: row.acceptedAt,
    idempotencyKey: row.idempotencyKey,
    requestId: row.requestId,
  };
}

// Unused helper to keep the imports tight; the persist input is
// re-exported so the service contract imports stay small.
export type { PersistProvisionDealApproverInput };
