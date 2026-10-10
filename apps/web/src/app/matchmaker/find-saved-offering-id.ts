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
// A `null` savedOfferingId is treated as "no saved offering" so
// the highlight lookup never matches an unrelated row.
import type {
  ExplanationEntryV1,
  MatchmakerRecommendationV1,
  PublicOfferingSummaryV1,
} from "@soundhub/types";

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

// M2 (#87) 6th review Finding 17: the row's target offering is
// the saved offering when it is in either `bestMatchingOffering`
// or `additionalMatchingOfferings`; otherwise it falls back to
// the row's `bestMatchingOffering` (the canonical display for
// fresh buyers with no Talent recovery). The returned summary
// drives every row display element (title, category, audio
// preview) so the buyer reviews the exact offering the Send
// project request will target — not the row's best match when
// the saved offering is in the additional set.
export function selectTargetOffering(
  recommendation: MatchmakerRecommendationV1,
  savedOfferingId: string | null,
): PublicOfferingSummaryV1 {
  if (savedOfferingId !== null) {
    if (recommendation.bestMatchingOffering.offeringId === savedOfferingId) {
      return recommendation.bestMatchingOffering;
    }
    for (const additional of recommendation.additionalMatchingOfferings) {
      if (additional.offeringId === savedOfferingId) {
        return additional;
      }
    }
  }
  return recommendation.bestMatchingOffering;
}

// M2 (#87) 7th review Finding 2 — Promoted-offering evidence
// alignment. The recommendation DTO carries a single
// `explanations` list and `matchReason` string derived from the
// search engine's analysis of the best matching offering. When
// the saved offering is in `additionalMatchingOfferings` (i.e.
// the row is displaying a different offering than the search
// ranked as best), the row MUST NOT render evidence derived
// from the best matching offering alongside the promoted
// offering's title, category, audio, and request target. The
// evidence and match reason are re-derived from the promoted
// offering's own fields so every element on the row describes
// the same offering.
//
// When the saved offering is the best matching offering (or no
// Talent recovery is present), the recommendation's existing
// evidence is authoritative and is returned unchanged.
export interface TargetEvidence {
  readonly explanations: readonly ExplanationEntryV1[];
  readonly matchReason: string;
}

export function selectTargetEvidence(
  recommendation: MatchmakerRecommendationV1,
  savedOfferingId: string | null,
): TargetEvidence {
  // No recovery, or the saved offering is the best matching
  // offering — the recommendation's evidence is already aligned
  // with the displayed offering. Return it as-is.
  if (
    savedOfferingId === null ||
    recommendation.bestMatchingOffering.offeringId === savedOfferingId
  ) {
    return {
      explanations: recommendation.explanations,
      matchReason: recommendation.matchReason,
    };
  }
  // The saved offering is in `additionalMatchingOfferings`.
  // Derive per-offering evidence from the target's own fields
  // so the explanations + match reason describe the same
  // offering the row displays.
  const target = selectTargetOffering(recommendation, savedOfferingId);
  const explanations: ExplanationEntryV1[] = [
    {
      kind: "matched-offering-title",
      label: `Matched offering: ${target.title}`,
    },
    {
      kind: "matched-category-key",
      label: `Listed under ${target.primaryCategory.name} (${target.primaryCategory.key})`,
    },
  ];
  const matchReasonParts: string[] = [
    `matched offering title: ${target.title}`,
    `category: ${target.primaryCategory.name}`,
  ];
  if (target.genreTags.length > 0) {
    explanations.push({
      kind: "preferred-genre",
      label: `Genre: ${target.genreTags.join(", ")}`,
    });
    matchReasonParts.push(`genre: ${target.genreTags.join(", ")}`);
  }
  if (target.serviceMode) {
    matchReasonParts.push(`service mode: ${target.serviceMode}`);
  }
  if (target.serviceAreas.length > 0) {
    const first = target.serviceAreas[0]!;
    const city = first.city ?? "";
    const area = `${city} ${first.countryCode}`.trim();
    if (area.length > 0) {
      explanations.push({
        kind: "preferred-locality",
        label: `Service area: ${area}`,
      });
    }
  }
  return {
    explanations,
    matchReason: matchReasonParts.join("; "),
  };
}
