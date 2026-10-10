/* eslint-disable @typescript-eslint/no-floating-promises */
// DealTermsService unit tests (BG5).
//
// Background: ticket #63 acceptance criteria require the service to:
//   - enforce drafting authorization (current member + Workspace is
//     a party + Deal is Negotiating)
//   - enforce approval authorization (current membership + explicit
//     DealApprover row + exact current TermsVersion)
//   - persist TermsVersion via the in-memory repository with the
//     same application-policy contract the Prisma adapter enforces
//   - reject duplicate approvals for the same (termsVersionId,
//     workspaceId) tuple
//   - reject approval of a stale TermsVersionId after a material
//     replacement
//
// These tests use the InMemoryDealTermsRepository so they run without
// a database. The Prisma adapter's equivalence is proven by the
// integration tests against the disposable PostgreSQL target.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DealTermsService, DealTermsError } from "./deal-terms.service.js";
import { InMemoryDealTermsRepository } from "./in-memory-deal-terms.repository.js";
import { InMemoryDealApproverRepository } from "../deal-approver/in-memory-deal-approver.repository.js";
import { WorkspaceAuthorizationService } from "../services/workspace-authorization.service.js";
import { InMemoryAuthRepository } from "../auth-repository/in-memory-auth-repository.js";
import type {
  ProjectRequestRepository,
  PersistedProjectRequest,
} from "../project-request/project-request.repository.js";

/**
 * Lightweight ProjectRequestRepository stub for unit tests. Holds a
 * single ProjectRequest row in memory; tests seed it directly. Other
 * ProjectRequestRepository methods throw because they are not
 * exercised on this path (DealTermsService.getDeal only calls
 * findProjectRequestById).
 */
class StubProjectRequestRepository implements ProjectRequestRepository {
  private row: PersistedProjectRequest | null = null;

  seed(row: PersistedProjectRequest): void {
    this.row = row;
  }

  createProjectRequestInTransaction(): Promise<never> {
    return Promise.reject(new Error("not implemented"));
  }

  respondToProjectRequestInTransaction(): Promise<never> {
    return Promise.reject(new Error("not implemented"));
  }

  findProjectRequestById(id: string): Promise<PersistedProjectRequest | null> {
    if (this.row === null) return Promise.resolve(null);
    return Promise.resolve(this.row.id === id ? this.row : null);
  }

  listProjectRequests(): Promise<readonly PersistedProjectRequest[]> {
    if (this.row === null) return Promise.resolve([]);
    return Promise.resolve([this.row]);
  }
}

const BUYER_USER_ID = "user-buyer";
const BUYER_WORKSPACE_ID = "ws-buyer";
const SELLER_USER_ID = "user-seller";
const SELLER_WORKSPACE_ID = "ws-seller";
const OTHER_USER_ID = "user-other";
const OTHER_WORKSPACE_ID = "ws-other";
const DEAL_ID = "deal-1";
const OFFERING_ID = "of-1";
const BRIEF_ID = "brief-1";
const PROJECT_REQUEST_ID = "pr-1";

const VALID_PROPOSED = {
  scope: "Produce the commissioned work described in the brief.",
  deliverables: [{ title: "Primary", description: "Mix-ready master." }],
  schedule: { startDate: "2026-01-01", endDate: "2026-01-22", deliveryDays: 21 },
  price: { amountMinor: 75000, currency: "USD" as const },
  revisionAllowance: 1,
  rightsSummary: "Non-exclusive worldwide rights.",
  fundingDeadlineAt: undefined,
};

interface Fixture {
  service: DealTermsService;
  repo: InMemoryDealTermsRepository;
  authz: WorkspaceAuthorizationService;
  // M2 (#88) Codex finding: the in-memory DealApprover
  // adapter is wired into the fixture so the
  // `actingSideHasDealApprover` predicate is observable in
  // the tests below.
  dealApproverRepository: InMemoryDealApproverRepository;
  clock: { current: Date };
  // ProjectRequestRepository the service is wired with. Tests that
  // want to exercise the seller-consent projection can call
  // `.seed(...)` directly. Defaults to an empty repository so the
  // projection is always null unless the test seeds one.
  projectRequestRepository: StubProjectRequestRepository;
}

function buildFixture(opts?: { dealStatus?: "Negotiating" | "Active" }): Fixture {
  const repo = new InMemoryDealTermsRepository();
  repo.seedWorkspace({ workspaceId: BUYER_WORKSPACE_ID, status: "Active" });
  repo.seedWorkspace({ workspaceId: SELLER_WORKSPACE_ID, status: "Active" });
  repo.seedWorkspace({ workspaceId: OTHER_WORKSPACE_ID, status: "Active" });
  repo.seedMembership({ userId: BUYER_USER_ID, workspaceId: BUYER_WORKSPACE_ID });
  repo.seedMembership({ userId: SELLER_USER_ID, workspaceId: SELLER_WORKSPACE_ID });
  repo.seedMembership({ userId: OTHER_USER_ID, workspaceId: OTHER_WORKSPACE_ID });
  // Build a real WorkspaceAuthorizationService backed by the same
  // membership state the in-memory deal-terms repo uses. P1-004
  // requires the service to enforce current membership before
  // invoking AI; the test fixture must therefore provide a real
  // (not stubbed) authorization service so the pre-check fires.
  const authRepo = new InMemoryAuthRepository(
    [
      {
        userAccountId: BUYER_USER_ID,
        email: "buyer@example.com",
        identityProvider: "deterministic",
        identitySubject: `buyer-${BUYER_USER_ID}`,
        memberships: [
          {
            workspaceId: BUYER_WORKSPACE_ID,
            slug: "buyer",
            name: "Buyer",
            workspaceType: "Personal",
            workspaceStatus: "Active",
            role: "Owner",
            capabilities: ["Buyer"],
          },
        ],
      },
      {
        userAccountId: SELLER_USER_ID,
        email: "seller@example.com",
        identityProvider: "deterministic",
        identitySubject: `seller-${SELLER_USER_ID}`,
        memberships: [
          {
            workspaceId: SELLER_WORKSPACE_ID,
            slug: "seller",
            name: "Seller",
            workspaceType: "Personal",
            workspaceStatus: "Active",
            role: "Owner",
            capabilities: ["Seller"],
          },
        ],
      },
      {
        userAccountId: OTHER_USER_ID,
        email: "other@example.com",
        identityProvider: "deterministic",
        identitySubject: `other-${OTHER_USER_ID}`,
        memberships: [
          {
            workspaceId: OTHER_WORKSPACE_ID,
            slug: "other",
            name: "Other",
            workspaceType: "Personal",
            workspaceStatus: "Active",
            role: "Owner",
            capabilities: [],
          },
        ],
      },
    ],
    () => 0,
  );
  const authz = new WorkspaceAuthorizationService({ authRepository: authRepo });
  repo.seedDeal({
    id: DEAL_ID,
    buyerWorkspaceId: BUYER_WORKSPACE_ID,
    sellerWorkspaceId: SELLER_WORKSPACE_ID,
    serviceOfferingId: OFFERING_ID,
    projectBriefId: BRIEF_ID,
    projectRequestId: PROJECT_REQUEST_ID,
    status: opts?.dealStatus ?? "Negotiating",
    activatedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  });
  repo.seedDealApprover({
    id: "da-buyer",
    workspaceId: BUYER_WORKSPACE_ID,
    userId: BUYER_USER_ID,
    grantedAt: new Date("2026-01-01T00:00:00Z"),
  });
  repo.seedDealApprover({
    id: "da-seller",
    workspaceId: SELLER_WORKSPACE_ID,
    userId: SELLER_USER_ID,
    grantedAt: new Date("2026-01-01T00:00:00Z"),
  });

  const clock = { current: new Date("2026-09-01T00:00:00Z") };
  // The ProjectRequestRepository is wired in the service so getDeal()
  // can derive the seller-consent projection from the associated
  // ProjectRequest. The default stub holds nothing, so the projection
  // is null unless the test seeds it via `projectRequestRepository.seed(...)`.
  const projectRequestRepository = new StubProjectRequestRepository();
  // M2 (#88) Codex finding: the Deal view needs the durable
  // `(workspaceId, userId)` `deal_approvers` row. The fixture
  // wires the in-memory DealApprover adapter so the
  // `actingSideHasDealApprover` predicate is observable in
  // the tests below.
  const dealApproverRepository = new InMemoryDealApproverRepository();
  dealApproverRepository.seedWorkspace({
    workspaceId: BUYER_WORKSPACE_ID,
    status: "Active",
    type: "Personal",
  });
  dealApproverRepository.seedWorkspace({
    workspaceId: SELLER_WORKSPACE_ID,
    status: "Active",
    type: "Personal",
  });
  dealApproverRepository.seedMembership({
    userId: BUYER_USER_ID,
    workspaceId: BUYER_WORKSPACE_ID,
  });
  dealApproverRepository.seedMembership({
    userId: SELLER_USER_ID,
    workspaceId: SELLER_WORKSPACE_ID,
  });
  const service = new DealTermsService({
    dealTermsRepository: repo,
    workspaceAuthorizationService: authz,
    projectRequestRepository,
    dealApproverRepository,
    now: () => clock.current,
  });

  return { service, repo, clock, authz, projectRequestRepository, dealApproverRepository };
}

// ---------------------------------------------------------------------------
// approvedAt + draftedAt are server-generated, NOT authoritative from request
// ---------------------------------------------------------------------------

test("draftTerms persists draftedAt from the service clock, ignoring any caller-supplied value", async () => {
  const { service, repo } = buildFixture();
  // Callers MUST NOT be able to influence `draftedAt` through the
  // request payload. The route schema accepts only
  // `actingWorkspaceId`; the service supplies `draftedAt` from its
  // own clock. We assert that the persisted row carries the service
  // clock value, not a hypothetical caller-supplied one.
  const result = await service.draftTerms({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    dealId: DEAL_ID,
    callerProposedTerms: VALID_PROPOSED,
  });
  assert.equal(
    result.termsVersion.draftedAt,
    "2026-09-01T00:00:00.000Z",
    "draftedAt must equal the service clock",
  );
  // The DealTerms view must also expose the same draftedAt.
  const view = await service.getDeal({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    dealId: DEAL_ID,
  });
  assert.equal(view.currentTermsVersion?.draftedAt, "2026-09-01T00:00:00.000Z");
  // Internal sanity: the repository recorded the timestamp too.
  const persisted = [...repo["termsVersions"].values()].find((row) => row.dealId === DEAL_ID);
  assert.ok(persisted, "the in-memory repo must hold a TermsVersion row");
  assert.equal(persisted.draftedAt.toISOString(), "2026-09-01T00:00:00.000Z");
});

test("approveTerms persists approvedAt from the service clock", async () => {
  const { service } = buildFixture();
  const draft = await service.draftTerms({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    dealId: DEAL_ID,
    callerProposedTerms: VALID_PROPOSED,
  });
  // Advance the clock.
  const { service: service2, clock } = buildFixture();
  // Re-draft with the second fixture's seeded state (the first draft
  // lives only in the first fixture).
  void service;
  const draft2 = await service2.draftTerms({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    dealId: DEAL_ID,
    callerProposedTerms: VALID_PROPOSED,
  });
  clock.current = new Date("2026-09-02T00:00:00Z");
  const approval = await service2.approveTerms({
    userAccountId: SELLER_USER_ID,
    actingWorkspaceId: SELLER_WORKSPACE_ID,
    dealId: DEAL_ID,
    termsVersionId: draft2.termsVersion.termsVersionId,
  });
  assert.equal(
    approval.approval.approvedAt,
    "2026-09-02T00:00:00.000Z",
    "approvedAt must equal the service clock",
  );
  void draft;
});

// ---------------------------------------------------------------------------
// Creating TermsVersion N+1 leaves TermsVersion N immutable; prior approvals
// are insufficient because only approvals for current MAX(version) count.
// ---------------------------------------------------------------------------

test("drafting TermsVersion 2 leaves TermsVersion 1 immutable; a prior approval of V1 is insufficient", async () => {
  const { service, repo } = buildFixture();
  const v1 = await service.draftTerms({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    dealId: DEAL_ID,
    callerProposedTerms: VALID_PROPOSED,
  });
  // Buyer approves V1.
  await service.approveTerms({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    dealId: DEAL_ID,
    termsVersionId: v1.termsVersion.termsVersionId,
  });
  // Now seller drafts V2.
  const v2 = await service.draftTerms({
    userAccountId: SELLER_USER_ID,
    actingWorkspaceId: SELLER_WORKSPACE_ID,
    dealId: DEAL_ID,
    callerProposedTerms: VALID_PROPOSED,
  });
  assert.equal(v2.termsVersion.version, 2);
  // V1 row is immutable: the deal view's approvals list still references V1's termsVersionId.
  const view = await service.getDeal({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    dealId: DEAL_ID,
  });
  assert.equal(view.currentTermsVersion?.version, 2);
  // The buyer's earlier V1 approval is still in the repo (immutable
  // audit), but it is NOT in the current-version approvals list.
  assert.equal(view.currentApprovals.length, 0);
  // The in-memory repo still has 1 approval row attached to V1.
  const allApprovals = [...repo["dealApprovals"].values()];
  assert.equal(allApprovals.length, 1, "earlier approval row remains in storage");
  assert.equal(allApprovals[0]!.termsVersionId, v1.termsVersion.termsVersionId);
});

test("approve against a stale TermsVersion id fails with TERMS_VERSION_NOT_CURRENT", async () => {
  const { service } = buildFixture();
  const v1 = await service.draftTerms({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    dealId: DEAL_ID,
    callerProposedTerms: VALID_PROPOSED,
  });
  await service.draftTerms({
    userAccountId: SELLER_USER_ID,
    actingWorkspaceId: SELLER_WORKSPACE_ID,
    dealId: DEAL_ID,
    callerProposedTerms: VALID_PROPOSED,
  });
  // Seller tries to approve V1 (now stale because V2 is current).
  await assert.rejects(
    () =>
      service.approveTerms({
        userAccountId: SELLER_USER_ID,
        actingWorkspaceId: SELLER_WORKSPACE_ID,
        dealId: DEAL_ID,
        termsVersionId: v1.termsVersion.termsVersionId,
      }),
    (err: unknown) => {
      assert.ok(err instanceof DealTermsError);
      assert.equal(err.code, "BG5_APPROVAL_NOT_CURRENT_VERSION");
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Public DTOs never expose approvedByUserId, draftedByUserId, or dealApproverId
// ---------------------------------------------------------------------------

test("public TermsVersion DTO carries no draftedByUserId / approvedByUserId / dealApproverId", async () => {
  const { service } = buildFixture();
  const result = await service.draftTerms({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    dealId: DEAL_ID,
    callerProposedTerms: VALID_PROPOSED,
  });
  const dto = result.termsVersion;
  assert.equal((dto as unknown as Record<string, unknown>)["draftedByUserId"], undefined);
  assert.equal((dto as unknown as Record<string, unknown>)["approvedByUserId"], undefined);
  assert.equal((dto as unknown as Record<string, unknown>)["dealApproverId"], undefined);
  assert.equal((dto as unknown as Record<string, unknown>)["grantedByUserId"], undefined);
  // Every public DTO must carry the schema-mandated badge literal.
  assert.equal(dto.aiDraftedUnapprovedBadge, true);
});

test("public DealApproval DTO carries no approvedByUserId / dealApproverId / draftedByUserId", async () => {
  const { service } = buildFixture();
  const draft = await service.draftTerms({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    dealId: DEAL_ID,
    callerProposedTerms: VALID_PROPOSED,
  });
  const approval = await service.approveTerms({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    dealId: DEAL_ID,
    termsVersionId: draft.termsVersion.termsVersionId,
  });
  const dto = approval.approval;
  assert.equal((dto as unknown as Record<string, unknown>)["approvedByUserId"], undefined);
  assert.equal((dto as unknown as Record<string, unknown>)["dealApproverId"], undefined);
  assert.equal((dto as unknown as Record<string, unknown>)["draftedByUserId"], undefined);
  assert.equal((dto as unknown as Record<string, unknown>)["grantedByUserId"], undefined);
});

// ---------------------------------------------------------------------------
// Buyer and seller approvals are independent durable records for the same
// current TermsVersion.
// ---------------------------------------------------------------------------

// M2 (#88) Codex finding: the Deal view must surface a derived
// `actingSideHasDealApprover` signal so the web can render
// the permission CTA and the approve CTA MUTUALLY EXCLUSIVELY.
test("getDeal surfaces actingSideHasDealApprover=false when no DealApprover row exists", async () => {
  const { service, dealApproverRepository } = buildFixture();
  // The fixture does NOT seed a (workspaceId, userId) row.
  void dealApproverRepository;
  const view = await service.getDeal({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    dealId: DEAL_ID,
  });
  assert.equal(view.actingSideHasDealApprover, false);
});

test("getDeal surfaces actingSideHasDealApprover=true when a DealApprover row exists for the acting (workspaceId, userId)", async () => {
  const { service, dealApproverRepository } = buildFixture();
  // Seed a DealApprover row for the buyer side so the lookup
  // returns a hit.
  dealApproverRepository.seedDealApprover({
    id: "da-buyer",
    workspaceId: BUYER_WORKSPACE_ID,
    userId: BUYER_USER_ID,
    grantedByUserId: BUYER_USER_ID,
    grantedAt: new Date(),
  });
  const view = await service.getDeal({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    dealId: DEAL_ID,
  });
  assert.equal(view.actingSideHasDealApprover, true);
});

test("getDeal surfaces actingSideHasDealApprover=false when a DealApprover row exists for a DIFFERENT user on the same Workspace", async () => {
  // The (workspaceId, userId) tuple is the only durable key.
  // A row for SOMEONE ELSE on the same Workspace does not
  // authorize the acting human.
  const { service, dealApproverRepository } = buildFixture();
  dealApproverRepository.seedDealApprover({
    id: "da-other",
    workspaceId: BUYER_WORKSPACE_ID,
    userId: OTHER_USER_ID,
    grantedByUserId: OTHER_USER_ID,
    grantedAt: new Date(),
  });
  const view = await service.getDeal({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    dealId: DEAL_ID,
  });
  assert.equal(view.actingSideHasDealApprover, false);
});

test("buyer approval and seller approval are independent records; both can coexist for the current version", async () => {
  const { service } = buildFixture();
  const draft = await service.draftTerms({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    dealId: DEAL_ID,
    callerProposedTerms: VALID_PROPOSED,
  });
  const buyerApproval = await service.approveTerms({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    dealId: DEAL_ID,
    termsVersionId: draft.termsVersion.termsVersionId,
  });
  const sellerApproval = await service.approveTerms({
    userAccountId: SELLER_USER_ID,
    actingWorkspaceId: SELLER_WORKSPACE_ID,
    dealId: DEAL_ID,
    termsVersionId: draft.termsVersion.termsVersionId,
  });
  assert.notEqual(buyerApproval.approval.dealApprovalId, sellerApproval.approval.dealApprovalId);
  assert.equal(buyerApproval.approval.workspaceId, BUYER_WORKSPACE_ID);
  assert.equal(sellerApproval.approval.workspaceId, SELLER_WORKSPACE_ID);
  const view = await service.getDeal({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    dealId: DEAL_ID,
  });
  assert.equal(view.currentApprovals.length, 2);
});

// ---------------------------------------------------------------------------
// Duplicate approval retry for the same (termsVersionId, workspaceId) creates
// exactly one approval.
// ---------------------------------------------------------------------------

test("duplicate approval for the same Workspace + TermsVersion is rejected; only one approval row exists", async () => {
  const { service, repo } = buildFixture();
  const draft = await service.draftTerms({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    dealId: DEAL_ID,
    callerProposedTerms: VALID_PROPOSED,
  });
  await service.approveTerms({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    dealId: DEAL_ID,
    termsVersionId: draft.termsVersion.termsVersionId,
  });
  await assert.rejects(
    () =>
      service.approveTerms({
        userAccountId: BUYER_USER_ID,
        actingWorkspaceId: BUYER_WORKSPACE_ID,
        dealId: DEAL_ID,
        termsVersionId: draft.termsVersion.termsVersionId,
      }),
    (err: unknown) => {
      assert.ok(err instanceof DealTermsError);
      assert.equal(err.code, "BG5_APPROVAL_ALREADY_RECORDED");
      return true;
    },
  );
  const approvals = [...repo["dealApprovals"].values()].filter(
    (a) =>
      a.termsVersionId === draft.termsVersion.termsVersionId &&
      a.workspaceId === BUYER_WORKSPACE_ID,
  );
  assert.equal(approvals.length, 1, "exactly one approval row for the same workspace + version");
});

// ---------------------------------------------------------------------------
// Drafting a non-Negotiating Deal fails closed.
// ---------------------------------------------------------------------------

test("draftTerms on an Active Deal fails closed", async () => {
  const { service } = buildFixture({ dealStatus: "Active" });
  await assert.rejects(
    () =>
      service.draftTerms({
        userAccountId: BUYER_USER_ID,
        actingWorkspaceId: BUYER_WORKSPACE_ID,
        dealId: DEAL_ID,
        callerProposedTerms: VALID_PROPOSED,
      }),
    (err: unknown) => {
      assert.ok(err instanceof DealTermsError);
      assert.equal(err.code, "BG5_DEAL_NOT_NEGOTIATING");
      return true;
    },
  );
});

test("approveTerms on an Active Deal fails closed", async () => {
  const { service, repo } = buildFixture({ dealStatus: "Active" });
  // Seed a TermsVersion so approve has a real id to look up.
  const tvId = "tv-existing";
  repo["termsVersions"].set(tvId, {
    id: tvId,
    dealId: DEAL_ID,
    version: 1,
    scope: "Scope",
    deliverablesJson: [{ title: "t", description: "d" }],
    scheduleJson: VALID_PROPOSED.schedule,
    priceAmountMinor: 75000,
    priceCurrency: "USD",
    revisionAllowance: 1,
    rightsSummary: "Rights",
    fundingDeadlineAt: null,
    aiProvider: "deterministic-fallback",
    aiModelId: null,
    aiFallbackUsed: true,
    draftedByUserId: null,
    draftedAt: new Date("2026-09-01T00:00:00Z"),
    createdAt: new Date("2026-09-01T00:00:00Z"),
  });
  await assert.rejects(
    () =>
      service.approveTerms({
        userAccountId: BUYER_USER_ID,
        actingWorkspaceId: BUYER_WORKSPACE_ID,
        dealId: DEAL_ID,
        termsVersionId: tvId,
      }),
    (err: unknown) => {
      assert.ok(err instanceof DealTermsError);
      assert.equal(err.code, "BG5_DEAL_NOT_NEGOTIATING");
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Approval without current membership, DealApprover authorization, or current
// TermsVersion fails closed.
// ---------------------------------------------------------------------------

test("approveTerms by a user with no current membership fails closed", async () => {
  const { service } = buildFixture();
  const draft = await service.draftTerms({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    dealId: DEAL_ID,
    callerProposedTerms: VALID_PROPOSED,
  });
  // OTHER_USER_ID has no membership in BUYER_WORKSPACE_ID.
  await assert.rejects(
    () =>
      service.approveTerms({
        userAccountId: OTHER_USER_ID,
        actingWorkspaceId: BUYER_WORKSPACE_ID,
        dealId: DEAL_ID,
        termsVersionId: draft.termsVersion.termsVersionId,
      }),
    (err: unknown) => {
      assert.ok(err instanceof DealTermsError);
      assert.equal(err.code, "BG5_APPROVAL_FORBIDDEN");
      return true;
    },
  );
});

test("approveTerms without an explicit DealApprover authorization fails closed", async () => {
  const { service, repo } = buildFixture();
  // OTHER_WORKSPACE_ID has no DealApprover row for OTHER_USER_ID.
  repo.seedMembership({ userId: OTHER_USER_ID, workspaceId: OTHER_WORKSPACE_ID });
  repo.seedDeal({
    id: "deal-no-approver",
    buyerWorkspaceId: BUYER_WORKSPACE_ID,
    sellerWorkspaceId: OTHER_WORKSPACE_ID,
    serviceOfferingId: OFFERING_ID,
    projectBriefId: BRIEF_ID,
    projectRequestId: "pr-2",
    status: "Negotiating",
    activatedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  });
  const draft = await service.draftTerms({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    dealId: "deal-no-approver",
    callerProposedTerms: VALID_PROPOSED,
  });
  await assert.rejects(
    () =>
      service.approveTerms({
        userAccountId: OTHER_USER_ID,
        actingWorkspaceId: OTHER_WORKSPACE_ID,
        dealId: "deal-no-approver",
        termsVersionId: draft.termsVersion.termsVersionId,
      }),
    (err: unknown) => {
      assert.ok(err instanceof DealTermsError);
      assert.equal(err.code, "BG5_APPROVAL_FORBIDDEN");
      return true;
    },
  );
});

test("approveTerms with a non-current TermsVersion fails closed", async () => {
  const { service, repo } = buildFixture();
  // Seed an older TermsVersion that is NOT the current version.
  repo["termsVersions"].set("tv-stale", {
    id: "tv-stale",
    dealId: DEAL_ID,
    version: 1,
    scope: "Old scope",
    deliverablesJson: [{ title: "t", description: "d" }],
    scheduleJson: VALID_PROPOSED.schedule,
    priceAmountMinor: 75000,
    priceCurrency: "USD",
    revisionAllowance: 1,
    rightsSummary: "Old",
    fundingDeadlineAt: null,
    aiProvider: "deterministic-fallback",
    aiModelId: null,
    aiFallbackUsed: true,
    draftedByUserId: null,
    draftedAt: new Date("2026-01-01T00:00:00Z"),
    createdAt: new Date("2026-01-01T00:00:00Z"),
  });
  // Draft a newer version (current = V2).
  await service.draftTerms({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    dealId: DEAL_ID,
    callerProposedTerms: VALID_PROPOSED,
  });
  await assert.rejects(
    () =>
      service.approveTerms({
        userAccountId: BUYER_USER_ID,
        actingWorkspaceId: BUYER_WORKSPACE_ID,
        dealId: DEAL_ID,
        termsVersionId: "tv-stale",
      }),
    (err: unknown) => {
      assert.ok(err instanceof DealTermsError);
      assert.equal(err.code, "BG5_APPROVAL_NOT_CURRENT_VERSION");
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Funding deadline remains display-only and causes no state transition.
// ---------------------------------------------------------------------------

test("funding deadline is persisted as display-only and never gates approval state", async () => {
  const { service } = buildFixture();
  const futureDeadline = new Date("2099-12-31T00:00:00.000Z").toISOString();
  const pastDeadline = new Date("2000-01-01T00:00:00.000Z").toISOString();

  // Future deadline: approval succeeds.
  const futureDraft = await service.draftTerms({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    dealId: DEAL_ID,
    callerProposedTerms: { ...VALID_PROPOSED, fundingDeadlineAt: futureDeadline },
  });
  await service.approveTerms({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    dealId: DEAL_ID,
    termsVersionId: futureDraft.termsVersion.termsVersionId,
  });

  // Past deadline: still approves successfully (no state effect).
  const pastDraft = await service.draftTerms({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    dealId: DEAL_ID,
    callerProposedTerms: { ...VALID_PROPOSED, fundingDeadlineAt: pastDeadline },
  });
  const pastApproval = await service.approveTerms({
    userAccountId: SELLER_USER_ID,
    actingWorkspaceId: SELLER_WORKSPACE_ID,
    dealId: DEAL_ID,
    termsVersionId: pastDraft.termsVersion.termsVersionId,
  });
  assert.equal(pastApproval.approval.termsVersionId, pastDraft.termsVersion.termsVersionId);
  assert.equal(
    pastDraft.termsVersion.fundingDeadlineAt,
    pastDeadline,
    "deadline persists verbatim for display",
  );
});

// ---------------------------------------------------------------------------
// Seller-consent projection (ticket AC27)
//
// The DealTermsService.getDeal() method computes the narrow public
// `sellerConsent` projection from the persisted ProjectRequest
// associated with the Deal. The projection is the smallest surface
// needed by the Active Deal view to render an explicit seller-consent
// indicator; it MUST be null whenever the domain invariant (a Deal
// only exists after seller acceptance) does not hold.
// ---------------------------------------------------------------------------

test("getDeal surfaces sellerConsent: null when no ProjectRequest is wired for the Deal", async () => {
  const { service } = buildFixture();
  // No ProjectRequest seeded → projection must be null. The page
  // MUST NOT infer consent from Deal existence alone.
  const view = await service.getDeal({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    dealId: DEAL_ID,
  });
  assert.equal(view.sellerConsent, null);
});

test("getDeal surfaces the Accepted seller-consent projection when the PR is Accepted", async () => {
  const { service, projectRequestRepository } = buildFixture();
  // Seed the wired ProjectRequestRepository with an Accepted row.
  // The Deal row references PROJECT_REQUEST_ID, so the service's
  // getDeal() looks up by that id and projects consent.
  projectRequestRepository.seed({
    id: PROJECT_REQUEST_ID,
    buyerWorkspaceId: BUYER_WORKSPACE_ID,
    sellerWorkspaceId: SELLER_WORKSPACE_ID,
    serviceOfferingId: OFFERING_ID,
    projectBriefId: BRIEF_ID,
    createdByUserId: BUYER_USER_ID,
    status: "Accepted",
    sellerDecisionAt: new Date("2026-08-31T12:00:00Z"),
    sellerDecisionByUserId: SELLER_USER_ID,
    sellerConsentAt: new Date("2026-08-31T12:00:00Z"),
    createdAt: new Date("2026-08-30T00:00:00Z"),
    buyerWorkspaceName: "Buyer",
    sellerWorkspaceName: "Seller",
    serviceOfferingTitle: "Dancehall single",
    briefExcerpt: null,
  });
  const view = await service.getDeal({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    dealId: DEAL_ID,
  });
  assert.equal(view.sellerConsent?.status, "Accepted");
  assert.equal(view.sellerConsent?.sellerConsentAt, "2026-08-31T12:00:00.000Z");
});

test("getDeal surfaces sellerConsent: null when the PR exists but is not Accepted (fail-closed)", async () => {
  const { service, projectRequestRepository } = buildFixture();
  // A Declined PR violates the domain invariant that a Deal can
  // only exist after seller acceptance; even if a stale PR row is
  // reachable, the projection must be null so the UI does NOT
  // present false consent.
  projectRequestRepository.seed({
    id: PROJECT_REQUEST_ID,
    buyerWorkspaceId: BUYER_WORKSPACE_ID,
    sellerWorkspaceId: SELLER_WORKSPACE_ID,
    serviceOfferingId: OFFERING_ID,
    projectBriefId: BRIEF_ID,
    createdByUserId: BUYER_USER_ID,
    status: "Declined",
    sellerDecisionAt: new Date("2026-08-31T12:00:00Z"),
    sellerDecisionByUserId: SELLER_USER_ID,
    sellerConsentAt: null,
    createdAt: new Date("2026-08-30T00:00:00Z"),
    buyerWorkspaceName: "Buyer",
    sellerWorkspaceName: "Seller",
    serviceOfferingTitle: "Dancehall single",
    briefExcerpt: null,
  });
  const view = await service.getDeal({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    dealId: DEAL_ID,
  });
  assert.equal(view.sellerConsent, null);
});

test("getDeal surfaces sellerConsent: null when the PR lookup throws (fail-closed)", async () => {
  const { repo } = buildFixture();
  // Stub a faulty ProjectRequestRepository. A read failure must
  // collapse to null rather than bubble up — the UI must not
  // present false consent.
  const faultyRepo: ProjectRequestRepository = {
    createProjectRequestInTransaction: () => Promise.reject(new Error("not implemented")),
    respondToProjectRequestInTransaction: () => Promise.reject(new Error("not implemented")),
    findProjectRequestById: () => Promise.reject(new Error("db unavailable")),
    listProjectRequests: () => Promise.reject(new Error("not implemented")),
  };
  const clock = { current: new Date("2026-09-01T00:00:00Z") };
  const failClosedService = new DealTermsService({
    dealTermsRepository: repo,
    workspaceAuthorizationService: new WorkspaceAuthorizationService({
      authRepository: new InMemoryAuthRepository([]),
    }),
    projectRequestRepository: faultyRepo,
    now: () => clock.current,
  });
  // Use a service-bound Deal by seeding membership; reuse the
  // existing seedDeal approach via a fresh fixture.
  const view = await failClosedService.getDeal({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    dealId: DEAL_ID,
  });
  // Even with a faulty PR repo, the Deal read itself succeeded —
  // the projection collapses to null but the view's Deal fields are
  // intact.
  assert.equal(view.deal.dealId, DEAL_ID);
  assert.equal(view.sellerConsent, null);
});
