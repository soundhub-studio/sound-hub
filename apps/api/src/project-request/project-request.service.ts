// ProjectRequest service (BG4).
//
// Background: ticket #62 requires a single application boundary that
// owns the buyer-side ProjectRequest creation, the seller-side
// accept/decline, and the eligibility revalidation that protects
// against stale selections (GS 16). The service composes:
//
//   - the application-owned policy evaluators in
//     `./project-request-authorization-policy.ts` (buyer authority,
//     complete seller / offering eligibility, brief recommendation
//     boundary, seller authority), and
//   - the transaction-scoped repository methods in
//     `./project-request.repository.ts` (one PostgreSQL transaction
//     per command, FOR UPDATE-locked fact reads, guarded persistence).
//
// For each consequential command the service supplies a pure use-case
// closure that consumes the snapshot the repository loads inside its
// transaction and returns either a `persist` verdict or a `reject`
// verdict. The repository never decides whether the facts authorize
// the command; the service owns that decision.
//
// The repository remains the only layer that touches Prisma. The
// service has no Prisma dependency.

import type {
  CreateProjectRequestRequestV1,
  ProjectRequestPublicV1,
  DealPublicV1,
  DealTermsAiDraftInputV1,
  DealTermsAiDraftOutputV1,
  Bg5TermsVersionPublicV1,
} from "@soundhub/types";
import { bg5ProposedTermsV1Schema } from "@soundhub/types";
import type { PersistedBrief } from "../matchmaker/project-brief.repository.js";
import {
  AuthorizationError,
  type WorkspaceAuthorizationService,
} from "../services/workspace-authorization.service.js";
import type { DealTermsAiAdapter } from "../deal-terms/deal-terms-ai-adapter.js";
import { DeterministicDealTermsAiAdapter } from "../deal-terms/deal-terms-ai-adapter.js";
import type {
  AcceptProjectRequestResult,
  CreateProjectRequestFailureReason,
  CreateProjectRequestResult,
  CreateProjectRequestUseCase,
  CreateProjectRequestUseCaseContext,
  CreateProjectRequestUseCaseTools,
  CreateUseCaseOutcome,
  DecideFailureReason,
  DecideResult,
  InitialTermsVersionDraft,
  PersistedDeal,
  PersistedProjectRequest,
  PersistedTermsVersion,
  ProjectRequestRepository,
  RespondProjectRequestUseCase,
  RespondProjectRequestUseCaseContext,
  RespondProjectRequestUseCaseTools,
  RespondUseCaseOutcome,
} from "./project-request.repository.js";
import {
  evaluateBriefRecommendationBoundary,
  evaluateBuyerAuthority,
  evaluateSellerAuthority,
  evaluateSellerEligibility,
} from "./project-request-authorization-policy.js";

export class ProjectRequestError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "PROJECT_REQUEST_INVALID"
      | "PROJECT_REQUEST_BRIEF_NOT_FOUND"
      | "PROJECT_REQUEST_BRIEF_FORBIDDEN"
      | "PROJECT_REQUEST_OFFERING_INELIGIBLE"
      | "PROJECT_REQUEST_NOT_FOUND"
      | "PROJECT_REQUEST_FORBIDDEN"
      | "PROJECT_REQUEST_ALREADY_PENDING"
      | "PROJECT_REQUEST_ALREADY_RESPONDED"
      | "PROJECT_REQUEST_UNAVAILABLE"
      | "PROJECT_REQUEST_TERMS_DRAFT_INVALID",
  ) {
    super(message);
    this.name = "ProjectRequestError";
  }
}

export interface ProjectRequestServiceDeps {
  readonly projectRequestRepository: ProjectRequestRepository;
  /**
   * Used by the read commands (getProjectRequest /
   * listProjectRequests) to revalidate that the authenticated
   * UserAccount holds a current WorkspaceMembership in the
   * explicitly acting Workspace before any private ProjectRequest
   * DTO is returned. The application owns this policy decision;
   * the repository never inspects WorkspaceMembership.
   */
  readonly workspaceAuthorizationService: WorkspaceAuthorizationService;
  /**
   * M2 (#88): AI adapter that produces the initial TermsVersion
   * candidate on accept. Defaults to the deterministic fallback
   * adapter so the buildathon journey stays reproducible without a
   * managed provider. The service validates the candidate against
   * the strict `bg5ProposedTermsV1Schema` before persisting; a
   * malformed candidate collapses to a typed `PROJECT_REQUEST_TERMS_DRAFT_INVALID`
   * rejection (no Deal is created in that case).
   */
  readonly termsDraftAiAdapter?: DealTermsAiAdapter;
  /**
   * Optional clock injection for tests. Defaults to `new Date()`.
   */
  readonly now?: () => Date;
}

export interface CreateProjectRequestInput {
  readonly userAccountId: string;
  readonly actingWorkspaceId: string;
  readonly projectBriefId: string;
  readonly serviceOfferingId: string;
}

export interface AcceptProjectRequestInput {
  readonly userAccountId: string;
  readonly actingWorkspaceId: string;
  readonly projectRequestId: string;
}

export interface DeclineProjectRequestInput {
  readonly userAccountId: string;
  readonly actingWorkspaceId: string;
  readonly projectRequestId: string;
}

export interface GetProjectRequestInput {
  readonly userAccountId: string;
  readonly actingWorkspaceId: string;
  readonly projectRequestId: string;
}

export interface ListProjectRequestsInput {
  readonly userAccountId: string;
  readonly actingWorkspaceId: string;
  readonly statusFilter?: "Pending" | "Accepted" | "Declined";
}

export class ProjectRequestService {
  private readonly repository: ProjectRequestRepository;
  private readonly authz: WorkspaceAuthorizationService;
  private readonly termsDraftAiAdapter: DealTermsAiAdapter;
  private readonly now: () => Date;

  constructor(deps: ProjectRequestServiceDeps) {
    this.repository = deps.projectRequestRepository;
    this.authz = deps.workspaceAuthorizationService;
    this.termsDraftAiAdapter = deps.termsDraftAiAdapter ?? new DeterministicDealTermsAiAdapter();
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Create a Pending ProjectRequest owned by the acting Buyer
   * Workspace.
   *
   * The service supplies a use-case callback. The repository opens
   * one transaction, FOR UPDATE-locks the buyer Workspace /
   * membership / capability, the seller Workspace / membership /
   * capability, the seller Profile, the ServiceOffering, and the
   * ProjectBrief + BriefSearchResult rows, then hands the
   * snapshots to the use case. The use case evaluates the
   * application-owned policy and returns either `persist` (with the
   * sellerWorkspaceId the snapshot surfaced) or `reject`. The
   * repository persists only when the use case persists.
   */
  async createProjectRequest(input: CreateProjectRequestInput): Promise<{
    readonly projectRequest: ProjectRequestPublicV1;
  }> {
    const useCase: CreateProjectRequestUseCase = (
      ctx: CreateProjectRequestUseCaseContext,
      tools: CreateProjectRequestUseCaseTools,
    ): CreateUseCaseOutcome => evaluateCreateUseCase(ctx, tools, input);

    const result = await this.repository.createProjectRequestInTransaction(
      {
        userAccountId: input.userAccountId,
        buyerWorkspaceId: input.actingWorkspaceId,
        projectBriefId: input.projectBriefId,
        serviceOfferingId: input.serviceOfferingId,
      },
      useCase,
    );

    if (!result.ok) {
      throw this.createFailureToServiceError(result.reason);
    }
    return { projectRequest: toPublicProjectRequest(result.value) };
  }

  /**
   * Accept a Pending ProjectRequest as the seller. Atomically
   * transitions Pending → Accepted, creates exactly one Negotiating
   * Deal, AND creates exactly one AI-drafted, unapproved current
   * TermsVersion (ticket #88 acceptance criteria + GS 18 + GS 26).
   *
   * M2 (#88) Codex finding: the AI candidate is produced INSIDE
   * the transaction via a deferred thunk the use case closure
   * captures. The repository invokes the thunk AFTER the
   * guarded Pending → Accepted update + Deal insert succeed
   * and BEFORE the TermsVersion insert. The adapter is
   * therefore NOT invoked for unauthorized / already-responded /
   * losing-concurrent attempts, and concurrent accepts share the
   * same retry-safe adapter call only on the winning path. A
   * strict-validation failure on the winning path throws and the
   * surrounding `$transaction` rolls back, leaving no Deal +
   * no TermsVersion rows behind. The (deals.projectRequestId) +
   * (termsVersions.dealId, version) UNIQUE indexes are the
   * durable convergence keys for same-attempt retry. The
   * transaction does NOT approve the TermsVersion (per the M2
   * authority invariants: ProjectRequest acceptance is not
   * TermsVersion approval).
   */
  async acceptProjectRequest(input: AcceptProjectRequestInput): Promise<{
    readonly projectRequest: ProjectRequestPublicV1;
    readonly deal: DealPublicV1;
    readonly initialTermsVersion: Bg5TermsVersionPublicV1;
  }> {
    // Step 1: look up the ProjectRequest so we can pass real
    // buyer / seller / ServiceOffering ids to the AI adapter. If
    // the lookup fails (rare: the row was deleted between the
    // create call and this accept), we fall back to placeholder
    // ids derived from the input + projectRequestId so the adapter
    // receives a well-formed input shape regardless of lookup
    // fidelity. The strict-validation of the candidate guarantees
    // the persisted row matches the contract regardless.
    const prRow = await this.repository.findProjectRequestById(input.projectRequestId);
    const aiContext = prRow ?? {
      id: input.projectRequestId,
      buyerWorkspaceId: `pending-${input.projectRequestId}`,
      sellerWorkspaceId: input.actingWorkspaceId,
      serviceOfferingId: `pending-${input.projectRequestId}`,
      projectBriefId: `pending-${input.projectRequestId}`,
    };

    // Step 2: build the deferred AI draft producer. The thunk
    // is captured by the use case closure and invoked by the
    // repository ONLY when the use case decides to accept.
    // Concurrent losing accepts therefore never invoke the
    // adapter; unauthorized attempts never invoke the adapter;
    // already-responded attempts never invoke the adapter.
    const produceInitialTermsVersionDraft = async (): Promise<InitialTermsVersionDraft> => {
      return this.produceInitialTermsVersionDraft(input, aiContext);
    };

    // Step 3: open one transaction via the use-case closure.
    const useCase: RespondProjectRequestUseCase = (
      ctx: RespondProjectRequestUseCaseContext,
      tools: RespondProjectRequestUseCaseTools,
    ): RespondUseCaseOutcome => {
      const verdict = evaluateSellerAuthority(ctx.sellerAuthority);
      if (!verdict.ok) {
        return tools.reject("SELLER_NOT_AUTHORIZED");
      }
      return tools.accept({
        projectRequestId: ctx.projectRequest.id,
        sellerDecisionByUserId: input.userAccountId,
        now: this.now(),
        // M2 (#88) Codex finding: the AI draft is a thunk
        // captured from the use-case context. The repository
        // invokes it INSIDE the transaction, AFTER the guarded
        // transition + Deal insert succeed, and BEFORE the
        // TermsVersion insert. A strict-validation failure
        // throws and rolls back the transaction.
        produceInitialTermsVersionDraft:
          ctx.produceInitialTermsVersionDraft ??
          (() =>
            Promise.reject(
              new Error("Internal error: repository did not provide an AI draft producer."),
            )),
      });
    };

    const result = await this.repository.respondToProjectRequestInTransaction(
      {
        projectRequestId: input.projectRequestId,
        actingWorkspaceId: input.actingWorkspaceId,
        userAccountId: input.userAccountId,
        now: this.now(),
        produceInitialTermsVersionDraft,
      },
      useCase,
    );
    if (!result.ok) {
      throw this.decideErrorToServiceError(result.reason);
    }
    const accepted = result.value as AcceptProjectRequestResult;
    return {
      projectRequest: toPublicProjectRequest(accepted.projectRequest),
      deal: toPublicDeal(accepted.deal),
      initialTermsVersion: toPublicInitialTermsVersion(accepted.initialTermsVersion, true),
    };
  }

  /**
   * Produce + structurally validate the initial TermsVersion draft
   * the repository will persist alongside the new Deal. The
   * `bg5ProposedTermsV1Schema` is the same strict Zod schema the
   * DealTermsService uses — the application is the only validation
   * point, and no Deal may exist without a strictly valid
   * TermsVersion. A malformed candidate collapses to
   * `PROJECT_REQUEST_TERMS_DRAFT_INVALID` (no Deal is created).
   *
   * The adapter's `dealId` argument is constructed from the
   * ProjectRequest id so the adapter can produce a deterministic
   * proposal for the buildathon journey; the adapter's candidate
   * is keyed by the application boundary, not by the persisted
   * Deal id (which does not exist yet at this point).
   */
  private async produceInitialTermsVersionDraft(
    input: AcceptProjectRequestInput,
    prRow: {
      readonly id: string;
      readonly buyerWorkspaceId: string;
      readonly sellerWorkspaceId: string;
      readonly serviceOfferingId: string;
      readonly projectBriefId: string;
    },
  ): Promise<InitialTermsVersionDraft> {
    // The Deal summary is needed to thread buyer/seller Workspace ids
    // + the ServiceOffering id into the AI boundary input. The
    // ProjectRequestRepository already exposes the persisted row;
    // we re-read it for the strict input shape so the adapter does
    // not need Prisma access. A null lookup (rare — the row was
    // deleted between the create call and this accept) is handled
    // by the caller, which falls back to placeholder ids derived
    // from the input + projectRequestId.
    const aiInput: DealTermsAiDraftInputV1 = {
      dealId: `pending-${prRow.id}`,
      buyerWorkspaceId: prRow.buyerWorkspaceId,
      sellerWorkspaceId: prRow.sellerWorkspaceId,
      serviceOfferingId: prRow.serviceOfferingId,
      projectBriefId: prRow.projectBriefId,
    };
    const output: DealTermsAiDraftOutputV1 =
      await this.termsDraftAiAdapter.draftProposedTerms(aiInput);
    // Strict validate the candidate at the trusted boundary.
    const parsed = bg5ProposedTermsV1Schema.safeParse(output.candidate);
    if (!parsed.success) {
      // Mirror the DealTermsService diagnostic-only logging seam so
      // server-side logs retain the AI diagnostic while the public
      // envelope receives a generic typed rejection.
      const diagnostic = {
        provider: output.provider,
        issueCount: parsed.error.issues.length,
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          code: i.code,
          message: i.message,
        })),
      };
      console.error(
        "[project-request] AI TermsVersion draft validation failed:",
        JSON.stringify(diagnostic),
      );
      throw new ProjectRequestError(
        "The drafted terms were invalid.",
        "PROJECT_REQUEST_TERMS_DRAFT_INVALID",
      );
    }
    return {
      scope: parsed.data.scope,
      deliverables: parsed.data.deliverables.map((d) => ({
        title: d.title,
        description: d.description,
      })),
      schedule: {
        startDate: parsed.data.schedule.startDate,
        endDate: parsed.data.schedule.endDate,
        deliveryDays: parsed.data.schedule.deliveryDays,
      },
      price: {
        amountMinor: parsed.data.price.amountMinor,
        currency: parsed.data.price.currency,
      },
      revisionAllowance: parsed.data.revisionAllowance,
      rightsSummary: parsed.data.rightsSummary,
      ...(parsed.data.fundingDeadlineAt !== undefined
        ? { fundingDeadlineAt: parsed.data.fundingDeadlineAt }
        : {}),
      aiProvider: output.provider,
      aiModelId: output.modelId,
      aiFallbackUsed: output.provider === "deterministic-fallback",
    };
  }

  /**
   * Decline a Pending ProjectRequest as the seller. Terminal;
   * creates no Deal (GS 18).
   */
  async declineProjectRequest(input: DeclineProjectRequestInput): Promise<{
    readonly projectRequest: ProjectRequestPublicV1;
  }> {
    const useCase: RespondProjectRequestUseCase = (
      ctx: RespondProjectRequestUseCaseContext,
      tools: RespondProjectRequestUseCaseTools,
    ): RespondUseCaseOutcome => {
      const verdict = evaluateSellerAuthority(ctx.sellerAuthority);
      if (!verdict.ok) {
        return tools.reject("SELLER_NOT_AUTHORIZED");
      }
      return tools.decline({
        projectRequestId: ctx.projectRequest.id,
        sellerDecisionByUserId: input.userAccountId,
        now: this.now(),
      });
    };

    const result = await this.repository.respondToProjectRequestInTransaction(
      {
        projectRequestId: input.projectRequestId,
        actingWorkspaceId: input.actingWorkspaceId,
        userAccountId: input.userAccountId,
        now: this.now(),
      },
      useCase,
    );
    if (!result.ok) {
      throw this.decideErrorToServiceError(result.reason);
    }
    const declined = result.value as PersistedProjectRequest;
    return { projectRequest: toPublicProjectRequest(declined) };
  }

  /**
   * Fetch one ProjectRequest. Either side (buyer or seller
   * Workspace) may view it, but the application requires the
   * authenticated UserAccount to hold a current WorkspaceMembership
   * in the explicitly acting Workspace. A revoked former member
   * loses read access immediately; a non-member using a real
   * request id receives the same safe PROJECT_REQUEST_NOT_FOUND
   * envelope so the response contract never reveals whether the
   * record exists.
   */
  async getProjectRequest(input: GetProjectRequestInput): Promise<{
    readonly projectRequest: ProjectRequestPublicV1;
  }> {
    try {
      await this.authz.requireActingMembership({
        userAccountId: input.userAccountId,
        workspaceId: input.actingWorkspaceId,
      });
    } catch (err) {
      // Reads collapse ONLY the expected typed authorization
      // failures (NOT_A_MEMBER / WORKSPACE_INELIGIBLE /
      // MISSING_CAPABILITY / WORKSPACE_NOT_FOUND) to the same
      // PROJECT_REQUEST_NOT_FOUND envelope so the response
      // contract never reveals whether the record exists.
      // Unexpected repository / database / infrastructure errors
      // propagate so the route's safe 5xx path can surface them
      // — collapsing a real infra failure to NOT_FOUND would
      // falsely suggest the record does not exist and mask the
      // incident from operators.
      if (err instanceof AuthorizationError) {
        throw new ProjectRequestError("ProjectRequest not found.", "PROJECT_REQUEST_NOT_FOUND");
      }
      throw err;
    }
    const existing = await this.repository.findProjectRequestById(input.projectRequestId);
    if (!existing) {
      throw new ProjectRequestError("ProjectRequest not found.", "PROJECT_REQUEST_NOT_FOUND");
    }
    if (
      existing.buyerWorkspaceId !== input.actingWorkspaceId &&
      existing.sellerWorkspaceId !== input.actingWorkspaceId
    ) {
      throw new ProjectRequestError("ProjectRequest not found.", "PROJECT_REQUEST_NOT_FOUND");
    }
    return { projectRequest: toPublicProjectRequest(existing) };
  }

  /**
   * List ProjectRequests for an acting Workspace (both sides). The
   * application requires the authenticated UserAccount to hold a
   * current WorkspaceMembership in the explicitly acting
   * Workspace. A revoked former member loses list access immediately;
   * a non-member using a real Workspace id receives the same
   * PROJECT_REQUEST_NOT_FOUND envelope so the response contract
   * never reveals whether the request set exists. The route can
   * pass `statusFilter` to scope the inbox to Pending requests
   * only.
   */
  async listProjectRequests(input: ListProjectRequestsInput): Promise<{
    readonly projectRequests: readonly ProjectRequestPublicV1[];
  }> {
    try {
      await this.authz.requireActingMembership({
        userAccountId: input.userAccountId,
        workspaceId: input.actingWorkspaceId,
      });
    } catch (err) {
      // Same typed-only collapse as getProjectRequest so the safe
      // envelope does not leak the existence of the Workspace's
      // records. Unexpected infrastructure errors propagate.
      if (err instanceof AuthorizationError) {
        throw new ProjectRequestError("ProjectRequest not found.", "PROJECT_REQUEST_NOT_FOUND");
      }
      throw err;
    }
    const rows = await this.repository.listProjectRequests({
      workspaceId: input.actingWorkspaceId,
      ...(input.statusFilter ? { statusFilter: input.statusFilter } : {}),
    });
    return {
      projectRequests: rows.map(toPublicProjectRequest),
    };
  }

  private createFailureToServiceError(
    reason: CreateProjectRequestFailureReason,
  ): ProjectRequestError {
    switch (reason) {
      case "BUYER_NOT_AUTHORIZED":
        return new ProjectRequestError(
          "You are not authorized to create a ProjectRequest.",
          "PROJECT_REQUEST_FORBIDDEN",
        );
      case "SELLER_INELIGIBLE":
        return new ProjectRequestError(
          "The selected ServiceOffering is no longer eligible.",
          "PROJECT_REQUEST_OFFERING_INELIGIBLE",
        );
      case "BRIEF_NOT_FOUND":
        return new ProjectRequestError(
          "ProjectBrief not found.",
          "PROJECT_REQUEST_BRIEF_NOT_FOUND",
        );
      case "BRIEF_FORBIDDEN":
        return new ProjectRequestError(
          "ProjectBrief does not belong to this Workspace.",
          "PROJECT_REQUEST_BRIEF_FORBIDDEN",
        );
      case "OFFERING_NOT_IN_BRIEF":
        return new ProjectRequestError(
          "The selected ServiceOffering was not surfaced for this ProjectBrief.",
          "PROJECT_REQUEST_OFFERING_INELIGIBLE",
        );
      case "ALREADY_PENDING":
        return new ProjectRequestError(
          "A Pending ProjectRequest already exists for this selection.",
          "PROJECT_REQUEST_ALREADY_PENDING",
        );
      case "CONCURRENCY_RETRY_EXHAUSTED":
        // Bounded P2034 retry budget exhausted in the Prisma
        // adapter. Surface as the marketplace-busy transient
        // envelope (503) rather than masking it as an offering
        // ineligibility — the buyer / seller can retry the same
        // payload once the marketplace is free again.
        return new ProjectRequestError(
          "The marketplace is busy; please retry.",
          "PROJECT_REQUEST_UNAVAILABLE",
        );
    }
  }

  private decideErrorToServiceError(reason: DecideFailureReason): ProjectRequestError {
    switch (reason) {
      case "NOT_FOUND":
        return new ProjectRequestError("ProjectRequest not found.", "PROJECT_REQUEST_NOT_FOUND");
      case "SELLER_NOT_AUTHORIZED":
        return new ProjectRequestError(
          "You are not authorized to respond to this ProjectRequest.",
          "PROJECT_REQUEST_FORBIDDEN",
        );
      case "ALREADY_RESPONDED":
        return new ProjectRequestError(
          "This ProjectRequest has already been responded to.",
          "PROJECT_REQUEST_ALREADY_RESPONDED",
        );
      case "CONCURRENCY_RETRY_EXHAUSTED":
        // Bounded P2034 retry budget exhausted in the Prisma
        // adapter. Surface as the marketplace-busy transient
        // envelope (503) so the seller can retry the same
        // accept/decline payload once the marketplace is free
        // again, rather than masking it as an already-responded
        // state.
        return new ProjectRequestError(
          "The marketplace is busy; please retry.",
          "PROJECT_REQUEST_UNAVAILABLE",
        );
    }
  }
}

// ---------- application-owned use-case evaluators ----------

function evaluateCreateUseCase(
  ctx: CreateProjectRequestUseCaseContext,
  tools: CreateProjectRequestUseCaseTools,
  input: CreateProjectRequestInput,
): CreateUseCaseOutcome {
  // Step 1: brief recommendation boundary. Existence + ownership
  // + Matchmaker provenance must all hold before we evaluate
  // authority (matches the documented priority so a buyer cannot
  // probe authority against a brief they do not own).
  const briefVerdict = evaluateBriefRecommendationBoundary(
    ctx.briefRecommendations,
    input.serviceOfferingId,
    input.actingWorkspaceId,
  );
  if (!briefVerdict.ok) {
    if (briefVerdict.reason === "BRIEF_NOT_FOUND") {
      return tools.reject("BRIEF_NOT_FOUND");
    }
    if (briefVerdict.reason === "BRIEF_FORBIDDEN") {
      return tools.reject("BRIEF_FORBIDDEN");
    }
    return tools.reject("OFFERING_NOT_IN_BRIEF");
  }

  // Step 2: buyer authority. The repository already loaded +
  // locked the buyer Workspace / membership / capability rows.
  const buyerVerdict = evaluateBuyerAuthority(ctx.buyerAuthority);
  if (!buyerVerdict.ok) {
    return tools.reject("BUYER_NOT_AUTHORIZED");
  }

  // Step 3: complete seller / offering eligibility. The repository
  // already loaded + locked the seller Workspace / membership /
  // capability rows, the SellerProfile, and the ServiceOffering.
  const sellerVerdict = evaluateSellerEligibility(ctx.sellerEligibility);
  if (!sellerVerdict.ok) {
    return tools.reject("SELLER_INELIGIBLE");
  }

  // All checks pass. Persist the Pending ProjectRequest with the
  // seller Workspace id the snapshot surfaced (no second read
  // required).
  return tools.persist({
    userAccountId: input.userAccountId,
    buyerWorkspaceId: input.actingWorkspaceId,
    sellerWorkspaceId: sellerVerdict.sellerWorkspaceId,
    projectBriefId: input.projectBriefId,
    serviceOfferingId: input.serviceOfferingId,
  });
}

// ---------- DTO mapping ----------

export function toPublicProjectRequest(persisted: PersistedProjectRequest): ProjectRequestPublicV1 {
  // Private human-actor identifiers are intentionally omitted from
  // the counterparty-visible surface. The persisted columns remain
  // in PostgreSQL as audit evidence (and are available to internal
  // / separately-authorized audit presentations), but they MUST
  // NOT cross this public DTO. See projectRequestPublicV1Schema
  // for the allow-list contract.
  //
  // Display-only context (buyer Workspace name, seller Workspace
  // name, ServiceOffering title, brief excerpt) is included so the
  // seller inbox (and the symmetric buyer audit view) can render
  // human-readable context instead of raw internal ids. These
  // fields are populated by the repository's read paths; the
  // transactional create / accept / decline paths leave them null
  // because the UI immediately re-lists and re-renders.
  return {
    projectRequestId: persisted.id,
    buyerWorkspaceId: persisted.buyerWorkspaceId,
    sellerWorkspaceId: persisted.sellerWorkspaceId,
    serviceOfferingId: persisted.serviceOfferingId,
    projectBriefId: persisted.projectBriefId,
    status: persisted.status,
    sellerDecisionAt: persisted.sellerDecisionAt ? persisted.sellerDecisionAt.toISOString() : null,
    sellerConsentAt: persisted.sellerConsentAt ? persisted.sellerConsentAt.toISOString() : null,
    createdAt: persisted.createdAt.toISOString(),
    buyerWorkspaceName: persisted.buyerWorkspaceName,
    sellerWorkspaceName: persisted.sellerWorkspaceName,
    serviceOfferingTitle: persisted.serviceOfferingTitle,
    briefExcerpt: persisted.briefExcerpt,
  };
}

export function toPublicDeal(persisted: PersistedDeal): DealPublicV1 {
  return {
    dealId: persisted.id,
    buyerWorkspaceId: persisted.buyerWorkspaceId,
    sellerWorkspaceId: persisted.sellerWorkspaceId,
    serviceOfferingId: persisted.serviceOfferingId,
    projectBriefId: persisted.projectBriefId,
    projectRequestId: persisted.projectRequestId,
    status: persisted.status,
    activatedAt: persisted.activatedAt ? persisted.activatedAt.toISOString() : null,
    createdAt: persisted.createdAt.toISOString(),
  };
}

/**
 * Map the persisted TermsVersion row to the strict allow-listed
 * public DTO. Mirrors `toPublicTermsVersion` in
 * `apps/api/src/deal-terms/deal-terms.service.ts` so the accept
 * response and the Deal view return identical shapes.
 */
export function toPublicInitialTermsVersion(
  persisted: PersistedTermsVersion,
  isCurrent: boolean,
): Bg5TermsVersionPublicV1 {
  const deliverables = persisted.deliverablesJson as Array<{
    title: string;
    description: string;
  }>;
  const schedule = persisted.scheduleJson as InitialTermsVersionDraft["schedule"];
  return {
    termsVersionId: persisted.id,
    dealId: persisted.dealId,
    version: persisted.version,
    scope: persisted.scope,
    deliverables,
    schedule,
    price: { amountMinor: persisted.priceAmountMinor, currency: "USD" },
    revisionAllowance: persisted.revisionAllowance,
    rightsSummary: persisted.rightsSummary,
    fundingDeadlineAt: persisted.fundingDeadlineAt
      ? persisted.fundingDeadlineAt.toISOString()
      : null,
    aiProvider: persisted.aiProvider as Bg5TermsVersionPublicV1["aiProvider"],
    aiModelId: persisted.aiModelId,
    aiFallbackUsed: persisted.aiFallbackUsed,
    aiDraftedUnapprovedBadge: true,
    draftedAt: persisted.draftedAt.toISOString(),
    createdAt: persisted.createdAt.toISOString(),
    isCurrentVersion: isCurrent,
  };
}

// Allow the route to consume the request type directly so the
// import graph stays small.
export type { CreateProjectRequestRequestV1 };
// Allow the ProjectBriefRepository type to be re-imported from
// this module so the route file does not need to know its path.
export type { PersistedBrief };
export type {
  CreateProjectRequestResult,
  CreateProjectRequestFailureReason,
  DecideResult,
  DecideFailureReason,
};
