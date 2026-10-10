// In-memory ProjectRequestRepository for unit tests.
//
// Background: the ProjectRequest service tests run without a
// database. The in-memory adapter mirrors the Prisma adapter's
// contract surface so tests can substitute it without changing the
// service or route code.
//
// The Prisma adapter is the canonical implementation; this is for
// unit tests only.
//
// --- Guarantee parity (deliberately conservative) ---
//
// The in-memory adapter simulates PostgreSQL row locks with a
// per-test mutex so concurrent unit tests do not see stale
// authority facts. It does NOT replicate PostgreSQL's MVCC
// snapshots, serializable isolation, or row-level locking
// semantics. Any interleaving test that depends on real concurrency
// MUST run against the Prisma adapter (see
// `prisma-project-request.repository.test.ts`); the in-memory
// adapter is only sufficient for the service-level policy tests
// that exercise a single transaction at a time.

import { randomUUID } from "node:crypto";
import type {
  AcceptProjectRequestResult,
  CreateProjectRequestResult,
  CreateProjectRequestTransactionInput,
  CreateProjectRequestUseCase,
  CreateProjectRequestUseCaseTools,
  CreateUseCaseOutcome,
  DecideResult,
  PersistedDeal,
  PersistedProjectRequest,
  PersistedTermsVersion,
  ProjectRequestRepository,
  RespondProjectRequestTransactionInput,
  RespondProjectRequestUseCase,
  RespondProjectRequestUseCaseTools,
  RespondUseCaseOutcome,
} from "./project-request.repository.js";
import type {
  BriefRecommendationsSnapshot,
  BuyerAuthoritySnapshot,
  SellerAuthoritySnapshot,
  SellerEligibilitySnapshot,
} from "./project-request-authorization-policy.js";
import type { ProjectRequestStatusV1 } from "@soundhub/types";

export interface MembershipSnapshotSeed {
  readonly userId: string;
  readonly workspaceId: string;
}

export interface SellerProfileSnapshotSeed {
  readonly workspaceId: string;
  readonly status: "Draft" | "Published" | "Suspended";
}

export interface ServiceOfferingSnapshotSeed {
  readonly id: string;
  readonly sellerWorkspaceId: string;
  readonly status: "Active" | "Draft" | "Paused" | "Archived";
  // Display-only context for the seller inbox (and the symmetric
  // buyer audit view). Mirrors the same-named fields on the public
  // DTO. Optional; null when the test fixture does not seed a
  // title.
  readonly title?: string;
}

export interface ProjectBriefSnapshotSeed {
  readonly id: string;
  readonly buyerWorkspaceId: string;
  readonly recommendedOfferingIds: readonly string[];
  // Display-only excerpt for the seller inbox. Optional; null when
  // the test fixture does not seed a brief excerpt.
  readonly originalText?: string;
}

export interface WorkspaceSnapshotSeed {
  readonly workspaceId: string;
  readonly status: "Active" | "Suspended";
  readonly ownerUserId: string;
  readonly buyerCapability: boolean;
  readonly sellerCapability: boolean;
  // Display-only name for the seller inbox. Optional; null when the
  // test fixture does not seed a workspace name.
  readonly name?: string;
}

export class InMemoryProjectRequestRepository implements ProjectRequestRepository {
  private readonly requests = new Map<string, PersistedProjectRequest>();
  private readonly deals = new Map<string, PersistedDeal>();
  /**
   * M2 (#88): in-memory TermsVersion map mirroring the (dealId, version)
   * uniqueness and persistence shape the Prisma adapter enforces.
   * The accept transaction seeds one v1 row per Deal on the same
   * logical commit as the Deal itself.
   */
  private readonly termsVersions = new Map<string, PersistedTermsVersion>();
  private readonly workspaces = new Map<string, WorkspaceSnapshotSeed>();
  private readonly memberships = new Map<string, MembershipSnapshotSeed>();
  private readonly sellerProfiles = new Map<string, SellerProfileSnapshotSeed>();
  private readonly offerings = new Map<string, ServiceOfferingSnapshotSeed>();
  private readonly briefs = new Map<string, ProjectBriefSnapshotSeed>();
  /** Single-flight mutex so a single in-memory test cannot interleave
   *  authority mutations with a running use case. This is NOT a
   *  guarantee that real concurrency cannot occur — only a guarantee
   *  that a single test cannot observe a state mid-mutation. The
   *  Prisma adapter is the only authoritative interleaving surface. */
  private inflight = false;

  constructor() {
    this.workspaces = new Map();
    this.memberships = new Map();
    this.sellerProfiles = new Map();
    this.offerings = new Map();
    this.briefs = new Map();
  }

  // ---------- test seams ----------

  seedWorkspace(input: WorkspaceSnapshotSeed): void {
    this.workspaces.set(input.workspaceId, input);
  }

  seedMembership(input: MembershipSnapshotSeed): void {
    this.memberships.set(this.membershipKey(input.userId, input.workspaceId), input);
  }

  removeMembership(userId: string, workspaceId: string): void {
    this.memberships.delete(this.membershipKey(userId, workspaceId));
  }

  seedSellerProfile(input: SellerProfileSnapshotSeed): void {
    this.sellerProfiles.set(input.workspaceId, input);
  }

  seedServiceOffering(input: ServiceOfferingSnapshotSeed): void {
    this.offerings.set(input.id, input);
  }

  seedProjectBrief(input: ProjectBriefSnapshotSeed): void {
    this.briefs.set(input.id, input);
  }

  removeProjectBrief(id: string): void {
    this.briefs.delete(id);
  }

  // ---------- create ----------

  async createProjectRequestInTransaction(
    input: CreateProjectRequestTransactionInput,
    useCase: CreateProjectRequestUseCase,
  ): Promise<CreateProjectRequestResult> {
    if (this.inflight) {
      throw new Error(
        "In-memory ProjectRequestRepository already has an inflight transaction; " +
          "the in-memory adapter does not serialize concurrent transactions.",
      );
    }
    this.inflight = true;
    try {
      // Build the snapshots from the in-memory state.
      const buyerAuthority = this.snapshotBuyerAuthority(input);
      const sellerEligibility = this.snapshotSellerEligibility(input);
      const briefRecommendations = this.snapshotBriefRecommendations(input);

      const tools: CreateProjectRequestUseCaseTools = {
        reject: (reason): CreateUseCaseOutcome => ({ kind: "reject", reason }),
        persist: (persistInput): CreateUseCaseOutcome => ({ kind: "persist", input: persistInput }),
      };
      const outcome = useCase({ buyerAuthority, sellerEligibility, briefRecommendations }, tools);

      if (outcome.kind === "reject") {
        return { ok: false, reason: outcome.reason };
      }

      // Pending uniqueness guard (mirrors the partial unique
      // index).
      for (const existing of this.requests.values()) {
        if (
          existing.status === "Pending" &&
          existing.buyerWorkspaceId === outcome.input.buyerWorkspaceId &&
          existing.sellerWorkspaceId === outcome.input.sellerWorkspaceId &&
          existing.serviceOfferingId === outcome.input.serviceOfferingId &&
          existing.projectBriefId === outcome.input.projectBriefId
        ) {
          return { ok: false, reason: "ALREADY_PENDING" };
        }
      }

      const row: PersistedProjectRequest = {
        id: `pr-${randomUUID()}`,
        buyerWorkspaceId: outcome.input.buyerWorkspaceId,
        sellerWorkspaceId: outcome.input.sellerWorkspaceId,
        serviceOfferingId: outcome.input.serviceOfferingId,
        projectBriefId: outcome.input.projectBriefId,
        createdByUserId: outcome.input.userAccountId,
        status: "Pending",
        sellerDecisionAt: null,
        sellerDecisionByUserId: null,
        sellerConsentAt: null,
        createdAt: new Date(),
        // Display context for the just-created row. Populated from
        // the seeded snapshots so a follow-up list call surfaces
        // the same human-readable fields the Prisma adapter emits.
        buyerWorkspaceName: this.workspaces.get(outcome.input.buyerWorkspaceId)?.name ?? null,
        sellerWorkspaceName: this.workspaces.get(outcome.input.sellerWorkspaceId)?.name ?? null,
        serviceOfferingTitle: this.offerings.get(outcome.input.serviceOfferingId)?.title ?? null,
        briefExcerpt: makeBriefExcerpt(this.briefs.get(outcome.input.projectBriefId)?.originalText),
      };
      this.requests.set(row.id, row);
      return Promise.resolve({ ok: true, value: row });
    } finally {
      this.inflight = false;
    }
  }

  // ---------- respond (accept / decline) ----------

  async respondToProjectRequestInTransaction(
    input: RespondProjectRequestTransactionInput,
    useCase: RespondProjectRequestUseCase,
  ): Promise<DecideResult<AcceptProjectRequestResult | PersistedProjectRequest>> {
    if (this.inflight) {
      throw new Error(
        "In-memory ProjectRequestRepository already has an inflight transaction; " +
          "the in-memory adapter does not serialize concurrent transactions.",
      );
    }
    this.inflight = true;
    try {
      const existing = this.requests.get(input.projectRequestId);
      if (!existing) return Promise.resolve({ ok: false, reason: "NOT_FOUND" });

      const sellerAuthority = this.snapshotSellerAuthority(input, existing.sellerWorkspaceId);

      const tools: RespondProjectRequestUseCaseTools = {
        reject: (reason): RespondUseCaseOutcome => ({ kind: "reject", reason }),
        accept: (acceptInput): RespondUseCaseOutcome => ({ kind: "accept", input: acceptInput }),
        decline: (declineInput): RespondUseCaseOutcome => ({
          kind: "decline",
          input: declineInput,
        }),
      };
      const outcome = useCase(
        {
          sellerAuthority,
          projectRequest: existing,
          produceInitialTermsVersionDraft: input.produceInitialTermsVersionDraft ?? null,
        },
        tools,
      );

      if (outcome.kind === "reject") {
        return { ok: false, reason: outcome.reason };
      }

      if (existing.status !== "Pending") {
        return Promise.resolve({ ok: false, reason: "ALREADY_RESPONDED" });
      }

      if (outcome.kind === "accept") {
        // Unique Deal invariant (mirrors the deals.projectRequestId index).
        for (const deal of this.deals.values()) {
          if (deal.projectRequestId === existing.id) {
            return Promise.resolve({ ok: false, reason: "ALREADY_RESPONDED" });
          }
        }
        const updated: PersistedProjectRequest = {
          ...existing,
          status: "Accepted",
          sellerDecisionAt: outcome.input.now,
          sellerDecisionByUserId: outcome.input.sellerDecisionByUserId,
          sellerConsentAt: outcome.input.now,
        };
        this.requests.set(updated.id, updated);
        const deal: PersistedDeal = {
          id: `deal-${randomUUID()}`,
          buyerWorkspaceId: updated.buyerWorkspaceId,
          sellerWorkspaceId: updated.sellerWorkspaceId,
          serviceOfferingId: updated.serviceOfferingId,
          projectBriefId: updated.projectBriefId,
          projectRequestId: updated.id,
          status: "Negotiating",
          activatedAt: null,
          createdAt: new Date(),
        };
        this.deals.set(deal.id, deal);
        // M2 (#88): atomically persist the AI-drafted, unapproved
        // initial TermsVersion (v1) inside the SAME logical commit
        // as the Deal. The (dealId, version) UNIQUE check below
        // mirrors the durable convergence key the Prisma adapter
        // enforces. M2 (#88) Codex finding: the AI draft is
        // produced INSIDE the transaction via the thunk the use
        // case closure captured; the adapter is therefore NOT
        // invoked for unauthorized / already-responded /
        // losing-concurrent attempts. The thunk is awaited
        // here so a strict-validation failure propagates as a
        // thrown error and the surrounding transaction rolls
        // back with no state change.
        const draft = await outcome.input.produceInitialTermsVersionDraft();
        if (!draft) {
          // Defensive guard: the service must supply a draft
          // candidate via the use-case closure. If it did not,
          // the transaction rolls back with no state change.
          throw new Error(
            "In-memory accept use-case verdict lacked an initial TermsVersion draft.",
          );
        }
        for (const tv of this.termsVersions.values()) {
          if (tv.dealId === deal.id && tv.version === 1) {
            return Promise.resolve({ ok: false, reason: "ALREADY_RESPONDED" });
          }
        }
        const initialTermsVersion: PersistedTermsVersion = {
          id: `tv-${randomUUID()}`,
          dealId: deal.id,
          version: 1,
          scope: draft.scope,
          deliverablesJson: draft.deliverables.map((d) => ({
            title: d.title,
            description: d.description,
          })),
          scheduleJson: draft.schedule,
          priceAmountMinor: draft.price.amountMinor,
          priceCurrency: draft.price.currency,
          revisionAllowance: draft.revisionAllowance,
          rightsSummary: draft.rightsSummary,
          fundingDeadlineAt: draft.fundingDeadlineAt ? new Date(draft.fundingDeadlineAt) : null,
          aiProvider: draft.aiProvider,
          aiModelId: draft.aiModelId,
          aiFallbackUsed: draft.aiFallbackUsed,
          draftedByUserId: input.userAccountId,
          draftedAt: input.now,
          createdAt: new Date(),
        };
        this.termsVersions.set(initialTermsVersion.id, initialTermsVersion);
        return Promise.resolve({
          ok: true,
          value: { projectRequest: updated, deal, initialTermsVersion },
        });
      }

      // Decline branch.
      const updated: PersistedProjectRequest = {
        ...existing,
        status: "Declined",
        sellerDecisionAt: outcome.input.now,
        sellerDecisionByUserId: outcome.input.sellerDecisionByUserId,
        sellerConsentAt: null,
      };
      this.requests.set(updated.id, updated);
      return Promise.resolve({ ok: true, value: updated });
    } finally {
      this.inflight = false;
    }
  }

  // ---------- reads ----------

  async findProjectRequestById(projectRequestId: string): Promise<PersistedProjectRequest | null> {
    return Promise.resolve(this.requests.get(projectRequestId) ?? null);
  }

  async listProjectRequests(input: {
    readonly workspaceId: string;
    readonly statusFilter?: ProjectRequestStatusV1;
  }): Promise<readonly PersistedProjectRequest[]> {
    const all = [...this.requests.values()]
      .filter(
        (row) =>
          row.buyerWorkspaceId === input.workspaceId || row.sellerWorkspaceId === input.workspaceId,
      )
      .filter((row) => (input.statusFilter ? row.status === input.statusFilter : true))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    // Mirror the Prisma adapter's `take: 200` so the in-memory
    // adapter cannot diverge from the public response contract
    // maximum of 200 rows. The schema enforces 200 on the way out;
    // this prevents the adapter from returning more rows than the
    // envelope can carry.
    return Promise.resolve(all.slice(0, 200));
  }

  // ---------- snapshot helpers ----------

  private membershipKey(userId: string, workspaceId: string): string {
    return `${userId}|${workspaceId}`;
  }

  private snapshotBuyerAuthority(
    input: CreateProjectRequestTransactionInput,
  ): BuyerAuthoritySnapshot {
    const ws = this.workspaces.get(input.buyerWorkspaceId);
    return {
      userAccountId: input.userAccountId,
      buyerWorkspaceId: input.buyerWorkspaceId,
      workspaceStatus: ws?.status ?? "Suspended",
      isMember: this.memberships.has(
        this.membershipKey(input.userAccountId, input.buyerWorkspaceId),
      ),
      hasBuyerCapability: ws?.buyerCapability ?? false,
    };
  }

  private snapshotSellerEligibility(
    input: CreateProjectRequestTransactionInput,
  ): SellerEligibilitySnapshot {
    const offering = this.offerings.get(input.serviceOfferingId);
    if (!offering) {
      return {
        serviceOfferingId: input.serviceOfferingId,
        sellerWorkspaceId: null,
        offeringStatus: null,
        workspaceStatus: null,
        workspaceHasSellerCapability: null,
        profileStatus: null,
      };
    }
    const ws = this.workspaces.get(offering.sellerWorkspaceId);
    const profile = this.sellerProfiles.get(offering.sellerWorkspaceId);
    return {
      serviceOfferingId: input.serviceOfferingId,
      sellerWorkspaceId: offering.sellerWorkspaceId,
      offeringStatus: offering.status,
      workspaceStatus: ws?.status ?? null,
      workspaceHasSellerCapability: ws?.sellerCapability ?? null,
      profileStatus: profile?.status ?? null,
    };
  }

  private snapshotBriefRecommendations(
    input: CreateProjectRequestTransactionInput,
  ): BriefRecommendationsSnapshot {
    const brief = this.briefs.get(input.projectBriefId);
    if (!brief) {
      return {
        projectBriefId: input.projectBriefId,
        buyerWorkspaceId: null,
        exists: false,
        offeringIds: [],
      };
    }
    return {
      projectBriefId: brief.id,
      buyerWorkspaceId: brief.buyerWorkspaceId,
      exists: true,
      offeringIds: [...brief.recommendedOfferingIds],
    };
  }

  private snapshotSellerAuthority(
    input: RespondProjectRequestTransactionInput,
    projectRequestSellerWorkspaceId: string,
  ): SellerAuthoritySnapshot {
    const ws = this.workspaces.get(projectRequestSellerWorkspaceId);
    return {
      userAccountId: input.userAccountId,
      actingWorkspaceId: input.actingWorkspaceId,
      projectRequestSellerWorkspaceId,
      workspaceStatus: ws?.status ?? "Suspended",
      isMember: this.memberships.has(
        this.membershipKey(input.userAccountId, input.actingWorkspaceId),
      ),
      hasSellerCapability: ws?.sellerCapability ?? false,
    };
  }
}

// Trim + collapse whitespace and cap the brief excerpt so the DTO
// stays bounded. Mirrors the same helper used by the Prisma adapter
// so the in-memory adapter produces identical public DTO shapes.
function makeBriefExcerpt(originalText: string | null | undefined): string | null {
  if (!originalText) return null;
  const trimmed = originalText.replace(/\s+/g, " ").trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > 280 ? `${trimmed.slice(0, 277)}…` : trimmed;
}
