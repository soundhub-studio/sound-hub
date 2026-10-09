"use client";

// Result card (post-#83 visual-parity pass — Stitch Caribbean Studio).
//
// Background: the Stitch `soundhub_find_caribbean_talent_desktop/code.html`
// renders marketplace cards with a hero photo, category badges, location,
// service description, an audio waveform, and a footer with delivery
// time. The real SoundHub result DTO does NOT carry a hero photo, a
// delivery-time promise, or a fabricated audio waveform. The card
// therefore translates the Stitch visual language over the truthful
// public DTO fields:
//
//   - avatarUrl (optional)        → small circular avatar in the header,
//                                   OR initials placeholder when absent.
//   - seller.professionalName     → headline.
//   - basedIn (city/region/cc)    → location line beneath the headline.
//   - caribbeanAffiliationCodes   → small affiliation chip(s).
//   - seller.specialties          → small specialty chips.
//   - bestMatchingOffering.title  → service title (one line).
//   - offering.description        → 2-line description.
//   - primaryCategory.name        → category badge.
//   - serviceMode                 → small mode chip.
//   - serviceAreas                → small location chip(s).
//   - genreTags                   → small genre chip(s).
//   - pricing                     → formatted price + non-binding disclaimer.
//   - matchReason                 → factual-match card (Issue #6 deterministic
//                                   evidence).
//   - preferenceCoverage / textCoverage / required-only fallback
//                                → qualitative-fit card (Issue #6).
//
// Audio playback is delegated to the existing `AudioSamplesPanel` so
// #61-follow-up sample-eligibility re-checks remain authoritative.
//
// The Stitch's "Delivery: 5-7 Business Days" badge and "View service"
// link are NOT rendered because the DTO does not carry a delivery-time
// promise and the application does not yet expose a per-seller detail
// route. A regression that re-introduces either would silently invent
// product surface the spec has not approved.
//
// All `data-testid` conventions from the M1 result card are preserved
// verbatim so the existing e2e and behavioral tests continue to assert
// against the same identifiers.

import { useState } from "react";
import type { TalentSearchResultV1 } from "@soundhub/types";
import { AudioSamplesPanel } from "./AudioSamplesPanel";
import { formatPricing } from "../lib/pricing";

export interface ResultCardProps {
  readonly result: TalentSearchResultV1;
  /**
   * M2 (#87): buyer-side action handler. When the buyer clicks the
   * coral "Send project request" button on the result, the page
   * wires this to `navigateToMatchmakerFromTalent`. When `undefined`
   * (e.g. a non-wired test render), the button is rendered disabled
   * with `aria-disabled="true"` and a `title` hint. The disabled
   * state is the regression gate: a regression that wires the
   * button to a non-protected command (e.g. a direct
   * `createProjectRequest` call) MUST be caught by the test
   * "Send project request is disabled when the callback is
   * undefined" below.
   */
  readonly onSendProjectRequest?: (result: TalentSearchResultV1) => void;
}

type OfferingDetailVariant = "lead" | "additional";

const OFFERING_DETAIL_STYLES: Record<
  OfferingDetailVariant,
  {
    readonly title: string;
    readonly description: string;
    readonly meta: string;
  }
> = {
  lead: {
    title: "font-serif text-xl text-ink leading-tight",
    description: "text-sm text-muted leading-relaxed line-clamp-2 mt-1",
    meta: "text-xs text-muted mt-2 flex flex-wrap gap-x-3 gap-y-1",
  },
  additional: {
    title: "font-serif text-base text-ink leading-tight",
    description: "text-xs text-muted leading-relaxed mt-0.5",
    meta: "text-xs text-muted mt-1 flex flex-wrap gap-x-3 gap-y-1",
  },
};

export function ResultCard({ result, onSendProjectRequest }: ResultCardProps) {
  const {
    seller,
    bestMatchingOffering,
    additionalMatchingOfferings,
    matchReason,
    preferenceCoverage,
    textCoverage,
  } = result;

  const avatarInitials = initialsFrom(seller.professionalName);

  // M2 (#87): "View service details" inline expansion. The local
  // `useState` is the only state this affordance needs — a
  // regression that introduces a new public-directory route would
  // re-introduce the surface the existing test at lines 88–95
  // explicitly forbids. The button toggles a panel with the full
  // description, all `includedServices`, and the additional-offering
  // disclosure body; it is NOT a link.
  const [detailsOpen, setDetailsOpen] = useState<boolean>(false);
  const detailsPanelId = `result-view-service-details-panel-${result.seller.sellerId}`;

  return (
    <article
      className="bg-surface border border-borderWarm rounded-xl overflow-hidden flex flex-col shadow-sm hover:shadow-md transition-shadow"
      data-testid="result-card"
    >
      <div className="p-5 lg:p-6 flex flex-col gap-4">
        {/* Header: avatar + name + location + affiliation */}
        <header className="flex items-start gap-3">
          {seller.avatarUrl ? (
            /* eslint-disable-next-line @next/next/no-img-element -- the contract
               returns an arbitrary approved absolute URL, which the Next image
               loader would require host allow-listing for. */
            <img
              src={seller.avatarUrl}
              alt={`${seller.professionalName} profile image`}
              className="h-12 w-12 rounded-full object-cover bg-canvas border border-borderWarm shrink-0"
              width={48}
              height={48}
              loading="lazy"
              referrerPolicy="no-referrer"
              data-testid="result-seller-avatar"
            />
          ) : (
            <div
              aria-hidden="true"
              className="h-12 w-12 rounded-full bg-canvas border border-borderWarm flex items-center justify-center text-sm font-medium text-aubergine shrink-0"
              data-testid="result-seller-initials"
            >
              {avatarInitials}
            </div>
          )}
          <div className="flex flex-col min-w-0">
            <h3
              className="font-serif text-xl text-ink leading-tight truncate"
              data-testid="result-seller-name"
            >
              {seller.professionalName}
            </h3>
            <p className="text-sm text-muted truncate" data-testid="result-based-in">
              {formatLocation(seller.basedIn)}
            </p>
            {seller.caribbeanAffiliationCodes.length > 0 && (
              <p className="text-xs text-seaGlass mt-0.5" data-testid="result-affiliations">
                Caribbean affiliation: {seller.caribbeanAffiliationCodes.join(", ")}
              </p>
            )}
          </div>
        </header>

        {/* Specialty chips */}
        {seller.specialties.length > 0 && (
          <div data-testid="result-specialties" className="flex flex-wrap gap-1.5">
            {seller.specialties.map((specialty) => (
              <span
                key={specialty}
                className="px-2 py-0.5 rounded-md bg-canvas border border-borderWarm text-xs text-aubergine"
              >
                {formatSpecialty(specialty)}
              </span>
            ))}
          </div>
        )}

        {/* Best matching offering */}
        <BestOfferingCard offering={bestMatchingOffering} testIdPrefix="result-offering" />

        {/* Additional matching offerings */}
        {additionalMatchingOfferings.length > 0 && (
          <div
            className="border-t border-borderWarm pt-4 mt-1"
            data-testid="result-additional-offerings"
          >
            <p className="text-xs uppercase tracking-wider text-muted mb-2">
              Also available from this seller
            </p>
            <ul className="space-y-3">
              {additionalMatchingOfferings.map((offering) => (
                <li
                  key={offering.offeringId}
                  className="border-l-2 border-borderWarm pl-3"
                  data-testid="result-additional-offering"
                  data-offering-id={offering.offeringId}
                >
                  <OfferingDetail
                    offering={offering}
                    testIdPrefix="result-additional-offering"
                    variant="additional"
                  />
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Bio: only when present and non-trivial */}
        {seller.bio.length > 0 && (
          <p className="text-sm text-muted leading-relaxed line-clamp-3">{seller.bio}</p>
        )}

        {/* Match evidence */}
        <div
          className="bg-canvas border border-borderWarm rounded-lg p-3"
          data-testid="result-match-reason"
        >
          <p className="text-xs font-semibold text-aubergine uppercase tracking-wider mb-1">
            Why this matches
          </p>
          <p className="text-sm text-ink leading-relaxed">{matchReason}</p>
        </div>

        {/* Qualitative fit */}
        {preferenceCoverage && (
          <div
            className="bg-canvas border border-borderWarm rounded-lg p-3"
            data-testid="result-qualitative-fit"
          >
            <p className="text-xs font-semibold text-aubergine uppercase tracking-wider mb-1">
              Preference coverage
            </p>
            <p
              className="text-sm text-ink leading-relaxed"
              data-testid="result-qualitative-fit-text"
            >
              {formatPreferenceCoverage(preferenceCoverage)}
            </p>
          </div>
        )}
        {textCoverage && (
          <div
            className="bg-canvas border border-borderWarm rounded-lg p-3"
            data-testid="result-qualitative-fit"
          >
            <p className="text-xs font-semibold text-aubergine uppercase tracking-wider mb-1">
              Brief coverage
            </p>
            <p
              className="text-sm text-ink leading-relaxed"
              data-testid="result-qualitative-fit-text"
            >
              {formatTextCoverage(textCoverage)}
            </p>
          </div>
        )}
        {!preferenceCoverage && !textCoverage && (
          <div
            className="bg-canvas border border-borderWarm rounded-lg p-3"
            data-testid="result-qualitative-fit"
          >
            <p className="text-xs font-semibold text-aubergine uppercase tracking-wider mb-1">
              Eligibility
            </p>
            <p
              className="text-sm text-ink leading-relaxed"
              data-testid="result-qualitative-fit-text"
            >
              {formatRequiredOnlyFit(matchReason)}
            </p>
          </div>
        )}

        {/* M2 (#87): buyer-side action surface. The coral
            "Send project request" is the primary marketplace
            progression action (matches the spec's "coral =
            marketplace progression only"). The neutral "View
            service details" button toggles an inline expansion
            panel — it is NOT a link and the existing test at
            ResultCard.test.ts:88-95 forbids any href. The
            expansion panel renders the full description and all
            `includedServices` inline. */}
        <div
          className="mt-1 pt-3 border-t border-borderWarm flex flex-col gap-2"
          data-testid="result-actions"
        >
          <button
            type="button"
            onClick={() => {
              if (onSendProjectRequest) {
                onSendProjectRequest(result);
              }
            }}
            disabled={!onSendProjectRequest}
            aria-disabled={!onSendProjectRequest}
            title={
              onSendProjectRequest
                ? "Send a project request to this seller"
                : "Sign in to send a project request"
            }
            className="inline-flex items-center justify-center min-h-[44px] px-4 py-2 rounded-md bg-coral text-white text-sm font-semibold hover:bg-coral-hover disabled:opacity-60 disabled:cursor-not-allowed transition-colors focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-coral"
            data-testid="result-send-project-request"
          >
            Send project request
          </button>
          <button
            type="button"
            onClick={() => setDetailsOpen((open) => !open)}
            aria-expanded={detailsOpen}
            aria-controls={detailsPanelId}
            className="inline-flex items-center justify-center min-h-[44px] px-4 py-2 rounded-md border border-borderWarm bg-canvas text-ink text-sm font-medium hover:bg-surface focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine transition-colors"
            data-testid="result-view-service-details"
          >
            {detailsOpen ? "Hide service details" : "View service details"}
          </button>
        </div>
        {detailsOpen && (
          <div
            id={detailsPanelId}
            className="bg-canvas border border-borderWarm rounded-lg p-3 flex flex-col gap-2"
            data-testid="result-view-service-details-panel"
          >
            {bestMatchingOffering.description.length > 0 && (
              <p className="text-sm text-ink leading-relaxed">{bestMatchingOffering.description}</p>
            )}
            {bestMatchingOffering.includedServices.length > 0 && (
              <p
                className="text-xs text-muted"
                data-testid="result-view-service-details-included-services"
              >
                <span className="font-medium text-aubergine">Bundle includes: </span>
                {bestMatchingOffering.includedServices
                  .map((included) => `${included.name} (bundle only)`)
                  .join(", ")}
              </p>
            )}
            {bestMatchingOffering.serviceAreas.length > 0 && (
              <p className="text-xs text-muted">
                <span className="font-medium text-aubergine">Service area: </span>
                {bestMatchingOffering.serviceAreas.map(formatLocation).join(" · ")}
              </p>
            )}
            {bestMatchingOffering.genreTags.length > 0 && (
              <p className="text-xs text-muted">
                <span className="font-medium text-aubergine">Genres: </span>
                {bestMatchingOffering.genreTags.join(", ")}
              </p>
            )}
            {additionalMatchingOfferings.length > 0 && (
              <div data-testid="result-additional-offerings-body" className="pt-2">
                <p className="text-xs uppercase tracking-wider text-muted font-semibold mb-1">
                  Also available from this seller
                </p>
                <ul className="space-y-2">
                  {additionalMatchingOfferings.map((offering) => (
                    <li
                      key={offering.offeringId}
                      data-testid="result-additional-offering"
                      data-offering-id={offering.offeringId}
                      className="text-xs text-muted"
                    >
                      <span className="font-medium text-ink">{offering.title}</span>
                      <span className="ml-1">
                        ({offering.primaryCategory.name} · {formatServiceMode(offering.serviceMode)}
                        )
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

interface BestOfferingCardProps {
  readonly offering: TalentSearchResultV1["bestMatchingOffering"];
  readonly testIdPrefix: string;
}

function BestOfferingCard({ offering, testIdPrefix }: BestOfferingCardProps) {
  const pricingLabel = formatPricing(offering.pricing);
  return (
    <div className="border-t border-borderWarm pt-4" data-testid={`${testIdPrefix}-card`}>
      <OfferingDetail offering={offering} testIdPrefix={testIdPrefix} variant="lead" />
      <dl className="text-xs text-muted mt-2 space-y-1">
        {offering.serviceAreas.length > 0 && (
          <div className="flex flex-wrap items-baseline gap-x-1.5">
            <dt className="font-medium text-aubergine">Service area:</dt>
            <dd data-testid={`${testIdPrefix}-service-areas`}>
              {offering.serviceAreas.map(formatLocation).join(" · ")}
            </dd>
          </div>
        )}
        {offering.genreTags.length > 0 && (
          <div className="flex flex-wrap items-baseline gap-x-1.5">
            <dt className="font-medium text-aubergine">Genres:</dt>
            <dd data-testid={`${testIdPrefix}-genres`}>{offering.genreTags.join(", ")}</dd>
          </div>
        )}
        <div className="flex flex-wrap items-baseline gap-x-1.5">
          <dt className="font-medium text-aubergine">Pricing:</dt>
          <dd data-testid={`${testIdPrefix}-pricing`}>{pricingLabel ?? "Not advertised"}</dd>
        </div>
      </dl>
      <p
        className="text-xs text-muted mt-2 italic"
        data-testid={`${testIdPrefix}-pricing-disclaimer`}
      >
        {pricingLabel === null
          ? "This seller has not advertised pricing. Any pricing discussed later is non-binding until it is incorporated into approved terms."
          : "Advertised pricing is non-binding and not a quote. It binds no one until it is incorporated into approved terms."}
      </p>
      <AudioSamplesPanel offeringId={offering.offeringId} offeringTitle={offering.title} />
    </div>
  );
}

interface OfferingDetailProps {
  readonly offering: TalentSearchResultV1["bestMatchingOffering"];
  readonly testIdPrefix: string;
  readonly variant: OfferingDetailVariant;
}

function OfferingDetail({ offering, testIdPrefix, variant }: OfferingDetailProps) {
  const styles = OFFERING_DETAIL_STYLES[variant];
  return (
    <>
      <p className={styles.title} data-testid={`${testIdPrefix}-title`}>
        {offering.title}
      </p>
      {offering.description.length > 0 && (
        <p className={styles.description}>{offering.description}</p>
      )}
      <div className={styles.meta}>
        <span>
          <span className="font-medium text-aubergine">Category: </span>
          <span data-testid={`${testIdPrefix}-category`}>{offering.primaryCategory.name}</span>
        </span>
        <span>
          <span className="font-medium text-aubergine">Mode: </span>
          <span data-testid={`${testIdPrefix}-service-mode`}>
            {formatServiceMode(offering.serviceMode)}
          </span>
        </span>
      </div>
      {offering.includedServices.length > 0 && (
        <p className="text-xs text-muted mt-2" data-testid={`${testIdPrefix}-included-services`}>
          <span className="font-medium text-aubergine">Bundle includes: </span>
          {offering.includedServices.map((included) => `${included.name} (bundle only)`).join(", ")}
        </p>
      )}
    </>
  );
}

// "City, Region · CC" while tolerating the optional city/region fields.
function formatLocation(location: { city?: string; region?: string; countryCode: string }): string {
  const locality = [location.city, location.region].filter(Boolean).join(", ");
  return locality ? `${locality} · ${location.countryCode}` : location.countryCode;
}

// First-letter initials from a professional name, uppercased, up to 2
// glyphs. Used when the public DTO does not carry an `avatarUrl` so the
// card never renders a broken-image placeholder.
function initialsFrom(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "·";
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return `${first}${last}`.toUpperCase();
}

// Specialty keys are stable controlled records (for example
// `SoundEngineer`). Presentation-only humanization; the contract value
// is unchanged.
function formatSpecialty(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

function formatServiceMode(mode: TalentSearchResultV1["bestMatchingOffering"]["serviceMode"]) {
  if (mode === "InPerson") return "In person";
  return mode;
}

// Factual preference coverage statement. Counts only — never a percentage,
// never derived from `relevanceScore`. The contract guarantees this helper
// is only called when the buyer supplied at least one canonical preference
// atom; the no-preferences case is rendered by simply skipping this line.
function formatPreferenceCoverage(coverage: {
  readonly matched: number;
  readonly total: number;
}): string {
  if (coverage.matched === coverage.total) {
    return `Matches all ${coverage.total} requested preference${coverage.total === 1 ? "" : "s"}.`;
  }
  const unmet = coverage.total - coverage.matched;
  return `Matches ${coverage.matched} of ${coverage.total} requested preferences; ${unmet} not matched.`;
}

// Factual query-token coverage statement. Counts only — never a percentage,
// never derived from `relevanceScore`. The contract guarantees this helper
// is only called when the buyer supplied at least one usable query.
function formatTextCoverage(coverage: {
  readonly matched: number;
  readonly total: number;
}): string {
  if (coverage.matched === coverage.total) {
    return `Matches all ${coverage.total} word${coverage.total === 1 ? "" : "s"} of your brief.`;
  }
  const unmet = coverage.total - coverage.matched;
  return `Matches ${coverage.matched} of ${coverage.total} words from your brief; ${unmet} not matched.`;
}

// Deterministic, non-percentage qualitative-fit fallback for required-only
// results. Mode-neutral wording ("Eligible for this search.") because the
// optional coverage fields may also be absent on query- or preference-
// bearing searches from in-flight clients.
function formatRequiredOnlyFit(matchReason: string): string {
  const trimmed = matchReason.trim();
  if (trimmed.length === 0) {
    return "Eligible for this search.";
  }
  return `Eligible for this search (${trimmed}).`;
}
