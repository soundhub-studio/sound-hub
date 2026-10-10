// Matchmaker routes (BG3).
//
// Background: BG3 requires an authenticated, Workspace-authorized
// route that accepts a natural-language ProjectBrief, hands it to
// the AI boundary, persists the resulting criteria + search
// results, and returns the buyer-safe DTO. The route follows the
// same patterns as the BG1 auth routes:
//
//   - Express owns untrusted JSON parsing and the safe error
//     envelope.
//   - The application service owns authorization and state
//     transitions; the route never reads Workspace.ownerUserId.
//   - The route revalidates the authenticated session on every
//     request; a stale cookie fails closed.
//
// Routes:
//
//   POST /api/matchmaker/brief
//     Body: { actingWorkspaceId, briefText, nonSearchRequirements? }.
//     Response: { ok: true, brief, recommendations, totalResults,
//     strategy, fallbackNotice? }. The route does not introduce
//     a second search path; it forwards the request to the
//     Matchmaker service which invokes the existing
//     TalentSearchService.
//
//   GET /api/matchmaker/brief/:briefId
//     Response: { brief }. The route revalidates the buyer's
//     current WorkspaceMembership on every read.

import { Router, type NextFunction, type Request, type Response } from "express";
import {
  briefResponseV1Schema,
  submitBriefRequestV1Schema,
  submitBriefResponseV1Schema,
  type ApiErrorCodeV1,
} from "@soundhub/types";
import { ZodError } from "zod";
import {
  buildFieldErrors,
  buildSafeError,
  generateRequestId,
  writeSafeError,
  type SafeErrorResponse,
} from "../lib/errors.js";
import { SESSION_COOKIE } from "../lib/session-cookie.js";
import type { AuthenticationService } from "../services/authentication.service.js";
import { AuthorizationError } from "../services/workspace-authorization.service.js";
import { MatchmakerError, type MatchmakerService } from "../services/matchmaker.service.js";

export interface MatchmakerRouteDeps {
  readonly authenticationService: AuthenticationService;
  readonly matchmakerService: MatchmakerService;
}

const MAX_REQUEST_BODY_BYTES = 16 * 1024;

export function createMatchmakerRouter(deps: MatchmakerRouteDeps): Router {
  const router = Router();

  router.post("/brief", (req, res, next) => {
    handleSubmitBrief(req, res, deps).catch((err) =>
      forwardUnhandledRejection(req, res, next, err),
    );
  });
  router.get("/brief/:briefId", (req, res, next) => {
    handleGetBrief(req, res, deps).catch((err) => forwardUnhandledRejection(req, res, next, err));
  });

  return router;
}

function forwardUnhandledRejection(
  req: Request,
  res: Response,
  next: NextFunction,
  err: unknown,
): void {
  if (res.headersSent) {
    console.error(
      `[matchmaker] requestId=${resolveRequestId(req)} handler-rejection-after-write:`,
      err,
    );
    return;
  }
  next(err);
}

// ---------- POST /api/matchmaker/brief ----------

async function handleSubmitBrief(
  req: Request,
  res: Response,
  deps: MatchmakerRouteDeps,
): Promise<void> {
  const requestId = resolveRequestId(req);
  res.setHeader("x-request-id", requestId);

  const sessionId = readSessionCookie(req);
  const session = await deps.authenticationService.resolveSession(sessionId);
  if (!session) {
    writeSafeError(
      res,
      buildSafeError(
        "SESSION_INVALID",
        "Sign in is required to submit a ProjectBrief.",
        undefined,
        requestId,
      ),
    );
    return;
  }

  const rawBody = await readJsonBodyOrRespond(req, res, requestId);
  if (rawBody === undefined) return;

  let parsed;
  try {
    parsed = submitBriefRequestV1Schema.parse(rawBody);
  } catch (err) {
    if (err instanceof ZodError) {
      writeSafeError(
        res,
        buildSafeError(
          "MATCHMAKER_INVALID_REQUEST",
          "ProjectBrief submission failed schema validation.",
          buildFieldErrors(err.issues),
          requestId,
        ),
      );
      return;
    }
    throw err;
  }

  let result;
  try {
    result = await deps.matchmakerService.submitBrief({
      userAccountId: session.userAccountId,
      actingWorkspaceId: parsed.actingWorkspaceId,
      briefText: parsed.briefText,
      // M2 (#87) Finding 8: optional buyer-supplied required +
      // preferred criteria. The route passes them through; the
      // service merges them over the AI-derived criteria (buyer's
      // required wins over AI's required; buyer's preferred wins
      // over AI's preferred; AI's `query` axis is preserved).
      buyerRequired: parsed.required,
      buyerPreferred: parsed.preferred,
      buyerNonSearchRequirements: parsed.nonSearchRequirements,
    });
  } catch (err) {
    if (err instanceof MatchmakerError) {
      writeMatchmakerError(res, err, requestId);
      return;
    }
    if (err instanceof AuthorizationError) {
      // Map the authorization rejection to the documented 403 envelope
      // (routes/auth.ts:297 does the same). The application service
      // throws AuthorizationError with NOT_A_MEMBER /
      // MISSING_CAPABILITY / WORKSPACE_INELIGIBLE codes; we project
      // them onto the BG3 BRIEF_FORBIDDEN code so the safe envelope
      // carries a 403 status (see errors.ts mapStatus).
      writeSafeError(res, buildSafeError("BRIEF_FORBIDDEN", err.message, undefined, requestId));
      return;
    }
    console.error(`[matchmaker] requestId=${requestId} unhandled:`, err);
    writeSafeError(
      res,
      buildSafeError(
        "MATCHMAKER_FAILED",
        "An unexpected error occurred while processing the ProjectBrief.",
        undefined,
        requestId,
      ),
    );
    return;
  }

  const validated = submitBriefResponseV1Schema.safeParse({
    ok: true,
    brief: result.brief,
    recommendations: result.recommendations,
    totalResults: result.totalResults,
    strategy: result.strategy,
    ...(result.fallbackNotice ? { fallbackNotice: result.fallbackNotice } : {}),
  });
  if (!validated.success) {
    console.error(`[matchmaker] requestId=${requestId} response-schema-drift:`, validated.error);
    writeSafeError(
      res,
      buildSafeError(
        "MATCHMAKER_FAILED",
        "An unexpected error occurred while preparing the response.",
        undefined,
        requestId,
      ),
    );
    return;
  }
  res.status(200).json(validated.data);
}

// ---------- GET /api/matchmaker/brief/:briefId ----------

async function handleGetBrief(
  req: Request,
  res: Response,
  deps: MatchmakerRouteDeps,
): Promise<void> {
  const requestId = resolveRequestId(req);
  res.setHeader("x-request-id", requestId);

  const sessionId = readSessionCookie(req);
  const session = await deps.authenticationService.resolveSession(sessionId);
  if (!session) {
    writeSafeError(
      res,
      buildSafeError(
        "SESSION_INVALID",
        "Sign in is required to fetch a ProjectBrief.",
        undefined,
        requestId,
      ),
    );
    return;
  }

  const briefId = req.params.briefId;
  if (typeof briefId !== "string" || briefId.length === 0 || briefId.length > 128) {
    writeSafeError(
      res,
      buildSafeError(
        "MATCHMAKER_INVALID_REQUEST",
        "ProjectBrief id is missing or malformed.",
        undefined,
        requestId,
      ),
    );
    return;
  }

  let result;
  try {
    result = await deps.matchmakerService.getBrief({
      userAccountId: session.userAccountId,
      briefId,
    });
  } catch (err) {
    if (err instanceof MatchmakerError) {
      writeMatchmakerError(res, err, requestId);
      return;
    }
    if (err instanceof AuthorizationError) {
      writeSafeError(res, buildSafeError("BRIEF_FORBIDDEN", err.message, undefined, requestId));
      return;
    }
    console.error(`[matchmaker] requestId=${requestId} unhandled:`, err);
    writeSafeError(
      res,
      buildSafeError(
        "MATCHMAKER_FAILED",
        "An unexpected error occurred while fetching the ProjectBrief.",
        undefined,
        requestId,
      ),
    );
    return;
  }

  const validated = briefResponseV1Schema.safeParse({
    brief: result.brief,
  });
  if (!validated.success) {
    console.error(
      `[matchmaker] requestId=${requestId} get-response-schema-drift:`,
      validated.error,
    );
    writeSafeError(
      res,
      buildSafeError(
        "MATCHMAKER_FAILED",
        "An unexpected error occurred while preparing the response.",
        undefined,
        requestId,
      ),
    );
    return;
  }
  res.status(200).json(validated.data);
}

// ---------- Helpers ----------

function resolveRequestId(req: Request): string {
  const incoming = req.headers["x-request-id"];
  if (typeof incoming === "string" && incoming.length > 0 && incoming.length <= 128) {
    return incoming;
  }
  return generateRequestId();
}

function readSessionCookie(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (typeof header !== "string" || header.length === 0) return undefined;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${SESSION_COOKIE}=`)) {
      const raw = trimmed.slice(SESSION_COOKIE.length + 1);
      try {
        return decodeURIComponent(raw);
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

async function readJsonBody(req: Request, res: Response, requestId: string): Promise<unknown> {
  // When the body has already been parsed by an upstream middleware
  // (e.g. express.json in tests), reuse it instead of re-reading the
  // stream. Reading again would hang because the stream has already
  // been consumed.
  const existing: unknown = req.body;
  if (existing !== undefined && existing !== null) return existing;

  const chunks: Buffer[] = [];
  let total = 0;
  const limit = MAX_REQUEST_BODY_BYTES;
  try {
    await new Promise<void>((resolve, reject) => {
      req.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > limit) {
          req.pause();
          writeSafeError(
            res,
            buildSafeError(
              "MATCHMAKER_INVALID_REQUEST",
              `Request body exceeds the ${limit}-byte limit.`,
              undefined,
              requestId,
            ),
          );
          reject(new BodyReadError("payload-too-large"));
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve());
      req.on("error", (err: Error) => reject(err));
    });
  } catch (err) {
    if (err instanceof Error && err.message === "payload-too-large") {
      throw new BodyReadError("payload-too-large");
    }
    throw err;
  }
  if (res.writableEnded) {
    throw new BodyReadError("response-already-ended");
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    writeSafeError(
      res,
      buildSafeError(
        "MATCHMAKER_INVALID_REQUEST",
        "Request body is not valid JSON.",
        undefined,
        requestId,
      ),
    );
    throw new BodyReadError("invalid-json");
  }
}

class BodyReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BodyReadError";
  }
}

async function readJsonBodyOrRespond(
  req: Request,
  res: Response,
  requestId: string,
): Promise<unknown> {
  try {
    return await readJsonBody(req, res, requestId);
  } catch (err) {
    if (err instanceof BodyReadError) {
      return undefined;
    }
    throw err;
  }
}

function writeMatchmakerError(res: Response, err: MatchmakerError, requestId: string): void {
  const safe: SafeErrorResponse = buildSafeError(err.code, err.message, undefined, requestId);
  console.error(`[matchmaker] requestId=${requestId} code=${err.code}:`, err);
  writeSafeError(res, safe);
}

// Re-export for tests that want to assert error codes verbatim.
export type MatchmakerApiErrorCode = ApiErrorCodeV1;
