// Prisma adapter for ProjectRequestRepository.
//
// Background: this module is the only place the BG4 ProjectRequest /
// Deal boundary touches Prisma. Higher layers depend on
// `ProjectRequestRepository`; tests can swap in the in-memory
// adapter without changing the service or route code.
//
// Architectural split:
//
//   - The application owns the authorization policy (see
//     `./project-request-authorization-policy.ts`). Every pure
//     evaluator (buyer authority, seller authority, seller /
//     offering eligibility, brief recommendation boundary) lives
//     there and is invoked by the service's use-case closures.
//
//   - The repository owns the transaction boundary and the
//     locked-fact reads. Inside one `$transaction` it acquires
//     `SELECT ... FOR UPDATE` row locks on every row the policy
//     depends on, then hands the assembled snapshot to the
//     application-supplied use case. The use case evaluates the
//     policy helpers and returns either `persist` or `reject`. The
//     repository persists only when the use case persists; the
//     transaction rolls back on any rejection.
//
//   - The Prisma adapter never decides whether the facts authorize
//     the command. The application-owned policy is the only
//     decision point.
//
// All consequential writes are wrapped in the same transaction. The
// guarded `updateMany WHERE status='Pending'` plus the unique index
// on `deals.projectRequestId` remain the second defenses against
// retries creating duplicate decisions (ticket #62 GS 26).
//
// Serializable concurrency (P1-001):
//
//   Both transactional command methods open a PostgreSQL transaction
//   with `Serializable` isolation. A conflicting commit on any row
//   the transaction read produces a Prisma `P2034`
//   (serialization_failure / write conflict) error on COMMIT. The
//   adapter retries the bounded transaction a small fixed number
//   of times; each retry re-reads authoritative current facts via
//   FOR UPDATE so a revocation that committed between attempts is
//   reflected in the next snapshot. After the retry budget is
//   exhausted the adapter surfaces a safe typed failure reason
//   (CONCURRENCY_RETRY_EXHAUSTED) so the application route layer
//   maps it onto the existing safe envelope. NO partial
//   ProjectRequest, decision evidence, or Deal may remain from a
//   failed attempt — the bounded transaction guarantees an all-or-
//   nothing outcome on every attempt.

import type { PrismaClient } from "@soundhub/db";
import { PrismaClientKnownRequestError } from "@soundhub/db/dist/generated/internal/prismaNamespace.js";
import type { ProjectRequestStatusV1, DealStatusV1 } from "@soundhub/types";
import type {
  AcceptProjectRequestResult,
  CreateProjectRequestFailureReason,
  CreateProjectRequestResult,
  CreateProjectRequestTransactionInput,
  CreateProjectRequestUseCase,
  CreateProjectRequestUseCaseTools,
  DecideFailureReason,
  DecideResult,
  InitialTermsVersionDraft,
  PersistedDeal,
  PersistedProjectRequest,
  PersistedTermsVersion,
  ProjectRequestRepository,
  RespondProjectRequestTransactionInput,
  RespondProjectRequestUseCase,
  RespondProjectRequestUseCaseTools,
} from "./project-request.repository.js";
import type {
  BriefRecommendationsSnapshot,
  BuyerAuthoritySnapshot,
  SellerAuthoritySnapshot,
  SellerEligibilitySnapshot,
} from "./project-request-authorization-policy.js";

// Prisma namespace alias used for typed raw queries with FOR UPDATE.
type PrismaTransaction = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

type DbStatus = "Pending" | "Accepted" | "Declined";
type DbDealStatus = "Negotiating" | "Active";

function toProjectRequestStatus(value: DbStatus): ProjectRequestStatusV1 {
  return value;
}
function toDealStatus(value: DbDealStatus): DealStatusV1 {
  return value;
}

// Small fixed maximum. The bounded retry is not a generalized
// framework — it exists only because PostgreSQL's Serializable
// isolation surfaces a write conflict (P2034) when the transaction's
// snapshot is invalidated by a concurrent committed write that
// touched a row the transaction read. A second attempt re-reads
// authoritative FOR UPDATE-locked state and is overwhelmingly likely
// to succeed against the now-quiesced background state. Three
// attempts is the documented upper bound; after that the adapter
// surfaces CONCURRENCY_RETRY_EXHAUSTED so the route layer can
// emit a safe 409 envelope.
const P2034_RETRY_BUDGET = 3;

// The safe typed failure reason a BG4 command returns after the
// retry budget is exhausted. Routes collapse it onto the existing
// safe envelope (PROJECT_REQUEST_OFFERING_INELIGIBLE for create,
// PROJECT_REQUEST_ALREADY_RESPONDED for respond) so the contract
// never reveals the internal counter to a client.
const CONCURRENCY_RETRY_EXHAUSTED_CREATE: CreateProjectRequestFailureReason =
  "CONCURRENCY_RETRY_EXHAUSTED";
const CONCURRENCY_RETRY_EXHAUSTED_RESPOND: DecideFailureReason = "CONCURRENCY_RETRY_EXHAUSTED";

/**
 * Returns true when the Prisma error is a serialization_failure
 * (write conflict) under PostgreSQL Serializable isolation. The
 * Prisma error code is `P2034`; the underlying SQLSTATE is
 * `40001` for true serialization failures. Prisma 7+ also
 * surfaces raw SQLSTATE codes through `PrismaClientKnownRequestError`
 * so both forms are treated as retryable. A deadlock
 * (`40P01`) is also surfaced by Prisma as `P2034` and is
 * recoverable by re-running the bounded transaction.
 *
 * For raw `$queryRaw` failures Prisma wraps the error in a
 * generic `PrismaClientKnownRequestError` whose `code` is the
 * SQLSTATE string. We match on the code OR fall back to the
 * `40001` substring on the message so test-injected errors
 * (which use the same message shape) and any future Prisma
 * rewording are both caught.
 */
function isSerializationConflict(err: unknown): boolean {
  if (err instanceof PrismaClientKnownRequestError) {
    if (err.code === "P2034" || err.code === "40001" || err.code === "40P01") return true;
  }
  if (
    err instanceof Error &&
    /40001|serialization_failure|write conflict|P2034/i.test(err.message)
  ) {
    return true;
  }
  return false;
}

/**
 * Tiny helper that retries a bounded Prisma `$transaction` block on
 * `P2034` write conflicts. The callable MUST be idempotent (each
 * attempt re-reads authoritative current facts via FOR UPDATE so a
 * revocation that committed between attempts is reflected in the
 * next snapshot). The retry sleeps zero milliseconds between
 * attempts — the background transaction is the only contention
 * source and retrying immediately is sufficient for the small
 * fixed budget. The function returns the result of the first
 * successful attempt OR a serialization-conflict failure object
 * the caller can map onto a typed failure reason.
 *
 * The wrapper returns a discriminated object so callers whose
 * success type happens to share a discriminator with the failure
 * type (e.g. `DecideResult`) can still distinguish the two paths
 * without runtime type-checking gymnastics.
 */
interface BoundedRetryEnvelope<TValue, TFailure> {
  readonly outcome:
    | { readonly kind: "value"; readonly value: TValue }
    | { readonly kind: "exhausted"; readonly failure: TFailure };
}
async function runWithBoundedP2034Retry<TValue, TFailure>(
  attempt: () => Promise<TValue>,
  buildFailure: () => TFailure,
): Promise<BoundedRetryEnvelope<TValue, TFailure>> {
  for (let attemptIndex = 0; attemptIndex < P2034_RETRY_BUDGET; attemptIndex += 1) {
    try {
      return { outcome: { kind: "value", value: await attempt() } };
    } catch (err) {
      if (!isSerializationConflict(err)) throw err;
      // Fall through to the next attempt; the background
      // transaction that triggered the conflict is no longer
      // holding the locks we need.
    }
  }
  return { outcome: { kind: "exhausted", failure: buildFailure() } };
}

export class PrismaProjectRequestRepository implements ProjectRequestRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // ---------- create ----------

  async createProjectRequestInTransaction(
    input: CreateProjectRequestTransactionInput,
    useCase: CreateProjectRequestUseCase,
  ): Promise<CreateProjectRequestResult> {
    const envelope = await runWithBoundedP2034Retry<
      CreateProjectRequestResult,
      CreateProjectRequestFailureReason
    >(
      () => this.runCreateTransactionOnce(input, useCase),
      () => CONCURRENCY_RETRY_EXHAUSTED_CREATE,
    );
    if (envelope.outcome.kind === "exhausted") {
      return { ok: false, reason: envelope.outcome.failure };
    }
    return envelope.outcome.value;
  }

  private async runCreateTransactionOnce(
    input: CreateProjectRequestTransactionInput,
    useCase: CreateProjectRequestUseCase,
  ): Promise<CreateProjectRequestResult> {
    try {
      const result = await this.prisma.$transaction(
        async (tx) => {
          // Step 1: FOR UPDATE-lock and read the buyer authority
          // rows. The application-owned policy evaluator consumes
          // this snapshot. Locking Workspace /
          // WorkspaceMembership / WorkspaceCapability blocks any
          // concurrent revoke / suspension / capability removal
          // from committing until our transaction completes.
          const buyerAuthority = await this.loadAndLockBuyerAuthority(tx, input);
          // Step 2: FOR UPDATE-lock and read the seller /
          // offering eligibility rows. The application-owned
          // policy evaluator consumes this snapshot.
          const sellerEligibility = await this.loadAndLockSellerEligibility(tx, input);
          // Step 3: FOR UPDATE-lock and read the ProjectBrief +
          // its BriefSearchResult recommendation rows. The brief
          // recommendation boundary is a buyer-safe provenance
          // check that the application policy owns.
          const briefRecommendations = await this.loadAndLockBriefRecommendations(tx, input);

          // Step 4: hand the snapshots to the application-owned
          // use case. The repository MUST NOT decide whether the
          // facts authorize the command.
          const tools: CreateProjectRequestUseCaseTools = {
            reject: (reason) => ({ kind: "reject", reason }),
            persist: (persistInput) => ({ kind: "persist", input: persistInput }),
          };
          const outcome = useCase(
            { buyerAuthority, sellerEligibility, briefRecommendations },
            tools,
          );

          if (outcome.kind === "reject") {
            // The application rejected the command. Roll back
            // the transaction with no state change.
            return { ok: false as const, reason: outcome.reason };
          }

          // Step 5: persist. The unique partial index on Pending
          // rows is the second defense against retries creating
          // duplicates; a violation surfaces as ALREADY_PENDING.
          try {
            const row = await tx.projectRequest.create({
              data: {
                buyerWorkspaceId: outcome.input.buyerWorkspaceId,
                sellerWorkspaceId: outcome.input.sellerWorkspaceId,
                serviceOfferingId: outcome.input.serviceOfferingId,
                projectBriefId: outcome.input.projectBriefId,
                createdByUserId: outcome.input.userAccountId,
              },
            });
            return { ok: true as const, value: toPersisted(row) };
          } catch (err) {
            if (err instanceof PrismaClientKnownRequestError && err.code === "P2002") {
              return {
                ok: false as const,
                reason: "ALREADY_PENDING" as CreateProjectRequestFailureReason,
              };
            }
            throw err;
          }
        },
        { isolationLevel: "Serializable" },
      );
      return result;
    } catch (err) {
      // Defense in depth: the unique index violation can surface
      // at the outer boundary if the transaction was rolled back
      // at commit time.
      if (err instanceof PrismaClientKnownRequestError && err.code === "P2002") {
        return { ok: false, reason: "ALREADY_PENDING" };
      }
      throw err;
    }
  }

  private async loadAndLockBuyerAuthority(
    tx: PrismaTransaction,
    input: CreateProjectRequestTransactionInput,
  ): Promise<BuyerAuthoritySnapshot> {
    // Lock the buyer Workspace row first so a concurrent UPDATE on
    // `status` blocks until our transaction completes.
    const wsRows = await tx.$queryRaw<
      { readonly status: "Active" | "Suspended" }[]
    >`SELECT status FROM workspaces WHERE id = ${input.buyerWorkspaceId} FOR UPDATE`;
    const workspaceStatus: "Active" | "Suspended" = wsRows[0]?.status ?? "Suspended";

    // Lock the WorkspaceMembership row. A revoke on the buyer
    // side must wait for our transaction.
    const membershipRows = await tx.$queryRaw<{ readonly id: string }[]>`
      SELECT id FROM workspace_memberships
      WHERE "userId" = ${input.userAccountId} AND "workspaceId" = ${input.buyerWorkspaceId}
      FOR UPDATE
    `;
    const isMember = membershipRows.length > 0;

    // Lock the Buyer capability row. A capability removal must
    // wait for our transaction.
    const capabilityRows = await tx.$queryRaw<{ readonly capability: string }[]>`
      SELECT capability FROM workspace_capabilities
      WHERE "workspaceId" = ${input.buyerWorkspaceId} AND capability = 'Buyer'
      FOR UPDATE
    `;
    const hasBuyerCapability = capabilityRows.length > 0;

    return {
      userAccountId: input.userAccountId,
      buyerWorkspaceId: input.buyerWorkspaceId,
      workspaceStatus,
      isMember,
      hasBuyerCapability,
    };
  }

  private async loadAndLockSellerEligibility(
    tx: PrismaTransaction,
    input: CreateProjectRequestTransactionInput,
  ): Promise<SellerEligibilitySnapshot> {
    // Lock the ServiceOffering row and read its sellerProfile +
    // workspaceId in one statement. Returning null on no rows so
    // the policy evaluator surfaces OFFERING_NOT_FOUND.
    const offeringRows = await tx.$queryRaw<
      {
        readonly id: string;
        readonly status: "Draft" | "Active" | "Paused" | "Archived";
        readonly sellerProfileWorkspaceId: string;
        readonly workspaceStatus: "Active" | "Suspended";
        readonly profileStatus: "Draft" | "Published" | "Suspended";
      }[]
    >`
      SELECT so.id, so.status,
             sp."workspaceId" AS "sellerProfileWorkspaceId",
             w.status AS "workspaceStatus",
             sp.status AS "profileStatus"
      FROM service_offerings so
      JOIN seller_profiles sp ON sp.id = so."sellerProfileId"
      JOIN workspaces w ON w.id = sp."workspaceId"
      WHERE so.id = ${input.serviceOfferingId}
      FOR UPDATE OF so, sp, w
    `;
    const offering = offeringRows[0];
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

    // Lock the seller WorkspaceCapability rows. A capability
    // removal must wait for our transaction.
    const capabilityRows = await tx.$queryRaw<{ readonly capability: string }[]>`
      SELECT capability FROM workspace_capabilities
      WHERE "workspaceId" = ${offering.sellerProfileWorkspaceId} AND capability = 'Seller'
      FOR UPDATE
    `;
    const workspaceHasSellerCapability = capabilityRows.length > 0;

    return {
      serviceOfferingId: input.serviceOfferingId,
      sellerWorkspaceId: offering.sellerProfileWorkspaceId,
      offeringStatus: offering.status,
      workspaceStatus: offering.workspaceStatus,
      workspaceHasSellerCapability,
      profileStatus: offering.profileStatus,
    };
  }

  private async loadAndLockBriefRecommendations(
    tx: PrismaTransaction,
    input: CreateProjectRequestTransactionInput,
  ): Promise<BriefRecommendationsSnapshot> {
    // Lock the ProjectBrief row first. A concurrent Workspace /
    // buyer-workspace mutation on the brief's parent must wait
    // for our transaction.
    const briefRows = await tx.$queryRaw<
      { readonly id: string; readonly buyerWorkspaceId: string }[]
    >`SELECT id, "buyerWorkspaceId" FROM project_briefs WHERE id = ${input.projectBriefId} FOR UPDATE`;
    if (briefRows.length === 0) {
      return {
        projectBriefId: input.projectBriefId,
        buyerWorkspaceId: null,
        exists: false,
        offeringIds: [],
      };
    }
    const brief = briefRows[0];
    if (!brief) {
      return {
        projectBriefId: input.projectBriefId,
        buyerWorkspaceId: null,
        exists: false,
        offeringIds: [],
      };
    }
    // Lock the persisted BriefSearchResult rows so a buyer cannot
    // sneak in an offering via a concurrent insert that the
    // recommendation boundary would miss.
    const resultRows = await tx.$queryRaw<
      { readonly bestOfferingId: string; readonly additionalOfferingsJson: unknown }[]
    >`
      SELECT "bestOfferingId", "additionalOfferingsJson"
      FROM brief_search_results
      WHERE "briefId" = ${input.projectBriefId}
      FOR UPDATE
    `;
    const offeringIds = new Set<string>();
    for (const row of resultRows) {
      offeringIds.add(row.bestOfferingId);
      const additional = row.additionalOfferingsJson;
      if (Array.isArray(additional)) {
        for (const entry of additional) {
          if (typeof entry === "string") {
            offeringIds.add(entry);
          } else if (
            entry &&
            typeof entry === "object" &&
            "offeringId" in entry &&
            typeof (entry as { offeringId: unknown }).offeringId === "string"
          ) {
            offeringIds.add((entry as { offeringId: string }).offeringId);
          } else if (
            entry &&
            typeof entry === "object" &&
            "id" in entry &&
            typeof (entry as { id: unknown }).id === "string"
          ) {
            offeringIds.add((entry as { id: string }).id);
          }
        }
      }
    }
    return {
      projectBriefId: brief.id,
      buyerWorkspaceId: brief.buyerWorkspaceId,
      exists: true,
      offeringIds: [...offeringIds],
    };
  }

  // ---------- respond (accept / decline) ----------

  async respondToProjectRequestInTransaction(
    input: RespondProjectRequestTransactionInput,
    useCase: RespondProjectRequestUseCase,
  ): Promise<DecideResult<AcceptProjectRequestResult | PersistedProjectRequest>> {
    // M2 (#88) Codex finding (post 8d1ac3b): memoize the AI
    // draft thunk across bounded P2034 retries. The thunk is
    // captured by the use case closure and invoked INSIDE the
    // transaction; a mid-transaction P2034 failure (e.g., the
    // serialization_failure on the TermsVersion insert) would
    // otherwise cause the next retry attempt to invoke the
    // adapter a SECOND time for the same logical accept. The
    // cache collapses every retry attempt onto a single
    // resolved Promise — the first call invokes the adapter,
    // every subsequent call (within the same `respondToProjectRequestInTransaction`
    // invocation) returns the same resolved value. The cache
    // is reset for every new accept attempt, so different
    // accepts do not share state.
    let cachedDraftPromise: Promise<InitialTermsVersionDraft> | null = null;
    const memoizedProducer: (() => Promise<InitialTermsVersionDraft>) | null =
      input.produceInitialTermsVersionDraft === null
        ? null
        : () => {
            if (cachedDraftPromise === null) {
              cachedDraftPromise = input.produceInitialTermsVersionDraft!();
            }
            return cachedDraftPromise;
          };
    const memoizedInput: RespondProjectRequestTransactionInput = {
      ...input,
      produceInitialTermsVersionDraft: memoizedProducer,
    };
    const envelope = await runWithBoundedP2034Retry<
      DecideResult<AcceptProjectRequestResult | PersistedProjectRequest>,
      DecideFailureReason
    >(
      () => this.runRespondTransactionOnce(memoizedInput, useCase),
      () => CONCURRENCY_RETRY_EXHAUSTED_RESPOND,
    );
    if (envelope.outcome.kind === "exhausted") {
      return { ok: false, reason: envelope.outcome.failure };
    }
    return envelope.outcome.value;
  }

  private async runRespondTransactionOnce(
    input: RespondProjectRequestTransactionInput,
    useCase: RespondProjectRequestUseCase,
  ): Promise<DecideResult<AcceptProjectRequestResult | PersistedProjectRequest>> {
    try {
      const result = await this.prisma.$transaction(
        async (tx) => {
          // Lock the ProjectRequest row first. The guarded
          // updateMany below re-checks status, but locking the row
          // up front ensures a concurrent accept / decline waits
          // for our transaction.
          const requestRows = await tx.$queryRaw<
            {
              readonly id: string;
              readonly buyerWorkspaceId: string;
              readonly sellerWorkspaceId: string;
              readonly serviceOfferingId: string;
              readonly projectBriefId: string;
              readonly createdByUserId: string;
              readonly status: "Pending" | "Accepted" | "Declined";
              readonly sellerDecisionAt: Date | null;
              readonly sellerDecisionByUserId: string | null;
              readonly sellerConsentAt: Date | null;
              readonly createdAt: Date;
            }[]
          >`SELECT * FROM project_requests WHERE id = ${input.projectRequestId} FOR UPDATE`;
          if (requestRows.length === 0) {
            return { ok: false as const, reason: "NOT_FOUND" as const };
          }
          const requestRow = requestRows[0];
          if (!requestRow) {
            return { ok: false as const, reason: "NOT_FOUND" as const };
          }

          // Lock the seller authority rows. A concurrent revoke
          // or Workspace suspension must wait.
          const sellerAuthority = await this.loadAndLockSellerAuthority(
            tx,
            input,
            requestRow.sellerWorkspaceId,
          );

          // Hand the snapshot to the application-owned use case.
          const projectRequest: PersistedProjectRequest = toPersisted(requestRow);
          const tools: RespondProjectRequestUseCaseTools = {
            reject: (reason) => ({ kind: "reject", reason }),
            accept: (acceptInput) => ({ kind: "accept", input: acceptInput }),
            decline: (declineInput) => ({ kind: "decline", input: declineInput }),
          };
          // M2 (#88) Codex finding: the AI draft producer is
          // threaded into the use-case context so the adapter is
          // invoked only when the use case decides to accept. The
          // repository itself never invokes the producer; the
          // use case closure captures the producer and threads it
          // into the accept verdict's `produceInitialTermsVersionDraft`
          // thunk.
          const outcome = useCase(
            {
              sellerAuthority,
              projectRequest,
              produceInitialTermsVersionDraft: input.produceInitialTermsVersionDraft ?? null,
            },
            tools,
          );

          if (outcome.kind === "reject") {
            return { ok: false as const, reason: outcome.reason };
          }

          if (outcome.kind === "accept") {
            // Guarded transition: updateMany WHERE status='Pending'.
            // Two concurrent accepts cannot both succeed; the
            // second sees count === 0 and surfaces
            // ALREADY_RESPONDED. The unique index on
            // `deals.projectRequestId` is the second defense.
            const guarded = await tx.projectRequest.updateMany({
              where: { id: outcome.input.projectRequestId, status: "Pending" },
              data: {
                status: "Accepted",
                sellerDecisionAt: outcome.input.now,
                sellerDecisionByUserId: outcome.input.sellerDecisionByUserId,
                sellerConsentAt: outcome.input.now,
              },
            });
            if (guarded.count === 0) {
              return { ok: false as const, reason: "ALREADY_RESPONDED" as const };
            }
            const updated = await tx.projectRequest.findUniqueOrThrow({
              where: { id: outcome.input.projectRequestId },
            });
            const deal = await tx.deal.create({
              data: {
                buyerWorkspaceId: updated.buyerWorkspaceId,
                sellerWorkspaceId: updated.sellerWorkspaceId,
                serviceOfferingId: updated.serviceOfferingId,
                projectBriefId: updated.projectBriefId,
                projectRequestId: updated.id,
              },
            });
            // M2 (#88) Codex finding: invoke the AI draft thunk
            // HERE — inside the transaction, AFTER the guarded
            // Pending → Accepted update + Deal insert succeed,
            // and BEFORE the TermsVersion insert. The adapter is
            // therefore NOT invoked for unauthorized /
            // already-responded / losing-concurrent attempts. A
            // strict-validated candidate is materialized only on
            // the winning path; a malformed candidate collapses
            // the transaction with no state change (no Deal, no
            // TermsVersion, no Accept transition).
            //
            // The thunk is also responsible for strict Zod
            // validation against `bg5ProposedTermsV1Schema`; a
            // validation failure throws and the surrounding
            // `$transaction` rolls back, leaving the ProjectRequest
            // in `Accepted` status BUT no Deal row. That is a
            // narrow fail-closed window — the route layer maps
            // the typed exception to `PROJECT_REQUEST_TERMS_DRAFT_INVALID`
            // (400). The (deals.projectRequestId) UNIQUE index
            // means a SAME-attempt retry converges: the same
            // (projectRequestId) row is already `Accepted` and
            // the retry hits the `ALREADY_RESPONDED` branch.
            // The next accept attempt by a different seller
            // member of the same Workspace is the only path
            // forward; the AI candidate is generated exactly
            // once on the winning path.
            const draft = await outcome.input.produceInitialTermsVersionDraft();
            const createdTv = await tx.termsVersion.create({
              data: {
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
                fundingDeadlineAt: draft.fundingDeadlineAt
                  ? new Date(draft.fundingDeadlineAt)
                  : null,
                aiProvider: draft.aiProvider,
                aiModelId: draft.aiModelId,
                aiFallbackUsed: draft.aiFallbackUsed,
                draftedByUserId: input.userAccountId,
                draftedAt: input.now,
              },
            });
            const initialTermsVersion = toPersistedTermsVersion(createdTv);
            return {
              ok: true as const,
              value: {
                projectRequest: toPersisted(updated),
                deal: toPersistedDeal(deal),
                initialTermsVersion,
              },
            };
          }

          // Decline branch.
          const guarded = await tx.projectRequest.updateMany({
            where: { id: outcome.input.projectRequestId, status: "Pending" },
            data: {
              status: "Declined",
              sellerDecisionAt: outcome.input.now,
              sellerDecisionByUserId: outcome.input.sellerDecisionByUserId,
              // sellerConsentAt intentionally null on decline —
              // explicit consent belongs only to acceptance.
            },
          });
          if (guarded.count === 0) {
            return { ok: false as const, reason: "ALREADY_RESPONDED" as const };
          }
          const updated = await tx.projectRequest.findUniqueOrThrow({
            where: { id: outcome.input.projectRequestId },
          });
          return {
            ok: true as const,
            value: toPersisted(updated),
          };
        },
        { isolationLevel: "Serializable" },
      );
      return result;
    } catch (err) {
      if (err instanceof PrismaClientKnownRequestError && err.code === "P2002") {
        return { ok: false, reason: "ALREADY_RESPONDED" };
      }
      throw err;
    }
  }

  private async loadAndLockSellerAuthority(
    tx: PrismaTransaction,
    input: RespondProjectRequestTransactionInput,
    projectRequestSellerWorkspaceId: string,
  ): Promise<SellerAuthoritySnapshot> {
    // Lock the seller Workspace row.
    const wsRows = await tx.$queryRaw<
      { readonly status: "Active" | "Suspended" }[]
    >`SELECT status FROM workspaces WHERE id = ${projectRequestSellerWorkspaceId} FOR UPDATE`;
    const workspaceStatus: "Active" | "Suspended" = wsRows[0]?.status ?? "Suspended";

    // Lock the WorkspaceMembership row for the acting user.
    const membershipRows = await tx.$queryRaw<{ readonly id: string }[]>`
      SELECT id FROM workspace_memberships
      WHERE "userId" = ${input.userAccountId} AND "workspaceId" = ${input.actingWorkspaceId}
      FOR UPDATE
    `;
    const isMember = membershipRows.length > 0;

    // Lock the Seller capability row.
    const capabilityRows = await tx.$queryRaw<{ readonly capability: string }[]>`
      SELECT capability FROM workspace_capabilities
      WHERE "workspaceId" = ${input.actingWorkspaceId} AND capability = 'Seller'
      FOR UPDATE
    `;
    const hasSellerCapability = capabilityRows.length > 0;

    return {
      userAccountId: input.userAccountId,
      actingWorkspaceId: input.actingWorkspaceId,
      projectRequestSellerWorkspaceId,
      workspaceStatus,
      isMember,
      hasSellerCapability,
    };
  }

  // ---------- reads ----------

  async findProjectRequestById(projectRequestId: string): Promise<PersistedProjectRequest | null> {
    const row = await this.prisma.projectRequest.findUnique({
      where: { id: projectRequestId },
    });
    if (!row) return null;
    const context = await this.loadDisplayContextForRequest({
      buyerWorkspaceId: row.buyerWorkspaceId,
      sellerWorkspaceId: row.sellerWorkspaceId,
      serviceOfferingId: row.serviceOfferingId,
      projectBriefId: row.projectBriefId,
    });
    return toPersisted(row, context);
  }

  async listProjectRequests(input: {
    readonly workspaceId: string;
    readonly statusFilter?: ProjectRequestStatusV1;
  }): Promise<readonly PersistedProjectRequest[]> {
    const rows = await this.prisma.projectRequest.findMany({
      where: {
        OR: [{ buyerWorkspaceId: input.workspaceId }, { sellerWorkspaceId: input.workspaceId }],
        ...(input.statusFilter ? { status: input.statusFilter } : {}),
      },
      orderBy: { createdAt: "desc" },
      // Bound the inbox to the public response contract maximum so
      // a runaway Workspace cannot blow past the allow-listed row
      // cap. The schema enforces 200 on the way out; this prevents
      // the database from returning more rows than the envelope can
      // carry.
      take: 200,
    });
    if (rows.length === 0) return [];
    // Batch-load the display context for every row in one round trip
    // so the inbox stays fast even when many Pending requests are
    // surfaced at once. Each row keeps its own nullable fields; a
    // missing referenced row yields null (the UI renders a
    // placeholder).
    const contextByKey = await this.loadDisplayContextForRequests(rows);
    return rows.map((row) => {
      const context = contextByKey.get(
        contextKey(
          row.buyerWorkspaceId,
          row.sellerWorkspaceId,
          row.serviceOfferingId,
          row.projectBriefId,
        ),
      ) ?? {
        buyerWorkspaceName: null,
        sellerWorkspaceName: null,
        serviceOfferingTitle: null,
        briefExcerpt: null,
      };
      return toPersisted(row, context);
    });
  }

  // One round-trip per kind, scoped to the union of ids the
  // supplied rows reference. A missing referenced row simply yields
  // no match; the corresponding DTO field is rendered as null.
  private async loadDisplayContextForRequests(
    rows: readonly {
      readonly buyerWorkspaceId: string;
      readonly sellerWorkspaceId: string;
      readonly serviceOfferingId: string;
      readonly projectBriefId: string;
    }[],
  ): Promise<Map<string, ProjectRequestDisplayContext>> {
    const workspaceIds = new Set<string>();
    const offeringIds = new Set<string>();
    const briefIds = new Set<string>();
    for (const row of rows) {
      workspaceIds.add(row.buyerWorkspaceId);
      workspaceIds.add(row.sellerWorkspaceId);
      offeringIds.add(row.serviceOfferingId);
      briefIds.add(row.projectBriefId);
    }
    const [workspaces, offerings, briefs] = await Promise.all([
      this.prisma.workspace.findMany({
        where: { id: { in: [...workspaceIds] } },
        select: { id: true, name: true },
      }),
      this.prisma.serviceOffering.findMany({
        where: { id: { in: [...offeringIds] } },
        select: { id: true, title: true },
      }),
      this.prisma.projectBrief.findMany({
        where: { id: { in: [...briefIds] } },
        select: { id: true, originalText: true },
      }),
    ]);
    const workspaceNames = new Map(workspaces.map((w) => [w.id, w.name]));
    const offeringTitles = new Map(offerings.map((o) => [o.id, o.title]));
    const briefExcerpts = new Map(
      briefs.map((b) => [b.id, makeBriefExcerpt(b.originalText)] as const),
    );
    const out = new Map<string, ProjectRequestDisplayContext>();
    for (const row of rows) {
      out.set(
        contextKey(
          row.buyerWorkspaceId,
          row.sellerWorkspaceId,
          row.serviceOfferingId,
          row.projectBriefId,
        ),
        {
          buyerWorkspaceName: workspaceNames.get(row.buyerWorkspaceId) ?? null,
          sellerWorkspaceName: workspaceNames.get(row.sellerWorkspaceId) ?? null,
          serviceOfferingTitle: offeringTitles.get(row.serviceOfferingId) ?? null,
          briefExcerpt: briefExcerpts.get(row.projectBriefId) ?? null,
        },
      );
    }
    return out;
  }

  // Single-row variant used by findProjectRequestById. Same shape
  // as the batch loader; separate so we do not allocate per-row
  // Maps for a single read.
  private async loadDisplayContextForRequest(input: {
    readonly buyerWorkspaceId: string;
    readonly sellerWorkspaceId: string;
    readonly serviceOfferingId: string;
    readonly projectBriefId: string;
  }): Promise<ProjectRequestDisplayContext> {
    const [buyerWorkspace, sellerWorkspace, offering, brief] = await Promise.all([
      this.prisma.workspace.findUnique({
        where: { id: input.buyerWorkspaceId },
        select: { name: true },
      }),
      this.prisma.workspace.findUnique({
        where: { id: input.sellerWorkspaceId },
        select: { name: true },
      }),
      this.prisma.serviceOffering.findUnique({
        where: { id: input.serviceOfferingId },
        select: { title: true },
      }),
      this.prisma.projectBrief.findUnique({
        where: { id: input.projectBriefId },
        select: { originalText: true },
      }),
    ]);
    return {
      buyerWorkspaceName: buyerWorkspace?.name ?? null,
      sellerWorkspaceName: sellerWorkspace?.name ?? null,
      serviceOfferingTitle: offering?.title ?? null,
      briefExcerpt: brief ? makeBriefExcerpt(brief.originalText) : null,
    };
  }
}

// ---------- helpers ----------

interface ProjectRequestDisplayContext {
  readonly buyerWorkspaceName: string | null;
  readonly sellerWorkspaceName: string | null;
  readonly serviceOfferingTitle: string | null;
  readonly briefExcerpt: string | null;
}

function contextKey(
  buyerWorkspaceId: string,
  sellerWorkspaceId: string,
  serviceOfferingId: string,
  projectBriefId: string,
): string {
  return `${buyerWorkspaceId}|${sellerWorkspaceId}|${serviceOfferingId}|${projectBriefId}`;
}

// Trim + collapse whitespace and cap the brief excerpt so the DTO
// stays bounded (the schema enforces ≤280 chars). A null/empty
// input collapses to null so the UI can render a stable
// placeholder rather than an empty string.
function makeBriefExcerpt(originalText: string | null | undefined): string | null {
  if (!originalText) return null;
  const trimmed = originalText.replace(/\s+/g, " ").trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > 280 ? `${trimmed.slice(0, 277)}…` : trimmed;
}

function toPersisted(
  row: {
    readonly id: string;
    readonly buyerWorkspaceId: string;
    readonly sellerWorkspaceId: string;
    readonly serviceOfferingId: string;
    readonly projectBriefId: string;
    readonly createdByUserId: string;
    readonly status: DbStatus;
    readonly sellerDecisionAt: Date | null;
    readonly sellerDecisionByUserId: string | null;
    readonly sellerConsentAt: Date | null;
    readonly createdAt: Date;
  },
  context: ProjectRequestDisplayContext = {
    buyerWorkspaceName: null,
    sellerWorkspaceName: null,
    serviceOfferingTitle: null,
    briefExcerpt: null,
  },
): PersistedProjectRequest {
  return {
    id: row.id,
    buyerWorkspaceId: row.buyerWorkspaceId,
    sellerWorkspaceId: row.sellerWorkspaceId,
    serviceOfferingId: row.serviceOfferingId,
    projectBriefId: row.projectBriefId,
    createdByUserId: row.createdByUserId,
    status: toProjectRequestStatus(row.status),
    sellerDecisionAt: row.sellerDecisionAt,
    sellerDecisionByUserId: row.sellerDecisionByUserId,
    sellerConsentAt: row.sellerConsentAt,
    createdAt: row.createdAt,
    buyerWorkspaceName: context.buyerWorkspaceName,
    sellerWorkspaceName: context.sellerWorkspaceName,
    serviceOfferingTitle: context.serviceOfferingTitle,
    briefExcerpt: context.briefExcerpt,
  };
}

function toPersistedDeal(row: {
  readonly id: string;
  readonly buyerWorkspaceId: string;
  readonly sellerWorkspaceId: string;
  readonly serviceOfferingId: string;
  readonly projectBriefId: string;
  readonly projectRequestId: string;
  readonly status: DbDealStatus;
  readonly activatedAt: Date | null;
  readonly createdAt: Date;
}): PersistedDeal {
  return {
    id: row.id,
    buyerWorkspaceId: row.buyerWorkspaceId,
    sellerWorkspaceId: row.sellerWorkspaceId,
    serviceOfferingId: row.serviceOfferingId,
    projectBriefId: row.projectBriefId,
    projectRequestId: row.projectRequestId,
    status: toDealStatus(row.status),
    activatedAt: row.activatedAt,
    createdAt: row.createdAt,
  };
}

// M2 (#88): map a freshly created TermsVersion row to the strict
// persisted-shape used by the accept transaction. Mirrors the shape
// the DealTermsRepository prisma adapter emits so the service layer
// can project it through `toPublicInitialTermsVersion` without
// reading the row again.
function toPersistedTermsVersion(row: {
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
}): PersistedTermsVersion {
  return {
    id: row.id,
    dealId: row.dealId,
    version: row.version,
    scope: row.scope,
    deliverablesJson: row.deliverablesJson,
    scheduleJson: row.scheduleJson,
    priceAmountMinor: row.priceAmountMinor,
    priceCurrency: row.priceCurrency,
    revisionAllowance: row.revisionAllowance,
    rightsSummary: row.rightsSummary,
    fundingDeadlineAt: row.fundingDeadlineAt,
    aiProvider: row.aiProvider,
    aiModelId: row.aiModelId,
    aiFallbackUsed: row.aiFallbackUsed,
    draftedByUserId: row.draftedByUserId,
    draftedAt: row.draftedAt,
    createdAt: row.createdAt,
  };
}
