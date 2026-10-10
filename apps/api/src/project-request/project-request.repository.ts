// ProjectRequest + Deal repository contract.
//
// Background: ticket #62 (BG4 of the Buildathon Golden Slice)
// requires a persistence boundary for ProjectRequest and the Deal
// that follows an accepted request. The contract is the only surface
// the service layer depends on; the Prisma adapter is the canonical
// implementation and is the only place that touches the database
// directly. Higher layers (service, route) consume the contract
// exclusively.
//
// The contract deliberately exposes transaction-scoped use cases so
// the application can run authorization, eligibility, and persistence
// in one authoritative unit of work:
//
//   - createProjectRequestInTransaction runs the FOR UPDATE-locked
//     buyer authority read, the FOR UPDATE-locked seller / offering
//     eligibility read, and the FOR UPDATE-locked ProjectBrief
//     recommendation boundary read, then hands the assembled snapshot
//     to the application-owned use case. The use case evaluates the
//     policy helpers in `project-request-authorization-policy.ts`
//     and either calls the provided `persist` tool or surfaces a
//     rejection. The repository never decides whether the facts
//     authorize the command.
//
//   - respondToProjectRequestInTransaction does the same for accept /
//     decline: it FOR UPDATE-locks the request, the seller Workspace
//     / membership / capability rows, then hands the snapshot to the
//     application-owned use case, which decides whether to transition
//     the request and (for accept) create exactly one Negotiating
//     Deal. The guarded updateMany on Pending status and the unique
//     index on `deals.projectRequestId` remain the second defenses
//     against retries creating duplicate decisions.
//
//   - findProjectRequestById / listProjectRequests are read-only
//     surfaces used by view + inbox flows. Membership authorization
//     is the caller's responsibility; these methods only filter by
//     workspace.

import type { ProjectRequestStatusV1, DealStatusV1 } from "@soundhub/types";
import type {
  BriefRecommendationsSnapshot,
  BuyerAuthoritySnapshot,
  SellerAuthoritySnapshot,
  SellerEligibilitySnapshot,
} from "./project-request-authorization-policy.js";

// ---------- M2 (#88) — initial TermsVersion draft ----------
//
// The seller-accept command atomically creates exactly one
// Negotiating Deal AND exactly one AI-drafted, unapproved current
// TermsVersion (ticket #88 acceptance criterion: "Seller acceptance
// atomically and retry-safely creates exactly one Negotiating Deal
// and AI-drafted, unapproved current TermsVersion"). The application
// layer is responsible for generating the AI proposal; the
// repository is responsible for FOR UPDATE-locking the Deal + the
// `(dealId, version)` uniqueness and persisting the row inside the
// same transaction that creates the Deal. A retry that re-enters
// the same accept payload converges on the same TermsVersion row
// because the (dealId, version) UNIQUE index rejects duplicates.
//
// The shape mirrors `PersistDraftTermsInput["proposedTerms"]` in
// `apps/api/src/deal-terms/deal-terms.repository.ts`. We deliberately
// do NOT import the DealTerms contract here so the ProjectRequest
// repository seam stays a single-file module — the application layer
// constructs the validated proposal before opening the transaction.
export interface InitialTermsVersionDraft {
  readonly scope: string;
  readonly deliverables: ReadonlyArray<{
    readonly title: string;
    readonly description: string;
  }>;
  readonly schedule: {
    readonly startDate: string;
    readonly endDate: string;
    readonly deliveryDays: number;
  };
  readonly price: { readonly amountMinor: number; readonly currency: "USD" };
  readonly revisionAllowance: number;
  readonly rightsSummary: string;
  readonly fundingDeadlineAt?: string;
  readonly aiProvider: "managed" | "deterministic-fallback";
  readonly aiModelId: string | null;
  readonly aiFallbackUsed: boolean;
}

export interface PersistedTermsVersion {
  readonly id: string;
  readonly dealId: string;
  readonly version: number;
  readonly scope: string;
  readonly deliverablesJson: unknown;
  readonly scheduleJson: unknown;
  readonly priceAmountMinor: number;
  readonly priceCurrency: string;
  readonly revisionAllowance: number;
  readonly rightsSummary: string;
  readonly fundingDeadlineAt: Date | null;
  readonly aiProvider: string;
  readonly aiModelId: string | null;
  readonly aiFallbackUsed: boolean;
  readonly draftedByUserId: string | null;
  readonly draftedAt: Date;
  readonly createdAt: Date;
}

export interface PersistedProjectRequest {
  readonly id: string;
  readonly buyerWorkspaceId: string;
  readonly sellerWorkspaceId: string;
  readonly serviceOfferingId: string;
  readonly projectBriefId: string;
  readonly createdByUserId: string;
  readonly status: ProjectRequestStatusV1;
  readonly sellerDecisionAt: Date | null;
  readonly sellerDecisionByUserId: string | null;
  readonly sellerConsentAt: Date | null;
  readonly createdAt: Date;
  // Display-only context for the seller inbox (and the symmetric
  // buyer audit view). Mirrors the same-named fields on the public
  // DTO; nullable when the referenced row could not be loaded (e.g.
  // in tests where the fixture does not seed a ProjectBrief).
  // The repository populates them on read paths only; transactional
  // create / accept / decline paths leave them null because the UI
  // immediately re-lists and re-renders from the read surface.
  readonly buyerWorkspaceName: string | null;
  readonly sellerWorkspaceName: string | null;
  readonly serviceOfferingTitle: string | null;
  readonly briefExcerpt: string | null;
}

export interface PersistedDeal {
  readonly id: string;
  readonly buyerWorkspaceId: string;
  readonly sellerWorkspaceId: string;
  readonly serviceOfferingId: string;
  readonly projectBriefId: string;
  readonly projectRequestId: string;
  readonly status: DealStatusV1;
  readonly activatedAt: Date | null;
  readonly createdAt: Date;
}

export interface PersistPendingProjectRequestInput {
  readonly userAccountId: string;
  readonly buyerWorkspaceId: string;
  readonly sellerWorkspaceId: string;
  readonly projectBriefId: string;
  readonly serviceOfferingId: string;
}

export interface PersistAcceptProjectRequestInput {
  readonly projectRequestId: string;
  readonly sellerDecisionByUserId: string;
  readonly now: Date;
  /**
   * M2 (#88): the AI-drafted TermsVersion proposal persisted alongside
   * the new Deal in the SAME transaction. Required on accept; absent
   * on decline. The application layer validates the candidate against
   * `bg5ProposedTermsV1Schema` BEFORE handing it to the repository;
   * the repository does NOT validate it. The transaction persists the
   * row with monotonic version 1; the `(dealId, version)` UNIQUE
   * index is the durable convergence key for same-attempt retry.
   */
  readonly initialTermsVersionDraft: InitialTermsVersionDraft;
}

export interface PersistDeclineProjectRequestInput {
  readonly projectRequestId: string;
  readonly sellerDecisionByUserId: string;
  readonly now: Date;
}

export type CreateProjectRequestFailureReason =
  | "BUYER_NOT_AUTHORIZED"
  | "SELLER_INELIGIBLE"
  | "BRIEF_NOT_FOUND"
  | "BRIEF_FORBIDDEN"
  | "OFFERING_NOT_IN_BRIEF"
  | "ALREADY_PENDING"
  | "CONCURRENCY_RETRY_EXHAUSTED";

export type DecideFailureReason =
  | "NOT_FOUND"
  | "ALREADY_RESPONDED"
  | "SELLER_NOT_AUTHORIZED"
  | "CONCURRENCY_RETRY_EXHAUSTED";

export type CreateProjectRequestResult =
  | { readonly ok: true; readonly value: PersistedProjectRequest }
  | { readonly ok: false; readonly reason: CreateProjectRequestFailureReason };

export type DecideResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: DecideFailureReason };

// ---------- create use case ----------

export interface CreateProjectRequestUseCaseContext {
  readonly buyerAuthority: BuyerAuthoritySnapshot;
  readonly sellerEligibility: SellerEligibilitySnapshot;
  readonly briefRecommendations: BriefRecommendationsSnapshot;
}

export interface CreateProjectRequestUseCaseTools {
  reject(reason: CreateProjectRequestFailureReason): CreateUseCaseOutcome;
  persist(input: PersistPendingProjectRequestInput): CreateUseCaseOutcome;
}

export type CreateUseCaseOutcome =
  | { readonly kind: "reject"; readonly reason: CreateProjectRequestFailureReason }
  | { readonly kind: "persist"; readonly input: PersistPendingProjectRequestInput };

export type CreateProjectRequestUseCase = (
  ctx: CreateProjectRequestUseCaseContext,
  tools: CreateProjectRequestUseCaseTools,
) => CreateUseCaseOutcome;

export interface CreateProjectRequestTransactionInput {
  readonly userAccountId: string;
  readonly buyerWorkspaceId: string;
  readonly projectBriefId: string;
  readonly serviceOfferingId: string;
}

// ---------- respond (accept/decline) use case ----------

export interface RespondProjectRequestUseCaseContext {
  readonly sellerAuthority: SellerAuthoritySnapshot;
  readonly projectRequest: PersistedProjectRequest;
}

export interface RespondProjectRequestUseCaseTools {
  reject(reason: DecideFailureReason): RespondUseCaseOutcome;
  accept(input: PersistAcceptProjectRequestInput): RespondUseCaseOutcome;
  decline(input: PersistDeclineProjectRequestInput): RespondUseCaseOutcome;
}

export type RespondUseCaseOutcome =
  | { readonly kind: "reject"; readonly reason: DecideFailureReason }
  | { readonly kind: "accept"; readonly input: PersistAcceptProjectRequestInput }
  | { readonly kind: "decline"; readonly input: PersistDeclineProjectRequestInput };

export type RespondProjectRequestUseCase = (
  ctx: RespondProjectRequestUseCaseContext,
  tools: RespondProjectRequestUseCaseTools,
) => RespondUseCaseOutcome;

export interface RespondProjectRequestTransactionInput {
  readonly projectRequestId: string;
  readonly actingWorkspaceId: string;
  readonly userAccountId: string;
  readonly now: Date;
}

export interface AcceptProjectRequestResult {
  readonly projectRequest: PersistedProjectRequest;
  readonly deal: PersistedDeal;
  /**
   * M2 (#88): the AI-drafted, unapproved current TermsVersion the
   * accept transaction persisted atomically alongside the Deal. The
   * row is unapproved by construction — accepting a ProjectRequest
   * is NOT TermsVersion approval (ticket #88 acceptance criterion).
   */
  readonly initialTermsVersion: PersistedTermsVersion;
}

// ---------- interface ----------

export interface ProjectRequestRepository {
  /**
   * Open one PostgreSQL transaction. Inside the transaction the
   * adapter acquires `SELECT ... FOR UPDATE` row locks on every
   * row the buyer authority read depends on (Workspace,
   * WorkspaceMembership, WorkspaceCapability for the buyer), every
   * row the seller eligibility read depends on (Workspace,
   * WorkspaceCapability, SellerProfile, ServiceOffering for the
   * seller side), and the ProjectBrief row. The adapter then
   * invokes the supplied `useCase` with the assembled snapshot. The
   * use case is the application-owned policy: it calls
   * `evaluateBuyerAuthority`, `evaluateSellerEligibility`, and
   * `evaluateBriefRecommendationBoundary` (or rejects for any
   * application-specific reason) and returns either `persist` or
   * `reject`. The adapter persists when the use case persists;
   * otherwise the transaction rolls back with no state change.
   *
   * Failure reasons returned to the caller map one-to-one onto
   * the use-case reject reasons. The unique index on Pending
   * `project_requests` rows remains the second defense against
   * retries creating inappropriate duplicates.
   */
  createProjectRequestInTransaction(
    input: CreateProjectRequestTransactionInput,
    useCase: CreateProjectRequestUseCase,
  ): Promise<CreateProjectRequestResult>;

  /**
   * Same shape as create, but for accept / decline. The adapter
   * FOR UPDATE-locks the ProjectRequest row, the seller Workspace,
   * the seller WorkspaceMembership, and the seller
   * WorkspaceCapability, then hands the snapshot to the use case.
   * The use case calls `evaluateSellerAuthority` and returns
   * `accept`, `decline`, or `reject`. When the use case accepts,
   * the adapter runs the guarded updateMany on Pending status and
   * creates the Negotiating Deal atomically; the unique index on
   * `deals.projectRequestId` is the second defense against retries
   * creating multiple Deals.
   */
  respondToProjectRequestInTransaction(
    input: RespondProjectRequestTransactionInput,
    useCase: RespondProjectRequestUseCase,
  ): Promise<DecideResult<AcceptProjectRequestResult | PersistedProjectRequest>>;

  findProjectRequestById(projectRequestId: string): Promise<PersistedProjectRequest | null>;

  /**
   * List ProjectRequests whose buyerWorkspaceId OR sellerWorkspaceId
   * matches `workspaceId`, ordered by createdAt desc. Optional
   * `statusFilter` narrows to one status (used by the seller inbox
   * to show only Pending requests). Membership authorization is the
   * caller's responsibility; this method only filters by workspace.
   */
  listProjectRequests(input: {
    readonly workspaceId: string;
    readonly statusFilter?: ProjectRequestStatusV1;
  }): Promise<readonly PersistedProjectRequest[]>;
}
