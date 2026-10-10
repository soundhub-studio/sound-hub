// Milestone 1: Database-Backed Talent and Offering Search
//
// Shared runtime contract. Zod schemas are the executable contract; TypeScript
// types are inferred from them. The same schemas are used by the API request
// validator and by the web response parser, so the browser, the server, and the
// contract document cannot drift.
//
// The contract version is `v1`. See docs/contracts/search-api.md.

import { z } from "zod";

// ---------- Helpers ----------

// Trim a string and reject it if it is empty after trimming. Used to
// normalize location fields and array elements before length validation.
const trimmedNonEmptyString = (minLength: number, maxLength: number, label: string) =>
  z
    .string()
    .max(maxLength, `${label} must be at most ${maxLength} characters`)
    .transform((value, ctx) => {
      const trimmed = value.trim();
      if (trimmed.length < minLength) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} must be at least ${minLength} non-whitespace character(s) after normalization`,
        });
        return z.NEVER;
      }
      return trimmed;
    });

// Bounded string array. Each element is trimmed, deduped, and
// rejected (ZodError) if it does not meet `minLength` after trimming.
// An empty input collapses to `undefined` so downstream usability
// checks ignore "no criteria" arrays.
const optionalBoundedStringArray = (minLength: number, maxLength: number, label: string) =>
  z
    .array(
      z
        .string()
        .max(maxLength, `${label} elements must be at most ${maxLength} characters`)
        .transform((value, ctx) => {
          const trimmed = value.trim();
          if (trimmed.length < minLength) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `${label} contains an element shorter than ${minLength} non-whitespace character(s) after normalization`,
            });
            return z.NEVER;
          }
          return trimmed;
        }),
    )
    .max(50, `${label} must contain at most 50 elements`)
    .transform((values) => {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const value of values) {
        if (seen.has(value)) continue;
        seen.add(value);
        out.push(value);
      }
      return out;
    })
    .transform((arr) => (arr.length === 0 ? undefined : arr))
    .optional();

// ISO 3166-1 alpha-2 country code (uppercase). The contract only
// validates the shape; whether a specific code is a supported Caribbean
// affiliation is an application-layer concern.
const countryCodeSchema = z
  .string()
  .regex(/^[A-Z]{2}$/, "countryCode must be a 2-letter ISO alpha-2 code");

// ---------- Service mode (closed behavior state) ----------

export const serviceModeSchema = z.enum(["Remote", "InPerson", "Hybrid"]);
export type ServiceMode = z.infer<typeof serviceModeSchema>;

// ---------- Pricing ----------

export const pricingKindSchema = z.enum(["StartingAt", "Fixed", "ContactForQuote"]);
export type PricingKind = z.infer<typeof pricingKindSchema>;

const moneyV1Schema = z.object({
  amountMinor: z.number().int().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/, "currency must be a 3-letter ISO 4217 code"),
});
export type MoneyV1 = z.infer<typeof moneyV1Schema>;

export const pricingSummaryV1Schema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("StartingAt"),
    amount: moneyV1Schema,
    unit: z.string().min(1).max(64),
  }),
  z.object({
    kind: z.literal("Fixed"),
    amount: moneyV1Schema,
    unit: z.string().min(1).max(64),
  }),
  z.object({
    kind: z.literal("ContactForQuote"),
  }),
]);
export type PricingSummaryV1 = z.infer<typeof pricingSummaryV1Schema>;

// ---------- Location filter ----------

// Location fields are normalized (trimmed) before min-length validation
// and rejected if they are empty after normalization. The location
// filter as a whole is also rejected if all three fields normalize to
// empty/missing values.
const trimmedCitySchema = trimmedNonEmptyString(1, 120, "city");
const trimmedRegionSchema = trimmedNonEmptyString(1, 120, "region");
const trimmedCountryCodeSchema = trimmedNonEmptyString(2, 2, "countryCode").refine(
  (value) => /^[A-Z]{2}$/.test(value),
  { message: "countryCode must be a 2-letter ISO alpha-2 code" },
);

const locationFilterV1Schema = z
  .object({
    city: trimmedCitySchema.optional(),
    region: trimmedRegionSchema.optional(),
    countryCode: trimmedCountryCodeSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.city === undefined && value.region === undefined && value.countryCode === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "location filter must contain at least one of city, region, countryCode",
      });
    }
  });
export type LocationFilterV1 = z.infer<typeof locationFilterV1Schema>;

// ---------- Required criteria ----------

export const talentSearchRequiredCriteriaV1Schema = z
  .object({
    primaryCategoryKeys: optionalBoundedStringArray(1, 64, "primaryCategoryKeys"),
    independentlyPurchasableServiceKeys: optionalBoundedStringArray(
      1,
      64,
      "independentlyPurchasableServiceKeys",
    ),
    serviceModes: z
      .array(serviceModeSchema)
      .max(8)
      .transform((arr) => (arr.length === 0 ? undefined : arr))
      .optional(),
    basedIn: locationFilterV1Schema.optional(),
    serviceArea: locationFilterV1Schema.optional(),
  })
  .strict();
export type TalentSearchRequiredCriteriaV1 = z.infer<typeof talentSearchRequiredCriteriaV1Schema>;

// ---------- Preferred criteria ----------

export const talentSearchPreferredCriteriaV1Schema = z
  .object({
    categoryKeys: optionalBoundedStringArray(1, 64, "categoryKeys"),
    includedServiceKeys: optionalBoundedStringArray(1, 64, "includedServiceKeys"),
    specialties: optionalBoundedStringArray(1, 64, "specialties"),
    genreTags: optionalBoundedStringArray(1, 64, "genreTags"),
    caribbeanAffiliationCodes: z
      .array(countryCodeSchema)
      .max(20)
      .transform((arr) => (arr.length === 0 ? undefined : arr))
      .optional(),
    basedIn: locationFilterV1Schema.optional(),
    serviceModes: z
      .array(serviceModeSchema)
      .max(8)
      .transform((arr) => (arr.length === 0 ? undefined : arr))
      .optional(),
  })
  .strict();
export type TalentSearchPreferredCriteriaV1 = z.infer<typeof talentSearchPreferredCriteriaV1Schema>;

// ---------- Request ----------

// Normalized query: trimmed, internal whitespace collapsed, lowercased,
// surrounding punctuation stripped. A purely punctuation-only string
// collapses to the empty string and fails the usability check.
const normalizedQuerySchema = z
  .string()
  .max(500, "query must be at most 500 characters")
  .transform((value) => value.trim().replace(/\s+/g, " ").toLowerCase())
  .transform((value) => value.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
  .refine((value) => /[\p{L}\p{N}]/u.test(value), {
    message: "query must contain at least one letter or digit after normalization",
  })
  .refine((value) => value.length >= 2, {
    message: "query must be at least 2 characters after normalization",
  });

// A request is usable when at least one of `query`, `required`, or `preferred`
// has a meaningful value. The refinement enforces the contract rule.
export const talentSearchRequestV1Schema = z
  .object({
    query: normalizedQuerySchema.optional(),
    required: talentSearchRequiredCriteriaV1Schema.optional(),
    preferred: talentSearchPreferredCriteriaV1Schema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasQuery = typeof value.query === "string" && value.query.length >= 2;
    const hasRequired = value.required ? isUsable(value.required) : false;
    const hasPreferred = value.preferred ? isUsable(value.preferred) : false;
    if (!(hasQuery || hasRequired || hasPreferred)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "at least one of query, required, or preferred must contain criteria",
      });
    }
  });
export type TalentSearchRequestV1 = z.infer<typeof talentSearchRequestV1Schema>;

// Recursively treats a value as "usable" if it has a non-empty string,
// a non-empty array, or a nested object that itself is usable. Empty
// arrays, empty objects, and undefined values are not usable.
function isUsable(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(isUsable);
  }
  return false;
}

// ---------- Public seller summary ----------

export const publicSellerSummaryV1Schema = z
  .object({
    sellerId: z.string().min(1),
    professionalName: z.string().min(1).max(200),
    specialties: z.array(z.string().min(1).max(64)).max(20),
    bio: z.string().max(2000),
    basedIn: z.object({
      city: z.string().min(1).max(120).optional(),
      region: z.string().min(1).max(120).optional(),
      countryCode: countryCodeSchema,
    }),
    caribbeanAffiliationCodes: z.array(countryCodeSchema).max(20),
    avatarUrl: z.string().url().optional(),
  })
  .strict();
export type PublicSellerSummaryV1 = z.infer<typeof publicSellerSummaryV1Schema>;

// ---------- Public offering summary ----------

const includedServiceV1Schema = z
  .object({
    key: z.string().min(1).max(64),
    name: z.string().min(1).max(200),
    purchaseMode: z.literal("BundleOnly"),
  })
  .strict();

const serviceAreaV1Schema = z
  .object({
    city: z.string().min(1).max(120).optional(),
    region: z.string().min(1).max(120).optional(),
    countryCode: countryCodeSchema,
  })
  .strict();

export const publicOfferingSummaryV1Schema = z
  .object({
    offeringId: z.string().min(1),
    title: z.string().min(1).max(200),
    description: z.string().max(4000),
    primaryCategory: z
      .object({
        key: z.string().min(1).max(64),
        name: z.string().min(1).max(200),
      })
      .strict(),
    includedServices: z.array(includedServiceV1Schema).max(20),
    genreTags: z.array(z.string().min(1).max(64)).max(50),
    serviceMode: serviceModeSchema,
    serviceAreas: z.array(serviceAreaV1Schema).max(20),
    pricing: pricingSummaryV1Schema.optional(),
  })
  .strict();
export type PublicOfferingSummaryV1 = z.infer<typeof publicOfferingSummaryV1Schema>;

// ---------- Result and response ----------

// Factual coverage counts shared by the preference-atom coverage and the
// normalized-query-token coverage response fields. Both fields have
// identical shape, strictness, integer bounds, and `matched <= total`
// refinement, so the schema is declared once here as a non-exported
// internal record and re-exported under semantically named aliases.
// P2-001 deduplication: a parallel handwritten copy of this schema
// would inevitably drift; the aliases keep the public surface stable
// while leaving a single source of truth for the validation.
const coverageCountsV1Schema = z
  .object({
    matched: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  })
  .strict()
  .refine((value) => value.matched <= value.total, {
    message: "matched must not exceed total",
  });

// Factual coverage of the buyer's preference atoms against the best matching
// offering's matched atoms. The matched count is bounded by `total` and both
// are computed from the canonical preference atoms and the deterministic
// matcher (never derived from `relevanceScore`, which is strategy-specific
// ordering and explicitly NOT a buyer-facing confidence signal).
//
// Optional in the public DTO so adding the field is backward-compatible
// per the v1 contract's compatibility rules. Older clients see a response
// without the field and the UI falls back to `matchReason` evidence only
// (P1-002 remediation).
export const preferenceCoverageV1Schema = coverageCountsV1Schema;
export type PreferenceCoverageV1 = z.infer<typeof coverageCountsV1Schema>;

// Factual coverage of the buyer's normalized query tokens against the
// best matching offering's matched text fields. The matched count is
// bounded by `total` and both are computed from the canonical
// distinct-query-tokens set and the deterministic text matcher (never
// derived from `relevanceScore`, which is strategy-specific ordering
// and explicitly NOT a buyer-facing confidence signal).
//
// Optional in the public DTO so adding the field is backward-compatible
// per the v1 contract's compatibility rules. Older clients see a response
// without the field and the UI falls back to `matchReason` evidence only.
// Emitted whenever the buyer supplied a usable query (at least one
// distinct canonical token); omitted when the request had no query, in
// which case `textCoverage.total` would be `0` and the resulting "0 of
// 0" statement is not factual evidence. Persisted separately from
// `preferenceCoverage` so a request that supplies both a query and
// preferences carries both factual-evidence lines.
export const textCoverageV1Schema = coverageCountsV1Schema;
export type TextCoverageV1 = z.infer<typeof coverageCountsV1Schema>;

export const talentSearchResultV1Schema = z
  .object({
    seller: publicSellerSummaryV1Schema,
    bestMatchingOffering: publicOfferingSummaryV1Schema,
    additionalMatchingOfferings: z.array(publicOfferingSummaryV1Schema).max(2),
    relevanceScore: z
      .number()
      .min(0, "relevanceScore must be at least 0")
      .max(1, "relevanceScore must be at most 1")
      .finite(),
    matchReason: z.string().min(1).max(500),
    preferenceCoverage: preferenceCoverageV1Schema.optional(),
    textCoverage: textCoverageV1Schema.optional(),
  })
  .strict();
export type TalentSearchResultV1 = z.infer<typeof talentSearchResultV1Schema>;

export const talentSearchStrategyV1Schema = z.literal("postgres-text-v1");
export type TalentSearchStrategyV1 = z.infer<typeof talentSearchStrategyV1Schema>;

export const talentSearchResponseV1Schema = z
  .object({
    results: z.array(talentSearchResultV1Schema).max(10),
    metadata: z
      .object({
        normalizedQuery: z.string().min(2).max(500).optional(),
        totalResults: z.number().int().nonnegative(),
        processingTimeMs: z.number().int().nonnegative(),
        strategy: talentSearchStrategyV1Schema,
        appliedRequiredCriteria: talentSearchRequiredCriteriaV1Schema,
        appliedPreferredCriteria: talentSearchPreferredCriteriaV1Schema,
      })
      .strict(),
  })
  .strict();
export type TalentSearchResponseV1 = z.infer<typeof talentSearchResponseV1Schema>;

// ---------- Public metadata envelope ----------
//
// The canonical category catalog returned by `GET /api/metadata/categories`.
// The browser NEVER holds a second list of category keys; it parses the
// response against this shared Zod schema before rendering the option
// list. Unknown fields and malformed elements are rejected so a contract
// mismatch can never silently populate the page.
const categoryMetadataItemV1Schema = z
  .object({
    key: z.string().min(1).max(64),
    name: z.string().min(1).max(200),
  })
  .strict();

export const categoryMetadataResponseV1Schema = z
  .object({
    categories: z.array(categoryMetadataItemV1Schema).max(200),
  })
  .strict();
export type CategoryMetadataItemV1 = z.infer<typeof categoryMetadataItemV1Schema>;
export type CategoryMetadataResponseV1 = z.infer<typeof categoryMetadataResponseV1Schema>;

// ---------- Standard error envelope ----------

export const apiErrorCodeV1Schema = z.enum([
  "INVALID_JSON",
  "INVALID_SEARCH_CRITERIA",
  "UNSUPPORTED_MEDIA_TYPE",
  "SEARCH_RATE_LIMITED",
  "SEARCH_FAILED",
  "SEARCH_UNAVAILABLE",
  // Buildathon Golden Slice 1 error codes. Each code maps to a stable
  // HTTP status via buildSafeError's switch table and to a buyer-safe
  // message. The codes never expose provider subjects, raw tokens,
  // session ids, or membership internals.
  "INVALID_AUTH_REQUEST",
  "AUTH_RATE_LIMITED",
  "AUTH_FAILED",
  "AUTH_PROVIDER_UNAVAILABLE",
  "SESSION_INVALID",
  "SESSION_EXPIRED",
  "WORKSPACE_NOT_FOUND",
  "WORKSPACE_INELIGIBLE",
  "NOT_A_MEMBER",
  "MISSING_CAPABILITY",
  // Buildathon Golden Slice 3 error codes. Matchmaker-specific
  // codes share the same status-code table; the route layer maps
  // each to a buyer-safe message that never leaks provider
  // internals, AI raw output, or session material.
  "MATCHMAKER_INVALID_REQUEST",
  "MATCHMAKER_AI_UNAVAILABLE",
  "MATCHMAKER_FAILED",
  "BRIEF_NOT_FOUND",
  "BRIEF_FORBIDDEN",
  // Buildathon Golden Slice 2 (BG2) error codes. Each code maps to a
  // stable HTTP status via `mapStatus` and to a buyer-safe message.
  // They cover the seller-audio slice only; existing codes are
  // unchanged.
  "AUDIO_OFFERING_NOT_FOUND",
  "AUDIO_OFFERING_INELIGIBLE",
  "AUDIO_SAMPLE_NOT_FOUND",
  "AUDIO_SAMPLE_LIMIT_EXCEEDED",
  "AUDIO_CONTENT_TYPE_UNSUPPORTED",
  "AUDIO_PAYLOAD_TOO_LARGE",
  "AUDIO_PAYLOAD_MISSING",
  "AUDIO_PROVIDER_UNAVAILABLE",
  "AUDIO_STORAGE_FAILED",
  // Buildathon Golden Slice 4 error codes. ProjectRequest / Deal
  // specific. The 403 codes cover both buyer-side and seller-side
  // authorization failures (route layer collapses them to a single
  // safe envelope); PROJECT_REQUEST_ALREADY_PENDING and
  // PROJECT_REQUEST_ALREADY_RESPONDED surface as 409 to indicate a
  // retry that would have produced a duplicate row.
  "PROJECT_REQUEST_INVALID",
  "PROJECT_REQUEST_BRIEF_NOT_FOUND",
  "PROJECT_REQUEST_BRIEF_FORBIDDEN",
  "PROJECT_REQUEST_OFFERING_INELIGIBLE",
  "PROJECT_REQUEST_NOT_FOUND",
  "PROJECT_REQUEST_FORBIDDEN",
  "PROJECT_REQUEST_ALREADY_PENDING",
  "PROJECT_REQUEST_ALREADY_RESPONDED",
  // Transient marketplace-busy envelope. Maps to 503 so the buyer or
  // seller can retry the request without changing the payload.
  "PROJECT_REQUEST_UNAVAILABLE",
  // M2 (#88): the AI candidate for the initial TermsVersion (the
  // unapproved row persisted alongside the new Deal on a successful
  // accept) failed the strict `bg5ProposedTermsV1Schema` runtime
  // validation. 400 Bad Request — a malformed AI candidate must not
  // produce a Deal; the transaction rolls back with no state change.
  // This is distinct from `BG5_TERMS_DRAFT_INVALID` (which covers
  // post-accept replacement drafts) because the row is being
  // created as part of the accept command, not via
  // /api/deals/:id/terms-draft.
  "PROJECT_REQUEST_TERMS_DRAFT_INVALID",
  // Generic ProjectRequest internal-failure envelope. Maps to 500.
  // Used only when the handler catches an exception that does not
  // match a typed ProjectRequestError; the underlying message is
  // never echoed.
  "PROJECT_REQUEST_FAILED",
  // Buildathon Golden Slice 5 (BG5) error codes. Cover the
  // Deal/TermsVersion/DealApprover/DealApproval slice. The codes
  // never expose private identifiers (UserAccount ids, DealApprover
  // ids, storage references). Status mapping in
  // `apps/api/src/lib/errors.ts` is the single source of truth.
  "BG5_DEAL_NOT_FOUND",
  "BG5_TERMS_VERSION_NOT_FOUND",
  "BG5_DEAL_NOT_NEGOTIATING",
  "BG5_TERMS_DRAFT_FORBIDDEN",
  "BG5_TERMS_DRAFT_INVALID",
  "BG5_APPROVAL_FORBIDDEN",
  "BG5_APPROVAL_INVALID",
  "BG5_APPROVAL_NOT_CURRENT_VERSION",
  "BG5_APPROVAL_ALREADY_RECORDED",
  "BG5_DEAL_INTERNAL_FAILED",
  "BG5_DEAL_UNAVAILABLE",
  // Buildathon Golden Slice 6 (BG6) — PaymentIntent + activation codes.
  // 404 — the Deal id is unknown to the acting Workspace.
  "BG6_DEAL_NOT_FOUND",
  // 403 — the acting Workspace is not the buyer side, is not a
  // current member, lacks the Buyer capability, or another
  // authorization rejection (safe envelope collapses them).
  "BG6_FUNDING_FORBIDDEN",
  // 400 — the request body failed runtime validation.
  "BG6_FUNDING_INVALID",
  // 422 — the Deal is past Negotiating (typically already Active).
  "BG6_DEAL_NOT_NEGOTIATING",
  // 422 — both parties have not approved the current TermsVersion.
  "BG6_APPROVALS_INCOMPLETE",
  // 422 — the current TermsVersion moved under us between preauth
  // and Phase 3; retry-safe.
  "BG6_TERMS_VERSION_NOT_CURRENT",
  // 422 — the provider confirmation's amount/currency/termsVersionId
  // did not match the locked TermsVersion snapshot.
  "BG6_FUNDING_CONFIRMATION_MISMATCH",
  // 503 — provider outage; Deal stays Negotiating; intent transitions
  // to Failed on the SAME row.
  "BG6_ESCROW_UNAVAILABLE",
  // 409 — guarded activation UPDATE returned 0 rows; concurrent
  // activation already happened.
  "BG6_DEAL_ALREADY_ACTIVE",
  // 500 — unexpected internal failure outside the typed surfaces.
  "BG6_FUNDING_INTERNAL_FAILED",
  // Deals discovery list (ticket #74). The list is a private,
  // Workspace-scoped read; its rejection surface is deliberately
  // narrow so the response never reveals whether a Workspace exists
  // or whether the caller merely lacks membership.
  // 403 — the acting Workspace is unknown, not Active, or the
  // authenticated human is not a current member of that EXACT
  // Workspace. The single code collapses all three.
  "DEAL_LIST_FORBIDDEN",
  // 400 — the request failed runtime validation (missing or
  // malformed actingWorkspaceId).
  "DEAL_LIST_INVALID",
  // 500 — unexpected internal failure outside the typed surfaces.
  "DEAL_LIST_FAILED",
  // M2 (#82): Personal Workspace convergence surface. These codes
  // are RESERVED for distinct boundary conditions; the normal
  // recovery path surfaces recovery via `setupState: "recovery"` on
  // the public user payload, NOT via an error envelope from
  // /verify-token.
  // 403 — Personal Workspace recovery is required and the normal
  // verifySignIn path cannot proceed (e.g., ops-side intervention).
  "PERSONAL_WORKSPACE_RECOVERY_REQUIRED",
  // 409 — an unexpected concurrent-write race escaped the
  // compare-and-set + retry budget. Defensive code; the safe envelope
  // covers it if it occurs.
  "PERSONAL_WORKSPACE_CONVERGENCE_CONFLICT",
  // M2 (#83): Intent selection surface.
  // 400 — the intent request body failed runtime validation.
  "INTENT_INVALID",
  // 403 — the acting human is not a current member of the target
  // Personal Workspace, the Workspace is not eligible, or some
  // other authorization rejection collapsed by the safe envelope.
  "INTENT_FORBIDDEN",
  // 409 — the request's `expectedCapabilities` did not match the
  // persisted capability set inside the locked transition. The
  // transaction has been rolled back; the response carries the
  // fresh capability set so the customer can re-submit with the
  // up-to-date precondition. Distinct from INTENT_FORBIDDEN
  // (authorization failure) so the UI can render an actionable
  // recovery rather than a false "not a current member" message.
  "INTENT_CONFLICT",
  // M2 (#84): SellerProfile creation / resume / publish / update
  // surface. Mirrors the intent pattern: 400 for malformed bodies
  // (including missing/invalid `idempotencyKey`), 403 for
  // authorization rejections (Personal-Workspace-only AND
  // Seller-capable — Organization actor, Buyer-only Personal, or
  // non-current member are all collapsed by the safe envelope),
  // 404 for missing draft rows on read, 409 for
  // duplicate-on-first-save / not-Draft-on-publish /
  // not-Published-on-update, 422 for incomplete Publish payload
  // (semantic-but-well-formed rejection; the safe envelope carries
  // `fields` for the multi-error summary), 500 for unexpected
  // internal failures.
  "SELLER_PROFILE_INVALID",
  "SELLER_PROFILE_FORBIDDEN",
  "SELLER_PROFILE_NOT_FOUND",
  "SELLER_PROFILE_DUPLICATE",
  "SELLER_PROFILE_INCOMPLETE",
  "SELLER_PROFILE_NOT_DRAFT",
  "SELLER_PROFILE_NOT_PUBLISHED",
  "SELLER_PROFILE_INTERNAL_FAILED",
  // M2 (#85): ServiceOffering creation / draft / activate surface.
  // Mirrors the #84 pattern: 400 for malformed bodies (including
  // missing/invalid `idempotencyKey`), 403 for authorization
  // rejections (Personal-Workspace-only AND Seller-capable AND the
  // SellerProfile is Published; non-current members, suspended
  // Workspaces, and unactivated SellerProfiles collapse to the safe
  // envelope), 404 for missing offering rows on read, 409 for
  // not-Draft-on-activate / already-Active, 422 for incomplete
  // activation payload (semantic-but-well-formed rejection; the
  // safe envelope carries `fields` for the multi-error summary),
  // 500 for unexpected internal failures.
  "SERVICE_OFFERING_INVALID",
  "SERVICE_OFFERING_FORBIDDEN",
  "SERVICE_OFFERING_NOT_FOUND",
  "SERVICE_OFFERING_INCOMPLETE",
  "SERVICE_OFFERING_NOT_DRAFT",
  "SERVICE_OFFERING_ALREADY_ACTIVE",
  "SERVICE_OFFERING_SELLER_PROFILE_NOT_PUBLISHED",
  // M2 (#85) PR-review feedback: the application boundary now
  // requires an explicit media-use confirmation version on every
  // audio upload. A missing or unknown version collapses to this
  // 400 — a 422 (semantic) would be misleading because the
  // request is structurally incomplete without the field.
  "AUDIO_SAMPLE_MEDIA_CONFIRMATION_REQUIRED",
  "SERVICE_OFFERING_INTERNAL_FAILED",
  // M2 (#86): post-activation lifecycle surface.
  // Pause authorization is independent of activation completeness;
  // a grandfathered nonconforming Active offering must remain pausable.
  // Reactivate re-runs the entire current activation contract. Update
  // (Active → Active) atomically replaces the public fields.
  //
  // 409 — Pause attempted on a non-Active offering (already Paused,
  // Draft, or Archived). A retry of the same previously-committed
  // idempotencyKey converges on the existing pause row and does NOT
  // surface this code; only a NEW key against an already-Paused
  // offering triggers this envelope.
  "SERVICE_OFFERING_ALREADY_PAUSED",
  // 409 — Reactivate attempted on a non-Paused offering (Active,
  // Draft, or Archived). A retry of the same previously-committed
  // idempotencyKey converges on the existing reactivation row and
  // does NOT surface this code.
  "SERVICE_OFFERING_NOT_PAUSED",
  // 409 — Update attempted on a non-Active offering (Paused, Draft,
  // or Archived). A retry of the same previously-committed
  // idempotencyKey converges on the existing update row.
  "SERVICE_OFFERING_NOT_ACTIVE",
  // 422 — Update payload is well-formed but semantically incomplete
  // (mirrors the SERVICE_OFFERING_INCOMPLETE pattern from activation).
  // The safe envelope carries `fields` for the multi-error summary.
  "SERVICE_OFFERING_INVALID_UPDATE",
  // M2 (#86): removing the final qualifying sample from an Active
  // offering requires an explicit eligibility-loss confirmation on
  // the request body (`confirmEligibilityLoss: true`). A removal
  // without that flag against the last qualifying Active sample
  // returns this 400 — a 422 (semantic) would be misleading because
  // the request is structurally incomplete without the explicit
  // confirmation field. The flag is transient and is never persisted
  // on the sample row.
  "AUDIO_SAMPLE_FINAL_REMOVAL_CONFIRMATION_REQUIRED",
  // M2 (#88): Personal-Workspace DealApprover JIT permission setup
  // surface. The codes never expose private audit identifiers
  // (`grantedByUserId`, `dealApproverId`); they only carry the
  // bounded typed rejection needed for the safe envelope. Status
  // mapping in `apps/api/src/lib/errors.ts` is the single source of
  // truth.
  // 400 — the request body failed runtime validation (missing or
  // malformed `actingWorkspaceId`, `confirmationVersion`, or
  // `idempotencyKey`).
  "DEAL_APPROVER_INVALID",
  // 403 — the acting Workspace is not Personal, the Workspace is not
  // Active, the authenticated human is not a current member, or some
  // other authorization rejection collapsed by the safe envelope.
  "DEAL_APPROVER_FORBIDDEN",
  // 409 — a different idempotencyKey against an already-provisioned
  // (workspaceId, userId) tuple, OR a same-key retry after a
  // committed failure whose persisted row is durable evidence of the
  // collapse. A same-key retry after a successful provisioning
  // converges on the existing row and does NOT surface this code.
  "DEAL_APPROVER_ALREADY_PROVISIONED",
  // 422 — the supplied `confirmationVersion` is not the closed
  // canonical value (`m2-deal-approver-v1`). The human must accept
  // the current version; a stale one is a typed rejection so the
  // application boundary cannot accept an unknown / future version.
  "DEAL_APPROVER_CONFIRMATION_VERSION_MISMATCH",
  // 500 — unexpected internal failure outside the typed
  // DealApproverError surface.
  "DEAL_APPROVER_INTERNAL_FAILED",
]);
export type ApiErrorCodeV1 = z.infer<typeof apiErrorCodeV1Schema>;

export const apiFieldErrorV1Schema = z
  .object({
    path: z.string().min(1),
    code: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();
export type ApiFieldErrorV1 = z.infer<typeof apiFieldErrorV1Schema>;

export const apiErrorResponseV1Schema = z
  .object({
    error: z
      .object({
        code: apiErrorCodeV1Schema,
        message: z.string().min(1).max(500),
        fields: z.array(apiFieldErrorV1Schema).max(50).optional(),
        requestId: z.string().min(1).max(128),
      })
      .strict(),
  })
  .strict();
export type ApiErrorResponseV1 = z.infer<typeof apiErrorResponseV1Schema>;

// ---------- Supported Caribbean affiliation codes ----------
//
// The application layer validates the user's `preferred` Caribbean
// affiliation codes against this canonical set. Unknown codes return
// INVALID_SEARCH_CRITERIA, not empty results.
export const SUPPORTED_CARIBBEAN_AFFILIATION_CODES = [
  "AG",
  "BB",
  "BS",
  "BZ",
  "DM",
  "DO",
  "GD",
  "GY",
  "HT",
  "JM",
  "KN",
  "LC",
  "SR",
  "TT",
  "VC",
] as const;
export type SupportedCaribbeanAffiliationCode =
  (typeof SUPPORTED_CARIBBEAN_AFFILIATION_CODES)[number];

export function isSupportedCaribbeanAffiliationCode(
  code: string,
): code is SupportedCaribbeanAffiliationCode {
  return (SUPPORTED_CARIBBEAN_AFFILIATION_CODES as readonly string[]).includes(code);
}

// M2 (#84): canonical display names for the closed Caribbean
// affiliation code list. Mirrors SUPPORTED_CARIBBEAN_AFFILIATION_CODES
// index-by-index. Used by the seller-profile taxonomy endpoint to
// render friendly names in the editor and publication review. This
// const is a TYPE-ONLY allow-list; the codes themselves are
// closed by SUPPORTED_CARIBBEAN_AFFILIATION_CODES above and the
// runtime guard `isSupportedCaribbeanAffiliationCode`.
export const SUPPORTED_CARIBBEAN_AFFILIATION_NAMES: ReadonlyArray<{
  readonly code: SupportedCaribbeanAffiliationCode;
  readonly name: string;
}> = [
  { code: "AG", name: "Antigua and Barbuda" },
  { code: "BB", name: "Barbados" },
  { code: "BS", name: "Bahamas" },
  { code: "BZ", name: "Belize" },
  { code: "DM", name: "Dominica" },
  { code: "DO", name: "Dominican Republic" },
  { code: "GD", name: "Grenada" },
  { code: "GY", name: "Guyana" },
  { code: "HT", name: "Haiti" },
  { code: "JM", name: "Jamaica" },
  { code: "KN", name: "Saint Kitts and Nevis" },
  { code: "LC", name: "Saint Lucia" },
  { code: "SR", name: "Suriname" },
  { code: "TT", name: "Trinidad and Tobago" },
  { code: "VC", name: "Saint Vincent and the Grenadines" },
];

// ---------- Stable controlled keys exposed for runtime validation ----------
//
// The canonical service categories, specialties, and pricing units
// live in PostgreSQL (seeded by packages/db/prisma/seed.ts). The
// @soundhub/types package does NOT maintain a parallel list of those
// keys. Closed behavioral enums (the next block) remain shared
// Zod/Prisma values per the accepted architecture, but the canonical
// catalog of which categories, specialties, and pricing units exist
// is resolved by the application-layer repository from PostgreSQL.

// ---------- Closed Prisma enum surfaces (for drift testing) ----------
//
// These mirror the values used by the Prisma enums in packages/db/prisma/schema.prisma.
// The drift test compares them at module load time and fails fast if the
// persistence layer and the public contract diverge.

export const workspaceTypeValuesV1 = ["Personal", "Organization"] as const;
export type WorkspaceTypeV1 = (typeof workspaceTypeValuesV1)[number];
export const workspaceStatusValuesV1 = ["Active", "Suspended"] as const;
export type WorkspaceStatusV1 = (typeof workspaceStatusValuesV1)[number];
export const workspaceMembershipRoleValuesV1 = ["Owner", "Admin", "Member"] as const;
export type WorkspaceMembershipRoleV1 = (typeof workspaceMembershipRoleValuesV1)[number];
export const marketplaceCapabilityValuesV1 = ["Buyer", "Seller"] as const;
export type MarketplaceCapabilityV1 = (typeof marketplaceCapabilityValuesV1)[number];
export const sellerProfileStatusValuesV1 = ["Draft", "Published", "Suspended"] as const;
export type SellerProfileStatusV1 = (typeof sellerProfileStatusValuesV1)[number];
export const serviceOfferingStatusValuesV1 = ["Draft", "Active", "Paused", "Archived"] as const;
export type ServiceOfferingStatusV1 = (typeof serviceOfferingStatusValuesV1)[number];
export const serviceModeValuesV1 = ["Remote", "InPerson", "Hybrid"] as const;
export type ServiceModeV1 = (typeof serviceModeValuesV1)[number];
export const pricingKindValuesV1 = ["StartingAt", "Fixed", "ContactForQuote"] as const;
export type PricingKindV1 = (typeof pricingKindValuesV1)[number];
export const purchaseModeValuesV1 = ["BundleOnly"] as const;
export type PurchaseModeV1 = (typeof purchaseModeValuesV1)[number];

// BG4 closed behavior states. These mirror the Prisma enum values
// added in migration 20260827090000_bg4_project_requests.
export const projectRequestStatusValuesV1 = ["Pending", "Accepted", "Declined"] as const;
export type ProjectRequestStatusV1 = (typeof projectRequestStatusValuesV1)[number];

export const dealStatusValuesV1 = ["Negotiating", "Active"] as const;
export type DealStatusV1 = (typeof dealStatusValuesV1)[number];

// ===========================================================================
// Milestone 2 (#84): Professional Profile (SellerProfile) shared runtime
// contracts.
//
// The schemas below cover the seller-profile draft / publish / update /
// read surface. The browser NEVER holds a second, independently deployable
// list of controlled Specialties or Caribbean affiliation codes — the
// metadata seam (see sellerProfileTaxonomyResponseV1Schema below and the
// GET /api/metadata/seller-profile-taxonomy route) is the only source of
// truth.
//
// Body validation follows the same patterns as the v1 search contract and
// the BG1 runtime contracts: shared Zod is the executable contract;
// TypeScript types are inferred from it; the same schema is consumed by
// the Express route validator and the browser response parser. `.strict()`
// rejects unknown fields. No Prisma model or raw provider subject ever
// crosses a public DTO.

// ---------- Taxonomy endpoint (controlled-values catalog) ----------
//
// One round trip on editor mount. The Specialty list comes from the
// existing `Specialty` table seeded by packages/db/prisma/seed.ts; the
// Caribbean affiliation code list comes from the closed
// SUPPORTED_CARIBBEAN_AFFILIATION_CODES const above. The HTTP layer is
// the only consumer — the browser never reads these consts directly.

export const sellerProfileTaxonomyItemSpecialtyV1Schema = z
  .object({
    key: z.string().min(1).max(64),
    name: z.string().min(1).max(200),
  })
  .strict();
export type SellerProfileTaxonomyItemSpecialtyV1 = z.infer<
  typeof sellerProfileTaxonomyItemSpecialtyV1Schema
>;

export const sellerProfileTaxonomyItemCountryV1Schema = z
  .object({
    code: countryCodeSchema,
    name: z.string().min(1).max(120),
  })
  .strict();
export type SellerProfileTaxonomyItemCountryV1 = z.infer<
  typeof sellerProfileTaxonomyItemCountryV1Schema
>;

export const sellerProfileTaxonomyResponseV1Schema = z
  .object({
    specialties: z.array(sellerProfileTaxonomyItemSpecialtyV1Schema).max(50),
    caribbeanAffiliationCodes: z.array(sellerProfileTaxonomyItemCountryV1Schema).max(50),
  })
  .strict();
export type SellerProfileTaxonomyResponseV1 = z.infer<typeof sellerProfileTaxonomyResponseV1Schema>;

// ---------- Shared payload fragments ----------
//
// Reused across draft / publish / update request schemas. NOT exposed
// publicly — these are request-side building blocks.

// STRICT basedIn. Used by publish / update REQUEST schemas and
// by the OwnerView of a Published profile (the persisted country
// code is required by the closed Caribbean-orientation surface).
const sellerProfileBasedInV1Schema = z
  .object({
    countryCode: countryCodeSchema,
    region: z.string().min(1).max(120).optional(),
    city: z.string().min(1).max(120).optional(),
  })
  .strict();
export type SellerProfileBasedInV1 = z.infer<typeof sellerProfileBasedInV1Schema>;

// RELAXED basedIn. Used by the draft request and by a Draft
// OwnerView. `countryCode` may be omitted because a partial
// first-save must not silently fabricate a country the seller
// never selected — per M2 #84 "Incomplete pre-publication Drafts
// remain private, resumable, absent from public DTOs, and
// presented as Private draft". Publish / update completeness is
// enforced separately via the STRICT sub-schema above.
const sellerProfileDraftBasedInV1Schema = z
  .object({
    countryCode: countryCodeSchema.optional(),
    region: z.string().min(1).max(120).optional(),
    city: z.string().min(1).max(120).optional(),
  })
  .strict();
export type SellerProfileDraftBasedInV1 = z.infer<typeof sellerProfileDraftBasedInV1Schema>;

// RELAXED identity. Used by draft requests (which may be partial
// per M2 #84: "Incomplete pre-publication Drafts remain private,
// resumable, absent from public DTOs, and presented as Private
// draft") and by the OwnerView response (which may carry a partial
// draft). Publication-time completeness is enforced separately via
// the STRICT sub-schema below.
const sellerProfileIdentityV1Schema = z
  .object({
    professionalName: z.string().max(200),
    // Preserve the canonical PublicSellerSummaryV1.bio bound (2000
    // characters). The Stitch editor's "248 / 600" counter is
    // presentation-only; the UI normalizes to the canonical domain
    // limit. The #84 brief does not authorize a tighter bound.
    bio: z.string().max(2000),
    avatarUrl: z.string().url().max(500).optional(),
  })
  .strict();
export type SellerProfileIdentityV1 = z.infer<typeof sellerProfileIdentityV1Schema>;

// STRICT identity. Used by publish / update REQUEST schemas. The
// publish-time completeness invariant ("Publication requires the
// functional specification's professional name, biography, ...")
// is enforced at the trusted Zod boundary so a direct API client
// cannot smuggle an empty identity through.
//
// Both required fields use `trimmedNonEmptyString` (declared at
// the top of this module) so a whitespace-only payload — `.min(1)`
// alone would accept `"   "` because it counts characters before
// trimming — is rejected with the same field-anchor shape as the
// other required-field paths. The relaxed draft schema below
// still permits drafts to persist with whitespace-only strings
// (the seller may edit the field later); the trimmed validation
// applies only to publish / update, per ticket #84's "missing
// fields on draft must remain private, resumable" rule.
const sellerProfilePublishUpdateIdentityV1Schema = z
  .object({
    professionalName: trimmedNonEmptyString(1, 200, "professionalName"),
    bio: trimmedNonEmptyString(1, 2000, "bio"),
    avatarUrl: z.string().url().max(500).optional(),
  })
  .strict();

const sellerProfileDisciplineV1Schema = z
  .object({
    specialtyKeys: z.array(z.string().min(1).max(64)).min(0).max(20),
    caribbeanAffiliationCodes: z.array(countryCodeSchema).min(0).max(20),
  })
  .strict();
export type SellerProfileDisciplineV1 = z.infer<typeof sellerProfileDisciplineV1Schema>;

// ---------- Draft request (lazy first-save / resume / update) ----------
//
// Save draft is explicit and idempotent w.r.t. the same payload. The
// existing `seller_profiles.workspaceId @unique` constraint plus the
// INSERT ... ON CONFLICT DO NOTHING primitive at provisionIntentAtomically
// (apps/api/src/auth-repository/prisma-auth-repository.ts:498) provide
// retry convergence without an explicit idempotencyKey on this surface.
// Draft saves are pure upsert — no separate evidence row.

export const sellerProfileDraftRequestV1Schema = z
  .object({
    identity: sellerProfileIdentityV1Schema,
    basedIn: sellerProfileDraftBasedInV1Schema,
    disciplines: sellerProfileDisciplineV1Schema,
    // Optional return target — schema-validated + server-resolved
    // safeReturnTo. Mirrors the #83 intent return-target pattern.
    returnTo: z.string().min(1).max(256).optional(),
  })
  .strict();
export type SellerProfileDraftRequestV1 = z.infer<typeof sellerProfileDraftRequestV1Schema>;

// ---------- Draft response ----------
//
// Returns the OwnerView shape so the editor re-renders with the
// persisted values without a second GET round trip.

const sellerProfileOwnerViewV1Schema = z
  .object({
    sellerProfileId: z.string().min(1),
    workspaceId: z.string().min(1),
    status: z.enum(["Draft", "Published", "Suspended"]),
    identity: sellerProfileIdentityV1Schema,
    // Drafts may carry a partial basedIn (countryCode omitted).
    // Published profiles always have countryCode set (the
    // publish/update STRICT schema enforces it). Either way, the
    // OwnerView shares the RELAXED shape; consumers that need the
    // STRICT invariant (i.e. anything reading a Published profile)
    // revalidate at the trust boundary.
    basedIn: sellerProfileDraftBasedInV1Schema,
    disciplines: sellerProfileDisciplineV1Schema,
    publishedAt: z.string().datetime().optional(),
    publishedByDisplayName: z.string().min(1).max(200).optional(),
  })
  .strict();
export type SellerProfileOwnerViewV1 = z.infer<typeof sellerProfileOwnerViewV1Schema>;

export const sellerProfileDraftResponseV1Schema = z
  .object({
    ok: z.literal(true),
    profile: sellerProfileOwnerViewV1Schema,
    returnTo: z.string().min(1).max(256).nullable(),
    safeReturnTo: z.string().min(1).max(256).nullable(),
  })
  .strict();
export type SellerProfileDraftResponseV1 = z.infer<typeof sellerProfileDraftResponseV1Schema>;

// ---------- Publish / Update request ----------
//
// Publish and post-publication update both require:
//   - complete public field set (same as draft payload)
//   - client-supplied idempotencyKey (UUID)
//   - server-known confirmationVersion (the immutable document
//     identifier). The constant `m2-profile-publication-v1` is the
//     closed enum for the M2 slice. A future document revision
//     increments the version suffix.
//
// `idempotencyKey` is generated by the client when a new
// publication/update attempt begins and is RETAINED across any
// uncertain transport outcome and explicit Retry action. Only a
// definitive successful response, a payload change, or explicit
// abandonment clears the key. The DB unique constraint
// (workspaceId, idempotencyKey) is the second defense against
// transport-retry duplicates.

export const SELLER_PROFILE_PUBLICATION_CONFIRMATION_VERSIONS = [
  "m2-profile-publication-v1",
] as const;
export type SellerProfilePublicationConfirmationVersionV1 =
  (typeof SELLER_PROFILE_PUBLICATION_CONFIRMATION_VERSIONS)[number];

const sellerProfilePublishUpdateCoreV1Schema = z
  .object({
    identity: sellerProfilePublishUpdateIdentityV1Schema,
    basedIn: sellerProfileBasedInV1Schema,
    disciplines: sellerProfileDisciplineV1Schema,
    // Immutable confirmation/document version. The application
    // layer resolves the canonical document text/version from this
    // key; the document itself is NOT duplicated in the request
    // body. Mirrors DealApproval.termsVersionId.
    confirmationVersion: z.enum(SELLER_PROFILE_PUBLICATION_CONFIRMATION_VERSIONS),
    // Client-supplied UUID generated when a new publication/update
    // attempt begins. Format: 8-4-4-4-12 hex with dashes. The DB
    // unique constraint (workspaceId, idempotencyKey) is the second
    // defense against transport-retry duplicates.
    idempotencyKey: z.string().uuid().min(36).max(64),
    returnTo: z.string().min(1).max(256).optional(),
  })
  .strict();

// ---------- Publish request ----------
//
// Publish is the FIRST transition from Draft → Published. The schema
// accepts the same shape as the draft (min(0) on both discipline
// arrays) so a publish-failing payload reaches the service layer
// rather than being rejected as INVALID. The service
// (`SellerProfileService.publishProfile`) re-validates completeness
// via `assertPublishCompleteness` and throws `SELLER_PROFILE_INCOMPLETE`
// — which maps to HTTP 422 with field-level details — for empty
// `specialtyKeys` or empty `caribbeanAffiliationCodes`. The route
// never reports a 400 for "publish payload is missing required
// controlled values"; that semantic is owned by the service.

export const sellerProfilePublishRequestV1Schema = sellerProfilePublishUpdateCoreV1Schema;
export type SellerProfilePublishRequestV1 = z.infer<typeof sellerProfilePublishRequestV1Schema>;

// ---------- Update request ----------
//
// Post-publication update (atomic full field set replacement). Same
// shape as publish; the service's `assertUpdateCompleteness` is the
// single source of truth for `SELLER_PROFILE_INCOMPLETE`.

export const sellerProfileUpdateRequestV1Schema = sellerProfilePublishUpdateCoreV1Schema;
export type SellerProfileUpdateRequestV1 = z.infer<typeof sellerProfileUpdateRequestV1Schema>;

// ---------- Publish / Update response ----------
//
// Returns the OwnerView plus the immutable evidence row's identity
// so the UI can render "Published at <publishedAt> by <displayName>"
// without a second GET round trip.

export const sellerProfilePublicationResponseV1Schema = z
  .object({
    ok: z.literal(true),
    profile: sellerProfileOwnerViewV1Schema,
    evidence: z
      .object({
        publishedAt: z.string().datetime(),
        confirmationVersion: z.enum(SELLER_PROFILE_PUBLICATION_CONFIRMATION_VERSIONS),
        idempotencyKey: z.string().uuid(),
      })
      .strict(),
    returnTo: z.string().min(1).max(256).nullable(),
    safeReturnTo: z.string().min(1).max(256).nullable(),
  })
  .strict();
export type SellerProfilePublicationResponseV1 = z.infer<
  typeof sellerProfilePublicationResponseV1Schema
>;

// ---------- Get response ----------
//
// Editor / review on-mount read. Distinct from the public
// PublicSellerSummaryV1 because the OwnerView returns Draft rows to
// their owner; the public summary is Published-only.

export const sellerProfileGetResponseV1Schema = z
  .object({
    ok: z.literal(true),
    profile: sellerProfileOwnerViewV1Schema.nullable(),
  })
  .strict();
export type SellerProfileGetResponseV1 = z.infer<typeof sellerProfileGetResponseV1Schema>;

// ===========================================================================
// Milestone 2 (#85): ServiceOffering creation / draft / activate surface.
//
// The schemas below cover the seller-facing Private-draft authoring surface:
// lazy first-save, resume / update-draft, explicit activate, and the
// editor / review on-mount read. The browser NEVER holds a second list of
// ServiceCategory / PricingUnit / IncludedService keys — the metadata seam
// (see serviceOfferingTaxonomyResponseV1Schema below and the
// GET /api/metadata/service-offering-taxonomy route) is the only source of
// truth.
//
// Body validation follows the same patterns as the v1 search contract and
// the BG1 runtime contracts: shared Zod is the executable contract;
// TypeScript types are inferred from it; the same schema is consumed by
// the Express route validator and the browser response parser. `.strict()`
// rejects unknown fields. No Prisma model or raw storage reference ever
// crosses a public DTO.
// ===========================================================================

// ---------- ServiceOffering drafts: lazy first-save / resume / update ----------
//
// The draft schema is RELAXED — every field is optional — so a partial
// first-save does not silently fabricate a value the seller never chose
// (the same lazy-first-save rule that the #84 draft schema applies).
// Activate requires the STRICT complete payload below.

// RELAXED title / description. Drafts may save with empty / partial
// values; the trimmed-non-empty validator applies only on the
// STRICT schema. Both fields preserve the canonical M1 surface
// limits (60 / 80 char title, 800 / 500 char description) — the
// stitch counter values are presentation-only and the implementation
// normalizes to the canonical domain limits.
const serviceOfferingDraftTitleV1Schema = z.string().max(80);
const serviceOfferingDraftDescriptionV1Schema = z.string().max(2000);

const serviceOfferingDraftServiceAreaV1Schema = z
  .object({
    countryCode: countryCodeSchema,
    region: z.string().min(1).max(120).optional(),
    city: z.string().min(1).max(120).optional(),
  })
  .strict();

// RELAXED pricing — any subset of fields. The STRICT schema below
// validates that Fixed / StartingAt carry a USD amount + currency +
// unitId, and that ContactForQuote carries no advertised amount.
const serviceOfferingDraftPricingV1Schema = z
  .object({
    kind: z.enum(pricingKindValuesV1).optional(),
    amountMinor: z.number().int().nonnegative().max(1_000_000_000).optional(),
    currency: z.string().length(3).optional(),
    unitId: z.string().min(1).max(64).optional(),
  })
  .strict();

// The draft request. Lazy first-save / resume / update-draft; the
// offering row is created on the first successful save (the
// `idempotencyKey` carries the same-attempt retry identity).
export const serviceOfferingDraftRequestV1Schema = z
  .object({
    title: serviceOfferingDraftTitleV1Schema.optional(),
    description: serviceOfferingDraftDescriptionV1Schema.optional(),
    primaryCategoryKey: z.string().min(1).max(64).optional(),
    serviceMode: z.enum(serviceModeValuesV1).optional(),
    serviceAreas: z.array(serviceOfferingDraftServiceAreaV1Schema).max(20).optional(),
    pricing: serviceOfferingDraftPricingV1Schema.optional(),
    genreTags: z.array(z.string().min(1).max(60)).max(30).optional(),
    includedServiceCategoryKeys: z.array(z.string().min(1).max(64)).max(20).optional(),
    // Same-attempt retry identity. Generated on the FIRST save of a
    // fresh session, retained across transport retries, cleared on
    // definitive success or on payload change. The DB unique
    // constraint on (offeringId, idempotencyKey) is the second
    // defense against transport-retry duplicates.
    idempotencyKey: z.string().min(1).max(64),
    returnTo: z.string().min(1).max(256).optional(),
  })
  .strict();
export type ServiceOfferingDraftRequestV1 = z.infer<typeof serviceOfferingDraftRequestV1Schema>;

// ---------- ServiceOffering create request ----------
//
// M2 (#85) PR-review feedback (round 3): the POST that lazy-creates
// a Draft offering ALSO persists the first-save draft payload
// atomically. The body carries the client-supplied idempotencyKey
// PLUS the full RELAXED draft field set (every field optional —
// a fresh Draft may save without a category, mode, pricing, or
// service areas, but the seller must type SOMETHING into the
// editor before pressing Save, so the create-empty-then-navigate-
// away orphan is impossible). The route also accepts the same
// idempotencyKey via the `Idempotency-Key` header for clients that
// prefer that convention. A deliberate second click (a new
// idempotencyKey) creates a NEW offering AND starts a fresh
// field-set.
export const serviceOfferingCreateDraftRequestV1Schema = z
  .object({
    idempotencyKey: z.string().min(1).max(128),
    title: serviceOfferingDraftTitleV1Schema.optional(),
    description: serviceOfferingDraftDescriptionV1Schema.optional(),
    primaryCategoryKey: z.string().min(1).max(64).optional(),
    serviceMode: z.enum(serviceModeValuesV1).optional(),
    serviceAreas: z.array(serviceOfferingDraftServiceAreaV1Schema).max(20).optional(),
    pricing: serviceOfferingDraftPricingV1Schema.optional(),
    genreTags: z.array(z.string().min(1).max(60)).max(30).optional(),
    includedServiceCategoryKeys: z.array(z.string().min(1).max(64)).max(20).optional(),
  })
  .strict();
export type ServiceOfferingCreateDraftRequestV1 = z.infer<
  typeof serviceOfferingCreateDraftRequestV1Schema
>;

// ---------- ServiceOffering activation request ----------
//
// Activation requires the FULL public field set (mirrors the
// publish/update STRICT pattern for SellerProfile). Each "required"
// field uses trimmedNonEmptyString so a whitespace-only payload is
// rejected at the trusted boundary, not later in the service.
//
// Activation also carries the same idempotencyKey + confirmationVersion
// contract: the (offeringId, idempotencyKey) unique constraint on the
// service_offering_activations table is the second defense against
// transport-retry duplicates.

export const SERVICE_OFFERING_ACTIVATION_CONFIRMATION_VERSIONS = [
  "m2-service-activation-v1",
] as const;
export type ServiceOfferingActivationConfirmationVersionV1 =
  (typeof SERVICE_OFFERING_ACTIVATION_CONFIRMATION_VERSIONS)[number];

const serviceOfferingActivationTitleV1Schema = trimmedNonEmptyString(1, 80, "title");
const serviceOfferingActivationDescriptionV1Schema = trimmedNonEmptyString(1, 2000, "description");

const serviceOfferingActivationServiceAreaV1Schema = z
  .object({
    countryCode: countryCodeSchema,
    region: z.string().min(1).max(120).optional(),
    city: z.string().min(1).max(120).optional(),
  })
  .strict();

// Pricing on activation. The kind, amount, currency, and unitId
// must satisfy the canonical Fixed / StartingAt / ContactForQuote
// semantics — Fixed and StartingAt require a USD amount in minor
// units plus a PricingUnit; ContactForQuote carries no amount.
const serviceOfferingActivationPricingV1Schema = z
  .object({
    kind: z.enum(pricingKindValuesV1),
    amountMinor: z.number().int().nonnegative().max(1_000_000_000).optional(),
    currency: z.string().length(3).optional(),
    unitId: z.string().min(1).max(64).optional(),
  })
  .strict()
  .refine(
    (p) =>
      p.kind === "ContactForQuote" ||
      (p.amountMinor !== undefined && p.currency === "USD" && p.unitId !== undefined),
    {
      message: "Fixed or StartingAt pricing requires amountMinor, currency=USD, and unitId.",
      path: ["pricing"],
    },
  )
  .refine((p) => p.kind !== "ContactForQuote" || p.amountMinor === undefined, {
    message: "ContactForQuote pricing must not advertise an amount.",
    path: ["pricing"],
  });

export const serviceOfferingActivateRequestV1Schema = z
  .object({
    title: serviceOfferingActivationTitleV1Schema,
    description: serviceOfferingActivationDescriptionV1Schema,
    primaryCategoryKey: z.string().min(1).max(64),
    serviceMode: z.enum(serviceModeValuesV1),
    serviceAreas: z.array(serviceOfferingActivationServiceAreaV1Schema).max(20),
    pricing: serviceOfferingActivationPricingV1Schema,
    genreTags: z.array(z.string().min(1).max(60)).max(30),
    includedServiceCategoryKeys: z.array(z.string().min(1).max(64)).max(20),
    confirmationVersion: z.enum(SERVICE_OFFERING_ACTIVATION_CONFIRMATION_VERSIONS),
    idempotencyKey: z.string().uuid().min(36).max(64),
    returnTo: z.string().min(1).max(256).optional(),
  })
  .strict();
export type ServiceOfferingActivateRequestV1 = z.infer<
  typeof serviceOfferingActivateRequestV1Schema
>;

// M2 (#85) PR-review feedback: closed set of media-use confirmation
// versions the seller must acknowledge before each upload. Declared
// here (before the ServiceOfferingOwnerSampleSummaryV1 schema and
// the bg2AudioSamplePublicV1Schema that reference it) so the forward
// reference resolves at type-check time.
export const SERVICE_OFFERING_AUDIO_MEDIA_CONFIRMATION_VERSIONS = [
  "m2-audio-confirmation-v1",
] as const;
export type ServiceOfferingAudioMediaConfirmationVersionV1 =
  (typeof SERVICE_OFFERING_AUDIO_MEDIA_CONFIRMATION_VERSIONS)[number];

// ---------- ServiceOffering owner view (read shape) ----------
//
// Mirrors the SellerProfile owner view: the editor / review on-mount
// read returns Draft rows to their owner. The status, activation
// evidence, and audio sample summary are included so the editor can
// derive readiness without a second round trip. Sample playbackUrl is
// generated server-side at read time so the browser can render the
// player without an additional resolve step.

export const serviceOfferingOwnerSampleSummaryV1Schema = z
  .object({
    sampleId: z.string().min(1).max(128),
    label: z.string().min(1).max(120),
    contentType: z.literal("audio/mpeg"),
    byteSize: z
      .number()
      .int()
      .nonnegative()
      .max(25 * 1024 * 1024),
    displayOrder: z.number().int().min(1).max(3),
    playbackUrl: z.string().url(),
    // M2 (#85) PR-review feedback: the owner-view sample summary
    // surfaces the same confirmation fields the activation
    // completeness recheck uses, so the editor can render the
    // readiness checklist from the durable persisted state rather
    // than a client-side filter on confirmation-only metadata it
    // never receives.
    confirmation: z
      .object({
        version: z.enum(SERVICE_OFFERING_AUDIO_MEDIA_CONFIRMATION_VERSIONS),
        confirmedAt: z.string().datetime(),
      })
      .strict(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type ServiceOfferingOwnerSampleSummaryV1 = z.infer<
  typeof serviceOfferingOwnerSampleSummaryV1Schema
>;

// M2 (#86, slice 86E + 86F): closed-shape readiness view, derived
// by the API runtime from the same pure predicate the operator
// inventory uses (`deriveServiceOfferingReadiness` from `@soundhub/db`).
// The closed-set reason vocabulary is the slice 86E contract: no
// silently-invented alternative buckets. The runtime consumes the
// predicate so the UI never re-implements the rule.
export const serviceOfferingReadinessV1Schema = z
  .object({
    isAvailable: z.boolean(),
    updateNeeded: z.boolean(),
    reasonCategories: z
      .array(
        z.enum([
          "title-required",
          "description-required",
          "category-required",
          "service-area-required",
          "pricing-required",
          "audio-sample-required",
          "activation-confirmation-stale",
          "seller-profile-not-published",
        ]),
      )
      .max(8),
    isGrandfatheredNonconforming: z.boolean(),
  })
  .strict();
export type ServiceOfferingReadinessV1 = z.infer<typeof serviceOfferingReadinessV1Schema>;

// Closed union of the readiness reason categories. Re-exported as
// a named type so internal call sites (the API repository's
// `ServiceOfferingOwnerViewRecord.readiness.reasonCategories`,
// the in-memory adapter's `toOwnerView` helper) can carry the
// closed set without restating the enum.
export type ServiceOfferingReadinessReasonCategory =
  ServiceOfferingReadinessV1["reasonCategories"][number];

export const serviceOfferingOwnerViewV1Schema = z
  .object({
    serviceOfferingId: z.string().min(1).max(128),
    workspaceId: z.string().min(1).max(128),
    sellerProfileId: z.string().min(1).max(128),
    status: z.enum(serviceOfferingStatusValuesV1),
    title: z.string().max(80),
    description: z.string().max(2000),
    primaryCategoryKey: z.string().max(64).nullable(),
    serviceMode: z.enum(serviceModeValuesV1).nullable(),
    serviceAreas: z.array(serviceOfferingDraftServiceAreaV1Schema).max(20),
    pricing: serviceOfferingDraftPricingV1Schema.nullable(),
    genreTags: z.array(z.string().min(1).max(60)).max(30),
    includedServiceCategoryKeys: z.array(z.string().min(1).max(64)).max(20),
    // The bounded sample summary the editor renders. PendingCleanup
    // and Removed samples are excluded; the buyer-facing list never
    // sees a Draft offering's samples either way (the buyer-side
    // gate is on Active + Published + Active Workspace + Seller
    // capability).
    samples: z.array(serviceOfferingOwnerSampleSummaryV1Schema).max(3),
    activatedAt: z.string().datetime().nullable(),
    activatedByDisplayName: z.string().min(1).max(200).nullable(),
    // M2 (#86, slice 86F): readiness derived from the persisted
    // state by the API runtime. The runtime's source of truth is
    // `deriveServiceOfferingReadiness` from `@soundhub/db` — the
    // same predicate the operator inventory CLI uses. The web
    // editor renders this verbatim and does not re-derive.
    readiness: serviceOfferingReadinessV1Schema,
  })
  .strict();
export type ServiceOfferingOwnerViewV1 = z.infer<typeof serviceOfferingOwnerViewV1Schema>;

// ---------- ServiceOffering list (owner scope) ----------

export const serviceOfferingOwnerListResponseV1Schema = z
  .object({
    ok: z.literal(true),
    offerings: z.array(serviceOfferingOwnerViewV1Schema).max(200),
  })
  .strict();
export type ServiceOfferingOwnerListResponseV1 = z.infer<
  typeof serviceOfferingOwnerListResponseV1Schema
>;

// ---------- Draft / activate responses ----------

export const serviceOfferingDraftResponseV1Schema = z
  .object({
    ok: z.literal(true),
    offering: serviceOfferingOwnerViewV1Schema,
    returnTo: z.string().min(1).max(256).nullable(),
    safeReturnTo: z.string().min(1).max(256).nullable(),
  })
  .strict();
export type ServiceOfferingDraftResponseV1 = z.infer<typeof serviceOfferingDraftResponseV1Schema>;

export const serviceOfferingActivationEvidenceV1Schema = z
  .object({
    activatedAt: z.string().datetime(),
    confirmationVersion: z.enum(SERVICE_OFFERING_ACTIVATION_CONFIRMATION_VERSIONS),
    idempotencyKey: z.string().uuid(),
  })
  .strict();
export type ServiceOfferingActivationEvidenceV1 = z.infer<
  typeof serviceOfferingActivationEvidenceV1Schema
>;

export const serviceOfferingActivationResponseV1Schema = z
  .object({
    ok: z.literal(true),
    offering: serviceOfferingOwnerViewV1Schema,
    evidence: serviceOfferingActivationEvidenceV1Schema,
    returnTo: z.string().min(1).max(256).nullable(),
    safeReturnTo: z.string().min(1).max(256).nullable(),
  })
  .strict();
export type ServiceOfferingActivationResponseV1 = z.infer<
  typeof serviceOfferingActivationResponseV1Schema
>;

export const serviceOfferingGetResponseV1Schema = z
  .object({
    ok: z.literal(true),
    offering: serviceOfferingOwnerViewV1Schema.nullable(),
  })
  .strict();
export type ServiceOfferingGetResponseV1 = z.infer<typeof serviceOfferingGetResponseV1Schema>;

// ---------- M2 (#86): ServiceOffering pause / reactivate / updateActive ----------
//
// These commands reuse the STRICT activation contract for Reactivate
// and `updateActive` because both re-run the complete activation
// validation. We DO NOT reimplement the field rules here — the
// activation Zod schema (defined above) is the single source of truth.
// The aliases below make the call-site typing explicit and give
// consumers a stable reference even if the underlying schema ever
// gains an internal-only field.
//
// The Pause command carries only an idempotencyKey. Authorization
// (Personal-Workspace-only AND Seller-capable AND ownership) and
// precondition (status === "Active") are enforced server-side; the
// Pause request body has no business field beyond the retry-identity
// UUID.

// Pause request: idempotencyKey only.
// The Pause command is a single-state transition; the request body
// carries no field payload beyond the retry-identity UUID. All
// authorization, precondition, and persistence decisions live
// server-side. The schema is strict — any additional field (for
// example a future `returnTo` redirect hint) must be added
// intentionally to the schema rather than smuggled through.
export const serviceOfferingPauseRequestV1Schema = z
  .object({
    idempotencyKey: z.string().uuid().min(36).max(64),
  })
  .strict();
export type ServiceOfferingPauseRequestV1 = z.infer<typeof serviceOfferingPauseRequestV1Schema>;

// Pause evidence view (private to the persistence layer; the
// response-side shape below wraps it with the OwnerView for the
// route handler).
export const serviceOfferingPauseEvidenceV1Schema = z
  .object({
    pausedAt: z.string().datetime(),
    reason: z.enum(["user_initiated", "final_sample_removal"]),
    idempotencyKey: z.string().uuid().min(36).max(64),
  })
  .strict();
export type ServiceOfferingPauseEvidenceV1 = z.infer<typeof serviceOfferingPauseEvidenceV1Schema>;

// Pause response: same shape as the draft / activate responses —
// the OwnerView of the now-Paused offering plus the pause evidence.
export const serviceOfferingPauseResponseV1Schema = z
  .object({
    ok: z.literal(true),
    offering: serviceOfferingOwnerViewV1Schema,
    evidence: serviceOfferingPauseEvidenceV1Schema,
    returnTo: z.string().min(1).max(256).nullable(),
    safeReturnTo: z.string().min(1).max(256).nullable(),
  })
  .strict();
export type ServiceOfferingPauseResponseV1 = z.infer<typeof serviceOfferingPauseResponseV1Schema>;

// Reactivate request: alias of the existing STRICT activation request
// schema. Reactivate carries the same complete public field set with
// the same idempotencyKey + confirmationVersion contract because the
// repository re-runs the same activation completeness check
// (buildActivationCompletenessFieldErrors + CONFIRMED Live sample
// count + SellerProfile.published precondition). Failure leaves the
// offering Paused.
export const serviceOfferingReactivateRequestV1Schema = serviceOfferingActivateRequestV1Schema;
export type ServiceOfferingReactivateRequestV1 = ServiceOfferingActivateRequestV1;
// The response shape is the existing activation response — Reactivate
// produces a new ServiceOfferingActivation evidence row whose
// `pausedAt`/`activatedAt` field carries the reactivation moment.
export type ServiceOfferingReactivateResponseV1 = ServiceOfferingActivationResponseV1;

// Update request: alias of the existing STRICT activation request
// schema. `updateActive` carries the same complete public field set
// because the repository runs the same activation completeness check.
// On success the public fields are replaced atomically and one
// ServiceOfferingUpdate evidence row is appended; on failure the
// prior public state is preserved verbatim per ADR 0008.
export const serviceOfferingUpdateRequestV1Schema = serviceOfferingActivateRequestV1Schema;
export type ServiceOfferingUpdateRequestV1 = ServiceOfferingActivateRequestV1;

// Update evidence view (private to the persistence layer).
export const serviceOfferingUpdateEvidenceV1Schema = z
  .object({
    updatedAt: z.string().datetime(),
    confirmationVersion: z.enum(SERVICE_OFFERING_ACTIVATION_CONFIRMATION_VERSIONS),
    idempotencyKey: z.string().uuid().min(36).max(64),
  })
  .strict();
export type ServiceOfferingUpdateEvidenceV1 = z.infer<typeof serviceOfferingUpdateEvidenceV1Schema>;

// Update response: the OwnerView of the now-updated Active offering
// plus the update evidence. The response deliberately does NOT include
// any `activatedAt` re-write or update metadata exposed on the
// OwnerView — the activation history is preserved unchanged per ADR
// 0008.
export const serviceOfferingUpdateResponseV1Schema = z
  .object({
    ok: z.literal(true),
    offering: serviceOfferingOwnerViewV1Schema,
    evidence: serviceOfferingUpdateEvidenceV1Schema,
    returnTo: z.string().min(1).max(256).nullable(),
    safeReturnTo: z.string().min(1).max(256).nullable(),
  })
  .strict();
export type ServiceOfferingUpdateResponseV1 = z.infer<typeof serviceOfferingUpdateResponseV1Schema>;

// ---------- ServiceOffering taxonomy (controlled values) ----------
//
// One round trip on editor mount. The categories list comes from
// the existing `ServiceCategory` table seeded by
// packages/db/prisma/seed.ts; the pricingUnits list comes from the
// existing `PricingUnit` table; the bundleOnlyCategoryKeys are the
// subset of ServiceCategory rows with `bundleOnly: true` (the only
// kind the canonical IncludedService surface accepts).
//
// The HTTP layer is the only consumer — the browser never reads
// these consts directly.
export const serviceOfferingTaxonomyResponseV1Schema = z
  .object({
    categories: z.array(categoryMetadataItemV1Schema).max(200),
    pricingUnits: z
      .array(
        z
          .object({
            key: z.string().min(1).max(64),
            name: z.string().min(1).max(200),
          })
          .strict(),
      )
      .max(50),
    bundleOnlyCategoryKeys: z.array(z.string().min(1).max(64)).max(200),
  })
  .strict();
export type ServiceOfferingTaxonomyResponseV1 = z.infer<
  typeof serviceOfferingTaxonomyResponseV1Schema
>;

// ===========================================================================
// Buildathon Golden Slice 1 (BG1) shared runtime contracts.
//
// These schemas cover the identity, session, and acting-Workspace
// surfaces. They follow the same patterns as the v1 search contract:
// shared Zod is the executable contract; TypeScript types are inferred
// from it; the same schema is consumed by the Express route validator
// and the browser response parser. No Prisma model or raw provider
// subject ever crosses a public DTO.
//
// Per ticket #59, the GS 1 / GS 2 / GS 3 / GS 4 / GS 5 / GS 6
// requirements are:
//
//   GS 1 — preserve the buildathon-only governance boundary.
//   GS 2 — deployed managed magic-link auth with the bounded fallback.
//   GS 3 — both adapters map credentials to persisted UserAccounts and
//          produce server-validated sessions through the same boundary.
//   GS 4 — every Golden Slice command names an acting Workspace and
//          rejects a human without a current qualifying membership.
//   GS 5 — a matching legacy Workspace.ownerUserId grants no authority
//          without current membership.
//   GS 6 — buyer/seller Workspaces, capabilities, and memberships are
//          persisted (no DealApprover authorization here; BG5 owns it).
//
// ===========================================================================

// ---------- Magic link request ----------

// SoundHub always uses neutral responses: the request envelope returns
// the same shape whether the email is registered or not, so the public
// surface cannot be used to enumerate accounts. The deterministic
// adapter adds a test-only `devVerificationUrl` for the local
// integration test; managed providers omit
// it because the real email delivery happens on the provider side.
export const bg1MagicLinkRequestV1Schema = z
  .object({
    email: z
      .string()
      .trim()
      .toLowerCase()
      .email("email must be a valid email address")
      .max(254, "email must be at most 254 characters"),
    // Optional human-friendly hint carried into the session metadata
    // for diagnostics. Never returned to other members.
    displayName: z.string().min(1).max(120).optional(),
    // M2 (#82): optional validated internal return destination. The
    // server validates against the configured application origin
    // (canonical URL parsing) and stores the path in a short-lived
    // HttpOnly cookie. The cookie is re-validated and surfaced as the
    // `returnTo` field on the verify-token response. Invalid values
    // are silently dropped so the caller never has to handle a
    // partial cookie set.
    return: z.string().min(1).max(256).optional(),
  })
  .strict();
export type Bg1MagicLinkRequestV1 = z.infer<typeof bg1MagicLinkRequestV1Schema>;

export const bg1MagicLinkResponseV1Schema = z
  .object({
    // Neutral acknowledgement. `ok` is always true on a well-formed
    // request; rate-limited or otherwise rejected requests produce the
    // standard safe error envelope instead.
    ok: z.literal(true),
    // Public correlation id for the magic-link request (per ticket
    // #59 P2-001). This value is observability only; it is NOT a
    // verification credential. The managed adapter returns a
    // SoundHub-side UUID and never reads it back; the deterministic
    // adapter returns its own correlation id and keys its pending
    // request under a separate private `verificationToken`. A browser
    // that round-trips this value to `/api/auth/verify-token` is
    // rejected as an unknown credential.
    requestId: z.string().min(1).max(256),
    // Deterministic-adapter local-test mode only: a one-time
    // verification URL that the Playwright flow can follow without
    // live email delivery. Production Supabase
    // magic-link emails render this field absent; the deployed
    // deterministic fallback also renders it absent so an
    // unauthenticated browser cannot choose a demo identity by
    // email. The contract documents the field name verbatim so a
    // contract-drift detector can catch an adapter that begins
    // leaking the verification URL to a deployed browser.
    devVerificationUrl: z.string().min(1).max(2048).optional(),
  })
  .strict();
export type Bg1MagicLinkResponseV1 = z.infer<typeof bg1MagicLinkResponseV1Schema>;

// ---------- Verify token ----------
//
// The verify-token request carries the **private one-time verification
// credential** extracted from the magic-link callback URL — NOT a
// public correlation id. The BG1 provider-neutral contract requires
// distinct names for the two values so a future adapter cannot
// accidentally substitute one for the other (ticket #59 P2-001):
//
//   - `requestId` is the **public correlation id** returned in the
//     magic-link response and carried into logs and observability.
//     It is never a credential and cannot be used to mint a session.
//   - `verificationToken` is the **private one-time credential** the
//     browser extracts from the managed email callback URL or the
//     explicitly gated local test URL. It is the only
//     value `verifySignIn` accepts. It MUST NEVER appear in public
//     DTOs, error envelopes, or log lines.
export const bg1VerifyTokenRequestV1Schema = z
  .object({
    verificationToken: z.string().min(1).max(512),
  })
  .strict();
export type Bg1VerifyTokenRequestV1 = z.infer<typeof bg1VerifyTokenRequestV1Schema>;

// The verify-token response is what the server returns when a magic-link
// verification succeeds. The HttpOnly session cookie is set on the
// response side (not part of the body) so the client cannot read the
// session id; this body contains only allow-listed identity and
// membership facts the client needs to render the post-sign-in state.
export const bg1PublicWorkspaceV1Schema = z
  .object({
    workspaceId: z.string().min(1).max(128),
    slug: z.string().min(1).max(120),
    name: z.string().min(1).max(200),
    workspaceType: z.enum(["Personal", "Organization"]),
    workspaceStatus: z.enum(["Active", "Suspended"]),
    // M2 (#82): relaxed from `.min(1)` to `.max(8)`. A freshly
    // converged Personal Workspace has no capabilities until the
    // human chooses an intent (later M2 ticket #83). The mapper
    // produces an empty array; the schema permits it.
    capabilities: z.array(z.enum(["Buyer", "Seller"])).max(8),
  })
  .strict();
export type Bg1PublicWorkspaceV1 = z.infer<typeof bg1PublicWorkspaceV1Schema>;

// M2 (#82): server-derived Personal Workspace setup state. The
// convergence service classifies the state into "converged" or
// "recovery" and surfaces it here. The browser reads ONLY this field
// to render the Personal Workspace dashboard or the recovery
// surface — it never infers recovery from the workspaces array
// (which would let a future Workspace type or capability flag
// silently change the result).
export const bg1SetupStateValuesV1 = ["converged", "recovery"] as const;
export type Bg1SetupStateV1 = (typeof bg1SetupStateValuesV1)[number];

export const bg1PublicUserV1Schema = z
  .object({
    userAccountId: z.string().min(1).max(128),
    // The primary SoundHub-owned email, when present. May be absent if
    // the identity provider does not surface an email and the user has
    // not set one explicitly. Per ADR 0004 the email is private; it
    // never enters the public seller contract and the workspace UI is
    // the only place it appears (for the signed-in user themselves).
    email: z.string().email().nullable(),
    displayName: z.string().min(1).max(120).nullable(),
    // The provider key is exposed to the signed-in user so they can
    // understand how SoundHub authenticated them, but the provider
    // subject NEVER crosses a public DTO (privacy boundary). Provider
    // claims, roles, and metadata never identify or authorize a
    // Workspace — only the server-validated UserAccount does.
    identityProvider: z.string().min(1).max(64),
    workspaces: z.array(bg1PublicWorkspaceV1Schema).max(64),
    // M2 (#82): server-derived setup state. The convergence service
    // classifies the Personal Workspace state into "converged" or
    // "recovery" — never "recovery" with the internal reason
    // (pointer-workspace-missing, pointer-not-personal, etc.) which
    // is server-internal only.
    setupState: z.enum(bg1SetupStateValuesV1),
  })
  .strict();
export type Bg1PublicUserV1 = z.infer<typeof bg1PublicUserV1Schema>;

export const bg1VerifyTokenResponseV1Schema = z
  .object({
    ok: z.literal(true),
    user: bg1PublicUserV1Schema,
    // M2 (#82): validated internal return destination. The browser
    // navigates to this path after successful authentication. `null`
    // means no destination was preserved (or it was overridden by
    // recovery, or the cookie was invalid). The browser falls back
    // to `/dashboard` (or `/dashboard?recovery=1` on recovery).
    returnTo: z.string().min(1).max(256).nullable(),
  })
  .strict();
export type Bg1VerifyTokenResponseV1 = z.infer<typeof bg1VerifyTokenResponseV1Schema>;

// ---------- Current session info ----------

export const bg1SessionInfoV1Schema = z
  .object({
    // Null when the request carries no valid session cookie. Otherwise
    // the user the cookie authenticates, plus the workspaces they
    // currently belong to. The acting workspace is NOT in this
    // payload: per GS 4 every consequential command must carry the
    // acting workspace explicitly, so the UI chooses a workspace and
    // passes it on the command itself rather than persisting it on the
    // session.
    user: bg1PublicUserV1Schema.nullable(),
  })
  .strict();
export type Bg1SessionInfoV1 = z.infer<typeof bg1SessionInfoV1Schema>;

// ---------- Sign out ----------

export const bg1SignOutResponseV1Schema = z
  .object({
    ok: z.literal(true),
  })
  .strict();
export type Bg1SignOutResponseV1 = z.infer<typeof bg1SignOutResponseV1Schema>;

// ---------- Sample consequential command (acts as a Workspace) ----------
//
// The Buildathon Golden Slice ticket (#59) requires that
// consequential command contracts identify an acting Workspace and use
// a reusable current-membership authorization service. This is the
// minimal sample contract used to demonstrate that property at the
// HTTP boundary and in the focused authorization tests. Real
// ProjectRequest, Deal, TermsVersion, and approval commands will be
// authored against the same pattern in later tickets; this sample is
// sufficient to satisfy GS 4 / GS 5 / GS 6 today.
export const bg1ActingWorkspaceRequestV1Schema = z
  .object({
    actingWorkspaceId: z.string().min(1).max(128),
    // M2 #83 continuation: the switch interstitial forwards the
    // raw `?return=` query into the request body when present.
    // The route revalidates and resolves it under the
    // post-commit acting Workspace context via
    // `resolvePostCommandReturnDestination`; the response only
    // carries the bounded `safeReturnTo`. Invalid / missing
    // values drop to `safeReturnTo: null` and the browser falls
    // back to `/dashboard`.
    returnTo: z.string().min(1).max(256).optional(),
  })
  .strict();
export type Bg1ActingWorkspaceRequestV1 = z.infer<typeof bg1ActingWorkspaceRequestV1Schema>;

export const bg1ActingWorkspaceResponseV1Schema = z
  .object({
    ok: z.literal(true),
    actingWorkspace: bg1PublicWorkspaceV1Schema,
    membership: z
      .object({
        role: z.enum(["Owner", "Admin", "Member"]),
        joinedAt: z.string().datetime(),
      })
      .strict(),
    // M2 #83 remediation (§5): server-resolved safe return
    // destination. Bounded by
    // `apps/api/src/lib/post-command-return-destination.ts` to the
    // explicit #83 route shapes. The browser consumes only this
    // value; it does NOT read raw query parameters or pattern-match
    // paths. `null` when no returnTo was supplied or none passes
    // the bounded revalidation.
    safeReturnTo: z.string().min(1).max(256).nullable(),
  })
  .strict();
export type Bg1ActingWorkspaceResponseV1 = z.infer<typeof bg1ActingWorkspaceResponseV1Schema>;

// ---------- Stable provider keys exposed for runtime validation ----------
//
// The provider keys are a closed enum so a future provider can only be
// added by editing this contract and the adapter factory together.
// SoundHub owns these keys; provider SDKs never read them.
export const bg1IdentityProviderV1Values = ["managed-magic-link", "deterministic"] as const;
export type Bg1IdentityProviderV1 = (typeof bg1IdentityProviderV1Values)[number];

// ---------- Shared deterministic subject derivation ----------
//
// The deterministic identity adapter and the seed must agree on the
// provider subject derived from an email. Otherwise the seeded
// IdentityProvider row for a demo account never matches the row the
// adapter looks up at sign-in, and a second UserAccount is created
// for the same email.
//
// The derivation is intentionally opaque (a SHA-256 hash). It is
// scoped per-provider so a future migration to a different adapter
// cannot accidentally resolve to the same subject for an unrelated
// email. The hash function is injected so this contract lives in
// `@soundhub/types` (no Node-only imports) while every consumer
// passes Node `crypto.createHash` or an equivalent WebCrypto digest.
export type Sha256HexFn = (input: string) => string;

export function deriveDeterministicSubject(email: string, sha256Hex: Sha256HexFn): string {
  return sha256Hex(`deterministic|${email.trim().toLowerCase()}`);
}

// ===========================================================================
// M2 (#83) shared runtime contracts.
//
// Intent selection is the Personal-Workspace-scoped command that lets
// a freshly-converged human choose `Hire talent`, `Offer services`, or
// `Both`. The command is capability-creating only; it never grants
// `DealApprover` and never publishes seller content. The acting
// Workspace id is required so the route can revalidate current Owner
// membership (any Owner/Admin/Member role passes
// `requireActingMembership` — the route is not Owner-only per ticket
// #82). Neither Buyer nor Seller capability collects a generic
// participation/terms acceptance at capability-provisioning time —
// context-specific confirmations are owned by their later boundaries
// (SellerProfile publication, media use, ServiceOffering activation,
// Deal approval authority / approval).
//
// The `returnTo` field on the request is validated by the route via
// the existing internal-return validation rules
// (`apps/api/src/lib/return-context.ts`). Invalid values are silently
// dropped; the route proceeds with `returnTo: null`. The successful
// response echoes only the validated `returnTo`. The intent contract
// does not carry `setupState` — recovery is already surfaced via the
// existing `bg1PublicUserV1Schema.setupState` field on the user
// payload and the dashboard renders it.
// ===========================================================================

// ---------- Closed intent values ----------

export const intentKindV1Values = ["Hire", "Offer", "Both"] as const;
export type IntentKindV1 = (typeof intentKindV1Values)[number];

// ---------- Bounded post-command return routes (M2 #83) ----------
//
// The closed set of internal return routes the post-command destination
// resolver may emit. This list is the SHARED definition consumed by both
// the server-side authority boundary
// (`apps/api/src/lib/post-command-return-destination.ts`) AND the typed
// client narrowing helper on the Workspace-switch interstitial
// (`apps/web/src/app/workspace/switch/page.tsx`). Adding a route in the
// resolver MUST extend this list in lock-step so a server-returnable
// value can never be silently rejected by the client narrowing helper.
//
// The set is intentionally closed (#83 review §5): unknown routes fall
// back to `/dashboard` rather than being pattern-matched. The resolver
// does not build a general route-manifest authorization engine; the
// list of authorized destinations is the closed enum declared here.
export const postCommandRouteValuesV1 = [
  "/dashboard",
  "/workspace/intent",
  "/workspace/switch",
  "/talent",
  "/deals",
  "/seller-requests",
  "/dashboard/audio",
  // M2 (#84): Professional Profile editor + publication review. The
  // SellerProfile slice is Personal-Workspace-only and Seller-capable;
  // the gate map in apps/api/src/lib/post-command-return-destination.ts
  // adds a `Seller` capability requirement on these two routes so a
  // Buyer-only Workspace returning from a non-#84 command cannot
  // resume the editor under a stale Buyer actor.
  "/seller/profile/edit",
  "/seller/profile/review",
  // M2 (#87): Matchmaker. The route is open (no capability gate) so
  // anonymous discovery on /talent can route through /login →
  // /matchmaker without requiring Buyer capability on the return
  // destination. The substantive buyer-flow state (which offering to
  // highlight, which brief/filter to pre-fill) rides in a localStorage
  // record keyed by the seller-profile-pending-edits seam pattern;
  // the URL marker `?from=talent` is a routing hint, not a contract
  // surface, and may be stripped by the bounded return resolver.
  "/matchmaker",
] as const;
export type PostCommandRouteV1 = (typeof postCommandRouteValuesV1)[number];

// ---------- Intent request ----------

// The intent request body.
//
// `intent` selects the capability set to ADD. The command is
// additive: `Hire` adds Buyer, `Offer` adds Seller, `Both` adds
// Buyer + Seller. Removing or narrowing a capability is not
// exposed by this command.
//
// `expectedCapabilities` is the capability set the human
// observed when they clicked Submit. The route compares the
// persisted set to this value inside the transaction's
// Workspace-scoped lock and rejects mismatches with the
// `INTENT_CONFLICT` envelope so the customer can recover with
// the fresh state. Idempotency only requires the chosen set to
// be fully covered by the persisted set; a stale
// `expectedCapabilities` does NOT produce a conflict when the
// chosen set is already present.
//
// `expectedCapabilities` is a SET, not an array: the closed
// domain contains only Buyer and Seller so the maximum unique
// size is two, and duplicate entries (`['Buyer', 'Buyer']`) must
// be rejected so the comparison against the persisted set never
// produces a false conflict.
//
// `returnTo` is optional; the route revalidates it via the
// existing internal-return validation rules. No `sellerAcceptance`
// field is carried: the M2 #83 slice does not collect a generic
// Seller participation/terms acceptance at capability-provisioning
// time.
export const intentRequestV1Schema = z
  .object({
    intent: z.enum(intentKindV1Values),
    expectedCapabilities: z
      .array(z.enum(marketplaceCapabilityValuesV1))
      .max(2, {
        message:
          "expectedCapabilities may contain at most the two closed-enum capabilities (Buyer, Seller).",
      })
      .refine(
        (arr) => new Set(arr).size === arr.length,
        "expectedCapabilities must contain unique entries (duplicate capabilities are not allowed).",
      ),
    returnTo: z.string().min(1).max(256).optional(),
  })
  .strict();
export type IntentRequestV1 = z.infer<typeof intentRequestV1Schema>;

// ---------- Intent response ----------

// The successful intent response. Carries the updated public user
// payload, the validated `returnTo` (or `null` when none was
// supplied / validation dropped it), and the server-resolved
// `safeReturnTo`. `safeReturnTo` represents CONTEXTUAL
// authorization against the fresh post-provision user — it is the
// destination the browser should consume (route + capability +
// Workspace all revalidated). The contract does NOT carry
// `setupState` — recovery is already surfaced via the user
// payload's existing `setupState` field; intent is capability-only.
export const intentResponseV1Schema = z
  .object({
    ok: z.literal(true),
    user: bg1PublicUserV1Schema,
    returnTo: z.string().min(1).max(256).nullable(),
    safeReturnTo: z.string().min(1).max(256).nullable(),
  })
  .strict();
export type IntentResponseV1 = z.infer<typeof intentResponseV1Schema>;

// ---------- Intent conflict response ----------
//
// Surface returned when the request's `expectedCapabilities`
// does not match the persisted capability set inside the
// locked transition. Carries the FRESH persisted capability set
// so the customer can re-submit with the up-to-date
// precondition. Distinct from the standard error envelope so
// the UI can render an actionable recovery rather than the
// false "not a current member" copy.
//
// The shape is only emitted by the intent route; the standard
// safe error envelope covers every other rejection surface.
export const intentConflictResponseV1Schema = z
  .object({
    error: z
      .object({
        code: z.literal("INTENT_CONFLICT"),
        message: z.string().min(1).max(500),
        // Server-emitted fresh persisted capability set. Mirrors
        // the request-side cap: at most the two closed-enum
        // values, unique only.
        freshCapabilities: z
          .array(z.enum(marketplaceCapabilityValuesV1))
          .max(2)
          .refine((arr) => new Set(arr).size === arr.length, "freshCapabilities must be unique"),
        requestId: z.string().min(1).max(128),
      })
      .strict(),
  })
  .strict();
export type IntentConflictResponseV1 = z.infer<typeof intentConflictResponseV1Schema>;

// ===========================================================================
// Matchmaker shared runtime contracts (introduced by ticket #60
// / BG3 of the Buildathon Golden Slice).
//
// These schemas cover the Matchmaker slice: natural-language
// ProjectBrief submission, validated search criteria, evidence-
// grounded recommendations, and the AI provider provenance trail.
// They follow the same patterns as the v1 search contract: shared
// Zod is the executable contract; TypeScript types are inferred
// from it; the same schema is consumed by the API route validator
// and the browser response parser. No Prisma model, AI raw output,
// provider subject, or storage key ever crosses a public DTO.
//
// Per ticket #60, the GS 13 / GS 14 / GS 15 requirements are:
//
//   GS 13 — the required golden brief proceeds directly to runtime-
//           validated search criteria without clarification.
//   GS 14 — required constraints are never silently relaxed.
//   GS 15 — displayed recommendations and explanations refer only to
//           returned sellers, ServiceOfferings, and factual match
//           evidence.
//
// The Matchmaker never queries Prisma directly; AI output is parsed
// through a strict schema before use and falls back to a
// deterministic interpretation that crosses the same validation and
// TalentSearchService boundaries.
//
// ===========================================================================

// ---------- AI provider provenance ----------

// Stable provider keys for the Matchmaker AI boundary. SoundHub
// owns these keys; provider SDKs never read them. Adding a new
// provider requires editing this enum and the adapter factory
// together.
export const aiProviderV1Values = ["managed", "deterministic-fallback"] as const;
export type AiProviderV1 = (typeof aiProviderV1Values)[number];

// ---------- Brief submission ----------

// The buyer's raw, natural-language ProjectBrief text. The route
// layer trims and collapses internal whitespace; the schema only
// enforces a usability floor (length bounds + at least one
// letter/digit) so an empty or purely punctuation-only submission
// is rejected at the trusted boundary rather than reaching the
// search service.
const projectBriefTextV1Schema = z
  .string()
  .min(8, "Brief text must be at least 8 non-whitespace characters")
  .max(2000, "Brief text must be at most 2000 characters")
  .transform((value) => value.trim().replace(/\s+/g, " "))
  .refine((value) => /[\p{L}\p{N}]/u.test(value), {
    message: "Brief text must contain at least one letter or digit after normalization",
  })
  .refine((value) => value.length >= 8, {
    message: "Brief text must be at least 8 non-whitespace characters after normalization",
  });

// Non-search project requirements are a free-form JSON object
// captured by the AI interpretation but never consumed by
// TalentSearchService. They carry things like buyer-acknowledged
// funding deadlines, scope hints, and any other context the brief
// produced without forcing the search contract to grow new fields.
// The schema keeps the value as an opaque record; the Matchmaker
// passes it through verbatim. The `.strict()` modifier rejects
// arrays/scalars at the trusted boundary so the persistence layer
// always reads a JSON object.
export const projectBriefNonSearchRequirementsV1Schema = z
  .object({})
  .catchall(z.string().min(1).max(500))
  .refine((value) => Object.keys(value).length <= 20, {
    message: "nonSearchRequirements must contain at most 20 entries",
  })
  .optional();
export type ProjectBriefNonSearchRequirementsV1 = z.infer<
  typeof projectBriefNonSearchRequirementsV1Schema
>;

// The brief-submission request is the trusted boundary between the
// browser and the Matchmaker service. It carries the acting
// Workspace identifier (so the route can revalidate membership),
// the original brief text, and an optional non-search requirements
// override.
//
// M2 (#87) Codex 4th review Finding 8: the matchmaker brief
// submission now accepts optional `required` and `preferred`
// criteria so the M1 strict required filters can be preserved
// across the /talent → /matchmaker recovery round-trip without
// the AI boundary re-interpreting them. When the buyer supplies
// `required`, the route applies it as-is — the AI never relaxes
// or rewrites a buyer-supplied hard constraint. The buyer-
// supplied criteria are not a free-form override; they round-
// trip through the shared search schema so the same persistence
// contract (`talentSearchRequiredCriteriaV1Schema` and
// `talentSearchPreferredCriteriaV1Schema`) governs what survives.
// The AI is still invoked for the natural-language brief text
// to derive any non-supplied axes (e.g. preferred axes from the
// query), but the supplied required axes win over the AI output.
export const submitBriefRequestV1Schema = z
  .object({
    actingWorkspaceId: z.string().min(1).max(128),
    briefText: projectBriefTextV1Schema,
    // M2 (#87) Finding 8: optional buyer-supplied strict required
    // criteria. When present, the route applies them verbatim —
    // the AI never relaxes a buyer-supplied hard axis. The fields
    // round-trip through the shared `talentSearch*CriteriaV1Schema`
    // so the schema (not the buyer) decides which axes survive.
    required: talentSearchRequiredCriteriaV1Schema.optional(),
    // M2 (#87) Finding 8: optional buyer-supplied preferred
    // criteria. When present, the route applies them as the
    // preferred axes alongside whatever the AI derives from the
    // brief text. The buyer is never forced to set them.
    preferred: talentSearchPreferredCriteriaV1Schema.optional(),
    // Optional buyer-supplied non-search requirements. When absent
    // the AI boundary (or fallback) derives them from the brief.
    nonSearchRequirements: projectBriefNonSearchRequirementsV1Schema,
  })
  .strict();
export type SubmitBriefRequestV1 = z.infer<typeof submitBriefRequestV1Schema>;

// ---------- Matchmaker criteria (AI output, validated) ----------

// The validated search criteria the Matchmaker produces from the
// buyer's brief. This is the single point where AI output (or the
// deterministic fallback) is normalized into the existing M1
// search contract; every field is one of the M1 schema's strict
// shapes so the validated value flows into TalentSearchService
// without further transformation. `required` may never be silently
// relaxed: the schema validates the persisted JSON on read so a
// stored Brief whose required criteria are empty fails closed
// instead of producing an unconstrained search.
function hasHardRequiredAxis(value: TalentSearchRequiredCriteriaV1): boolean {
  if (value.serviceModes && value.serviceModes.length > 0) return true;
  if (value.primaryCategoryKeys && value.primaryCategoryKeys.length > 0) return true;
  if (
    value.independentlyPurchasableServiceKeys &&
    value.independentlyPurchasableServiceKeys.length > 0
  ) {
    return true;
  }
  if (value.basedIn !== undefined) return true;
  if (value.serviceArea !== undefined) return true;
  return false;
}

export const matchmakerCriteriaV1Schema = z
  .object({
    query: normalizedQuerySchema.optional(),
    required: talentSearchRequiredCriteriaV1Schema,
    preferred: talentSearchPreferredCriteriaV1Schema.optional(),
    // Optional non-search requirements derived from the brief.
    nonSearchRequirements: projectBriefNonSearchRequirementsV1Schema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasQuery = typeof value.query === "string" && value.query.length >= 2;
    const requiredHasValue = isUsable(value.required);
    const preferredHasValue = value.preferred ? isUsable(value.preferred) : false;
    // A criteria payload must yield a usable search call so a
    // malformed AI output cannot reach TalentSearchService with
    // nothing to do.
    if (!hasQuery && !requiredHasValue && !preferredHasValue) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Matchmaker criteria must yield at least one of query, required, or preferred",
      });
    }
    // GS 14: when the buyer DID express a hard constraint, that
    // constraint must survive the AI boundary. We detect "hard
    // constraint was expressed" by checking that either the
    // required block has a hard axis OR the buyer-only non-search
    // requirements carry a signal that implies a hard axis. In
    // practice the deterministic fallback always maps the brief
    // to a hard axis when the buyer's text contains a recognised
    // phrase; this check only enforces that the AI boundary did
    // not silently drop it.
    //
    // We do NOT force a hard axis when the buyer only supplied a
    // query — the buyer is entitled to describe the work without
    // naming a category.
    if (requiredHasValue && !hasHardRequiredAxis(value.required)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Matchmaker criteria.required must contain at least one hard constraint axis",
      });
    }
  });
export type MatchmakerCriteriaV1 = z.infer<typeof matchmakerCriteriaV1Schema>;

// ---------- Explanation payload (evidence-grounded, never AI-invented) ----------

// A single explanation line refers to one factual match-evidence
// axis from the eligibility-determined search result. AI cannot
// invent qualifications, availability, verification, prices, or
// sample rights; every line cites the evidence that already exists
// in the search result. The label is human-friendly wording
// restricted to a small allow-list so the UI cannot render
// arbitrary agent output.
export const explanationKindV1Values = [
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
] as const;
export type ExplanationKindV1 = (typeof explanationKindV1Values)[number];

export const explanationEntryV1Schema = z
  .object({
    kind: z.enum(explanationKindV1Values),
    // The factual label derived from the validated search
    // result's matched fields (e.g. "matched offering title",
    // "preferred genre: Dancehall"). The schema restricts the
    // string to a sane length; the AI boundary never constructs
    // these values.
    label: z.string().min(1).max(200),
  })
  .strict();
export type ExplanationEntryV1 = z.infer<typeof explanationEntryV1Schema>;

// ---------- Brief public DTO ----------

// Allow-listed public DTO returned by GET /api/matchmaker/brief/:id.
// The persisted required/preferred criteria are re-validated against
// the M1 schema on every read so a tampered or corrupted row cannot
// leak malformed data into the UI. Provenance (`aiProvider`,
// `aiModelId`, `aiFallbackUsed`) is exposed so the UI can disclose
// which path produced the criteria.
export const projectBriefPublicV1Schema = z
  .object({
    briefId: z.string().min(1).max(128),
    actingWorkspaceId: z.string().min(1).max(128),
    createdByUserId: z.string().min(1).max(128),
    briefText: z.string().min(8).max(2000),
    criteria: matchmakerCriteriaV1Schema,
    aiProvider: z.enum(aiProviderV1Values),
    aiModelId: z.string().min(1).max(120).nullable(),
    aiFallbackUsed: z.boolean(),
    createdAt: z.string().datetime(),
    // Allow-listed BuyerWorkspaceView (id + slug + name). The
    // Workspace's capabilities and status are intentionally NOT
    // exposed here — the caller already authorised through them.
    buyerWorkspace: z
      .object({
        workspaceId: z.string().min(1).max(128),
        slug: z.string().min(1).max(120),
        name: z.string().min(1).max(200),
      })
      .strict(),
  })
  .strict();
export type ProjectBriefPublicV1 = z.infer<typeof projectBriefPublicV1Schema>;

// ---------- Recommendation DTO (search results grounded to the brief) ----------

// Allow-listed recommendation entry. Re-uses the public seller /
// public offering schemas already shipped with the v1 search
// contract so a Matchmaker response is structurally identical to a
// direct search response; the only difference is the addition of
// `explanations`, which is derived from the returned result (never
// the AI provider).
export const matchmakerRecommendationV1Schema = z
  .object({
    sellerId: z.string().min(1),
    professionalName: z.string().min(1).max(200),
    bestMatchingOfferingId: z.string().min(1),
    relevanceScore: z
      .number()
      .min(0, "relevanceScore must be at least 0")
      .max(1, "relevanceScore must be at most 1")
      .finite(),
    // Buyer-facing factual evidence the AI boundary assembled from
    // the returned result's matched fields + preference atom
    // coverage + query token coverage. Each entry maps to a
    // structured allow-listed kind; AI-generated text never crosses
    // this boundary.
    explanations: z.array(explanationEntryV1Schema).max(20),
    matchReason: z.string().min(1).max(500),
    preferenceCoverage: preferenceCoverageV1Schema.optional(),
    textCoverage: textCoverageV1Schema.optional(),
    // Best-matching offering snapshot. The full v1 public offering
    // summary is inlined so the UI can render without a follow-up
    // call; the `seller` snapshot follows the same v1 public shape.
    bestMatchingOffering: publicOfferingSummaryV1Schema,
    seller: publicSellerSummaryV1Schema,
    additionalMatchingOfferings: z.array(publicOfferingSummaryV1Schema).max(2),
  })
  .strict();
export type MatchmakerRecommendationV1 = z.infer<typeof matchmakerRecommendationV1Schema>;

// ---------- Matchmaker response ----------

// The submit-brief response returns the persisted brief AND the
// recommendations produced by the eligibility-determined search in
// a single round trip, so the buyer can render the results without
// a follow-up fetch (per the brief+results UI). `totalResults`
// mirrors the M1 search metadata field so the UI can render a
// stable count without depending on the v1 metadata envelope shape.
export const submitBriefResponseV1Schema = z
  .object({
    ok: z.literal(true),
    brief: projectBriefPublicV1Schema,
    recommendations: z.array(matchmakerRecommendationV1Schema).max(10),
    totalResults: z.number().int().nonnegative(),
    strategy: talentSearchStrategyV1Schema,
    // Surfaced when the AI provider failed and the deterministic
    // fallback crossed the same boundary. The UI uses this to
    // disclose the fallback; the field is absent on the managed
    // path so a misconfigured UI cannot mis-attribute provenance.
    fallbackNotice: z.string().min(1).max(500).optional(),
  })
  .strict();
export type SubmitBriefResponseV1 = z.infer<typeof submitBriefResponseV1Schema>;

// ---------- Brief fetch response (no recommendations) ----------

export const briefResponseV1Schema = z
  .object({
    brief: projectBriefPublicV1Schema,
  })
  .strict();
export type BriefResponseV1 = z.infer<typeof briefResponseV1Schema>;

// ---------- AI adapter contract ----------

// Provider-neutral input handed to the AI adapter. Includes the
// acting Workspace identifier so the AI boundary cannot be confused
// about whose brief it is interpreting; the AI never receives raw
// Prisma models, provider subjects, session tokens, or storage
// keys.
export const aiInterpretBriefInputV1Schema = z
  .object({
    actingWorkspaceId: z.string().min(1).max(128),
    briefText: z.string().min(8).max(2000),
    buyerNonSearchRequirements: projectBriefNonSearchRequirementsV1Schema,
  })
  .strict();
export type AiInterpretBriefInputV1 = z.infer<typeof aiInterpretBriefInputV1Schema>;

// Provider-neutral output the AI adapter returns. The structure is
// the candidate criteria payload (NOT yet validated) plus
// provenance metadata the application persists alongside the brief.
// The application is the only layer that validates the payload
// against `matchmakerCriteriaV1Schema`; AI output NEVER crosses
// the validation boundary untyped.
export const aiInterpretBriefOutputV1Schema = z
  .object({
    provider: z.enum(aiProviderV1Values),
    modelId: z.string().min(1).max(120).nullable(),
    // The unvalidated candidate payload. The application parses it
    // through `matchmakerCriteriaV1Schema` and rejects any
    // adapter that returns malformed JSON. The schema here is a
    // permissive record because the goal is to catch anything
    // obviously wrong (top-level type) without re-implementing the
    // validation that already lives on the M1 side.
    candidate: z.record(z.string(), z.unknown()),
  })
  .strict();
export type AiInterpretBriefOutputV1 = z.infer<typeof aiInterpretBriefOutputV1Schema>;

// ===========================================================================
// Buildathon Golden Slice 2 (BG2) shared runtime contracts.
//
// These schemas cover the bounded MP3 discovery samples a seller may
// attach to a ServiceOffering. The contracts follow the same patterns
// as the v1 search and BG1 contracts: shared Zod is the executable
// contract; TypeScript types are inferred from it; the same schema is
// consumed by the Express route validator, the seller management UI,
// the buyer-facing discovery renderer, and the deterministic browser
// journey. No Prisma model, storage reference, bucket name, or
// provider credential ever crosses a public DTO.
//
// Per ticket #61 the BG2 slice satisfies the Golden Slice GS 7–GS 12
// acceptance criteria:
//
//   GS 7  — an authorized seller Workspace can upload an MP3 sample
//           to its own ServiceOffering and list, play, and remove it.
//   GS 8  — an unrelated Workspace, non-member, or insufficiently
//           authorized member cannot upload or remove samples.
//   GS 9  — a successful upload persists buyer-safe metadata and an
//           opaque storage reference in PostgreSQL only after the
//           storage operation succeeds.
//   GS 10 — an Active ServiceOffering exposes zero to three playable
//           MP3 discovery samples; removal stops a sample from
//           appearing in buyer-facing discovery.
//   GS 11 — a fourth sample, a non-MP3 object, or an object larger
//           than 25 MB is rejected at a trusted boundary; duration
//           is not an acceptance condition.
//   GS 12 — Supabase Storage is exercised by a bounded deployed-
//           provider smoke; deterministic storage fixtures satisfy
//           the same application-facing contract in tests.
//
// ===========================================================================

// ---------- Audio sample DTOs ----------

// The only audio sample shape that ever crosses the public HTTP
// boundary. The buyer-facing `<audio>` tag renders `playbackUrl`
// directly; the application server uses the persisted storage ref
// for upload/remove operations but never serializes it. Storage
// credentials, bucket names, object keys, and provider subjects
// never enter this schema. `playbackUrl` resolves to either a
// narrowly scoped Supabase signed URL or the in-app buyer-safe
// playback route, depending on which adapter the server wires.
// Both adapters produce a URL that resolves to actual playable
// audio without further resolution on the client.
// M2 (#85) PR-review feedback: the public DTO now carries the
// persisted media-use confirmation (version + timestamp). The
// constant declaration for the closed version set lives above so
// the forward reference resolves at type-check time.

export const bg2AudioSamplePublicV1Schema = z
  .object({
    sampleId: z.string().min(1).max(128),
    offeringId: z.string().min(1).max(128),
    label: z.string().min(1).max(120),
    contentType: z.literal("audio/mpeg"),
    byteSize: z
      .number()
      .int()
      .nonnegative()
      .max(25 * 1024 * 1024),
    displayOrder: z.number().int().min(1).max(3),
    // Fully-formed URL the browser attaches to the `<audio>` `src`
    // attribute without inspecting the internals. For Supabase
    // Storage this is a narrowly scoped signed URL; for the
    // deterministic adapter this is the in-app
    // `/api/services/:offeringId/audio-samples/:sampleId/play`
    // route. Eligibility and removal checks are applied before the
    // URL is emitted, so an ineligible or removed sample never
    // appears with a playable handle.
    playbackUrl: z.string().url(),
    // M2 (#85) PR-review feedback (round 2): durable media-use
    // confirmation. OPTIONAL on the public DTO so legacy Live
    // samples (persisted before the confirmation columns existed)
    // can still be listed and played by buyers — the activation
    // gate filters confirmation != null, so legacy samples do
    // NOT satisfy activation eligibility until a seller
    // re-uploads them with the current version. The buyer-side
    // playback gate and the seller-side preview gate do not
    // require confirmation; they only require Live status +
    // workspace ownership + lifecycle state.
    confirmation: z
      .object({
        version: z.enum(SERVICE_OFFERING_AUDIO_MEDIA_CONFIRMATION_VERSIONS),
        confirmedAt: z.string().datetime(),
      })
      .strict()
      .optional(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type Bg2AudioSamplePublicV1 = z.infer<typeof bg2AudioSamplePublicV1Schema>;

// ---------- Seller list response (one offering's bounded samples) ----------

export const bg2AudioSampleListResponseV1Schema = z
  .object({
    offeringId: z.string().min(1).max(128),
    samples: z.array(bg2AudioSamplePublicV1Schema).max(3),
  })
  .strict();
export type Bg2AudioSampleListResponseV1 = z.infer<typeof bg2AudioSampleListResponseV1Schema>;

// ---------- Upload response ----------

// The upload command returns the persisted buyer-safe sample. The
// request body itself is multipart/form-data (Content-Disposition:
// form-data), so the JSON schema is only for the RESPONSE side; the
// request boundary enforces the file content type and size at the
// trusted multipart parser.
export const bg2AudioSampleUploadResponseV1Schema = z
  .object({
    ok: z.literal(true),
    sample: bg2AudioSamplePublicV1Schema,
  })
  .strict();
export type Bg2AudioSampleUploadResponseV1 = z.infer<typeof bg2AudioSampleUploadResponseV1Schema>;

// ---------- Remove response ----------

export const bg2AudioSampleRemoveResponseV1Schema = z
  .object({
    ok: z.literal(true),
    sampleId: z.string().min(1).max(128),
    offeringId: z.string().min(1).max(128),
    removedAt: z.string().datetime(),
  })
  .strict();
export type Bg2AudioSampleRemoveResponseV1 = z.infer<typeof bg2AudioSampleRemoveResponseV1Schema>;

// ---------- Remove request ----------
//
// M2 (#86): removing the final qualifying sample from an Active
// offering atomically transitions the offering to Paused and removes
// the sample from application-visible state before provider cleanup.
// To prevent an accidental marketplace-eligibility loss, the
// application boundary requires an explicit `confirmEligibilityLoss:
// true` flag on the request when the removal would be the last
// qualifying Active sample. A removal without the flag against that
// condition returns AUDIO_SAMPLE_FINAL_REMOVAL_CONFIRMATION_REQUIRED.
// The flag is transient and is never persisted on the sample row.
export const bg2AudioSampleRemoveRequestV1Schema = z
  .object({
    actingWorkspaceId: z.string().min(1).max(128),
    confirmEligibilityLoss: z.boolean().optional(),
  })
  .strict();
export type Bg2AudioSampleRemoveRequestV1 = z.infer<typeof bg2AudioSampleRemoveRequestV1Schema>;

// ---------- Stable limits exposed for runtime validation ----------
//
// The application uses these constants to enforce the GS 11 / GS 12
// limits at the trusted boundary. A future contract drift detector
// can compare them against the values the application service
// enforces.
export const BG2_AUDIO_SAMPLE_MAX_PER_OFFERING = 3;
export const BG2_AUDIO_SAMPLE_MAX_BYTE_SIZE = 25 * 1024 * 1024;
export const BG2_AUDIO_SAMPLE_CONTENT_TYPE = "audio/mpeg" as const;
export const BG2_AUDIO_SAMPLE_MAX_LABEL_LENGTH = 120;
export const BG2_AUDIO_SAMPLE_MAX_DISPLAY_ORDER = 3;

// ===========================================================================
// BG2 error code additions to the shared safe envelope.
//
// Existing codes remain unchanged. The new BG2 codes cover the
// rejection surfaces unique to the seller-audio slice and round-trip
// through `mapStatus` in `apps/api/src/lib/errors.ts`. The codes
// never expose provider subjects, raw tokens, session ids, storage
// credentials, bucket names, or membership internals.
// ===========================================================================

// The new codes are appended to the existing enum so a contract-drift
// detector can compare this list against the runtime error builder.
// The drift test (`apps/api/src/lib/enum-drift.test.ts`) is the only
// place that consults this list outside the route layer.

// ===========================================================================
// Buildathon Golden Slice 4 (BG4) shared runtime contracts.
//
// These schemas cover the ProjectRequest + seller-consent slice:
// persistence, decision, view, and list endpoints. The same patterns
// as the BG3 contracts are reused: shared Zod is the executable
// contract; TypeScript types are inferred from it; the same schema is
// consumed by the API route validator and the browser response parser.
// No Prisma model, raw provider subject, or storage key ever crosses
// a public DTO.
//
// Per ticket #62, GS 16–18 require:
//   GS 16 — ProjectRequest creation revalidates current eligibility
//           and persists a Pending request owned by the buyer
//           Workspace; it does not create a Deal.
//   GS 17 — Only an authorized seller Workspace member can accept or
//           decline the request.
//   GS 18 — Decline creates no Deal; acceptance records seller
//           consent and creates exactly one Negotiating Deal.
// And GS 26 requires that retries cannot create duplicate
// ProjectRequests or multiple Deals for one accepted ProjectRequest.
// ===========================================================================

// ---------- ProjectRequest public DTO ----------

// Allow-listed ProjectRequest shape. The counterparty-visible surface
// does NOT include private human-actor identifiers (`createdByUserId`,
// `sellerDecisionByUserId`): those are persisted as audit evidence
// only and are never serialized into responses (CLAUDE.md: "Do not
// expose account identity... publicly"). `sellerConsentAt` is the
// canonical "explicit seller consent" evidence referenced by GS 18
// / future activation invariants. It is null for Pending and
// Declined requests and the timestamp of the accept call for
// Accepted ones.
//
// BG4 seller-inbox UI (ticket #62 acceptance QA, P3-002) requires
// that a row carries human-readable context — the buyer Workspace
// name, the ServiceOffering title, and a brief excerpt — so the
// seller can distinguish multiple Pending requests without seeing
// raw internal ids as primary user-facing content. The ids remain on
// the response for client-side keys, audit correlation, and tests,
// but the UI MUST render the human-readable context as the primary
// label. The fields are bounded and pulled from the same referenced
// rows that authorize the request; they do not expose account,
// membership, embedding, or storage internals.
export const projectRequestPublicV1Schema = z
  .object({
    projectRequestId: z.string().min(1).max(128),
    buyerWorkspaceId: z.string().min(1).max(128),
    sellerWorkspaceId: z.string().min(1).max(128),
    serviceOfferingId: z.string().min(1).max(128),
    projectBriefId: z.string().min(1).max(128),
    status: z.enum(projectRequestStatusValuesV1),
    sellerDecisionAt: z.string().datetime().nullable(),
    sellerConsentAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    // Display-only context for the seller inbox (and the symmetric
    // buyer audit view). Pulled from the referenced Workspace /
    // ServiceOffering / ProjectBrief rows at read time. Null when
    // the referenced row could not be loaded; the UI must render
    // a stable placeholder rather than fabricating a label.
    buyerWorkspaceName: z.string().min(1).max(200).nullable(),
    sellerWorkspaceName: z.string().min(1).max(200).nullable(),
    serviceOfferingTitle: z.string().min(1).max(200).nullable(),
    briefExcerpt: z.string().max(280).nullable(),
  })
  .strict();
export type ProjectRequestPublicV1 = z.infer<typeof projectRequestPublicV1Schema>;

// ---------- Deal public DTO ----------

// Allow-listed Deal shape. BG4 only ever emits Negotiating Deals; the
// `activatedAt` field is always null in this slice. Future
// activation-invariant code (a later ticket) will set it.
export const dealPublicV1Schema = z
  .object({
    dealId: z.string().min(1).max(128),
    buyerWorkspaceId: z.string().min(1).max(128),
    sellerWorkspaceId: z.string().min(1).max(128),
    serviceOfferingId: z.string().min(1).max(128),
    projectBriefId: z.string().min(1).max(128),
    projectRequestId: z.string().min(1).max(128),
    status: z.enum(dealStatusValuesV1),
    activatedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type DealPublicV1 = z.infer<typeof dealPublicV1Schema>;

// ---------- Deals discovery list DTO (ticket #74) ----------
//
// Background: ticket #74 makes Deals discoverable from signed-in
// navigation. The list is a DISCOVERY surface, not a second Deal
// detail surface: it carries only what a human needs to recognise a
// Deal and choose a row. Full terms, approval audit records, and the
// BG6 funding confirmation stay on `/deals/:dealId`.
//
// Deliberately EXCLUDED from the list item (AGENTS.md: "Do not expose
// account identity, membership, wallet, embedding, or storage
// internals publicly"):
//   - buyerWorkspaceId / sellerWorkspaceId  (membership topology;
//     `actingSide` + the counterparty NAME carry the context)
//   - projectBriefId / projectRequestId / serviceOfferingId
//   - paymentIntentId, correlationId, providerReference
//   - provider / asset / network / environment labels
//   - confirmation timestamps and failure diagnostics
//
// Approval state is DERIVED server-side. There is no persisted
// approval-status column: BG5 represents approval as DealApproval row
// existence per (termsVersionId, workspaceId), so the server derives
// this closed enum from the current TermsVersion's approval rows. The
// client must not reconstruct it.
export const dealApprovalStateValuesV1 = [
  // No TermsVersion has been drafted yet.
  "NoTerms",
  // A current TermsVersion exists; neither party has approved it.
  "AwaitingBothApprovals",
  // The seller approved the current version; the buyer has not.
  "AwaitingBuyerApproval",
  // The buyer approved the current version; the seller has not.
  "AwaitingSellerApproval",
  // Both parties approved the SAME current version.
  "BothApproved",
] as const;
export type DealApprovalStateV1 = (typeof dealApprovalStateValuesV1)[number];

// Slim, derived funding summary for the list. This is NOT the BG6
// `bg6FundingConfirmationPublicV1Schema` and must not be widened into
// it — the list exposes discovery-sufficient state only.
//
// Semantics (derived server-side from persisted Deal / BG5 / BG6
// state, never reconstructed by the client):
//   null                   funding is not yet applicable (no current
//                          terms, or approvals are incomplete)
//   AwaitingConfirmation   both parties approved the current version;
//                          the Deal is ready for / awaiting funding
//   Confirmed              funding confirmed (aligns with an Active
//                          Deal in the Golden Slice)
//   Failed                 the current applicable funding attempt
//                          failed; the Deal remains Negotiating
export const dealListFundingStatusesV1 = ["AwaitingConfirmation", "Confirmed", "Failed"] as const;
export type DealListFundingStatusV1 = (typeof dealListFundingStatusesV1)[number];

// Which side of the Deal the acting Workspace is on. Lets the UI say
// "with {counterparty}" without exposing either workspace id.
export const dealActingSideValuesV1 = ["Buyer", "Seller"] as const;
export type DealActingSideV1 = (typeof dealActingSideValuesV1)[number];

// One discoverable Deal row, scoped to the acting Workspace.
//
// `counterpartyWorkspaceName` and `serviceOfferingTitle` are the
// human-readable primary context required by ticket #74 ("Deal rows
// use human-readable labels rather than raw internal IDs as their
// primary context"). They are nullable for the same reason
// `projectRequestPublicV1Schema` makes its display context nullable:
// a referenced row that could not be loaded must render a stable
// placeholder rather than a fabricated label.
export const dealListItemPublicV1Schema = z
  .object({
    dealId: z.string().min(1).max(128),
    status: z.enum(dealStatusValuesV1),
    actingSide: z.enum(dealActingSideValuesV1),
    counterpartyWorkspaceName: z.string().min(1).max(200).nullable(),
    serviceOfferingTitle: z.string().min(1).max(200).nullable(),
    // The current TermsVersion's monotonic version number; null when
    // no terms have been drafted.
    currentTermsVersion: z.number().int().positive().nullable(),
    approvalState: z.enum(dealApprovalStateValuesV1),
    fundingStatus: z.enum(dealListFundingStatusesV1).nullable(),
    activatedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type DealListItemPublicV1 = z.infer<typeof dealListItemPublicV1Schema>;

// List request. The acting Workspace is explicit (GS 4 / GS 5
// authority contract) and arrives as a query parameter; the server
// revalidates current membership for the EXACT commanded Workspace
// inside the same transaction that reads the Deals.
export const listDealsRequestV1Schema = z
  .object({
    actingWorkspaceId: z.string().min(1).max(128),
  })
  .strict();
export type ListDealsRequestV1 = z.infer<typeof listDealsRequestV1Schema>;

// List response. Bounded by design: ticket #74 excludes pagination
// frameworks, and the cap keeps the discovery surface from becoming
// an unbounded export.
export const listDealsResponseV1Schema = z
  .object({
    ok: z.literal(true),
    deals: z.array(dealListItemPublicV1Schema).max(200),
  })
  .strict();
export type ListDealsResponseV1 = z.infer<typeof listDealsResponseV1Schema>;

// ---------- ProjectRequest endpoints ----------

// Create-ProjectRequest request body. The buyer-side acting
// Workspace id (GS 4 / GS 5 / GS 6 authority contract), the persisted
// ProjectBrief id (required by ticket #62 GS 16 — selection is
// grounded in a previously-persisted brief), and the selected
// ServiceOffering id (one of the eligibility-determined offerings).
export const createProjectRequestRequestV1Schema = z
  .object({
    actingWorkspaceId: z.string().min(1).max(128),
    projectBriefId: z.string().min(1).max(128),
    serviceOfferingId: z.string().min(1).max(128),
  })
  .strict();
export type CreateProjectRequestRequestV1 = z.infer<typeof createProjectRequestRequestV1Schema>;

export const createProjectRequestResponseV1Schema = z
  .object({
    ok: z.literal(true),
    projectRequest: projectRequestPublicV1Schema,
  })
  .strict();
export type CreateProjectRequestResponseV1 = z.infer<typeof createProjectRequestResponseV1Schema>;

// View one ProjectRequest. Authorization is revalidated on every
// read (GS 4); a non-member of either side receives
// PROJECT_REQUEST_FORBIDDEN (403) and an unknown id receives
// PROJECT_REQUEST_NOT_FOUND (404).
export const getProjectRequestResponseV1Schema = z
  .object({
    projectRequest: projectRequestPublicV1Schema,
  })
  .strict();
export type GetProjectRequestResponseV1 = z.infer<typeof getProjectRequestResponseV1Schema>;

// List ProjectRequests for an acting Workspace. Used by the seller
// inbox (statusFilter=Pending) and the audit view (no filter). The
// route revalidates current membership on every call.
export const listProjectRequestsRequestV1Schema = z
  .object({
    actingWorkspaceId: z.string().min(1).max(128),
    statusFilter: z.enum(projectRequestStatusValuesV1).optional(),
  })
  .strict();
export type ListProjectRequestsRequestV1 = z.infer<typeof listProjectRequestsRequestV1Schema>;

export const listProjectRequestsResponseV1Schema = z
  .object({
    projectRequests: z.array(projectRequestPublicV1Schema).max(200),
  })
  .strict();
export type ListProjectRequestsResponseV1 = z.infer<typeof listProjectRequestsResponseV1Schema>;

// ---------- Seller decision endpoints ----------

// Accept / Decline carry the same payload: the acting Workspace id
// is required so the route can revalidate membership and the
// seller-side authorization before touching the request row.
export const respondProjectRequestRequestV1Schema = z
  .object({
    actingWorkspaceId: z.string().min(1).max(128),
  })
  .strict();
export type RespondProjectRequestRequestV1 = z.infer<typeof respondProjectRequestRequestV1Schema>;

export const declineProjectRequestResponseV1Schema = z
  .object({
    ok: z.literal(true),
    projectRequest: projectRequestPublicV1Schema,
  })
  .strict();
export type DeclineProjectRequestResponseV1 = z.infer<typeof declineProjectRequestResponseV1Schema>;

// ===========================================================================
// Buildathon Golden Slice 5 (BG5) shared runtime contracts.
//
// These schemas cover the TermsVersion, DealApproval, and DealApprover
// surfaces introduced by ticket #63. The same patterns as BG1–BG4 are
// reused: shared Zod is the executable contract; TypeScript types are
// inferred from it; the same schema is consumed by the API route
// validator and the browser response parser.
//
// Per ticket #63 the BG5 slice satisfies the Golden Slice GS 19, GS 20,
// GS 21, GS 26 (terms / approval surface) and the DealApprover portion
// of GS 6. The slice is buildathon-scoped: no managed AI integration,
// no generalized idempotency framework, and no visible terms-edit UI
// (per ticket #63: "Do not implement clock-driven expiration or
// require a visible terms-edit/versioning UI").
//
// Public DTOs are strict allow-lists. Private audit-only identifiers
// (`draftedByUserId`, `approvedByUserId`, `dealApproverId`) are
// persisted in PostgreSQL for later milestones but NEVER cross a
// public DTO. The Application derives approval completeness from
// durable DealApproval rows; AI output, UI state, provider metadata,
// and one party's approval cannot synthesize the other party's
// approval.
// ===========================================================================

// ---------- Money (USD; BG5 is USD-only per the Golden Slice) ----------

const bg5UsdMoneyV1Schema = z.object({
  amountMinor: z.number().int().nonnegative(),
  currency: z.literal("USD"),
});
export type Bg5UsdMoneyV1 = z.infer<typeof bg5UsdMoneyV1Schema>;

// ---------- Deliverable requirement ----------

// One structured deliverable requirement inside a TermsVersion. The
// shape is small enough to remain stable across the buildathon; future
// milestones can extend it (sub-deliverables, attached assets, …)
// without breaking the public contract.
export const bg5DeliverableRequirementV1Schema = z
  .object({
    title: z.string().min(1).max(200),
    description: z.string().min(1).max(2000),
  })
  .strict();
export type Bg5DeliverableRequirementV1 = z.infer<typeof bg5DeliverableRequirementV1Schema>;

// ---------- Schedule ----------

export const bg5ScheduleV1Schema = z
  .object({
    // ISO date strings (YYYY-MM-DD). The contract accepts any ISO
    // date; the application does not enforce timezone alignment with
    // the buyer's locale.
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "startDate must be YYYY-MM-DD"),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "endDate must be YYYY-MM-DD"),
    // Bounded: 1..365 days. Larger engagements are not part of the
    // Golden Slice and would need a separate negotiation flow.
    deliveryDays: z.number().int().min(1).max(365),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.startDate > value.endDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "startDate must not be after endDate",
      });
    }
  });
export type Bg5ScheduleV1 = z.infer<typeof bg5ScheduleV1Schema>;

// ---------- Proposed terms (AI boundary output, strict) ----------
//
// The shape produced by `DealTermsAiAdapter.draftProposedTerms` and
// validated at the application boundary before any TermsVersion row
// is persisted. AI output never crosses the boundary untyped; this
// schema is the single source of truth for the candidate proposal.
// The deterministic fallback re-derives a value that parses through
// the same schema so a managed-adapter failure cannot bypass the
// validation invariant.

export const bg5RevisionAllowanceV1Schema = z.number().int().min(0).max(10);
export type Bg5RevisionAllowanceV1 = z.infer<typeof bg5RevisionAllowanceV1Schema>;

export const bg5ProposedTermsV1Schema = z
  .object({
    scope: z.string().min(1).max(2000),
    deliverables: z.array(bg5DeliverableRequirementV1Schema).min(1).max(20),
    schedule: bg5ScheduleV1Schema,
    // USD-only for BG5 per the Golden Slice spec.
    price: bg5UsdMoneyV1Schema,
    revisionAllowance: bg5RevisionAllowanceV1Schema,
    rightsSummary: z.string().min(1).max(2000),
    // Optional, display-only. The application never reads this as a
    // state-transition source.
    fundingDeadlineAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type Bg5ProposedTermsV1 = z.infer<typeof bg5ProposedTermsV1Schema>;

// ---------- AI boundary input / output ----------

export const bg5AiProviderV1Values = ["managed", "deterministic-fallback"] as const;
export type Bg5AiProviderV1 = (typeof bg5AiProviderV1Values)[number];

// Provider-neutral input handed to the DealTermsAiAdapter. The
// adapter receives the persisted Deal + ProjectBrief context it needs
// to draft a proposal; it never receives raw Prisma models, provider
// subjects, session tokens, or storage keys.
export const dealTermsAiDraftInputV1Schema = z
  .object({
    dealId: z.string().min(1).max(128),
    buyerWorkspaceId: z.string().min(1).max(128),
    sellerWorkspaceId: z.string().min(1).max(128),
    serviceOfferingId: z.string().min(1).max(128),
    projectBriefId: z.string().min(1).max(128),
  })
  .strict();
export type DealTermsAiDraftInputV1 = z.infer<typeof dealTermsAiDraftInputV1Schema>;

// Provider-neutral output. The structure is the candidate proposal
// (NOT yet validated) plus provenance metadata the application
// persists alongside the TermsVersion. The application is the only
// layer that validates the proposal against `bg5ProposedTermsV1Schema`;
// AI output NEVER crosses the validation boundary untyped.
export const dealTermsAiDraftOutputV1Schema = z
  .object({
    provider: z.enum(bg5AiProviderV1Values),
    modelId: z.string().min(1).max(120).nullable(),
    candidate: z.record(z.string(), z.unknown()),
  })
  .strict();
export type DealTermsAiDraftOutputV1 = z.infer<typeof dealTermsAiDraftOutputV1Schema>;

// ---------- Public DTOs (strict allow-list) ----------
//
// Per the Golden Slice privacy boundary:
//   - `draftedByUserId` is private audit attribution. NEVER public.
//   - `approvedByUserId` is private audit attribution. NEVER public.
//   - `dealApproverId` is the private authorization row id. NEVER public.
//   - Buyer + seller approval rows are both public so each side can see
//     the OTHER side's approval, but the public row carries no human
//     actor identifier (the Workspace identity is the authorization
//     carrier for counterparty display).
//
// `aiDraftedUnapprovedBadge` is a literal `true` field on every public
// TermsVersion DTO. The UI is required to render the "AI-drafted ·
// unapproved" badge whenever this field is present; making the field a
// schema-mandated literal guarantees the UI cannot silently drop it.

export const bg5TermsVersionPublicV1Schema = z
  .object({
    termsVersionId: z.string().min(1).max(128),
    dealId: z.string().min(1).max(128),
    version: z.number().int().min(1),
    scope: z.string().min(1).max(2000),
    deliverables: z.array(bg5DeliverableRequirementV1Schema).min(1).max(20),
    schedule: bg5ScheduleV1Schema,
    price: bg5UsdMoneyV1Schema,
    revisionAllowance: bg5RevisionAllowanceV1Schema,
    rightsSummary: z.string().min(1).max(2000),
    fundingDeadlineAt: z.string().datetime({ offset: true }).nullable(),
    aiProvider: z.enum(bg5AiProviderV1Values),
    aiModelId: z.string().min(1).max(120).nullable(),
    aiFallbackUsed: z.boolean(),
    // Schema-mandated literal so the UI cannot silently drop the badge.
    aiDraftedUnapprovedBadge: z.literal(true),
    draftedAt: z.string().datetime(),
    createdAt: z.string().datetime(),
    // `isCurrentVersion` is derived (MAX(version) per Deal) at the
    // read boundary. It is NOT persisted on the TermsVersion row;
    // including it here lets the UI render the "current" indicator
    // without a second round trip.
    isCurrentVersion: z.boolean(),
  })
  .strict();
export type Bg5TermsVersionPublicV1 = z.infer<typeof bg5TermsVersionPublicV1Schema>;

export const bg5DealApprovalPublicV1Schema = z
  .object({
    dealApprovalId: z.string().min(1).max(128),
    termsVersionId: z.string().min(1).max(128),
    workspaceId: z.string().min(1).max(128),
    approvedAt: z.string().datetime(),
  })
  .strict();
export type Bg5DealApprovalPublicV1 = z.infer<typeof bg5DealApprovalPublicV1Schema>;

// Allow-listed seller-consent projection surfaced on the BG5 Deal
// view (ticket AC27). The authoritative source remains the persisted
// ProjectRequest already loaded by DealTermsService.getDeal(); this
// schema is the smallest public surface the Active Deal view needs
// to render an explicit seller-consent indicator.
//
// Domain invariant: every persisted Deal must have originated from a
// seller-accepted ProjectRequest, so for any Deal whose invariant
// holds the projection is non-null with `status: "Accepted"`. When
// the invariant does not hold (ProjectRequest row missing, status
// not "Accepted") the route MUST emit `sellerConsent: null` rather
// than presenting false consent — the page renders no "Accepted"
// indicator in that case.
//
// This is a projection, NOT a re-derivation hint: the UI MUST NOT
// infer consent from the Deal's existence, status, approvals, or
// any other DTO field. Only this field drives the indicator.
export const bg5SellerConsentProjectionV1Schema = z
  .object({
    status: z.literal("Accepted"),
    sellerConsentAt: z.string().datetime().nullable(),
  })
  .strict();
export type Bg5SellerConsentProjectionV1 = z.infer<typeof bg5SellerConsentProjectionV1Schema>;

// Extended Deal view for the /deals/:dealId page. Wraps the BG4
// `dealPublicV1Schema` and adds the current TermsVersion (nullable —
// a Deal in Negotiating may not yet have a draft), the current
// approvals (max 2: buyer + seller), and the seller-consent
// projection (null when the invariant does not hold).
export const bg5DealViewV1Schema = z
  .object({
    deal: dealPublicV1Schema,
    currentTermsVersion: bg5TermsVersionPublicV1Schema.nullable(),
    currentApprovals: z.array(bg5DealApprovalPublicV1Schema).max(2),
    sellerConsent: bg5SellerConsentProjectionV1Schema.nullable(),
    // M2 (#88) Codex finding: render the permission CTA and the
    // approve CTA MUTUALLY EXCLUSIVELY. The page needs an explicit
    // signal that the authenticated human (acting on the deal's
    // buyer or seller side) holds an explicit `DealApprover`
    // authorization for that Workspace. The server derives this
    // from the durable `deal_approvers` row keyed by
    // (workspaceId, userId) + the authenticated `UserAccount.id`.
    // Null when the human is not a current member of either
    // side (the page already requires membership) or when the
    // acting Workspace id is not a party to this Deal.
    actingSideHasDealApprover: z.boolean(),
  })
  .strict();
export type Bg5DealViewV1 = z.infer<typeof bg5DealViewV1Schema>;

// ---------- Request / response schemas ----------

// Draft terms. The acting Workspace id is required so the route can
// revalidate current membership. The Deal id comes from the URL path
// in the route layer; this schema carries the body payload only.
export const bg5DraftTermsRequestV1Schema = z
  .object({
    actingWorkspaceId: z.string().min(1).max(128),
  })
  .strict();
export type Bg5DraftTermsRequestV1 = z.infer<typeof bg5DraftTermsRequestV1Schema>;

export const bg5DraftTermsResponseV1Schema = z
  .object({
    ok: z.literal(true),
    termsVersion: bg5TermsVersionPublicV1Schema,
  })
  .strict();
export type Bg5DraftTermsResponseV1 = z.infer<typeof bg5DraftTermsResponseV1Schema>;

// Approve terms. The termsVersionId is supplied in the body so the
// application policy can verify it equals the current version before
// recording approval. A stale version produces
// BG5_APPROVAL_NOT_CURRENT_VERSION (422) and is NOT persisted.
export const bg5ApproveTermsRequestV1Schema = z
  .object({
    actingWorkspaceId: z.string().min(1).max(128),
    termsVersionId: z.string().min(1).max(128),
  })
  .strict();
export type Bg5ApproveTermsRequestV1 = z.infer<typeof bg5ApproveTermsRequestV1Schema>;

export const bg5ApproveTermsResponseV1Schema = z
  .object({
    ok: z.literal(true),
    approval: bg5DealApprovalPublicV1Schema,
  })
  .strict();
export type Bg5ApproveTermsResponseV1 = z.infer<typeof bg5ApproveTermsResponseV1Schema>;

// ===========================================================================
// M2 (#88) — extended accept ProjectRequest response shape.
//
// Per the reconciled M2 specification (and ticket #88), seller
// acceptance atomically creates exactly one Negotiating Deal AND one
// AI-drafted, unapproved current TermsVersion. The accept response
// envelope carries the TermsVersion row alongside the Deal so the
// browser can route the seller to the Negotiating Deal detail page
// without a second fetch.
//
// This declaration lives here rather than alongside the original
// `acceptProjectRequestResponseV1Schema` because it references
// `bg5TermsVersionPublicV1Schema`, which is declared further down
// in this file. JavaScript module hoisting does NOT cross the
// `export const` statement boundary so the reference has to follow
// the dependency order.
// ===========================================================================

export const acceptProjectRequestResponseV1Schema = z
  .object({
    ok: z.literal(true),
    projectRequest: projectRequestPublicV1Schema,
    deal: dealPublicV1Schema,
    // The AI-drafted, unapproved current TermsVersion the accept
    // transaction persisted atomically alongside the new Deal.
    // Same DTO as the Deal view's `currentTermsVersion` so the
    // browser can render the row immediately without a second round
    // trip.
    initialTermsVersion: bg5TermsVersionPublicV1Schema,
  })
  .strict();
export type AcceptProjectRequestResponseV1 = z.infer<typeof acceptProjectRequestResponseV1Schema>;

// ===========================================================================
// Milestone 2 (#88) — Personal-Workspace DealApprover JIT permission setup
//
// Per the reconciled M2 specification (and ticket #88), provisioning a
// `DealApprover` authorization is capability-neutral, Personal-Workspace-
// scoped, and explicit. The human accepts a closed, versioned
// approval-authority attestation before the authorization row exists.
// Setup is offered as optional dashboard readiness AND just-in-time
// from either party's attempted approval; it NEVER approves terms.
//
// This slice owns the schema-only surface for #88A. The route, the
// repository, and the UI land in later slices (#88C, #88D, #88E).
// ===========================================================================

// ---------- Closed confirmation version ----------
//
// The closed canonical version for the Personal-Workspace
// approval-authority attestation. The application boundary enforces
// this exact value at the trusted boundary; a stale or unknown version
// fails closed with `DEAL_APPROVER_CONFIRMATION_VERSION_MISMATCH`. The
// suffix pattern matches the established M2 attestation family
// (e.g., `m2-service-activation-v1`, `m2-seller-profile-publication-v1`,
// `m2-audio-confirmation-v1`).
export const m2DealApproverConfirmationVersionV1 = "m2-deal-approver-v1" as const;

// ---------- Public DTOs (strict allow-list) ----------
//
// Minimal allow-listed DealApprover projection. The application MUST
// NOT serialize `grantedByUserId` or the workspace's `ownerUserId`;
// the public envelope exposes only the bounded permission
// identifier, the Workspace it was granted for, and the grant
// timestamp. The human account identity stays on the private
// `DealApprover` row + the `DealApproverAcceptance` evidence
// table — it is NEVER serialized into the public DTO (AGENTS.md:
// "Do not expose account identity, membership, wallet, embedding,
// or storage internals publicly"). Customer-facing copy refers
// to this as "permission to approve terms", never `DealApprover`
// or provider / governance internals (ticket #88; M2 UX contract).
export const dealApproverPublicV1Schema = z
  .object({
    dealApproverId: z.string().min(1).max(128),
    workspaceId: z.string().min(1).max(128),
    grantedAt: z.string().datetime(),
  })
  .strict();
export type DealApproverPublicV1 = z.infer<typeof dealApproverPublicV1Schema>;

// ---------- Request / response schemas ----------
//
// Provision request body. The acting Workspace id is required so the
// route can revalidate current Personal-Workspace membership. The
// closed `confirmationVersion` is REQUIRED — the human must accept the
// current version of the approval-authority attestation. The
// `idempotencyKey` is a client-supplied UUID; same-key retry converges
// on the persisted row and does NOT create a duplicate.
export const provisionDealApproverRequestV1Schema = z
  .object({
    actingWorkspaceId: z.string().min(1).max(128),
    confirmationVersion: z.literal(m2DealApproverConfirmationVersionV1),
    idempotencyKey: z.string().uuid(),
  })
  .strict();
export type ProvisionDealApproverRequestV1 = z.infer<typeof provisionDealApproverRequestV1Schema>;

// Provision response. Wraps the allow-listed `DealApprover` projection.
// The route MUST NOT serialize the `grantedByUserId`, the persisted
// `confirmationVersion` audit row, the `idempotencyKey`, or the
// `requestId` — those live only on the durable `DealApproverAcceptance`
// evidence row.
export const provisionDealApproverResponseV1Schema = z
  .object({
    ok: z.literal(true),
    dealApprover: dealApproverPublicV1Schema,
  })
  .strict();
export type ProvisionDealApproverResponseV1 = z.infer<typeof provisionDealApproverResponseV1Schema>;

// Read the Deal view. No request body. The route accepts the Deal id
// in the path and the acting Workspace id as a query parameter so
// current membership can be revalidated server-side.
export const bg5GetDealRequestV1Schema = z
  .object({
    actingWorkspaceId: z.string().min(1).max(128),
  })
  .strict();
export type Bg5GetDealRequestV1 = z.infer<typeof bg5GetDealRequestV1Schema>;

export const bg5GetDealResponseV1Schema = z
  .object({
    deal: bg5DealViewV1Schema,
  })
  .strict();
export type Bg5GetDealResponseV1 = z.infer<typeof bg5GetDealResponseV1Schema>;

// ===========================================================================
// Buildathon Golden Slice 6 (BG6) — PaymentIntent + deterministic activation
//
// Per ticket #64 the buyer's authorized human explicitly requests
// funding for the current TermsVersion after both parties have
// approved it. The MockEscrowProvider is the only provider the
// buildathon wires; the confirmation carries an opaque reference, the
// exact amount the TermsVersion bound, the asset/network labels the
// mock returned, the current TermsVersion id, and a confirmation
// timestamp. The Deal becomes Active atomically with the
// confirmation persistence.
//
// Persistence is private: paymentIntentId, correlationId, raw
// providerReference, raw failureDetail, and internal providerState
// NEVER cross the public DTO. The single allow-listed public surface
// is bg6FundingConfirmationPublicV1Schema, which carries only
// product-safe status, amount, truthful provider/asset/network/
// environment labels, confirmation time, the sanitized failure code,
// and the schema-mandated sandboxSimulatedBadge literal.
// ===========================================================================

// ---------- Closed label / status / reason tuples ----------

// The fixed buildathon sandbox asset labels. The mock provider returns
// exactly this value; the application surfaces it in the UI so the
// sandbox / production distinction is unmistakable.
export const bg6SandboxAssetLabelsV1 = ["sandbox-USDC"] as const;
export type Bg6SandboxAssetLabelV1 = (typeof bg6SandboxAssetLabelsV1)[number];

// The fixed buildathon synthetic network label. Unmistakably
// simulated ("simulated-" prefix and "network" generic) so no
// concrete blockchain family is named. A future real
// PolkaAward adapter would expose its own truthful asset /
// network / environment labels through a separate closed tuple —
// the BG6 application boundary remains provider-neutral.
export const bg6SimulatedNetworkLabelsV1 = ["simulated-network"] as const;
export type Bg6SimulatedNetworkLabelV1 = (typeof bg6SimulatedNetworkLabelsV1)[number];

export const bg6EnvironmentLabelsV1 = ["sandbox"] as const;
export type Bg6EnvironmentLabelV1 = (typeof bg6EnvironmentLabelsV1)[number];

// Provider-neutral provider keys. The buildathon only wires the
// deterministic mock; a future PolkaAward adapter (or any other
// real adapter) extends this tuple WITHOUT changing the application
// types.
export const bg6ProviderKeysV1 = ["mock-escrow-deterministic"] as const;
export type Bg6ProviderKeyV1 = (typeof bg6ProviderKeysV1)[number];

// Public product-safe status enum. Mapped from internal
// PaymentIntentProviderState at the DTO boundary.
export const bg6PublicFundingStatusesV1 = ["AwaitingConfirmation", "Confirmed", "Failed"] as const;
export type Bg6PublicFundingStatusV1 = (typeof bg6PublicFundingStatusesV1)[number];

// Closed sanitized reason codes that may appear in the public DTO.
// Matches the persisted PaymentIntentFailureReasonCode enum.
export const bg6PublicFundingFailureReasonCodesV1 = [
  "EscrowProviderUnavailable",
  "EscrowConfirmationAmountMismatch",
  "EscrowConfirmationCurrencyMismatch",
  "EscrowConfirmationVersionMismatch",
] as const;
export type Bg6PublicFundingFailureReasonCodeV1 =
  (typeof bg6PublicFundingFailureReasonCodesV1)[number];

// ---------- Public DTOs ----------

// Minimal allow-listed public funding-status DTO. Carries ONLY
// product-safe fields. EXCLUDED from this schema:
//   - paymentIntentId        (internal audit id)
//   - correlationId          (SoundHub-owned opaque identity)
//   - providerReference      (provider-side handle)
//   - raw failureDetail      (server-only)
//   - internal providerState (mapped onto `status` here)
//
// `sandboxSimulatedBadge: z.literal(true)` is schema-mandated so a
// future refactor cannot silently drop the badge from the UI.
export const bg6FundingConfirmationPublicV1Schema = z
  .object({
    status: z.enum(bg6PublicFundingStatusesV1),
    expectedAmount: bg5UsdMoneyV1Schema,
    confirmedAmount: bg5UsdMoneyV1Schema.nullable(),
    providerKey: z.enum(bg6ProviderKeysV1),
    assetLabel: z.enum(bg6SandboxAssetLabelsV1),
    networkLabel: z.enum(bg6SimulatedNetworkLabelsV1),
    environmentLabel: z.enum(bg6EnvironmentLabelsV1),
    confirmationTime: z.string().datetime().nullable(),
    sanitizedFailureReason: z.enum(bg6PublicFundingFailureReasonCodesV1).nullable(),
    sandboxSimulatedBadge: z.literal(true),
  })
  .strict();
export type Bg6FundingConfirmationPublicV1 = z.infer<typeof bg6FundingConfirmationPublicV1Schema>;

// Funding request body. The actingWorkspaceId is required so the
// route can revalidate current membership + the Buyer capability.
// The Deal id comes from the URL path; no TermsVersion id from the
// client — the service derives the current version from the locked
// snapshot, so a stale client cannot force funding against a
// superseded version.
export const bg6FundDealRequestV1Schema = z
  .object({
    actingWorkspaceId: z.string().min(1).max(128),
  })
  .strict();
export type Bg6FundDealRequestV1 = z.infer<typeof bg6FundDealRequestV1Schema>;

// Funding response. Wraps the BG5 Deal view + the public funding
// status DTO. After a successful fund, the Deal view's
// `deal.status` carries "Active" and `activatedAt` the activation
// timestamp. The single allow-listed public funding surface is
// `fundingStatus` — no separate paymentIntent / fundingConfirmation
// members.
export const bg6FundDealResponseV1Schema = z
  .object({
    ok: z.literal(true),
    deal: bg5DealViewV1Schema,
    fundingStatus: bg6FundingConfirmationPublicV1Schema,
  })
  .strict();
export type Bg6FundDealResponseV1 = z.infer<typeof bg6FundDealResponseV1Schema>;

// Sanitized failure-detail category. The closed enum below is the
// ONLY value that may be persisted on `PaymentIntent.failureDetail`;
// raw exception text is logged server-side only. Bounded length is
// enforced at the application boundary so the column cannot be
// used to smuggle provider stack traces into the database.
export const bg6PaymentIntentFailureDetailCategoriesV1 = [
  "PROVIDER_UNAVAILABLE",
  "CONFIRMATION_INVALID",
  "CONFIRMATION_MISMATCH",
] as const;
export type Bg6PaymentIntentFailureDetailCategoryV1 =
  (typeof bg6PaymentIntentFailureDetailCategoriesV1)[number];

export const bg6PaymentIntentFailureDetailV1Schema = z
  .object({
    category: z.enum(bg6PaymentIntentFailureDetailCategoriesV1),
  })
  .strict();
export type Bg6PaymentIntentFailureDetailV1 = z.infer<typeof bg6PaymentIntentFailureDetailV1Schema>;

// ---------- BG5 error codes (appended to the shared safe envelope) ----------
//
// The new codes cover the rejection surfaces unique to the
// terms/approval slice and round-trip through `mapStatus` in
// `apps/api/src/lib/errors.ts`. They never expose provider subjects,
// raw tokens, session ids, storage credentials, bucket names,
// UserAccount ids, or internal DealApprover row ids.
