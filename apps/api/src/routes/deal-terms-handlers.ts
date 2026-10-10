// Per-handler Deal / TermsVersion route logic.
//
// Background: each endpoint-specific flow lives in its own exported
// factory so the router file stays small. The handlers reuse the
// thin shared primitives in `deal-terms-route-helpers.ts` (session
// resolution, body parsing, validation, error translation,
// response-schema validation). Endpoint-specific control flow lives
// in each handler body.
//
// Routes (all under /api/deals):
//
//   POST /api/deals/:dealId/terms-draft
//     Body: { actingWorkspaceId }. Server invokes the AI boundary
//     (deterministic fallback in BG5) and persists an immutable
//     TermsVersion. The Deal must be Negotiating; the acting user
//     must be a current member of one of the Deal's buyer or seller
//     Workspaces. AI drafting never implies approval — the
//     persisted row carries `aiDraftedUnapprovedBadge: true` so the
//     UI cannot silently drop the badge.
//
//   POST /api/deals/:dealId/approvals
//     Body: { actingWorkspaceId, termsVersionId }. The Deal must be
//     Negotiating; the acting user must be a current member of the
//     acting Workspace + must hold an explicit DealApprover
//     authorization for that Workspace; the termsVersionId must
//     equal the Deal's CURRENT TermsVersion (MAX(version)). The
//     persisted row binds Workspace, human actor, explicit
//     DealApprover authorization, exact TermsVersion, and timestamp.
//
//   GET /api/deals/:dealId?actingWorkspaceId=...
//     Returns the Deal view (Deal + currentTermsVersion +
//     currentApprovals). The route revalidates current membership
//     against the Deal's buyer/seller Workspace before returning the
//     view.

import type { Request, Response } from "express";
import {
  bg5ApproveTermsRequestV1Schema,
  bg5ApproveTermsResponseV1Schema,
  bg5DraftTermsRequestV1Schema,
  bg5DraftTermsResponseV1Schema,
  bg5GetDealRequestV1Schema,
  bg5GetDealResponseV1Schema,
} from "@soundhub/types";
import {
  resolveSessionForDealTerms,
  readDealTermsJsonBody,
  readDealTermsPathParam,
  readDealTermsQueryParam,
  validateDealTermsBody,
  validateDealTermsResponse,
  translateDealTermsServiceError,
  writeDealTermsInternalError,
} from "./deal-terms-route-helpers.js";
import type { DealTermsService } from "../deal-terms/deal-terms.service.js";

export interface DealTermsRouteDeps {
  readonly authenticationService: {
    resolveSession(id: string | undefined): Promise<unknown>;
  };
  readonly dealTermsService: DealTermsService;
}

export function createDealTermsRouter(deps: DealTermsRouteDeps) {
  return async (req: Request, res: Response, next: (err?: unknown) => void): Promise<void> => {
    const sessionResult = await resolveSessionForDealTerms(
      req,
      res,
      deps.authenticationService,
      "manage deal terms",
    );
    if (!sessionResult) return;
    const { session, requestId } = sessionResult;

    const dealId = readDealTermsPathParam(res, req, "dealId", requestId);
    if (!dealId) return;

    // The actingWorkspaceId comes from the body for write endpoints
    // and from the query string for the read endpoint. We dispatch
    // based on the URL path so the router stays minimal.
    const path = req.path.replace(/\/$/, "");
    if (path.endsWith("/terms-draft") && req.method === "POST") {
      return draftTerms(deps)(req, res, session.userAccountId, dealId, requestId);
    }
    if (path.endsWith("/approvals") && req.method === "POST") {
      return approveTerms(deps)(req, res, session.userAccountId, dealId, requestId);
    }
    if (req.method === "GET") {
      return getDeal(deps)(req, res, session.userAccountId, dealId, requestId);
    }
    // Fallback: no matching endpoint. Surface 404 through the safe
    // envelope.
    writeDealTermsInternalError(res, new Error("not found"), requestId, "routing deal terms");
    void next;
  };
}

// ---------- handler factories ----------

function draftTerms(
  deps: DealTermsRouteDeps,
): (
  req: Request,
  res: Response,
  userAccountId: string,
  dealId: string,
  requestId: string,
) => Promise<void> {
  return async (req, res, userAccountId, dealId, requestId) => {
    const rawBody = await readDealTermsJsonBody(req, res, requestId);
    if (rawBody === null) return;

    const parsed = validateDealTermsBody(
      res,
      bg5DraftTermsRequestV1Schema,
      rawBody,
      requestId,
      "Terms draft request",
    );
    if (parsed === null) return;

    try {
      const result = await deps.dealTermsService.draftTerms({
        userAccountId,
        actingWorkspaceId: parsed.actingWorkspaceId,
        dealId,
      });
      validateDealTermsResponse(
        res,
        201,
        bg5DraftTermsResponseV1Schema,
        { ok: true, termsVersion: result.termsVersion },
        requestId,
        "draft",
      );
    } catch (err) {
      if (translateDealTermsServiceError(res, err, requestId)) return;
      writeDealTermsInternalError(res, err, requestId, "drafting terms");
    }
  };
}

function approveTerms(
  deps: DealTermsRouteDeps,
): (
  req: Request,
  res: Response,
  userAccountId: string,
  dealId: string,
  requestId: string,
) => Promise<void> {
  return async (req, res, userAccountId, dealId, requestId) => {
    const rawBody = await readDealTermsJsonBody(req, res, requestId);
    if (rawBody === null) return;

    const parsed = validateDealTermsBody(
      res,
      bg5ApproveTermsRequestV1Schema,
      rawBody,
      requestId,
      "Approval request",
    );
    if (parsed === null) return;

    try {
      const result = await deps.dealTermsService.approveTerms({
        userAccountId,
        actingWorkspaceId: parsed.actingWorkspaceId,
        dealId,
        termsVersionId: parsed.termsVersionId,
      });
      validateDealTermsResponse(
        res,
        201,
        bg5ApproveTermsResponseV1Schema,
        { ok: true, approval: result.approval },
        requestId,
        "approve",
      );
    } catch (err) {
      if (translateDealTermsServiceError(res, err, requestId)) return;
      writeDealTermsInternalError(res, err, requestId, "approving terms");
    }
  };
}

function getDeal(
  deps: DealTermsRouteDeps,
): (
  req: Request,
  res: Response,
  userAccountId: string,
  dealId: string,
  requestId: string,
) => Promise<void> {
  return async (req, res, userAccountId, dealId, requestId) => {
    const actingWorkspaceId = readDealTermsQueryParam(res, req, "actingWorkspaceId", requestId);
    if (!actingWorkspaceId) return;

    // Re-validate the body-shaped query against the shared schema so
    // the contract is the single source of truth for the field name.
    const parsed = validateDealTermsBody(
      res,
      bg5GetDealRequestV1Schema,
      { actingWorkspaceId },
      requestId,
      "Deal view request",
    );
    if (parsed === null) return;

    try {
      const result = await deps.dealTermsService.getDeal({
        userAccountId,
        actingWorkspaceId: parsed.actingWorkspaceId,
        dealId,
      });
      validateDealTermsResponse(
        res,
        200,
        bg5GetDealResponseV1Schema,
        {
          deal: {
            deal: result.deal,
            currentTermsVersion: result.currentTermsVersion,
            currentApprovals: result.currentApprovals,
            sellerConsent: result.sellerConsent,
            // M2 (#88) Codex finding: pass the derived
            // acting-side authorization signal through the
            // strict Zod schema so the public envelope stays
            // a 1:1 mirror of the contract.
            actingSideHasDealApprover: result.actingSideHasDealApprover,
          },
        },
        requestId,
        "view",
      );
    } catch (err) {
      if (translateDealTermsServiceError(res, err, requestId)) return;
      writeDealTermsInternalError(res, err, requestId, "fetching the Deal view");
    }
  };
}
