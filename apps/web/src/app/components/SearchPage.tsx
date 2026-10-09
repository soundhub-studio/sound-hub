"use client";

// Public Talent search page (post-#83 visual-parity pass — Stitch Caribbean Studio).
//
// Background: the post-#83 visual pass replaces the previous
// debug-form-look search surface with the Stitch
// `soundhub_find_caribbean_talent_desktop/code.html` composition —
// editorial heading + natural-language search surface + Filters
// disclosure + discipline chips + truthful result cards. The
// presentation changed; the search behavior did not.
//
// Behavioral authority (M2 #83 — unchanged by this pass):
//
//   - search endpoint contracts — POST /api/search, unchanged.
//   - TalentSearchService behavior — unchanged.
//   - strict-filter semantics — required.* fields are exclusionary and
//     are NOT relaxed on empty results.
//   - canonical categories — fetched once from
//     `GET /api/metadata/categories`; the chips row and the category
//     filter dropdown BOTH read from the same response so the on-page
//     discipline chips never drift from the strict-filter dropdown.
//   - eligibility logic — unchanged.
//   - authorization — public anonymous + signed-in access; no capability
//     gate; the dashboard `Choose intent` CTA handles Personal-only
//     provisioning separately.
//   - result DTOs — unchanged. The result card renders ONLY the
//     truthful public DTO fields (no fabricated names, locations,
//     hero photos, delivery times, or audio waveforms).
//   - search request construction — the same `buildCandidatePayload`
//     helper in `talent-search-request-builder.ts` owns the wire
//     shape; the page only composes its `RequiredFiltersValue` from
//     the canonical metadata and submits.
//
// Filters disclosure contract:
//
//   - All strict filters live inside the `FiltersDisclosure` wrapper.
//     The disclosure is closed by default and reveals the structured
//     filters on click, mirroring the Stitch composition. Every
//     underlying field, its `data-testid`, and its field-error
//     rendering are owned by `RequiredFilters.tsx`; this page never
//     touches them.
//   - The disclosure's `Reset` button is wired to a no-op that clears
//     every sub-field through the canonical `RequiredFiltersValue`
//     path; it does NOT clear the free-text query.
//
// Discipline chips contract:
//
//   - The chips render the canonical category metadata fetched from
//     `/api/metadata/categories`. They are NEVER hard-coded because
//     the post-#83 visual-parity brief explicitly forbids that.
//   - Clicking a chip toggles the `primaryCategoryKey` filter. The
//     click does NOT submit; the buyer still hits the coral
//     "Find talent" CTA (or Enter on the input) to dispatch.
//   - The chips are a presentation shortcut to the primary-category
//     filter dropdown inside the Filters disclosure — both paths set
//     the same `primaryCategoryValue`, so the count badge on the
//     Filters toggle reflects the chip selection immediately.
//
// Truthfulness rule (Stitch brief):
//
//   The Stitch mock contains illustrative marketplace content. This
//   page renders:
//     - real search results when the API returns them
//     - the truthful empty state when no results match
//     - the truthful loading state while the request is in flight
//     - the truthful error state when the request fails
//   It does NOT port fictional creator data from the Stitch mock.

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { isRetriableErrorCode, useSearch } from "../hooks/useSearch";
import {
  getEmptySearchSubmissionMessage,
  hasUsableCriteria,
  type RequiredFiltersValue,
} from "../lib/talent-search-request-builder";
import { isControlledRequiredPath } from "../lib/field-error-paths";
import { Card } from "./ui/Card";
import { SearchForm } from "./SearchForm";
import { RequiredFilters } from "./RequiredFilters";
import { ResultCard } from "./ResultCard";
import { FiltersDisclosure } from "./FiltersDisclosure";
import { DisciplineChips } from "./DisciplineChips";
import {
  categoryMetadataResponseV1Schema,
  type ApiFieldErrorV1,
  type CategoryMetadataItemV1,
  type TalentSearchResultV1,
} from "@soundhub/types";

export interface SearchPageProps {
  /**
   * M2 (#87): buyer-side action handler wired by the talent page.
   * The default (no prop) renders the result card with the coral
   * Send project request button disabled. The /talent page provides
   * a `navigateToMatchmakerFromTalent` default that writes the
   * Talent continuation record and routes to the matchmaker (or
   * the protected-action login / intent flow).
   */
  readonly onSendProjectRequest?: (
    result: TalentSearchResultV1,
    criteria: SubmittedCriteria,
  ) => void;
}

export function SearchPage({ onSendProjectRequest }: SearchPageProps = {}) {
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<RequiredFiltersValue>({
    primaryCategoryKey: "",
    independentlyPurchasableServiceKey: "",
    serviceModes: [],
    basedIn: { city: "", region: "", countryCode: "" },
    serviceArea: { city: "", region: "", countryCode: "" },
  });
  const { results, isLoading, error, errorCode, fieldErrors, requestId, search, retry } =
    useSearch();

  // Page-level empty-submission guard (M1.7 QA). The `message` is
  // set when the buyer submits a (query, filters) tuple with no usable
  // criteria; cleared on the next submission that does have usable
  // criteria. While set, the hook's dispatch is skipped so no API
  // request is made for an empty submission.
  const [emptySearchMessage, setEmptySearchMessage] = useState<string | null>(null);

  // Pending criteria snapshot for the in-flight submission. A
  // ref (not state) so updates do not re-render the form; the
  // success-commit effect below promotes it to React state when
  // the corresponding response lands.
  const pendingCriteriaRef = useRef<SubmittedCriteria | null>(null);
  // The criteria that produced the currently-rendered results.
  // `null` until the first successful submission commits. The
  // results meta reads from this state, NOT from the live `query`
  // / `filters` form values — a change in the form that has not
  // been submitted must NOT change the meta on screen.
  const [submittedCriteria, setSubmittedCriteria] = useState<SubmittedCriteria | null>(null);

  // Canonical categories from `GET /api/metadata/categories`. The
  // browser NEVER holds a second, independently deployable list of
  // category keys. The chips row, the primary-category dropdown inside
  // the Filters disclosure, and the independently-purchasable-service
  // dropdown all read from this single response.
  const [categories, setCategories] = useState<readonly CategoryMetadataItemV1[]>([]);
  const [categoriesError, setCategoriesError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/metadata/categories", {
          method: "GET",
          headers: { Accept: "application/json" },
        });
        if (!response.ok) {
          throw new Error(`Metadata request failed (${response.status}).`);
        }
        const body: unknown = await response.json();
        const parsed = categoryMetadataResponseV1Schema.safeParse(body);
        if (!parsed.success) {
          throw new Error("Metadata response does not match the shared category schema.");
        }
        if (cancelled) return;
        setCategories(parsed.data.categories);
        setCategoriesError(null);
      } catch (err) {
        if (cancelled) return;
        setCategoriesError(
          err instanceof Error ? err.message : "Could not load the canonical category catalog.",
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const guard = getEmptySearchSubmissionMessage(query, filters);
    if (guard !== null) {
      setEmptySearchMessage(guard.message);
      return;
    }
    setEmptySearchMessage(null);
    // Capture the criteria for THIS submission in a value
    // snapshot (shallow clone of `filters`) so a later edit to
    // the form cannot retroactively mutate the snapshot. The
    // meta line MUST describe the criteria that produced the
    // currently-displayed results — not the live form fields
    // that have not been submitted yet.
    pendingCriteriaRef.current = snapshotCriteria(query, filters);
    void search(query, filters);
  };

  // Commit the captured criteria to React state ONLY when the
  // corresponding response succeeds. The meta line tracks
  // "which criteria produced the currently-displayed results",
  // not "what the form currently says":
  //   - while a previous A is on screen, the user can edit to B
  //     without submitting and the meta must keep describing A.
  //   - if a new search B fails, the previous A results stay
  //     on screen and the meta must keep describing A.
  //   - when a new search B succeeds, the meta must describe B.
  // The hook's own results/error state already clears `results`
  // on failure, so the meta only needs to track the success
  // commit.
  useEffect(() => {
    if (results !== null && pendingCriteriaRef.current !== null) {
      setSubmittedCriteria(pendingCriteriaRef.current);
      pendingCriteriaRef.current = null;
    }
  }, [results]);

  const unmatchedFieldErrors = useMemo<readonly ApiFieldErrorV1[]>(
    () => fieldErrors.filter((err) => !isControlledRequiredPath(err.path)),
    [fieldErrors],
  );

  // The FiltersDisclosure tray defaults closed. When the latest
  // submission produced a controlled required-filter field error
  // (for example a malformed `basedIn.countryCode`), the error
  // renders beside the matching control INSIDE the disclosure — so
  // if the tray stays closed the buyer cannot see the error and
  // the submission appears to have been ignored. Surfacing the
  // error therefore requires opening the tray. The page is the
  // sole authority: when a controlled error is present, force the
  // disclosure open; otherwise the closed-by-default Stitch
  // composition is preserved.
  const controlledRequiredErrors = useMemo<readonly ApiFieldErrorV1[]>(
    () => fieldErrors.filter((err) => isControlledRequiredPath(err.path)),
    [fieldErrors],
  );
  const forceFiltersOpen = controlledRequiredErrors.length > 0;

  const usable = hasUsableCriteria(query, filters);
  const showEmptyState = !isLoading && results !== null && results.results.length === 0 && usable;

  return (
    <div className="bg-canvas" data-testid="talent-page">
      <div className="max-w-[1440px] mx-auto px-6 lg:px-12 py-8 lg:py-12 space-y-8 lg:space-y-10">
        {/* ============== EDITORIAL HEADING ============== */}
        <section
          className="grid grid-cols-1 lg:grid-cols-12 gap-6 lg:gap-10 items-end"
          data-testid="talent-heading-section"
        >
          <div className="lg:col-span-8 flex flex-col gap-2">
            <span className="text-xs uppercase tracking-widest text-seaGlass font-semibold">
              Caribbean Studio · Talent Discovery
            </span>
            <h1
              className="font-serif text-4xl md:text-5xl lg:text-[48px] leading-tight text-ink"
              data-testid="talent-heading"
            >
              Find Caribbean talent
            </h1>
            <p className="text-lg text-muted max-w-2xl" data-testid="talent-summary">
              Connect with Caribbean producers, songwriters, vocalists, arrangers, and audio
              engineers across the diaspora. Describe your sound or refine by category, location,
              and session format.
            </p>
          </div>
          <div className="lg:col-span-4 flex lg:justify-end">
            <span
              className="inline-flex items-center gap-2 px-3 py-1.5 bg-surface border border-borderWarm rounded-md text-xs uppercase tracking-wider text-ink"
              data-testid="talent-trust-badge"
            >
              <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-seaGlass" />
              Terms approved before work begins
            </span>
          </div>
        </section>

        {/* ============== PRIMARY SEARCH SURFACE ============== */}
        <section
          className="bg-canvas border border-borderWarm rounded-xl p-4 lg:p-5 shadow-sm"
          data-testid="talent-search-surface"
        >
          <form
            onSubmit={handleSubmit}
            className="flex flex-col md:flex-row items-stretch md:items-center gap-3"
            data-testid="search-form"
          >
            <div className="flex-1 flex items-center gap-3 px-3">
              <span aria-hidden="true" className="text-aubergine text-xl shrink-0">
                ⌕
              </span>
              <SearchForm query={query} setQuery={setQuery} loading={isLoading} hideLabel />
            </div>
            <button
              type="submit"
              disabled={isLoading}
              data-testid="search-submit"
              className="inline-flex items-center justify-center gap-2 min-h-[44px] min-w-[44px] px-6 py-3 rounded-lg bg-coral text-white font-semibold hover:bg-coral-hover disabled:opacity-60 transition-colors focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-coral"
            >
              <span>{isLoading ? "Searching…" : "Find talent"}</span>
              <span aria-hidden="true">→</span>
            </button>
          </form>

          {/* Try-searching hints */}
          <div
            className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted"
            data-testid="search-try-hints"
          >
            <span className="text-xs uppercase tracking-wider text-seaGlass font-semibold">
              Try:
            </span>
            <TryHint
              onClick={() => setQuery("Haitian producer in New York for a remote dancehall single")}
              testId="search-try-hint-1"
            >
              Haitian producer in New York for a remote dancehall single
            </TryHint>
            <span aria-hidden="true" className="text-muted/50">
              ·
            </span>
            <TryHint
              onClick={() => setQuery("Trinidadian soca brass section")}
              testId="search-try-hint-2"
            >
              Trinidadian soca brass section
            </TryHint>
          </div>
        </section>

        {/* ============== FILTERS DISCLOSURE ============== */}
        <FiltersDisclosure value={filters} onChange={setFilters} forceOpen={forceFiltersOpen}>
          <RequiredFilters
            value={filters}
            onChange={setFilters}
            fieldErrors={fieldErrors}
            categories={categories}
            disabled={isLoading}
            categorySelectsDisabled={categories.length === 0}
          />
        </FiltersDisclosure>

        {/* ============== DISCIPLINE CHIPS ============== */}
        <section
          className="flex flex-col gap-2"
          data-testid="discipline-chips-section"
          aria-label="Discipline shortcuts"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs uppercase tracking-widest text-muted font-semibold">
              Disciplines &amp; Craft Specialties
            </span>
          </div>
          <DisciplineChips
            categories={categories}
            activeKey={filters.primaryCategoryKey}
            onSelect={(key) => setFilters((prev) => ({ ...prev, primaryCategoryKey: key }))}
          />
        </section>

        {/* ============== FEEDBACK SURFACES ============== */}
        <EmptySearchGuidance message={emptySearchMessage} />

        {categoriesError && (
          <Card
            variant="outlined"
            className="border-amber-200 bg-amber-50"
            data-testid="catalog-error"
          >
            <Card.Content>
              <p className="text-amber-800" data-testid="catalog-error-message">
                The canonical category catalog is unavailable. {categoriesError}
              </p>
              <p className="mt-2 text-sm text-amber-700">
                Category selects are disabled until the catalog loads. Service mode, based-in, and
                service-area controls remain usable. Retry by refreshing the page.
              </p>
            </Card.Content>
          </Card>
        )}

        {error && (
          <Card variant="outlined" className="border-red-200 bg-red-50" data-testid="search-error">
            <Card.Content>
              <p className="text-red-800" data-testid="search-error-message">
                {error}
              </p>
              {errorCode === "SEARCH_UNAVAILABLE" && (
                <p className="mt-2 text-sm text-red-700">
                  The brief is preserved. You can retry without retyping it.
                </p>
              )}
              {isRetriableErrorCode(errorCode) && !isLoading && (
                <button
                  type="button"
                  onClick={() => {
                    void retry();
                  }}
                  data-testid="search-retry"
                  className="mt-3 inline-flex items-center gap-1 bg-red-600 text-white py-2 px-4 rounded-md text-sm font-medium hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 transition-colors"
                >
                  Retry search
                </button>
              )}
              {unmatchedFieldErrors.length > 0 && (
                <ul className="mt-3 space-y-1" data-testid="search-error-fields">
                  {unmatchedFieldErrors.map((err) => (
                    <li key={`${err.path}-${err.code}`} className="text-sm text-red-700">
                      <span className="font-mono text-xs mr-1">{err.path}</span>
                      {err.message}
                    </li>
                  ))}
                </ul>
              )}
              {requestId && (
                <p className="mt-2 text-xs text-red-600" data-testid="search-error-request-id">
                  Request ID: {requestId}
                </p>
              )}
            </Card.Content>
          </Card>
        )}

        {isLoading && (
          <div className="text-center py-12" data-testid="search-loading" aria-live="polite">
            <div className="inline-block animate-spin h-8 w-8 border-b-2 border-aubergine rounded-full" />
            <p className="mt-4 text-muted">Searching talent…</p>
          </div>
        )}

        {showEmptyState && (
          <Card className="text-center py-12" data-testid="search-empty">
            <Card.Content>
              <p className="text-muted">
                No matching talent yet. Try a different description or remove optional filters.
              </p>
            </Card.Content>
          </Card>
        )}

        {/* ============== RESULTS ============== */}
        {results && results.results.length > 0 && (
          <section className="space-y-4" data-testid="search-results" aria-label="Search results">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 px-1">
              <h2 className="font-serif text-2xl text-ink" data-testid="search-results-heading">
                {results.results.length} matching seller
                {results.results.length === 1 ? "" : "s"}
              </h2>
              <p className="text-sm text-muted" data-testid="search-results-meta">
                {formatResultsMeta(
                  submittedCriteria?.query ?? "",
                  submittedCriteria?.filters ?? filters,
                )}
              </p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
              {results.results.map((result) => (
                <ResultCard
                  key={result.seller.sellerId}
                  result={result}
                  onSendProjectRequest={
                    onSendProjectRequest
                      ? (r) =>
                          onSendProjectRequest(r, {
                            query: submittedCriteria?.query ?? "",
                            filters: submittedCriteria?.filters ?? filters,
                          })
                      : undefined
                  }
                />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

interface TryHintProps {
  readonly onClick: () => void;
  readonly children: ReactNode;
  readonly testId: string;
}

function TryHint({ onClick, children, testId }: TryHintProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="hover:text-aubergine underline underline-offset-2 decoration-borderWarm focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine rounded"
      data-testid={testId}
    >
      {children}
    </button>
  );
}

// Build a compact "Music Production in Caribbean & Diaspora" style
// summary from the active filter state. Truthful — only describes the
// filters the API actually received, never invented copy.
function formatResultsMeta(query: string, filters: RequiredFiltersValue): string {
  const parts: string[] = [];
  const trimmedQuery = query.trim();
  if (trimmedQuery.length > 0) {
    parts.push(`"${trimmedQuery}"`);
  }
  if (filters.primaryCategoryKey.length > 0) {
    parts.push(filters.primaryCategoryKey);
  }
  if (filters.serviceModes.length > 0) {
    parts.push(filters.serviceModes.join(" / "));
  }
  if (filters.basedIn.countryCode.trim().length > 0) {
    parts.push(`based in ${filters.basedIn.countryCode.trim().toUpperCase()}`);
  }
  if (filters.independentlyPurchasableServiceKey.length > 0) {
    parts.push("ready-to-book services");
  }
  if (parts.length === 0) {
    return "All available Caribbean & Diaspora talent.";
  }
  return parts.join(" · ");
}

// Empty-submission guidance. Renders the buyer-friendly message when
// the page-level guard has flagged an empty (no-usable-criteria)
// submission; renders nothing on a null message.
//
// Exported (with the implementation kept private as
// `EmptySearchGuidanceImpl`) so tests can render it in isolation
// against a controlled message string without spinning up the parent
// `SearchPage`.
function EmptySearchGuidanceImpl({ message }: { readonly message: string | null }) {
  if (message === null) return null;
  return (
    <Card
      variant="outlined"
      className="mb-0 border-amber-200 bg-amber-50"
      data-testid="empty-search-guidance"
      role="status"
      aria-live="polite"
    >
      <Card.Content>
        <p className="text-amber-800" data-testid="empty-search-guidance-message">
          {message}
        </p>
      </Card.Content>
    </Card>
  );
}

export const EmptySearchGuidance = EmptySearchGuidanceImpl;

/**
 * Snapshot of the (query, filters) tuple at the moment a
 * search is actually dispatched. The search-results meta line
 * describes this snapshot — never the live form state — so an
 * edit to the form that has not been submitted yet cannot
 * change the meta text on screen.
 */
export interface SubmittedCriteria {
  readonly query: string;
  readonly filters: RequiredFiltersValue;
}

/**
 * Take a shallow value snapshot of the criteria tuple so a
 * later mutation to the live `filters` state (or to the
 * `basedIn.countryCode`/`serviceArea` nested objects) cannot
 * retroactively rewrite the snapshot the meta line is built
 * from. The shallow copy at the top level is paired with
 * explicit copies of the `basedIn` and `serviceArea` value
 * objects; the underlying strings/arrays remain immutable from
 * the caller's perspective.
 *
 * Exported so unit tests can target the snapshot semantics
 * directly without rendering the full page.
 */
export function snapshotCriteria(query: string, filters: RequiredFiltersValue): SubmittedCriteria {
  return {
    query,
    filters: {
      primaryCategoryKey: filters.primaryCategoryKey,
      independentlyPurchasableServiceKey: filters.independentlyPurchasableServiceKey,
      serviceModes: filters.serviceModes.slice(),
      basedIn: { ...filters.basedIn },
      serviceArea: { ...filters.serviceArea },
    },
  };
}
