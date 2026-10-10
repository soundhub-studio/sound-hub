// Per-handler BG6 PaymentIntent + activation route logic.
//
// The router file (`funding.ts`) is a thin Express Router factory;
// this file owns the per-endpoint flow. The BG6 router currently
// exposes a single endpoint: POST /api/deals/:dealId/funding.
//
// The route re-uses the BG5 DealTermsService.getDeal to compose the
// full Deal view for the response so the public DTO carries the
// canonical Deal + current TermsVersion + approvals + project
// request + seller-consent fields. The funding status is layered on
// top.

import type { Request, Response } from "express";
import { bg6FundDealRequestV1Schema, bg6FundDealResponseV1Schema } from "@soundhub/types";
import type { FundingService } from "../funding/funding.service.js";
import type { DealTermsService } from "../deal-terms/deal-terms.service.js";
import {
  readFundingJsonBody,
  readFundingPathParam,
  resolveSessionForFunding,
  translateFundingServiceError,
  validateFundingRequestBody,
  validateFundingResponse,
  writeFundingInternalError,
} from "./funding-route-helpers.js";

export interface FundingRouteDeps {
  readonly authenticationService: {
    resolveSession(id: string | undefined): Promise<unknown>;
  };
  readonly fundingService: FundingService;
  readonly dealTermsService: DealTermsService;
}

export function createFundingRouter(deps: FundingRouteDeps) {
  return async (req: Request, res: Response, next: (err?: unknown) => void): Promise<void> => {
    const sessionResult = await resolveSessionForFunding(
      req,
      res,
      deps.authenticationService,
      "fund this Deal",
    );
    if (!sessionResult) return;
    const { session, requestId } = sessionResult;

    const dealId = readFundingPathParam(res, req, "dealId", requestId);
    if (!dealId) return;

    const path = req.path.replace(/\/$/, "");
    if (path.endsWith("/funding") && req.method === "POST") {
      return fundDeal(deps)(req, res, session.userAccountId, dealId, requestId);
    }
    writeFundingInternalError(res, new Error("not found"), requestId, "routing funding");
    void next;
  };
}

function fundDeal(
  deps: FundingRouteDeps,
): (
  req: Request,
  res: Response,
  userAccountId: string,
  dealId: string,
  requestId: string,
) => Promise<void> {
  return async (req, res, userAccountId, dealId, requestId) => {
    const rawBody = await readFundingJsonBody(req, res, requestId);
    if (rawBody === null) return;

    const parsed = validateFundingRequestBody(
      res,
      bg6FundDealRequestV1Schema,
      rawBody,
      requestId,
      "Funding request",
    );
    if (parsed === null) return;

    try {
      const result = await deps.fundingService.fundDeal({
        userAccountId,
        actingWorkspaceId: parsed.actingWorkspaceId,
        dealId,
      });
      // Re-fetch the Deal view through the BG5 service so the
      // response carries the canonical Deal + current TermsVersion +
      // approvals + project request + seller-consent shape.
      //
      // The seller-consent projection is required by
      // bg5DealViewV1Schema (AC27 widening) and is sourced from the
      // canonical DealTermsService.getDeal() result — NOT recomputed
      // or inferred here, and NOT fetched via a separate
      // ProjectRequest query. The funding route is intentionally a
      // pure serializer over the BG5 service output.
      const view = await deps.dealTermsService.getDeal({
        userAccountId,
        actingWorkspaceId: parsed.actingWorkspaceId,
        dealId,
      });
      validateFundingResponse(
        res,
        200,
        bg6FundDealResponseV1Schema,
        {
          ok: true,
          deal: {
            deal: view.deal,
            currentTermsVersion: view.currentTermsVersion,
            currentApprovals: view.currentApprovals,
            sellerConsent: view.sellerConsent,
            // M2 (#88) Codex finding: the Bg5DealViewV1 schema
            // requires the `actingSideHasDealApprover` field. The
            // funding route does not depend on it, but the
            // strict shared Zod schema fails closed without it.
            actingSideHasDealApprover: view.actingSideHasDealApprover,
          },
          fundingStatus: result.fundingStatus,
        },
        requestId,
        "fund",
      );
    } catch (err) {
      if (translateFundingServiceError(res, err, requestId)) return;
      writeFundingInternalError(res, err, requestId, "funding the Deal");
    }
  };
}
