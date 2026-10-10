// Shared route helpers for the DealApprover router (M2 #88).
//
// Background: ticket #88 requires a single new endpoint
// `POST /api/deal-approvers` that provisions a `DealApprover`
// authorization for the acting Personal-Workspace human. The
// route layer delegates the request body + session + error
// translation to the same primitives used by the existing
// /api/project-requests and /api/deals routers.
//
// The shape mirrors the existing project-request / deal-terms route
// helpers so the route handler stays small and the safe envelope
// remains the single source of truth for the response contract.

import type { Request, Response } from "express";
import type { ZodError, ZodSchema } from "zod";
import {
  buildFieldErrors,
  buildSafeError,
  generateRequestId,
  writeSafeError,
  type SafeErrorResponse,
} from "../lib/errors.js";
import { SESSION_COOKIE } from "../lib/session-cookie.js";
import { DealApproverError } from "../deal-approver/deal-approver.service.js";
import type { ProvisionDealApproverRequestV1 } from "@soundhub/types";
import {
  provisionDealApproverRequestV1Schema,
  provisionDealApproverResponseV1Schema,
} from "@soundhub/types";

const MAX_REQUEST_BODY_BYTES = 16 * 1024;

export function generateDealApproverRequestId(req: Request): string {
  const incoming = req.headers["x-request-id"];
  if (typeof incoming === "string" && incoming.length > 0 && incoming.length <= 128) {
    return incoming;
  }
  return generateRequestId();
}

export async function readJsonBodyForDealApprover(
  req: Request,
  res: Response,
  requestId: string,
): Promise<unknown> {
  if (req.body !== undefined && req.body !== null) {
    return req.body;
  }
  // Express's json parser has a default 100 KB cap; we surface
  // our own tighter 16 KB envelope to keep the public surface
  // consistent with the project-request / deal-terms helpers.
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const bufferChunk = chunk as Buffer;
    totalBytes += bufferChunk.length;
    if (totalBytes > MAX_REQUEST_BODY_BYTES) {
      writeSafeError(
        res,
        buildSafeError("DEAL_APPROVER_INVALID", "Request body too large.", undefined, requestId),
      );
      return null;
    }
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    writeSafeError(
      res,
      buildSafeError(
        "DEAL_APPROVER_INVALID",
        "Request body is not valid JSON.",
        undefined,
        requestId,
      ),
    );
    return null;
  }
}

export function validateDealApproverBody<T>(
  res: Response,
  schema: ZodSchema<T>,
  raw: unknown,
  requestId: string,
  contextLabel: string,
): T | null {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const zodError = parsed.error as ZodError;
    // M2 (#88) Codex finding: a stale or unknown
    // `confirmationVersion` is a typed 422
    // (`DEAL_APPROVER_CONFIRMATION_VERSION_MISMATCH`), NOT a
    // generic 400. Clients must be able to distinguish an
    // outdated attestation from a malformed request so the
    // customer can re-read the current version. The application
    // boundary keeps the closed canonical version in one place
    // (the shared Zod `literal(...)`); a non-literal value is
    // the only reason the Zod path emits a typed mismatch here.
    const confirmationVersionIssue = zodError.issues.find(
      (issue) => issue.path[0] === "confirmationVersion",
    );
    if (confirmationVersionIssue !== undefined) {
      writeSafeError(
        res,
        buildSafeError(
          "DEAL_APPROVER_CONFIRMATION_VERSION_MISMATCH",
          "The current version of the approval-authority attestation has changed. Please reload and try again.",
          undefined,
          requestId,
        ),
      );
      return null;
    }
    writeSafeError(
      res,
      buildSafeError(
        "DEAL_APPROVER_INVALID",
        `The request body for ${contextLabel} failed validation.`,
        buildFieldErrors(zodError.issues),
        requestId,
      ),
    );
    return null;
  }
  return parsed.data;
}

export function validateDealApproverResponse<T>(
  res: Response,
  status: number,
  schema: ZodSchema<T>,
  payload: unknown,
  requestId: string,
  contextLabel: string,
): boolean {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    console.error(
      `[deal-approver] requestId=${requestId} ${contextLabel} response-schema-drift:`,
      parsed.error,
    );
    writeSafeError(
      res,
      buildSafeError(
        "DEAL_APPROVER_INTERNAL_FAILED",
        "An internal error occurred.",
        undefined,
        requestId,
      ),
    );
    return false;
  }
  res.status(status).json(parsed.data);
  return true;
}

export function translateDealApproverServiceError(
  res: Response,
  err: unknown,
  requestId: string,
): boolean {
  if (err instanceof DealApproverError) {
    const safe: SafeErrorResponse = buildSafeError(err.code, err.message, undefined, requestId);
    console.error(`[deal-approver] requestId=${requestId} code=${err.code}:`, err);
    writeSafeError(res, safe);
    return true;
  }
  return false;
}

export function writeDealApproverInternalError(
  res: Response,
  err: unknown,
  requestId: string,
  contextLabel: string,
): void {
  console.error(`[deal-approver] requestId=${requestId} ${contextLabel} unhandled:`, err);
  writeSafeError(
    res,
    buildSafeError(
      "DEAL_APPROVER_INTERNAL_FAILED",
      `An unexpected error occurred while ${contextLabel}.`,
      undefined,
      requestId,
    ),
  );
}

export interface DealApproverRouteSessionResult {
  readonly session: { readonly userAccountId: string };
  readonly requestId: string;
}

export interface DealApproverAuthenticationService {
  resolveSession(id: string | undefined): Promise<unknown>;
}

export async function resolveSessionForDealApprover(
  req: Request,
  res: Response,
  authenticationService: DealApproverAuthenticationService,
  contextLabel: string,
): Promise<DealApproverRouteSessionResult | null> {
  const requestId = generateDealApproverRequestId(req);
  const cookieHeader = req.headers.cookie;
  let sessionId: string | undefined;
  if (typeof cookieHeader === "string") {
    for (const part of cookieHeader.split(";")) {
      const [k, ...rest] = part.trim().split("=");
      if (k === SESSION_COOKIE) {
        sessionId = rest.join("=");
        break;
      }
    }
  }
  let resolved: unknown;
  try {
    resolved = await authenticationService.resolveSession(sessionId);
  } catch (err) {
    console.error(
      `[deal-approver] requestId=${requestId} ${contextLabel} session-resolve-failed:`,
      err,
    );
    writeSafeError(
      res,
      buildSafeError("SESSION_INVALID", "You are not signed in.", undefined, requestId),
    );
    return null;
  }
  const session = resolved as { userAccountId?: string } | null;
  if (!session || typeof session.userAccountId !== "string") {
    writeSafeError(
      res,
      buildSafeError("SESSION_INVALID", "You are not signed in.", undefined, requestId),
    );
    return null;
  }
  return { session: { userAccountId: session.userAccountId }, requestId };
}

export type { ProvisionDealApproverRequestV1 };
export { provisionDealApproverRequestV1Schema, provisionDealApproverResponseV1Schema };
