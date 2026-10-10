// DealApprover persistence contract (M2 #88).
//
// Background: ticket #88 requires a Personal-Workspace-only
// self-service command that creates a `DealApprover` authorization
// AND a `DealApproverAcceptance` evidence row in one PostgreSQL
// transaction. The command is capability-neutral (no Buyer / Seller
// capability is required or implied) and Personal-Workspace-only
// (Organization Workspaces never receive intent-driven authorization
// grants in this slice).
//
// The contract is a single transaction-scoped use case so the
// application can run authorization + persistence in one
// authoritative unit of work:
//
//   - provisionDealApproverInTransaction acquires
//     `SELECT ... FOR UPDATE` row locks on the Workspace row
//     (verifying it is `Personal` + `Active`), the WorkspaceMembership
//     row, and the (workspaceId, userId) `deal_approvers` UNIQUE
//     index. It also pre-checks the
//     (workspaceId, idempotencyKey) `deal_approver_acceptances`
//     UNIQUE index for same-attempt retry convergence.
//   - The use case evaluates the application-owned policy
//     (Personal-Workspace-only, current membership, confirmation
//     version) and returns either `persist` or `reject`.
//   - On persist, the repository inserts the `DealApprover` row AND
//     the `DealApproverAcceptance` evidence row inside the same
//     transaction; the application does NOT separately re-create
//     either row.
//   - The (deal_approvers(workspaceId, userId)) UNIQUE index and
//     the (deal_approver_acceptances(workspaceId, idempotencyKey))
//     UNIQUE index are the second defenses against retries creating
//     duplicate authorizations or duplicate evidence rows.
//
// The repository never decides whether the facts authorize the
// command; the application-owned policy is the only decision point.
//
// The closed confirmation version is `m2-deal-approver-v1`. The
// application boundary rejects any other value with
// `DEAL_APPROVER_CONFIRMATION_VERSION_MISMATCH` (422).

import type { WorkspaceStatusV1, WorkspaceTypeV1 } from "@soundhub/types";

export type DealApproverConfirmationVersionV1 = "m2-deal-approver-v1";

// ---------- Persistence shapes ----------

export interface PersistedDealApprover {
  readonly id: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly grantedByUserId: string;
  readonly grantedAt: Date;
}

export interface PersistedDealApproverAcceptance {
  readonly id: string;
  readonly dealApproverId: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly grantedByUserId: string;
  readonly confirmationVersion: string;
  readonly acceptedAt: Date;
  readonly idempotencyKey: string;
  readonly requestId: string;
}

// ---------- Authority snapshot (locked facts) ----------

export interface DealApproverAuthoritySnapshot {
  readonly userAccountId: string;
  readonly actingWorkspaceId: string;
  readonly workspaceStatus: WorkspaceStatusV1 | null;
  readonly workspaceType: WorkspaceTypeV1 | null;
  readonly isMember: boolean;
  /**
   * True when a `DealApprover` row already exists for the
   * (workspaceId, userId) tuple. A different-key retry against an
   * already-provisioned tuple surfaces a typed
   * `DEAL_APPROVER_ALREADY_PROVISIONED` rejection; a same-key retry
   * converges on the existing row.
   */
  readonly dealApproverExists: boolean;
  /**
   * The existing `DealApprover` row id when `dealApproverExists` is
   * true. Null otherwise.
   */
  readonly dealApproverId: string | null;
  /**
   * The existing `DealApproverAcceptance` row id (for same-key
   * retry convergence) when the (workspaceId, idempotencyKey) row
   * already exists. Null otherwise.
   */
  readonly existingAcceptanceId: string | null;
  readonly existingAcceptanceVersion: string | null;
}

// ---------- Use case inputs ----------

export interface PersistProvisionDealApproverInput {
  readonly workspaceId: string;
  readonly userId: string;
  readonly grantedByUserId: string;
  readonly confirmationVersion: DealApproverConfirmationVersionV1;
  readonly idempotencyKey: string;
  readonly requestId: string;
  readonly now: Date;
}

export interface ProvisionDealApproverTransactionInput {
  readonly userAccountId: string;
  readonly actingWorkspaceId: string;
  readonly confirmationVersion: DealApproverConfirmationVersionV1;
  readonly idempotencyKey: string;
  readonly requestId: string;
  readonly now: Date;
}

// ---------- Use case outcomes ----------

export type ProvisionDealApproverFailureReason =
  | "WORKSPACE_NOT_FOUND"
  | "WORKSPACE_INELIGIBLE"
  | "NOT_A_MEMBER"
  | "NOT_PERSONAL_WORKSPACE"
  | "ALREADY_PROVISIONED"
  | "CONFIRMATION_VERSION_MISMATCH"
  | "CONFLICT"
  | "CONCURRENCY_RETRY_EXHAUSTED";

export interface ProvisionDealApproverResult {
  readonly dealApprover: PersistedDealApprover;
  readonly acceptance: PersistedDealApproverAcceptance;
}

export type ProvisionDealApproverUseCaseContext = {
  readonly authority: DealApproverAuthoritySnapshot;
};

export interface ProvisionDealApproverUseCaseTools {
  reject(reason: ProvisionDealApproverFailureReason): ProvisionDealApproverUseCaseOutcome;
  persist(input: PersistProvisionDealApproverInput): ProvisionDealApproverUseCaseOutcome;
}

export type ProvisionDealApproverUseCaseOutcome =
  | { readonly kind: "reject"; readonly reason: ProvisionDealApproverFailureReason }
  | { readonly kind: "persist"; readonly input: PersistProvisionDealApproverInput };

export type ProvisionDealApproverUseCase = (
  ctx: ProvisionDealApproverUseCaseContext,
  tools: ProvisionDealApproverUseCaseTools,
) => ProvisionDealApproverUseCaseOutcome;

// ---------- Repository contract ----------

export interface DealApproverRepository {
  /**
   * Open one PostgreSQL transaction. Inside the transaction the
   * adapter acquires `SELECT ... FOR UPDATE` row locks on the
   * Workspace row, the WorkspaceMembership row, and the
   * (workspaceId, userId) `deal_approvers` UNIQUE index; the adapter
   * also pre-checks the (workspaceId, idempotencyKey) UNIQUE index
   * for same-attempt retry convergence. The adapter then invokes
   * the supplied `useCase` with the assembled snapshot. The use
   * case is the application-owned policy: it returns either
   * `persist` or `reject`. The adapter persists when the use case
   * persists; the transaction rolls back on any rejection. No
   * partial `DealApprover` or `DealApproverAcceptance` row may
   * remain from a failed attempt.
   */
  provisionDealApproverInTransaction(
    input: ProvisionDealApproverTransactionInput,
    useCase: ProvisionDealApproverUseCase,
  ): Promise<
    | { readonly ok: true; readonly value: ProvisionDealApproverResult }
    | { readonly ok: false; readonly reason: ProvisionDealApproverFailureReason }
  >;

  /**
   * M2 (#88) Codex finding: the DealTermsService needs a
   * derived signal for the acting Workspace's authorization
   * state on this human (`actingSideHasDealApprover`) so the
   * web can render the permission CTA and the approve CTA
   * MUTUALLY EXCLUSIVELY. The repository is the canonical
   * owner of the `deal_approvers` row keyed by
   * (workspaceId, userId); the lookup is read-only and does
   * NOT take any FOR UPDATE locks. The service fails closed
   * on a database error so the page surfaces a generic 5xx
   * rather than silently flipping the predicate.
   *
   * The (workspaceId, userId) tuple is the same one the
   * existing `provisionDealApproverInTransaction` writes
   * against, so the contract is identical to the durable
   * authorization state.
   */
  findDealApprover(input: {
    readonly workspaceId: string;
    readonly userId: string;
  }): Promise<PersistedDealApprover | null>;
}
