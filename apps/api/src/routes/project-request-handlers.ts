// Per-handler ProjectRequest route logic.
//
// Background: each endpoint-specific flow lives in its own exported
// factory so the router file stays small. The handlers reuse the
// shared primitives in `project-request-route-helpers.ts`
// (session resolution, body parsing, validation, error translation,
// response-schema validation). P2-001 collapsed the duplicated
// pipeline into those helpers; this file keeps the
// endpoint-specific control flow (the path-param parse, the body
// shape, and the service call) local to each handler.

import type { Request, Response } from "express";
import {
  acceptProjectRequestResponseV1Schema,
  createProjectRequestRequestV1Schema,
  createProjectRequestResponseV1Schema,
  declineProjectRequestResponseV1Schema,
  getProjectRequestResponseV1Schema,
  listProjectRequestsResponseV1Schema,
  respondProjectRequestRequestV1Schema,
  projectRequestStatusValuesV1,
} from "@soundhub/types";
import {
  resolveSessionForProjectRequest,
  readJsonBodyForProjectRequest,
  readPathParamForProjectRequest,
  readActingWorkspaceIdFromQuery,
  validateProjectRequestBody,
  validateProjectRequestResponse,
  translateProjectRequestServiceError,
  writeProjectRequestInternalError,
  writeProjectRequestQueryError,
} from "./project-request-route-helpers.js";
import type { ProjectRequestRouteDeps } from "./project-requests.js";

export function createProjectRequest(deps: ProjectRequestRouteDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    const sessionResult = await resolveSessionForProjectRequest(
      req,
      res,
      deps.authenticationService,
      "create a ProjectRequest",
    );
    if (!sessionResult) return;
    const { session, requestId } = sessionResult;

    const rawBody = await readJsonBodyForProjectRequest(req, res, requestId);
    if (rawBody === null) return;

    const parsed = validateProjectRequestBody(
      res,
      createProjectRequestRequestV1Schema,
      rawBody,
      requestId,
      "ProjectRequest creation",
    );
    if (parsed === null) return;

    try {
      const result = await deps.projectRequestService.createProjectRequest({
        userAccountId: session.userAccountId,
        actingWorkspaceId: parsed.actingWorkspaceId,
        projectBriefId: parsed.projectBriefId,
        serviceOfferingId: parsed.serviceOfferingId,
      });
      validateProjectRequestResponse(
        res,
        201,
        createProjectRequestResponseV1Schema,
        { ok: true, projectRequest: result.projectRequest },
        requestId,
        "create",
      );
    } catch (err) {
      if (translateProjectRequestServiceError(res, err, requestId)) return;
      writeProjectRequestInternalError(res, err, requestId, "creating the ProjectRequest");
    }
  };
}

export function getProjectRequest(deps: ProjectRequestRouteDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    const sessionResult = await resolveSessionForProjectRequest(
      req,
      res,
      deps.authenticationService,
      "fetch a ProjectRequest",
    );
    if (!sessionResult) return;
    const { session, requestId } = sessionResult;

    const projectRequestId = readPathParamForProjectRequest(
      res,
      req,
      "projectRequestId",
      requestId,
    );
    if (!projectRequestId) return;

    const actingWorkspaceId = readActingWorkspaceIdFromQuery(res, req, requestId);
    if (!actingWorkspaceId) return;

    try {
      const result = await deps.projectRequestService.getProjectRequest({
        userAccountId: session.userAccountId,
        actingWorkspaceId,
        projectRequestId,
      });
      validateProjectRequestResponse(
        res,
        200,
        getProjectRequestResponseV1Schema,
        { projectRequest: result.projectRequest },
        requestId,
        "get",
      );
    } catch (err) {
      if (translateProjectRequestServiceError(res, err, requestId)) return;
      writeProjectRequestInternalError(res, err, requestId, "fetching the ProjectRequest");
    }
  };
}

export function listProjectRequests(deps: ProjectRequestRouteDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    const sessionResult = await resolveSessionForProjectRequest(
      req,
      res,
      deps.authenticationService,
      "list ProjectRequests",
    );
    if (!sessionResult) return;
    const { session, requestId } = sessionResult;

    const actingWorkspaceId = readActingWorkspaceIdFromQuery(res, req, requestId);
    if (!actingWorkspaceId) return;

    // The shared request schema (`listProjectRequestsRequestV1Schema`)
    // is the authoritative source for the filter field name; reading
    // `req.query["status"]` here would silently accept a request the
    // contract does not document. The schema declares the field as
    // `statusFilter`, so the handler matches it. We deliberately do
    // NOT also accept the legacy `status` name — supporting both
    // would let old clients bypass the contract and keep an
    // undocumented query parameter alive past the BG4 cut.
    const statusFilterRaw = req.query["statusFilter"];
    let statusFilter: "Pending" | "Accepted" | "Declined" | undefined;
    if (typeof statusFilterRaw === "string" && statusFilterRaw.length > 0) {
      if (!(projectRequestStatusValuesV1 as readonly string[]).includes(statusFilterRaw)) {
        writeProjectRequestQueryError(res, requestId, "statusFilter is invalid.");
        return;
      }
      statusFilter = statusFilterRaw as "Pending" | "Accepted" | "Declined";
    }

    try {
      const result = await deps.projectRequestService.listProjectRequests({
        userAccountId: session.userAccountId,
        actingWorkspaceId,
        ...(statusFilter ? { statusFilter } : {}),
      });
      validateProjectRequestResponse(
        res,
        200,
        listProjectRequestsResponseV1Schema,
        { projectRequests: result.projectRequests },
        requestId,
        "list",
      );
    } catch (err) {
      if (translateProjectRequestServiceError(res, err, requestId)) return;
      writeProjectRequestInternalError(res, err, requestId, "listing ProjectRequests");
    }
  };
}

export function acceptProjectRequest(deps: ProjectRequestRouteDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    const sessionResult = await resolveSessionForProjectRequest(
      req,
      res,
      deps.authenticationService,
      "accept a ProjectRequest",
    );
    if (!sessionResult) return;
    const { session, requestId } = sessionResult;

    const projectRequestId = readPathParamForProjectRequest(
      res,
      req,
      "projectRequestId",
      requestId,
    );
    if (!projectRequestId) return;

    const rawBody = await readJsonBodyForProjectRequest(req, res, requestId);
    if (rawBody === null) return;

    const parsed = validateProjectRequestBody(
      res,
      respondProjectRequestRequestV1Schema,
      rawBody,
      requestId,
      "Accept request",
    );
    if (parsed === null) return;

    try {
      const result = await deps.projectRequestService.acceptProjectRequest({
        userAccountId: session.userAccountId,
        actingWorkspaceId: parsed.actingWorkspaceId,
        projectRequestId,
      });
      validateProjectRequestResponse(
        res,
        200,
        acceptProjectRequestResponseV1Schema,
        {
          ok: true,
          projectRequest: result.projectRequest,
          deal: result.deal,
          initialTermsVersion: result.initialTermsVersion,
        },
        requestId,
        "accept",
      );
    } catch (err) {
      if (translateProjectRequestServiceError(res, err, requestId)) return;
      writeProjectRequestInternalError(res, err, requestId, "accepting the ProjectRequest");
    }
  };
}

export function declineProjectRequest(deps: ProjectRequestRouteDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    const sessionResult = await resolveSessionForProjectRequest(
      req,
      res,
      deps.authenticationService,
      "decline a ProjectRequest",
    );
    if (!sessionResult) return;
    const { session, requestId } = sessionResult;

    const projectRequestId = readPathParamForProjectRequest(
      res,
      req,
      "projectRequestId",
      requestId,
    );
    if (!projectRequestId) return;

    const rawBody = await readJsonBodyForProjectRequest(req, res, requestId);
    if (rawBody === null) return;

    const parsed = validateProjectRequestBody(
      res,
      respondProjectRequestRequestV1Schema,
      rawBody,
      requestId,
      "Decline request",
    );
    if (parsed === null) return;

    try {
      const result = await deps.projectRequestService.declineProjectRequest({
        userAccountId: session.userAccountId,
        actingWorkspaceId: parsed.actingWorkspaceId,
        projectRequestId,
      });
      validateProjectRequestResponse(
        res,
        200,
        declineProjectRequestResponseV1Schema,
        { ok: true, projectRequest: result.projectRequest },
        requestId,
        "decline",
      );
    } catch (err) {
      if (translateProjectRequestServiceError(res, err, requestId)) return;
      writeProjectRequestInternalError(res, err, requestId, "declining the ProjectRequest");
    }
  };
}

// Re-export for tests that want to assert error codes verbatim.
export type { ProjectRequestRouteDeps };
