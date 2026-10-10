/* eslint-disable @typescript-eslint/no-floating-promises */
// ResultCard behavioral coverage (post-#83 visual-parity pass).
//
// The pre-existing `SearchPage.test.ts` already covers the match-
// evidence contract (matchReason, qualitative-fit variants, full-
// coverage and required-only fallback wording, no percentage, no
// score-derived band, bundle-only labelling). This file pins the
// NEW visual-parity additions:
//
//   - The card never renders Stitch mock content: no hero photo,
//     no delivery-time promise, no fabricated "View service" link
//     to a per-seller route that does not exist.
//   - When `avatarUrl` is absent the card renders an initials
//     placeholder (so the buyer never sees a broken-image slot).
//   - The avatar renders with `loading="lazy"` + `referrerPolicy`
//     when present (security + performance contract preserved
//     from M1).
//   - Every existing `data-testid` from M1 / M1.6 / M1.7 is preserved.
//   - The card meets the WCAG 2.5.5 44px target on the avatar
//     region so keyboard focus stays usable.
//
// The tests render with `renderToStaticMarkup` and assert on the
// rendered HTML a browser would see.

import { createElement } from "react";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { TalentSearchResultV1 } from "@soundhub/types";
import { ResultCard } from "./ResultCard";
// React must be in scope for the JSX to compile under the test
// tsconfig; the existing FiltersDisclosure.test.tsx relies on the
// same global React import pattern.

const SAMPLE_RESULT: TalentSearchResultV1 = {
  seller: {
    sellerId: "seller-1",
    professionalName: "Marc-André Pierre",
    specialties: ["Producer"],
    bio: "Brooklyn-based Haitian producer.",
    basedIn: { city: "Brooklyn", region: "NY", countryCode: "US" },
    caribbeanAffiliationCodes: ["HT"],
  },
  bestMatchingOffering: {
    offeringId: "offering-1",
    title: "Haitian dancehall single production — remote",
    description: "Remote dancehall single production.",
    primaryCategory: { key: "music-production", name: "Music Production" },
    includedServices: [],
    genreTags: ["Dancehall"],
    serviceMode: "Remote",
    serviceAreas: [{ countryCode: "US" }],
    pricing: {
      kind: "StartingAt",
      amount: { amountMinor: 60000, currency: "USD" },
      unit: "track",
    },
  },
  additionalMatchingOfferings: [],
  relevanceScore: 0.75,
  matchReason: "matched offering title; preferred genre: Dancehall",
  preferenceCoverage: { matched: 1, total: 2 },
};

describe("ResultCard — post-#83 visual-parity truthfulness", () => {
  test("does NOT render Stitch mock content (no hero photo, no delivery time, no fabricated View service link)", () => {
    const html = renderToStaticMarkup(createElement(ResultCard, { result: SAMPLE_RESULT }));

    // The Stitch mock fabricates a hero photo with a stock-image URL.
    // The result card MUST NOT render any image other than the
    // (optional) avatar — and never a Stitch-style hero photo.
    assert.equal(
      html.includes("lighthouse"),
      false,
      "the card MUST NOT render Stitch mock stock-image URLs",
    );
    assert.equal(
      html.includes("lh3.googleusercontent.com"),
      false,
      "the card MUST NOT reference the Stitch mock's stock-image CDN",
    );

    // The Stitch mock fabricates a delivery-time badge ("3-4 Business
    // Days"). The DTO does not carry a delivery promise, so the card
    // MUST NOT render one.
    assert.equal(
      /Business Days?|48-Hour|Rush Ready/i.test(html),
      false,
      "the card MUST NOT render a fabricated delivery-time badge",
    );

    // The Stitch mock links to a per-service detail route that the
    // application does not yet expose. The card MUST NOT render the
    // "View service" affordance as a working link.
    // M2 (#87): the affordance is a <button> that toggles an inline
    // expansion, NOT a <Link> to a public detail page. The contract
    // is now: button only, no href, no <a>.
    assert.equal(
      /href=[^>]*>View service</.test(html),
      false,
      "the card MUST NOT render a View service link to a route the application does not yet expose",
    );
    // The "View service details" affordance is a <button> with no
    // `href` attribute. A regression that re-introduces a public-
    // directory link would fail this assertion.
    assert.equal(
      /<a[^>]*>[^<]*View service details/i.test(html),
      false,
      "View service details MUST NOT be a link (<a>) to a public detail page",
    );
    assert.match(
      html,
      /<button[^>]*type="button"[^>]*data-testid="result-view-service-details"[^>]*>View service details/,
      'the View service details affordance MUST be a <button type="button">',
    );
    assert.match(
      html,
      /aria-expanded="false"[^>]*data-testid="result-view-service-details"|data-testid="result-view-service-details"[^>]*aria-expanded="false"/,
      'the View service details button MUST default to aria-expanded="false"',
    );
  });

  test("renders an initials placeholder (NOT a broken-image slot) when avatarUrl is absent", () => {
    const html = renderToStaticMarkup(createElement(ResultCard, { result: SAMPLE_RESULT }));

    assert.equal(
      html.includes('data-testid="result-seller-avatar"'),
      false,
      "the avatar <img> MUST NOT render when avatarUrl is absent (no broken-image slot)",
    );
    assert.ok(
      html.includes('data-testid="result-seller-initials"'),
      "an initials placeholder MUST render so the buyer always sees a stable seller identifier",
    );
    assert.match(
      html,
      /data-testid="result-seller-initials"[^>]*>M[A-Z]?</,
      "the initials placeholder MUST derive from the professional name (Marc-André → M + A)",
    );
  });

  test("renders the avatar with loading=lazy + referrerPolicy when avatarUrl is present", () => {
    const html = renderToStaticMarkup(
      createElement(ResultCard, {
        result: {
          ...SAMPLE_RESULT,
          seller: {
            ...SAMPLE_RESULT.seller,
            avatarUrl: "https://example.test/avatar.svg",
          },
        },
      }),
    );

    assert.ok(
      html.includes('data-testid="result-seller-avatar"'),
      "the avatar <img> MUST render when avatarUrl is present",
    );
    // Match the avatar <img> tag and assert on the whole attribute list
    // — attribute order is not part of the contract.
    const avatarMatch = html.match(/<img[^>]*data-testid="result-seller-avatar"[^>]*\/>/);
    assert.ok(avatarMatch, "the avatar tag MUST be present as a self-closing <img/>");
    const avatarTag = avatarMatch[0];
    assert.match(
      avatarTag,
      /loading="lazy"/,
      "the avatar MUST use lazy loading to keep result-card scrolls cheap",
    );
    assert.match(
      avatarTag,
      /referrerPolicy="no-referrer"/,
      "the avatar MUST use no-referrer to avoid leaking the referrer to the absolute avatar origin",
    );
  });

  test("preserves every M1 / M1.6 / M1.7 result-card testid", () => {
    const html = renderToStaticMarkup(createElement(ResultCard, { result: SAMPLE_RESULT }));

    const expectedTestids = [
      "result-card",
      "result-seller-name",
      "result-based-in",
      "result-affiliations",
      "result-specialties",
      "result-offering-card",
      "result-offering-title",
      "result-offering-category",
      "result-offering-service-mode",
      "result-offering-service-areas",
      "result-offering-genres",
      "result-offering-pricing",
      "result-offering-pricing-disclaimer",
      "result-match-reason",
      "result-qualitative-fit",
      "result-qualitative-fit-text",
    ];
    for (const testid of expectedTestids) {
      assert.ok(
        html.includes(`data-testid="${testid}"`),
        `M1 contract testid "${testid}" MUST remain in the redesigned result card`,
      );
    }
  });

  test("renders the non-binding pricing disclaimer exactly as the M1 contract required", () => {
    const html = renderToStaticMarkup(createElement(ResultCard, { result: SAMPLE_RESULT }));
    assert.ok(
      html.includes('data-testid="result-offering-pricing-disclaimer"'),
      "pricing-disclaimer testid MUST remain",
    );
    assert.ok(
      html.includes("non-binding") && html.includes("approved terms"),
      "the pricing disclaimer MUST keep its non-binding + approved-terms framing",
    );
  });
});

describe("ResultCard — M2 (#87) buyer-side action surface", () => {
  test("coral Send project request button renders with the right testid", () => {
    const html = renderToStaticMarkup(createElement(ResultCard, { result: SAMPLE_RESULT }));
    assert.match(
      html,
      /<button[^>]*type="button"[^>]*data-testid="result-send-project-request"/,
      "the coral Send project request button MUST render with the result-send-project-request testid",
    );
  });

  test("Send project request is disabled when the callback is undefined", () => {
    const html = renderToStaticMarkup(createElement(ResultCard, { result: SAMPLE_RESULT }));
    const buttonMatch = html.match(/<button[^>]*data-testid="result-send-project-request"[^>]*>/);
    assert.ok(buttonMatch, "Send project request button must be present");
    assert.match(
      buttonMatch[0],
      /(?<!aria-)\bdisabled(?:=|>|$| )/,
      "Send project request MUST be disabled",
    );
    assert.match(
      buttonMatch[0],
      /aria-disabled="true"/,
      "Send project request MUST carry aria-disabled=true",
    );
  });

  test("Send project request is enabled when the callback is provided", () => {
    const html = renderToStaticMarkup(
      createElement(ResultCard, { result: SAMPLE_RESULT, onSendProjectRequest: () => undefined }),
    );
    const buttonMatch = html.match(/<button[^>]*data-testid="result-send-project-request"[^>]*>/);
    assert.ok(buttonMatch, "Send project request button must be present");
    assert.doesNotMatch(
      buttonMatch[0],
      /(?<!aria-)\bdisabled(?:=|>|$| )/,
      "Send project request MUST NOT be disabled",
    );
    assert.doesNotMatch(
      buttonMatch[0],
      /aria-disabled="true"/,
      "Send project request MUST NOT carry aria-disabled=true",
    );
  });

  test("View service details panel is NOT in the DOM by default (collapsed)", () => {
    const html = renderToStaticMarkup(
      createElement(ResultCard, { result: SAMPLE_RESULT, onSendProjectRequest: () => undefined }),
    );
    assert.equal(
      html.includes('data-testid="result-view-service-details-panel"'),
      false,
      "the expansion panel MUST be collapsed by default — no DOM presence until the button is clicked",
    );
  });

  test("the action section never renders a public-directory link (regression gate)", () => {
    const html = renderToStaticMarkup(
      createElement(ResultCard, { result: SAMPLE_RESULT, onSendProjectRequest: () => undefined }),
    );
    // The "Send project request" button is the primary action and
    // is a <button>; the "View service details" affordance is a
    // <button> too. Neither should be an <a> to a public directory.
    assert.equal(
      /<a[^>]*data-testid="result-send-project-request"/.test(html),
      false,
      "Send project request MUST NOT be a link",
    );
    assert.equal(
      /<a[^>]*data-testid="result-view-service-details"/.test(html),
      false,
      "View service details MUST NOT be a link",
    );
  });

  test("the action section preserves the canonical hierarchy: Send project request before View service details", () => {
    const html = renderToStaticMarkup(
      createElement(ResultCard, { result: SAMPLE_RESULT, onSendProjectRequest: () => undefined }),
    );
    const sendIndex = html.indexOf('data-testid="result-send-project-request"');
    const viewIndex = html.indexOf('data-testid="result-view-service-details"');
    assert.ok(sendIndex > 0, "Send project request must render");
    assert.ok(viewIndex > 0, "View service details must render");
    assert.ok(
      sendIndex < viewIndex,
      "Send project request (coral, primary) MUST render before View service details (neutral, secondary)",
    );
  });

  test("Finding 7 — Send project request is disabled with the loading title when the disabled prop is set", () => {
    const html = renderToStaticMarkup(
      createElement(ResultCard, {
        result: SAMPLE_RESULT,
        onSendProjectRequest: () => undefined,
        disabled: true,
        disabledTitle: "Checking your sign-in status…",
      }),
    );
    const buttonMatch = html.match(/<button[^>]*data-testid="result-send-project-request"[^>]*>/);
    assert.ok(buttonMatch, "Send project request button must be present");
    assert.ok(
      / disabled(?=[\s>=])/.test(buttonMatch[0]),
      "Send project request MUST be disabled when the disabled prop is set",
    );
    assert.match(
      buttonMatch[0],
      /title="Checking your sign-in status…"/,
      "Send project request MUST use the loading title when the disabled prop carries a disabledTitle",
    );
  });

  test("Finding 7 — Send project request is enabled when the disabled prop is false and the callback is provided", () => {
    const html = renderToStaticMarkup(
      createElement(ResultCard, {
        result: SAMPLE_RESULT,
        onSendProjectRequest: () => undefined,
        disabled: false,
      }),
    );
    const buttonMatch = html.match(/<button[^>]*data-testid="result-send-project-request"[^>]*>/);
    assert.ok(buttonMatch, "Send project request button must be present");
    assert.doesNotMatch(
      buttonMatch[0],
      / disabled(?=[\s>=])/,
      "Send project request MUST NOT be disabled when the disabled prop is false and the callback is provided",
    );
  });
});
