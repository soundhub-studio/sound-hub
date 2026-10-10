# GitHub Issue #88 — Implementation Slices

> **Purpose:** Define the approved implementation sequence for GitHub issue #88 so implementation and review can proceed in bounded slices without treating intentionally deferred work as missing.
>
> **Authoritative source:** GitHub issue #88 and the reconciled Milestone 2 specifications remain authoritative for product behavior. This document defines implementation sequencing and review boundaries only. It does not replace or weaken the issue.

---

## Current review target

**CURRENT REVIEW TARGET: `88F` (DEFERRED — see completion notes)**

Update this line only after the current slice has:

1. been implemented,
2. passed its required verification,
3. been independently reviewed,
4. had all blocking findings resolved, and
5. been committed as the accepted foundation for the next slice.

The slices are implemented **sequentially**, not in parallel.

---

## Review rule

For any review of issue #88:

1. Read GitHub issue #88 as the authoritative overall contract.
2. Read this implementation-slice plan.
3. Identify the `CURRENT REVIEW TARGET`.
4. Review the current slice's acceptance criteria, every previously completed slice, and cross-slice invariants from the full issue that the current slice must preserve.
5. Do **not** report requirements assigned to a later slice as missing/blocking merely because they are intentionally deferred.
6. A future-slice concern **is blocking** when the current slice contradicts the overall issue, makes the future slice impossible or unsafe, locks in an incompatible schema/API/persistence contract, implements behavior assigned to a later slice prematurely, weakens an existing M1/M2 invariant, or violates a cross-slice authorization, privacy, atomicity, idempotency, or lifecycle invariant.
7. When useful, list intentionally deferred requirements under **Not applicable / Deferred by slice plan**.

---

# Cross-slice invariants

These apply to every slice.

## Authority

- `Workspace.ownerUserId` never authorizes — including during permission setup.
- `WorkspaceMembership` is the only authorization source for acting through a Workspace.
- DealApprover provisioning is capability-neutral, Personal-Workspace-scoped, and is **not** an approval.
- DealApprover authorization binds exactly one (Workspace, UserAccount) tuple.
- DealApprover provisioning never creates a `DealApproval`.
- One party's DealApprover never authorizes the counterparty's approval.

## Approval

- Approval is exact-version and party-scoped.
- AI output, Owner status, capability, remembered context, and counterparty state never approve.
- Every consequential command (Accept, Provision, Approve) is atomic, attributable, and retry-safe.

## Privacy

- Public DTOs never serialize private audit identifiers (`grantedByUserId`, `approvedByUserId`, `dealApproverId`, `actingWorkspaceId` audit columns).
- Customer language is "permission to approve terms" — never `DealApprover` or provider/governance internals.

## State

- ProjectRequest acceptance is not TermsVersion approval.
- A replacement TermsVersion invalidates earlier approvals in presentation and behavior.
- "Approved" appears only with persisted evidence; "Pending approval" may be derived.

---

# Slice dependency graph

```text
88A — Persistence + closed attestation version
 ├── 88B — Accept atomically creates Deal + initial TermsVersion
 ├── 88C — DealApprover JIT permission setup service + endpoint
 ├── 88D — ProjectRequest detail pages (buyer + seller)
 ├── 88E — Deal page approval flow + aubergine authority styling
 └── 88F — Integration + browser coverage
```

88F depends on 88A–88E.

---

# 88A — Persistence + closed attestation version

## Scope

Establish the durable persistence and contract surface that later slices require.

88A includes:

- Closed `m2-deal-approver-v1` confirmation version constant.
- `DealApproverAcceptance` evidence table mirroring the existing
  SellerProfilePublication / ServiceOfferingActivation / ServiceOfferingUpdate
  pattern:
  - `id` (cuid)
  - `dealApproverId` — the authorized `DealApprover` row id
  - `workspaceId` — the Personal Workspace receiving the authorization
  - `userId` — the human accepting the versioned attestation
  - `grantedByUserId` — the same human (Personal Workspace, self-service)
  - `confirmationVersion` (closed: `m2-deal-approver-v1`)
  - `acceptedAt`
  - `idempotencyKey` (UUID, client-supplied)
  - `requestId` (server-injected correlation id)
  - `UNIQUE (workspaceId, idempotencyKey)`
  - `INDEX (dealApproverId)`
  - `ON DELETE RESTRICT` on every FK
- Additive Prisma migration.
- Shared Zod schemas for:
  - `provisionDealApproverRequestV1Schema` (body: `{ actingWorkspaceId, confirmationVersion, idempotencyKey }`)
  - `provisionDealApproverResponseV1Schema` (body: `{ ok: true, dealApprover: { dealApproverId, workspaceId, grantedAt } }`)
- API error codes:
  - `DEAL_APPROVER_INVALID` → 400
  - `DEAL_APPROVER_FORBIDDEN` → 403 (collapsed: not Personal, not current member, no capability-neutral eligibility)
  - `DEAL_APPROVER_ALREADY_PROVISIONED` → 409 (idempotency-key collision + a row already exists)
  - `DEAL_APPROVER_CONFIRMATION_VERSION_MISMATCH` → 422
  - `DEAL_APPROVER_INTERNAL_FAILED` → 500
- HTTP status mapping entries in `apps/api/src/lib/errors.ts`.

## Explicit non-goals

88A does **not** implement:

- Provisioning service or use-case logic
- Route handler
- UI
- Web client
- Acceptance logic / repository locking / transactional write
- A duplicate DealApprover row on retry (the unique index only)

## Acceptance criteria

- Migration applies cleanly to disposable PostgreSQL.
- `DealApproverAcceptance` evidence rows carry NO `DealApprover` row id until later slices persist them.
- `DealApproverAcceptance` evidence carries `confirmationVersion`, `idempotencyKey`, `requestId`, and FKs to UserAccount + Workspace.
- Closed error schema includes all new codes.
- Status mappings are correct.
- `confirmationVersion` is the only value accepted by the Zod schema (`m2-deal-approver-v1`).
- `idempotencyKey` is a UUID validated at the boundary.
- No runtime command implementation or fake route is introduced.

## Verification

At minimum:

```bash
pnpm prisma:generate
pnpm --filter @soundhub/db db:migrate
pnpm type-check
pnpm lint
pnpm format:check
pnpm check:fast
```

## Review gate

Codex reviews only the 88A delta plus overarching #88 invariants.

Future slices 88B–88F are deferred and must not be reported as missing unless 88A makes them impossible, unsafe, or contract-incompatible.

---

# 88B — Accept atomically creates Deal + initial TermsVersion

## Scope

Update the BG4 seller-accept command so it atomically creates exactly one
Negotiating Deal **and** exactly one AI-drafted, unapproved current
TermsVersion.

Acceptance revalidates current membership, Seller capability, ownership,
seller/offering eligibility, and request state — both pre-existing BG4
rules and the new BG5 drafting precondition (`deal must be Negotiating`).
A same-attempt retry (transport retry with no idempotency key change)
converges on the same Deal + TermsVersion and does NOT create a second
TermsVersion.

Implementation is bounded to the `apps/api/src/project-request/` surfaces:

- `ProjectRequestService.acceptProjectRequest` (delegates drafting to
  the DealTerms AI boundary or a synchronous fallback so the AI is
  invoked exactly once on success).
- `PrismaProjectRequestRepository.runRespondTransactionOnce` —
  extended so the `accept` branch persists a TermsVersion v1 with
  monotonic version 1 inside the same `$transaction` that creates the
  Deal.
- `InMemoryProjectRequestRepository` mirror.
- Tests in `project-request.service.test.ts` +
  `prisma-project-request.repository.test.ts`.

The `apps/api/src/deal-terms/` surface is not modified by 88B; later
slices (88E) reuse the existing draftTermsInTransaction logic for
replacement drafts.

## Explicit non-goals

88B does **not** implement:

- New HTTP endpoints
- New schemas
- UI changes
- Approval or DealApprover logic
- Replacement TermsVersion logic (existing BG5 already handles this)
- A persistent idempotency key on accept (the existing
  `(deal.projectRequestId)` unique index is sufficient for the
  "same-accept → same-Deal" invariant; a separate
  `TermsVersions(dealId, version)` unique index ensures
  "same-accept → same-TermsVersion")

## Acceptance criteria

- Accept succeeds and persists exactly one Deal AND exactly one
  TermsVersion v1 in one transaction.
- The persisted TermsVersion carries `aiDraftedUnapprovedBadge: true`
  and `aiFallbackUsed: true` (the deterministic adapter is the only
  adapter the buildathon wires).
- A same-attempt retry converges on the same Deal id AND the same
  TermsVersion id; no duplicate rows.
- Concurrent accept attempts: exactly one Deal, exactly one TV; the
  loser receives `PROJECT_REQUEST_ALREADY_RESPONDED`.
- Accept of an ineligible offering revalidates the seller-offering
  snapshot (BG4 contract preserved) and rejects with the BG4 typed
  error.
- Declining does NOT create a Deal AND does NOT create a TermsVersion
  (pre-existing BG4 contract preserved).
- The drafting precondition (`deal must be Negotiating`) revalidates
  the Deal state after the Deal is created in the same transaction;
  any draft state from a prior partial write cannot survive rollback.
- An invalid AI candidate (the deterministic adapter always produces
  a valid candidate under the closed `bg5ProposedTermsV1Schema`) does
  NOT leave a partial Deal or TermsVersion behind.

## Verification

At minimum:

```bash
pnpm --filter @soundhub/api test -- project-request
pnpm type-check
pnpm check:fast
```

## Review gate

Codex reviews only the 88B delta plus overarching #88 invariants.

Future slices 88C–88F are deferred.

---

# 88C — DealApprover JIT permission setup service + endpoint

## Scope

Implement Personal-Workspace-only, capability-neutral, self-service
DealApprover provisioning.

Surface:

- `DealApproverService` (`apps/api/src/deal-approver/`)
  - `provisionDealApprover({ userAccountId, actingWorkspaceId, confirmationVersion, idempotencyKey, now? })`
  - One PostgreSQL transaction; FOR UPDATE-locks the Workspace /
    WorkspaceMembership rows; verifies the Workspace is `Personal` AND
    Active; verifies current membership; ensures no DealApprover
    exists for `(workspaceId, userId)`; inserts a `DealApprover` row
    AND a `DealApproverAcceptance` evidence row in one transaction.
  - Same-idempotency-key retry → converged success (returns the
    previously committed row).
  - Different-key retry when DealApprover already exists →
    `DEAL_APPROVER_ALREADY_PROVISIONED`.
  - The service does NOT create a `DealApproval`.
- Route handler `POST /api/deal-approvers`
  - body: `{ actingWorkspaceId, confirmationVersion, idempotencyKey }`
  - response: `{ ok: true, dealApprover: { dealApproverId, workspaceId, grantedAt } }`
- In-memory and Prisma repository.
- Web client function `provisionDealApprover`.

## Explicit non-goals

88C does **not** implement:

- Organization Workspace provisioning
- Revocation
- Approval (still BG5)
- UI page (88E)
- Dashboard readiness task (later dashboard slice)

## Acceptance criteria

- Provisioning requires current Personal Workspace membership.
- Provisioning requires `confirmationVersion === "m2-deal-approver-v1"`.
- Provisioning requires a valid UUID `idempotencyKey`.
- Same-key retry returns the previously committed `dealApprover` row.
- Different-key retry when DealApprover exists → typed conflict.
- Membership loss / Workspace not Personal / Workspace not Active /
  unexpected user rejects at the boundary with safe envelopes.
- `workspace.ownerUserId` is never read.
- `DealApproverAcceptance` evidence row carries the persisted
  confirmation version, idempotency key, and request id.

## Verification

At minimum:

```bash
pnpm --filter @soundhub/api test -- deal-approver
pnpm --filter @soundhub/web test -- deal-approver
pnpm type-check
pnpm check:fast
```

## Review gate

Codex reviews only the 88C delta plus overarching #88 invariants.

Future slices 88D–88F are deferred.

---

# 88D — ProjectRequest detail pages (buyer + seller)

## Scope

Web UI for `/project-requests/[projectRequestId]`:

- Buyer side:
  - Heading "Awaiting response"
  - Seller / ServiceOffering selection summary
  - ProjectBrief originalText (or excerpt + link)
  - Constraints summary (the brief's required criteria)
  - "No Deal yet — seller has not accepted. No approval, no funding,
    and no work has started."
- Seller side:
  - Full acting Workspace displayed prominently inside a bounded
    Accept/Decline region
  - Brief context
  - Accept / Decline buttons
  - Accept: full acting Workspace, "Creates one Negotiating Deal
    and an AI-drafted TermsVersion. Does not approve terms. Does not
    begin work."
  - Decline: "Records that you declined. No Deal is created."

Authorization: each side must be a current member of the acting
Workspace; cross-side attempts render the same safe envelope as the
existing `/api/project-requests/:id` GET.

The page reuses the BG1 SessionProvider and reuses the existing
`fetchProjectRequest` + `acceptProjectRequest` + `declineProjectRequest`
clients from `apps/web/src/app/lib/project-requests-client.ts`.

## Explicit non-goals

88D does **not** implement:

- Deal page wiring (88E)
- Permission setup UI (88E)
- Replacement terms UI
- Chat / messaging

## Acceptance criteria

- Both ProjectRequest views render without exposing raw internal ids
  as primary content.
- Seller-side Accept/Decline remains inside the bounded region and
  uses the existing safe envelope.
- Buyer-side view shows the canonical "Awaiting response" indicator
  and explicitly states that no Deal, approval, funding, or work has
  begun.
- Buyer-side and seller-side reject unauthorized access with the same
  safe envelope.
- Mobile + desktop responsive; ~393px reflow OK.
- Keyboard focus entry / order.

## Verification

At minimum:

```bash
pnpm --filter @soundhub/web test -- project-requests
pnpm type-check
pnpm check:fast
```

## Review gate

Codex reviews only the 88D delta plus overarching #88 invariants.

Future slices 88E–88F are deferred.

---

# 88E — Deal page approval flow + aubergine authority styling

## Scope

Wire the existing `/deals/:dealId` page so:

- The "Approve this TermsVersion" CTA uses the aubergine family (not
  coral) so it is visually distinct from marketplace-progression
  actions.
- A new "Permission to approve terms" CTA appears for each party
  that lacks a `DealApprover` authorization. The CTA is aubergine.
- Clicking the CTA routes to `/deals/:dealId/approve-permission` (or
  renders the inline versioned-attestation dialog if same page).
- Successful setup returns to the Deal page, shows "Permission set up",
  and requires a new, separate explicit **Approve Version N** action.
- No action is auto-replayed; no DealApproval is created during
  setup.
- The `/deals/:dealId` page surfaces a "Pending approval" indicator
  for each side that has not approved the current version, and an
  "Approved" indicator only when a DealApproval row exists for that
  side.
- A replacement TermsVersion invalidates earlier approval indicators
  in presentation and behavior (existing BG5 MAX(version) rule).

## Explicit non-goals

88E does **not** implement:

- Replacements editor (replacement drafts reuse the existing
  `POST /api/deals/:dealId/terms-draft` route)
- Funding flow (BG6)
- Chat / messaging

## Acceptance criteria

- Aubergine CTA palette is used for Approve and Permission CTA, not
  coral.
- Permission setup accepts the closed version + idempotency key, calls
  the new route, refreshes the Deal view, and does NOT auto-approve.
- The Permission set up state is ephemeral (route returns to Deal
  page; no separate persisted state).
- Each side independently approves; one side's approval does not
  approve the other.
- A replacement TermsVersion surfaces "Pending approval" for both
  sides even when prior approvals existed for the superseded version.

## Verification

At minimum:

```bash
pnpm --filter @soundhub/web test -- deal-approver
pnpm type-check
pnpm check:fast
```

## Review gate

Codex reviews only the 88E delta plus overarching #88 invariants.

---

# 88F — Integration + browser coverage

## Scope

End-to-end integration coverage that proves the cross-slice
acceptance criteria:

- Buyer-side ProjectRequest view shows "Awaiting response".
- Seller-side ProjectRequest view shows bounded Accept/Decline
  region with full acting Workspace.
- Accept atomically creates Deal + v1 TermsVersion.
- Decline records canonical outcome; no Deal.
- Each side attempts approval without DealApprover; JIT setup
  succeeds; return to Deal page requires separate explicit approval.
- Each side independently approves the current version.
- A replacement TermsVersion invalidates earlier approvals in
  presentation and behavior.
- Aubergine palette for authority actions; coral for progression.
- No `ownerUserId` authorization at any boundary.
- One full browser journey exercising the slice.

## Acceptance criteria

Cover all ticket acceptance criteria that were deferred by the
slice plan.

## Verification

At minimum:

```bash
pnpm test:repository
pnpm --filter @soundhub/web test
pnpm check:fast
pnpm build
```

## Review gate

Final Codex review of the full branch.

---

# Completion workflow

For each slice:

```text
Implement current slice
→ focused verification
→ Codex delta review
→ fix blocking findings
→ rerun verification/review
→ commit accepted slice
→ update CURRENT REVIEW TARGET
→ begin next slice
```

After 88F:

```text
full manual visual QA
→ broad PR review / Tenki
→ apply review feedback
→ final Codex full-branch review
→ CI
→ resolve review conversations
→ merge #88
```

---

# Explicit #88 non-goals

Do not add as part of #88:

- Chat, messaging, counteroffers
- Organization delegation / multi-member administration
- Delivery, deadlines, disputes, real funding
- Default rights/licensing terms or legal guarantees
- Generalized audit/event-sourcing framework
- Editing existing ProjectRequests/Deals/TermsVersions/approvals/funding
- Self-service Organization Workspace DealApprover
- Capability deactivation
