# Milestone 1 Plan: Database-Backed Talent and Offering Search

- **Status:** Ready for implementation after documentation review
- **Product specification:** [Milestone 1 spec](../specs/milestone-1-talent-search.md)
- **Domain language:** [`CONTEXT.md`](../../CONTEXT.md)
- **API contract:** [Talent Search API](../contracts/search-api.md)
- **Architecture:** [Workspaces](../adr/0001-workspaces-own-marketplace-activity.md),
  [offerings](../adr/0002-sellers-publish-purchasable-offerings.md), and
  [agent boundaries](../adr/0003-agents-reason-within-deterministic-workflows.md)

## Outcome

An anonymous buyer enters a brief and optional filters in the browser and receives deterministic,
public seller-and-offering results from PostgreSQL:

```text
Seeded Workspace + SellerProfile + Active ServiceOffering
    → PostgreSQL
    → PrismaTalentSearchRepository
    → TalentSearchService
    → Express POST /api/search
    → Next.js proxy
    → buyer-facing result states
```

The slice proves the browser, HTTP, runtime contract, application service, repository, Prisma, and
PostgreSQL boundaries without requiring AI, vector, Redis, storage, authentication, wallet, or
blockchain infrastructure.

It remains the future Matchmaker's retrieval primitive:

```text
Authenticated brief
    → Matchmaker
        → clarification when needed
        → required constraints + preferences
        → SearchTalentTool
            → TalentSearchService
```

## Scope baseline

### Implement

- Complete Milestone 1 structural schema foundation for UserAccount, Workspace,
  WorkspaceMembership, SellerProfile, ServiceCategory, Specialty, PricingUnit, and
  ServiceOffering
- Independent Buyer and Seller Workspace capabilities
- SellerProfile with professional identity, specialties, location, and Caribbean affiliations
- Controlled ServiceCategory records
- ServiceOffering with category, IncludedServices, pricing summary, service mode, and lifecycle
- Reviewed Prisma migration and deterministic idempotent seed
- Repository interface plus Prisma implementation
- Deterministic structured filtering and ranking
- Versioned, allow-listed public DTOs and shared runtime validation
- Standard safe API error envelope
- Express route and Next.js proxy
- Web initial, loading, results, empty, invalid, unavailable, and retry states
- Focused unit, repository, contract, web, and runtime tests

### Establish structurally but do not expose behavior

WorkspaceMembership records exist so marketplace ownership is correct. Authentication, invitations,
Workspace switching, membership administration, and permission screens remain deferred.

### Exclude

- Authentication and onboarding
- Matchmaker, Google ADK, OpenAI, embeddings, Pinecone, and generated explanations
- ProjectRequest, Deal, negotiation, approvals, delivery, and disputes
- Wallet, escrow, stablecoin, and Polkadot behavior
- Redis and scheduled jobs
- PortfolioItem, DealDeliverable, S3, and uploads
- Sync licensing of existing works
- Availability calendars and capacity inventory
- Admin moderation and real verification
- Production deployment

## Domain baseline

### Ownership

- UserAccount is a private human login.
- Workspace is the marketplace participant and owns capabilities and SellerProfile.
- A UserAccount may join multiple Workspaces.
- One Workspace owns at most one SellerProfile in the MVP.
- Personal and organizational Workspaces may sell when they represent creatives, bands, studios, or
  collectives.

### Seller eligibility

A search candidate is eligible only when:

```text
Workspace is eligible and has Seller capability
AND SellerProfile is published and not suspended
AND ServiceOffering is Active
```

Publication and verification are separate. Milestone 1 does not display or rank a fake verification
signal.

### Offerings

- Lifecycle: `Draft | Active | Paused | Archived`
- Service mode: `Remote | InPerson | Hybrid`
- One primary ServiceCategory per offering
- Optional IncludedServices are bundle-only
- Separate offerings represent independently purchasable work
- Pricing: `StartingAt`, `Fixed`, or `ContactForQuote`
- Price units are controlled values appropriate to the category; advertised pricing is non-binding

Initial category keys:

1. `music-production`
2. `songwriting`
3. `custom-composition`
4. `session-vocals`
5. `session-instrument-performance`
6. `featured-artist-performance`
7. `mixing`
8. `mastering`
9. `recording-engineering`
10. `live-performance`

## Search behavior

TalentSearchService accepts normalized text plus structured criteria divided into:

- `required`: exclusionary constraints
- `preferred`: ranking signals

The direct Milestone 1 UI must not silently derive hard constraints from free text. Later, the
Matchmaker owns clarification and translation into structured criteria.

Searchable evidence includes:

- Seller professional name and biography
- Specialties
- Caribbean affiliations and current location
- Offering title, description, primary category, IncludedServices, genres, tags, service mode, and
  service area

Ranking rules:

- Return at most ten sellers.
- Return one result per seller.
- Lead with the seller's best matching offering and include at most two additional matches.
- Required violations never enter ranking.
- Use named weights and a stable seller identifier tie-breaker.
- Bound relevanceScore from zero through one.
- Treat relevanceScore as strategy-specific ordering, not probability.
- Produce deterministic evidence-based matchReason without AI claims.
- Do not silently relax required constraints.

## Proposed implementation seams

```text
HTTP route
    → runtime request schema
    → TalentSearchService
        → TalentSearchRepository interface
            ← PrismaTalentSearchRepository
    → public response schema
```

Likely ownership shape:

```text
packages/types
    versioned request, response, error, and runtime schemas

packages/db
    schema, migration, seed, Prisma repository

apps/api
    route, service, repository interface, composition root, tests

apps/web
    proxy, client hook, filters, result cards, state tests
```

Exact private paths may change. Dependency direction and shared contracts may not change without
integration-owner approval.

## M1.1 execution baseline

[Issue #2](https://github.com/soundhub-studio/sound-hub/issues/2) is both Gate 1 and the first vertical
slice. It owns the shared foundation required by later tickets; it is not a disposable minimal model
that downstream streams are expected to redesign.

### Foundation completeness and authority

M1.1 must establish the complete Milestone 1 schema and deterministic positive-fixture foundation:

- Every Milestone 1 model, relationship, uniqueness rule, lifecycle field, and controlled-value
  representation needed by issues #2 through #8 is included in its reviewed migration.
- The seed includes all ten approved ServiceCategories, approved controlled records, and at least
  six stable positive Caribbean seller/offering fixtures. Later tickets may add negative and edge
  fixtures but must not redesign the foundation merely to implement their behavior.
- M1.1 also establishes the shared public schemas, internal repository interface/candidate contract,
  Prisma adapter, composition seam, and the first database-to-browser path.
- The M1.1 owner is the Milestone 1 integration owner until the foundation is merged. That owner may
  change shared types, dependency declarations, root scripts/configuration, and the lockfile when
  required by the approved slice. Other streams request changes to those files through that owner.
- A discovered foundation defect may reopen the contract through the documented integration-owner
  process; it does not authorize a downstream ticket to choose a conflicting architecture.

### Runtime validation

Use Zod as the shared runtime-validation implementation:

- `packages/types` owns versioned Zod request, response, and safe-error schemas and exports types
  inferred from those schemas. Do not maintain parallel handwritten DTO interfaces.
- Express parses untrusted request JSON with the shared request schema before invoking
  TalentSearchService.
- The web client parses untrusted success and error responses with the shared response schemas before
  updating UI state.
- Repository candidates and Prisma models remain internal and are not validated or exported as
  public DTOs merely because they are typed by TypeScript.
- M1.1 owns the Zod dependency and lockfile change. Later agent-tool schemas reuse the same public
  contract instead of creating a second validation strategy.

### Controlled values

Use two representations based on whether a value is behavioral or extensible:

- Closed, behavior-bearing states use shared Zod enums and matching Prisma enums:
  `WorkspaceType`, `WorkspaceStatus`, `WorkspaceMembershipRole`, `MarketplaceCapability`,
  `SellerProfileStatus`, `ServiceOfferingStatus`, `ServiceMode`, `PricingKind`, and `PurchaseMode`.
  Their approved M1 values are respectively `Personal | Organization`, `Active | Suspended`,
  `Owner | Admin | Member`, `Buyer | Seller`, `Draft | Published | Suspended`,
  `Draft | Active | Paused | Archived`, `Remote | InPerson | Hybrid`,
  `StartingAt | Fixed | ContactForQuote`, and `BundleOnly`. Contract tests must detect drift between
  persistence and shared public values.
- Extensible marketplace taxonomies are seeded records with stable keys, not Prisma enums:
  ServiceCategory, Specialty, and PricingUnit. Initial PricingUnit keys are `hour`, `track`,
  `project`, `session`, `event`, and `day`.
- Genre tags and seller-authored tags are normalized strings, not controlled records in Milestone 1.
- Location and CaribbeanAffiliation codes are uppercase ISO 3166-1 alpha-2 strings. The shared
  contract validates their shape; the application validates CaribbeanAffiliation against the
  supported Caribbean-code set. SoundHub does not redefine nationality.
- PostgreSQL and its idempotent seed are canonical for extensible records. Public schemas validate
  stable-key shape and the application/repository resolves whether a referenced key exists.

### Baseline relevance behavior

M1.1 implements only deterministic text evidence needed for its happy-path tracer:

1. Normalize the query by trimming, collapsing whitespace, lowercasing, removing surrounding
   punctuation, and deduplicating non-empty tokens.
2. Match distinct query tokens against the seeded offering title and primary ServiceCategory key and
   display name using case-insensitive comparison.
3. Compute relevanceScore as `matched distinct query tokens / distinct query tokens`, bounded from
   zero through one. Use stable sellerId as the final tie-breaker.
4. Build matchReason only from fields that actually matched, using factual wording such as matched
   offering title or category. Do not use qualitative labels, randomness, or AI claims.
5. Return the single matching offering as bestMatchingOffering and an empty
   additionalMatchingOfferings array for the M1.1 tracer.

This is intentionally an incremental implementation of `postgres-text-v1`, not a separate public
strategy. Issue #6 completes preference weighting, seller grouping, additional offerings, and final
Milestone 1 ranking semantics before the acceptance gate.

### Approved proxy

Retain the existing Next.js rewrite in `next.config.js` as the Milestone 1 proxy:

- Browser code calls same-origin `/api/search`.
- The server-side rewrite forwards `/api/:path*` to `${API_URL}/api/:path*`, using
  `http://localhost:4000` only as the local default.
- Do not introduce a Next.js route handler or duplicate validation/business logic in the web app.
- Playwright and proxy contract checks must exercise the rewrite and verify that success status,
  error status/body, and request ID pass through unchanged.

### Test meaning for M1.1

“Browser test” means one automated Playwright Chromium happy-path tracer running against the real
Next.js app, Express API, and disposable PostgreSQL database. It submits the search form and asserts
the rendered seller and Active offering. It does not mock `fetch`, the API, repository, or database.

Focused tests beneath that highest seam remain required:

- Node test-runner service tests use an in-memory TalentSearchRepository adapter.
- Repository integration tests use the real disposable PostgreSQL convention below.
- Express contract tests cross the HTTP interface and shared Zod schemas.
- Broader browser state, concurrency, retry, and unavailable-path coverage belongs to issues #7 and
  #8.

### Disposable PostgreSQL convention

M1.1 establishes a repository-controlled test database that cannot collide with or destroy the
developer database:

- Add a dedicated test Compose service/configuration with PostgreSQL only, database
  `soundhub_m1_test`, host port `5433`, and ephemeral storage rather than the developer named volume.
- Integration and Playwright commands require `TEST_DATABASE_URL`; the database name must end in
  `_test`, and the host must be local/Compose. A guard fails closed before reset, migration, or seed
  when those conditions are not met.
- The test harness maps the validated TEST_DATABASE_URL into Prisma's DATABASE_URL only for the
  child command that runs migrations, seed, API, or tests. It never prints credentials.
- Root scripts must provide explicit test-database up, migrate/seed/test, and down operations. Test
  teardown removes only the isolated test service and never invokes the developer `pnpm db:down`.
- Apply the reviewed migration from empty state, seed twice, verify idempotence, and reset test state
  deterministically between repository tests.
- Shared, staging, production, and the default developer database are forbidden targets.

## Work breakdown

### Gate 1 / M1.1 — Shared foundation and first tracer

Single integration owner:

1. Add shared request, response, and error schemas.
2. Add repository interface and internal candidate contract.
3. Establish domain names and identifiers.
4. Add compile-only fakes where useful.
5. Freeze shared files after focused checks pass.

### Stream A — Database

**Suggested worktree:** `codex/m1-database`

Owns Prisma schema, reviewed migration, seed, Prisma repository, and repository integration tests.

Tasks:

1. Replace the pre-release role/ProducerProfile/MusicTrack scaffold.
2. Implement minimal Workspace ownership and marketplace discovery records.
3. Seed stable solo, multi-brand, and group Workspace examples.
4. Seed at least six Caribbean sellers and Active offerings across all major query scenarios.
5. Implement eligibility and candidate retrieval.
6. Apply and test migration only against disposable local PostgreSQL.

### Stream B — API and search service

**Suggested worktree:** `codex/m1-api-search`

Owns service, internal repository seam, HTTP route, runtime mapping, and API/service tests.

Tasks:

1. Replace RagService with TalentSearchService.
2. Remove random scores, fake vectors, delay, and fabricated AI text.
3. Validate strict text and structured criteria.
4. Apply required filters and deterministic preference ranking.
5. Deduplicate by seller and map best/additional offerings.
6. Map safe validation, internal, and database-unavailable errors.

### Stream C — Web

**Suggested worktree:** `codex/m1-web-search`

Owns Next.js proxy, search state, filters, result presentation, and web tests.

Tasks:

1. Consume shared request/response schemas.
2. Preserve cancellation and prevent stale responses or stale loading state.
3. Render all approved states and preserve input after retryable failure.
4. Show match evidence, pricing kind, category, service mode, location, and affiliations.
5. Do not show relevanceScore as a buyer-facing percentage.
6. Label bundle-only IncludedServices accurately.

## Worktree coordination

Use an integration branch such as `codex/m1-talent-search`; do not merge independent worktrees
directly into `main`.

```text
shared foundation
       ↓
database ─────┐
API fake repo ├──→ integration → full checks → runtime smoke → review
web UI ───────┘
```

Rules:

1. One owner per worktree.
2. The integration owner exclusively owns shared types, root configuration, and lockfile.
3. Dependency requests go through the integration owner.
4. Shared contract changes require evidence, explicit approval, and notification to all streams.
5. No migration runs against shared, staging, or production databases.
6. Every stream runs focused checks before handoff.
7. The integration owner runs full verification after every merge.

## Migration safety

Before migration work:

1. Confirm the target is disposable local PostgreSQL without printing credentials.
2. Confirm no valuable data depends on the pre-release scaffold.
3. Generate a descriptively named migration.
4. Read SQL for destructive operations, data loss, indexes, constraints, and unintended enum lock-in.
5. Run migration from an empty database.
6. Seed twice and verify stable row counts and values.
7. Do not use `prisma db push` as an acceptance substitute.

## Acceptance gates

### Repository

```bash
pnpm type-check
pnpm lint
pnpm test
pnpm build
pnpm format:check
```

### Database

- Fresh migration succeeds against empty PostgreSQL.
- Seed succeeds twice without duplication or random changes.
- Repository integration tests use real PostgreSQL.
- Draft, Paused, Archived, unpublished, suspended, and ineligible records are excluded correctly.

### Service and API

- Repeated input and state produce identical ordering, reasons, and scores.
- Required/preferred semantics, bundles, deduplication, and tie-breaking are covered.
- Empty results return `200`.
- Invalid and unknown fields use the standard error envelope.
- Database unavailability returns safe retriable `503`.
- Public DTOs exclude private account, wallet, embedding, storage, and internal timestamp fields.
- Next.js proxy preserves the Express contract.

### Web

- Initial, loading, results, empty, invalid, unavailable, and retry states work.
- Input survives retryable failures.
- Canceled or older requests cannot overwrite newer state.
- No percentage-confidence claim appears.

### Runtime smoke

```text
clean PostgreSQL
→ migrate
→ seed twice
→ start API and web
→ health check
→ successful browser search
→ strict invalid request
→ unavailable dependency state
```

No AI, vector, Redis, storage, wallet, or blockchain credentials are permitted in this gate.

## Completion handoff

Milestone 1 is complete only when the acceptance gates pass, runtime behavior matches the published
contract, the obsolete mock path is gone, and documentation reflects any approved contract changes.
Authentication and later MVP milestones require a new stress-test before implementation.
