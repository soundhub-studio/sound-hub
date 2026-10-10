// DealApprover authorization policy (M2 #88).
//
// Background: ticket #88 requires a Personal-Workspace-only,
// capability-neutral, self-service command that creates a
// `DealApprover` authorization. The command is open to the acting
// Personal Workspace member who is acting on their own behalf
// (the persisted `grantedByUserId` is the same as the
// `userId`). Organization Workspaces never receive intent-driven
// authorization grants in this slice.
//
// This module is the single source of truth for the policy: every
// consequential provisioning use case runs through these pure
// evaluators. The repository adapter loads the snapshot rows
// inside its transaction and calls these helpers to obtain the
// application-owned verdict; the adapter MUST NOT make the
// authorization decision itself.
//
// The policy decision is intentionally pure:
//   - it operates on snapshot rows the caller already holds
//   - it does not consult any external state
//   - it returns a discriminated verdict the repository maps onto
//     its own typed failure reasons
//
// New evaluators added here must remain pure and additive.

import type { WorkspaceStatusV1, WorkspaceTypeV1 } from "@soundhub/types";
import type { DealApproverAuthoritySnapshot } from "./deal-approver.repository.js";

export type ProvisionDealApproverVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason:
        | "WORKSPACE_NOT_FOUND"
        | "WORKSPACE_INELIGIBLE"
        | "NOT_A_MEMBER"
        | "NOT_PERSONAL_WORKSPACE"
        | "ALREADY_PROVISIONED"
        | "CONFIRMATION_VERSION_MISMATCH";
    };

/**
 * Apply the provisioning policy to a FOR UPDATE-locked snapshot.
 *
 * The repository supplies the snapshot; this function decides
 * whether those facts authorize the command.
 *
 * Rules (per ticket #88):
 *   1. The Workspace must exist (`workspaceStatus` is non-null).
 *   2. The Workspace must be `Active`.
 *   3. The acting user must be a current member of that exact
 *      Workspace.
 *   4. The Workspace must be `Personal` (Organization Workspaces
 *      never receive intent-driven authorization grants in this
 *      slice).
 *   5. No `DealApprover` row may already exist for the
 *      (workspaceId, userId) tuple. A same-key retry against the
 *      SAME idempotencyKey converges on the existing row (handled
 *      by the repository, not here).
 *
 * `CONFIRMATION_VERSION_MISMATCH` is detected at the application
 * boundary (the route) and never reaches this evaluator; the
 * repository only ever sees the closed canonical version.
 *
 * `Workspace.ownerUserId` is never read; a matching legacy owner
 * without a current membership fails this call with `NOT_A_MEMBER`.
 */
export function evaluateProvisionDealApproverAuthority(
  snapshot: DealApproverAuthoritySnapshot,
): ProvisionDealApproverVerdict {
  if (snapshot.workspaceStatus === null) {
    return { ok: false, reason: "WORKSPACE_NOT_FOUND" };
  }
  if (snapshot.workspaceStatus !== "Active") {
    return { ok: false, reason: "WORKSPACE_INELIGIBLE" };
  }
  if (!snapshot.isMember) {
    return { ok: false, reason: "NOT_A_MEMBER" };
  }
  if (snapshot.workspaceType !== "Personal") {
    return { ok: false, reason: "NOT_PERSONAL_WORKSPACE" };
  }
  if (snapshot.dealApproverExists) {
    return { ok: false, reason: "ALREADY_PROVISIONED" };
  }
  return { ok: true };
}

export type DealApproverConfirmableWorkspaceStatus = Extract<
  WorkspaceStatusV1,
  "Active" | "Suspended"
>;
export type DealApproverConfirmableWorkspaceType = Extract<
  WorkspaceTypeV1,
  "Personal" | "Organization"
>;
