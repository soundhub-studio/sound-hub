/* eslint-disable @typescript-eslint/no-floating-promises */
// DealTerms client unit tests (BG5).
//
// Background: ticket #63 requires the BG5 web client to parse
// responses against the shared Zod schemas from `@soundhub/types` so
// the browser cannot drift from the contract. These tests stub the
// global `fetch` and assert observable outcome only — no JSDOM, no
// source-pattern assertions.

import assert from "node:assert/strict";
import { describe, test, beforeEach, afterEach } from "node:test";
import type { Bg5DealApprovalPublicV1, Bg5TermsVersionPublicV1 } from "@soundhub/types";
import { approveTerms, draftTerms, fetchDeal } from "./deal-terms-client.js";

const originalFetch = globalThis.fetch;
let lastRequest: { url: string; init?: RequestInit } | null = null;

function mockFetch(
  response:
    | { status: number; body: unknown }
    | ((url: string, init?: RequestInit) => { status: number; body: unknown }),
): void {
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    lastRequest = { url, init };
    const r = typeof response === "function" ? response(url, init) : response;
    return Promise.resolve(
      new Response(JSON.stringify(r.body), {
        status: r.status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };
}

beforeEach(() => {
  lastRequest = null;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const sampleTermsVersion: Bg5TermsVersionPublicV1 = {
  termsVersionId: "tv-1",
  dealId: "deal-1",
  version: 1,
  scope: "Scope",
  deliverables: [{ title: "t", description: "d" }],
  schedule: { startDate: "2026-01-01", endDate: "2026-01-22", deliveryDays: 21 },
  price: { amountMinor: 75000, currency: "USD" },
  revisionAllowance: 1,
  rightsSummary: "Rights",
  fundingDeadlineAt: null,
  aiProvider: "deterministic-fallback",
  aiModelId: null,
  aiFallbackUsed: true,
  aiDraftedUnapprovedBadge: true,
  draftedAt: "2026-09-01T00:00:00.000Z",
  createdAt: "2026-09-01T00:00:00.000Z",
  isCurrentVersion: true,
};

const sampleApproval: Bg5DealApprovalPublicV1 = {
  dealApprovalId: "da-1",
  termsVersionId: "tv-1",
  workspaceId: "ws-buyer",
  approvedAt: "2026-09-02T00:00:00.000Z",
};

describe("fetchDeal", () => {
  test("parses the Deal view against the shared schema", async () => {
    mockFetch({
      status: 200,
      body: {
        deal: {
          deal: {
            dealId: "deal-1",
            buyerWorkspaceId: "ws-buyer",
            sellerWorkspaceId: "ws-seller",
            serviceOfferingId: "of-1",
            projectBriefId: "brief-1",
            projectRequestId: "pr-1",
            status: "Negotiating",
            activatedAt: null,
            createdAt: "2026-09-01T00:00:00.000Z",
          },
          currentTermsVersion: sampleTermsVersion,
          currentApprovals: [],
          sellerConsent: {
            status: "Accepted",
            sellerConsentAt: "2026-09-01T00:00:05.000Z",
          },
          // M2 (#88) Codex finding: the Bg5DealViewV1 schema
          // requires the `actingSideHasDealApprover` field. The
          // deal page surfaces the permission CTA vs approve
          // CTA exclusively based on this signal.
          actingSideHasDealApprover: true,
        },
      },
    });
    const result = await fetchDeal("deal-1", "ws-buyer");
    assert.equal(result.deal.deal.dealId, "deal-1");
    assert.equal(result.deal.currentTermsVersion?.termsVersionId, "tv-1");
    assert.equal(result.deal.currentApprovals.length, 0);
    assert.equal(result.deal.sellerConsent?.status, "Accepted");
  });

  test("sends actingWorkspaceId as a query parameter with credentials", async () => {
    mockFetch({
      status: 200,
      body: {
        deal: {
          deal: {
            dealId: "deal-1",
            buyerWorkspaceId: "ws-buyer",
            sellerWorkspaceId: "ws-seller",
            serviceOfferingId: "of-1",
            projectBriefId: "brief-1",
            projectRequestId: "pr-1",
            status: "Negotiating",
            activatedAt: null,
            createdAt: "2026-09-01T00:00:00.000Z",
          },
          currentTermsVersion: null,
          currentApprovals: [],
          sellerConsent: null,
          // M2 (#88) Codex finding: the Bg5DealViewV1 schema
          // requires the `actingSideHasDealApprover` field.
          actingSideHasDealApprover: false,
        },
      },
    });
    await fetchDeal("deal-1", "ws-buyer");
    assert.ok(lastRequest);
    const req = lastRequest;
    assert.ok(req.url.includes("actingWorkspaceId=ws-buyer"));
    assert.equal(req.init?.credentials, "include");
    assert.equal(req.init?.method, "GET");
  });

  test("throws on non-ok response with the safe envelope code", async () => {
    mockFetch({
      status: 403,
      body: {
        error: {
          code: "BG5_APPROVAL_FORBIDDEN",
          message: "forbidden",
          requestId: "rid-1",
        },
      },
    });
    await assert.rejects(
      () => fetchDeal("deal-1", "ws-buyer"),
      (err: unknown) => {
        const e = err as { code?: string; status?: number };
        assert.equal(e.code, "BG5_APPROVAL_FORBIDDEN");
        assert.equal(e.status, 403);
        return true;
      },
    );
  });
});

describe("draftTerms", () => {
  test("parses the draft response against the shared schema", async () => {
    mockFetch({
      status: 201,
      body: { ok: true, termsVersion: sampleTermsVersion },
    });
    const result = await draftTerms("deal-1", { actingWorkspaceId: "ws-buyer" });
    assert.equal(result.termsVersion.termsVersionId, "tv-1");
    assert.equal(result.termsVersion.aiDraftedUnapprovedBadge, true);
  });

  test("rejects malformed body that does not satisfy the schema", async () => {
    mockFetch({
      status: 201,
      body: { ok: true, termsVersion: { ...sampleTermsVersion, version: "not-an-int" } },
    });
    await assert.rejects(() => draftTerms("deal-1", { actingWorkspaceId: "ws-buyer" }));
  });
});

describe("approveTerms", () => {
  test("parses the approval response against the shared schema", async () => {
    mockFetch({
      status: 201,
      body: { ok: true, approval: sampleApproval },
    });
    const result = await approveTerms("deal-1", {
      actingWorkspaceId: "ws-buyer",
      termsVersionId: "tv-1",
    });
    assert.equal(result.approval.dealApprovalId, "da-1");
    assert.equal(result.approval.workspaceId, "ws-buyer");
  });

  test("sends both actingWorkspaceId + termsVersionId in the JSON body with credentials", async () => {
    mockFetch({ status: 201, body: { ok: true, approval: sampleApproval } });
    await approveTerms("deal-1", { actingWorkspaceId: "ws-buyer", termsVersionId: "tv-1" });
    assert.ok(lastRequest);
    const req = lastRequest;
    const body = parseRequestBody(req.init?.body);
    assert.equal(body.actingWorkspaceId, "ws-buyer");
    assert.equal(body.termsVersionId, "tv-1");
    assert.equal(req.init?.method, "POST");
    assert.equal(req.init?.credentials, "include");
  });

  test("does not accept authoritative timestamps from the request body", async () => {
    // The route schema only allows actingWorkspaceId + termsVersionId;
    // any extra field is dropped server-side. Assert the body shape.
    mockFetch({
      status: 201,
      body: { ok: true, approval: sampleApproval },
    });
    await approveTerms("deal-1", {
      actingWorkspaceId: "ws-buyer",
      termsVersionId: "tv-1",
    });
    assert.ok(lastRequest);
    const req = lastRequest;
    const body = parseRequestBody(req.init?.body);
    assert.equal(body.approvedAt, undefined, "approvedAt must not be sent from the client");
    assert.equal(body.draftedAt, undefined, "draftedAt must not be sent from the client");
    assert.equal(body.dealApproverId, undefined, "dealApproverId must not be sent from the client");
  });
});

/**
 * Parse the fetch request body through a JSON.parse + unknown-typed
 * boundary so the rest of the test can use a typed record. The
 * schema at the public boundary is `z.record(z.string(), z.unknown())`
 * for the AI candidate, and the strict Zod schema for the request
 * body itself; here we only need to read specific keys.
 */
function parseRequestBody(body: unknown): Record<string, unknown> {
  if (typeof body !== "string") return {};
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return {};
}
