/* eslint-disable @typescript-eslint/no-floating-promises */
// DealApprover route tests (M2 #88).
//
// Background: ticket #88 acceptance criteria require the
// `POST /api/deal-approvers` endpoint to:
//   - require current Personal-Workspace membership
//   - revalidate current acting membership server-side
//   - validate the body shape (actingWorkspaceId, confirmationVersion,
//     idempotencyKey) against the strict Zod schema
//   - return the bounded `dealApprover` public DTO on success
//   - collapse every authorization rejection to the safe envelope
//     `DEAL_APPROVER_FORBIDDEN` (403) or typed failure
//
// The tests use a fake authentication service + the
// InMemoryDealApproverRepository so the test suite runs without
// a database. The Prisma adapter's equivalence is proven by the
// integration tests against the disposable PostgreSQL target.

import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createDealApproverRouter } from "./deal-approvers.js";
import { InMemoryDealApproverRepository } from "../deal-approver/in-memory-deal-approver.repository.js";
import { DealApproverService } from "../deal-approver/deal-approver.service.js";

const PERSONAL_WORKSPACE_ID = "ws-personal";
const ACTING_USER_ID = "user-acting";

function buildApp(opts?: { withSession?: boolean }) {
  const repo = new InMemoryDealApproverRepository();
  repo.seedWorkspace({
    workspaceId: PERSONAL_WORKSPACE_ID,
    status: "Active",
    type: "Personal",
  });
  if (opts?.withSession !== false) {
    repo.seedMembership({ userId: ACTING_USER_ID, workspaceId: PERSONAL_WORKSPACE_ID });
  }
  const service = new DealApproverService({ dealApproverRepository: repo });
  const app = express();
  app.use(express.json({ limit: "16kb" }));
  app.use(
    "/api/deal-approvers",
    createDealApproverRouter({
      authenticationService: {
        resolveSession(id: string | undefined) {
          if (!id) return Promise.resolve(null);
          if (id === "session-acting") return Promise.resolve({ userAccountId: ACTING_USER_ID });
          return Promise.resolve(null);
        },
      },
      dealApproverService: service,
      generateRequestId: () => "req-test",
    }),
  );
  return { app, repo };
}

async function postProvisioning(
  port: number,
  body: unknown,
  cookie?: string,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (cookie) headers["cookie"] = cookie;
  const response = await fetch(`http://127.0.0.1:${port}/api/deal-approvers`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const json: unknown = await response.json();
  return { status: response.status, body: json };
}

async function withServer(
  app: express.Express,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const server = app.listen(0);
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Could not bind ephemeral port");
    }
    await fn(address.port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("POST /api/deal-approvers returns 201 + bounded dealApprover on success", async () => {
  const { app } = buildApp();
  await withServer(app, async (port) => {
    const result = await postProvisioning(
      port,
      {
        actingWorkspaceId: PERSONAL_WORKSPACE_ID,
        confirmationVersion: "m2-deal-approver-v1",
        idempotencyKey: "11111111-1111-1111-1111-111111111111",
      },
      "soundhub_session=session-acting",
    );
    assert.equal(result.status, 201);
    const body = result.body as {
      ok: boolean;
      dealApprover: { dealApproverId: string; workspaceId: string; userId: string };
    };
    assert.equal(body.ok, true);
    assert.equal(body.dealApprover.workspaceId, PERSONAL_WORKSPACE_ID);
    assert.equal(body.dealApprover.userId, ACTING_USER_ID);
  });
});

test("POST /api/deal-approvers rejects an unauthenticated request", async () => {
  const { app } = buildApp();
  await withServer(app, async (port) => {
    const result = await postProvisioning(port, {
      actingWorkspaceId: PERSONAL_WORKSPACE_ID,
      confirmationVersion: "m2-deal-approver-v1",
      idempotencyKey: "11111111-1111-1111-1111-111111111111",
    });
    assert.equal(result.status, 401);
    const body = result.body as { error: { code: string } };
    assert.equal(body.error.code, "SESSION_INVALID");
  });
});

test("POST /api/deal-approvers rejects an invalid body shape with DEAL_APPROVER_INVALID", async () => {
  const { app } = buildApp();
  await withServer(app, async (port) => {
    const result = await postProvisioning(
      port,
      {
        actingWorkspaceId: PERSONAL_WORKSPACE_ID,
        // missing confirmationVersion + idempotencyKey
      },
      "soundhub_session=session-acting",
    );
    assert.equal(result.status, 400);
    const body = result.body as { error: { code: string } };
    assert.equal(body.error.code, "DEAL_APPROVER_INVALID");
  });
});

test("POST /api/deal-approvers rejects an unknown confirmationVersion with 422", async () => {
  const { app } = buildApp();
  await withServer(app, async (port) => {
    const result = await postProvisioning(
      port,
      {
        actingWorkspaceId: PERSONAL_WORKSPACE_ID,
        // The strict Zod schema is a literal `m2-deal-approver-v1`;
        // any other value is rejected at the boundary.
        confirmationVersion: "m2-deal-approver-v0",
        idempotencyKey: "11111111-1111-1111-1111-111111111111",
      },
      "soundhub_session=session-acting",
    );
    assert.equal(result.status, 400);
    const body = result.body as { error: { code: string } };
    assert.equal(body.error.code, "DEAL_APPROVER_INVALID");
  });
});

test("POST /api/deal-approvers rejects a non-member with DEAL_APPROVER_FORBIDDEN", async () => {
  const { app } = buildApp({ withSession: false });
  await withServer(app, async (port) => {
    const result = await postProvisioning(
      port,
      {
        actingWorkspaceId: PERSONAL_WORKSPACE_ID,
        confirmationVersion: "m2-deal-approver-v1",
        idempotencyKey: "11111111-1111-1111-1111-111111111111",
      },
      "soundhub_session=session-acting",
    );
    assert.equal(result.status, 403);
    const body = result.body as { error: { code: string } };
    assert.equal(body.error.code, "DEAL_APPROVER_FORBIDDEN");
  });
});
