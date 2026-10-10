/* eslint-disable @typescript-eslint/no-floating-promises */
/* eslint-disable @typescript-eslint/require-await */
// BG6 funding-handler route tests.
//
// Background (regression coverage for the AC27 seller-consent widening):
//   AC27 widened `bg5DealViewV1Schema` so the Deal view embedded in
//   `bg6FundDealResponseV1Schema` carries the canonical
//   `sellerConsent` projection. The funding route re-uses
//   `DealTermsService.getDeal()` to compose the response — but the
//   first regression was that the manual reconstruction in
//   `funding-handlers.ts` rebuilt the view WITHOUT `sellerConsent`,
//   so `validateFundingResponse()` rejected the payload and the
//   server emitted `BG6_FUNDING_INTERNAL_FAILED: fund response drift
//   detected.` immediately after the buyer's "Fund Deal" click.
//
// These tests pin the regression down at the route boundary so any
// future refactor that drops `sellerConsent` from the manual
// reconstruction fails loudly at CI. The tests use fake
// FundingService + DealTermsService implementations so the route
// contract is exercised without touching the database or the
// real provider adapter.
//
// Coverage:
//   (a) successful funding response containing the canonical
//       sellerConsent projection validates against
//       bg6FundDealResponseV1Schema (no drift error);
//   (b) response carries Active Deal + current terms + current
//       approvals + funding status expected by BG6;
//   (c) the response does NOT introduce provider / internal
//       identifiers (paymentIntentId, correlationId,
//       providerReference, raw failureDetail);
//   (d) when the manual reconstruction omits `sellerConsent` the
//       server-side validation remains fail-closed (500
//       BG6_FUNDING_INTERNAL_FAILED) — proving the validator is the
//       enforcement boundary, not a coincidence.

import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import type { Express } from "express";
import type {
  Bg5DealApprovalPublicV1,
  Bg5SellerConsentProjectionV1,
  Bg5TermsVersionPublicV1,
  Bg6FundingConfirmationPublicV1,
  DealPublicV1,
} from "@soundhub/types";
import { createBg6FundingRouter } from "./funding.js";
import type { FundingRouteDeps } from "./funding-handlers.js";

const USER_ID = "user-buyer";
const WORKSPACE_ID = "ws-buyer";
const DEAL_ID = "deal-1";

// ---------- Fixtures ----------

function makeActiveDeal(): DealPublicV1 {
  return {
    dealId: DEAL_ID,
    buyerWorkspaceId: "ws_b",
    sellerWorkspaceId: "ws_s",
    serviceOfferingId: "of_1",
    projectBriefId: "b_1",
    projectRequestId: "pr_1",
    status: "Active",
    activatedAt: "2026-09-03T12:00:00.000Z",
    createdAt: "2026-09-01T00:00:00.000Z",
  };
}

function makeCurrentTermsVersion(): Bg5TermsVersionPublicV1 {
  return {
    termsVersionId: "tv_1",
    dealId: DEAL_ID,
    version: 1,
    scope: "Mix and master one full track.",
    deliverables: [{ title: "Stems", description: "All final stems in WAV" }],
    schedule: {
      startDate: "2026-09-04",
      endDate: "2026-09-18",
      deliveryDays: 14,
    },
    price: { amountMinor: 75000, currency: "USD" },
    revisionAllowance: 2,
    rightsSummary: "Buyer receives a non-exclusive license.",
    fundingDeadlineAt: null,
    aiProvider: "deterministic-fallback",
    aiModelId: null,
    aiFallbackUsed: true,
    aiDraftedUnapprovedBadge: true,
    draftedAt: "2026-09-02T10:00:00.000Z",
    createdAt: "2026-09-02T10:00:00.000Z",
    isCurrentVersion: true,
  };
}

function makeApprovals(): Bg5DealApprovalPublicV1[] {
  return [
    {
      dealApprovalId: "da_buyer",
      termsVersionId: "tv_1",
      workspaceId: "ws_b",
      approvedAt: "2026-09-02T11:00:00.000Z",
    },
    {
      dealApprovalId: "da_seller",
      termsVersionId: "tv_1",
      workspaceId: "ws_s",
      approvedAt: "2026-09-02T12:00:00.000Z",
    },
  ];
}

function makeFundingStatus(): Bg6FundingConfirmationPublicV1 {
  return {
    status: "Confirmed",
    expectedAmount: { amountMinor: 75000, currency: "USD" },
    confirmedAmount: { amountMinor: 75000, currency: "USD" },
    providerKey: "mock-escrow-deterministic",
    assetLabel: "sandbox-USDC",
    networkLabel: "simulated-network",
    environmentLabel: "sandbox",
    confirmationTime: "2026-09-03T12:00:00.000Z",
    sanitizedFailureReason: null,
    sandboxSimulatedBadge: true,
  };
}

// ---------- Test doubles ----------

class FakeAuthService {
  async resolveSession(): Promise<{ userAccountId: string } | null> {
    return { userAccountId: USER_ID };
  }
}

class FakeFundingService {
  readonly calls: { userAccountId: string; actingWorkspaceId: string; dealId: string }[] = [];
  async fundDeal(input: {
    userAccountId: string;
    actingWorkspaceId: string;
    dealId: string;
  }): Promise<{
    readonly dealStatus: "Negotiating" | "Active";
    readonly activatedAt: string | null;
    readonly fundingStatus: Bg6FundingConfirmationPublicV1;
  }> {
    this.calls.push(input);
    return {
      dealStatus: "Active",
      activatedAt: "2026-09-03T12:00:00.000Z",
      fundingStatus: makeFundingStatus(),
    };
  }
}

class FakeDealTermsService {
  /**
   * The canonical seller-consent projection the BG5 service exposes
   * for an Accepted ProjectRequest (AC27). The test default returns
   * the non-null projection; specific tests override this to model
   * the null invariant case or the drift case.
   */
  sellerConsentOverride: Bg5SellerConsentProjectionV1 | null = {
    status: "Accepted",
    sellerConsentAt: "2026-09-01T09:00:00.000Z",
  };
  readonly calls: { userAccountId: string; actingWorkspaceId: string; dealId: string }[] = [];

  async getDeal(input: {
    userAccountId: string;
    actingWorkspaceId: string;
    dealId: string;
  }): Promise<{
    readonly deal: DealPublicV1;
    readonly currentTermsVersion: Bg5TermsVersionPublicV1 | null;
    readonly currentApprovals: readonly Bg5DealApprovalPublicV1[];
    readonly sellerConsent: Bg5SellerConsentProjectionV1 | null;
    // M2 (#88) Codex finding: the Bg5DealViewV1 schema
    // requires the `actingSideHasDealApprover` field. The
    // funding route does not depend on it, but the strict
    // shared Zod schema fails closed without it.
    readonly actingSideHasDealApprover: boolean;
  }> {
    this.calls.push(input);
    return {
      deal: makeActiveDeal(),
      currentTermsVersion: makeCurrentTermsVersion(),
      currentApprovals: makeApprovals(),
      sellerConsent: this.sellerConsentOverride,
      // M2 (#88) Codex finding: the Bg5DealViewV1 schema
      // requires the `actingSideHasDealApprover` field on the
      // public envelope. The funding route does not depend on
      // it, but the strict shared Zod schema fails closed
      // without it.
      actingSideHasDealApprover: true,
    };
  }
}

// NOTE: This name keeps the regression-coverage intent explicit in
// the failing test message; the helper just bypasses the property to
// simulate the AC27 widening regression when the manual route
// reconstruction omits `sellerConsent`. Keeping the structural shape
// here (rather than importing `DealTermsService`) lets the
// drift-test inject a getDeal() that intentionally drops
// `sellerConsent` without lying to the rest of the suite about the
// real service surface.
type DealTermsServiceShape = {
  getDeal(input: { userAccountId: string; actingWorkspaceId: string; dealId: string }): Promise<{
    deal: DealPublicV1;
    currentTermsVersion: Bg5TermsVersionPublicV1 | null;
    currentApprovals: readonly Bg5DealApprovalPublicV1[];
    sellerConsent: Bg5SellerConsentProjectionV1 | null;
    // M2 (#88) Codex finding: the Bg5DealViewV1 schema
    // requires the `actingSideHasDealApprover` field. The
    // funding route does not depend on it, but the strict
    // shared Zod schema must include the new field on every
    // public envelope.
    actingSideHasDealApprover: boolean;
  }>;
};
type FundingServiceShape = {
  fundDeal(input: { userAccountId: string; actingWorkspaceId: string; dealId: string }): Promise<{
    readonly dealStatus: "Negotiating" | "Active";
    readonly activatedAt: string | null;
    readonly fundingStatus: Bg6FundingConfirmationPublicV1;
  }>;
};
type FundingRouteTestDeps = Omit<FundingRouteDeps, "fundingService" | "dealTermsService"> & {
  readonly fundingService: FundingServiceShape;
  readonly dealTermsService: DealTermsServiceShape;
};

function buildApp(deps: FundingRouteTestDeps): Express {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/deals",
    createBg6FundingRouter(deps as unknown as Parameters<typeof createBg6FundingRouter>[0]),
  );
  return app;
}

function buildHappyDeps(): {
  auth: FakeAuthService;
  funding: FakeFundingService;
  terms: FakeDealTermsService;
} {
  return {
    auth: new FakeAuthService(),
    funding: new FakeFundingService(),
    terms: new FakeDealTermsService(),
  };
}

test("(a) successful fund response containing the canonical sellerConsent projection validates and returns 200", async () => {
  const { auth, funding, terms } = buildHappyDeps();
  const app = buildApp({
    authenticationService: auth,
    fundingService: funding,
    dealTermsService: terms,
  });

  const response = await request(app)
    .post(`/api/deals/${DEAL_ID}/funding`)
    .set("Cookie", "soundhub_session=session-token")
    .send({ actingWorkspaceId: WORKSPACE_ID });

  // 200 (NOT 500 BG6_FUNDING_INTERNAL_FAILED) — proves the
  // reconstruction no longer drops `sellerConsent` since the AC27
  // widening.
  assert.equal(response.status, 200);
  assert.ok(!JSON.stringify(response.body).includes("BG6_FUNDING_INTERNAL_FAILED"));

  const body = response.body as {
    ok: boolean;
    deal: {
      deal: { status: string; dealId: string; activatedAt: string };
      currentTermsVersion: Bg5TermsVersionPublicV1 | null;
      currentApprovals: Bg5DealApprovalPublicV1[];
      sellerConsent: Bg5SellerConsentProjectionV1 | null;
      // M2 (#88) Codex finding: the Bg5DealViewV1 schema
      // requires the `actingSideHasDealApprover` field. The
      // funding route does not depend on it, but the strict
      // shared Zod schema must include the new field on every
      // public envelope.
      actingSideHasDealApprover: boolean;
    };
    fundingStatus: Bg6FundingConfirmationPublicV1;
  };

  // (a) The canonical seller-consent projection the BG5 service
  // exposes is round-tripped verbatim — no recomputation, no
  // separate ProjectRequest query.
  assert.equal(body.deal.sellerConsent?.status, "Accepted");
  assert.equal(body.deal.sellerConsent?.sellerConsentAt, "2026-09-01T09:00:00.000Z");

  // (b) Response still carries Active Deal + current terms +
  // current approvals + funding status expected by BG6.
  assert.equal(body.deal.deal.status, "Active");
  assert.equal(body.deal.deal.dealId, DEAL_ID);
  assert.ok(body.deal.currentTermsVersion);
  assert.equal(body.deal.currentTermsVersion?.termsVersionId, "tv_1");
  assert.equal(body.deal.currentApprovals.length, 2);
  assert.equal(body.fundingStatus.status, "Confirmed");
  assert.equal(body.fundingStatus.sandboxSimulatedBadge, true);
});

test("(a-null) the BG5 service null invariant (sellerConsent: null) round-trips and the response still validates", async () => {
  // The DealTermsService is the canonical source for the
  // projection: when the invariant does not hold (no PR row, or PR
  // status not Accepted), the service returns null and the
  // funding route MUST pass that null through. Hardening this
  // guarantees no future refactor fabricates an "Accepted"
  // indicator on a Deal without a backing consent fact.
  const { auth, funding, terms } = buildHappyDeps();
  terms.sellerConsentOverride = null;
  const app = buildApp({
    authenticationService: auth,
    fundingService: funding,
    dealTermsService: terms,
  });

  const response = await request(app)
    .post(`/api/deals/${DEAL_ID}/funding`)
    .set("Cookie", "soundhub_session=session-token")
    .send({ actingWorkspaceId: WORKSPACE_ID });

  assert.equal(response.status, 200);
  const body = response.body as {
    deal: { sellerConsent: Bg5SellerConsentProjectionV1 | null };
  };
  assert.equal(body.deal.sellerConsent, null);
});

test("(b) response exposes BG6 product surface: Active Deal + current terms + current approvals + funding status", async () => {
  const { auth, funding, terms } = buildHappyDeps();
  const app = buildApp({
    authenticationService: auth,
    fundingService: funding,
    dealTermsService: terms,
  });

  const response = await request(app)
    .post(`/api/deals/${DEAL_ID}/funding`)
    .set("Cookie", "soundhub_session=session-token")
    .send({ actingWorkspaceId: WORKSPACE_ID });

  assert.equal(response.status, 200);
  const body = response.body as {
    deal: {
      deal: { status: string; activatedAt: string };
      currentTermsVersion: Bg5TermsVersionPublicV1 | null;
      currentApprovals: Bg5DealApprovalPublicV1[];
    };
    fundingStatus: Bg6FundingConfirmationPublicV1;
  };

  // Active Deal.
  assert.equal(body.deal.deal.status, "Active");
  assert.ok(body.deal.deal.activatedAt);

  // Current terms (single TermsVersion, isCurrentVersion = true).
  assert.ok(body.deal.currentTermsVersion);
  assert.equal(body.deal.currentTermsVersion?.isCurrentVersion, true);

  // Both approvals present (buyer + seller) for the current
  // TermsVersion.
  const approvalWorkspaces = body.deal.currentApprovals.map((a) => a.workspaceId).sort();
  assert.deepEqual(approvalWorkspaces, ["ws_b", "ws_s"]);

  // Funding status carries the BG6 product surface only.
  assert.equal(body.fundingStatus.providerKey, "mock-escrow-deterministic");
  assert.equal(body.fundingStatus.assetLabel, "sandbox-USDC");
  assert.equal(body.fundingStatus.networkLabel, "simulated-network");
  assert.equal(body.fundingStatus.environmentLabel, "sandbox");
  assert.equal(body.fundingStatus.sanitizedFailureReason, null);
  assert.equal(body.fundingStatus.sandboxSimulatedBadge, true);
});

test("(c) response does NOT introduce provider / internal identifiers (paymentIntentId, correlationId, providerReference, raw failureDetail)", async () => {
  const { auth, funding, terms } = buildHappyDeps();
  const app = buildApp({
    authenticationService: auth,
    fundingService: funding,
    dealTermsService: terms,
  });

  const response = await request(app)
    .post(`/api/deals/${DEAL_ID}/funding`)
    .set("Cookie", "soundhub_session=session-token")
    .send({ actingWorkspaceId: WORKSPACE_ID });

  assert.equal(response.status, 200);
  const serialized = JSON.stringify(response.body);
  for (const forbidden of [
    "paymentIntentId",
    "correlationId",
    "providerReference",
    "rawFailureDetail",
    "failureDetail",
    // Internal providerState labels must not leak — only the
    // closed `bg6PublicFundingStatusesV1` labels do.
    "AwaitingProvider",
    "Created",
    "providerState",
  ]) {
    assert.ok(!serialized.includes(forbidden), `BG6 public DTO must not expose ${forbidden}`);
  }
});

test("(d) when sellerConsent is omitted from the manual reconstruction the server-side validator remains fail-closed (500 BG6_FUNDING_INTERNAL_FAILED)", async () => {
  // This test re-exercises the AC27 widening regression through a
  // purpose-built double whose `getDeal()` deliberately returns a
  // view WITHOUT `sellerConsent` — modelling the pre-fix
  // reconstruction. The validator at the route boundary is the
  // single source of truth: any future manual reconstruction that
  // drops the required field MUST collapse to a 500 envelope here,
  // NOT silently 200 with a malformed body.
  const { auth, funding } = buildHappyDeps();

  class DriftingDealTermsService {
    async getDeal(): Promise<{
      deal: DealPublicV1;
      currentTermsVersion: Bg5TermsVersionPublicV1 | null;
      currentApprovals: readonly Bg5DealApprovalPublicV1[];
      // Deliberately omit `sellerConsent` here — the Zod schema
      // requires it. We intentionally use `as` to bypass the type
      // and prove the runtime validator rejects it.
      // M2 (#88) Codex finding: include the
      // `actingSideHasDealApprover` field so the runtime
      // validator's missing-field failure isolates on
      // `sellerConsent`.
      actingSideHasDealApprover: boolean;
    }> {
      return {
        deal: makeActiveDeal(),
        currentTermsVersion: makeCurrentTermsVersion(),
        currentApprovals: makeApprovals(),
        actingSideHasDealApprover: true,
      };
    }
  }

  const app = buildApp({
    authenticationService: auth,
    fundingService: funding,
    dealTermsService: new DriftingDealTermsService() as unknown as DealTermsServiceShape,
  });

  const response = await request(app)
    .post(`/api/deals/${DEAL_ID}/funding`)
    .set("Cookie", "soundhub_session=session-token")
    .send({ actingWorkspaceId: WORKSPACE_ID });

  assert.equal(response.status, 500);
  const body = response.body as { error: { code: string; message: string } };
  assert.equal(body.error.code, "BG6_FUNDING_INTERNAL_FAILED");
  assert.equal(body.error.message, "fund response drift detected.");
});

test("BG5 service getDeal is invoked exactly once per funding response so no separate ProjectRequest query is opened", async () => {
  // The fix is a pure serializer over the BG5 service output: the
  // funding route MUST NOT introduce a second ProjectRequest lookup.
  // If a future change adds one, this test pins the call count.
  const { auth, funding, terms } = buildHappyDeps();
  const app = buildApp({
    authenticationService: auth,
    fundingService: funding,
    dealTermsService: terms,
  });

  await request(app)
    .post(`/api/deals/${DEAL_ID}/funding`)
    .set("Cookie", "soundhub_session=session-token")
    .send({ actingWorkspaceId: WORKSPACE_ID });

  assert.equal(terms.calls.length, 1);
  assert.equal(funding.calls.length, 1);
  assert.equal(terms.calls[0]?.userAccountId, USER_ID);
  assert.equal(terms.calls[0]?.actingWorkspaceId, WORKSPACE_ID);
  assert.equal(terms.calls[0]?.dealId, DEAL_ID);
});
