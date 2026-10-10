// DealApprover JIT permission setup service (M2 #88).
//
// Background: ticket #88 acceptance requires a Personal-Workspace-
// only, capability-neutral, self-service command that creates a
// `DealApprover` authorization AND a `DealApproverAcceptance`
// evidence row in one PostgreSQL transaction. The service composes:
//
//   - the application-owned policy evaluator in
//     `./deal-approver-authorization-policy.ts` (Personal-Workspace
//     + Active + current member + no existing DealApprover), and
//   - the transaction-scoped repository method in
//     `./deal-approver.repository.ts` (one PostgreSQL transaction per
//     command, FOR UPDATE-locked fact reads, guarded persistence).
//
// For each consequential command the service supplies a pure
// use-case closure that consumes the snapshot the repository loads
// inside its transaction and returns either a `persist` verdict or
// a `reject` verdict. The repository never decides whether the
// facts authorize the command; the service owns that decision.
//
// The service is intentionally separate from DealTermsService so
// the Provisioning command does NOT have a dependency on
// `DealTermsAiAdapter` or any TermsVersion row. Provisioning is
// independent of any pending Deal; the human is provisioned
// against their own Personal Workspace and returns to the same
// pending Deal / current TermsVersion afterwards (per the
// reconciled M2 specification).
//
// The service does NOT create a `DealApproval`. Approval is
// governed by BG5's `recordApprovalInTransaction`; the JIT setup
// command only creates the `DealApprover` authorization that the
// approval command later resolves to.

import type { DealApproverPublicV1 } from "@soundhub/types";
import {
  evaluateProvisionDealApproverAuthority,
  type ProvisionDealApproverVerdict,
} from "./deal-approver-authorization-policy.js";
import type {
  DealApproverRepository,
  PersistProvisionDealApproverInput,
  ProvisionDealApproverFailureReason,
  ProvisionDealApproverResult,
  ProvisionDealApproverUseCase,
  ProvisionDealApproverUseCaseContext,
  ProvisionDealApproverUseCaseOutcome,
  ProvisionDealApproverUseCaseTools,
} from "./deal-approver.repository.js";

export class DealApproverError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "DEAL_APPROVER_INVALID"
      | "DEAL_APPROVER_FORBIDDEN"
      | "DEAL_APPROVER_ALREADY_PROVISIONED"
      | "DEAL_APPROVER_CONFIRMATION_VERSION_MISMATCH"
      | "DEAL_APPROVER_INTERNAL_FAILED",
  ) {
    super(message);
    this.name = "DealApproverError";
  }
}

export interface DealApproverServiceDeps {
  readonly dealApproverRepository: DealApproverRepository;
}

export interface ProvisionDealApproverInput {
  readonly userAccountId: string;
  readonly actingWorkspaceId: string;
  readonly confirmationVersion: "m2-deal-approver-v1";
  readonly idempotencyKey: string;
  readonly requestId: string;
  readonly now?: Date;
}

export class DealApproverService {
  private readonly repository: DealApproverRepository;
  private readonly now: () => Date;

  constructor(deps: DealApproverServiceDeps) {
    this.repository = deps.dealApproverRepository;
    this.now = () => new Date();
  }

  /**
   * Provision a `DealApprover` authorization for the acting
   * Personal-Workspace human member.
   *
   * Flow:
   *   1. Open one transaction via
   *      `provisionDealApproverInTransaction`. The repository FOR
   *      UPDATE-locks the Workspace row, the WorkspaceMembership
   *      row, and the (workspaceId, userId) `deal_approvers`
   *      UNIQUE index, and pre-checks the
   *      (workspaceId, idempotencyKey) `deal_approver_acceptances`
   *      UNIQUE index for same-attempt retry convergence.
   *   2. The use case evaluates the application-owned
   *      `evaluateProvisionDealApproverAuthority` policy and
   *      either calls `persist` or surfaces a rejection.
   *   3. The repository persists the `DealApprover` row AND the
   *      `DealApproverAcceptance` evidence row inside the same
   *      transaction. NO `DealApproval` is created — provisioning
   *      is not approval (per the M2 authority invariants).
   *
   * A same-attempt retry (same `idempotencyKey` against the same
   * `actingWorkspaceId` and `userAccountId`) converges on the
   * existing rows and does NOT surface an error. A different-key
   * retry against an already-provisioned (workspaceId, userId)
   * tuple surfaces `DEAL_APPROVER_ALREADY_PROVISIONED` (409).
   */
  async provisionDealApprover(
    input: ProvisionDealApproverInput,
  ): Promise<{ readonly dealApprover: DealApproverPublicV1 }> {
    const now = input.now ?? this.now();

    const useCase: ProvisionDealApproverUseCase = (
      ctx: ProvisionDealApproverUseCaseContext,
      tools: ProvisionDealApproverUseCaseTools,
    ): ProvisionDealApproverUseCaseOutcome => {
      const verdict: ProvisionDealApproverVerdict = evaluateProvisionDealApproverAuthority(
        ctx.authority,
      );
      if (!verdict.ok) {
        return tools.reject(verdict.reason);
      }
      const persistInput: PersistProvisionDealApproverInput = {
        workspaceId: input.actingWorkspaceId,
        userId: input.userAccountId,
        // For Personal-Workspace self-service the granting human
        // IS the human accepting the versioned attestation. A
        // future Organization-grant flow would populate this from
        // the granting Owner/Admin.
        grantedByUserId: input.userAccountId,
        confirmationVersion: input.confirmationVersion,
        idempotencyKey: input.idempotencyKey,
        requestId: input.requestId,
        now,
      };
      return tools.persist(persistInput);
    };

    const result = await this.repository.provisionDealApproverInTransaction(
      {
        userAccountId: input.userAccountId,
        actingWorkspaceId: input.actingWorkspaceId,
        confirmationVersion: input.confirmationVersion,
        idempotencyKey: input.idempotencyKey,
        requestId: input.requestId,
        now,
      },
      useCase,
    );

    if (!result.ok) {
      throw this.failureToServiceError(result.reason);
    }
    return { dealApprover: toPublicDealApprover(result.value.dealApprover) };
  }

  private failureToServiceError(reason: ProvisionDealApproverFailureReason): DealApproverError {
    switch (reason) {
      case "WORKSPACE_NOT_FOUND":
        return new DealApproverError(
          "The acting Workspace does not exist.",
          "DEAL_APPROVER_FORBIDDEN",
        );
      case "WORKSPACE_INELIGIBLE":
        return new DealApproverError(
          "The acting Workspace is not eligible to act in the marketplace.",
          "DEAL_APPROVER_FORBIDDEN",
        );
      case "NOT_A_MEMBER":
        return new DealApproverError(
          "You are not a current member of this Workspace.",
          "DEAL_APPROVER_FORBIDDEN",
        );
      case "NOT_PERSONAL_WORKSPACE":
        return new DealApproverError(
          "Permission to approve terms can only be set up on a Personal Workspace.",
          "DEAL_APPROVER_FORBIDDEN",
        );
      case "ALREADY_PROVISIONED":
        return new DealApproverError(
          "Permission to approve terms has already been set up for this human on this Workspace.",
          "DEAL_APPROVER_ALREADY_PROVISIONED",
        );
      case "CONFLICT":
        // Defensive guard: the (workspaceId, idempotencyKey) UNIQUE
        // index tripped at the DB level even though the
        // pre-transaction check passed. Collapse to the typed
        // 409 envelope so the safe response does not leak
        // internal counter / collision state.
        return new DealApproverError(
          "Permission to approve terms has already been set up with this idempotency key.",
          "DEAL_APPROVER_ALREADY_PROVISIONED",
        );
      case "CONCURRENCY_RETRY_EXHAUSTED":
        return new DealApproverError(
          "The marketplace is busy; please retry.",
          "DEAL_APPROVER_INTERNAL_FAILED",
        );
      case "CONFIRMATION_VERSION_MISMATCH":
        // The application boundary rejects any non-canonical
        // `confirmationVersion` before the repository runs; this
        // branch exists for completeness.
        return new DealApproverError(
          "The current version of the approval-authority attestation has changed. Please reload and try again.",
          "DEAL_APPROVER_CONFIRMATION_VERSION_MISMATCH",
        );
    }
  }
}

export function toPublicDealApprover(persisted: {
  readonly id: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly grantedAt: Date;
}): DealApproverPublicV1 {
  return {
    dealApproverId: persisted.id,
    workspaceId: persisted.workspaceId,
    userId: persisted.userId,
    grantedAt: persisted.grantedAt.toISOString(),
  };
}

export type { ProvisionDealApproverResult };
