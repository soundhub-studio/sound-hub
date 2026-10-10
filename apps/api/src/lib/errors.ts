// Standard safe error envelope for the v1 search contract.
//
// The API surface uses the shared Zod schema `apiErrorResponseV1Schema` from
// @soundhub/types. This module produces the response body and HTTP status and
// centralises the request-ID generation that flows through the
// response headers. Internal exception text never enters the response.

import { randomUUID } from "node:crypto";
import type { Response } from "express";
import {
  apiErrorResponseV1Schema,
  type ApiErrorCodeV1,
  type ApiErrorResponseV1,
  type ApiFieldErrorV1,
} from "@soundhub/types";

export const REQUEST_ID_HEADER = "x-request-id";

export interface SafeErrorResponse {
  readonly status: number;
  readonly body: ApiErrorResponseV1;
}

export function buildFieldErrors(
  issues: ReadonlyArray<{ path: readonly (string | number)[]; code: string; message: string }>,
): readonly ApiFieldErrorV1[] {
  return issues.map((issue) => ({
    path: issue.path.length === 0 ? "<root>" : issue.path.join("."),
    code: issue.code,
    message: issue.message,
  }));
}

export function buildSafeError(
  code: ApiErrorCodeV1,
  message: string,
  fields: readonly ApiFieldErrorV1[] | undefined,
  requestId: string,
): SafeErrorResponse {
  const body: ApiErrorResponseV1 = {
    error: {
      code,
      message,
      ...(fields ? { fields: [...fields] } : {}),
      requestId,
    },
  };
  const status = mapStatus(code);
  return { status, body };
}

export function mapStatus(code: ApiErrorCodeV1): number {
  switch (code) {
    case "INVALID_JSON":
    case "INVALID_SEARCH_CRITERIA":
    case "INVALID_AUTH_REQUEST":
    case "MATCHMAKER_INVALID_REQUEST":
      return 400;
    case "UNSUPPORTED_MEDIA_TYPE":
      return 415;
    case "SEARCH_RATE_LIMITED":
    case "AUTH_RATE_LIMITED":
      return 429;
    case "SEARCH_FAILED":
    case "AUTH_FAILED":
    case "MATCHMAKER_FAILED":
      return 500;
    case "SEARCH_UNAVAILABLE":
    case "AUTH_PROVIDER_UNAVAILABLE":
    case "MATCHMAKER_AI_UNAVAILABLE":
      return 503;
    // GS 4 / GS 5 authorization rejections. The standard safe envelope
    // does not include 401/403 by default, so we map the new
    // authorization codes to status codes that respect the spirit of
    // those HTTP semantics while preserving the shared envelope
    // contract (every error response carries the same shape).
    case "SESSION_INVALID":
    case "SESSION_EXPIRED":
      return 401;
    case "WORKSPACE_NOT_FOUND":
    case "BRIEF_NOT_FOUND":
      return 404;
    case "WORKSPACE_INELIGIBLE":
    case "NOT_A_MEMBER":
    case "MISSING_CAPABILITY":
    case "BRIEF_FORBIDDEN":
    case "PROJECT_REQUEST_FORBIDDEN":
    case "PROJECT_REQUEST_BRIEF_FORBIDDEN":
      return 403;
    // Buildathon Golden Slice 2 (BG2) seller-audio rejection
    // surfaces. Each code maps to a stable HTTP status that respects
    // the spirit of the HTTP semantic while preserving the shared
    // envelope contract.
    case "AUDIO_OFFERING_NOT_FOUND":
      return 404;
    case "AUDIO_OFFERING_INELIGIBLE":
      return 403;
    case "AUDIO_SAMPLE_LIMIT_EXCEEDED":
      return 400;
    case "AUDIO_CONTENT_TYPE_UNSUPPORTED":
      return 400;
    // AUDIO_PAYLOAD_MISSING is a malformed-request rejection, not
    // a size-cap rejection. The boundary distinguished the two at
    // the trusted multipart parser; the safe envelope maps them to
    // distinct statuses so a buyer who omitted the file part sees
    // 400 Bad Request, not 413 Payload Too Large.
    case "AUDIO_PAYLOAD_MISSING":
      return 400;
    case "AUDIO_PAYLOAD_TOO_LARGE":
      return 413;
    case "AUDIO_PROVIDER_UNAVAILABLE":
      return 503;
    case "AUDIO_SAMPLE_MEDIA_CONFIRMATION_REQUIRED":
      // M2 (#85) PR-review feedback: the upload boundary requires a
      // closed-version media-use confirmation. A missing or unknown
      // version is a structural omission, not a semantic
      // well-formedness issue — surface as 400.
      return 400;
    case "AUDIO_STORAGE_FAILED":
      return 500;
    case "AUDIO_SAMPLE_NOT_FOUND":
      return 404;
    case "PROJECT_REQUEST_NOT_FOUND":
    case "PROJECT_REQUEST_BRIEF_NOT_FOUND":
      return 404;
    case "PROJECT_REQUEST_INVALID":
      return 400;
    case "PROJECT_REQUEST_OFFERING_INELIGIBLE":
      // The selected offering is ineligible at the revalidation
      // step (stale, suspended, archived, etc.). Surface as 422 to
      // signal the request was well-formed but the chosen resource
      // does not satisfy current eligibility. The safe envelope
      // stays buyer-safe; the offering id is not echoed.
      return 422;
    case "PROJECT_REQUEST_ALREADY_PENDING":
    case "PROJECT_REQUEST_ALREADY_RESPONDED":
      // 409 Conflict. A retry would have produced a duplicate
      // ProjectRequest or a duplicate Deal; the guarded state
      // transition rejected the duplicate. The caller can read the
      // current state via GET /api/project-requests/:id.
      return 409;
    case "PROJECT_REQUEST_UNAVAILABLE":
      // 503 Service Unavailable. The bounded P2034 retry budget was
      // exhausted; the marketplace is briefly unable to authorise
      // the write. The caller can retry the same payload without
      // changing the request.
      return 503;
    case "PROJECT_REQUEST_TERMS_DRAFT_INVALID":
      // M2 (#88): the AI candidate for the initial TermsVersion
      // (persisted atomically alongside the new Deal on accept)
      // failed the strict `bg5ProposedTermsV1Schema` validation.
      // 400 Bad Request — a malformed AI candidate must not produce
      // a Deal. The transaction rolls back with no state change.
      return 400;
    case "PROJECT_REQUEST_FAILED":
      // 500 Internal Server Error. Used only when the handler
      // catches an exception outside the typed ProjectRequestError
      // surface. The underlying exception message is logged server
      // side but never echoed to the response envelope.
      return 500;
    // Buildathon Golden Slice 5 (BG5) Deal / TermsVersion /
    // DealApprover / DealApproval status mapping. The codes mirror
    // the BG4 pattern: 403 for authorization rejections, 404 for
    // unknown ids, 409 for retry-detected duplicates, 422 for
    // semantic-but-well-formed rejections (non-Negotiating,
    // non-current version), 400 for malformed requests, 500 for
    // unexpected internal failures, 503 for transient marketplace
    // unavailability.
    case "BG5_DEAL_NOT_FOUND":
    case "BG5_TERMS_VERSION_NOT_FOUND":
      return 404;
    case "BG5_TERMS_DRAFT_FORBIDDEN":
    case "BG5_APPROVAL_FORBIDDEN":
      return 403;
    case "BG5_DEAL_NOT_NEGOTIATING":
      // Semantic rejection: the Deal is Active or otherwise past
      // Negotiating. The Golden Slice does NOT support drafting
      // terms for an Active Deal.
      return 422;
    case "BG5_APPROVAL_NOT_CURRENT_VERSION":
      // Semantic rejection: the requested termsVersionId is not the
      // Deal's current (MAX(version)) TermsVersion. The approval is
      // rejected; the caller may re-issue against the new current
      // version. A retry that re-sends the stale version is rejected
      // for the same reason — the application policy is the only
      // arbiter.
      return 422;
    case "BG5_APPROVAL_ALREADY_RECORDED":
      // 409 Conflict. A retry would have produced a duplicate
      // DealApproval; the unique index + guarded insert rejected the
      // duplicate.
      return 409;
    case "BG5_TERMS_DRAFT_INVALID":
    case "BG5_APPROVAL_INVALID":
      return 400;
    case "BG5_DEAL_INTERNAL_FAILED":
      // 500 Internal Server Error. Used only when the handler
      // catches an exception outside the typed DealTermsError
      // surface. The underlying exception message is logged server
      // side but never echoed to the response envelope.
      return 500;
    case "BG5_DEAL_UNAVAILABLE":
      // 503 Service Unavailable. The bounded P2034 retry budget was
      // exhausted; the marketplace is briefly unable to authorise
      // the write. The caller can retry the same payload without
      // changing the request.
      return 503;
    // Deals discovery list (ticket #74).
    case "DEAL_LIST_FORBIDDEN":
      // 403 Forbidden. Collapses "unknown Workspace", "Workspace not
      // Active", and "not a current member" into one envelope so the
      // caller learns nothing about Workspaces they cannot act for.
      // Notably NOT 404: the list is addressed by the acting
      // Workspace, and distinguishing absence from denial would leak
      // Workspace existence.
      return 403;
    case "DEAL_LIST_INVALID":
      return 400;
    case "DEAL_LIST_FAILED":
      // 500 Internal Server Error. Used only when the handler catches
      // an exception outside the typed DealListError surface; the
      // underlying message is logged but never echoed.
      return 500;
    // Buildathon Golden Slice 6 (BG6) — PaymentIntent + activation
    // status mapping. The mapping mirrors the BG5 pattern: 403 for
    // authorization rejections, 404 for unknown ids, 409 for
    // retry-detected duplicates, 422 for semantic-but-well-formed
    // rejections (non-Negotiating, non-current version, mismatch),
    // 400 for malformed requests, 500 for unexpected internal
    // failures, 503 for transient provider unavailability.
    case "BG6_DEAL_NOT_FOUND":
      return 404;
    case "BG6_FUNDING_FORBIDDEN":
      return 403;
    case "BG6_DEAL_NOT_NEGOTIATING":
    case "BG6_APPROVALS_INCOMPLETE":
    case "BG6_TERMS_VERSION_NOT_CURRENT":
    case "BG6_FUNDING_CONFIRMATION_MISMATCH":
      return 422;
    case "BG6_DEAL_ALREADY_ACTIVE":
      // 409 Conflict. The guarded activation UPDATE returned 0 rows;
      // a concurrent activation already happened. Safe for the buyer
      // to retry against the (now Active) Deal only after re-reading
      // the deal view.
      return 409;
    case "BG6_FUNDING_INVALID":
      return 400;
    case "BG6_ESCROW_UNAVAILABLE":
      // 503 Service Unavailable. The provider threw or was
      // unreachable; the intent transitions to Failed on the same
      // durable row and the Deal stays Negotiating. The caller can
      // retry the same payload without changing the request.
      return 503;
    case "BG6_FUNDING_INTERNAL_FAILED":
      // 500 Internal Server Error. Used only when the handler
      // catches an exception outside the typed FundingServiceError
      // surface. The underlying message is logged server side but
      // never echoed to the response envelope.
      return 500;
    // M2 (#82): Personal Workspace convergence surface (reserved).
    // The normal recovery path surfaces recovery via `setupState:
    // "recovery"` on the public user payload, NOT via an error
    // envelope from /verify-token. These codes are mapped to safe
    // statuses for the boundary-condition paths.
    case "PERSONAL_WORKSPACE_RECOVERY_REQUIRED":
      return 403;
    case "PERSONAL_WORKSPACE_CONVERGENCE_CONFLICT":
      return 409;
    // M2 (#83): Intent selection status mapping. 400 for malformed
    // requests, 403 for authorization rejections collapsed by the
    // safe envelope, 409 for the transition precondition mismatch
    // (the persisted capability set does not match the
    // request's `expectedCapabilities`). Intent does NOT collect a
    // generic Seller participation/terms acceptance at
    // capability-provisioning time; there is no separate
    // product/legal envelope at this boundary.
    case "INTENT_INVALID":
      return 400;
    case "INTENT_FORBIDDEN":
      return 403;
    case "INTENT_CONFLICT":
      return 409;
    // M2 (#84): SellerProfile creation / resume / publish / update
    // status mapping. Mirrors the intent pattern: 400 for malformed
    // bodies (including missing/invalid `idempotencyKey`), 403 for
    // authorization rejections (Personal-Workspace-only AND
    // Seller-capable — Organization actor, Buyer-only Personal, or
    // non-current member are all collapsed by the safe envelope),
    // 404 for missing draft rows on read, 409 for
    // duplicate-on-first-save / not-Draft-on-publish /
    // not-Published-on-update, 422 for incomplete Publish payload
    // (semantic-but-well-formed rejection; the safe envelope carries
    // `fields` for the multi-error summary), 500 for unexpected
    // internal failures.
    case "SELLER_PROFILE_INVALID":
      return 400;
    case "SELLER_PROFILE_FORBIDDEN":
      return 403;
    case "SELLER_PROFILE_NOT_FOUND":
      return 404;
    case "SELLER_PROFILE_DUPLICATE":
    case "SELLER_PROFILE_NOT_DRAFT":
    case "SELLER_PROFILE_NOT_PUBLISHED":
      return 409;
    case "SELLER_PROFILE_INCOMPLETE":
      return 422;
    case "SELLER_PROFILE_INTERNAL_FAILED":
      return 500;
    // M2 (#85): ServiceOffering creation / draft / activate surface.
    // Mirrors the SellerProfile mapping: 400 / 403 / 404 / 409 / 422
    // / 500. The "not-Draft" / "already-Active" cases map to 409 so a
    // retry on a stale status surfaces as a recoverable conflict
    // rather than as a generic 500.
    case "SERVICE_OFFERING_INVALID":
      return 400;
    case "SERVICE_OFFERING_FORBIDDEN":
      return 403;
    case "SERVICE_OFFERING_NOT_FOUND":
      return 404;
    case "SERVICE_OFFERING_NOT_DRAFT":
    case "SERVICE_OFFERING_ALREADY_ACTIVE":
      return 409;
    case "SERVICE_OFFERING_INCOMPLETE":
    case "SERVICE_OFFERING_SELLER_PROFILE_NOT_PUBLISHED":
      // Semantic-but-well-formed rejection: the activation payload
      // is valid but the offering does not satisfy the full current
      // contract (missing field, missing audio, or unpublished
      // SellerProfile). The safe envelope carries `fields` for the
      // multi-error summary where applicable.
      return 422;
    case "SERVICE_OFFERING_INTERNAL_FAILED":
      return 500;
    // M2 (#86): post-activation lifecycle. The mapping mirrors the
    // existing ServiceOffering pattern: 409 for state-precondition
    // mismatches (Pause of a non-Active offering, Reactivate of a
    // non-Paused offering, Update of a non-Active offering); 422
    // for the Update completeness rejection (mirrors
    // SERVICE_OFFERING_INCOMPLETE); 400 for the audio-side
    // final-removal confirmation flag omission.
    case "SERVICE_OFFERING_ALREADY_PAUSED":
    case "SERVICE_OFFERING_NOT_PAUSED":
    case "SERVICE_OFFERING_NOT_ACTIVE":
      // 409 Conflict. The offering is in the wrong lifecycle state
      // for the requested command; a retry that re-sends the same
      // idempotencyKey after a committed command returns the
      // existing evidence row (converged success) and does NOT
      // surface this code.
      return 409;
    case "SERVICE_OFFERING_INVALID_UPDATE":
      // Semantic-but-well-formed rejection: the Update payload is
      // valid but the offering does not satisfy the full current
      // contract. The safe envelope carries `fields` for the
      // multi-error summary.
      return 422;
    case "AUDIO_SAMPLE_FINAL_REMOVAL_CONFIRMATION_REQUIRED":
      // M2 (#86): the seller attempted to remove the last qualifying
      // sample from an Active offering without the explicit
      // `confirmEligibilityLoss` flag on the request body. The flag
      // is transient (never persisted) and required only on this
      // condition — surface as 400 because the request is
      // structurally incomplete without the explicit confirmation
      // field.
      return 400;
    // M2 (#88): Personal-Workspace DealApprover JIT permission setup.
    // The mapping mirrors the existing M2 patterns: 400 for malformed
    // bodies (missing/invalid `actingWorkspaceId`, `confirmationVersion`,
    // or `idempotencyKey`), 403 for authorization rejections collapsed
    // by the safe envelope (non-Personal acting Workspace, non-Active
    // Workspace, or non-current member all surface here), 409 for
    // a different idempotencyKey against an already-provisioned
    // (workspaceId, userId) tuple, 422 for the closed
    // `confirmationVersion` mismatch, 500 for unexpected internal
    // failures.
    case "DEAL_APPROVER_INVALID":
      return 400;
    case "DEAL_APPROVER_FORBIDDEN":
      return 403;
    case "DEAL_APPROVER_ALREADY_PROVISIONED":
      return 409;
    case "DEAL_APPROVER_CONFIRMATION_VERSION_MISMATCH":
      return 422;
    case "DEAL_APPROVER_INTERNAL_FAILED":
      return 500;
  }
}

export function generateRequestId(): string {
  return randomUUID();
}

export function writeSafeError(res: Response, response: SafeErrorResponse): void {
  res.setHeader(REQUEST_ID_HEADER, response.body.error.requestId);
  // Validate our own envelope before sending it; this catches drift between
  // the shared schema and our construction here.
  const parsed = apiErrorResponseV1Schema.safeParse(response.body);
  if (!parsed.success) {
    // Last-resort fallback that is itself schema-valid.
    const fallback = apiErrorResponseV1Schema.parse({
      error: {
        code: "SEARCH_FAILED" as const,
        message: "An internal error occurred.",
        requestId: response.body.error.requestId,
      },
    });
    res.status(500).json(fallback);
    return;
  }
  res.status(response.status).json(parsed.data);
}
