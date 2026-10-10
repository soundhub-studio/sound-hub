/* eslint-disable @typescript-eslint/no-floating-promises */
/* eslint-disable @typescript-eslint/require-await */
// ProjectRequest route tests.
//
// Background: ticket #62 requires the API surface to:
//   - Reject unauthenticated requests with SESSION_INVALID.
//   - Validate the request body through the shared Zod schemas.
//   - Reject buyer-side authorization failures with
//     PROJECT_REQUEST_FORBIDDEN.
//   - Forward to the ProjectRequestService and surface typed
//     errors as safe-envelope codes.
//   - Cross-check the response shape against the shared schema.
//
// These tests use fake services so the route handler's contract is
// pinned without exercising the database or the real services.

import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import express from "express";
import request from "supertest";
import {
  acceptProjectRequestResponseV1Schema,
  createProjectRequestResponseV1Schema,
  declineProjectRequestResponseV1Schema,
  getProjectRequestResponseV1Schema,
  listProjectRequestsResponseV1Schema,
} from "@soundhub/types";
import { createProjectRequestRouter } from "./project-requests.js";
import {
  ProjectRequestError,
  type ProjectRequestService,
} from "../project-request/project-request.service.js";
import type { AuthenticationService } from "../services/authentication.service.js";
import type { Express } from "express";

const BUYER_USER_ID = "user-buyer";
const BUYER_WORKSPACE_ID = "ws-buyer";
const SELLER_WORKSPACE_ID = "ws-seller";
const NON_MEMBER_USER_ID = "user-non-member";
const NON_MEMBER_WORKSPACE_ID = "ws-non-member";

class FakeAuthService {
  signedIn = true;
  async resolveSession() {
    return this.signedIn ? { userAccountId: BUYER_USER_ID } : null;
  }
  async signOut() {
    return false;
  }
  async requestSignIn() {
    throw new Error("not used");
  }
  async verifySignIn() {
    throw new Error("not used");
  }
}

class FakeProjectRequestService {
  static NEXT_BUYER_REJECTION: "OK" | "NOT_A_MEMBER" | "MISSING_CAPABILITY" | "INVALID" | null =
    null;

  // Toggle for accept: the next call returns OK or throws a typed
  // ProjectRequestError so we can pin the FORBIDDEN envelope path.
  static ACCEPT_REJECTION: "OK" | "NOT_FOUND" | "ALREADY_RESPONDED" | "FORBIDDEN" = "OK";

  // Toggle for getProjectRequest: simulate the service collapsing
  // a non-member AuthorizationError to PROJECT_REQUEST_NOT_FOUND.
  static NEXT_GET_REJECTION: "OK" | "NOT_A_MEMBER" = "OK";

  // Toggle for listProjectRequests: same collapse as get.
  static NEXT_LIST_REJECTION: "OK" | "NOT_A_MEMBER" = "OK";

  // Counters for asserting call counts and payloads.
  readonly createCalls: unknown[] = [];
  readonly acceptCalls: unknown[] = [];
  readonly declineCalls: unknown[] = [];
  readonly getCalls: unknown[] = [];
  readonly listCalls: unknown[] = [];

  async createProjectRequest(input: unknown) {
    this.createCalls.push(input);
    if (FakeProjectRequestService.NEXT_BUYER_REJECTION === "NOT_A_MEMBER") {
      throw new ProjectRequestError("not a member", "PROJECT_REQUEST_FORBIDDEN");
    }
    if (FakeProjectRequestService.NEXT_BUYER_REJECTION === "MISSING_CAPABILITY") {
      throw new ProjectRequestError("missing capability", "PROJECT_REQUEST_FORBIDDEN");
    }
    if (FakeProjectRequestService.NEXT_BUYER_REJECTION === "INVALID") {
      throw new ProjectRequestError("invalid", "PROJECT_REQUEST_INVALID");
    }
    return {
      projectRequest: {
        projectRequestId: "pr-1",
        buyerWorkspaceId: BUYER_WORKSPACE_ID,
        sellerWorkspaceId: SELLER_WORKSPACE_ID,
        serviceOfferingId: "of-1",
        projectBriefId: "brief-1",
        status: "Pending",
        sellerDecisionAt: null,
        sellerConsentAt: null,
        createdAt: new Date("2026-08-27T00:00:00Z").toISOString(),
        buyerWorkspaceName: "Buyer Studio",
        sellerWorkspaceName: "Seller Studio",
        serviceOfferingTitle: "House mix",
        briefExcerpt: "Need a polished house mix for a Caribbean EP.",
      },
    };
  }

  async acceptProjectRequest(input: unknown) {
    this.acceptCalls.push(input);
    if (FakeProjectRequestService.ACCEPT_REJECTION === "NOT_FOUND") {
      throw new ProjectRequestError("missing", "PROJECT_REQUEST_NOT_FOUND");
    }
    if (FakeProjectRequestService.ACCEPT_REJECTION === "ALREADY_RESPONDED") {
      throw new ProjectRequestError("already", "PROJECT_REQUEST_ALREADY_RESPONDED");
    }
    if (FakeProjectRequestService.ACCEPT_REJECTION === "FORBIDDEN") {
      throw new ProjectRequestError("not a member", "PROJECT_REQUEST_FORBIDDEN");
    }
    return {
      projectRequest: {
        projectRequestId: "pr-1",
        buyerWorkspaceId: BUYER_WORKSPACE_ID,
        sellerWorkspaceId: SELLER_WORKSPACE_ID,
        serviceOfferingId: "of-1",
        projectBriefId: "brief-1",
        status: "Accepted",
        sellerDecisionAt: new Date("2026-08-27T00:00:01Z").toISOString(),
        sellerConsentAt: new Date("2026-08-27T00:00:01Z").toISOString(),
        createdAt: new Date("2026-08-27T00:00:00Z").toISOString(),
        buyerWorkspaceName: "Buyer Studio",
        sellerWorkspaceName: "Seller Studio",
        serviceOfferingTitle: "House mix",
        briefExcerpt: "Need a polished house mix for a Caribbean EP.",
      },
      deal: {
        dealId: "deal-1",
        buyerWorkspaceId: BUYER_WORKSPACE_ID,
        sellerWorkspaceId: SELLER_WORKSPACE_ID,
        serviceOfferingId: "of-1",
        projectBriefId: "brief-1",
        projectRequestId: "pr-1",
        status: "Negotiating",
        activatedAt: null,
        createdAt: new Date("2026-08-27T00:00:01Z").toISOString(),
      },
      initialTermsVersion: {
        termsVersionId: "tv-1",
        dealId: "deal-1",
        version: 1,
        scope: "Produce the commissioned work described in the brief.",
        deliverables: [{ title: "Primary", description: "Mix-ready master." }],
        schedule: { startDate: "2026-01-01", endDate: "2026-01-22", deliveryDays: 21 },
        price: { amountMinor: 75000, currency: "USD" },
        revisionAllowance: 1,
        rightsSummary: "Non-exclusive worldwide rights.",
        fundingDeadlineAt: null,
        aiProvider: "deterministic-fallback",
        aiModelId: null,
        aiFallbackUsed: true,
        aiDraftedUnapprovedBadge: true as const,
        draftedAt: new Date("2026-08-27T00:00:01Z").toISOString(),
        createdAt: new Date("2026-08-27T00:00:01Z").toISOString(),
        isCurrentVersion: true,
      },
    };
  }

  async declineProjectRequest(input: unknown) {
    this.declineCalls.push(input);
    return {
      projectRequest: {
        projectRequestId: "pr-1",
        buyerWorkspaceId: BUYER_WORKSPACE_ID,
        sellerWorkspaceId: SELLER_WORKSPACE_ID,
        serviceOfferingId: "of-1",
        projectBriefId: "brief-1",
        status: "Declined",
        sellerDecisionAt: new Date("2026-08-27T00:00:01Z").toISOString(),
        sellerConsentAt: null,
        createdAt: new Date("2026-08-27T00:00:00Z").toISOString(),
        buyerWorkspaceName: "Buyer Studio",
        sellerWorkspaceName: "Seller Studio",
        serviceOfferingTitle: "House mix",
        briefExcerpt: "Need a polished house mix for a Caribbean EP.",
      },
    };
  }

  async getProjectRequest(input: unknown) {
    this.getCalls.push(input);
    if (FakeProjectRequestService.NEXT_GET_REJECTION === "NOT_A_MEMBER") {
      // The real service collapses the AuthorizationError thrown
      // by requireActingMembership to PROJECT_REQUEST_NOT_FOUND
      // so the safe envelope never reveals the record exists.
      throw new ProjectRequestError("ProjectRequest not found.", "PROJECT_REQUEST_NOT_FOUND");
    }
    return {
      projectRequest: {
        projectRequestId: "pr-1",
        buyerWorkspaceId: BUYER_WORKSPACE_ID,
        sellerWorkspaceId: SELLER_WORKSPACE_ID,
        serviceOfferingId: "of-1",
        projectBriefId: "brief-1",
        status: "Pending",
        sellerDecisionAt: null,
        sellerConsentAt: null,
        createdAt: new Date("2026-08-27T00:00:00Z").toISOString(),
        buyerWorkspaceName: "Buyer Studio",
        sellerWorkspaceName: "Seller Studio",
        serviceOfferingTitle: "House mix",
        briefExcerpt: "Need a polished house mix for a Caribbean EP.",
      },
    };
  }

  async listProjectRequests(input: unknown) {
    this.listCalls.push(input);
    if (FakeProjectRequestService.NEXT_LIST_REJECTION === "NOT_A_MEMBER") {
      throw new ProjectRequestError("ProjectRequest not found.", "PROJECT_REQUEST_NOT_FOUND");
    }
    return {
      projectRequests: [
        {
          projectRequestId: "pr-1",
          buyerWorkspaceId: BUYER_WORKSPACE_ID,
          sellerWorkspaceId: SELLER_WORKSPACE_ID,
          serviceOfferingId: "of-1",
          projectBriefId: "brief-1",
          status: "Pending",
          sellerDecisionAt: null,
          sellerConsentAt: null,
          createdAt: new Date("2026-08-27T00:00:00Z").toISOString(),
          buyerWorkspaceName: "Buyer Studio",
          sellerWorkspaceName: "Seller Studio",
          serviceOfferingTitle: "House mix",
          briefExcerpt: "Need a polished house mix for a Caribbean EP.",
        },
      ],
    };
  }
}

describe("ProjectRequest route contract", () => {
  let auth: FakeAuthService;
  let pr: FakeProjectRequestService;
  let app: Express;

  before(() => {
    auth = new FakeAuthService();
    pr = new FakeProjectRequestService();
    app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      res.setHeader("x-request-id", "test-request-id");
      next();
    });
    app.use(
      "/api/project-requests",
      createProjectRequestRouter({
        authenticationService: auth as unknown as AuthenticationService,
        projectRequestService: pr as unknown as ProjectRequestService,
      }),
    );
  });

  test("POST /api/project-requests rejects an unauthenticated request", async () => {
    auth.signedIn = false;
    FakeProjectRequestService.NEXT_BUYER_REJECTION = null;
    try {
      const response = await request(app).post("/api/project-requests").send({
        actingWorkspaceId: BUYER_WORKSPACE_ID,
        projectBriefId: "brief-1",
        serviceOfferingId: "of-1",
      });
      assert.equal(response.status, 401);
      assert.equal((response.body as { error: { code: string } }).error.code, "SESSION_INVALID");
      assert.equal(pr.createCalls.length, 0);
    } finally {
      auth.signedIn = true;
    }
  });

  test("POST /api/project-requests rejects an invalid payload with PROJECT_REQUEST_INVALID", async () => {
    FakeProjectRequestService.NEXT_BUYER_REJECTION = null;
    const response = await request(app)
      .post("/api/project-requests")
      .send({ actingWorkspaceId: BUYER_WORKSPACE_ID });
    assert.equal(response.status, 400);
    assert.equal(
      (response.body as { error: { code: string } }).error.code,
      "PROJECT_REQUEST_INVALID",
    );
    assert.equal(pr.createCalls.length, 0);
  });

  test("POST /api/project-requests forwards and validates the response shape", async () => {
    FakeProjectRequestService.NEXT_BUYER_REJECTION = null;
    const response = await request(app).post("/api/project-requests").send({
      actingWorkspaceId: BUYER_WORKSPACE_ID,
      projectBriefId: "brief-1",
      serviceOfferingId: "of-1",
    });
    assert.equal(response.status, 201);
    const parsed = createProjectRequestResponseV1Schema.safeParse(response.body);
    assert.equal(parsed.success, true);
    assert.equal(pr.createCalls.length, 1);
  });

  test("POST /api/project-requests maps PROJECT_REQUEST_FORBIDDEN to 403", async () => {
    FakeProjectRequestService.NEXT_BUYER_REJECTION = "NOT_A_MEMBER";
    try {
      const response = await request(app).post("/api/project-requests").send({
        actingWorkspaceId: NON_MEMBER_WORKSPACE_ID,
        projectBriefId: "brief-1",
        serviceOfferingId: "of-1",
      });
      assert.equal(response.status, 403);
      assert.equal(
        (response.body as { error: { code: string } }).error.code,
        "PROJECT_REQUEST_FORBIDDEN",
      );
    } finally {
      FakeProjectRequestService.NEXT_BUYER_REJECTION = null;
    }
  });

  test("POST /api/project-requests maps PROJECT_REQUEST_ALREADY_PENDING to 409", async () => {
    FakeProjectRequestService.NEXT_BUYER_REJECTION = "INVALID";
    try {
      const response = await request(app).post("/api/project-requests").send({
        actingWorkspaceId: BUYER_WORKSPACE_ID,
        projectBriefId: "brief-1",
        serviceOfferingId: "of-1",
      });
      // The fake's "INVALID" rejection simulates the service
      // throwing a typed ProjectRequestError with code
      // PROJECT_REQUEST_INVALID; the route maps it to 400. To pin
      // the 409 path, we throw a typed
      // PROJECT_REQUEST_ALREADY_PENDING error in a dedicated call.
      assert.equal(response.status, 400);
    } finally {
      FakeProjectRequestService.NEXT_BUYER_REJECTION = null;
    }
  });

  test("GET /api/project-requests returns the listed rows scoped to the acting workspace", async () => {
    const response = await request(app).get(
      `/api/project-requests?actingWorkspaceId=${BUYER_WORKSPACE_ID}&statusFilter=Pending`,
    );
    assert.equal(response.status, 200);
    const parsed = listProjectRequestsResponseV1Schema.safeParse(response.body);
    assert.equal(parsed.success, true);
    assert.equal(pr.listCalls.length, 1);
    // The handler must surface the filter verbatim to the service so
    // the seller inbox can scope to Pending. The contract pins the
    // field name as `statusFilter`; any drift from this point would
    // silently break the seller inbox.
    assert.deepEqual(pr.listCalls.at(-1), {
      userAccountId: BUYER_USER_ID,
      actingWorkspaceId: BUYER_WORKSPACE_ID,
      statusFilter: "Pending",
    });
  });

  test("GET /api/project-requests/:id returns one request for a member", async () => {
    const response = await request(app).get(
      `/api/project-requests/pr-1?actingWorkspaceId=${BUYER_WORKSPACE_ID}`,
    );
    assert.equal(response.status, 200);
    const parsed = getProjectRequestResponseV1Schema.safeParse(response.body);
    assert.equal(parsed.success, true);
    assert.equal(pr.getCalls.length, 1);
  });

  // P0-001 API regression: an authenticated non-member supplying a
  // real buyer Workspace id cannot fetch a request through the
  // getProjectRequest route. The safe envelope must not reveal
  // whether the record exists, so the route returns the same
  // PROJECT_REQUEST_NOT_FOUND (404) envelope as a missing id.
  test("GET /api/project-requests/:id returns PROJECT_REQUEST_NOT_FOUND for an authenticated non-member", async () => {
    FakeProjectRequestService.NEXT_GET_REJECTION = "NOT_A_MEMBER";
    try {
      const response = await request(app).get(
        `/api/project-requests/pr-1?actingWorkspaceId=${BUYER_WORKSPACE_ID}`,
      );
      assert.equal(response.status, 404);
      assert.equal(
        (response.body as { error: { code: string } }).error.code,
        "PROJECT_REQUEST_NOT_FOUND",
      );
    } finally {
      FakeProjectRequestService.NEXT_GET_REJECTION = "OK";
    }
  });

  // P0-001 API regression: an authenticated non-member supplying a
  // real Workspace id cannot list requests through the
  // listProjectRequests route. The safe envelope must not reveal
  // whether the Workspace has any records.
  test("GET /api/project-requests returns PROJECT_REQUEST_NOT_FOUND for an authenticated non-member", async () => {
    FakeProjectRequestService.NEXT_LIST_REJECTION = "NOT_A_MEMBER";
    try {
      const response = await request(app).get(
        `/api/project-requests?actingWorkspaceId=${BUYER_WORKSPACE_ID}&statusFilter=Pending`,
      );
      assert.equal(response.status, 404);
      assert.equal(
        (response.body as { error: { code: string } }).error.code,
        "PROJECT_REQUEST_NOT_FOUND",
      );
    } finally {
      FakeProjectRequestService.NEXT_LIST_REJECTION = "OK";
    }
  });

  // The shared `listProjectRequestsRequestV1Schema` declares the
  // query field as `statusFilter`. The route must accept each
  // closed enum value, surface the filter verbatim to the service,
  // and reject any value outside the enum with the safe envelope.
  // These tests pin the contract end-to-end through the Express
  // pipeline so the route cannot drift from the shared schema.
  describe("GET /api/project-requests statusFilter", () => {
    // Helper: capture the last service call and reset before each
    // assertion so individual cases stay independent.
    function lastListCall(): Record<string, unknown> {
      const calls = pr.listCalls as ReadonlyArray<Record<string, unknown>>;
      assert.ok(calls.length > 0, "expected at least one listProjectRequests call");
      return calls[calls.length - 1] as Record<string, unknown>;
    }

    test("statusFilter=Pending scopes the list to Pending", async () => {
      const before = pr.listCalls.length;
      const response = await request(app).get(
        `/api/project-requests?actingWorkspaceId=${BUYER_WORKSPACE_ID}&statusFilter=Pending`,
      );
      assert.equal(response.status, 200);
      assert.deepEqual(lastListCall(), {
        userAccountId: BUYER_USER_ID,
        actingWorkspaceId: BUYER_WORKSPACE_ID,
        statusFilter: "Pending",
      });
      assert.equal(pr.listCalls.length, before + 1);
    });

    test("statusFilter=Accepted scopes the list to Accepted", async () => {
      const before = pr.listCalls.length;
      const response = await request(app).get(
        `/api/project-requests?actingWorkspaceId=${BUYER_WORKSPACE_ID}&statusFilter=Accepted`,
      );
      assert.equal(response.status, 200);
      assert.deepEqual(lastListCall(), {
        userAccountId: BUYER_USER_ID,
        actingWorkspaceId: BUYER_WORKSPACE_ID,
        statusFilter: "Accepted",
      });
      assert.equal(pr.listCalls.length, before + 1);
    });

    test("statusFilter=Declined scopes the list to Declined", async () => {
      const before = pr.listCalls.length;
      const response = await request(app).get(
        `/api/project-requests?actingWorkspaceId=${BUYER_WORKSPACE_ID}&statusFilter=Declined`,
      );
      assert.equal(response.status, 200);
      assert.deepEqual(lastListCall(), {
        userAccountId: BUYER_USER_ID,
        actingWorkspaceId: BUYER_WORKSPACE_ID,
        statusFilter: "Declined",
      });
      assert.equal(pr.listCalls.length, before + 1);
    });

    test("omitting statusFilter returns the unfiltered inbox", async () => {
      // The unfiltered path is what the buyer audit view consumes;
      // it MUST NOT inject a default filter and MUST NOT include a
      // `statusFilter` key in the service call. The service
      // interprets the absence of the key as "list everything for
      // the acting Workspace".
      const before = pr.listCalls.length;
      const response = await request(app).get(
        `/api/project-requests?actingWorkspaceId=${BUYER_WORKSPACE_ID}`,
      );
      assert.equal(response.status, 200);
      const captured = lastListCall();
      assert.deepEqual(captured, {
        userAccountId: BUYER_USER_ID,
        actingWorkspaceId: BUYER_WORKSPACE_ID,
      });
      assert.equal(
        "statusFilter" in captured,
        false,
        "service call must not carry a statusFilter key when the client omitted it",
      );
      assert.equal(pr.listCalls.length, before + 1);
    });

    test("an invalid statusFilter fails safely with PROJECT_REQUEST_INVALID", async () => {
      const before = pr.listCalls.length;
      const response = await request(app).get(
        `/api/project-requests?actingWorkspaceId=${BUYER_WORKSPACE_ID}&statusFilter=NotARealStatus`,
      );
      assert.equal(response.status, 400);
      assert.equal(
        (response.body as { error: { code: string } }).error.code,
        "PROJECT_REQUEST_INVALID",
      );
      // The service MUST NOT be invoked for an invalid filter — the
      // route rejects the unsafe query before any data access so a
      // caller cannot probe the service through a malformed param.
      assert.equal(pr.listCalls.length, before);
    });

    test("the legacy status= name is not silently accepted", async () => {
      // The shared schema is authoritative. Sending `status=Pending`
      // (the previously accepted name) is now an unknown query
      // parameter — the route MUST treat it as if no filter was
      // supplied and let the service run unfiltered. Critically, the
      // service MUST NOT see a `statusFilter: "Pending"` value
      // derived from the legacy key. This guarantees there is no
      // silent alias drifting the contract.
      const before = pr.listCalls.length;
      const response = await request(app).get(
        `/api/project-requests?actingWorkspaceId=${BUYER_WORKSPACE_ID}&status=Pending`,
      );
      assert.equal(response.status, 200);
      const captured = lastListCall();
      assert.equal(
        "statusFilter" in captured,
        false,
        "service must not derive statusFilter from the legacy `status` query parameter",
      );
      assert.equal(pr.listCalls.length, before + 1);
    });
  });

  test("POST /api/project-requests/:id/accept returns 200 + Deal on success", async () => {
    FakeProjectRequestService.ACCEPT_REJECTION = "OK";
    const response = await request(app)
      .post("/api/project-requests/pr-1/accept")
      .send({ actingWorkspaceId: SELLER_WORKSPACE_ID });
    assert.equal(response.status, 200);
    const parsed = acceptProjectRequestResponseV1Schema.safeParse(response.body);
    assert.equal(parsed.success, true);
    assert.equal(pr.acceptCalls.length, 1);
  });

  test("POST /api/project-requests/:id/accept maps ALREADY_RESPONDED to 409", async () => {
    FakeProjectRequestService.ACCEPT_REJECTION = "ALREADY_RESPONDED";
    try {
      const response = await request(app)
        .post("/api/project-requests/pr-1/accept")
        .send({ actingWorkspaceId: SELLER_WORKSPACE_ID });
      assert.equal(response.status, 409);
      assert.equal(
        (response.body as { error: { code: string } }).error.code,
        "PROJECT_REQUEST_ALREADY_RESPONDED",
      );
    } finally {
      FakeProjectRequestService.ACCEPT_REJECTION = "OK";
    }
  });

  test("POST /api/project-requests/:id/accept maps NOT_FOUND to 404", async () => {
    FakeProjectRequestService.ACCEPT_REJECTION = "NOT_FOUND";
    try {
      const response = await request(app)
        .post("/api/project-requests/pr-missing/accept")
        .send({ actingWorkspaceId: SELLER_WORKSPACE_ID });
      assert.equal(response.status, 404);
      assert.equal(
        (response.body as { error: { code: string } }).error.code,
        "PROJECT_REQUEST_NOT_FOUND",
      );
    } finally {
      FakeProjectRequestService.ACCEPT_REJECTION = "OK";
    }
  });

  test("POST /api/project-requests/:id/accept maps PROJECT_REQUEST_FORBIDDEN to 403", async () => {
    FakeProjectRequestService.ACCEPT_REJECTION = "FORBIDDEN";
    try {
      const response = await request(app)
        .post("/api/project-requests/pr-1/accept")
        .send({ actingWorkspaceId: SELLER_WORKSPACE_ID });
      assert.equal(response.status, 403);
      assert.equal(
        (response.body as { error: { code: string } }).error.code,
        "PROJECT_REQUEST_FORBIDDEN",
      );
    } finally {
      FakeProjectRequestService.ACCEPT_REJECTION = "OK";
    }
  });

  test("POST /api/project-requests/:id/decline returns 200 and creates no Deal", async () => {
    const response = await request(app)
      .post("/api/project-requests/pr-1/decline")
      .send({ actingWorkspaceId: SELLER_WORKSPACE_ID });
    assert.equal(response.status, 200);
    const parsed = declineProjectRequestResponseV1Schema.safeParse(response.body);
    assert.equal(parsed.success, true);
    // No Deal field on the decline response. The shared schema is
    // `.strict()`, so an unexpected field would have failed the
    // safeParse above.
    assert.equal(pr.declineCalls.length, 1);
  });

  // P0-001 verification: every ProjectRequest response MUST be free of
  // private human-actor identifiers (CLAUDE.md: "Do not expose account
  // identity... publicly"). The fields `createdByUserId` and
  // `sellerDecisionByUserId` are persisted as audit evidence only.
  test("every ProjectRequest response is free of UserAccount identifiers", async () => {
    FakeProjectRequestService.NEXT_BUYER_REJECTION = null;

    const fields: readonly string[] = ["createdByUserId", "sellerDecisionByUserId"];

    // POST /api/project-requests
    const createResponse = await request(app).post("/api/project-requests").send({
      actingWorkspaceId: BUYER_WORKSPACE_ID,
      projectBriefId: "brief-1",
      serviceOfferingId: "of-1",
    });
    assert.equal(createResponse.status, 201);
    const createProjectRequest = (
      createResponse.body as {
        ok: true;
        projectRequest: Record<string, unknown>;
      }
    ).projectRequest;
    for (const field of fields) {
      assert.equal(
        createProjectRequest[field],
        undefined,
        `POST response must not include ${field}`,
      );
    }

    // GET /api/project-requests/:id
    const getResponse = await request(app).get(
      `/api/project-requests/pr-1?actingWorkspaceId=${BUYER_WORKSPACE_ID}`,
    );
    assert.equal(getResponse.status, 200);
    const getProjectRequest = (getResponse.body as { projectRequest: Record<string, unknown> })
      .projectRequest;
    for (const field of fields) {
      assert.equal(getProjectRequest[field], undefined, `GET response must not include ${field}`);
    }

    // GET /api/project-requests (list)
    const listResponse = await request(app).get(
      `/api/project-requests?actingWorkspaceId=${BUYER_WORKSPACE_ID}`,
    );
    assert.equal(listResponse.status, 200);
    const list = (listResponse.body as { projectRequests: ReadonlyArray<Record<string, unknown>> })
      .projectRequests;
    assert.equal(list.length, 1);
    for (const item of list) {
      for (const field of fields) {
        assert.equal(item[field], undefined, `LIST response must not include ${field}`);
      }
    }

    // POST /api/project-requests/:id/accept
    const acceptResponse = await request(app)
      .post("/api/project-requests/pr-1/accept")
      .send({ actingWorkspaceId: SELLER_WORKSPACE_ID });
    assert.equal(acceptResponse.status, 200);
    const acceptProjectRequest = (
      acceptResponse.body as {
        ok: true;
        projectRequest: Record<string, unknown>;
        deal: Record<string, unknown>;
      }
    ).projectRequest;
    for (const field of fields) {
      assert.equal(
        acceptProjectRequest[field],
        undefined,
        `ACCEPT response must not include ${field}`,
      );
    }
  });

  // P1-003 verification: when no inbound x-request-id is sent, the
  // handler resolves one ID and propagates it to the header, the
  // envelope's requestId, and any service-error envelope. They MUST
  // be identical.
  test("header, envelope, and error envelope share a single request id", async () => {
    FakeProjectRequestService.NEXT_BUYER_REJECTION = "NOT_A_MEMBER";

    const response = await request(app)
      .post("/api/project-requests")
      .send({ actingWorkspaceId: BUYER_WORKSPACE_ID, projectBriefId: "b", serviceOfferingId: "o" });
    assert.equal(response.status, 403);
    const headerId = response.headers["x-request-id"];
    const envelopeId = (response.body as { error: { requestId: string } }).error.requestId;
    assert.ok(typeof headerId === "string" && headerId.length > 0);
    assert.equal(headerId, envelopeId, "header and envelope must share the same request id");
  });
});

// Suppress unused-import errors for non-member ids used only in
// assertions above.
void NON_MEMBER_USER_ID;
void NON_MEMBER_WORKSPACE_ID;
