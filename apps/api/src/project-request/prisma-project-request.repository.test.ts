/* eslint-disable @typescript-eslint/no-floating-promises */
// Prisma adapter integration tests for ProjectRequestRepository.
//
// Background: ticket #62 GS 26 requires the persistence boundary to
// use natural uniqueness constraints + guarded state transitions so
// retries cannot create inappropriate duplicate ProjectRequests or
// multiple Deals for one accepted ProjectRequest. These tests prove
// the Prisma adapter enforces both invariants against a real
// PostgreSQL database, and that the FOR UPDATE-locked snapshot read
// fails closed when authority or eligibility changes commit
// between an external observer's pre-snapshot state and the
// repository's authoritative transaction state.
//
// The tests follow the M1 repository convention: each test resets
// the project_requests and deals tables (and their prerequisites)
// between cases so a run never depends on test ordering. The
// disposable test database lives at TEST_DATABASE_URL.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createPrismaClient, type PrismaClient } from "@soundhub/db";
import { assertDisposableTestDatabase, readTestDatabaseUrl } from "../lib/test-database.js";
import { PrismaProjectRequestRepository } from "./prisma-project-request.repository.js";
import { loadOrCreateFixture, type ProjectRequestFixture } from "./test-fixture.js";
import { buyerOkUseCase, buildAcceptUseCase, buildDeclineUseCase } from "./test-use-cases.js";

let prisma: PrismaClient;
let fixture: ProjectRequestFixture;
let repo: PrismaProjectRequestRepository;
const clockNow = new Date("2026-08-27T12:00:00Z");
const respondAcceptUseCase = buildAcceptUseCase(clockNow);
const respondDeclineUseCase = buildDeclineUseCase(clockNow);

before(async () => {
  const url = readTestDatabaseUrl();
  assertDisposableTestDatabase(url);
  prisma = createPrismaClient(url);
  fixture = await loadOrCreateFixture(prisma);
});

after(async () => {
  if (prisma) {
    await prisma.$disconnect();
  }
});

beforeEach(async () => {
  // Reset only the BG4 rows so the fixture's identity rows (Users,
  // Workspaces, Profiles, Briefs, Offerings) stay stable. The
  // termsVersions + dealApprovals rows (added by M2 #88) must be
  // removed first because they hold RESTRICT FKs to deals and
  // project requests; deleting deals without first removing the
  // dependent rows trips the FK constraint.
  await prisma.dealApproval.deleteMany({
    where: { termsVersion: { deal: { projectBriefId: fixture.brief.id } } },
  });
  await prisma.termsVersion.deleteMany({
    where: { deal: { projectBriefId: fixture.brief.id } },
  });
  await prisma.deal.deleteMany({
    where: { projectBriefId: fixture.brief.id },
  });
  await prisma.projectRequest.deleteMany({
    where: { projectBriefId: fixture.brief.id },
  });
  repo = new PrismaProjectRequestRepository(prisma);
});

// ---------- persistence + uniqueness ----------

test("createProjectRequestInTransaction persists a Pending row", async () => {
  const result = await repo.createProjectRequestInTransaction(
    {
      buyerWorkspaceId: fixture.buyerWorkspace.id,
      projectBriefId: fixture.brief.id,
      serviceOfferingId: fixture.offering.id,
      userAccountId: fixture.buyerUser.id,
    },
    buyerOkUseCase,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.status, "Pending");
  assert.equal(result.value.buyerWorkspaceId, fixture.buyerWorkspace.id);
  assert.equal(result.value.sellerWorkspaceId, fixture.sellerWorkspace.id);
  assert.equal(result.value.serviceOfferingId, fixture.offering.id);
  assert.equal(result.value.projectBriefId, fixture.brief.id);
  assert.equal(result.value.createdByUserId, fixture.buyerUser.id);
});

test("createProjectRequestInTransaction rejects a Pending duplicate with ALREADY_PENDING", async () => {
  const first = await repo.createProjectRequestInTransaction(
    {
      buyerWorkspaceId: fixture.buyerWorkspace.id,
      projectBriefId: fixture.brief.id,
      serviceOfferingId: fixture.offering.id,
      userAccountId: fixture.buyerUser.id,
    },
    buyerOkUseCase,
  );
  assert.equal(first.ok, true);
  const second = await repo.createProjectRequestInTransaction(
    {
      buyerWorkspaceId: fixture.buyerWorkspace.id,
      projectBriefId: fixture.brief.id,
      serviceOfferingId: fixture.offering.id,
      userAccountId: fixture.buyerUser.id,
    },
    buyerOkUseCase,
  );
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.reason, "ALREADY_PENDING");
});

// P1-001 verification: a buyer cannot submit an arbitrary eligible
// offering that Matchmaker never returned for the persisted brief.
test("createProjectRequestInTransaction rejects an offering not surfaced by the brief's Matchmaker", async () => {
  const result = await repo.createProjectRequestInTransaction(
    {
      buyerWorkspaceId: fixture.buyerWorkspace.id,
      projectBriefId: fixture.brief.id,
      serviceOfferingId: fixture.notRecommendedOffering.id,
      userAccountId: fixture.buyerUser.id,
    },
    buyerOkUseCase,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "OFFERING_NOT_IN_BRIEF");
  // No ProjectRequest row was inserted.
  const count = await prisma.projectRequest.count({
    where: { projectBriefId: fixture.brief.id },
  });
  assert.equal(count, 0);
});

test("createProjectRequestInTransaction rejects an unknown brief", async () => {
  const result = await repo.createProjectRequestInTransaction(
    {
      buyerWorkspaceId: fixture.buyerWorkspace.id,
      projectBriefId: "no-such-brief",
      serviceOfferingId: fixture.offering.id,
      userAccountId: fixture.buyerUser.id,
    },
    buyerOkUseCase,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "BRIEF_NOT_FOUND");
});

test("respondToProjectRequestInTransaction accept atomically creates the Deal and transitions to Accepted", async () => {
  const created = await repo.createProjectRequestInTransaction(
    {
      buyerWorkspaceId: fixture.buyerWorkspace.id,
      projectBriefId: fixture.brief.id,
      serviceOfferingId: fixture.offering.id,
      userAccountId: fixture.buyerUser.id,
    },
    buyerOkUseCase,
  );
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const result = await repo.respondToProjectRequestInTransaction(
    {
      projectRequestId: created.value.id,
      actingWorkspaceId: fixture.sellerWorkspace.id,
      userAccountId: fixture.sellerUser.id,
      now: clockNow,
    },
    respondAcceptUseCase,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  if (!("deal" in result.value)) return;
  assert.equal(result.value.projectRequest.status, "Accepted");
  assert.equal(result.value.deal.status, "Negotiating");
  assert.equal(result.value.deal.projectRequestId, created.value.id);
});

test("respondToProjectRequestInTransaction accept retried after Accept returns ALREADY_RESPONDED (no second Deal)", async () => {
  const created = await repo.createProjectRequestInTransaction(
    {
      buyerWorkspaceId: fixture.buyerWorkspace.id,
      projectBriefId: fixture.brief.id,
      serviceOfferingId: fixture.offering.id,
      userAccountId: fixture.buyerUser.id,
    },
    buyerOkUseCase,
  );
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const first = await repo.respondToProjectRequestInTransaction(
    {
      projectRequestId: created.value.id,
      actingWorkspaceId: fixture.sellerWorkspace.id,
      userAccountId: fixture.sellerUser.id,
      now: clockNow,
    },
    respondAcceptUseCase,
  );
  assert.equal(first.ok, true);
  const second = await repo.respondToProjectRequestInTransaction(
    {
      projectRequestId: created.value.id,
      actingWorkspaceId: fixture.sellerWorkspace.id,
      userAccountId: fixture.sellerUser.id,
      now: clockNow,
    },
    respondAcceptUseCase,
  );
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.reason, "ALREADY_RESPONDED");
  // Exactly one Deal in the database.
  const dealCount = await prisma.deal.count({
    where: { projectRequestId: created.value.id },
  });
  assert.equal(dealCount, 1);
});

test("respondToProjectRequestInTransaction decline transitions to Declined and creates no Deal", async () => {
  const created = await repo.createProjectRequestInTransaction(
    {
      buyerWorkspaceId: fixture.buyerWorkspace.id,
      projectBriefId: fixture.brief.id,
      serviceOfferingId: fixture.offering.id,
      userAccountId: fixture.buyerUser.id,
    },
    buyerOkUseCase,
  );
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const result = await repo.respondToProjectRequestInTransaction(
    {
      projectRequestId: created.value.id,
      actingWorkspaceId: fixture.sellerWorkspace.id,
      userAccountId: fixture.sellerUser.id,
      now: clockNow,
    },
    respondDeclineUseCase,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  if (!("status" in result.value)) return;
  assert.equal(result.value.status, "Declined");
  assert.equal(result.value.sellerConsentAt, null);
  const dealCount = await prisma.deal.count({
    where: { projectRequestId: created.value.id },
  });
  assert.equal(dealCount, 0);
});

test("respondToProjectRequestInTransaction accept retried after Decline returns ALREADY_RESPONDED", async () => {
  const created = await repo.createProjectRequestInTransaction(
    {
      buyerWorkspaceId: fixture.buyerWorkspace.id,
      projectBriefId: fixture.brief.id,
      serviceOfferingId: fixture.offering.id,
      userAccountId: fixture.buyerUser.id,
    },
    buyerOkUseCase,
  );
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const declined = await repo.respondToProjectRequestInTransaction(
    {
      projectRequestId: created.value.id,
      actingWorkspaceId: fixture.sellerWorkspace.id,
      userAccountId: fixture.sellerUser.id,
      now: clockNow,
    },
    respondDeclineUseCase,
  );
  assert.equal(declined.ok, true);
  const accepted = await repo.respondToProjectRequestInTransaction(
    {
      projectRequestId: created.value.id,
      actingWorkspaceId: fixture.sellerWorkspace.id,
      userAccountId: fixture.sellerUser.id,
      now: clockNow,
    },
    respondAcceptUseCase,
  );
  assert.equal(accepted.ok, false);
  if (accepted.ok) return;
  assert.equal(accepted.reason, "ALREADY_RESPONDED");
  const dealCount = await prisma.deal.count({
    where: { projectRequestId: created.value.id },
  });
  assert.equal(dealCount, 0);
});

// P1-002 verification: a Pending row that exists outside the
// repository (e.g. a concurrent retry from another process) blocks a
// second create for the same tuple via the partial unique index
// `project_requests_pending_unique_idx`. The repository translates
// the violation into ALREADY_PENDING, NOT a duplicate row.
test("createProjectRequestInTransaction is blocked by an externally-inserted Pending duplicate", async () => {
  // Bypass the repository and write the Pending row directly so we
  // can simulate a concurrent retry that committed between this
  // process's checks and its INSERT.
  await prisma.projectRequest.create({
    data: {
      buyerWorkspaceId: fixture.buyerWorkspace.id,
      sellerWorkspaceId: fixture.sellerWorkspace.id,
      serviceOfferingId: fixture.offering.id,
      projectBriefId: fixture.brief.id,
      createdByUserId: fixture.buyerUser.id,
      status: "Pending",
    },
  });
  const second = await repo.createProjectRequestInTransaction(
    {
      buyerWorkspaceId: fixture.buyerWorkspace.id,
      projectBriefId: fixture.brief.id,
      serviceOfferingId: fixture.offering.id,
      userAccountId: fixture.buyerUser.id,
    },
    buyerOkUseCase,
  );
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.reason, "ALREADY_PENDING");
  // Exactly one ProjectRequest row for this tuple.
  const count = await prisma.projectRequest.count({
    where: {
      buyerWorkspaceId: fixture.buyerWorkspace.id,
      sellerWorkspaceId: fixture.sellerWorkspace.id,
      serviceOfferingId: fixture.offering.id,
      projectBriefId: fixture.brief.id,
    },
  });
  assert.equal(count, 1);
});

// P1-004 verification: the FKs on ProjectRequest and Deal use
// `ON DELETE RESTRICT` (NOT cascade / set null) so Workspace,
// ProjectRequest, or deciding-UserAccount deletion cannot erase
// accepted consent or the audit evidence.
test("RESTRICT prevents Workspace deletion from erasing accepted ProjectRequests and Deals", async () => {
  // Create + accept so a Deal exists alongside the ProjectRequest.
  const created = await repo.createProjectRequestInTransaction(
    {
      buyerWorkspaceId: fixture.buyerWorkspace.id,
      projectBriefId: fixture.brief.id,
      serviceOfferingId: fixture.offering.id,
      userAccountId: fixture.buyerUser.id,
    },
    buyerOkUseCase,
  );
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const accepted = await repo.respondToProjectRequestInTransaction(
    {
      projectRequestId: created.value.id,
      actingWorkspaceId: fixture.sellerWorkspace.id,
      userAccountId: fixture.sellerUser.id,
      now: clockNow,
    },
    respondAcceptUseCase,
  );
  assert.equal(accepted.ok, true);
  if (!accepted.ok) return;

  // Buyer-workspace deletion must fail because a ProjectRequest
  // references it.
  await assert.rejects(
    prisma.workspace.delete({ where: { id: fixture.buyerWorkspace.id } }),
    (err: unknown) => err instanceof Error && /foreign key/i.test(err.message),
  );
  // Seller-workspace deletion must fail because both a
  // ProjectRequest and a Deal reference it.
  await assert.rejects(
    prisma.workspace.delete({ where: { id: fixture.sellerWorkspace.id } }),
    (err: unknown) => err instanceof Error && /foreign key/i.test(err.message),
  );

  // The ProjectRequest and Deal rows are still present, with
  // their consent and audit evidence intact.
  const stillThere = await prisma.projectRequest.findUnique({
    where: { id: created.value.id },
  });
  assert.notEqual(stillThere, null);
  assert.equal(stillThere?.sellerConsentAt?.toISOString(), clockNow.toISOString());
  assert.equal(stillThere?.sellerDecisionByUserId, fixture.sellerUser.id);
  const dealCount = await prisma.deal.count({
    where: { projectRequestId: created.value.id },
  });
  assert.equal(dealCount, 1);
});

test("RESTRICT prevents ProjectRequest deletion from erasing the associated Deal", async () => {
  const created = await repo.createProjectRequestInTransaction(
    {
      buyerWorkspaceId: fixture.buyerWorkspace.id,
      projectBriefId: fixture.brief.id,
      serviceOfferingId: fixture.offering.id,
      userAccountId: fixture.buyerUser.id,
    },
    buyerOkUseCase,
  );
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const accepted = await repo.respondToProjectRequestInTransaction(
    {
      projectRequestId: created.value.id,
      actingWorkspaceId: fixture.sellerWorkspace.id,
      userAccountId: fixture.sellerUser.id,
      now: clockNow,
    },
    respondAcceptUseCase,
  );
  assert.equal(accepted.ok, true);
  if (!accepted.ok) return;

  await assert.rejects(
    prisma.projectRequest.delete({ where: { id: created.value.id } }),
    (err: unknown) => err instanceof Error && /foreign key/i.test(err.message),
  );
  const dealCount = await prisma.deal.count({
    where: { projectRequestId: created.value.id },
  });
  assert.equal(dealCount, 1);
});

test("RESTRICT prevents deciding-UserAccount deletion from nulling seller consent attribution", async () => {
  const created = await repo.createProjectRequestInTransaction(
    {
      buyerWorkspaceId: fixture.buyerWorkspace.id,
      projectBriefId: fixture.brief.id,
      serviceOfferingId: fixture.offering.id,
      userAccountId: fixture.buyerUser.id,
    },
    buyerOkUseCase,
  );
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const accepted = await repo.respondToProjectRequestInTransaction(
    {
      projectRequestId: created.value.id,
      actingWorkspaceId: fixture.sellerWorkspace.id,
      userAccountId: fixture.sellerUser.id,
      now: clockNow,
    },
    respondAcceptUseCase,
  );
  assert.equal(accepted.ok, true);
  if (!accepted.ok) return;

  // The deciding UserAccount must NOT be deletable while a
  // ProjectRequest records the consent attribution.
  await assert.rejects(
    prisma.userAccount.delete({ where: { id: fixture.sellerUser.id } }),
    (err: unknown) => err instanceof Error && /foreign key/i.test(err.message),
  );
  const stillThere = await prisma.projectRequest.findUnique({
    where: { id: created.value.id },
  });
  assert.equal(stillThere?.sellerDecisionByUserId, fixture.sellerUser.id);
  assert.equal(stillThere?.sellerConsentAt?.toISOString(), clockNow.toISOString());
});

// P1-001 / P1-002 / P1-003 invariants at the repository level:
//
//   1. The application-owned policy evaluators (in
//      `./project-request-authorization-policy.ts`) are the only
//      decision points. The Prisma adapter loads + FOR UPDATE-locks
//      every row the policy depends on, hands the snapshots to the
//      application-supplied use case, and persists only when the use
//      case returns `persist`. A `reject` rolls back with no state
//      change.
//
//   2. Concurrent / repeated acceptance of the same Pending row
//      cannot create multiple Deals. The partial unique index on
//      `deals.projectRequestId` plus the guarded
//      `updateMany WHERE status='Pending'` enforce this without a
//      serialization-retry framework.
//
//   3. The interleaving tests in this file (see
//      `prisma-project-request.repository.interleaving.test.ts`)
//      exercise a second PostgreSQL connection to mutate authority /
//      eligibility facts while the repository's transaction holds
//      FOR UPDATE locks, proving the locking semantics described in
//      ticket #62 hold in production.
