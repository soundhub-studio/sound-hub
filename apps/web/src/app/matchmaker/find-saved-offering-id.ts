// M2 (#87) Finding 8 (5th review): locate the saved offeringId in
// either the recommendation's `bestMatchingOffering` or any of its
// `additionalMatchingOfferings`. Returns the saved offeringId when
// the recommendation contains it (so Send project request targets
// exactly the buyer's original click on /talent) or `null` when the
// recommendation is unrelated to the saved offering. Lives in its
// own module so the focused unit test can drive the dual-lookup
// semantics without rendering the page AND so the matchmaker page
// module keeps its strict Next.js export surface (default + route
// exports only).
//
// A `null` saved offeringId is treated as "no saved offering" so
// the highlight lookup never matches an unrelated row.
import type { MatchmakerRecommendationV1 } from "@soundhub/types";

export function findSavedOfferingId(
  recommendation: MatchmakerRecommendationV1,
  savedOfferingId: string | null,
): string | null {
  if (savedOfferingId === null) return null;
  if (recommendation.bestMatchingOffering.offeringId === savedOfferingId) {
    return savedOfferingId;
  }
  for (const additional of recommendation.additionalMatchingOfferings) {
    if (additional.offeringId === savedOfferingId) {
      return savedOfferingId;
    }
  }
  return null;
}
