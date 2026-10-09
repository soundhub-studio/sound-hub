// Matchmaker route tests.
//
// Background: BG3 requires the route to:
//   - Validate the request body through submitBriefRequestV1Schema.
//   - Reject unauthenticated requests with SESSION_INVALID.
//   - Reject non-Buyer actors with BRIEF_FORBIDDEN.
//   - Forward the request to the MatchmakerService.
//   - Translate MatchmakerError into safe-envelope responses.
//
// The tests use a single shared app constructed in a `before` hook
// so supertest doesn't need to bind a real port; node's test runner
// closes the request loop after the test returns.

/* eslint-disable @typescript-eslint/no-floating-promises */
/* eslint-disable @typescript-eslint/require-await */
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import express from "express";
import request from "supertest";
import { briefResponseV1Schema, submitBriefResponseV1Schema } from "@soundhub/types";
import { createMatchmakerRouter } from "./matchmaker.js";
import { MatchmakerError, type MatchmakerService } from "../services/matchmaker.service.js";
import { AuthorizationError } from "../services/workspace-authorization.service.js";
import type {
  ProjectBriefPublicV1,
  MatchmakerRecommendationV1,
  SubmitBriefResponseV1,
} from "@soundhub/types";
import type { AuthenticationService } from "../services/authentication.service.js";
import type { Express } from "express";

const BUYER_USER_ID = "user-route-buyer";
const BUYER_WORKSPACE_ID = "ws-route-buyer";
const NON_BUYER_WORKSPACE_ID = "ws-route-no-capability";

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

class FakeMatchmakerService {
  readonly submitCalls: unknown[] = [];
  readonly getCalls: unknown[] = [];

  // Toggle to simulate the deterministic-fallback self-validation
  // rejection path. When true, submitBrief throws a real
  // MatchmakerError(MATCHMAKER_INVALID_REQUEST) — the same shape
  // the real service produces when the buyer's brief is
  // unusable.
  static INVALID_REQUEST = false;

  async submitBrief(input: unknown): Promise<SubmitBriefResponseV1> {
    if (FakeMatchmakerService.INVALID_REQUEST) {
      throw new MatchmakerError(
        "ProjectBrief cannot be interpreted into valid search criteria.",
        "MATCHMAKER_INVALID_REQUEST",
      );
    }
    this.submitCalls.push(input);
    if (
      typeof input === "object" &&
      input !== null &&
      "actingWorkspaceId" in input &&
      (input as { actingWorkspaceId: string }).actingWorkspaceId === NON_BUYER_WORKSPACE_ID
    ) {
      // The real service throws AuthorizationError; the route must
      // map it to a 403 BRIEF_FORBIDDEN envelope (not a generic
      // 500 MATCHMAKER_FAILED).
      throw new AuthorizationError("not a member", "NOT_A_MEMBER");
    }
    const brief: ProjectBriefPublicV1 = {
      briefId: "brief-test-1",
      actingWorkspaceId: BUYER_WORKSPACE_ID,
      createdByUserId: BUYER_USER_ID,
      briefText: "Need a Brooklyn producer.",
      criteria: {
        required: { primaryCategoryKeys: ["music-production"] },
      },
      aiProvider: "deterministic-fallback",
      aiModelId: null,
      aiFallbackUsed: true,
      createdAt: new Date("2026-08-26T00:00:00Z").toISOString(),
      buyerWorkspace: {
        workspaceId: BUYER_WORKSPACE_ID,
        slug: "bg1-demo-buyer",
        name: "BG1 Demo Buyer",
      },
    };
    const recommendations: MatchmakerRecommendationV1[] = [];
    return {
      ok: true,
      brief,
      recommendations,
      totalResults: 0,
      strategy: "postgres-text-v1",
    };
  }

  async getBrief(input: unknown) {
    this.getCalls.push(input);
    if (
      typeof input === "object" &&
      input !== null &&
      "briefId" in input &&
      (input as { briefId: string }).briefId === "brief-missing"
    ) {
      throw new MatchmakerError("Brief not found", "BRIEF_NOT_FOUND");
    }
    if (
      typeof input === "object" &&
      input !== null &&
      "briefId" in input &&
      (input as { briefId: string }).briefId === "brief-forbidden"
    ) {
      throw new AuthorizationError("missing capability", "MISSING_CAPABILITY");
    }
    return {
      brief: {
        briefId: "brief-test-1",
        actingWorkspaceId: BUYER_WORKSPACE_ID,
        createdByUserId: BUYER_USER_ID,
        briefText: "Need a Brooklyn producer.",
        criteria: {
          required: { primaryCategoryKeys: ["music-production"] },
        },
        aiProvider: "deterministic-fallback",
        aiModelId: null,
        aiFallbackUsed: true,
        createdAt: new Date("2026-08-26T00:00:00Z").toISOString(),
        buyerWorkspace: {
          workspaceId: BUYER_WORKSPACE_ID,
          slug: "bg1-demo-buyer",
          name: "BG1 Demo Buyer",
        },
      },
    };
  }
}

describe("Matchmaker route contract", () => {
  let auth: FakeAuthService;
  let mm: FakeMatchmakerService;
  let app: Express;

  before(() => {
    auth = new FakeAuthService();
    mm = new FakeMatchmakerService();
    app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      res.setHeader("x-request-id", "test-request-id");
      next();
    });
    app.use(
      "/api/matchmaker",
      createMatchmakerRouter({
        authenticationService: auth as unknown as AuthenticationService,
        matchmakerService: mm as unknown as MatchmakerService,
      }),
    );
  });

  test("POST /api/matchmaker/brief rejects an unauthenticated request", async () => {
    auth.signedIn = false;
    try {
      const response = await request(app)
        .post("/api/matchmaker/brief")
        .send({ actingWorkspaceId: BUYER_WORKSPACE_ID, briefText: "Need a Brooklyn producer." });
      assert.equal(response.status, 401);
      assert.equal((response.body as { error: { code: string } }).error.code, "SESSION_INVALID");
      assert.equal(mm.submitCalls.length, 0);
    } finally {
      auth.signedIn = true;
    }
  });

  test("POST /api/matchmaker/brief rejects an invalid payload with MATCHMAKER_INVALID_REQUEST", async () => {
    const response = await request(app)
      .post("/api/matchmaker/brief")
      .send({ actingWorkspaceId: BUYER_WORKSPACE_ID });
    assert.equal(response.status, 400);
    assert.equal(
      (response.body as { error: { code: string } }).error.code,
      "MATCHMAKER_INVALID_REQUEST",
    );
  });

  test("POST /api/matchmaker/brief forwards the request and validates the response shape", async () => {
    const response = await request(app).post("/api/matchmaker/brief").send({
      actingWorkspaceId: BUYER_WORKSPACE_ID,
      briefText: "Need a Brooklyn producer for a remote Haitian dancehall single.",
    });
    assert.equal(response.status, 200);
    const parsed = submitBriefResponseV1Schema.safeParse(response.body);
    assert.equal(parsed.success, true);
    assert.ok(mm.submitCalls.length >= 1);
  });

  test("POST /api/matchmaker/brief maps MatchmakerError.BRIEF_FORBIDDEN to a 403 envelope", async () => {
    const response = await request(app).post("/api/matchmaker/brief").send({
      actingWorkspaceId: NON_BUYER_WORKSPACE_ID,
      briefText: "Need a Brooklyn producer.",
    });
    assert.equal(response.status, 403);
    assert.equal((response.body as { error: { code: string } }).error.code, "BRIEF_FORBIDDEN");
  });

  test("GET /api/matchmaker/brief/:briefId returns the brief when authorised", async () => {
    const response = await request(app).get("/api/matchmaker/brief/brief-test-1");
    assert.equal(response.status, 200);
    const parsed = briefResponseV1Schema.safeParse(response.body);
    assert.equal(parsed.success, true);
    assert.ok(mm.getCalls.length >= 1);
  });

  test("GET /api/matchmaker/brief/:briefId returns 404 for an unknown brief", async () => {
    const response = await request(app).get("/api/matchmaker/brief/brief-missing");
    assert.equal(response.status, 404);
    assert.equal((response.body as { error: { code: string } }).error.code, "BRIEF_NOT_FOUND");
  });

  test("GET /api/matchmaker/brief/:briefId maps AuthorizationError to 403", async () => {
    const response = await request(app).get("/api/matchmaker/brief/brief-forbidden");
    assert.equal(response.status, 403);
    assert.equal((response.body as { error: { code: string } }).error.code, "BRIEF_FORBIDDEN");
  });

  // M2 (#87) Finding 8 — buyer-supplied required criteria reach
  // the service. The route accepts an optional `required` block
  // (matching the shared `talentSearchRequiredCriteriaV1Schema`)
  // and forwards it to the service as `buyerRequired` so the
  // matchmaker brief submission can preserve the buyer's strict
  // filters across the /talent → /matchmaker round-trip.
  test("POST /api/matchmaker/brief forwards buyer-supplied required criteria to the service (Finding 8)", async () => {
    const response = await request(app)
      .post("/api/matchmaker/brief")
      .send({
        actingWorkspaceId: BUYER_WORKSPACE_ID,
        briefText: "Need a Brooklyn producer for a remote Haitian dancehall single.",
        required: {
          primaryCategoryKeys: ["songwriting"],
          serviceModes: ["Remote"],
          basedIn: { countryCode: "JM" },
        },
      });
    assert.equal(response.status, 200);
    assert.ok(mm.submitCalls.length >= 1);
    const lastCall = mm.submitCalls[mm.submitCalls.length - 1] as {
      readonly buyerRequired?: unknown;
    };
    assert.deepEqual(lastCall.buyerRequired, {
      primaryCategoryKeys: ["songwriting"],
      serviceModes: ["Remote"],
      basedIn: { countryCode: "JM" },
    });
  });
});
