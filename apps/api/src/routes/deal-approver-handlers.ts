// Per-handler DealApprover route logic (M2 #88).
//
// Background: ticket #88 requires a single new endpoint
// `POST /api/deal-approvers` that provisions a `DealApprover`
// authorization for the acting Personal-Workspace human. The
// endpoint accepts the closed confirmation version +
// idempotencyKey + actingWorkspaceId, revalidates current
// membership against the exact acting Workspace, and returns the
// bounded `dealApprover` public DTO. The route reuses the safe
// error envelope so no private audit identifiers cross the
// boundary.

import type { Request, Response } from "express";
import {
  resolveSessionForDealApprover,
  readJsonBodyForDealApprover,
  validateDealApproverBody,
  validateDealApproverResponse,
  translateDealApproverServiceError,
  writeDealApproverInternalError,
  provisionDealApproverRequestV1Schema,
  provisionDealApproverResponseV1Schema,
} from "./deal-approver-route-helpers.js";
import type { DealApproverService } from "../deal-approver/deal-approver.service.js";

export interface DealApproverRouteDeps {
  readonly authenticationService: {
    resolveSession(id: string | undefined): Promise<unknown>;
  };
  readonly dealApproverService: DealApproverService;
  readonly generateRequestId: () => string;
}

export function createProvisionDealApproverHandler(deps: DealApproverRouteDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    const sessionResult = await resolveSessionForDealApprover(
      req,
      res,
      deps.authenticationService,
      "provision DealApprover authorization",
    );
    if (!sessionResult) return;
    const { session, requestId } = sessionResult;

    const rawBody = await readJsonBodyForDealApprover(req, res, requestId);
    if (rawBody === null) return;

    const parsed = validateDealApproverBody(
      res,
      provisionDealApproverRequestV1Schema,
      rawBody,
      requestId,
      "DealApprover provisioning",
    );
    if (parsed === null) return;

    try {
      const result = await deps.dealApproverService.provisionDealApprover({
        userAccountId: session.userAccountId,
        actingWorkspaceId: parsed.actingWorkspaceId,
        confirmationVersion: parsed.confirmationVersion,
        idempotencyKey: parsed.idempotencyKey,
        requestId,
      });
      validateDealApproverResponse(
        res,
        201,
        provisionDealApproverResponseV1Schema,
        { ok: true, dealApprover: result.dealApprover },
        requestId,
        "provision",
      );
    } catch (err) {
      if (translateDealApproverServiceError(res, err, requestId)) return;
      writeDealApproverInternalError(
        res,
        err,
        requestId,
        "provisioning the DealApprover authorization",
      );
    }
  };
}
