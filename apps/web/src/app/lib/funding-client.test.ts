/* eslint-disable @typescript-eslint/no-floating-promises */
// Funding client unit tests (BG6).
//
// Asserts: fundDeal issues a POST to /api/deals/:dealId/funding with
// credentials and JSON content-type; the response is parsed through
// the shared bg6FundDealResponseV1Schema; session-loss error codes
// surface as FundingClientError so the page can refresh the session.

import assert from "node:assert/strict";
import test from "node:test";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_LOCATION = (globalThis as { location?: unknown }).location;

type FetchCall = {
  readonly url: string;
  readonly init: RequestInit;
};

function installFetchMock(handler: (call: FetchCall) => Promise<Response> | Response) {
  const calls: FetchCall[] = [];
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === "string") {
      calls.push({ url: input, init: init ?? {} });
    } else if (input instanceof URL) {
      calls.push({ url: input.toString(), init: init ?? {} });
    } else {
      calls.push({ url: input.url, init: init ?? {} });
    }
    return handler({ url: calls[calls.length - 1]?.url ?? "", init: init ?? {} });
  }) as typeof fetch;
  return calls;
}

function restoreGlobals(calls: FetchCall[]) {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_LOCATION !== undefined) {
    (globalThis as { location?: unknown }).location = ORIGINAL_LOCATION;
  } else {
    delete (globalThis as { location?: unknown }).location;
  }
  // Suppress unused-variable lint
  void calls;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("fundDeal issues a POST to /api/deals/:dealId/funding with credentials + JSON content-type", async () => {
  const calls = installFetchMock(() =>
    jsonResponse(200, {
      ok: true,
      deal: {
        deal: {
          dealId: "deal_test",
          buyerWorkspaceId: "ws_b",
          sellerWorkspaceId: "ws_s",
          serviceOfferingId: "of_1",
          projectBriefId: "b_1",
          projectRequestId: "pr_1",
          status: "Active",
          activatedAt: "2026-09-03T12:00:00.000Z",
          createdAt: "2026-09-01T00:00:00.000Z",
        },
        currentTermsVersion: null,
        currentApprovals: [],
        sellerConsent: null,
        // M2 (#88) Codex finding: the Bg5DealViewV1 schema
        // requires the `actingSideHasDealApprover` field. The
        // funding route does not depend on it, but the strict
        // shared Zod schema fails closed without it.
        actingSideHasDealApprover: false,
      },
      fundingStatus: {
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
      },
    }),
  );
  const { fundDeal } = await import("./funding-client.js");
  try {
    const result = await fundDeal("deal_test", { actingWorkspaceId: "ws_b" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "/api/deals/deal_test/funding");
    assert.equal(calls[0]?.init.method, "POST");
    assert.equal(calls[0]?.init.credentials, "include");
    assert.equal(
      (calls[0]?.init.headers as Record<string, string>)["Content-Type"],
      "application/json",
    );
    assert.equal(calls[0]?.init.body, JSON.stringify({ actingWorkspaceId: "ws_b" }));
    assert.equal(result.fundingStatus.status, "Confirmed");
    assert.equal(result.fundingStatus.networkLabel, "simulated-network");
  } finally {
    restoreGlobals(calls);
  }
});

test("fundDeal surfaces BG6_ESCROW_UNAVAILABLE (503) with the parsed error envelope", async () => {
  const calls = installFetchMock(() =>
    jsonResponse(503, {
      error: {
        code: "BG6_ESCROW_UNAVAILABLE",
        message: "The escrow provider is unavailable.",
        requestId: "req_test",
      },
    }),
  );
  const { fundDeal } = await import("./funding-client.js");
  try {
    await assert.rejects(
      () => fundDeal("deal_test", { actingWorkspaceId: "ws_b" }),
      (err: unknown) => {
        const e = err as Error & {
          status?: number;
          code?: string;
          requestId?: string | null;
        };
        assert.equal(e.status, 503);
        assert.equal(e.code, "BG6_ESCROW_UNAVAILABLE");
        assert.equal(e.requestId, "req_test");
        return true;
      },
    );
  } finally {
    restoreGlobals(calls);
  }
});

test("fundDeal surfaces BG6_FUNDING_CONFIRMATION_MISMATCH (422)", async () => {
  const calls = installFetchMock(() =>
    jsonResponse(422, {
      error: {
        code: "BG6_FUNDING_CONFIRMATION_MISMATCH",
        message: "The provider confirmation did not match the locked TermsVersion snapshot.",
        requestId: "req_test",
      },
    }),
  );
  const { fundDeal } = await import("./funding-client.js");
  try {
    await assert.rejects(
      () => fundDeal("deal_test", { actingWorkspaceId: "ws_b" }),
      (err: unknown) => {
        const e = err as Error & { code?: string };
        assert.equal(e.code, "BG6_FUNDING_CONFIRMATION_MISMATCH");
        return true;
      },
    );
  } finally {
    restoreGlobals(calls);
  }
});

test("fundDeal public response does NOT contain paymentIntentId, correlationId, providerReference, or raw failureDetail", async () => {
  const calls = installFetchMock(() =>
    jsonResponse(200, {
      ok: true,
      deal: {
        deal: {
          dealId: "deal_test",
          buyerWorkspaceId: "ws_b",
          sellerWorkspaceId: "ws_s",
          serviceOfferingId: "of_1",
          projectBriefId: "b_1",
          projectRequestId: "pr_1",
          status: "Active",
          activatedAt: "2026-09-03T12:00:00.000Z",
          createdAt: "2026-09-01T00:00:00.000Z",
        },
        currentTermsVersion: null,
        currentApprovals: [],
        sellerConsent: null,
        // M2 (#88) Codex finding: the Bg5DealViewV1 schema
        // requires the `actingSideHasDealApprover` field. The
        // funding route does not depend on it, but the strict
        // shared Zod schema fails closed without it.
        actingSideHasDealApprover: false,
      },
      fundingStatus: {
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
      },
    }),
  );
  const { fundDeal } = await import("./funding-client.js");
  try {
    const result = await fundDeal("deal_test", { actingWorkspaceId: "ws_b" });
    const flat = JSON.stringify(result);
    assert.ok(!flat.includes("paymentIntentId"));
    assert.ok(!flat.includes("correlationId"));
    assert.ok(!flat.includes("providerReference"));
    assert.ok(!flat.includes("failureDetail"));
    assert.ok(!flat.includes("providerState"));
  } finally {
    restoreGlobals(calls);
  }
});
