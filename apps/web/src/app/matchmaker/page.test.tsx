/* eslint-disable @typescript-eslint/no-floating-promises */
// Matchmaker page contract tests.
//
// Background: ticket #60 ships the buyer-facing Matchmaker flow.
// The page submits the buyer's natural-language brief to
// /api/matchmaker/brief and renders the resulting eligibility-
// determined recommendations. These tests pin the React boundary
// contract at two layers:
//
//   1. Source-pattern tests pin the page's authoritative code
//      paths (DEFAULT_BRIEF wording, Buyer-capability filter,
//      wired submission, fallback notice element, fact-only
//      explanation rendering) so a refactor cannot silently
//      disconnect the buyer journey.
//
//   2. Runtime tests exercise the extracted
//      `submitBriefFromForm` test seam with a controlled fetch
//      (no live AI, no live database). The success path proves
//      the page actually posts the buyer workspace + brief text
//      AND records the returned recommendations (the page's
//      `setResponse` is exercised end to end). The rejection
//      path proves the page surfaces the error and resets
//      submitting so the form can be used again. Removing the
//      `setResponse(result)` call from the page's submit
//      handler would fail the runtime success test because the
//      recorded response state stays null.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, test } from "node:test";
import type * as React from "react";
import type {
  CategoryMetadataItemV1,
  ProjectBriefPublicV1,
  SubmitBriefRequestV1,
  SubmitBriefResponseV1,
} from "@soundhub/types";
import { submitBriefResponseV1Schema } from "@soundhub/types";
import type { submitBrief as submitBriefFn } from "../lib/matchmaker-client";
import { submitBriefFromForm } from "./submit-brief-from-form.js";
import { BriefSummary } from "./brief-summary.js";

// Canonical Category metadata used by the presentation-coverage
// tests. Mirrors what /api/metadata/categories returns at runtime
// (PostgreSQL is the source of truth; this fixture exists so the
// tests stay network-free).
const EXAMPLE_CATEGORIES: readonly CategoryMetadataItemV1[] = [
  { key: "music-production", name: "Music Production" },
  { key: "songwriting", name: "Songwriting" },
  { key: "mixing", name: "Mixing" },
  { key: "session-vocals", name: "Session Vocals" },
  { key: "live-performance", name: "Live Performance" },
];

const repoRoot = `${new URL("../../../../", import.meta.url).pathname}web`;

function readMatchmakerPage(): string {
  return readFileSync(`${repoRoot}/src/app/matchmaker/page.tsx`, "utf8");
}

// ---------- Runtime tests (controlled fetch) ----------

function buildResponse(override: Partial<SubmitBriefResponseV1> = {}): SubmitBriefResponseV1 {
  return {
    ok: true,
    brief: {
      briefId: "brief-runtime-1",
      actingWorkspaceId: "ws-buyer-runtime",
      createdByUserId: "user-runtime-buyer",
      briefText: "I need a Brooklyn-based producer for a remote Haitian dancehall single.",
      criteria: { required: { primaryCategoryKeys: ["music-production"] } },
      aiProvider: "deterministic-fallback",
      aiModelId: null,
      aiFallbackUsed: true,
      createdAt: "2026-08-26T00:00:00.000Z",
      buyerWorkspace: {
        workspaceId: "ws-buyer-runtime",
        slug: "bg1-demo-buyer",
        name: "BG1 Demo Buyer",
      },
    },
    recommendations: [
      {
        sellerId: "seller-runtime-1",
        professionalName: "Marc-André Pierre",
        bestMatchingOfferingId: "of-runtime-1",
        relevanceScore: 0.9,
        explanations: [
          { kind: "matched-offering-title", label: "Matched the offering title" },
          { kind: "preferred-genre", label: "Preferred genre: Dancehall" },
        ],
        matchReason: "matched offering title; preferred genre: Dancehall",
        bestMatchingOffering: {
          offeringId: "of-runtime-1",
          title: "Haitian dancehall single production — remote",
          description: "Caribbean-flavored dancehall production.",
          primaryCategory: { key: "music-production", name: "Music Production" },
          includedServices: [],
          genreTags: ["Dancehall"],
          serviceMode: "Remote",
          serviceAreas: [{ city: "Brooklyn", region: "NY", countryCode: "US" }],
        },
        seller: {
          sellerId: "seller-runtime-1",
          professionalName: "Marc-André Pierre",
          specialties: ["Producer"],
          bio: "Brooklyn-based producer.",
          basedIn: { city: "Brooklyn", region: "NY", countryCode: "US" },
          caribbeanAffiliationCodes: ["HT"],
        },
        additionalMatchingOfferings: [],
      },
    ],
    totalResults: 1,
    strategy: "postgres-text-v1",
    fallbackNotice: "The AI interpretation used the deterministic fallback.",
    ...override,
  };
}

interface RecordedSubmission {
  readonly url: string;
  readonly body: SubmitBriefRequestV1;
}

let originalFetch: typeof fetch;
let recordedSubmissions: RecordedSubmission[];
let queuedResponse: Response | Error | null;

function installFetchStub(): void {
  originalFetch = globalThis.fetch;
  recordedSubmissions = [];
  queuedResponse = null;
  /* eslint-disable @typescript-eslint/require-await */
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    let body: unknown = undefined;
    const rawBody = init?.body;
    if (typeof rawBody === "string" && rawBody.length > 0) {
      body = JSON.parse(rawBody);
    }
    recordedSubmissions.push({ url, body: body as SubmitBriefRequestV1 });
    if (queuedResponse instanceof Error) {
      throw queuedResponse;
    }
    if (queuedResponse instanceof Response) {
      return queuedResponse;
    }
    return new Response("{}", { status: 500 });
  };
  /* eslint-enable @typescript-eslint/require-await */
}

beforeEach(() => {
  installFetchStub();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("BG3 Matchmaker page runtime submit path", () => {
  test("a successful submission posts the buyer workspace + brief text and records the response", async () => {
    const controlled = buildResponse();
    queuedResponse = new Response(JSON.stringify(controlled), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const setErrorCalls: (string | null)[] = [];
    const setResponseCalls: (SubmitBriefResponseV1 | null)[] = [];
    const setSubmittingCalls: boolean[] = [];

    await submitBriefFromForm({
      actingWorkspaceId: "ws-buyer-runtime",
      briefText: "I need a Brooklyn-based producer for a remote Haitian dancehall single.",
      setError: (value) => setErrorCalls.push(value),
      setResponse: (value) => setResponseCalls.push(value),
      setSubmitting: (value) => setSubmittingCalls.push(value),
    });

    // The runtime path emitted exactly one POST to the documented
    // endpoint with the buyer workspace + trimmed brief text. A
    // refactor that drops the workspace id or replaces the brief
    // text would fail this assertion.
    assert.equal(recordedSubmissions.length, 1);
    const recorded = recordedSubmissions[0]!;
    assert.equal(recorded.url, "/api/matchmaker/brief");
    assert.equal(recorded.body.actingWorkspaceId, "ws-buyer-runtime");
    assert.equal(
      recorded.body.briefText,
      "I need a Brooklyn-based producer for a remote Haitian dancehall single.",
    );
    // The buyer Non-search requirements block is optional and the
    // page does not forward one, so the body must omit it.
    assert.equal(recorded.body.nonSearchRequirements, undefined);

    // The page receives the validated response and records it.
    // This is the assertion that fails if the page's submit
    // handler stops calling setResponse(result) — the recorded
    // state would stay null.
    // setError(null) is called once at the top of the seam to
    // clear stale state; the successful path does not invoke
    // setError again, so the array contains exactly one null.
    assert.equal(setErrorCalls.length, 1);
    assert.equal(setErrorCalls[0], null);
    // The handler clears any stale response before the fetch, so
    // two setResponse calls are expected: null (clear) and the
    // recorded response. The recorded value is the last entry.
    assert.equal(setResponseCalls.length, 2);
    const recordedResponse = setResponseCalls[1]!;
    submitBriefResponseV1Schema.parse(recordedResponse);
    assert.equal(recordedResponse.totalResults, 1);
    assert.equal(recordedResponse.recommendations.length, 1);
    assert.equal(recordedResponse.recommendations[0]?.sellerId, "seller-runtime-1");

    // The submitting flag must toggle: true before the fetch, false
    // after. Without this, the submit button would never re-enable
    // and the buyer could not submit another brief.
    assert.deepEqual(setSubmittingCalls, [true, false]);
  });

  test("a failing submission surfaces the error and resets submitting so the form can be used again", async () => {
    queuedResponse = new Response(
      JSON.stringify({
        error: {
          code: "MATCHMAKER_INVALID_REQUEST",
          message: "ProjectBrief submission failed schema validation.",
          requestId: "req-runtime-1",
        },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
    const setErrorCalls: (string | null)[] = [];
    const setResponseCalls: (SubmitBriefResponseV1 | null)[] = [];
    const setSubmittingCalls: boolean[] = [];

    await submitBriefFromForm({
      actingWorkspaceId: "ws-buyer-runtime",
      briefText: "I need a Brooklyn-based producer for a remote Haitian dancehall single.",
      setError: (value) => setErrorCalls.push(value),
      setResponse: (value) => setResponseCalls.push(value),
      setSubmitting: (value) => setSubmittingCalls.push(value),
    });

    // The fetch fired (the page attempts the request before
    // seeing the error), the response was discarded, and the
    // error message from the safe envelope was surfaced.
    assert.equal(recordedSubmissions.length, 1);
    // setError is called twice (null + the safe-envelope message).
    // setResponse is called once (null, BEFORE the fetch — the
    // catch block does not run setResponse because the fetch
    // throws before the success assignment). The submitting
    // flag toggles true → false.
    assert.equal(setResponseCalls.length, 1);
    assert.equal(setResponseCalls[0], null, "failed submission must not record a response");
    assert.equal(setErrorCalls.length, 2);
    assert.equal(setErrorCalls[0], null);
    assert.match(setErrorCalls[1] ?? "", /ProjectBrief submission failed schema validation/);
    assert.deepEqual(setSubmittingCalls, [true, false], "submitting flag must reset on failure");
  });

  test("a SESSION_INVALID response triggers onSessionInvalid so the page converges on the signed-out state", async () => {
    // Simulate the buyer signing out in another tab (or the cookie
    // expiring) by returning a 401 with the SESSION_INVALID safe
    // envelope code. The seam must invoke onSessionInvalid so the
    // page can refresh the shared BG1 SessionProvider so the header
    // email and workspace list disappear and the Matchmaker page
    // shows its signed-out empty-state.
    queuedResponse = new Response(
      JSON.stringify({
        error: {
          code: "SESSION_INVALID",
          message: "Sign in is required to submit a ProjectBrief.",
          requestId: "req-session-invalid-1",
        },
      }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
    let calls = 0;
    await submitBriefFromForm({
      actingWorkspaceId: "ws-buyer-runtime",
      briefText: "I need a Brooklyn-based producer for a remote Haitian dancehall single.",
      setError: () => {},
      setResponse: () => {},
      setSubmitting: () => {},
      onSessionInvalid: () => {
        calls += 1;
      },
    });
    assert.equal(calls, 1, "SESSION_INVALID response must invoke onSessionInvalid exactly once");
  });

  test("an AUTH_FAILED response also triggers onSessionInvalid (legacy / cross-tab invalidation)", async () => {
    queuedResponse = new Response(
      JSON.stringify({
        error: {
          code: "AUTH_FAILED",
          message: "Magic link is invalid, expired, or already used.",
          requestId: "req-auth-failed-1",
        },
      }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
    let calls = 0;
    await submitBriefFromForm({
      actingWorkspaceId: "ws-buyer-runtime",
      briefText: "I need a Brooklyn-based producer for a remote Haitian dancehall single.",
      setError: () => {},
      setResponse: () => {},
      setSubmitting: () => {},
      onSessionInvalid: () => {
        calls += 1;
      },
    });
    assert.equal(calls, 1, "AUTH_FAILED must also trigger onSessionInvalid");
  });

  test("a non-401 failure does NOT trigger onSessionInvalid", async () => {
    queuedResponse = new Response(
      JSON.stringify({
        error: {
          code: "MATCHMAKER_INVALID_REQUEST",
          message: "ProjectBrief cannot be interpreted.",
          requestId: "req-bad-brief-1",
        },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
    let calls = 0;
    await submitBriefFromForm({
      actingWorkspaceId: "ws-buyer-runtime",
      briefText: "I need a Brooklyn-based producer for a remote Haitian dancehall single.",
      setError: () => {},
      setResponse: () => {},
      setSubmitting: () => {},
      onSessionInvalid: () => {
        calls += 1;
      },
    });
    assert.equal(
      calls,
      0,
      "non-401 failures must NOT trigger onSessionInvalid (the session is still valid)",
    );
  });

  test("a network failure does NOT trigger onSessionInvalid (the session is still valid; only retry)", async () => {
    queuedResponse = new Error("network unreachable");
    let calls = 0;
    await submitBriefFromForm({
      actingWorkspaceId: "ws-buyer-runtime",
      briefText: "I need a Brooklyn-based producer for a remote Haitian dancehall single.",
      setError: () => {},
      setResponse: () => {},
      setSubmitting: () => {},
      onSessionInvalid: () => {
        calls += 1;
      },
    });
    assert.equal(
      calls,
      0,
      "network failures must NOT trigger onSessionInvalid — only HTTP 401 envelope codes do",
    );
  });

  test("a network failure surfaces the error and resets submitting", async () => {
    queuedResponse = new Error("network unreachable");
    const setErrorCalls: (string | null)[] = [];
    const setResponseCalls: (SubmitBriefResponseV1 | null)[] = [];
    const setSubmittingCalls: boolean[] = [];

    await submitBriefFromForm({
      actingWorkspaceId: "ws-buyer-runtime",
      briefText: "I need a Brooklyn-based producer for a remote Haitian dancehall single.",
      setError: (value) => setErrorCalls.push(value),
      setResponse: (value) => setResponseCalls.push(value),
      setSubmitting: (value) => setSubmittingCalls.push(value),
    });

    // The network error throws inside the fetch before the
    // success branch runs. setError is called twice (null + the
    // thrown Error message). setResponse is called once (null,
    // before the fetch). The submitting flag toggles true →
    // false.
    assert.equal(setResponseCalls.length, 1);
    assert.equal(setResponseCalls[0], null);
    assert.equal(setErrorCalls.length, 2);
    assert.equal(setErrorCalls[0], null);
    assert.match(setErrorCalls[1] ?? "", /network unreachable/);
    assert.deepEqual(setSubmittingCalls, [true, false]);
  });

  test("missing workspace selection short-circuits with a validation error and no fetch", async () => {
    const setErrorCalls: (string | null)[] = [];
    const setResponseCalls: (SubmitBriefResponseV1 | null)[] = [];
    const setSubmittingCalls: boolean[] = [];

    await submitBriefFromForm({
      actingWorkspaceId: "",
      briefText: "I need a Brooklyn-based producer for a remote Haitian dancehall single.",
      setError: (value) => setErrorCalls.push(value),
      setResponse: (value) => setResponseCalls.push(value),
      setSubmitting: (value) => setSubmittingCalls.push(value),
    });

    assert.equal(
      recordedSubmissions.length,
      0,
      "must not issue a fetch without an acting workspace",
    );
    // Validation short-circuits before the fetch: setResponse is
    // called once (to clear stale state), setError is called
    // twice (null + the validation message), and no setSubmitting
    // transition occurs.
    assert.equal(setResponseCalls.length, 1);
    assert.equal(setResponseCalls[0], null);
    assert.equal(setErrorCalls.length, 2);
    assert.equal(setErrorCalls[0], null);
    assert.match(setErrorCalls[1] ?? "", /Pick an acting Workspace/);
    assert.deepEqual(
      setSubmittingCalls,
      [],
      "validation short-circuit must not toggle the submitting flag",
    );
  });

  test("an injection-mode submit function receives the buyer workspace + trimmed brief text", async () => {
    // The test seam accepts an injected submit function so the
    // UI test can validate the page's payload contract without
    // exercising the network. A refactor that drops the acting
    // workspace id or fails to trim the brief text would fail
    // this assertion.
    const captured: SubmitBriefRequestV1[] = [];
    /* eslint-disable @typescript-eslint/require-await */
    const fakeSubmit: typeof submitBriefFn = async (input) => {
      captured.push(input);
      return buildResponse();
    };
    /* eslint-enable @typescript-eslint/require-await */
    const setResponseCalls: (SubmitBriefResponseV1 | null)[] = [];

    await submitBriefFromForm({
      actingWorkspaceId: "ws-buyer-injected",
      briefText: "   Brooklyn-based producer for a remote Haitian dancehall single.   ",
      setError: () => {},
      setResponse: (value) => setResponseCalls.push(value),
      setSubmitting: () => {},
      submit: fakeSubmit,
    });

    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.actingWorkspaceId, "ws-buyer-injected");
    assert.equal(
      captured[0]!.briefText,
      "Brooklyn-based producer for a remote Haitian dancehall single.",
      "brief text must be trimmed before submission",
    );
    assert.equal(setResponseCalls.length, 2);
    const recordedResponse = setResponseCalls[1]!;
    submitBriefResponseV1Schema.parse(recordedResponse);
  });
});

// ---------- Presentation coverage (rendered BriefSummary) ----------

describe("BriefSummary presentation coverage", () => {
  // The buyer-facing summary renders every supported criteria axis as
  // a labeled value or chip. These tests use `react-dom/server` to
  // render the extracted `BriefSummary` module with a realistic
  // brief so a regression that drops any axis fails this layer.

  // Lazy import so the file can run in environments without
  // react-dom/server (none of the other tests exercise SSR).
  type RenderFn = (element: React.ReactElement) => string;
  let renderToString: RenderFn | null = null;
  const loadRenderer = async (): Promise<RenderFn> => {
    if (!renderToString) {
      const server = await import("react-dom/server");
      renderToString = (element) => server.renderToString(element);
    }
    return renderToString;
  };

  // Build a ProjectBriefPublicV1 fixture with every supported axis
  // populated. The shapes here match the BG3 runtime contract; if a
  // future ticket changes an axis shape, the corresponding
  // presentation-coverage test fails until the renderer is updated.
  function buildBrief(
    overrides: Partial<ProjectBriefPublicV1["criteria"]> = {},
  ): ProjectBriefPublicV1 {
    return {
      briefId: "brief-test",
      actingWorkspaceId: "ws-buyer-1",
      createdByUserId: "user-1",
      briefText: "I need a Brooklyn-based producer for a remote Haitian dancehall single.",
      aiProvider: "deterministic-fallback",
      aiModelId: null,
      aiFallbackUsed: true,
      createdAt: "2026-08-26T00:00:00.000Z",
      buyerWorkspace: {
        workspaceId: "ws-buyer-1",
        slug: "bg1-demo-buyer",
        name: "BG1 Demo Buyer",
      },
      criteria: {
        required: {
          primaryCategoryKeys: ["music-production"],
          independentlyPurchasableServiceKeys: ["songwriting"],
          serviceModes: ["Remote"],
          basedIn: { city: "Brooklyn", region: "NY", countryCode: "US" },
          serviceArea: { countryCode: "US" },
        },
        preferred: {
          categoryKeys: ["music-production"],
          includedServiceKeys: ["mixing"],
          specialties: ["Producer"],
          genreTags: ["dancehall", "R&B"],
          caribbeanAffiliationCodes: ["HT"],
          basedIn: { city: "Brooklyn", countryCode: "US" },
          serviceModes: ["Remote"],
        },
        query: "brooklyn dancehall producer",
        nonSearchRequirements: {
          fundingDeadline: "march 14",
          customRiderNote: "deliver wav + stems",
        },
        ...overrides,
      },
    };
  }

  test("does NOT render raw criteria JSON", async () => {
    // The original implementation rendered `criteria.required`
    // and `criteria.preferred` as `JSON.stringify(...)`. The
    // human-readable implementation must not include those strings
    // anywhere in the rendered output for a fully-populated brief.
    const render = await loadRenderer();
    const brief = buildBrief();
    const html = render(<BriefSummary brief={brief} categories={EXAMPLE_CATEGORIES} />);
    assert.ok(
      !html.includes("JSON.stringify"),
      "BriefSummary must not call JSON.stringify on the criteria axes",
    );
    assert.ok(
      !html.includes(JSON.stringify(brief.criteria.required)),
      "rendered BriefSummary must not embed the raw Required JSON",
    );
    assert.ok(
      !html.includes(JSON.stringify(brief.criteria.preferred)),
      "rendered BriefSummary must not embed the raw Preferred JSON",
    );
    assert.ok(
      !/&quot;primaryCategoryKeys&quot;/.test(html),
      "rendered BriefSummary must not surface machine keys inside a JSON blob",
    );
  });

  test("renders every Required axis with a labeled chip row", async () => {
    const render = await loadRenderer();
    const brief = buildBrief();
    const html = render(<BriefSummary brief={brief} categories={EXAMPLE_CATEGORIES} />);
    for (const testId of [
      "matchmaker-criteria-required-category",
      "matchmaker-criteria-required-independent-service",
      "matchmaker-criteria-required-service-mode",
      "matchmaker-criteria-required-based-in",
      "matchmaker-criteria-required-service-area",
    ]) {
      assert.ok(html.includes(`data-testid="${testId}"`), `Required section must render ${testId}`);
    }
  });

  test("Preferred section renders every supported axis", async () => {
    const render = await loadRenderer();
    const brief = buildBrief();
    const html = render(<BriefSummary brief={brief} categories={EXAMPLE_CATEGORIES} />);
    for (const testId of [
      "matchmaker-criteria-preferred-category",
      "matchmaker-criteria-preferred-included-service",
      "matchmaker-criteria-preferred-specialty",
      "matchmaker-criteria-preferred-genre",
      "matchmaker-criteria-preferred-affiliation",
      "matchmaker-criteria-preferred-based-in",
      "matchmaker-criteria-preferred-service-mode",
    ]) {
      assert.ok(
        html.includes(`data-testid="${testId}"`),
        `Preferred section must render ${testId}`,
      );
    }
  });

  test("category keys are humanised; localities render as City, Region, Country", async () => {
    const render = await loadRenderer();
    const brief = buildBrief();
    const html = render(<BriefSummary brief={brief} categories={EXAMPLE_CATEGORIES} />);
    // music-production -> Music Production (canonical metadata)
    assert.ok(html.includes("Music Production"), "category must show canonical name");
    // Brooklyn + NY + US collapsed into one chip line; the
    // dynamic segments may carry an inserted React comment node,
    // so a regex with optional HTML-comment tolerance is needed.
    assert.ok(
      /Brooklyn,\s*(?:<!--[^>]*-->)?\s*NY,\s*(?:<!--[^>]*-->)?\s*US/.test(html),
      "Based in must render as City, Region, Country",
    );
    // Required service area has no city / region; just US
    assert.ok(
      /data-testid="matchmaker-criteria-required-service-area"[\s\S]{0,500}>US</.test(html),
      "Service area (no city/region) renders as just the country code",
    );
  });

  test("Search terms renders the criteria.query axis under the new label", async () => {
    const render = await loadRenderer();
    const brief = buildBrief();
    const html = render(<BriefSummary brief={brief} categories={EXAMPLE_CATEGORIES} />);
    assert.ok(html.includes("Search terms"), "the buyer-facing label must read 'Search terms'");
    assert.ok(
      /brooklyn dancehall producer/.test(html),
      "the normalised query string must render under Search terms",
    );
    assert.ok(
      !html.includes("Normalized query"),
      "the legacy 'Normalized query' label must no longer appear",
    );
  });

  test("Other requirements renders every nonSearchRequirement entry with humanised keys", async () => {
    const render = await loadRenderer();
    const brief = buildBrief();
    const html = render(<BriefSummary brief={brief} categories={EXAMPLE_CATEGORIES} />);
    assert.ok(
      html.includes('data-testid="matchmaker-other-requirements"'),
      "Other requirements section must be present",
    );
    // fundingDeadline -> Funding Deadline
    assert.ok(
      html.includes("Funding Deadline"),
      "nonSearchRequirement keys must be humanised (camelCase / snake_case)",
    );
    // customRiderNote -> Custom Rider Note
    assert.ok(
      html.includes("Custom Rider Note"),
      "unknown nonSearchRequirement keys must still render with a humanised label",
    );
    // Values are preserved verbatim
    assert.ok(
      html.includes("march 14") && html.includes("deliver wav + stems"),
      "nonSearchRequirement values must be preserved",
    );
  });

  test("unknown nonSearchRequirement keys are never silently dropped", async () => {
    const render = await loadRenderer();
    const brief = buildBrief({
      nonSearchRequirements: {
        liveSoundCheckRequired: "yes",
        customRiderNote: "extra-long",
        preferred_rider_template: "v1",
      },
    });
    const html = render(<BriefSummary brief={brief} categories={EXAMPLE_CATEGORIES} />);
    // liveSoundCheckRequired -> Live Sound Check Required
    assert.ok(
      html.includes("Live Sound Check Required"),
      "every nonSearchRequirement key must render with a humanised label",
    );
    // preferred_rider_template -> Preferred Rider Template
    assert.ok(html.includes("Preferred Rider Template"), "snake_case keys must also be humanised");
  });

  test("missing axes are silently omitted (no empty rows)", async () => {
    const render = await loadRenderer();
    // Empty required + preferred + query + nonSearch.
    const brief = buildBrief();
    brief.criteria.required = {
      primaryCategoryKeys: [],
      independentlyPurchasableServiceKeys: [],
      serviceModes: [],
      basedIn: undefined,
      serviceArea: undefined,
    };
    delete brief.criteria.preferred;
    delete brief.criteria.query;
    delete brief.criteria.nonSearchRequirements;
    const html = render(<BriefSummary brief={brief} categories={EXAMPLE_CATEGORIES} />);
    // The shell containers are present but their inner chip rows
    // are not rendered when the axis is empty.
    // The shell container stays mounted so the surrounding dt label
    // (e.g. "Required criteria") reads consistently, but the chip
    // row itself is omitted when the axis is empty (the row component
    // returns null on empty input).
    assert.ok(
      html.includes('data-testid="matchmaker-criteria-required"'),
      "Required section shell must remain mounted",
    );
    assert.ok(
      !html.includes('data-testid="matchmaker-criteria-required-category-chip"'),
      "Required categories chip row should be omitted when axis is empty",
    );
    assert.ok(
      !html.includes('data-testid="matchmaker-criteria-preferred"'),
      "Preferred section should be omitted when preferred is absent",
    );
    assert.ok(
      !html.includes('data-testid="matchmaker-search-terms"'),
      "Search terms chip should be omitted when query is absent",
    );
    assert.ok(
      !html.includes('data-testid="matchmaker-other-requirements"'),
      "Other requirements section should be omitted when empty",
    );
    // Provenance + Original brief still render
    assert.ok(html.includes('data-testid="matchmaker-provenance"'));
  });

  test("provenance + fallback information is preserved", async () => {
    const render = await loadRenderer();
    const brief = buildBrief();
    brief.aiProvider = "deterministic-fallback";
    brief.aiModelId = null;
    brief.aiFallbackUsed = true;
    const html = render(<BriefSummary brief={brief} categories={EXAMPLE_CATEGORIES} />);
    // Buyer-friendly label: "Interpretation method: Deterministic"
    // when the deterministic fallback path produced the criteria,
    // "Interpretation method: Managed AI" when the managed path
    // produced them. The buyer never sees the internal
    // `deterministic-fallback` string or a contradictory
    // "Fallback: no" indicator.
    assert.ok(
      /Interpretation method:[\s\S]*?Deterministic/.test(html),
      "buyer-friendly provenance label must surface 'Deterministic' for the fallback path",
    );
    assert.ok(
      !html.includes("deterministic-fallback"),
      "raw provider key must not leak to the buyer UI",
    );
    assert.ok(
      !html.includes("Fallback: "),
      "the 'Fallback: yes/no' indicator must not appear in the buyer UI",
    );
    assert.ok(html.includes('data-testid="matchmaker-provenance"'));
    assert.ok(html.includes('data-testid="matchmaker-provenance-method"'));
  });

  test("provenance label surfaces 'Managed AI' when the managed path produced the criteria", async () => {
    const render = await loadRenderer();
    const brief = buildBrief();
    brief.aiProvider = "managed";
    brief.aiModelId = "qwen3.6-27b";
    brief.aiFallbackUsed = false;
    const html = render(<BriefSummary brief={brief} categories={EXAMPLE_CATEGORIES} />);
    assert.ok(
      /Interpretation method:[\s\S]*?Managed AI/.test(html),
      "managed-path briefs must surface 'Managed AI' as the interpretation method",
    );
    assert.ok(
      !html.includes("qwen"),
      "raw model id must not leak to the buyer UI (kept on the DTO for ops)",
    );
  });
});

// ---------- Source-pattern contract tests ----------

describe("BG3 Matchmaker page source contract", () => {
  test("M2 (#87) 5th review — page no longer ships a sample DEFAULT_BRIEF (Finding 2 — truthful brief)", () => {
    // M2 (#87) 5th review: the matchmaker MUST derive the brief
    // text from the saved query + structured criteria. The
    // previous DEFAULT_BRIEF sample copy ("I need a Brooklyn-
    // based producer...") was a spec violation: it invented
    // requirements the buyer never expressed. The page now
    // composes a brief from the recovered record via
    // `deriveTruthfulBrief` instead of falling back to a sample
    // string. The Brooklyn-based wording still survives inside
    // the deterministic adapter's LOCATION_PHRASES table (the
    // adapter's vocabulary), but the matchmaker page must NOT
    // pre-fill a buyer-visible brief with invented copy.
    const source = readMatchmakerPage();
    assert.ok(
      !/DEFAULT_BRIEF\s*=/.test(source),
      "matchmaker page MUST NOT export a sample DEFAULT_BRIEF constant (Finding 2 — truthful brief from saved query + criteria)",
    );
    assert.ok(
      !/I need a Brooklyn-based producer/i.test(source),
      "matchmaker page MUST NOT contain the invented Brooklyn-based producer sample copy (Finding 2)",
    );
  });

  test("buyer submission delegates to the test seam and forwards actingWorkspaceId + briefText + required", () => {
    const source = readMatchmakerPage();
    // The page MUST route the form submit through the test seam
    // so the runtime UI test can exercise the full payload +
    // response + error handling path. Removing this delegation
    // would break the runtime UI test's success case.
    assert.match(
      source,
      /await submitBriefFromForm\(\{/,
      "buyer page must delegate to submitBriefFromForm test seam",
    );
    // M2 (#87) Finding 8: the page MUST forward the buyer's
    // M1 strict required filters to the brief submission so the
    // API applies them verbatim (the AI never relaxes a
    // buyer-supplied hard axis). The forward may use a
    // conditional spread; the regex tolerates either ordering.
    assert.match(
      source,
      /required\s*[:?]/,
      "buyer page must forward the buyer-supplied `required` M1 strict criteria to the brief submission",
    );
    assert.match(
      source,
      /setError,\s*setResponse,\s*setSubmitting/,
      "buyer page must forward the three state setters",
    );
  });

  test("buyer page filters workspaces by Buyer capability", () => {
    const source = readMatchmakerPage();
    assert.match(
      source,
      /capabilities\.includes\("Buyer"\)/,
      "buyer page must filter acting workspaces by Buyer capability",
    );
    assert.match(
      source,
      /data-testid="matchmaker-no-buyer-workspace"/,
      "buyer page must surface the empty-state when no Buyer-capable Workspace is available",
    );
  });

  test("buyer page surfaces AI provenance + fallback notice", () => {
    // Provenance + fallback notice live in the extracted BriefSummary
    // module (page.tsx is a Next.js page component and cannot export
    // additional named exports). Read that module's source for the
    // patterns the buyer sees.
    const summarySource = readFileSync(`${repoRoot}/src/app/matchmaker/brief-summary.tsx`, "utf8");
    const pageSource = readMatchmakerPage();
    assert.match(
      pageSource,
      /data-testid="matchmaker-fallback-notice"/,
      "buyer page must surface the fallback notice when the deterministic fallback ran",
    );
    assert.match(
      summarySource,
      /Interpretation method:/,
      "BriefSummary module must render the buyer-friendly 'Interpretation method:' provenance label",
    );
    assert.match(
      summarySource,
      /brief\.aiProvider === "managed" \? "Managed AI" : "Deterministic"/,
      "BriefSummary module must map the provider key to a buyer-friendly label",
    );
    assert.doesNotMatch(
      summarySource,
      /Provider: \{brief\.aiProvider\}/,
      "BriefSummary module must NOT render the legacy 'Provider:' label",
    );
    assert.doesNotMatch(
      summarySource,
      /Fallback: \{brief\.aiFallbackUsed/,
      "BriefSummary module must NOT render the legacy 'Fallback: yes/no' indicator",
    );
  });

  test("buyer page renders the human-readable summary from the extracted module", () => {
    const pageSource = readMatchmakerPage();
    const summarySource = readFileSync(`${repoRoot}/src/app/matchmaker/brief-summary.tsx`, "utf8");
    // The page renders BriefSummary from the dedicated module so
    // the criterion axes have presentation coverage (Codex UI
    // feedback). The page must wire the categories fetch + brief
    // payload; the module must render every Required + Preferred
    // axis and the Other Requirements list.
    assert.match(
      pageSource,
      /<BriefSummary brief=\{response\.brief\} categories=\{categories\} \/>/,
      "page must render BriefSummary with both brief and categories props",
    );
    // Shell containers use literal data-testid attributes.
    for (const shell of [
      "matchmaker-criteria-required",
      "matchmaker-criteria-preferred",
      "matchmaker-other-requirements",
      "matchmaker-search-terms",
      "matchmaker-provenance",
    ]) {
      assert.match(
        summarySource,
        new RegExp(`data-testid="${shell}"`),
        `BriefSummary must render the ${shell} section`,
      );
    }
    // Axis rows are driven by a dynamic `testId` prop. Verify the
    // module enumerates each Required + Preferred axis and feeds
    // them through the same `data-testid={testId}` binding.
    for (const axisLabel of [
      "Category",
      "Independently purchasable service",
      "Service mode",
      "Based in",
      "Service area",
      "Included service",
      "Specialty",
      "Genre",
      "Caribbean affiliation",
    ]) {
      assert.ok(
        summarySource.includes(`label="${axisLabel}"`),
        `BriefSummary must include a row labeled "${axisLabel}"`,
      );
    }
  });

  test("buyer page renders factual explanations (no AI-invented text)", () => {
    const source = readMatchmakerPage();
    assert.match(
      source,
      /data-testid="matchmaker-explanation-item"/,
      "buyer page must render each explanation entry from the validated DTO",
    );
    assert.match(
      source,
      /recommendation\.explanations\.map\(/,
      "buyer page must drive the explanations list off the DTO, not a generated string",
    );
  });
});

describe("M2 (#87) Matchmaker page — Talent continuation contract", () => {
  test("brief is initialized from the recovered Talent continuation record (Finding 3 — pre-fill restored brief)", () => {
    // M2 (#87) acceptance criterion #11: brief/filter state is
    // preserved across the auth/intent round-trip. The matchmaker
    // MUST initialize briefText from the recovered query so the
    // buyer does not have to re-type the brief they composed on
    // /talent after onboarding. M2 (#87) 5th review: the brief
    // MUST be derived truthfully from the saved query +
    // structured criteria; the page MUST NOT fall back to an
    // invented DEFAULT_BRIEF.
    const source = readMatchmakerPage();
    assert.match(
      source,
      /deriveTruthfulBrief\(readTalentMatchmakerContext\(\)\)/,
      "Matchmaker page MUST initialize briefText via deriveTruthfulBrief(readTalentMatchmakerContext())",
    );
    assert.match(
      source,
      /function deriveTruthfulBrief\(record: TalentMatchmakerContext \| null\)/,
      "deriveTruthfulBrief must accept the recovered record shape",
    );
    // The 5th review: a 2–7 character query must not fail
    // Matchmaker validation, and filter-only searches must not
    // fall back to unrelated DEFAULT_BRIEF content. The page
    // composes a brief from the saved query + structured
    // criteria instead of inventing a sample brief.
    assert.ok(
      !/I need a Brooklyn-based producer/i.test(source),
      "Matchmaker page MUST NOT contain the invented DEFAULT_BRIEF sample copy (Finding 2 — truthful brief from saved query + criteria)",
    );
    assert.match(
      source,
      /composeBriefFromCriteria/,
      "Matchmaker page MUST compose a brief from the saved structured criteria when the recovered query is empty (Finding 2 — filter-only path)",
    );
  });

  test("Talent continuation is cleared on Send project request SUCCESS only (Finding 4 — no clear on failure)", () => {
    // M2 (#87) acceptance criterion: a successful Send project
    // request is the terminal boundary that clears the Talent
    // continuation record. A failure MUST leave the record in
    // place so the buyer can retry without a new /talent round-
    // trip. A regression that clears on every completion (success
    // or failure) would make the Back to talent link reappear
    // and the highlight survive a request the buyer did not
    // actually send.
    const source = readMatchmakerPage();
    // The clear call MUST live inside the setSuccess callback,
    // NOT inside setSubmitting. We assert by counting clear calls
    // and verifying the one that exists lives next to setSuccess.
    const submitClearCall = /setSubmitting[^}]+clearTalentMatchmakerContext\(\)/.test(source);
    assert.equal(
      submitClearCall,
      false,
      "Talent continuation MUST NOT be cleared inside the setSubmitting callback (would clear on every completion, including failures)",
    );
    const successClearCall = /setSuccess:[^,]+=>\s*\{[^}]*clearTalentMatchmakerContext\(\);/m.test(
      source,
    );
    assert.ok(
      successClearCall,
      "Talent continuation MUST be cleared inside the setSuccess callback so a successful Send project request is the terminal boundary",
    );
  });

  // M2 (#87) P1 — Codex 4th review Finding 11. The matchmaker's
  // signed-out card carried a "Sign in to continue" CTA whose
  // href was `/login?return=/matchmaker?from=talent`. A brand-new
  // sign-in then lands on /matchmaker with no Buyer capability
  // and hits the no-Buyer dead-end. The CTA must route through
  // /workspace/intent first so a new user is provisioned with
  // Buyer capability (or can use the Buyer-only skip link) before
  // reaching /matchmaker.
  test("signed-out Sign-in CTA chains through /workspace/intent to provision Buyer capability (Finding 11)", () => {
    const source = readMatchmakerPage();
    // The chained return MUST be exactly the one the talent page
    // uses (single source of truth for the cross-flow routing).
    assert.match(
      source,
      /\/login\?return=\/workspace\/intent\?return=\/matchmaker/,
      "matchmaker signed-out CTA MUST route through /workspace/intent before reaching /matchmaker (chain return so a brand-new account is provisioned with Buyer capability)",
    );
    // A regression that re-introduces the direct
    // /login?return=/matchmaker href (no chain) fails this assertion.
    assert.ok(
      !/href="\/login\?return=\/matchmaker\?from=talent"/.test(source),
      "matchmaker signed-out CTA MUST NOT use the direct /login?return=/matchmaker href (would land a brand-new account on the no-Buyer dead-end)",
    );
  });

  // M2 (#87) Finding 8 — apply recovered strict filters to
  // Matchmaker. The matchmaker brief form MUST keep M1 strict
  // required filters available through progressive disclosure
  // and MUST pre-fill them from the recovered Talent continuation
  // record. The brief submission MUST forward them to the API
  // verbatim so the AI never relaxes a buyer-supplied hard
  // axis. This is the spec acceptance criterion that the
  // /talent → /matchmaker round-trip does not lose the buyer's
  // structured search constraints (including a filter-only
  // search).
  test("Finding 8 — matchmaker renders M1 strict filters via progressive disclosure and pre-fills from the recovered record", () => {
    const source = readMatchmakerPage();
    // The matchmaker MUST render the same `RequiredFilters`
    // component used on /talent so the M1 contract (progressive
    // disclosure of structured required filters) is honored.
    assert.match(
      source,
      /import\s*\{[^}]*RequiredFilters[^}]*\}\s*from\s*["']\.\.\/components\/RequiredFilters["']/,
      "matchmaker page MUST import the RequiredFilters component to keep M1 strict required filters available through progressive disclosure",
    );
    assert.match(
      source,
      /<RequiredFilters/,
      "matchmaker page MUST render the RequiredFilters component (the M1 strict filter surface)",
    );
    // The page MUST pre-fill the filters from the recovered
    // Talent continuation record (lazy initializer — same shape
    // as the brief pre-fill).
    assert.match(
      source,
      /deriveInitialFilters\(readTalentMatchmakerContext\(\)\)/,
      "matchmaker page MUST pre-fill the strict required filters from the recovered Talent continuation record (Finding 8)",
    );
    // The page MUST forward the strict required filters to the
    // brief submission so the API applies them verbatim.
    assert.match(
      source,
      /buildRequiredCriteriaPayload\(requiredFilters\)/,
      "matchmaker page MUST convert the form's RequiredFiltersValue into a TalentSearchRequiredCriteriaV1 payload before submitting the brief (Finding 8)",
    );
    // The page MUST force the disclosure open when the
    // recovered record carries any pre-filled filter value so
    // the buyer can see the recovered state on first paint.
    assert.match(
      source,
      /forceOpen=\{forceFiltersOpen\}/,
      "matchmaker page MUST force the FiltersDisclosure open when the recovered record carries pre-filled filter values (Finding 8)",
    );
  });

  // M2 (#87) 5th review Finding 2: the brief is derived from the
  // saved query + structured criteria (truthful), and a 2–7 char
  // query does not fail Matchmaker's briefText schema (≥ 8 chars
  // after normalization). The page MUST NOT contain the
  // invented DEFAULT_BRIEF copy ("I need a Brooklyn-based
  // producer...") — that was a real spec violation pinned by
  // Codex 5th review.
  test("Finding 2 — brief is derived from saved query + structured criteria, not invented (5th review)", () => {
    const source = readMatchmakerPage();
    // The page MUST derive the brief from query + criteria.
    assert.match(
      source,
      /deriveTruthfulBrief\(readTalentMatchmakerContext\(\)\)/,
      "matchmaker page MUST initialize briefText via deriveTruthfulBrief (query + criteria, not invented copy)",
    );
    // The page MUST compose a brief from the structured criteria
    // when the recovered query is empty (filter-only search).
    assert.match(
      source,
      /composeBriefFromCriteria/,
      "matchmaker page MUST compose a brief from the saved structured criteria when the query is empty (filter-only path)",
    );
    // The page MUST NOT contain the invented DEFAULT_BRIEF.
    assert.ok(
      !/I need a Brooklyn-based producer/i.test(source),
      "matchmaker page MUST NOT contain the invented DEFAULT_BRIEF sample copy (Finding 2 — truthful brief)",
    );
  });

  // M2 (#87) 5th review Finding 3: the saved offeringId is
  // located in either `bestMatchingOffering` or
  // `additionalMatchingOfferings` and is the one used by Send
  // project request. The page imports the helper from a
  // dedicated module (the helper cannot be a page-module
  // export — Next.js enforces a strict default + route-only
  // export surface).
  test("Finding 3 — saved offeringId is located across both best and additional offerings (5th review)", () => {
    const source = readMatchmakerPage();
    // The page MUST import the helper from its own module.
    assert.match(
      source,
      /import\s*\{\s*findSavedOfferingId\s*,\s*selectTargetOffering\s*\}\s*from\s*["']\.\/find-saved-offering-id["']/,
      "matchmaker page MUST import findSavedOfferingId and selectTargetOffering from ./find-saved-offering-id (the helpers cannot be page-module exports)",
    );
    // The page MUST use the helper to drive the highlight.
    assert.match(
      source,
      /findSavedOfferingId\(recommendation,\s*highlightedOfferingId\)/,
      "matchmaker page MUST use findSavedOfferingId to drive the row highlight (Finding 3)",
    );
    // The page MUST pass a `targetOfferingId` to `onInvite` so
    // the Send project request targets the saved offering
    // (not the row's best matching offering) when the saved
    // offering is in `additionalMatchingOfferings`.
    assert.match(
      source,
      /onInvite=\{[^}]*targetOfferingId[^}]*\}/,
      "matchmaker page MUST pass a targetOfferingId to onInvite so Send project request targets the saved offering (Finding 3)",
    );
    // The page MUST forward the targetOfferingId to the
    // inviteFromRecommendation seam so the API receives the
    // saved offering's id (NOT the row's best matching
    // offering).
    assert.match(
      source,
      /targetOfferingId:\s*offeringId/,
      "matchmaker page MUST forward targetOfferingId to the inviteFromRecommendation seam (Finding 3)",
    );
  });

  // M2 (#87) 6th review Finding 16: the `submitting` comparison
  // must use a stable per-row target id (saved offering or
  // best-matching fallback). A `null === null` comparison would
  // light up every row's "Inviting…" label on initial mount
  // before any invite starts, and disable the buttons (the
  // `disabled` check is any-in-flight, but the per-row
  // `submitting` prop is supposed to reflect ONLY the in-flight
  // row's id match).
  test("Finding 16 — `submitting` comparison uses a stable per-row target id (6th review)", () => {
    const source = readMatchmakerPage();
    // The page MUST derive an `effectiveTargetOfferingId` that
    // falls back to the row's bestMatchingOffering.offeringId
    // when the Talent recovery is absent. The fallback
    // guarantees the comparison resolves to a unique id per row
    // on initial mount.
    assert.match(
      source,
      /effectiveTargetOfferingId\s*=\s*targetOfferingId\s*\?\?/,
      "matchmaker page MUST derive an effective target id that falls back to the row's best matching offering when the Talent recovery is absent (Finding 16)",
    );
    // The `submitting` prop MUST compare against the effective
    // target id, not the (potentially null) saved offering id.
    assert.match(
      source,
      /submitting=\{invitingRecommendationId\s*===\s*effectiveTargetOfferingId\}/,
      "matchmaker page MUST compare `submitting` against the effective target id, not the saved offering id (Finding 16)",
    );
  });

  // M2 (#87) 6th review Finding 17: the row MUST display the
  // target offering's summary (title, category, audio preview,
  // button offering-id) so the buyer reviews the exact offering
  // the Send project request will target. When the saved
  // offering is in `additionalMatchingOfferings`, the row must
  // show the additional offering's title — not the row's best
  // matching offering's title.
  test("Finding 17 — row displays the target offering, not the best matching offering (6th review)", () => {
    const source = readMatchmakerPage();
    // The page MUST import the new helper.
    assert.match(
      source,
      /import\s*\{\s*findSavedOfferingId,\s*selectTargetOffering\s*\}\s*from\s*["']\.\/find-saved-offering-id["']/,
      "matchmaker page MUST import selectTargetOffering from the helper module (Finding 17)",
    );
    // The page MUST call `selectTargetOffering` per recommendation
    // so every row gets the correct target offering.
    assert.match(
      source,
      /selectTargetOffering\([\s\S]*?rec[\s\S]*?highlightedOfferingId/,
      "matchmaker page MUST call selectTargetOffering(rec, highlightedOfferingId) to compute the per-row target offering (Finding 17)",
    );
    // The RecommendationItem MUST accept the target offering
    // and use it for the displayed title, audio, and button id.
    assert.match(
      source,
      /targetOffering:\s*PublicOfferingSummaryV1/,
      "RecommendationItem MUST accept a targetOffering: PublicOfferingSummaryV1 prop (Finding 17)",
    );
    // The displayed title MUST be the target offering's title.
    assert.match(
      source,
      /targetOffering\.title/,
      "RecommendationItem MUST render targetOffering.title (Finding 17 — buyer reviews the offering the request will target)",
    );
    // The audio preview toggle MUST target the row's target
    // offering id (not the row's best matching offering id).
    assert.match(
      source,
      /fetchRecommendationAudioPreview\(targetOffering\.offeringId\)/,
      "RecommendationItem MUST fetch the audio preview for targetOffering.offeringId (Finding 17)",
    );
    // The button's data-offering-id MUST match the target.
    assert.match(
      source,
      /data-offering-id=\{targetOffering\.offeringId\}/,
      "Send project request button MUST label the target offering id, not the best matching offering id (Finding 17)",
    );
  });
});
