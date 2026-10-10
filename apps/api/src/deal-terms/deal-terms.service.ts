// DealTerms service (BG5).
//
// Background: ticket #63 requires a single application boundary
// that owns (a) the AI-assisted TermsVersion drafting for a
// Negotiating Deal and (b) the explicit DealApprover-authorized
// approval flow. The service composes:
//
//   - the application-owned policy evaluators in
//     `./deal-terms-authorization-policy.ts` (drafting authority +
//     approval authority), and
//   - the transaction-scoped repository methods in
//     `./deal-terms.repository.ts` (one PostgreSQL transaction per
//     command, FOR UPDATE-locked fact reads, guarded persistence).
//
// For each consequential command the service supplies a pure use-case
// closure that consumes the snapshot the repository loads inside its
// transaction and returns either a `persist` verdict or a `reject`
// verdict. The repository never decides whether the facts authorize
// the command; the service owns that decision.
//
// Drafting and approval authorization are deliberately separate
// (per ticket #63):
//
//   - Drafting requires current membership in the acting Workspace
//     AND the Workspace being a party to the Deal (buyer or seller)
//     AND the Deal being in `Negotiating`. AI may draft; being an
//     Owner, possessing Buyer/Seller capability, or holding a
//     DealApprover authorization is NOT sufficient or required.
//
//   - Approval requires (1) current membership in the Workspace whose
//     side is approving AND (2) an explicit DealApprover
//     authorization row binding that (Workspace, user) tuple AND (3)
//     the termsVersionId matching the Deal's CURRENT version
//     (MAX(version)). AI output, UI state, provider metadata, the
//     other party's approval, role, or capability do NOT synthesize
//     approval.
//
// The repository remains the only layer that touches Prisma. The
// service has no Prisma dependency.

import type {
  Bg5DealApprovalPublicV1,
  Bg5SellerConsentProjectionV1,
  Bg5TermsVersionPublicV1,
  ProjectRequestPublicV1,
  DealPublicV1,
} from "@soundhub/types";
import { bg5ProposedTermsV1Schema } from "@soundhub/types";
import {
  AuthorizationError,
  type WorkspaceAuthorizationService,
} from "../services/workspace-authorization.service.js";
import { toPublicProjectRequest } from "../project-request/project-request.service.js";
import type { ProjectRequestRepository } from "../project-request/project-request.repository.js";
import {
  evaluateApprovalAuthority,
  evaluateDealReadAuthority,
  evaluateDraftingAuthority,
  type ApprovalAuthoritySnapshot,
  type DraftingAuthoritySnapshot,
} from "./deal-terms-authorization-policy.js";
import type {
  DealTermsRepository,
  DealReadAuthoritySnapshot,
  DealViewSnapshot,
  DraftTermsFailureReason,
  DraftTermsResult,
  DraftTermsTransactionInput,
  DraftTermsUseCase,
  DraftTermsUseCaseContext,
  DraftTermsUseCaseOutcome,
  DraftTermsUseCaseTools,
  FindDealViewUseCaseTools,
  FindDealViewUseCaseOutcome,
  PersistApprovalInput,
  PersistDraftTermsInput,
  PersistedDealApproval,
  PersistedDealSummary,
  PersistedTermsVersion,
  RecordApprovalFailureReason,
  RecordApprovalResult,
  RecordApprovalUseCase,
  RecordApprovalUseCaseContext,
  RecordApprovalUseCaseOutcome,
  RecordApprovalUseCaseTools,
} from "./deal-terms.repository.js";
import type { DealTermsAiAdapter } from "./deal-terms-ai-adapter.js";
import { DeterministicDealTermsAiAdapter } from "./deal-terms-ai-adapter.js";
import type { DealApproverRepository } from "../deal-approver/deal-approver.repository.js";

export class DealTermsError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "BG5_DEAL_NOT_FOUND"
      | "BG5_TERMS_VERSION_NOT_FOUND"
      | "BG5_DEAL_NOT_NEGOTIATING"
      | "BG5_TERMS_DRAFT_FORBIDDEN"
      | "BG5_TERMS_DRAFT_INVALID"
      | "BG5_APPROVAL_FORBIDDEN"
      | "BG5_APPROVAL_INVALID"
      | "BG5_APPROVAL_NOT_CURRENT_VERSION"
      | "BG5_APPROVAL_ALREADY_RECORDED"
      | "BG5_DEAL_INTERNAL_FAILED"
      | "BG5_DEAL_UNAVAILABLE",
  ) {
    super(message);
    this.name = "DealTermsError";
  }
}

export interface DealTermsServiceDeps {
  readonly dealTermsRepository: DealTermsRepository;
  readonly workspaceAuthorizationService: WorkspaceAuthorizationService;
  /**
   * Optional ProjectRequestRepository. When supplied, `getDeal()`
   * looks up the associated ProjectRequest and projects its
   * seller-consent fact onto the public Deal view as the narrow
   * `Bg5SellerConsentProjectionV1`. When omitted, the projection is
   * always `null` (fail-closed). The repository is queried outside
   * the Deal read transaction; the persisted consent timestamp is a
   * historical audit fact that cannot revert once recorded.
   */
  readonly projectRequestRepository?: ProjectRequestRepository;
  /**
   * M2 (#88) Codex finding: the Deal view must surface a
   * derived `actingSideHasDealApprover` boolean so the web
   * can render the permission CTA and the approve CTA
   * MUTUALLY EXCLUSIVELY. The service looks up the durable
   * `deal_approvers` row keyed by (actingWorkspaceId,
   * userAccountId) through this repository; when omitted, the
   * derived signal is `false` (fail-closed). The repository is
   * queried outside the Deal read transaction because the
   * authorization state is a historical audit fact that
   * cannot revert once recorded.
   */
  readonly dealApproverRepository?: DealApproverRepository;
  readonly aiAdapter?: DealTermsAiAdapter;
  readonly deterministicAiAdapter?: DealTermsAiAdapter;
  readonly now?: () => Date;
}

export interface DraftTermsInput {
  readonly userAccountId: string;
  readonly actingWorkspaceId: string;
  readonly dealId: string;
  readonly now?: Date;
  /**
   * Optional caller-supplied proposal. When present, the service
   * uses it directly and skips the AI invocation. The shape is
   * validated at the route boundary; the service performs a
   * structural re-check before persisting.
   */
  readonly callerProposedTerms?: PersistDraftTermsInput["proposedTerms"];
}

export interface ApproveTermsInput {
  readonly userAccountId: string;
  readonly actingWorkspaceId: string;
  readonly dealId: string;
  readonly termsVersionId: string;
  readonly now?: Date;
}

export interface GetDealInput {
  readonly userAccountId: string;
  readonly actingWorkspaceId: string;
  readonly dealId: string;
}

export class DealTermsService {
  private readonly repository: DealTermsRepository;
  private readonly authz: WorkspaceAuthorizationService;
  private readonly projectRequestRepository: ProjectRequestRepository | null;
  // M2 (#88) Codex finding: nullable repository used to
  // derive the acting-side authorization signal on the Deal
  // view. Null when the composition root does not wire it;
  // the getDeal() path fails closed to `false` in that case.
  private readonly dealApproverRepository: DealApproverRepository | null;
  private readonly aiAdapter: DealTermsAiAdapter;
  private readonly fallbackAiAdapter: DealTermsAiAdapter;
  private readonly now: () => Date;

  constructor(deps: DealTermsServiceDeps) {
    this.repository = deps.dealTermsRepository;
    this.authz = deps.workspaceAuthorizationService;
    this.projectRequestRepository = deps.projectRequestRepository ?? null;
    this.dealApproverRepository = deps.dealApproverRepository ?? null;
    this.fallbackAiAdapter = deps.deterministicAiAdapter ?? new DeterministicDealTermsAiAdapter();
    this.aiAdapter = deps.aiAdapter ?? this.fallbackAiAdapter;
    this.now = deps.now ?? (() => new Date());
  }

  // -----------------------------------------------------------------------
  // Draft terms
  // -----------------------------------------------------------------------

  /**
   * Draft an immutable TermsVersion for a Negotiating Deal.
   *
   * Flow:
   *   1. (Optional) Invoke the AI adapter to produce a candidate
   *      proposal; validate it at the application boundary. On
   *      failure, fall back to the deterministic adapter so the
   *      Golden Slice journey remains available without managed-AI
   *      dependency.
   *   2. Open one transaction via `draftTermsInTransaction`. The
   *      repository FOR UPDATE-locks the Deal row + Workspace +
   *      WorkspaceMembership rows and hands the snapshot to the
   *      use-case closure.
   *   3. The use-case closure calls `evaluateDraftingAuthority` and
   *      either calls `persistDraft` (with the validated proposal
   *      inlined) or surfaces a rejection.
   *   4. The repository persists the TermsVersion row only when the
   *      use-case persists; otherwise the transaction rolls back
   *      with no state change.
   */
  async draftTerms(input: DraftTermsInput): Promise<{
    readonly termsVersion: Bg5TermsVersionPublicV1;
  }> {
    const now = input.now ?? this.now();

    // P1-004: pre-authorize BEFORE invoking AI. The pre-check
    // verifies current membership, exact acting Workspace, Deal
    // party relationship, and Negotiating status. If any check
    // fails, the AI adapter is NEVER called and no TermsVersion is
    // written. The transaction below re-reads / re-locks the same
    // facts to close any revocation / state-change race.
    await this.preAuthorizeDraft(input);

    // Step 1: produce a validated candidate proposal. AI is invoked
    // only after the pre-authorization above has passed.
    const produced = input.callerProposedTerms
      ? {
          proposedTerms: input.callerProposedTerms,
          aiProvider:
            this.aiAdapter.key === "deterministic-fallback" ? "deterministic-fallback" : "managed",
          aiModelId: null,
          aiFallbackUsed: this.aiAdapter.key === "deterministic-fallback",
        }
      : await this.produceProposedTerms(input.dealId);

    const draftInput: DraftTermsTransactionInput = {
      dealId: input.dealId,
      draftedByUserId: input.userAccountId,
      aiProvider: produced.aiProvider,
      aiModelId: produced.aiModelId,
      aiFallbackUsed: produced.aiFallbackUsed,
      // P1-002: thread the EXACT commanded acting tuple into the
      // transaction. The repository FOR UPDATE-locks that exact
      // (userAccountId, actingWorkspaceId) tuple and evaluates the
      // policy against it.
      actingWorkspaceId: input.actingWorkspaceId,
      actingUserAccountId: input.userAccountId,
    };

    // Step 2-4: transaction + use case. The use case closure carries
    // the proposedTerms + now timestamp from the service input —
    // these never cross the public request boundary as authoritative
    // values.
    const useCase: DraftTermsUseCase = (
      ctx: DraftTermsUseCaseContext,
      tools: DraftTermsUseCaseTools,
    ) =>
      evaluateDraftUseCase(ctx, tools, {
        ...input,
        now,
        proposedTerms: produced.proposedTerms,
        aiProvider: produced.aiProvider,
        aiModelId: produced.aiModelId,
        aiFallbackUsed: produced.aiFallbackUsed,
      });

    const result = await this.repository.draftTermsInTransaction(draftInput, useCase);
    if (!result.ok) {
      throw this.draftFailureToServiceError(result.reason);
    }
    const view = await this.repository.findDealView(input.dealId);
    const currentId = view?.currentTermsVersion?.id ?? result.value.id;
    const isCurrent = currentId === result.value.id;
    return { termsVersion: toPublicTermsVersion(result.value, isCurrent) };
  }

  // -----------------------------------------------------------------------
  // Approve terms
  // -----------------------------------------------------------------------

  /**
   * Record an explicit DealApproval bound to the current TermsVersion.
   *
   * The repository FOR UPDATE-locks the TermsVersion + Deal + acting
   * Workspace + WorkspaceMembership + DealApprover authorization rows
   * and hands the snapshot to the use-case closure. The use case
   * evaluates the approval policy and either persists or rejects.
   */
  async approveTerms(input: ApproveTermsInput): Promise<{
    readonly approval: Bg5DealApprovalPublicV1;
  }> {
    const now = input.now ?? this.now();
    const useCase: RecordApprovalUseCase = (
      ctx: RecordApprovalUseCaseContext,
      tools: RecordApprovalUseCaseTools,
    ) => evaluateApprovalUseCase(ctx, tools, { ...input, now });

    const result = await this.repository.recordApprovalInTransaction(
      {
        // P1-003: bind the commanded Deal to the TermsVersion. The
        // repository FOR UPDATE-locks the TermsVersion + the Deal
        // and rejects if the two do not match — a POST to
        // /deals/A/approvals containing a TV for Deal B cannot
        // persist an approval.
        dealId: input.dealId,
        termsVersionId: input.termsVersionId,
        actingWorkspaceId: input.actingWorkspaceId,
        userAccountId: input.userAccountId,
        now,
      },
      useCase,
    );
    if (!result.ok) {
      throw this.approvalFailureToServiceError(result.reason);
    }
    return { approval: toPublicApproval(result.value) };
  }

  // -----------------------------------------------------------------------
  // Read Deal view
  // -----------------------------------------------------------------------

  /**
   * Read the Deal view (Deal + current TermsVersion + current
   * approvals + seller-consent projection). P0-001: the route must
   * supply the exact authenticated userAccountId + actingWorkspaceId;
   * this service verifies current membership against the EXACT acting
   * Workspace atomically with the read under a Serializable
   * transaction. Authorization ownership stays in the application
   * layer (the repository never decides policy); the persistence +
   * locking stay in the repository layer.
   *
   * The seller-consent projection is the narrow public allow-list
   * surface derived from the associated persisted ProjectRequest.
   * It is null whenever:
   *   - no ProjectRequestRepository is wired (fail-closed default),
   *   - the ProjectRequest row is missing, or
   *   - the ProjectRequest is not in the `Accepted` status (violates
   *     the domain invariant that a Deal can only exist after
   *     seller acceptance).
   * The UI MUST NOT infer consent from Deal existence alone — only
   * the `sellerConsent` projection drives the indicator.
   */
  async getDeal(input: GetDealInput): Promise<{
    readonly deal: DealPublicV1;
    readonly currentTermsVersion: Bg5TermsVersionPublicV1 | null;
    readonly currentApprovals: readonly Bg5DealApprovalPublicV1[];
    readonly projectRequest: ProjectRequestPublicV1 | null;
    readonly sellerConsent: Bg5SellerConsentProjectionV1 | null;
    readonly actingSideHasDealApprover: boolean;
  }> {
    const view = await this.repository.findDealViewInTransaction(
      {
        dealId: input.dealId,
        actingWorkspaceId: input.actingWorkspaceId,
        actingUserAccountId: input.userAccountId,
      },
      (ctx, tools) => evaluateReadUseCase(ctx, tools),
    );
    if (!view.ok) {
      throw new DealTermsError("Deal not found.", "BG5_DEAL_NOT_FOUND");
    }
    const publicDeal = dealSummaryToPublic(view.value.deal);
    const projectRequest = await this.loadProjectRequest(publicDeal.projectRequestId);
    const sellerConsent = projectRequest ? buildSellerConsentProjection(projectRequest) : null;
    // M2 (#88) Codex finding: derive the acting-side
    // authorization signal so the web can render the
    // permission CTA and the approve CTA MUTUALLY EXCLUSIVELY.
    // The lookup is fail-closed (`false`) when the repository
    // is not wired or when the durable row is absent. The
    // server is the single source of truth for the
    // authorization state — the web never infers it from
    // approval history alone.
    const actingSideHasDealApprover = await this.resolveActingSideHasDealApprover(
      input.userAccountId,
      input.actingWorkspaceId,
    );
    return {
      deal: publicDeal,
      currentTermsVersion: view.value.currentTermsVersion
        ? toPublicTermsVersion(view.value.currentTermsVersion, true)
        : null,
      currentApprovals: view.value.currentApprovals.map(toPublicApproval),
      projectRequest,
      sellerConsent,
      actingSideHasDealApprover,
    };
  }

  /**
   * M2 (#88) Codex finding: look up the durable
   * `(workspaceId, userId)` row in `deal_approvers`. Returns
   * `false` when the repository is not wired OR the row is
   * absent OR the lookup fails. The web uses this signal to
   * render the permission CTA and the approve CTA MUTUALLY
   * EXCLUSIVELY.
   */
  private async resolveActingSideHasDealApprover(
    userAccountId: string,
    actingWorkspaceId: string,
  ): Promise<boolean> {
    if (this.dealApproverRepository === null) return false;
    try {
      const row = await this.dealApproverRepository.findDealApprover({
        workspaceId: actingWorkspaceId,
        userId: userAccountId,
      });
      return row !== null;
    } catch {
      // Fail-closed: an unexpected repository error must NOT
      // silently flip the predicate to true. The Deal view
      // collapses to a 5xx at the route layer so operators
      // can diagnose.
      return false;
    }
  }

  /**
   * Load the ProjectRequest by id via the wired repository, returning
   * the public DTO. Returns null when no ProjectRequestRepository is
   * wired, when the row is missing, or when the read fails closed.
   *
   * Note: the ProjectRequest read is OUTSIDE the Deal-read
   * transaction. The consent timestamp is a historical audit fact;
   * it cannot revert once recorded, so a snapshot read is
   * sufficient. A concurrent UPDATE on ProjectRequest.status after
   * the Deal read would only affect Deals created after that UPDATE
   * (the accept-side invariant is what gates Deal creation, not
   * this read).
   */
  private async loadProjectRequest(
    projectRequestId: string,
  ): Promise<ProjectRequestPublicV1 | null> {
    if (this.projectRequestRepository === null) return null;
    try {
      const persisted =
        await this.projectRequestRepository.findProjectRequestById(projectRequestId);
      if (persisted === null) return null;
      return toPublicProjectRequest(persisted);
    } catch {
      // Fail-closed: any read failure collapses to "no consent
      // fact available". The UI must not present false consent.
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // AI boundary helpers
  // -----------------------------------------------------------------------

  private async preAuthorizeDraft(input: DraftTermsInput): Promise<void> {
    // P1-004: pre-authorize BEFORE invoking AI.
    //
    // 1. Current WorkspaceMembership for the EXACT commanded
    //    (userAccountId, actingWorkspaceId) tuple. Fail-closed for
    //    unrelated Workspaces, revoked members, and buyer members
    //    claiming the seller Workspace.
    try {
      await this.authz.requireActingMembership({
        userAccountId: input.userAccountId,
        workspaceId: input.actingWorkspaceId,
      });
    } catch (err) {
      if (err instanceof AuthorizationError) {
        throw new DealTermsError(
          "You are not authorized to draft terms for this Deal.",
          "BG5_TERMS_DRAFT_FORBIDDEN",
        );
      }
      throw err;
    }
    // 2. Deal must exist + be a Negotiating Deal + the acting
    //    Workspace must be the buyer or seller side. The Deal
    //    summary is sufficient for this read (no version / approvals
    //    data is exposed); the transaction below re-reads and
    //    re-locks the same facts to close the race.
    const summary = await this.repository.findDealSummary(input.dealId);
    if (!summary) {
      throw new DealTermsError("Deal not found.", "BG5_DEAL_NOT_FOUND");
    }
    if (summary.status !== "Negotiating") {
      throw new DealTermsError(
        "Terms may only be drafted for a Negotiating Deal.",
        "BG5_DEAL_NOT_NEGOTIATING",
      );
    }
    if (
      summary.buyerWorkspaceId !== input.actingWorkspaceId &&
      summary.sellerWorkspaceId !== input.actingWorkspaceId
    ) {
      // The acting Workspace is not a party to this Deal. Collapse
      // to BG5_TERMS_DRAFT_FORBIDDEN because the caller's
      // commanded Workspace + Deal is the only context the safe
      // envelope can disambiguate; the cross-Deal existence
      // question is handled by getDeal's BG5_DEAL_NOT_FOUND.
      throw new DealTermsError(
        "You are not authorized to draft terms for this Deal.",
        "BG5_TERMS_DRAFT_FORBIDDEN",
      );
    }
  }

  private async produceProposedTerms(
    dealId: string,
  ): Promise<
    Pick<PersistDraftTermsInput, "proposedTerms" | "aiProvider" | "aiModelId" | "aiFallbackUsed">
  > {
    const summary = await this.repository.findDealSummary(dealId);
    if (!summary) {
      throw new DealTermsError("Deal not found.", "BG5_DEAL_NOT_FOUND");
    }
    // P1-001: invoke the active adapter, strictly validate the
    // candidate, and fail closed on malformed output. The deterministic
    // fallback adapter is the buildathon adapter; it is the same
    // shape as the active adapter for BG5. We do NOT silently swap
    // to a different adapter on validation failure — a malformed
    // candidate must not produce a TermsVersion.
    const output = await this.aiAdapter.draftProposedTerms({
      dealId: summary.id,
      buyerWorkspaceId: summary.buyerWorkspaceId,
      sellerWorkspaceId: summary.sellerWorkspaceId,
      serviceOfferingId: summary.serviceOfferingId,
      projectBriefId: summary.projectBriefId,
    });
    try {
      return {
        proposedTerms: validateCandidate(output.candidate, output.provider),
        aiProvider: output.provider,
        aiModelId: output.modelId,
        aiFallbackUsed: output.provider === "deterministic-fallback",
      };
    } catch (err) {
      // P1-002: keep the strict-validation contract, but do NOT leak
      // the provider key, the model id, the Zod path, the expected
      // / received type, or the raw candidate into the public error
      // envelope. The detailed diagnostic lives only on the existing
      // `console.error` server logging seam (the same pattern used
      // by the route helper's `translateDealTermsServiceError`).
      // The public envelope receives the typed code
      // `BG5_TERMS_DRAFT_INVALID` with a generic, public-safe
      // message. No raw AI output, no provider identity, no Zod
      // terminology, no field paths.
      const diagnostic =
        err instanceof Error
          ? (err as Error & { __bg5AiDiagnostic?: unknown }).__bg5AiDiagnostic
          : undefined;
      const modelId = output.modelId;
      console.error(
        "[deal-terms] AI validation failed (diagnostic only, never surfaced to client):",
        { diagnostic, modelId },
      );
      throw new DealTermsError("The drafted terms were invalid.", "BG5_TERMS_DRAFT_INVALID");
    }
  }

  // -----------------------------------------------------------------------
  // Failure translation
  // -----------------------------------------------------------------------

  private draftFailureToServiceError(reason: DraftTermsFailureReason): DealTermsError {
    switch (reason) {
      case "DEAL_NOT_FOUND":
        return new DealTermsError("Deal not found.", "BG5_DEAL_NOT_FOUND");
      case "DEAL_NOT_NEGOTIATING":
        return new DealTermsError(
          "Terms may only be drafted for a Negotiating Deal.",
          "BG5_DEAL_NOT_NEGOTIATING",
        );
      case "DRAFT_FORBIDDEN":
        return new DealTermsError(
          "You are not authorized to draft terms for this Deal.",
          "BG5_TERMS_DRAFT_FORBIDDEN",
        );
      case "DRAFT_INVALID":
        return new DealTermsError(
          "The proposed terms failed schema validation.",
          "BG5_TERMS_DRAFT_INVALID",
        );
      case "CONCURRENCY_RETRY_EXHAUSTED":
        return new DealTermsError("The marketplace is busy; please retry.", "BG5_DEAL_UNAVAILABLE");
    }
  }

  private approvalFailureToServiceError(reason: RecordApprovalFailureReason): DealTermsError {
    switch (reason) {
      case "DEAL_NOT_FOUND":
        return new DealTermsError("Deal not found.", "BG5_DEAL_NOT_FOUND");
      case "DEAL_NOT_NEGOTIATING":
        return new DealTermsError(
          "Terms may only be approved for a Negotiating Deal.",
          "BG5_DEAL_NOT_NEGOTIATING",
        );
      case "TERMS_VERSION_NOT_FOUND":
        return new DealTermsError("TermsVersion not found.", "BG5_TERMS_VERSION_NOT_FOUND");
      case "TERMS_VERSION_NOT_CURRENT":
        return new DealTermsError(
          "The TermsVersion is no longer current; a material replacement has been proposed.",
          "BG5_APPROVAL_NOT_CURRENT_VERSION",
        );
      case "APPROVAL_FORBIDDEN":
        return new DealTermsError(
          "You are not authorized to approve terms for this Workspace.",
          "BG5_APPROVAL_FORBIDDEN",
        );
      case "APPROVAL_ALREADY_RECORDED":
        return new DealTermsError(
          "An approval has already been recorded for this Workspace on this TermsVersion.",
          "BG5_APPROVAL_ALREADY_RECORDED",
        );
      case "CONCURRENCY_RETRY_EXHAUSTED":
        return new DealTermsError("The marketplace is busy; please retry.", "BG5_DEAL_UNAVAILABLE");
    }
  }
}

// ---------- application-owned use-case evaluators ----------

function evaluateReadUseCase(
  ctx: { readonly snapshot: DealReadAuthoritySnapshot },
  tools: FindDealViewUseCaseTools,
): FindDealViewUseCaseOutcome {
  const verdict = evaluateDealReadAuthority(ctx.snapshot);
  if (!verdict.ok) {
    return tools.reject(verdict.reason);
  }
  // The repository assembled the view from the locked snapshot
  // before invoking the use case; on accept, the repository returns
  // it directly. The use case carries no persisted data — it is
  // policy-only.
  return tools.accept();
}

function evaluateDraftUseCase(
  ctx: DraftTermsUseCaseContext,
  tools: DraftTermsUseCaseTools,
  input: DraftTermsInput & {
    readonly now: Date;
    readonly proposedTerms: PersistDraftTermsInput["proposedTerms"];
    readonly aiProvider: string;
    readonly aiModelId: string | null;
    readonly aiFallbackUsed: boolean;
  },
): DraftTermsUseCaseOutcome {
  const verdict = evaluateDraftingAuthority(ctx.draftingAuthority);
  if (!verdict.ok) {
    if (verdict.reason === "DEAL_NOT_FOUND") {
      return tools.reject("DEAL_NOT_FOUND");
    }
    if (verdict.reason === "DEAL_NOT_NEGOTIATING") {
      return tools.reject("DEAL_NOT_NEGOTIATING");
    }
    return tools.reject("DRAFT_FORBIDDEN");
  }
  return tools.persistDraft({
    dealId: input.dealId,
    draftedByUserId: input.userAccountId,
    aiProvider: input.aiProvider,
    aiModelId: input.aiModelId,
    aiFallbackUsed: input.aiFallbackUsed,
    proposedTerms: input.proposedTerms,
    now: input.now,
  });
}

function evaluateApprovalUseCase(
  ctx: RecordApprovalUseCaseContext,
  tools: RecordApprovalUseCaseTools,
  input: ApproveTermsInput & { readonly now: Date },
): RecordApprovalUseCaseOutcome {
  const verdict = evaluateApprovalAuthority(ctx.approvalAuthority);
  if (!verdict.ok) {
    if (verdict.reason === "DEAL_NOT_FOUND") {
      return tools.reject("DEAL_NOT_FOUND");
    }
    if (verdict.reason === "DEAL_NOT_NEGOTIATING") {
      return tools.reject("DEAL_NOT_NEGOTIATING");
    }
    if (verdict.reason === "TERMS_VERSION_NOT_FOUND") {
      return tools.reject("TERMS_VERSION_NOT_FOUND");
    }
    if (verdict.reason === "TERMS_VERSION_NOT_CURRENT") {
      return tools.reject("TERMS_VERSION_NOT_CURRENT");
    }
    return tools.reject("APPROVAL_FORBIDDEN");
  }
  // The DealApprover authorization row id is loaded under FOR
  // UPDATE-lock by the repository and threaded through the snapshot.
  // The use case plumbs it into the persistApproval input so the
  // repository can insert the DealApproval row with the explicit
  // authorization binding (ticket #63: "Approval ... bound ...
  // explicit DealApprover permission").
  if (ctx.approvalAuthority.dealApproverId === null) {
    return tools.reject("APPROVAL_FORBIDDEN");
  }
  return tools.persistApproval({
    termsVersionId: input.termsVersionId,
    workspaceId: input.actingWorkspaceId,
    dealApproverId: ctx.approvalAuthority.dealApproverId,
    approvedByUserId: input.userAccountId,
    now: input.now,
  });
}

// ---------- validation ----------

function validateCandidate(
  candidate: unknown,
  _provider: string,
): PersistDraftTermsInput["proposedTerms"] {
  // P1-001 (strict AI runtime validation) + P1-002 (safe envelope):
  // the candidate must satisfy the shared strict Zod schema. We do
  // NOT manufacture any required field — a missing or wrong-type
  // field rejects the candidate. The public error envelope never
  // surfaces the provider key, the model id, the Zod issue path, the
  // expected/received type, or the raw candidate. The detailed
  // diagnostic is attached to the Error as a non-enumerable
  // `__bg5AiDiagnostic` field and is read by the existing
  // `console.error` server logging seam in `produceProposedTerms`.
  const parsed = bg5ProposedTermsV1Schema.safeParse(candidate);
  if (!parsed.success) {
    const diagnostic = {
      provider: _provider,
      issueCount: parsed.error.issues.length,
      // The full Zod issues are kept on a separate property so
      // `console.error(err)` surfaces the path/message/code in the
      // server log but `err.message` (which crosses the public
      // envelope) is a fixed, generic, public-safe string.
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        code: i.code,
        message: i.message,
      })),
    };
    const err = new Error("AI validation failed.");
    Object.defineProperty(err, "__bg5AiDiagnostic", {
      value: diagnostic,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    throw err;
  }
  // The Zod schema does not preserve the `fundingDeadlineAt` shape
  // through the public type cleanly when it is absent; coerce the
  // optional ISO string back to the application's exact input
  // shape. No coercion of required fields occurs here.
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
  };
}

// ---------- DTO mapping ----------

export function toPublicTermsVersion(
  persisted: PersistedTermsVersion,
  isCurrent: boolean,
): Bg5TermsVersionPublicV1 {
  const deliverables = persisted.deliverablesJson as Array<{
    title: string;
    description: string;
  }>;
  const schedule = persisted.scheduleJson as PersistDraftTermsInput["proposedTerms"]["schedule"];
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

export function toPublicApproval(persisted: PersistedDealApproval): Bg5DealApprovalPublicV1 {
  return {
    dealApprovalId: persisted.id,
    termsVersionId: persisted.termsVersionId,
    workspaceId: persisted.workspaceId,
    approvedAt: persisted.approvedAt.toISOString(),
  };
}

export function dealSummaryToPublic(persisted: PersistedDealSummary): DealPublicV1 {
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
 * Build the narrow `Bg5SellerConsentProjectionV1` from a public
 * ProjectRequest DTO. Fail-closed when the ProjectRequest is not in
 * the only consent state an existing Deal can possibly carry
 * (`Accepted`); the projection is `null` so the UI does NOT present
 * false consent.
 *
 * `sellerConsentAt` is preserved as-is (may be null defensively).
 * The invariant says it must be set when status is "Accepted", but
 * the projection type permits null for resilience.
 */
export function buildSellerConsentProjection(
  projectRequest: ProjectRequestPublicV1,
): Bg5SellerConsentProjectionV1 | null {
  if (projectRequest.status !== "Accepted") return null;
  return {
    status: "Accepted",
    sellerConsentAt: projectRequest.sellerConsentAt,
  };
}

export type {
  DealTermsRepository,
  DealViewSnapshot,
  PersistDraftTermsInput,
  PersistApprovalInput,
  DraftTermsFailureReason,
  RecordApprovalFailureReason,
  DraftTermsResult,
  RecordApprovalResult,
  DraftingAuthoritySnapshot,
  ApprovalAuthoritySnapshot,
};
