// In-memory DealApproverRepository for unit tests.
//
// Background: the DealApprover service tests run without a database.
// The in-memory adapter mirrors the Prisma adapter's contract
// surface so tests can substitute it without changing the service
// or route code.
//
// The Prisma adapter is the canonical implementation; this is for
// unit tests only.
//
// --- Guarantee parity (deliberately conservative) ---
//
// The in-memory adapter simulates per-test synchronization with a
// single-flight mutex so concurrent unit tests do not see stale
// authority facts. It does NOT replicate PostgreSQL's MVCC
// snapshots, serializable isolation, or row-level locking
// semantics. Any interleaving test that depends on real
// concurrency MUST run against the Prisma adapter; the in-memory
// adapter is only sufficient for the service-level policy tests
// that exercise a single transaction at a time.

import { randomUUID } from "node:crypto";
import type {
  DealApproverAuthoritySnapshot,
  DealApproverRepository,
  PersistedDealApprover,
  PersistedDealApproverAcceptance,
  ProvisionDealApproverFailureReason,
  ProvisionDealApproverResult,
  ProvisionDealApproverTransactionInput,
  ProvisionDealApproverUseCase,
  ProvisionDealApproverUseCaseOutcome,
  ProvisionDealApproverUseCaseTools,
} from "./deal-approver.repository.js";

export type ProvisionDealApproverResultEnvelope =
  | { readonly ok: true; readonly value: ProvisionDealApproverResult }
  | { readonly ok: false; readonly reason: ProvisionDealApproverFailureReason };
import type { WorkspaceStatusV1, WorkspaceTypeV1 } from "@soundhub/types";

export interface DealApproverWorkspaceSeed {
  readonly workspaceId: string;
  readonly status: WorkspaceStatusV1;
  readonly type: WorkspaceTypeV1;
}

export interface DealApproverMembershipSeed {
  readonly userId: string;
  readonly workspaceId: string;
}

export class InMemoryDealApproverRepository implements DealApproverRepository {
  private readonly dealApprovers = new Map<string, PersistedDealApprover>();
  private readonly acceptances = new Map<string, PersistedDealApproverAcceptance>();
  private readonly workspaces = new Map<string, DealApproverWorkspaceSeed>();
  private readonly memberships = new Map<string, DealApproverMembershipSeed>();
  /** Single-flight mutex so a single in-memory test cannot interleave
   *  authority mutations with a running use case. NOT a real-MVCC
   *  guarantee — see the header comment. */
  private inflight = false;

  seedWorkspace(input: DealApproverWorkspaceSeed): void {
    this.workspaces.set(input.workspaceId, input);
  }

  seedMembership(input: DealApproverMembershipSeed): void {
    this.memberships.set(this.membershipKey(input.userId, input.workspaceId), input);
  }

  removeMembership(userId: string, workspaceId: string): void {
    this.memberships.delete(this.membershipKey(userId, workspaceId));
  }

  seedDealApprover(input: PersistedDealApprover): void {
    this.dealApprovers.set(input.id, input);
  }

  seedAcceptance(input: PersistedDealApproverAcceptance): void {
    this.acceptances.set(input.id, input);
  }

  // ---------- Transaction ----------

  provisionDealApproverInTransaction(
    input: ProvisionDealApproverTransactionInput,
    useCase: ProvisionDealApproverUseCase,
  ): Promise<ProvisionDealApproverResultEnvelope> {
    if (this.inflight) {
      throw new Error(
        "In-memory DealApproverRepository already has an inflight transaction; " +
          "the in-memory adapter does not serialize concurrent transactions.",
      );
    }
    this.inflight = true;
    try {
      // Build the locked snapshot from in-memory state.
      const workspace = this.workspaces.get(input.actingWorkspaceId);
      const isMember = this.memberships.has(
        this.membershipKey(input.userAccountId, input.actingWorkspaceId),
      );
      // (workspaceId, userId) UNIQUE index — second defense.
      let dealApproverExists = false;
      let dealApproverId: string | null = null;
      for (const da of this.dealApprovers.values()) {
        if (da.workspaceId === input.actingWorkspaceId && da.userId === input.userAccountId) {
          dealApproverExists = true;
          dealApproverId = da.id;
          break;
        }
      }
      // (workspaceId, idempotencyKey) UNIQUE index — second
      // defense. A same-key retry converges on the existing row
      // by the policy evaluator: the pre-check finds the
      // acceptance and we return its associated DealApprover. We
      // pre-check here so a different-key retry against an
      // already-provisioned tuple does NOT silently re-insert the
      // (workspaceId, userId) row.
      let existingAcceptanceId: string | null = null;
      let existingAcceptanceVersion: string | null = null;
      let existingAcceptanceRow: PersistedDealApproverAcceptance | null = null;
      for (const acc of this.acceptances.values()) {
        if (
          acc.workspaceId === input.actingWorkspaceId &&
          acc.idempotencyKey === input.idempotencyKey
        ) {
          existingAcceptanceId = acc.id;
          existingAcceptanceVersion = acc.confirmationVersion;
          existingAcceptanceRow = acc;
          break;
        }
      }
      const snapshot: DealApproverAuthoritySnapshot = {
        userAccountId: input.userAccountId,
        actingWorkspaceId: input.actingWorkspaceId,
        workspaceStatus: workspace?.status ?? null,
        workspaceType: workspace?.type ?? null,
        isMember,
        dealApproverExists,
        dealApproverId,
        existingAcceptanceId,
        existingAcceptanceVersion,
      };

      // Same-key retry convergence: if the same (workspaceId,
      // idempotencyKey) acceptance row already exists, return the
      // pre-existing DealApprover + acceptance pair without
      // re-running the use case. This is the unit-test mirror of
      // the durable convergence guarantee; the (workspaceId,
      // idempotencyKey) UNIQUE index on the persisted table is the
      // authoritative source of truth in production.
      if (existingAcceptanceRow !== null) {
        // M2 (#88) Codex finding (post 8d1ac3b): same-key
        // replay MUST revalidate current Workspace
        // membership + status + the persisted row's
        // (workspaceId, userId) tuple. A revoked member,
        // suspended Workspace, or tuple-mismatched
        // acceptance fails closed instead of returning a
        // stale authorization.
        const replayWorkspace = this.workspaces.get(input.actingWorkspaceId);
        if (replayWorkspace === undefined || replayWorkspace.status !== "Active") {
          return Promise.resolve({ ok: false, reason: "WORKSPACE_INELIGIBLE" });
        }
        const memberKey = this.membershipKey(input.userAccountId, input.actingWorkspaceId);
        if (!this.memberships.has(memberKey)) {
          return Promise.resolve({ ok: false, reason: "NOT_A_MEMBER" });
        }
        const existing = this.dealApprovers.get(existingAcceptanceRow.dealApproverId);
        if (existing === undefined) {
          return Promise.resolve({ ok: false, reason: "CONFLICT" });
        }
        if (
          existing.workspaceId !== input.actingWorkspaceId ||
          existing.userId !== input.userAccountId
        ) {
          return Promise.resolve({ ok: false, reason: "CONFLICT" });
        }
        return Promise.resolve({
          ok: true,
          value: {
            dealApprover: existing,
            acceptance: existingAcceptanceRow,
          },
        });
      }

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
        return Promise.resolve({ ok: false, reason: outcome.reason });
      }

      // Persist both rows inside the single in-memory "transaction"
      // (the in-flight mutex is the serialization primitive).
      const dealApprover: PersistedDealApprover = {
        id: `da-${randomUUID()}`,
        workspaceId: outcome.input.workspaceId,
        userId: outcome.input.userId,
        grantedByUserId: outcome.input.grantedByUserId,
        grantedAt: outcome.input.now,
      };
      this.dealApprovers.set(dealApprover.id, dealApprover);
      const acceptance: PersistedDealApproverAcceptance = {
        id: `daa-${randomUUID()}`,
        dealApproverId: dealApprover.id,
        workspaceId: outcome.input.workspaceId,
        userId: outcome.input.userId,
        grantedByUserId: outcome.input.grantedByUserId,
        confirmationVersion: outcome.input.confirmationVersion,
        acceptedAt: outcome.input.now,
        idempotencyKey: outcome.input.idempotencyKey,
        requestId: outcome.input.requestId,
      };
      this.acceptances.set(acceptance.id, acceptance);
      return Promise.resolve({ ok: true, value: { dealApprover, acceptance } });
    } finally {
      this.inflight = false;
    }
  }

  // ---------- helpers ----------

  // M2 (#88) Codex finding: the DealTermsService needs a derived
  // signal for the acting Workspace's authorization state on
  // this human (`actingSideHasDealApprover`) so the web can
  // render the permission CTA and the approve CTA MUTUALLY
  // EXCLUSIVELY. The in-memory adapter mirrors the Prisma
  // adapter's read-only `findUnique`-equivalent lookup.
  findDealApprover(input: {
    readonly workspaceId: string;
    readonly userId: string;
  }): Promise<PersistedDealApprover | null> {
    for (const da of this.dealApprovers.values()) {
      if (da.workspaceId === input.workspaceId && da.userId === input.userId) {
        return Promise.resolve(da);
      }
    }
    return Promise.resolve(null);
  }

  private membershipKey(userId: string, workspaceId: string): string {
    return `${userId}|${workspaceId}`;
  }

  // Expose the acceptance index for test inspection.
  findAcceptanceByIdempotencyKey(
    workspaceId: string,
    idempotencyKey: string,
  ): PersistedDealApproverAcceptance | null {
    for (const acc of this.acceptances.values()) {
      if (acc.workspaceId === workspaceId && acc.idempotencyKey === idempotencyKey) {
        return acc;
      }
    }
    return null;
  }
}
