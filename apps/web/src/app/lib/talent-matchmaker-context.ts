// Bounded Talent → Matchmaker continuation record (M2 #87).
//
// Background: a buyer who clicks "Send project request" on a /talent
// result may not be authenticated yet, or may not yet have Buyer
// capability on their Personal Workspace. The /talent page must
// preserve the buyer's search context (the targeted offering, the
// brief text, and the structured filters) across the auth / intent
// round-trip so the matchmaker can restore the highlight and pre-
// fill the brief form when the buyer returns.
//
// Storage choice (M2 #87 design):
//
//   - localStorage (NOT sessionStorage). The magic-link callback
//     may open in a different browser tab than the original /talent
//     page; sessionStorage is per-tab and would be lost. localStorage
//     is shared across tabs and survives the callback's tab switch.
//
//   - Single key (`soundhub.talent-matchmaker-context`). The record
//     shape is `{ source: "talent", offeringId, query, filters,
//     createdAt }` and is the single source of truth for the cross-
//     flow state. The URL marker `?from=talent` is a routing hint
//     only — the post-command return resolver strips query
//     parameters, so the matchmaker must NOT rely on the URL.
//
//   - 5-minute TTL via `createdAt`. The browser storage lifetime
//     is NOT a TTL; the matchmaker reads `Date.now() - createdAt`
//     and discards any record older than `TALENT_MATCHMAKER_CONTEXT_TTL_MS`.
//
//   - Non-destructive read. The record is NOT cleared on a normal
//     mount — clearing is reserved for terminal boundaries:
//       - successful `createProjectRequest` (buyer actually sent)
//       - explicit "Back to talent" navigation
//       - detection of an invalid / corrupt / expired record
//       - a new `setTalentMatchmakerContext` from a later click
//         (newest action wins; the prior record is overwritten)
//
//   - Non-authoritative. Authentication, Workspace membership, Buyer
//     capability, offering eligibility, and ProjectRequest
//     authorization are all freshly server-validated on every API
//     call. The record only restores the buyer-visible context.
//
// Failure mode: `localStorage.setItem` throws when the browser
// refuses to allocate the entry (private mode, quota). The writer
// propagates the throw; the /talent page catches and surfaces the
// failure inline so the buyer is never sent to a destination they
// cannot resume from.

import type { LocationFilterValue, RequiredFiltersValue } from "./talent-search-request-builder.js";

export const TALENT_MATCHMAKER_CONTEXT_STORAGE_KEY = "soundhub.talent-matchmaker-context";

/**
 * Maximum age (milliseconds) of a Talent continuation record before
 * the matchmaker discards it as expired. The browser storage
 * lifetime itself is NOT a TTL — the matchmaker computes
 * `Date.now() - createdAt` on every read and returns `null` for
 * any record older than this constant.
 *
 * 5 minutes is enough for the typical auth / intent round-trip but
 * short enough that a stale record (e.g. the buyer returned the
 * next day) cannot mislead the matchmaker.
 */
export const TALENT_MATCHMAKER_CONTEXT_TTL_MS = 5 * 60 * 1000;

export interface TalentMatchmakerContext {
  readonly source: "talent";
  readonly offeringId: string;
  readonly query: string;
  readonly filters: RequiredFiltersValue;
  readonly createdAt: string;
}

/**
 * Predicate the reader applies after JSON.parse so a corrupt or
 * hostile entry cannot crash the matchmaker. The shape is exact
 * (extra fields are rejected) so a poisoned entry is silently
 * dropped and the buyer sees the matchmaker without a highlight.
 */
function isTalentMatchmakerContextShape(value: unknown): value is TalentMatchmakerContext {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  // Reject extra fields. The shape is closed; anything else
  // indicates a poisoned entry.
  const allowedKeys = ["source", "offeringId", "query", "filters", "createdAt"];
  for (const key of Object.keys(candidate)) {
    if (!allowedKeys.includes(key)) return false;
  }
  if (candidate.source !== "talent") return false;
  if (typeof candidate.offeringId !== "string" || candidate.offeringId.length === 0) return false;
  if (typeof candidate.query !== "string") return false;
  if (typeof candidate.createdAt !== "string") return false;
  if (!isRequiredFiltersValueShape(candidate.filters)) return false;
  return true;
}

function isRequiredFiltersValueShape(value: unknown): value is RequiredFiltersValue {
  if (typeof value !== "object" || value === null) return false;
  const f = value as Record<string, unknown>;
  const allowedKeys = [
    "primaryCategoryKey",
    "independentlyPurchasableServiceKey",
    "serviceModes",
    "basedIn",
    "serviceArea",
  ];
  for (const key of Object.keys(f)) {
    if (!allowedKeys.includes(key)) return false;
  }
  if (typeof f.primaryCategoryKey !== "string") return false;
  if (typeof f.independentlyPurchasableServiceKey !== "string") return false;
  if (!Array.isArray(f.serviceModes)) return false;
  for (const mode of f.serviceModes) {
    if (mode !== "Remote" && mode !== "InPerson" && mode !== "Hybrid") return false;
  }
  if (!isLocationFilterValueShape(f.basedIn)) return false;
  if (!isLocationFilterValueShape(f.serviceArea)) return false;
  return true;
}

function isLocationFilterValueShape(value: unknown): value is LocationFilterValue {
  if (typeof value !== "object" || value === null) return false;
  const l = value as Record<string, unknown>;
  const allowedKeys = ["city", "region", "countryCode"];
  for (const key of Object.keys(l)) {
    if (!allowedKeys.includes(key)) return false;
  }
  return (
    typeof l.city === "string" && typeof l.region === "string" && typeof l.countryCode === "string"
  );
}

/**
 * Write the Talent → Matchmaker continuation record. THROWS when
 * `localStorage` rejects the write (private-browsing quota, full
 * storage, blocked storage). The throw is intentional: a swallowed
 * failure would let the /talent page navigate to /matchmaker where
 * `readTalentMatchmakerContext` returns `null` and the matchmaker
 * silently renders without a highlight. Callers MUST catch and
 * surface the failure inline.
 */
export function setTalentMatchmakerContext(
  value: Omit<TalentMatchmakerContext, "createdAt">,
): void {
  if (typeof window === "undefined") {
    throw new Error("localStorage is not available in this environment");
  }
  const record: TalentMatchmakerContext = {
    ...value,
    createdAt: new Date().toISOString(),
  };
  window.localStorage.setItem(TALENT_MATCHMAKER_CONTEXT_STORAGE_KEY, JSON.stringify(record));
}

/**
 * Read the Talent → Matchmaker continuation record.
 *
 * Non-destructive: the record is NOT cleared by a normal read.
 * The record is only cleared on a terminal boundary
 * (successful `createProjectRequest`, explicit "Back to talent",
 * or a subsequent `setTalentMatchmakerContext` call that overwrites
 * the prior entry).
 *
 * Returns `null` for:
 *   - missing key
 *   - corrupt JSON
 *   - shape mismatch (extra fields, wrong types, unknown modes)
 *   - expired record (older than `TALENT_MATCHMAKER_CONTEXT_TTL_MS`)
 *   - storage unavailable (server-side render, blocked storage)
 *
 * An expired record is also cleared (one of the valid terminal
 * boundaries), so a subsequent read sees a clean storage.
 *
 * The optional `now` parameter is a clock-injection test seam so
 * the unit tests can pin the TTL boundary without mocking the
 * real Date.
 */
export function readTalentMatchmakerContext(
  now: () => number = Date.now,
): TalentMatchmakerContext | null {
  if (typeof window === "undefined") return null;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(TALENT_MATCHMAKER_CONTEXT_STORAGE_KEY);
  } catch {
    // localStorage blocked (private mode, etc.) — no recovery
    // possible from the client; the matchmaker renders without a
    // highlight and the buyer can re-run the search from /talent.
    return null;
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt JSON — clear the bad entry so a subsequent read sees
    // a clean storage. This is one of the valid terminal boundaries.
    clearTalentMatchmakerContext();
    return null;
  }

  if (!isTalentMatchmakerContextShape(parsed)) {
    // Shape mismatch — same treatment as corrupt JSON.
    clearTalentMatchmakerContext();
    return null;
  }

  const ageMs = now() - new Date(parsed.createdAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > TALENT_MATCHMAKER_CONTEXT_TTL_MS) {
    // Expired or impossible timestamp — clear it.
    clearTalentMatchmakerContext();
    return null;
  }

  return parsed;
}

/**
 * Explicit teardown. Used on the terminal boundaries
 * (successful `createProjectRequest`, "Back to talent" click, etc.).
 * Silent on storage failure so a teardown retry never throws into
 * a click handler.
 */
export function clearTalentMatchmakerContext(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(TALENT_MATCHMAKER_CONTEXT_STORAGE_KEY);
  } catch {
    // ignore
  }
}
