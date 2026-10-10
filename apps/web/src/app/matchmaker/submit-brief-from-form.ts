// Matchmaker form submit test seam.
//
// Background: Next.js page modules may export only `default` and a
// small set of route-level exports; arbitrary named exports cause
// type errors against `next/types`. To keep the buyer-page submit
// path testable without coupling to React state, the runtime body
// of the page's onSubmit handler lives here as a pure function
// that the page delegates to. The focused UI test exercises this
// function with a controlled fetch so the runtime wiring
// (workspace + brief text payload, response state, error state,
// submitting flag) is verified end to end.
//
// The page's onSubmit handler delegates to this function. Tests
// may inject a `submit` override to assert the payload contract
// without exercising the network.

import type { SubmitBriefRequestV1, SubmitBriefResponseV1 } from "@soundhub/types";
import { submitBrief } from "../lib/matchmaker-client";

export interface SubmitBriefFromFormInput {
  readonly actingWorkspaceId: string;
  readonly briefText: string;
  /**
   * M2 (#87) Finding 8: optional buyer-supplied strict required
   * criteria (M1's `talentSearchRequiredCriteriaV1Schema` shape).
   * When present, the route applies them verbatim — the AI never
   * relaxes a buyer-supplied hard axis. The matchmaker form
   * populates this from the recovered Talent continuation
   * record's `filters` so a buyer who searched with strict
   * filters on /talent does not lose them on the round-trip to
   * /matchmaker. Pass `null` to explicitly clear any previously
   * supplied required criteria.
   */
  readonly required?: SubmitBriefRequestV1["required"] | null;
  /**
   * M2 (#87) Finding 8: optional buyer-supplied preferred criteria.
   * Pass `null` to explicitly clear.
   */
  readonly preferred?: SubmitBriefRequestV1["preferred"] | null;
  readonly setError: (message: string | null) => void;
  readonly setResponse: (response: SubmitBriefResponseV1 | null) => void;
  readonly setSubmitting: (value: boolean) => void;
  /**
   * Optional injection for tests. Defaults to the page's own
   * `submitBrief` so production wiring is unchanged.
   */
  readonly submit?: typeof submitBrief;
  /**
   * Invoked when the Matchmaker API rejects the request because the
   * shared session cookie is invalid or expired (HTTP 401). The page
   * uses this hook to refresh the BG1 SessionProvider so the header
   * email and workspace list converge on the signed-out state
   * (and so the buyer never sees a stale "demo.buyer@…" with a
   * stale workspace selection).
   *
   * Cookies are origin-shared across browser tabs, so a sign-out
   * in another tab invalidates this tab's cookie on the next
   * request — that request then hits this hook and the page
   * converges on the signed-out state without a manual reload.
   */
  readonly onSessionInvalid?: () => void;
}

export async function submitBriefFromForm(input: SubmitBriefFromFormInput): Promise<void> {
  input.setError(null);
  input.setResponse(null);
  if (!input.actingWorkspaceId) {
    input.setError("Pick an acting Workspace before submitting a brief.");
    return;
  }
  if (input.briefText.trim().length < 8) {
    input.setError("Brief text must be at least 8 characters after trimming.");
    return;
  }
  input.setSubmitting(true);
  try {
    const fn = input.submit ?? submitBrief;
    // M2 (#87) Finding 8: forward buyer-supplied required +
    // preferred criteria to the brief submission. A `null`
    // value is forwarded as `undefined` (the schema's
    // `.optional()` allows absent fields; explicit `null`
    // would fail the strict schema).
    const required = input.required === null ? undefined : input.required;
    const preferred = input.preferred === null ? undefined : input.preferred;
    const result = await fn({
      actingWorkspaceId: input.actingWorkspaceId,
      briefText: input.briefText.trim(),
      ...(required ? { required } : {}),
      ...(preferred ? { preferred } : {}),
    });
    input.setResponse(result);
  } catch (err) {
    input.setError(err instanceof Error ? err.message : "Could not submit the brief.");
    // If the rejection was a session-invalid 401, refresh the
    // shared SessionProvider so the page converges on the
    // signed-out state. Detection is name-based because the safe
    // envelope is the only signal the client can rely on
    // regardless of which Matchmaker or future BG path returned
    // the 401.
    if (
      input.onSessionInvalid &&
      err instanceof Error &&
      ((err as { code?: string }).code === "SESSION_INVALID" ||
        (err as { code?: string }).code === "AUTH_FAILED" ||
        (err as { code?: string }).code === "SESSION_EXPIRED")
    ) {
      input.onSessionInvalid();
    }
  } finally {
    input.setSubmitting(false);
  }
}
