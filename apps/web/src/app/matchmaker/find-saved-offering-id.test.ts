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
import {
  findSavedOfferingId,
  selectTargetEvidence,
  selectTargetOffering,
} from "./find-saved-offering-id.js";

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

// M2 (#87) 6th review Finding 17: the row's target offering
// drives the displayed title, category, and audio preview — so
// the buyer reviews the exact offering the Send project request
// will target. The helper returns the saved offering when it is
// in either `bestMatchingOffering` or
// `additionalMatchingOfferings`; otherwise it falls back to the
// row's `bestMatchingOffering` (the canonical display for fresh
// buyers with no Talent recovery).
describe("selectTargetOffering (M2 #87 6th review Finding 17)", () => {
  test("returns the saved offering when it is `bestMatchingOffering`", () => {
    const rec = makeRecommendation("of-best", ["of-add-1"]);
    const target = selectTargetOffering(rec, "of-best");
    assert.equal(target.offeringId, "of-best");
    assert.equal(target.title, "Best offering");
  });

  test("returns the saved offering when it is in `additionalMatchingOfferings`", () => {
    const rec = makeRecommendation("of-best", ["of-add-1", "of-add-2"]);
    const target = selectTargetOffering(rec, "of-add-2");
    assert.equal(target.offeringId, "of-add-2");
    // The recovered offering is the additional one — the row
    // must show the additional offering's title, NOT the
    // best-matching offering's title. This is the entire point
    // of Finding 17: the buyer must review the offering the
    // request will target.
    assert.equal(target.title, "Additional of-add-2");
    assert.notEqual(target.title, "Best offering");
  });

  test("falls back to `bestMatchingOffering` when the saved id is null (no recovery record)", () => {
    const rec = makeRecommendation("of-best", ["of-add-1"]);
    const target = selectTargetOffering(rec, null);
    assert.equal(target.offeringId, "of-best");
  });

  test("falls back to `bestMatchingOffering` when the saved id is not in either set", () => {
    const rec = makeRecommendation("of-best", ["of-add-1"]);
    const target = selectTargetOffering(rec, "of-unrelated");
    assert.equal(target.offeringId, "of-best");
  });

  test("the helper does NOT mutate the recommendation", () => {
    const rec = makeRecommendation("of-best", ["of-add-1"]);
    const snapshot = JSON.stringify(rec);
    selectTargetOffering(rec, "of-add-1");
    selectTargetOffering(rec, null);
    assert.equal(JSON.stringify(rec), snapshot);
  });
});

// M2 (#87) 7th review Finding 2: when the saved offering is
// promoted from `additionalMatchingOfferings`, the row MUST
// display evidence derived from the target offering's own
// fields (not the best matching offering's). The
// `selectTargetEvidence` helper returns the recommendation's
// existing evidence when the saved offering IS the best
// matching offering (or no recovery is present), and re-derives
// the evidence from the target's own fields when the saved
// offering is in the additional set.
describe("selectTargetEvidence (M2 #87 7th review Finding 2)", () => {
  test("returns the recommendation's existing evidence when no Talent recovery is present", () => {
    const rec = makeRecommendation("of-best", ["of-add-1"]);
    const evidence = selectTargetEvidence(rec, null);
    assert.deepEqual(evidence.explanations, rec.explanations);
    assert.equal(evidence.matchReason, rec.matchReason);
  });

  test("returns the recommendation's existing evidence when the saved offering IS the best matching offering", () => {
    const rec = makeRecommendation("of-best", ["of-add-1"]);
    const evidence = selectTargetEvidence(rec, "of-best");
    assert.deepEqual(evidence.explanations, rec.explanations);
    assert.equal(evidence.matchReason, rec.matchReason);
  });

  test("derives per-offering evidence when the saved offering is in `additionalMatchingOfferings`", () => {
    // The saved offering is `of-add-1` (in additionalMatchings).
    // The best matching offering is `of-best` with title "Best
    // offering". The promoted offering's title is "Additional
    // of-add-1" (per the makeRecommendation helper). The
    // evidence MUST describe the promoted offering, NOT the
    // best matching one.
    const rec = makeRecommendation("of-best", ["of-add-1"]);
    const evidence = selectTargetEvidence(rec, "of-add-1");
    // Match reason MUST mention the promoted offering's title.
    assert.match(evidence.matchReason, /Additional of-add-1/);
    // Match reason MUST NOT mention the best matching offering's
    // title.
    assert.ok(
      !/Best offering/.test(evidence.matchReason),
      "matchReason MUST NOT mention the best matching offering's title when the saved offering is in additionalMatchings (Finding 2)",
    );
    // The explanations MUST include the promoted offering's title
    // and category, NOT the best matching offering's.
    const explanationLabels = evidence.explanations.map((e) => e.label).join(" | ");
    assert.match(explanationLabels, /Additional of-add-1/);
    assert.ok(
      !/Best offering/.test(explanationLabels),
      "explanations MUST NOT mention the best matching offering's title when the saved offering is in additionalMatchings (Finding 2)",
    );
    // Every explanation kind must be a valid ExplanationKindV1.
    const validKinds = new Set([
      "matched-offering-title",
      "matched-category-key",
      "matched-category-name",
      "preferred-genre",
      "preferred-category",
      "preferred-specialty",
      "preferred-affiliation",
      "preferred-service-mode",
      "preferred-included-service",
      "preferred-locality",
      "standalone-offering",
    ]);
    for (const entry of evidence.explanations) {
      assert.ok(
        validKinds.has(entry.kind),
        `explanation kind "${entry.kind}" is not a valid ExplanationKindV1`,
      );
    }
  });
});
