/* eslint-disable @typescript-eslint/no-floating-promises */
// Browser request-builder tests.
//
// These tests verify that every candidate payload produced by the
// shared request builder is schema-valid. The Codex review surfaced
// that the browser previously built requests by hand and dropped a
// one-character query when any required filter was supplied; that
// silently violated the rule that required constraints are never
// "saved" by relaxing or dropping a query. The fix is: build the
// candidate payload, parse it with the shared Zod schema, and let
// the schema be the only thing that decides what enters the wire.
//
// Each test below is the load-bearing assertion that the builder
// cannot bypass that schema-level enforcement.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { talentSearchRequestV1Schema, talentSearchRequiredCriteriaV1Schema } from "@soundhub/types";
import {
  buildCandidatePayload,
  buildRequiredCriteriaPayload,
  EMPTY_SEARCH_GUIDANCE_MESSAGE,
  getEmptySearchSubmissionMessage,
  hasUsableCriteria,
  isLocationFilterValueNonEmpty,
  toLocationFilterPayload,
  type LocationFilterValue,
  type RequiredFiltersValue,
} from "./talent-search-request-builder.js";

const emptyLocation: LocationFilterValue = { city: "", region: "", countryCode: "" };

const emptyFilters: RequiredFiltersValue = {
  primaryCategoryKey: "",
  independentlyPurchasableServiceKey: "",
  serviceModes: [],
  basedIn: emptyLocation,
  serviceArea: emptyLocation,
};

// Convenience helpers so individual tests can spell out just the
// sub-fields they care about — P2-001 introduced the nested
// `LocationFilterValue` shape and we still want each test to read
// at a glance.
function withBasedIn(overrides: Partial<LocationFilterValue>): RequiredFiltersValue {
  return { ...emptyFilters, basedIn: { ...emptyLocation, ...overrides } };
}

function withServiceArea(overrides: Partial<LocationFilterValue>): RequiredFiltersValue {
  return { ...emptyFilters, serviceArea: { ...emptyLocation, ...overrides } };
}

describe("toLocationFilterPayload", () => {
  test("an empty LocationFilterValue returns undefined so callers can omit the parent block", () => {
    assert.equal(toLocationFilterPayload(emptyLocation), undefined);
  });

  test("a whitespace-only LocationFilterValue is treated as empty", () => {
    const value: LocationFilterValue = { city: "   ", region: "\t", countryCode: "  " };
    assert.equal(toLocationFilterPayload(value), undefined);
  });

  test("a city-only value emits a LocationFilter with no region or countryCode", () => {
    const out = toLocationFilterPayload({ city: "Brooklyn", region: "", countryCode: "" });
    assert.deepEqual(out, { city: "Brooklyn" });
  });

  test("a region-only value emits a LocationFilter with no city or countryCode", () => {
    const out = toLocationFilterPayload({ city: "", region: "NY", countryCode: "" });
    assert.deepEqual(out, { region: "NY" });
  });

  test("a countryCode is upper-cased on the way out so the schema sees `JM`, not `jm`", () => {
    const out = toLocationFilterPayload({ city: "", region: "", countryCode: "jm" });
    assert.deepEqual(out, { countryCode: "JM" });
  });

  test("a trimmed-empty sub-field is omitted even when other sub-fields are present", () => {
    const out = toLocationFilterPayload({ city: "  ", region: "NY", countryCode: "US" });
    assert.deepEqual(out, { region: "NY", countryCode: "US" });
  });

  test("a fully populated value emits all three sub-fields verbatim", () => {
    const out = toLocationFilterPayload({ city: "Brooklyn", region: "NY", countryCode: "US" });
    assert.deepEqual(out, { city: "Brooklyn", region: "NY", countryCode: "US" });
  });
});

describe("isLocationFilterValueNonEmpty", () => {
  test("an empty value is non-usable", () => {
    assert.equal(isLocationFilterValueNonEmpty(emptyLocation), false);
  });

  test("a whitespace-only value is non-usable", () => {
    assert.equal(
      isLocationFilterValueNonEmpty({ city: "   ", region: " \t", countryCode: " " }),
      false,
    );
  });

  test("any single non-empty sub-field is usable", () => {
    assert.equal(isLocationFilterValueNonEmpty({ city: "", region: "", countryCode: "JM" }), true);
    assert.equal(isLocationFilterValueNonEmpty({ city: "", region: "NY", countryCode: "" }), true);
    assert.equal(
      isLocationFilterValueNonEmpty({ city: "Brooklyn", region: "", countryCode: "" }),
      true,
    );
  });
});

describe("buildCandidatePayload + talentSearchRequestV1Schema", () => {
  test("empty query and empty filters produce a payload that the schema rejects (no usable criteria)", () => {
    const candidate = buildCandidatePayload("", emptyFilters);
    const parsed = talentSearchRequestV1Schema.safeParse(candidate);
    assert.equal(parsed.success, false, "an empty payload must not be schema-valid");
  });

  test("a one-character query combined with a valid required filter is NOT silently dropped — the schema rejects it with a query field error", () => {
    // Buyer types "a" and selects a category. The builder must keep
    // the query in the candidate so the schema can reject it with
    // an actionable field-level error. The pre-fix code dropped this
    // exact case and produced a successful filter-only request.
    const candidate = buildCandidatePayload("a", {
      ...emptyFilters,
      primaryCategoryKey: "music-production",
    });
    const parsed = talentSearchRequestV1Schema.safeParse(candidate);
    assert.equal(parsed.success, false, "the one-character query must surface a schema rejection");
    const issue = parsed.error.issues.find((i) => i.path.join(".") === "query");
    assert.ok(issue, "the rejection must name the query path");
  });

  test("all-empty structured filters with no query do not craft a query-only request", () => {
    const candidate = buildCandidatePayload("", emptyFilters);
    assert.equal(candidate.query, undefined);
    assert.equal(candidate.required, undefined);
  });

  test("a query of 2+ characters with no filters produces a schema-valid request", () => {
    const candidate = buildCandidatePayload("dancehall", emptyFilters);
    const parsed = talentSearchRequestV1Schema.safeParse(candidate);
    assert.equal(parsed.success, true);
    assert.equal(parsed.data.query, "dancehall");
  });

  test("a malformed basedIn countryCode is NOT silently dropped — it reaches the schema and the schema rejects it", () => {
    // Numeric `12` passes the 2-char length check but fails the
    // shared Zod `/^[A-Z]{2}$/` regex. The schema rejects the
    // payload with a field-level error pointing at the countryCode.
    const candidate = buildCandidatePayload("dancehall", withBasedIn({ countryCode: "12" }));
    const parsed = talentSearchRequestV1Schema.safeParse(candidate);
    assert.equal(parsed.success, false);
    assert.ok(
      parsed.error.issues.some((i) => i.path.join(".").includes("basedIn.countryCode")),
      "the rejection must name the basedIn.countryCode path",
    );
  });

  test("a malformed serviceArea countryCode is NOT silently dropped — it reaches the schema and the schema rejects it", () => {
    const candidate = buildCandidatePayload("dancehall", withServiceArea({ countryCode: "12" }));
    const parsed = talentSearchRequestV1Schema.safeParse(candidate);
    assert.equal(parsed.success, false);
    assert.ok(
      parsed.error.issues.some((i) => i.path.join(".").includes("serviceArea.countryCode")),
      "the rejection must name the serviceArea.countryCode path",
    );
  });

  test("a lower-case basedIn countryCode is upper-cased so the schema accepts it", () => {
    const candidate = buildCandidatePayload("dancehall", withBasedIn({ countryCode: "jm" }));
    const parsed = talentSearchRequestV1Schema.safeParse(candidate);
    assert.equal(parsed.success, true);
    assert.equal(parsed.data.required?.basedIn?.countryCode, "JM");
  });

  test("a lower-case serviceArea countryCode is upper-cased so the schema accepts it", () => {
    const candidate = buildCandidatePayload("dancehall", withServiceArea({ countryCode: "gb" }));
    const parsed = talentSearchRequestV1Schema.safeParse(candidate);
    assert.equal(parsed.success, true);
    assert.equal(parsed.data.required?.serviceArea?.countryCode, "GB");
  });

  test("a basedIn city-only constraint survives the schema and is preserved on the request", () => {
    // Brooklyn is the canonical positive control for Marc-André
    // Pierre. The buyer is allowed to constrain basedIn.city without
    // supplying a countryCode; the schema accepts the partial
    // LocationFilter and the builder does not silently drop it.
    const candidate = buildCandidatePayload("dancehall", withBasedIn({ city: "Brooklyn" }));
    const parsed = talentSearchRequestV1Schema.safeParse(candidate);
    assert.equal(parsed.success, true);
    assert.equal(parsed.data.required?.basedIn?.city, "Brooklyn");
    assert.equal(parsed.data.required?.basedIn?.countryCode, undefined);
    assert.equal(parsed.data.required?.basedIn?.region, undefined);
  });

  test("a basedIn region-only constraint survives the schema and is preserved on the request", () => {
    const candidate = buildCandidatePayload("dancehall", withBasedIn({ region: "NY" }));
    const parsed = talentSearchRequestV1Schema.safeParse(candidate);
    assert.equal(parsed.success, true);
    assert.equal(parsed.data.required?.basedIn?.region, "NY");
    assert.equal(parsed.data.required?.basedIn?.countryCode, undefined);
    assert.equal(parsed.data.required?.basedIn?.city, undefined);
  });

  test("a serviceArea city-only constraint survives the schema and is preserved on the request", () => {
    const candidate = buildCandidatePayload("", withServiceArea({ city: "London" }));
    const parsed = talentSearchRequestV1Schema.safeParse(candidate);
    assert.equal(parsed.success, true);
    assert.equal(parsed.data.required?.serviceArea?.city, "London");
  });

  test("a serviceArea region-only constraint survives the schema and is preserved on the request", () => {
    const candidate = buildCandidatePayload("", withServiceArea({ region: "ON" }));
    const parsed = talentSearchRequestV1Schema.safeParse(candidate);
    assert.equal(parsed.success, true);
    assert.equal(parsed.data.required?.serviceArea?.region, "ON");
  });

  test("a fully populated basedIn (city + region + countryCode) is preserved verbatim", () => {
    const candidate = buildCandidatePayload(
      "dancehall",
      withBasedIn({ city: "Brooklyn", region: "NY", countryCode: "US" }),
    );
    const parsed = talentSearchRequestV1Schema.safeParse(candidate);
    assert.equal(parsed.success, true);
    assert.deepEqual(parsed.data.required?.basedIn, {
      city: "Brooklyn",
      region: "NY",
      countryCode: "US",
    });
  });

  test("a fully populated serviceArea (city + region + countryCode) is preserved verbatim", () => {
    const candidate = buildCandidatePayload(
      "dancehall",
      withServiceArea({ city: "London", region: "LDN", countryCode: "GB" }),
    );
    const parsed = talentSearchRequestV1Schema.safeParse(candidate);
    assert.equal(parsed.success, true);
    assert.deepEqual(parsed.data.required?.serviceArea, {
      city: "London",
      region: "LDN",
      countryCode: "GB",
    });
  });

  test("whitespace-only basedIn.city is trimmed and dropped, NOT surfaced as a malformed payload", () => {
    // Buyer types "  " into the basedIn.city input. The builder trims
    // it, sees an empty string, and omits the field rather than
    // sending a value the schema would reject. The rest of the
    // request remains valid.
    const candidate = buildCandidatePayload(
      "dancehall",
      withBasedIn({ city: "   ", countryCode: "JM" }),
    );
    const parsed = talentSearchRequestV1Schema.safeParse(candidate);
    assert.equal(parsed.success, true);
    assert.equal(parsed.data.required?.basedIn?.city, undefined);
    assert.equal(parsed.data.required?.basedIn?.countryCode, "JM");
  });

  test("whitespace-only serviceArea.region is trimmed and dropped, NOT surfaced as a malformed payload", () => {
    const candidate = buildCandidatePayload(
      "dancehall",
      withServiceArea({ region: "   ", countryCode: "GB" }),
    );
    const parsed = talentSearchRequestV1Schema.safeParse(candidate);
    assert.equal(parsed.success, true);
    assert.equal(parsed.data.required?.serviceArea?.region, undefined);
    assert.equal(parsed.data.required?.serviceArea?.countryCode, "GB");
  });

  test("a city whose trimmed length exceeds the 120-character schema bound surfaces a schema-level error", () => {
    // The HTML input caps city at 120 chars, but the builder is
    // pure and accepts any string. A 200-character city must reach
    // the schema and be rejected at the canonical boundary so the
    // browser surfaces a standard envelope rather than silently
    // dropping a field the buyer actually typed.
    const candidate = buildCandidatePayload("dancehall", withBasedIn({ city: "x".repeat(200) }));
    const parsed = talentSearchRequestV1Schema.safeParse(candidate);
    assert.equal(parsed.success, false);
    assert.ok(
      parsed.error.issues.some((i) => i.path.join(".").includes("basedIn.city")),
      "the rejection must name the basedIn.city path",
    );
  });

  test("a single primaryCategoryKey is wrapped in an array and the schema accepts it", () => {
    const candidate = buildCandidatePayload("dancehall", {
      ...emptyFilters,
      primaryCategoryKey: "music-production",
    });
    const parsed = talentSearchRequestV1Schema.safeParse(candidate);
    assert.equal(parsed.success, true);
    assert.deepEqual(parsed.data.required?.primaryCategoryKeys, ["music-production"]);
  });

  test("a single serviceMode is wrapped in an array and the schema accepts it", () => {
    const candidate = buildCandidatePayload("dancehall", {
      ...emptyFilters,
      serviceModes: ["Remote"],
    });
    const parsed = talentSearchRequestV1Schema.safeParse(candidate);
    assert.equal(parsed.success, true);
    assert.deepEqual(parsed.data.required?.serviceModes, ["Remote"]);
  });

  test("all structured filters combined produce a schema-valid structured-only request", () => {
    const candidate = buildCandidatePayload("", {
      primaryCategoryKey: "music-production",
      independentlyPurchasableServiceKey: "mixing",
      serviceModes: ["Remote", "Hybrid"],
      basedIn: { city: "London", region: "LDN", countryCode: "GB" },
      serviceArea: { city: "Brooklyn", region: "NY", countryCode: "US" },
    });
    const parsed = talentSearchRequestV1Schema.safeParse(candidate);
    assert.equal(parsed.success, true);
    assert.equal(parsed.data.query, undefined);
    assert.equal(parsed.data.required?.primaryCategoryKeys?.[0], "music-production");
    assert.equal(parsed.data.required?.independentlyPurchasableServiceKeys?.[0], "mixing");
    assert.deepEqual(parsed.data.required?.serviceModes, ["Remote", "Hybrid"]);
    assert.equal(parsed.data.required?.basedIn?.countryCode, "GB");
    assert.equal(parsed.data.required?.serviceArea?.countryCode, "US");
  });
});

describe("hasUsableCriteria", () => {
  test("empty query and empty filters are not usable", () => {
    assert.equal(hasUsableCriteria("", emptyFilters), false);
  });

  test("a 1-character query is not usable on its own", () => {
    assert.equal(hasUsableCriteria("a", emptyFilters), false);
  });

  test("a 2-character query is usable", () => {
    assert.equal(hasUsableCriteria("ab", emptyFilters), true);
  });

  test("any single non-empty structured filter is usable", () => {
    assert.equal(
      hasUsableCriteria("", { ...emptyFilters, primaryCategoryKey: "music-production" }),
      true,
    );
    assert.equal(
      hasUsableCriteria("", {
        ...emptyFilters,
        independentlyPurchasableServiceKey: "music-production",
      }),
      true,
    );
    assert.equal(hasUsableCriteria("", { ...emptyFilters, serviceModes: ["Remote"] }), true);
    assert.equal(hasUsableCriteria("", withBasedIn({ countryCode: "JM" })), true);
    assert.equal(hasUsableCriteria("", withBasedIn({ region: "NY" })), true);
    assert.equal(hasUsableCriteria("", withBasedIn({ city: "Brooklyn" })), true);
    assert.equal(hasUsableCriteria("", withServiceArea({ countryCode: "GB" })), true);
    assert.equal(hasUsableCriteria("", withServiceArea({ region: "LDN" })), true);
    assert.equal(hasUsableCriteria("", withServiceArea({ city: "London" })), true);
  });

  test("whitespace-only LocationFilter sub-fields are not usable", () => {
    assert.equal(hasUsableCriteria("", withBasedIn({ countryCode: "   " })), false);
    assert.equal(hasUsableCriteria("", withBasedIn({ region: "   " })), false);
    assert.equal(hasUsableCriteria("", withBasedIn({ city: "   " })), false);
    assert.equal(hasUsableCriteria("", withServiceArea({ countryCode: "  " })), false);
    assert.equal(hasUsableCriteria("", withServiceArea({ region: "  " })), false);
    assert.equal(hasUsableCriteria("", withServiceArea({ city: "  " })), false);
  });
});

// QA finding — empty search submissions previously surfaced a
// developer-centric API envelope (`<root> at least one of query,
// required, or preferred must contain criteria`) because the page
// dispatched every submit, including empty ones. The page-level
// guard now intercepts an empty submission before any API request
// is made and renders a buyer-friendly message instead. The pure
// `getEmptySearchSubmissionMessage` decision helper that drives
// that guard has to stay in lock-step with `hasUsableCriteria`
// because the API contract still treats an empty tuple as
// schema-invalid — any divergence would let a tuple the page lets
// through reach the server unchanged, where the rejection would
// once again surface the developer-centric envelope.
describe("getEmptySearchSubmissionMessage (page-level empty-submission guard)", () => {
  test("returns null when the tuple has a usable query or any usable structured filter", () => {
    // Usable query — 2+ characters.
    assert.equal(getEmptySearchSubmissionMessage("ab", emptyFilters), null);
    // Usable structured filter — every shape from `hasUsableCriteria`.
    assert.equal(
      getEmptySearchSubmissionMessage("", {
        ...emptyFilters,
        primaryCategoryKey: "music-production",
      }),
      null,
    );
    assert.equal(
      getEmptySearchSubmissionMessage("", {
        ...emptyFilters,
        independentlyPurchasableServiceKey: "mixing",
      }),
      null,
    );
    assert.equal(
      getEmptySearchSubmissionMessage("", { ...emptyFilters, serviceModes: ["Remote"] }),
      null,
    );
    assert.equal(getEmptySearchSubmissionMessage("", withBasedIn({ countryCode: "JM" })), null);
    assert.equal(getEmptySearchSubmissionMessage("", withBasedIn({ region: "NY" })), null);
    assert.equal(getEmptySearchSubmissionMessage("", withBasedIn({ city: "Brooklyn" })), null);
    assert.equal(getEmptySearchSubmissionMessage("", withServiceArea({ countryCode: "GB" })), null);
    assert.equal(getEmptySearchSubmissionMessage("", withServiceArea({ region: "LDN" })), null);
    assert.equal(getEmptySearchSubmissionMessage("", withServiceArea({ city: "London" })), null);
  });

  test("returns null on a query-only valid search (2+ characters with no filters)", () => {
    // Pins the "valid query-only searches still work" requirement
    // from the QA fix: a query alone is enough to dispatch.
    assert.equal(getEmptySearchSubmissionMessage("dancehall", emptyFilters), null);
  });

  test("returns null on a structured-filter-only valid search (any single filter set, no query)", () => {
    // Pins the "valid structured-filter-only searches still work"
    // requirement from the QA fix: any single populated filter is
    // enough to dispatch.
    assert.equal(
      getEmptySearchSubmissionMessage("", { ...emptyFilters, serviceModes: ["Remote"] }),
      null,
    );
    assert.equal(
      getEmptySearchSubmissionMessage("", {
        ...emptyFilters,
        primaryCategoryKey: "music-production",
        basedIn: { city: "", region: "NY", countryCode: "" },
      }),
      null,
    );
  });

  test("returns the buyer-friendly guidance message when query and filters are both empty", () => {
    // Both empty — guard fires, no API request is dispatched.
    assert.deepEqual(getEmptySearchSubmissionMessage("", emptyFilters), {
      message: EMPTY_SEARCH_GUIDANCE_MESSAGE,
    });
    assert.equal(
      getEmptySearchSubmissionMessage("", emptyFilters)?.message,
      "Add a project description or choose at least one search filter.",
    );
  });

  test("returns the buyer-friendly guidance message when only whitespace is supplied", () => {
    // A 1-character query is below the schema-level minimum of 2;
    // whitespace-only values stay empty after trimming, so the
    // tuple has no usable criteria. Each of these would reach the
    // API unchanged and trigger the developer-centric envelope
    // without the guard.
    assert.deepEqual(getEmptySearchSubmissionMessage("a", emptyFilters), {
      message: EMPTY_SEARCH_GUIDANCE_MESSAGE,
    });
    assert.deepEqual(getEmptySearchSubmissionMessage("   ", emptyFilters), {
      message: EMPTY_SEARCH_GUIDANCE_MESSAGE,
    });
    assert.deepEqual(getEmptySearchSubmissionMessage("a", withBasedIn({ countryCode: "   " })), {
      message: EMPTY_SEARCH_GUIDANCE_MESSAGE,
    });
  });

  test("the guard's tuples align with the schema's empty-tuple rejection (no tuple reaches an API unchanged)", () => {
    // Cross-check: every tuple the page intercepts as `blocked` is
    // also a tuple the shared Zod schema rejects today. Any tuple
    // the helper returns null for must, by construction, build a
    // schema-valid candidate via `buildCandidatePayload`. This
    // pins the contract that the page guard never lets a tuple
    // through to the server that would still trigger the
    // developer-centric envelope.
    const cases: ReadonlyArray<{
      readonly query: string;
      readonly filters: RequiredFiltersValue;
    }> = [
      { query: "", filters: emptyFilters },
      { query: "a", filters: emptyFilters },
      { query: "   ", filters: emptyFilters },
      {
        query: "",
        filters: { ...emptyFilters, basedIn: { city: "", region: "", countryCode: "" } },
      },
      { query: "dancehall", filters: emptyFilters },
      { query: "", filters: { ...emptyFilters, serviceModes: ["Remote"] } },
      { query: "", filters: withBasedIn({ countryCode: "JM" }) },
      { query: "ab", filters: withBasedIn({ city: "Brooklyn" }) },
    ];
    for (const { query, filters } of cases) {
      const guard = getEmptySearchSubmissionMessage(query, filters);
      const candidate = buildCandidatePayload(query, filters);
      const schema = talentSearchRequestV1Schema.safeParse(candidate);
      if (guard !== null) {
        assert.equal(
          schema.success,
          false,
          `guard fired for tuple that the schema accepted: ${JSON.stringify(candidate)}`,
        );
      } else {
        assert.equal(
          schema.success,
          true,
          `guard let tuple through that the schema rejects: ${JSON.stringify(candidate)}`,
        );
      }
    }
  });
});

// M2 (#87) Codex 4th review Finding 8: the matchmaker brief
// submission forwards the buyer's M1 strict required filters to
// the API so a buyer who searched /talent with structured
// constraints does not lose them on the round-trip. The
// `buildRequiredCriteriaPayload` helper produces a typed
// `TalentSearchRequiredCriteriaV1` payload from the form's
// `RequiredFiltersValue` shape (or `undefined` when no axis is
// usable, so the API's `.optional()` field is omitted). Every
// payload must round-trip through the shared search schema —
// the schema is the single authority on which axes survive.
describe("buildRequiredCriteriaPayload — M2 (#87) Finding 8", () => {
  test("returns undefined when the form carries no usable axis (form-only buyer)", () => {
    // The buyer never opened the Filters disclosure on /talent
    // and never supplied a query. The form is empty; the helper
    // must return `undefined` so the API's `.optional()` field
    // is omitted (the buyer submits briefText only, the AI
    // derives everything from the natural-language text).
    const result = buildRequiredCriteriaPayload(emptyFilters);
    assert.equal(result, undefined);
  });

  test("returns the buyer-supplied strict required block when at least one axis is set", () => {
    // A buyer who searched on /talent with `primaryCategoryKey`
    // + `serviceModes: ["Remote"]` + `basedIn.countryCode: "HT"`
    // must not lose any of those axes on the way to the
    // matchmaker. Every field the buyer supplied must be
    // preserved verbatim.
    const filters: RequiredFiltersValue = {
      primaryCategoryKey: "music-production",
      independentlyPurchasableServiceKey: "",
      serviceModes: ["Remote"],
      basedIn: { city: "", region: "", countryCode: "HT" },
      serviceArea: emptyLocation,
    };
    const result = buildRequiredCriteriaPayload(filters);
    assert.notEqual(result, undefined);
    assert.deepEqual(result, {
      primaryCategoryKeys: ["music-production"],
      serviceModes: ["Remote"],
      basedIn: { countryCode: "HT" },
    });
  });

  test("omits empty axes (a single empty input does not poison the others)", () => {
    // The same omission rule as `buildCandidatePayload` so the
    // matchmaker's filter form behaves identically to /talent.
    const filters: RequiredFiltersValue = {
      primaryCategoryKey: "music-production",
      independentlyPurchasableServiceKey: "",
      serviceModes: [],
      basedIn: { city: "", region: "", countryCode: "" },
      serviceArea: { city: "", region: "", countryCode: "" },
    };
    const result = buildRequiredCriteriaPayload(filters);
    assert.notEqual(result, undefined);
    assert.deepEqual(result, {
      primaryCategoryKeys: ["music-production"],
    });
  });

  test("the emitted payload parses against the shared search required schema", () => {
    // Single source of truth: the same `talentSearchRequiredCriteriaV1Schema`
    // that gates the /api/search route gates the matchmaker brief
    // submission. A regression that emits a shape the schema
    // rejects fails this assertion so the buyer cannot end up
    // with a payload the API would silently drop.
    const filters: RequiredFiltersValue = {
      primaryCategoryKey: "music-production",
      independentlyPurchasableServiceKey: "music-production-beat",
      serviceModes: ["Remote", "Hybrid"],
      basedIn: { city: "Brooklyn", region: "NY", countryCode: "US" },
      serviceArea: { city: "", region: "", countryCode: "HT" },
    };
    const result = buildRequiredCriteriaPayload(filters);
    assert.notEqual(result, undefined);
    const parsed = talentSearchRequiredCriteriaV1Schema.safeParse(result);
    assert.equal(
      parsed.success,
      true,
      `helper emitted a payload the shared search schema rejects: ${JSON.stringify(result)}`,
    );
  });
});
