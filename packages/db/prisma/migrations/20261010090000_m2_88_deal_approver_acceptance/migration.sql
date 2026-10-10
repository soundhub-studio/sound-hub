-- M2 (#88): DealApproverAcceptance evidence table.
--
-- Per ticket #88, Personal-Workspace self-service provisioning of a
-- DealApprover authorization is a capability-neutral, Personal-Workspace-
-- scoped explicit command. Every successful provisioning attempt
-- produces ONE append-only evidence row that records the (workspaceId,
-- userId) tuple authorized, the closed confirmation version the human
-- accepted, the actor, and the request correlation id.
--
-- The (workspaceId, idempotencyKey) UNIQUE constraint is the durable
-- convergence key for same-attempt transport retries; the application
-- also performs the pre-check, so this is the second defense, not the
-- first.
--
-- The acceptance row is NOT a `DealApproval` — the JIT permission setup
-- command does not approve any TermsVersion. A separate explicit
-- "Approve Version N" action follows the successful setup.
--
-- ON DELETE RESTRICT on every FK preserves the durable evidence row
-- even if the source UserAccount, Workspace, or DealApprover is ever
-- hard-deleted.
--
-- This migration is additive only. No existing rows are rewritten, no
-- legacy flag is added, and no fabricated DealApprover / acceptance /
-- attestation data is inserted.

-- ---------- DealApproverAcceptance ----------
--
-- Personal-Workspace self-service provisioning evidence. The closed
-- confirmation version is `m2-deal-approver-v1` (defined in the
-- application boundary); a stale or unknown version is a typed
-- rejection at the boundary.
CREATE TABLE "deal_approver_acceptances" (
  "id"                  TEXT NOT NULL,
  "dealApproverId"      TEXT NOT NULL,
  "workspaceId"         TEXT NOT NULL,
  "userId"              TEXT NOT NULL,
  "grantedByUserId"     TEXT NOT NULL,
  "confirmationVersion" TEXT NOT NULL,
  "acceptedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "idempotencyKey"      TEXT NOT NULL,
  "requestId"           TEXT NOT NULL,

  CONSTRAINT "deal_approver_acceptances_pkey" PRIMARY KEY ("id")
);

-- Same-attempt retry convergence. A transport retry after a lost
-- response reuses the same idempotencyKey; the unique constraint
-- rejects the duplicate INSERT and the service converges on the
-- already-persisted row.
CREATE UNIQUE INDEX "deal_approver_acceptances_workspace_idem_unique_idx"
  ON "deal_approver_acceptances" ("workspaceId", "idempotencyKey");

-- Latest-evidence lookup: "what is the most recent acceptance for
-- this DealApprover?". ORDER BY acceptedAt DESC plus this index
-- supports the audit surface.
CREATE INDEX "deal_approver_acceptances_workspace_acceptedAt_idx"
  ON "deal_approver_acceptances" ("workspaceId", "acceptedAt" DESC);

-- DealApprover scope index for audit and approval surface lookups
-- (a DealApprover may be re-granted in the future; the index lets a
-- reviewer trace every row that ever authorized that tuple).
CREATE INDEX "deal_approver_acceptances_dealApprover_idx"
  ON "deal_approver_acceptances" ("dealApproverId");

-- Foreign keys. ON DELETE RESTRICT preserves the durable evidence
-- row even if the source UserAccount, Workspace, or DealApprover is
-- hard-deleted.
ALTER TABLE "deal_approver_acceptances"
  ADD CONSTRAINT "deal_approver_acceptances_dealApproverId_fkey"
  FOREIGN KEY ("dealApproverId") REFERENCES "deal_approvers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "deal_approver_acceptances"
  ADD CONSTRAINT "deal_approver_acceptances_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "deal_approver_acceptances"
  ADD CONSTRAINT "deal_approver_acceptances_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "deal_approver_acceptances"
  ADD CONSTRAINT "deal_approver_acceptances_grantedByUserId_fkey"
  FOREIGN KEY ("grantedByUserId") REFERENCES "user_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;