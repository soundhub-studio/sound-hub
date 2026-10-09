/* eslint-disable @typescript-eslint/no-floating-promises */
// M2 (#87) Finding 8 (5th review): focused tests for the
// dual-lookup helper that locates the saved offeringId in either
// the recommendation's `bestMatchingOffering` or any of its
// `additionalMatchingOfferings`. The helper drives both the
// highlight (`aria-current` + `data-matchmaker-highlighted`) and
// the Send project request target on the matchmaker page.
//
// Each test below pins one branch of the helper so a regression
// that narrows the lookup back to `bestMatchingOffering` alone
// (the previous implementation) fails the test.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { MatchmakerRecommendationV1 } from "@soundhub/types";
import { findSavedOfferingId } from "./find-saved-offering-id.js";

function makeRecommendation(
  bestOfferingId: string,
  additionalOfferingIds: readonly string[] = [],
): MatchmakerRecommendationV1 {
  return {
    sellerId: "seller-1",
    professionalName: "Marc-André Pierre",
    bestMatchingOfferingId: bestOfferingId,
    relevanceScore: 0.9,
    explanations: [{ kind: "matched-offering-title", label: "matched" }],
    matchReason: "matched",
    bestMatchingOffering: {
      offeringId: bestOfferingId,
      title: "Best offering",
      description: "desc",
      primaryCategory: { key: "music-production", name: "Music Production" },
      includedServices: [],
      genreTags: [],
      serviceMode: "Remote",
      serviceAreas: [],
    },
    seller: {
      sellerId: "seller-1",
      professionalName: "Marc-André Pierre",
      bio: "Bio",
      basedIn: { countryCode: "US" },
      specialties: ["Producer"],
      caribbeanAffiliationCodes: ["HT"],
    },
    additionalMatchingOfferings: additionalOfferingIds.map((offeringId) => ({
      offeringId,
      title: `Additional ${offeringId}`,
      description: "desc",
      primaryCategory: { key: "mixing", name: "Mixing" },
      includedServices: [],
      genreTags: [],
      serviceMode: "Remote" as const,
      serviceAreas: [],
    })),
  };
}

describe("findSavedOfferingId (M2 #87 5th review Finding 3)", () => {
  test("returns the saved offeringId when it matches `bestMatchingOffering.offeringId`", () => {
    const rec = makeRecommendation("of-best", ["of-add-1", "of-add-2"]);
    assert.equal(findSavedOfferingId(rec, "of-best"), "of-best");
  });

  test("returns the saved offeringId when it matches an `additionalMatchingOfferings` entry", () => {
    const rec = makeRecommendation("of-best", ["of-add-1", "of-add-2"]);
    assert.equal(findSavedOfferingId(rec, "of-add-1"), "of-add-1");
    assert.equal(findSavedOfferingId(rec, "of-add-2"), "of-add-2");
  });

  test("returns null when the saved offeringId is neither best nor additional", () => {
    const rec = makeRecommendation("of-best", ["of-add-1"]);
    assert.equal(findSavedOfferingId(rec, "of-unrelated"), null);
  });

  test("returns null when the saved offeringId is null (no recovery record)", () => {
    const rec = makeRecommendation("of-best", ["of-add-1"]);
    assert.equal(findSavedOfferingId(rec, null), null);
  });

  test("returns null when `additionalMatchingOfferings` is empty and saved id is not the best", () => {
    const rec = makeRecommendation("of-best");
    assert.equal(findSavedOfferingId(rec, "of-someone-else"), null);
  });

  test("the helper does NOT mutate the recommendation or its offering arrays", () => {
    const rec = makeRecommendation("of-best", ["of-add-1"]);
    const snapshot = JSON.stringify(rec);
    findSavedOfferingId(rec, "of-add-1");
    findSavedOfferingId(rec, "of-best");
    assert.equal(JSON.stringify(rec), snapshot);
  });
});
