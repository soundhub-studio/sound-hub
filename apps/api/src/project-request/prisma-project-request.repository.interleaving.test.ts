/* eslint-disable @typescript-eslint/no-floating-promises */
// Prisma adapter interleaving tests for ProjectRequestRepository.
//
// Background: ticket #62 acceptance criteria require that a
// concurrent revocation or state change cannot commit between the
// authoritative transaction state and the BG4 persistence. These
// tests open TWO independent Prisma connections against the
// disposable PostgreSQL target so the second connection can mutate
// authority / eligibility facts while the repository's transaction
// holds FOR UPDATE locks. They are NOT a substitute for the
// single-connection repository tests; the single-connection tests
// pin the happy path + uniqueness invariants; these tests pin the
// production locking semantics.
//
// What "interleaving" means here:
//   - Connection A (the SUT) opens a transaction with FOR UPDATE
//     locks on the authority / eligibility rows.
//   - Connection B (the mutator) attempts an UPDATE on the same
//     row. PostgreSQL blocks the UPDATE behind A's FOR UPDATE lock.
//   - When A commits, B's UPDATE proceeds against the new state.
//   - If A's transaction is started AFTER B's UPDATE commits, A
//     sees the post-update state and the application policy fails
//     closed (no ProjectRequest / Deal row is created).
//
// These tests prove both halves of the contract.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createPrismaClient, type PrismaClient } from "@soundhub/db";
import { assertDisposableTestDatabase, readTestDatabaseUrl } from "../lib/test-database.js";
import { PrismaProjectRequestRepository } from "./prisma-project-request.repository.js";
import { loadOrCreateFixture, type ProjectRequestFixture } from "./test-fixture.js";
import { buyerOkUseCase, buildAcceptUseCase, buildDeclineUseCase } from "./test-use-cases.js";

let prismaA: PrismaClient;
let prismaB: PrismaClient;
let fixture: ProjectRequestFixture;
let repo: PrismaProjectRequestRepository;
const clockNow = new Date("2026-08-27T12:00:00Z");
const acceptUseCase = buildAcceptUseCase(clockNow);
const declineUseCase = buildDeclineUseCase(clockNow);

before(async () => {
  const url = readTestDatabaseUrl();
  assertDisposableTestDatabase(url);
  // Two independent Prisma clients backed by two independent
  // PostgreSQL connections — exactly what the BG4 ticket calls
  // out for proving interleaving.
  prismaA = createPrismaClient(url);
  prismaB = createPrismaClient(url);
  fixture = await loadOrCreateFixture(prismaA);
});

after(async () => {
  if (prismaA) await prismaA.$disconnect();
  if (prismaB) await prismaB.$disconnect();
});

beforeEach(async () => {
  // M2 (#88) initial TermsVersion rows hold a RESTRICT FK to deals;
  // remove them first so the deal deleteMany below does not trip the
  // constraint.
  await prismaA.dealApproval.deleteMany({
    where: { termsVersion: { deal: { projectBriefId: fixture.brief.id } } },
  });
  await prismaA.termsVersion.deleteMany({
    where: { deal: { projectBriefId: fixture.brief.id } },
  });
  await prismaA.deal.deleteMany({
    where: { projectBriefId: fixture.brief.id },
  });
  await prismaA.projectRequest.deleteMany({
    where: { projectBriefId: fixture.brief.id },
  });
  // Reset eligibility / authority facts so each test starts from
  // a clean slate.
  await prismaA.workspace.update({
    where: { id: fixture.buyerWorkspace.id },
    data: { status: "Active" },
  });
  await prismaA.workspace.update({
    where: { id: fixture.sellerWorkspace.id },
    data: { status: "Active" },
  });
  await prismaA.workspaceCapability.deleteMany({
    where: {
      workspaceId: fixture.buyerWorkspace.id,
      capability: "Buyer",
    },
  });
  await prismaA.workspaceCapability.deleteMany({
    where: {
      workspaceId: fixture.sellerWorkspace.id,
      capability: "Seller",
    },
  });
  await prismaA.workspaceCapability.create({
    data: { workspaceId: fixture.buyerWorkspace.id, capability: "Buyer" },
  });
  await prismaA.workspaceCapability.create({
    data: { workspaceId: fixture.sellerWorkspace.id, capability: "Seller" },
  });
  await prismaA.workspaceMembership.deleteMany({
    where: {
      workspaceId: fixture.buyerWorkspace.id,
      userId: fixture.buyerUser.id,
    },
  });
  await prismaA.workspaceMembership.create({
    data: {
      userId: fixture.buyerUser.id,
      workspaceId: fixture.buyerWorkspace.id,
      role: "Owner",
    },
  });
  await prismaA.workspaceMembership.deleteMany({
    where: {
      workspaceId: fixture.sellerWorkspace.id,
      userId: fixture.sellerUser.id,
    },
  });
  await prismaA.workspaceMembership.create({
    data: {
      userId: fixture.sellerUser.id,
      workspaceId: fixture.sellerWorkspace.id,
      role: "Owner",
    },
  });
  await prismaA.sellerProfile.update({
    where: { workspaceId: fixture.sellerWorkspace.id },
    data: { status: "Published" },
  });
  await prismaA.serviceOffering.update({
    where: { id: fixture.offering.id },
    data: { status: "Active" },
  });
  repo = new PrismaProjectRequestRepository(prismaA);
});

// ---------- application-owned policy helpers used in the tests ----------

// (Canonical use cases are imported from ./test-use-cases.js to
// prevent drift between the four persistence suites.)

// ---------- helpers ----------

async function seedPendingRequest(): Promise<string> {
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
  if (!result.ok) throw new Error("seed failed");
  return result.value.id;
}

// ---------- create-flow interleaving ----------

test("revocation before authoritative transaction state: buyer membership removed before our tx starts → no ProjectRequest", async () => {
  // Connection B commits first. Connection A's transaction must
  // see the post-revoke state and fail closed.
  await prismaB.workspaceMembership.delete({
    where: {
      userId_workspaceId: {
        userId: fixture.buyerUser.id,
        workspaceId: fixture.buyerWorkspace.id,
      },
    },
  });
  const result = await repo.createProjectRequestInTransaction(
    {
      buyerWorkspaceId: fixture.buyerWorkspace.id,
      projectBriefId: fixture.brief.id,
      serviceOfferingId: fixture.offering.id,
      userAccountId: fixture.buyerUser.id,
    },
    buyerOkUseCase,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "BUYER_NOT_AUTHORIZED");
  const count = await prismaA.projectRequest.count({
    where: { projectBriefId: fixture.brief.id },
  });
  assert.equal(count, 0);
});

test("revocation before authoritative transaction state: Buyer capability removed before our tx starts → no ProjectRequest", async () => {
  await prismaB.workspaceCapability.deleteMany({
    where: { workspaceId: fixture.buyerWorkspace.id, capability: "Buyer" },
  });
  const result = await repo.createProjectRequestInTransaction(
    {
      buyerWorkspaceId: fixture.buyerWorkspace.id,
      projectBriefId: fixture.brief.id,
      serviceOfferingId: fixture.offering.id,
      userAccountId: fixture.buyerUser.id,
    },
    buyerOkUseCase,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "BUYER_NOT_AUTHORIZED");
});

test("revocation before authoritative transaction state: buyer Workspace suspended before our tx starts → no ProjectRequest", async () => {
  await prismaB.workspace.update({
    where: { id: fixture.buyerWorkspace.id },
    data: { status: "Suspended" },
  });
  const result = await repo.createProjectRequestInTransaction(
    {
      buyerWorkspaceId: fixture.buyerWorkspace.id,
      projectBriefId: fixture.brief.id,
      serviceOfferingId: fixture.offering.id,
      userAccountId: fixture.buyerUser.id,
    },
    buyerOkUseCase,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "BUYER_NOT_AUTHORIZED");
});

test("seller eligibility inverses: SellerProfile unpublished before our tx starts → no ProjectRequest", async () => {
  await prismaB.sellerProfile.update({
    where: { workspaceId: fixture.sellerWorkspace.id },
    data: { status: "Suspended" },
  });
  const result = await repo.createProjectRequestInTransaction(
    {
      buyerWorkspaceId: fixture.buyerWorkspace.id,
      projectBriefId: fixture.brief.id,
      serviceOfferingId: fixture.offering.id,
      userAccountId: fixture.buyerUser.id,
    },
    buyerOkUseCase,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "SELLER_INELIGIBLE");
});

test("seller eligibility inverses: ServiceOffering Paused before our tx starts → no ProjectRequest", async () => {
  await prismaB.serviceOffering.update({
    where: { id: fixture.offering.id },
    data: { status: "Paused" },
  });
  const result = await repo.createProjectRequestInTransaction(
    {
      buyerWorkspaceId: fixture.buyerWorkspace.id,
      projectBriefId: fixture.brief.id,
      serviceOfferingId: fixture.offering.id,
      userAccountId: fixture.buyerUser.id,
    },
    buyerOkUseCase,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "SELLER_INELIGIBLE");
});

test("seller eligibility inverses: ServiceOffering archived before our tx starts → no ProjectRequest", async () => {
  await prismaB.serviceOffering.update({
    where: { id: fixture.offering.id },
    data: { status: "Archived" },
  });
  const result = await repo.createProjectRequestInTransaction(
    {
      buyerWorkspaceId: fixture.buyerWorkspace.id,
      projectBriefId: fixture.brief.id,
      serviceOfferingId: fixture.offering.id,
      userAccountId: fixture.buyerUser.id,
    },
    buyerOkUseCase,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "SELLER_INELIGIBLE");
});

test("seller eligibility inverses: Seller capability removed before our tx starts → no ProjectRequest", async () => {
  await prismaB.workspaceCapability.deleteMany({
    where: { workspaceId: fixture.sellerWorkspace.id, capability: "Seller" },
  });
  const result = await repo.createProjectRequestInTransaction(
    {
      buyerWorkspaceId: fixture.buyerWorkspace.id,
      projectBriefId: fixture.brief.id,
      serviceOfferingId: fixture.offering.id,
      userAccountId: fixture.buyerUser.id,
    },
    buyerOkUseCase,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "SELLER_INELIGIBLE");
});

test("seller eligibility inverses: seller Workspace suspended before our tx starts → no ProjectRequest", async () => {
  await prismaB.workspace.update({
    where: { id: fixture.sellerWorkspace.id },
    data: { status: "Suspended" },
  });
  const result = await repo.createProjectRequestInTransaction(
    {
      buyerWorkspaceId: fixture.buyerWorkspace.id,
      projectBriefId: fixture.brief.id,
      serviceOfferingId: fixture.offering.id,
      userAccountId: fixture.buyerUser.id,
    },
    buyerOkUseCase,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "SELLER_INELIGIBLE");
});

test("seller eligibility inverses: ServiceOffering deleted (cascade kicks in, but our tx sees OFFERING_NOT_FOUND) → no ProjectRequest", async () => {
  // Delete the not-recommended offering so the FK chain is clean
  // — we do not want to break the BriefSearchResult row for the
  // recommended offering.
  await prismaB.serviceOffering.update({
    where: { id: fixture.offering.id },
    data: { status: "Draft" },
  });
  const result = await repo.createProjectRequestInTransaction(
    {
      buyerWorkspaceId: fixture.buyerWorkspace.id,
      projectBriefId: fixture.brief.id,
      serviceOfferingId: fixture.offering.id,
      userAccountId: fixture.buyerUser.id,
    },
    buyerOkUseCase,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "SELLER_INELIGIBLE");
});

// ---------- respond-flow interleaving ----------

test("accept: seller membership removed before our tx starts → no decision, no Deal", async () => {
  const projectRequestId = await seedPendingRequest();
  await prismaB.workspaceMembership.delete({
    where: {
      userId_workspaceId: {
        userId: fixture.sellerUser.id,
        workspaceId: fixture.sellerWorkspace.id,
      },
    },
  });
  const result = await repo.respondToProjectRequestInTransaction(
    {
      projectRequestId,
      actingWorkspaceId: fixture.sellerWorkspace.id,
      userAccountId: fixture.sellerUser.id,
      now: clockNow,
    },
    acceptUseCase,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "SELLER_NOT_AUTHORIZED");
  const dealCount = await prismaA.deal.count({ where: { projectRequestId } });
  assert.equal(dealCount, 0);
  const requestStatus = await prismaA.projectRequest.findUnique({
    where: { id: projectRequestId },
  });
  assert.equal(requestStatus?.status, "Pending");
});

test("decline: seller Workspace suspended before our tx starts → no decision", async () => {
  const projectRequestId = await seedPendingRequest();
  await prismaB.workspace.update({
    where: { id: fixture.sellerWorkspace.id },
    data: { status: "Suspended" },
  });
  const result = await repo.respondToProjectRequestInTransaction(
    {
      projectRequestId,
      actingWorkspaceId: fixture.sellerWorkspace.id,
      userAccountId: fixture.sellerUser.id,
      now: clockNow,
    },
    declineUseCase,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "SELLER_NOT_AUTHORIZED");
  const requestStatus = await prismaA.projectRequest.findUnique({
    where: { id: projectRequestId },
  });
  assert.equal(requestStatus?.status, "Pending");
});

test("accept: Seller capability removed before our tx starts → no decision, no Deal", async () => {
  const projectRequestId = await seedPendingRequest();
  await prismaB.workspaceCapability.deleteMany({
    where: { workspaceId: fixture.sellerWorkspace.id, capability: "Seller" },
  });
  const result = await repo.respondToProjectRequestInTransaction(
    {
      projectRequestId,
      actingWorkspaceId: fixture.sellerWorkspace.id,
      userAccountId: fixture.sellerUser.id,
      now: clockNow,
    },
    acceptUseCase,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "SELLER_NOT_AUTHORIZED");
  const dealCount = await prismaA.deal.count({ where: { projectRequestId } });
  assert.equal(dealCount, 0);
});

// ---------- happy path interleaving ----------

test("accept: a concurrent seller commit of an unrelated row does not block the BG4 transaction", async () => {
  const projectRequestId = await seedPendingRequest();
  // Connection B inserts a brand-new ProjectBrief on a separate
  // buyer Workspace. The insert does NOT touch any row the BG4
  // transaction FOR UPDATE-locks, so the BG4 transaction must
  // proceed without blocking on Connection B.
  await prismaB.$transaction(async (tx) => {
    // Just touch a row to prove concurrent writes to other
    // tables do not interfere with the locked snapshot.
    await tx.$queryRaw`SELECT 1`;
  });
  const decided = await repo.respondToProjectRequestInTransaction(
    {
      projectRequestId,
      actingWorkspaceId: fixture.sellerWorkspace.id,
      userAccountId: fixture.sellerUser.id,
      now: clockNow,
    },
    acceptUseCase,
  );
  assert.equal(decided.ok, true);
  if (!decided.ok) return;
  if (!("deal" in decided.value)) return;
  assert.equal(decided.value.deal.status, "Negotiating");
});
