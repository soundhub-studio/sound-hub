// Matchmaker recommendation selection test seam (BG4).
//
// Background: ticket #62 requires the buyer-side selection step
// that converts an eligibility-determined Matchmaker recommendation
// into a persisted ProjectRequest. The form action lives in this
// module so the focused UI test can exercise the runtime wiring
// (acting Workspace + brief + selected offering + response state +
// error rendering + submitting flag) with a controlled client so the
// UI test does not exercise the network.
//
// The page's onClick delegate for each recommendation calls this
// function. Tests may inject an `invite` override to assert the
// payload contract without exercising the network.

import type { CreateProjectRequestResponseV1, MatchmakerRecommendationV1 } from "@soundhub/types";
import { createProjectRequest } from "../lib/project-requests-client";

export interface InviteFromRecommendationInput {
  readonly actingWorkspaceId: string;
  readonly briefId: string;
  readonly recommendation: MatchmakerRecommendationV1;
  /**
   * M2 (#87) Finding 8 (5th review): the saved offeringId from
   * the Talent continuation record may resolve to either the
   * recommendation's `bestMatchingOffering` or one of its
   * `additionalMatchingOfferings`. When set, the Send project
   * request targets exactly this offeringId (the buyer's
   * original click on /talent). When absent, the request falls
   * back to the recommendation's `bestMatchingOffering.offeringId`
   * (the legacy path for fresh buyers with no Talent recovery).
   */
  readonly targetOfferingId?: string | null;
  readonly setError: (message: string | null) => void;
  readonly setSuccess: (message: string | null) => void;
  readonly setSubmitting: (value: boolean) => void;
  /**
   * Optional injection for tests. Defaults to the page's own
   * `createProjectRequest` so production wiring is unchanged.
   */
  readonly invite?: typeof createProjectRequest;
  /**
   * Optional injection for tests so the UI test can stub the
   * session-refresh hook without standing up the SessionProvider.
   */
  readonly onSessionInvalid?: () => void;
}

export async function inviteFromRecommendation(
  input: InviteFromRecommendationInput,
): Promise<void> {
  input.setError(null);
  input.setSuccess(null);
  if (!input.actingWorkspaceId) {
    input.setError("Pick an acting Workspace before inviting a seller.");
    return;
  }
  if (!input.briefId) {
    input.setError("A persisted ProjectBrief is required to invite a seller.");
    return;
  }
  // M2 (#87) Finding 8 (5th review): when the page passes a
  // resolved `targetOfferingId` (the saved offeringId from the
  // Talent recovery), use it verbatim. Otherwise fall back to the
  // recommendation's `bestMatchingOffering` (the canonical row
  // offering for fresh buyers with no Talent recovery).
  const serviceOfferingId =
    input.targetOfferingId ?? input.recommendation.bestMatchingOffering.offeringId;
  input.setSubmitting(true);
  try {
    const fn = input.invite ?? createProjectRequest;
    const result: CreateProjectRequestResponseV1 = await fn({
      actingWorkspaceId: input.actingWorkspaceId,
      projectBriefId: input.briefId,
      serviceOfferingId,
    });
    input.setSuccess(
      `Invited ${input.recommendation.professionalName} — ProjectRequest ${result.projectRequest.projectRequestId} persisted as Pending.`,
    );
  } catch (err) {
    if (
      input.onSessionInvalid &&
      err instanceof Error &&
      ((err as { code?: string }).code === "SESSION_INVALID" ||
        (err as { code?: string }).code === "AUTH_FAILED" ||
        (err as { code?: string }).code === "SESSION_EXPIRED")
    ) {
      input.onSessionInvalid();
    }
    input.setError(err instanceof Error ? err.message : "Could not invite the seller.");
  } finally {
    input.setSubmitting(false);
  }
}
