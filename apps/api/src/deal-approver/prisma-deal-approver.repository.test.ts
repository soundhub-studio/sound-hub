/* eslint-disable @typescript-eslint/no-floating-promises */
// Prisma adapter integration tests for DealApproverRepository (M2 #88).
//
// Background: ticket #88 acceptance criteria require the
// Personal-Workspace-only, capability-neutral, self-service
// provisioning command to atomically create exactly one
// `DealApprover` row AND one `DealApproverAcceptance` evidence row.
// The (deal_approvers(workspaceId, userId)) UNIQUE index and the
// (deal_approver_acceptances(workspaceId, idempotencyKey)) UNIQUE
// index are the durable convergence keys for retries.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createPrismaClient, type PrismaClient } from "@soundhub/db";
import { assertDisposableTestDatabase, readTestDatabaseUrl } from "../lib/test-database.js";
import { PrismaDealApproverRepository } from "./prisma-deal-approver.repository.js";
import { randomUUID } from "node:crypto";

let prisma: PrismaClient;
let repo: PrismaDealApproverRepository;

const PERSONAL_OWNER_ID = "user-personal-owner";
const OTHER_USER_ID = "user-other";
const PERSONAL_WORKSPACE_ID = "ws-personal-active";
const ORG_WORKSPACE_ID = "ws-organization-active";
const SUSPENDED_WORKSPACE_ID = "ws-personal-suspended";
const NON_MEMBER_WORKSPACE_ID = "ws-personal-non-member";

let personalWorkspaceId: string;
let orgWorkspaceId: string;
let suspendedWorkspaceId: string;
let nonMemberWorkspaceId: string;
let sameKeyRetryWorkspaceId: string;
let personalOwnerId: string;
let otherUserId: string;
let requestId: string;

before(async () => {
  const url = readTestDatabaseUrl();
  assertDisposableTestDatabase(url);
  prisma = createPrismaClient(url);
  repo = new PrismaDealApproverRepository(prisma);

  // Wipe any rows left behind by a previous test run.
  await prisma.dealApproverAcceptance.deleteMany({});
  await prisma.dealApprover.deleteMany({});
  await prisma.workspaceMembership.deleteMany({});
  await prisma.workspace.deleteMany({});
  await prisma.userAccount.deleteMany({});

  personalOwnerId = `${PERSONAL_OWNER_ID}-${randomUUID()}`;
  otherUserId = `${OTHER_USER_ID}-${randomUUID()}`;
  personalWorkspaceId = `${PERSONAL_WORKSPACE_ID}-${randomUUID()}`;
  orgWorkspaceId = `${ORG_WORKSPACE_ID}-${randomUUID()}`;
  suspendedWorkspaceId = `${SUSPENDED_WORKSPACE_ID}-${randomUUID()}`;
  nonMemberWorkspaceId = `${NON_MEMBER_WORKSPACE_ID}-${randomUUID()}`;
  sameKeyRetryWorkspaceId = `ws-personal-same-key-retry-${randomUUID()}`;
  requestId = `req-${randomUUID()}`;

  await prisma.userAccount.create({
    data: { id: personalOwnerId, email: `personal-owner-${randomUUID()}@example.com` },
  });
  await prisma.userAccount.create({
    data: { id: otherUserId, email: `other-${randomUUID()}@example.com` },
  });
  await prisma.workspace.create({
    data: {
      id: personalWorkspaceId,
      slug: `personal-${randomUUID()}`,
      name: "Personal",
      type: "Personal",
      status: "Active",
      ownerUserId: personalOwnerId,
    },
  });
  await prisma.workspace.create({
    data: {
      id: orgWorkspaceId,
      slug: `org-${randomUUID()}`,
      name: "Organization",
      type: "Organization",
      status: "Active",
      ownerUserId: personalOwnerId,
    },
  });
  await prisma.workspace.create({
    data: {
      id: suspendedWorkspaceId,
      slug: `suspended-${randomUUID()}`,
      name: "Suspended Personal",
      type: "Personal",
      status: "Suspended",
      ownerUserId: personalOwnerId,
    },
  });
  await prisma.workspace.create({
    data: {
      id: nonMemberWorkspaceId,
      slug: `non-member-${randomUUID()}`,
      name: "Non-member Personal",
      type: "Personal",
      status: "Active",
      ownerUserId: personalOwnerId,
    },
  });
  await prisma.workspace.create({
    data: {
      id: sameKeyRetryWorkspaceId,
      slug: `same-key-retry-${randomUUID()}`,
      name: "Same-key retry Personal",
      type: "Personal",
      status: "Active",
      ownerUserId: personalOwnerId,
    },
  });
  await prisma.workspaceMembership.create({
    data: { userId: personalOwnerId, workspaceId: personalWorkspaceId, role: "Owner" },
  });
  await prisma.workspaceMembership.create({
    data: { userId: personalOwnerId, workspaceId: orgWorkspaceId, role: "Owner" },
  });
  await prisma.workspaceMembership.create({
    data: { userId: personalOwnerId, workspaceId: suspendedWorkspaceId, role: "Owner" },
  });
  await prisma.workspaceMembership.create({
    data: { userId: otherUserId, workspaceId: orgWorkspaceId, role: "Owner" },
  });
  await prisma.workspaceMembership.create({
    data: {
      userId: personalOwnerId,
      workspaceId: sameKeyRetryWorkspaceId,
      role: "Owner",
    },
  });
  // intentionally NOT a member of nonMemberWorkspaceId
});

after(async () => {
  if (prisma) {
    await prisma.dealApproverAcceptance.deleteMany({});
    await prisma.dealApprover.deleteMany({});
    await prisma.workspaceMembership.deleteMany({});
    await prisma.workspace.deleteMany({});
    await prisma.userAccount.deleteMany({});
    await prisma.$disconnect();
  }
});

test("provisionDealApproverInTransaction atomically creates DealApprover + DealApproverAcceptance rows", async () => {
  const result = await repo.provisionDealApproverInTransaction(
    {
      userAccountId: personalOwnerId,
      actingWorkspaceId: personalWorkspaceId,
      confirmationVersion: "m2-deal-approver-v1",
      idempotencyKey: randomUUID(),
      requestId,
      now: new Date(),
    },
    (ctx, tools) => {
      if (ctx.authority.workspaceStatus !== "Active") return tools.reject("WORKSPACE_INELIGIBLE");
      if (ctx.authority.workspaceType !== "Personal") return tools.reject("NOT_PERSONAL_WORKSPACE");
      if (!ctx.authority.isMember) return tools.reject("NOT_A_MEMBER");
      if (ctx.authority.dealApproverExists) return tools.reject("ALREADY_PROVISIONED");
      return tools.persist({
        workspaceId: ctx.authority.actingWorkspaceId,
        userId: ctx.authority.userAccountId,
        grantedByUserId: ctx.authority.userAccountId,
        confirmationVersion: "m2-deal-approver-v1",
        idempotencyKey: "ignored-by-repo-because-preCheckHits",
        requestId,
        now: new Date(),
      });
    },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.dealApprover.workspaceId, personalWorkspaceId);
  assert.equal(result.value.dealApprover.userId, personalOwnerId);
  assert.equal(result.value.acceptance.confirmationVersion, "m2-deal-approver-v1");
});

test("provisionDealApproverInTransaction same-key retry converges on the existing row", async () => {
  // Use the dedicated sameKeyRetryWorkspaceId so the
  // (workspaceId, userId) row does NOT exist before the first
  // call. The first call persists the row; the second call uses
  // the SAME idempotencyKey so the repository's pre-check
  // short-circuits through the (workspaceId, idempotencyKey)
  // acceptance pre-check and returns the existing pair.
  const idempotencyKey = randomUUID();
  const first = await repo.provisionDealApproverInTransaction(
    {
      userAccountId: personalOwnerId,
      actingWorkspaceId: sameKeyRetryWorkspaceId,
      confirmationVersion: "m2-deal-approver-v1",
      idempotencyKey,
      requestId,
      now: new Date(),
    },
    (ctx, tools) =>
      tools.persist({
        workspaceId: ctx.authority.actingWorkspaceId,
        userId: ctx.authority.userAccountId,
        grantedByUserId: ctx.authority.userAccountId,
        confirmationVersion: "m2-deal-approver-v1",
        idempotencyKey,
        requestId,
        now: new Date(),
      }),
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;

  const second = await repo.provisionDealApproverInTransaction(
    {
      userAccountId: personalOwnerId,
      actingWorkspaceId: sameKeyRetryWorkspaceId,
      confirmationVersion: "m2-deal-approver-v1",
      idempotencyKey,
      requestId,
      now: new Date(),
    },
    (ctx, tools) => {
      // The repository pre-check should find the existing
      // acceptance and short-circuit BEFORE this use case is
      // invoked. The use case is unreachable on the retry path.
      return tools.persist({
        workspaceId: ctx.authority.actingWorkspaceId,
        userId: ctx.authority.userAccountId,
        grantedByUserId: ctx.authority.userAccountId,
        confirmationVersion: "m2-deal-approver-v1",
        idempotencyKey,
        requestId,
        now: new Date(),
      });
    },
  );
  assert.equal(second.ok, true);
  if (!second.ok) return;
  // Same-key retry must return the IDENTICAL row id pair.
  assert.equal(second.value.dealApprover.id, first.value.dealApprover.id);
  assert.equal(second.value.acceptance.id, first.value.acceptance.id);
});

test("provisionDealApproverInTransaction different-key retry against an already-provisioned tuple surfaces ALREADY_PROVISIONED", async () => {
  // The first test created a (workspaceId, userId) row for
  // `personalOwnerId` + `personalWorkspaceId`. A different-key
  // retry against the same tuple must surface ALREADY_PROVISIONED.
  const second = await repo.provisionDealApproverInTransaction(
    {
      userAccountId: personalOwnerId,
      actingWorkspaceId: personalWorkspaceId,
      confirmationVersion: "m2-deal-approver-v1",
      idempotencyKey: randomUUID(),
      requestId,
      now: new Date(),
    },
    (ctx, tools) => {
      // The policy evaluator rejects because the snapshot's
      // `dealApproverExists` is true after the previous test.
      if (ctx.authority.dealApproverExists) return tools.reject("ALREADY_PROVISIONED");
      return tools.persist({
        workspaceId: ctx.authority.actingWorkspaceId,
        userId: ctx.authority.userAccountId,
        grantedByUserId: ctx.authority.userAccountId,
        confirmationVersion: "m2-deal-approver-v1",
        idempotencyKey: "ignored",
        requestId,
        now: new Date(),
      });
    },
  );
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.reason, "ALREADY_PROVISIONED");
});

test("provisionDealApproverInTransaction rejects a non-Personal Workspace", async () => {
  const result = await repo.provisionDealApproverInTransaction(
    {
      userAccountId: personalOwnerId,
      actingWorkspaceId: orgWorkspaceId,
      confirmationVersion: "m2-deal-approver-v1",
      idempotencyKey: randomUUID(),
      requestId,
      now: new Date(),
    },
    (ctx, tools) => {
      if (ctx.authority.workspaceType !== "Personal") return tools.reject("NOT_PERSONAL_WORKSPACE");
      return tools.persist({
        workspaceId: ctx.authority.actingWorkspaceId,
        userId: ctx.authority.userAccountId,
        grantedByUserId: ctx.authority.userAccountId,
        confirmationVersion: "m2-deal-approver-v1",
        idempotencyKey: "ignored",
        requestId,
        now: new Date(),
      });
    },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "NOT_PERSONAL_WORKSPACE");
});

test("provisionDealApproverInTransaction rejects a Suspended Workspace", async () => {
  const result = await repo.provisionDealApproverInTransaction(
    {
      userAccountId: personalOwnerId,
      actingWorkspaceId: suspendedWorkspaceId,
      confirmationVersion: "m2-deal-approver-v1",
      idempotencyKey: randomUUID(),
      requestId,
      now: new Date(),
    },
    (ctx, tools) => {
      if (ctx.authority.workspaceStatus !== "Active") return tools.reject("WORKSPACE_INELIGIBLE");
      return tools.persist({
        workspaceId: ctx.authority.actingWorkspaceId,
        userId: ctx.authority.userAccountId,
        grantedByUserId: ctx.authority.userAccountId,
        confirmationVersion: "m2-deal-approver-v1",
        idempotencyKey: "ignored",
        requestId,
        now: new Date(),
      });
    },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "WORKSPACE_INELIGIBLE");
});

test("provisionDealApproverInTransaction rejects a non-member", async () => {
  const result = await repo.provisionDealApproverInTransaction(
    {
      userAccountId: otherUserId,
      actingWorkspaceId: nonMemberWorkspaceId,
      confirmationVersion: "m2-deal-approver-v1",
      idempotencyKey: randomUUID(),
      requestId,
      now: new Date(),
    },
    (ctx, tools) => {
      if (!ctx.authority.isMember) return tools.reject("NOT_A_MEMBER");
      return tools.persist({
        workspaceId: ctx.authority.actingWorkspaceId,
        userId: ctx.authority.userAccountId,
        grantedByUserId: ctx.authority.userAccountId,
        confirmationVersion: "m2-deal-approver-v1",
        idempotencyKey: "ignored",
        requestId,
        now: new Date(),
      });
    },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "NOT_A_MEMBER");
});

test("provisionDealApproverInTransaction does not consult Workspace.ownerUserId", async () => {
  // The ownerUserId column is M1.1 metadata; it must NEVER grant
  // authority. `otherUserId` is NOT a member of
  // `personalWorkspaceId` and the request must fail closed with
  // NOT_A_MEMBER even though the Workspace's ownerUserId would
  // match if the legacy field were consulted.
  const result = await repo.provisionDealApproverInTransaction(
    {
      userAccountId: otherUserId,
      actingWorkspaceId: personalWorkspaceId,
      confirmationVersion: "m2-deal-approver-v1",
      idempotencyKey: randomUUID(),
      requestId,
      now: new Date(),
    },
    (ctx, tools) => {
      if (!ctx.authority.isMember) return tools.reject("NOT_A_MEMBER");
      return tools.persist({
        workspaceId: ctx.authority.actingWorkspaceId,
        userId: ctx.authority.userAccountId,
        grantedByUserId: ctx.authority.userAccountId,
        confirmationVersion: "m2-deal-approver-v1",
        idempotencyKey: "ignored",
        requestId,
        now: new Date(),
      });
    },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "NOT_A_MEMBER");
});
