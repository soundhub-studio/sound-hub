/* eslint-disable @typescript-eslint/no-floating-promises */
// BG6 funding route-helper unit tests.
//
// These tests assert the safe envelope mapping: BG6_* codes map to
// the correct HTTP status, BG6_FUNDING_INVALID is written for empty
// bodies or malformed JSON, and translateFundingServiceError echoes
// the typed code (NOT raw exception text) into the safe envelope.

import assert from "node:assert/strict";
import test from "node:test";
import type { Response } from "express";
import { FundingServiceError } from "../funding/funding.service.js";
import {
  translateFundingServiceError,
  validateFundingRequestBody,
  validateFundingResponse,
  writeFundingInternalError,
} from "./funding-route-helpers.js";
import { bg6FundDealRequestV1Schema, bg6FundDealResponseV1Schema } from "@soundhub/types";

interface MockResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  status(code: number): MockResponse;
  setHeader(name: string, value: string): MockResponse;
  json(payload: unknown): MockResponse;
}

function mockResponse(): MockResponse {
  const res: MockResponse = {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

const REQUEST_ID = "req_test_001";

test("validateFundingRequestBody rejects empty body with BG6_FUNDING_INVALID (400)", () => {
  const res = mockResponse();
  const result = validateFundingRequestBody(
    res as unknown as Response,
    bg6FundDealRequestV1Schema,
    {},
    REQUEST_ID,
    "Funding request",
  );
  assert.equal(result, null);
  assert.equal(res.statusCode, 400);
  const body = res.body as { error: { code: string; requestId: string } };
  assert.equal(body.error.code, "BG6_FUNDING_INVALID");
  assert.equal(body.error.requestId, REQUEST_ID);
});

test("validateFundingRequestBody rejects missing actingWorkspaceId with BG6_FUNDING_INVALID", () => {
  const res = mockResponse();
  const result = validateFundingRequestBody(
    res as unknown as Response,
    bg6FundDealRequestV1Schema,
    { actingWorkspaceId: "" },
    REQUEST_ID,
    "Funding request",
  );
  assert.equal(result, null);
  assert.equal(res.statusCode, 400);
});

test("validateFundingRequestBody accepts a well-formed body", () => {
  const res = mockResponse();
  const result = validateFundingRequestBody(
    res as unknown as Response,
    bg6FundDealRequestV1Schema,
    { actingWorkspaceId: "ws_buyer" },
    REQUEST_ID,
    "Funding request",
  );
  assert.ok(result);
  if (!result) return;
  assert.equal(result.actingWorkspaceId, "ws_buyer");
  assert.equal(res.statusCode, 200); // unchanged
});

test("translateFundingServiceError writes BG6_DEAL_NOT_FOUND (404)", () => {
  const res = mockResponse();
  const handled = translateFundingServiceError(
    res as unknown as Response,
    new FundingServiceError("Deal not found.", "BG6_DEAL_NOT_FOUND"),
    REQUEST_ID,
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 404);
});

test("translateFundingServiceError writes BG6_ESCROW_UNAVAILABLE (503)", () => {
  const res = mockResponse();
  const handled = translateFundingServiceError(
    res as unknown as Response,
    new FundingServiceError("Escrow unavailable.", "BG6_ESCROW_UNAVAILABLE"),
    REQUEST_ID,
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 503);
});

test("translateFundingServiceError writes BG6_FUNDING_CONFIRMATION_MISMATCH (422)", () => {
  const res = mockResponse();
  const handled = translateFundingServiceError(
    res as unknown as Response,
    new FundingServiceError("Provider confirmation mismatch.", "BG6_FUNDING_CONFIRMATION_MISMATCH"),
    REQUEST_ID,
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 422);
});

test("translateFundingServiceError writes BG6_DEAL_ALREADY_ACTIVE (409)", () => {
  const res = mockResponse();
  translateFundingServiceError(
    res as unknown as Response,
    new FundingServiceError("Already Active.", "BG6_DEAL_ALREADY_ACTIVE"),
    REQUEST_ID,
  );
  assert.equal(res.statusCode, 409);
});

test("translateFundingServiceError returns false for non-FundingServiceError input", () => {
  const res = mockResponse();
  const handled = translateFundingServiceError(
    res as unknown as Response,
    new Error("boom"),
    REQUEST_ID,
  );
  assert.equal(handled, false);
  assert.equal(res.statusCode, 200); // unchanged
});

test("translateFundingServiceError echoes the typed code (NOT raw exception text)", () => {
  const res = mockResponse();
  translateFundingServiceError(
    res as unknown as Response,
    new FundingServiceError("Provider unavailable.", "BG6_ESCROW_UNAVAILABLE"),
    REQUEST_ID,
  );
  const body = res.body as { error: { code: string; message: string } };
  assert.equal(body.error.code, "BG6_ESCROW_UNAVAILABLE");
  // The message is allowed to be a generic public-safe text — the
  // raw provider exception lives only on the server-only
  // failureDetail column.
  assert.equal(body.error.message, "Provider unavailable.");
});

test("writeFundingInternalError writes BG6_FUNDING_INTERNAL_FAILED (500)", () => {
  const res = mockResponse();
  writeFundingInternalError(res as unknown as Response, new Error("boom"), REQUEST_ID, "fund");
  assert.equal(res.statusCode, 500);
  const body = res.body as { error: { code: string } };
  assert.equal(body.error.code, "BG6_FUNDING_INTERNAL_FAILED");
});

test("validateFundingResponse accepts a well-formed payload", () => {
  const res = mockResponse();
  validateFundingResponse(
    res as unknown as Response,
    200,
    bg6FundDealResponseV1Schema,
    {
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
        // shared Zod schema must include the new field on every
        // public envelope.
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
    },
    REQUEST_ID,
    "fund",
  );
  assert.equal(res.statusCode, 200);
});

test("validateFundingResponse rejects drift with BG6_FUNDING_INTERNAL_FAILED", () => {
  const res = mockResponse();
  // Missing sandboxSimulatedBadge: schema rejects.
  validateFundingResponse(
    res as unknown as Response,
    200,
    bg6FundDealResponseV1Schema,
    {
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
        // shared Zod schema must include the new field on every
        // public envelope.
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
        // sandboxSimulatedBadge missing — strict Zod rejects.
      },
    },
    REQUEST_ID,
    "fund",
  );
  assert.equal(res.statusCode, 500);
});
