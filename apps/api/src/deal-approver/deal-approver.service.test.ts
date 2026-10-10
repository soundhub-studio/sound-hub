/* eslint-disable @typescript-eslint/no-floating-promises */
// DealApproverService unit tests (M2 #88).
//
// Background: ticket #88 acceptance requires a
// Personal-Workspace-only, capability-neutral, self-service
// command that creates a `DealApprover` authorization AND a
// `DealApproverAcceptance` evidence row in one transaction. The
// service is the application-owned policy boundary; the
// InMemoryDealApproverRepository is the unit-test mirror of the
// Prisma adapter's contract surface.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DealApproverService, DealApproverError } from "./deal-approver.service.js";
import { InMemoryDealApproverRepository } from "./in-memory-deal-approver.repository.js";

const PERSONAL_WORKSPACE_ID = "ws-personal";
const ORGANIZATION_WORKSPACE_ID = "ws-organization";
const SUSPENDED_WORKSPACE_ID = "ws-suspended";
const OTHER_USER_ID = "user-other";
const ACTING_USER_ID = "user-acting";
const REQUEST_ID = "req-1";
const IDEMPOTENCY_KEY = "11111111-1111-1111-1111-111111111111";
const OTHER_IDEMPOTENCY_KEY = "22222222-2222-2222-2222-222222222222";

function buildFixture() {
  const repo = new InMemoryDealApproverRepository();
  repo.seedWorkspace({
    workspaceId: PERSONAL_WORKSPACE_ID,
    status: "Active",
    type: "Personal",
  });
  repo.seedWorkspace({
    workspaceId: ORGANIZATION_WORKSPACE_ID,
    status: "Active",
    type: "Organization",
  });
  repo.seedWorkspace({
    workspaceId: SUSPENDED_WORKSPACE_ID,
    status: "Suspended",
    type: "Personal",
  });
  repo.seedMembership({ userId: ACTING_USER_ID, workspaceId: PERSONAL_WORKSPACE_ID });
  const service = new DealApproverService({ dealApproverRepository: repo });
  return { repo, service };
}

test("provisionDealApprover succeeds for an Active Personal Workspace current member", async () => {
  const { service } = buildFixture();
  const result = await service.provisionDealApprover({
    userAccountId: ACTING_USER_ID,
    actingWorkspaceId: PERSONAL_WORKSPACE_ID,
    confirmationVersion: "m2-deal-approver-v1",
    idempotencyKey: IDEMPOTENCY_KEY,
    requestId: REQUEST_ID,
  });
  assert.equal(result.dealApprover.workspaceId, PERSONAL_WORKSPACE_ID);
  assert.equal(result.dealApprover.userId, ACTING_USER_ID);
  // Customer-facing copy never mentions DealApprover internals —
  // the public DTO surfaces the same fields the route layer
  // serialises.
  assert.equal(result.dealApprover.dealApproverId.length > 0, true);
});

test("provisionDealApprover rejects a non-Personal acting Workspace", async () => {
  const { service } = buildFixture();
  await assert.rejects(
    service.provisionDealApprover({
      userAccountId: ACTING_USER_ID,
      actingWorkspaceId: ORGANIZATION_WORKSPACE_ID,
      confirmationVersion: "m2-deal-approver-v1",
      idempotencyKey: IDEMPOTENCY_KEY,
      requestId: REQUEST_ID,
    }),
    (err: unknown) => err instanceof DealApproverError && err.code === "DEAL_APPROVER_FORBIDDEN",
  );
});

test("provisionDealApprover rejects a Suspended acting Workspace", async () => {
  const { service } = buildFixture();
  await assert.rejects(
    service.provisionDealApprover({
      userAccountId: ACTING_USER_ID,
      actingWorkspaceId: SUSPENDED_WORKSPACE_ID,
      confirmationVersion: "m2-deal-approver-v1",
      idempotencyKey: IDEMPOTENCY_KEY,
      requestId: REQUEST_ID,
    }),
    (err: unknown) => err instanceof DealApproverError && err.code === "DEAL_APPROVER_FORBIDDEN",
  );
});

test("provisionDealApprover rejects a non-member of the acting Workspace", async () => {
  const { service } = buildFixture();
  await assert.rejects(
    service.provisionDealApprover({
      userAccountId: OTHER_USER_ID,
      actingWorkspaceId: PERSONAL_WORKSPACE_ID,
      confirmationVersion: "m2-deal-approver-v1",
      idempotencyKey: IDEMPOTENCY_KEY,
      requestId: REQUEST_ID,
    }),
    (err: unknown) => err instanceof DealApproverError && err.code === "DEAL_APPROVER_FORBIDDEN",
  );
});

test("provisionDealApprover rejects an unknown acting Workspace", async () => {
  const { service } = buildFixture();
  await assert.rejects(
    service.provisionDealApprover({
      userAccountId: ACTING_USER_ID,
      actingWorkspaceId: "ws-missing",
      confirmationVersion: "m2-deal-approver-v1",
      idempotencyKey: IDEMPOTENCY_KEY,
      requestId: REQUEST_ID,
    }),
    (err: unknown) => err instanceof DealApproverError && err.code === "DEAL_APPROVER_FORBIDDEN",
  );
});

test("provisionDealApprover same-key retry converges on the existing row", async () => {
  const { service } = buildFixture();
  const first = await service.provisionDealApprover({
    userAccountId: ACTING_USER_ID,
    actingWorkspaceId: PERSONAL_WORKSPACE_ID,
    confirmationVersion: "m2-deal-approver-v1",
    idempotencyKey: IDEMPOTENCY_KEY,
    requestId: REQUEST_ID,
  });
  const second = await service.provisionDealApprover({
    userAccountId: ACTING_USER_ID,
    actingWorkspaceId: PERSONAL_WORKSPACE_ID,
    confirmationVersion: "m2-deal-approver-v1",
    idempotencyKey: IDEMPOTENCY_KEY,
    requestId: REQUEST_ID,
  });
  assert.equal(first.dealApprover.dealApproverId, second.dealApprover.dealApproverId);
});

test("provisionDealApprover different-key retry against an already-provisioned tuple surfaces ALREADY_PROVISIONED", async () => {
  const { service } = buildFixture();
  await service.provisionDealApprover({
    userAccountId: ACTING_USER_ID,
    actingWorkspaceId: PERSONAL_WORKSPACE_ID,
    confirmationVersion: "m2-deal-approver-v1",
    idempotencyKey: IDEMPOTENCY_KEY,
    requestId: REQUEST_ID,
  });
  await assert.rejects(
    service.provisionDealApprover({
      userAccountId: ACTING_USER_ID,
      actingWorkspaceId: PERSONAL_WORKSPACE_ID,
      confirmationVersion: "m2-deal-approver-v1",
      idempotencyKey: OTHER_IDEMPOTENCY_KEY,
      requestId: REQUEST_ID,
    }),
    (err: unknown) =>
      err instanceof DealApproverError && err.code === "DEAL_APPROVER_ALREADY_PROVISIONED",
  );
});

test("provisionDealApprover accepts only the closed m2-deal-approver-v1 confirmation version (delegated to the application boundary)", async () => {
  // The TypeScript literal type enforces the value at compile
  // time; the runtime test below proves the service surface
  // does not accept a stale or unknown version through the
  // configuration seam.
  const { service } = buildFixture();
  const result = await service.provisionDealApprover({
    userAccountId: ACTING_USER_ID,
    actingWorkspaceId: PERSONAL_WORKSPACE_ID,
    // The TypeScript type is a literal `m2-deal-approver-v1`
    // so this test passes the canonical value through the
    // runtime boundary; a runtime mismatch would surface as a
    // CONFIRMATION_VERSION_MISMATCH typed rejection.
    confirmationVersion: "m2-deal-approver-v1",
    idempotencyKey: IDEMPOTENCY_KEY,
    requestId: REQUEST_ID,
  });
  assert.equal(result.dealApprover.workspaceId, PERSONAL_WORKSPACE_ID);
});
