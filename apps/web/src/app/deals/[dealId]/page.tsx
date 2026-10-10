"use client";

// Deal page (BG5 + BG6).
//
// Background: ticket #63 requires the buyer + seller surfaces for
// reviewing the current TermsVersion, approving it, and reading the
// deal state. Ticket #64 adds the BG6 funding surface: the buyer's
// authorized human can explicitly initiate sandbox escrow funding
// after both parties have approved the current TermsVersion; the
// page re-uses the BG1 SessionProvider and refreshes the Deal view
// after a successful fund.
//
// Per ticket #63 + the locked plan:
//   - Renders the Deal metadata + current TermsVersion.
//   - The "AI-drafted · unapproved" badge is driven by the
//     `aiDraftedUnapprovedBadge: true` literal on the public DTO so
//     the UI cannot silently drop it.
//   - The funding deadline is displayed only; passage carries no
//     Golden Slice state effect.
//   - Approval forms are capability-gated: buyer Workspace for
//     buyer-side approval, seller Workspace for seller-side
//     approval. The application policy revalidates the explicit
//     DealApprover authorization server-side; the UI does NOT make
//     the authorization decision.
//   - No Navigation destination. The existing workflow links to
//     /deals/:dealId directly.
//
// BG6 funding surface (ticket #64):
//   - FundingCard is gated to `isBuyerSide && deal.status ===
//     "Negotiating" && bothPartiesApproved`.
//   - Every funding surface renders the "Sandbox · simulated" badge
//     so a real network connection is never claimed.
//   - The public funding-status DTO carries NO internal identifiers
//     (paymentIntentId, correlationId, providerReference, raw
//     failureDetail, internal providerState). The FundingCard
//     renders only the allow-listed fields.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type {
  Bg5DealApprovalPublicV1,
  Bg5SellerConsentProjectionV1,
  Bg5TermsVersionPublicV1,
  Bg6FundingConfirmationPublicV1,
  DealPublicV1,
  MarketplaceCapabilityV1,
} from "@soundhub/types";
import { useSession } from "../../components/SessionProvider";
import { Card } from "../../components/ui/Card";
import { approveTerms, draftTerms, fetchDeal } from "../../lib/deal-terms-client";
import { fundDeal } from "../../lib/funding-client";
import {
  buildApprovalStatusRows,
  buildApprovalSuccessCopy,
  buildAiDraftStatusLabel,
  buildDealSummaryCopy,
  buildFundingBadgeLabel,
  buildPublicFundingStatusCopy,
  buildSellerConsentLabel,
  getDealPartySide,
  shouldShowDraftTermsControl,
} from "../deal-summary-copy";
import { findVisibleDeal } from "../find-visible-deal";

interface DealPageProps {
  // Next.js 15's `PageProps.params` is a Promise; await it in the
  // client component to keep the route type-compatible.
  readonly params: Promise<{ readonly dealId: string }>;
}

export default function DealPage({ params }: DealPageProps): JSX.Element {
  const [resolvedDealId, setResolvedDealId] = useState<string>("");
  useEffect(() => {
    let cancelled = false;
    void params.then((p) => {
      if (!cancelled) setResolvedDealId(p.dealId);
    });
    return () => {
      cancelled = true;
    };
  }, [params]);
  const dealId = resolvedDealId;
  const { user, loading, refresh } = useSession();
  const [actingWorkspaceId, setActingWorkspaceId] = useState<string>("");
  const [deal, setDeal] = useState<DealPublicV1 | null>(null);
  const [currentTermsVersion, setCurrentTermsVersion] = useState<Bg5TermsVersionPublicV1 | null>(
    null,
  );
  const [currentApprovals, setCurrentApprovals] = useState<readonly Bg5DealApprovalPublicV1[]>([]);
  // M2 (#88) Codex finding: derived from the durable
  // `(workspaceId, userId)` `deal_approvers` row. The page
  // uses this signal to render the permission CTA and the
  // approve CTA MUTUALLY EXCLUSIVELY (only ONE may show at a
  // time). False when the row is absent OR when the lookup
  // failed (fail-closed).
  const [actingSideHasDealApprover, setActingSideHasDealApprover] = useState<boolean>(false);
  const [sellerConsent, setSellerConsent] = useState<Bg5SellerConsentProjectionV1 | null>(null);
  const [loadingDeal, setLoadingDeal] = useState<boolean>(false);
  const [bootstrapComplete, setBootstrapComplete] = useState<boolean>(false);
  const bootstrapKeyRef = useRef<string | null>(null);
  const [submitting, setSubmitting] = useState<"draft" | "approve" | "fund" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [fundingStatus, setFundingStatus] = useState<Bg6FundingConfirmationPublicV1 | null>(null);
  const [fundingError, setFundingError] = useState<string | null>(null);
  const [fundingSuccess, setFundingSuccess] = useState<string | null>(null);

  const candidateWorkspaces = useMemo(() => {
    if (!deal) return [] as const;
    const ids = new Set<string>([deal.buyerWorkspaceId, deal.sellerWorkspaceId]);
    return user?.workspaces.filter((w) => ids.has(w.workspaceId)) ?? [];
  }, [user, deal]);

  const reload = useCallback(
    async (workspaceId: string) => {
      if (!workspaceId) {
        setDeal(null);
        setCurrentTermsVersion(null);
        setCurrentApprovals([]);
        setSellerConsent(null);
        setActingSideHasDealApprover(false);
        return;
      }
      setLoadingDeal(true);
      setError(null);
      try {
        const result = await fetchDeal(dealId, workspaceId);
        setDeal(result.deal.deal);
        setCurrentTermsVersion(result.deal.currentTermsVersion);
        setCurrentApprovals(result.deal.currentApprovals);
        setSellerConsent(result.deal.sellerConsent);
        setActingSideHasDealApprover(result.deal.actingSideHasDealApprover);
      } catch (err) {
        if (
          err instanceof Error &&
          ((err as { code?: string }).code === "SESSION_INVALID" ||
            (err as { code?: string }).code === "AUTH_FAILED" ||
            (err as { code?: string }).code === "SESSION_EXPIRED")
        ) {
          void refresh();
          return;
        }
        setError(err instanceof Error ? err.message : "Could not load the Deal.");
      } finally {
        setLoadingDeal(false);
      }
    },
    [dealId, refresh],
  );

  useEffect(() => {
    if (candidateWorkspaces.length === 0) {
      setDeal(null);
      setCurrentTermsVersion(null);
      setCurrentApprovals([]);
      setSellerConsent(null);
      setActingSideHasDealApprover(false);
      return;
    }
    if (
      !actingWorkspaceId ||
      !candidateWorkspaces.some((w) => w.workspaceId === actingWorkspaceId)
    ) {
      setActingWorkspaceId(candidateWorkspaces[0]!.workspaceId);
    }
  }, [candidateWorkspaces, actingWorkspaceId]);

  useEffect(() => {
    void reload(actingWorkspaceId);
  }, [actingWorkspaceId, reload]);

  useEffect(() => {
    if (!user || !dealId || deal || actingWorkspaceId) return;
    const bootstrapKey = `${dealId}:${user.userAccountId}`;
    if (bootstrapKeyRef.current === bootstrapKey) return;
    bootstrapKeyRef.current = bootstrapKey;
    setBootstrapComplete(false);
    setLoadingDeal(true);
    setError(null);

    let cancelled = false;
    void findVisibleDeal({
      dealId,
      workspaceIds: user.workspaces.map((workspace) => workspace.workspaceId),
      fetchDeal,
    })
      .then((result) => {
        if (cancelled) return;
        setActingWorkspaceId(result.actingWorkspaceId);
        setDeal(result.response.deal.deal);
        setCurrentTermsVersion(result.response.deal.currentTermsVersion);
        setCurrentApprovals(result.response.deal.currentApprovals);
        setSellerConsent(result.response.deal.sellerConsent);
        setActingSideHasDealApprover(result.response.deal.actingSideHasDealApprover);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (
          err instanceof Error &&
          ((err as { code?: string }).code === "SESSION_INVALID" ||
            (err as { code?: string }).code === "AUTH_FAILED" ||
            (err as { code?: string }).code === "SESSION_EXPIRED")
        ) {
          void refresh();
          return;
        }
        setError(err instanceof Error ? err.message : "Could not load the Deal.");
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingDeal(false);
          setBootstrapComplete(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [actingWorkspaceId, deal, dealId, refresh, user]);

  const onDraft = useCallback(async () => {
    if (!actingWorkspaceId) return;
    setSubmitting("draft");
    setError(null);
    setSuccess(null);
    try {
      const result = await draftTerms(dealId, { actingWorkspaceId });
      setSuccess(`Drafted TermsVersion ${result.termsVersion.version}.`);
      await reload(actingWorkspaceId);
    } catch (err) {
      if (
        err instanceof Error &&
        ((err as { code?: string }).code === "SESSION_INVALID" ||
          (err as { code?: string }).code === "AUTH_FAILED" ||
          (err as { code?: string }).code === "SESSION_EXPIRED")
      ) {
        void refresh();
      } else {
        setError(err instanceof Error ? err.message : "Could not draft terms.");
      }
    } finally {
      setSubmitting(null);
    }
  }, [actingWorkspaceId, dealId, reload, refresh]);

  const onApprove = useCallback(async () => {
    if (!actingWorkspaceId || !currentTermsVersion || !deal) return;
    const approvalSide = getDealPartySide({
      workspaceId: actingWorkspaceId,
      buyerWorkspaceId: deal.buyerWorkspaceId,
      sellerWorkspaceId: deal.sellerWorkspaceId,
    });
    if (!approvalSide) return;
    setSubmitting("approve");
    setError(null);
    setSuccess(null);
    try {
      await approveTerms(dealId, {
        actingWorkspaceId,
        termsVersionId: currentTermsVersion.termsVersionId,
      });
      setSuccess(buildApprovalSuccessCopy(approvalSide, currentTermsVersion.version));
      await reload(actingWorkspaceId);
    } catch (err) {
      if (
        err instanceof Error &&
        ((err as { code?: string }).code === "SESSION_INVALID" ||
          (err as { code?: string }).code === "AUTH_FAILED" ||
          (err as { code?: string }).code === "SESSION_EXPIRED")
      ) {
        void refresh();
      } else {
        setError(err instanceof Error ? err.message : "Could not approve terms.");
      }
    } finally {
      setSubmitting(null);
    }
  }, [actingWorkspaceId, currentTermsVersion, deal, dealId, reload, refresh]);

  const onFund = useCallback(async () => {
    if (!actingWorkspaceId) return;
    setSubmitting("fund");
    setFundingError(null);
    setFundingSuccess(null);
    try {
      const result = await fundDeal(dealId, { actingWorkspaceId });
      setFundingStatus(result.fundingStatus);
      setFundingSuccess(
        result.fundingStatus.status === "Confirmed"
          ? "Funding confirmed; the Deal is Active."
          : `Funding recorded: ${buildPublicFundingStatusCopy(
              result.fundingStatus.status,
              result.fundingStatus.sanitizedFailureReason,
            )}`,
      );
      await reload(actingWorkspaceId);
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code === "SESSION_INVALID" || code === "AUTH_FAILED" || code === "SESSION_EXPIRED") {
        void refresh();
        return;
      }
      setFundingError(
        (err as { message?: string } | null)?.message ??
          "Funding request failed. Please try again in a moment.",
      );
    } finally {
      setSubmitting(null);
    }
  }, [actingWorkspaceId, dealId, refresh, reload]);

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-12" data-testid="deal-loading">
        <p className="text-gray-600">Loading Deal…</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-12" data-testid="deal-signed-out">
        <Card>
          <Card.Content>
            <p className="text-gray-700">
              You are not signed in.{" "}
              <Link
                href="/login"
                className="text-blue-600 hover:text-blue-700 font-medium"
                data-testid="deal-sign-in-link"
              >
                Sign in
              </Link>{" "}
              to view this Deal.
            </p>
          </Card.Content>
        </Card>
      </div>
    );
  }

  if (!deal && (loadingDeal || !bootstrapComplete)) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-12" data-testid="deal-loading">
        <p className="text-gray-600">Loading Deal…</p>
      </div>
    );
  }

  if (!deal) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-12 space-y-4" data-testid="deal-empty">
        <Card>
          <Card.Header>
            <Card.Title>Deal not visible</Card.Title>
            <Card.Description>
              Either the Deal does not exist or your account is not a current member of one of its
              buyer / seller Workspaces.
            </Card.Description>
          </Card.Header>
        </Card>
      </div>
    );
  }

  const isBuyerSide = actingWorkspaceId === deal.buyerWorkspaceId;
  const isSellerSide = actingWorkspaceId === deal.sellerWorkspaceId;
  const capabilityRequired: MarketplaceCapabilityV1 | null = isBuyerSide
    ? "Buyer"
    : isSellerSide
      ? "Seller"
      : null;
  const alreadyApproved =
    currentTermsVersion !== null &&
    currentApprovals.some((a) => a.workspaceId === actingWorkspaceId);
  // M2 (#88) Codex finding: the permission CTA and the
  // approve CTA are MUTUALLY EXCLUSIVE. The permission CTA
  // shows only when the acting human lacks an explicit
  // `DealApprover` authorization; the approve CTA shows only
  // when they have one. The signal is the durable
  // `(workspaceId, userId)` `deal_approvers` row, NOT the
  // approval history. A side that has never approved may
  // still hold a DealApprover (e.g. provisioned via the
  // dashboard readiness task) — only the durable row
  // proves it.
  const hasCapabilityForDecision =
    capabilityRequired !== null &&
    currentTermsVersion !== null &&
    currentTermsVersion.isCurrentVersion &&
    !alreadyApproved;
  const showApprove = hasCapabilityForDecision && actingSideHasDealApprover;
  const showPermissionCta = hasCapabilityForDecision && !actingSideHasDealApprover;
  const dealSummaryCopy = buildDealSummaryCopy(deal.status);

  // BG6 funding state. The FundingCard renders a single allow-listed
  // public funding-status DTO; the page does not retain any
  // internal PaymentIntent identifiers.
  const fundingBadgeLabel = buildFundingBadgeLabel();

  // Compute the approval rows at the page level so the funding-gate
  // predicate (above) and the inner TermsVersionView share the same
  // evaluation.
  const pageApprovalRows = buildApprovalStatusRows({
    buyerWorkspaceId: deal.buyerWorkspaceId,
    sellerWorkspaceId: deal.sellerWorkspaceId,
    approvals: currentApprovals,
  });
  const bothPartiesApprovedAtPage = pageApprovalRows.every((row) => row.approvedAt !== null);
  const isAwaitingFunding =
    deal.status === "Negotiating" &&
    currentTermsVersion !== null &&
    currentTermsVersion.isCurrentVersion &&
    bothPartiesApprovedAtPage;

  return (
    <div className="max-w-3xl mx-auto px-6 py-12 space-y-6" data-testid="deal-page">
      <Card data-testid="deal-header">
        <Card.Header>
          <Card.Title>{dealSummaryCopy.title}</Card.Title>
          <Card.Description>{dealSummaryCopy.description}</Card.Description>
        </Card.Header>
        <Card.Content>
          {(() => {
            const sellerConsentCopy = buildSellerConsentLabel(sellerConsent);
            if (sellerConsentCopy === null) return null;
            return (
              <p
                className="text-sm text-gray-700"
                data-testid="deal-seller-consent"
                data-consent-status="Accepted"
              >
                {sellerConsentCopy.label}
              </p>
            );
          })()}
        </Card.Content>
      </Card>

      <Card data-testid="deal-workspace-card">
        <Card.Header>
          <Card.Title>Acting Workspace</Card.Title>
          <Card.Description>
            Pick one of the Deal's Workspaces to act as. Each side sees the same TermsVersion; the
            approval forms below are capability-gated.
          </Card.Description>
        </Card.Header>
        <Card.Content>
          {candidateWorkspaces.length === 0 ? (
            <p className="text-sm text-red-700" data-testid="deal-no-acting-workspace">
              Your account is not a current member of this Deal's buyer or seller Workspace.
            </p>
          ) : (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-gray-900">Acting Workspace</legend>
              {candidateWorkspaces.map((workspace) => {
                const side = workspace.workspaceId === deal.buyerWorkspaceId ? "Buyer" : "Seller";
                return (
                  <label
                    key={workspace.workspaceId}
                    className={`flex items-start gap-3 border rounded-md p-3 cursor-pointer ${
                      actingWorkspaceId === workspace.workspaceId
                        ? "border-blue-500 bg-blue-50"
                        : "border-gray-200"
                    }`}
                    data-testid="deal-workspace-option"
                    data-workspace-id={workspace.workspaceId}
                    data-side={side}
                  >
                    <input
                      type="radio"
                      name="actingWorkspaceId"
                      value={workspace.workspaceId}
                      checked={actingWorkspaceId === workspace.workspaceId}
                      onChange={() => setActingWorkspaceId(workspace.workspaceId)}
                      className="mt-1"
                      data-testid="deal-workspace-radio"
                    />
                    <span>
                      <span className="block text-sm font-medium text-gray-900">
                        {workspace.name} ({side})
                      </span>
                      <span className="block text-xs text-gray-500">
                        {workspace.workspaceType} · {workspace.workspaceStatus}
                      </span>
                    </span>
                  </label>
                );
              })}
            </fieldset>
          )}
        </Card.Content>
      </Card>

      <Card data-testid="deal-funding-card">
        <Card.Header>
          <Card.Title>Escrow funding</Card.Title>
          <Card.Description>
            <span
              className="inline-block text-xs uppercase tracking-wide px-2 py-1 rounded bg-amber-100 text-amber-800 mr-2"
              data-testid="deal-funding-badge"
            >
              {fundingBadgeLabel}
            </span>
            PaymentIntent persisted (sandbox, deterministic). After both parties approve the current
            TermsVersion, the buyer's authorized human can fund the Deal here. The
            MockEscrowProvider returns a deterministic confirmation; the Deal becomes Active
            atomically with the confirmation.
          </Card.Description>
        </Card.Header>
        <Card.Content>
          {fundingStatus && (
            <p
              className={`text-sm mb-3 ${
                fundingStatus.status === "Confirmed"
                  ? "text-green-700"
                  : fundingStatus.status === "Failed"
                    ? "text-red-700"
                    : "text-gray-700"
              }`}
              data-testid="deal-funding-status"
            >
              {buildPublicFundingStatusCopy(
                fundingStatus.status,
                fundingStatus.sanitizedFailureReason,
              )}
              {fundingStatus.confirmationTime !== null
                ? ` · confirmation time: ${fundingStatus.confirmationTime}`
                : ""}
              {" · network: "}
              <code className="text-xs">{fundingStatus.networkLabel}</code>
            </p>
          )}
          {fundingError && (
            <p className="text-sm text-red-700 mb-3" data-testid="deal-funding-error">
              {fundingError}
            </p>
          )}
          {fundingSuccess && (
            <p className="text-sm text-green-700 mb-3" data-testid="deal-funding-success">
              {fundingSuccess}
            </p>
          )}
          {deal.status === "Negotiating" && isBuyerSide && (
            <button
              type="button"
              onClick={() => {
                void onFund();
              }}
              disabled={submitting !== null || !isAwaitingFunding}
              className="bg-green-600 text-white px-3 py-1.5 rounded-md text-sm font-medium hover:bg-green-700 disabled:opacity-50 transition-colors"
              data-testid="deal-fund-button"
            >
              {submitting === "fund" ? "Funding…" : "Fund sandbox escrow"}
            </button>
          )}
          {deal.status === "Active" && (
            <p className="text-sm text-gray-700" data-testid="deal-active-terminal">
              Deal Active — escrow funded; commissioned work may begin.
            </p>
          )}
        </Card.Content>
      </Card>

      <Card data-testid="deal-terms-card">
        <Card.Header>
          <Card.Title>Current TermsVersion</Card.Title>
          <Card.Description>
            The TermsVersion below is the proposal both parties must independently approve.
          </Card.Description>
        </Card.Header>
        <Card.Content>
          {error && (
            <p className="text-sm text-red-700 mb-3" data-testid="deal-error">
              {error}
            </p>
          )}
          {success && (
            <p className="text-sm text-green-700 mb-3" data-testid="deal-success">
              {success}
            </p>
          )}
          {loadingDeal ? (
            <p className="text-sm text-gray-600" data-testid="deal-loading-list">
              Loading…
            </p>
          ) : currentTermsVersion ? (
            <TermsVersionView
              tv={currentTermsVersion}
              approvals={currentApprovals}
              buyerWorkspaceId={deal.buyerWorkspaceId}
              sellerWorkspaceId={deal.sellerWorkspaceId}
              onDraft={() => {
                void onDraft();
              }}
              onApprove={() => {
                void onApprove();
              }}
              onPermissionCta={
                showPermissionCta
                  ? () => {
                      // M2 (#88) Codex finding: thread the acting
                      // Workspace through the URL so the
                      // destination page can revalidate the
                      // exact selection against the Deal view
                      // (the human must be a current member AND
                      // a party to this Deal) instead of
                      // silently choosing the first Workspace
                      // that can read the Deal.
                      window.location.assign(
                        `/deals/${deal.dealId}/approve-permission?actingWorkspaceId=${encodeURIComponent(actingWorkspaceId)}`,
                      );
                    }
                  : null
              }
              submitting={submitting}
              showDraftButton={shouldShowDraftTermsControl(
                deal.status,
                capabilityRequired !== null,
              )}
              showApproveButton={showApprove}
            />
          ) : (
            <div className="space-y-3" data-testid="deal-no-terms">
              <p className="text-sm text-gray-700">
                No TermsVersion has been drafted for this Deal yet.
              </p>
              {capabilityRequired !== null && (
                <button
                  type="button"
                  onClick={() => {
                    void onDraft();
                  }}
                  disabled={submitting !== null}
                  className="bg-blue-600 text-white px-3 py-1.5 rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
                  data-testid="deal-draft-button"
                >
                  {submitting === "draft" ? "Drafting…" : "Draft TermsVersion"}
                </button>
              )}
            </div>
          )}
        </Card.Content>
      </Card>
    </div>
  );
}

function TermsVersionView({
  tv,
  approvals,
  buyerWorkspaceId,
  sellerWorkspaceId,
  onDraft,
  onApprove,
  onPermissionCta,
  submitting,
  showDraftButton,
  showApproveButton,
}: {
  readonly tv: Bg5TermsVersionPublicV1;
  readonly approvals: readonly Bg5DealApprovalPublicV1[];
  readonly buyerWorkspaceId: string;
  readonly sellerWorkspaceId: string;
  readonly onDraft: () => void;
  readonly onApprove: () => void;
  // M2 (#88): the aubergine "Permission to approve terms" CTA
  // routes the human to the JIT setup page when set. Null hides
  // the CTA (the human is on a different side, already
  // approved, or the page is read-only).
  readonly onPermissionCta: (() => void) | null;
  readonly submitting: "draft" | "approve" | "fund" | null;
  readonly showDraftButton: boolean;
  readonly showApproveButton: boolean;
}): JSX.Element {
  const approvalRows = buildApprovalStatusRows({
    buyerWorkspaceId,
    sellerWorkspaceId,
    approvals,
  });
  const aiDraftStatusLabel = buildAiDraftStatusLabel(approvalRows);
  const bothPartiesApproved = approvalRows.every((row) => row.approvedAt !== null);
  return (
    <div className="space-y-4" data-testid="deal-terms-view">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-gray-900" data-testid="deal-terms-version-label">
          TermsVersion {tv.version}
        </p>
        <span
          className={`text-xs uppercase tracking-wide px-2 py-1 rounded ${
            bothPartiesApproved ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800"
          }`}
          data-testid="deal-terms-ai-badge"
        >
          {aiDraftStatusLabel}
        </span>
      </div>
      <div>
        <p className="text-xs font-medium text-gray-500 uppercase">Scope</p>
        <p className="text-sm text-gray-900 break-words" data-testid="deal-terms-scope">
          {tv.scope}
        </p>
      </div>
      <div>
        <p className="text-xs font-medium text-gray-500 uppercase">Deliverables</p>
        <ul className="text-sm text-gray-900 list-disc pl-5" data-testid="deal-terms-deliverables">
          {tv.deliverables.map((d, idx) => (
            <li key={idx} data-testid="deal-terms-deliverable">
              <strong>{d.title}</strong> — {d.description}
            </li>
          ))}
        </ul>
      </div>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <p className="text-xs font-medium text-gray-500 uppercase">Schedule</p>
          <p data-testid="deal-terms-schedule">
            {tv.schedule.startDate} → {tv.schedule.endDate} ({tv.schedule.deliveryDays} days)
          </p>
        </div>
        <div>
          <p className="text-xs font-medium text-gray-500 uppercase">Price (USD)</p>
          <p data-testid="deal-terms-price">
            {(tv.price.amountMinor / 100).toFixed(2)} {tv.price.currency}
          </p>
        </div>
        <div>
          <p className="text-xs font-medium text-gray-500 uppercase">Revision allowance</p>
          <p data-testid="deal-terms-revision">{tv.revisionAllowance}</p>
        </div>
        <div>
          <p className="text-xs font-medium text-gray-500 uppercase">Funding deadline</p>
          <p className="text-xs text-gray-500" data-testid="deal-terms-funding-deadline">
            {tv.fundingDeadlineAt
              ? `${formatDatetime(tv.fundingDeadlineAt)} (display only — no Golden Slice state effect)`
              : "Not set"}
          </p>
        </div>
      </div>
      <div>
        <p className="text-xs font-medium text-gray-500 uppercase">Rights summary</p>
        <p className="text-sm text-gray-900 break-words" data-testid="deal-terms-rights">
          {tv.rightsSummary}
        </p>
      </div>
      <div>
        <p className="text-xs font-medium text-gray-500 uppercase">Recorded approvals</p>
        <ul className="text-sm text-gray-900" data-testid="deal-approvals">
          {approvalRows.map((row) => (
            <li key={row.side} data-testid="deal-approval">
              {row.side}:{" "}
              {row.approvedAt ? `Approved at ${formatDatetime(row.approvedAt)}` : "Pending"}
            </li>
          ))}
        </ul>
      </div>
      <div className="flex flex-wrap gap-2">
        {onPermissionCta && (
          <button
            type="button"
            onClick={() => {
              onPermissionCta();
            }}
            disabled={submitting !== null}
            className="inline-flex items-center justify-center min-h-[44px] py-2 px-4 text-sm font-medium text-white bg-aubergine hover:bg-aubergine-hover rounded focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine disabled:opacity-50"
            data-testid="deal-permission-cta"
          >
            Permission to approve terms
          </button>
        )}
        {showDraftButton && (
          <button
            type="button"
            onClick={() => {
              void onDraft();
            }}
            disabled={submitting !== null}
            className="bg-blue-600 text-white px-3 py-1.5 rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
            data-testid="deal-redraft-button"
          >
            {submitting === "draft" ? "Drafting…" : "Draft replacement TermsVersion"}
          </button>
        )}
        {showApproveButton && (
          <button
            type="button"
            onClick={() => {
              void onApprove();
            }}
            disabled={submitting !== null}
            className="inline-flex items-center justify-center min-h-[44px] py-2 px-4 text-sm font-medium text-white bg-aubergine hover:bg-aubergine-hover rounded focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine disabled:opacity-50"
            data-testid="deal-approve-button"
          >
            {submitting === "approve" ? "Approving…" : "Approve this TermsVersion"}
          </button>
        )}
      </div>
    </div>
  );
}

function formatDatetime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}
