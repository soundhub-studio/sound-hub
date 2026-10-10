"use client";

// ProjectRequest detail page (M2 #88).
//
// Background: ticket #88 acceptance criteria require a dedicated
// `/project-requests/[id]` surface that renders the buyer-side
// "Awaiting response" view OR the seller-side Accept/Decline
// bounded region depending on which Workspace the human is
// acting as. The page reuses the existing SessionProvider,
// fetchProjectRequest client, and Accept/Decline client methods.
//
// The page is read-only against the ProjectRequestPublicV1 DTO
// already exposed by the API; the Accept/Decline calls are the
// only state transitions. The page does NOT re-fetch the
// ProjectBrief originalText (it surfaces the bounded `briefExcerpt`
// from the ProjectRequest DTO and a structured constraints summary)
// — surfacing the full brief is a deliberate M2 follow-up that
// requires a separate ProjectBrief GET endpoint the M2 spec
// already calls out but does not require for #88.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { ProjectRequestPublicV1 } from "@soundhub/types";
import { useSession } from "../../components/SessionProvider";
import { Card } from "../../components/ui/Card";
import { fetchProjectRequest } from "../../lib/project-requests-client";

interface ProjectRequestDetailPageProps {
  readonly params: Promise<{ readonly projectRequestId: string }>;
}

export default function ProjectRequestDetailPage({
  params,
}: ProjectRequestDetailPageProps): JSX.Element {
  const [resolvedId, setResolvedId] = useState<string>("");
  useEffect(() => {
    let cancelled = false;
    void params.then((p) => {
      if (!cancelled) setResolvedId(p.projectRequestId);
    });
    return () => {
      cancelled = true;
    };
  }, [params]);
  const projectRequestId = resolvedId;

  const { user, loading } = useSession();
  const [actingWorkspaceId, setActingWorkspaceId] = useState<string>("");
  const [request, setRequest] = useState<ProjectRequestPublicV1 | null>(null);
  const [loadingRequest, setLoadingRequest] = useState<boolean>(false);
  const [bootstrapComplete, setBootstrapComplete] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<"accept" | "decline" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  // The human can act on the request from either the buyer
  // Workspace or the seller Workspace. List every Workspace the
  // user belongs to that matches either side of the request.
  const eligibleWorkspaces = useMemo(() => {
    if (!user || !request) return [] as const;
    return user.workspaces.filter(
      (w) =>
        w.workspaceId === request.buyerWorkspaceId || w.workspaceId === request.sellerWorkspaceId,
    );
  }, [user, request]);

  useEffect(() => {
    if (eligibleWorkspaces.length === 0) {
      setActingWorkspaceId("");
      return;
    }
    if (
      !actingWorkspaceId ||
      !eligibleWorkspaces.some((w) => w.workspaceId === actingWorkspaceId)
    ) {
      setActingWorkspaceId(eligibleWorkspaces[0]!.workspaceId);
    }
  }, [eligibleWorkspaces, actingWorkspaceId]);

  const reload = useCallback(
    async (workspaceId: string) => {
      if (!workspaceId || !projectRequestId) return;
      setLoadingRequest(true);
      setError(null);
      try {
        const result = await fetchProjectRequest(projectRequestId, workspaceId);
        setRequest(result.projectRequest);
      } catch (err) {
        if (
          err instanceof Error &&
          ((err as { code?: string }).code === "SESSION_INVALID" ||
            (err as { code?: string }).code === "AUTH_FAILED" ||
            (err as { code?: string }).code === "SESSION_EXPIRED")
        ) {
          // The SessionProvider will refresh the session state on
          // its own; we do not need to surface a duplicate error
          // here.
          setRequest(null);
          return;
        }
        setError(err instanceof Error ? err.message : "Could not load the ProjectRequest.");
      } finally {
        setLoadingRequest(false);
      }
    },
    [projectRequestId],
  );

  // Bootstrap: pick the first matching Workspace and load.
  useEffect(() => {
    if (!user || !projectRequestId || request) return;
    let cancelled = false;
    void (async () => {
      const targetIds = user.workspaces.map((w) => w.workspaceId);
      // Try each workspace in turn; the first that returns a
      // non-404 result is the acting side. A 404 collapses to
      // PROJECT_REQUEST_NOT_FOUND so the surface never reveals
      // whether the row exists.
      for (const candidate of targetIds) {
        if (cancelled) return;
        try {
          const result = await fetchProjectRequest(projectRequestId, candidate);
          if (cancelled) return;
          setRequest(result.projectRequest);
          setActingWorkspaceId(candidate);
          setBootstrapComplete(true);
          return;
        } catch {
          // continue
        }
      }
      if (!cancelled) {
        setBootstrapComplete(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, projectRequestId, request]);

  // After a successful bootstrap, keep the view in sync with the
  // active selection (the user may switch acting Workspace via
  // the Shell selector).
  useEffect(() => {
    if (!actingWorkspaceId || !request) return;
    void reload(actingWorkspaceId);
  }, [actingWorkspaceId, reload, request]);

  const onAccept = useCallback(async () => {
    if (!actingWorkspaceId || !projectRequestId) return;
    setSubmitting("accept");
    setActionError(null);
    setActionSuccess(null);
    try {
      const { acceptProjectRequest } = await import("../../lib/project-requests-client");
      const result = await acceptProjectRequest(projectRequestId, { actingWorkspaceId });
      setActionSuccess(
        `Accepted — a Negotiating Deal (${result.deal.dealId}) was created. Redirecting…`,
      );
      // Navigate to the new Deal page so the seller can review the
      // initial TermsVersion.
      window.location.assign(`/deals/${result.deal.dealId}`);
    } catch (err) {
      if (
        err instanceof Error &&
        ((err as { code?: string }).code === "SESSION_INVALID" ||
          (err as { code?: string }).code === "AUTH_FAILED" ||
          (err as { code?: string }).code === "SESSION_EXPIRED")
      ) {
        // session already refreshed by the provider
      } else {
        setActionError(err instanceof Error ? err.message : "Could not accept the request.");
      }
    } finally {
      setSubmitting(null);
    }
  }, [actingWorkspaceId, projectRequestId]);

  const onDecline = useCallback(async () => {
    if (!actingWorkspaceId || !projectRequestId) return;
    if (!window.confirm("Decline this ProjectRequest? No Deal will be created.")) {
      return;
    }
    setSubmitting("decline");
    setActionError(null);
    setActionSuccess(null);
    try {
      const { declineProjectRequest } = await import("../../lib/project-requests-client");
      await declineProjectRequest(projectRequestId, { actingWorkspaceId });
      setActionSuccess("Declined — no Deal was created.");
      await reload(actingWorkspaceId);
    } catch (err) {
      if (
        err instanceof Error &&
        ((err as { code?: string }).code === "SESSION_INVALID" ||
          (err as { code?: string }).code === "AUTH_FAILED" ||
          (err as { code?: string }).code === "SESSION_EXPIRED")
      ) {
        // session already refreshed by the provider
      } else {
        setActionError(err instanceof Error ? err.message : "Could not decline the request.");
      }
    } finally {
      setSubmitting(null);
    }
  }, [actingWorkspaceId, projectRequestId, reload]);

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-12" data-testid="project-request-loading">
        <p className="text-gray-600">Loading…</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-12" data-testid="project-request-signed-out">
        <Card>
          <Card.Content>
            <p className="text-gray-700">
              You are not signed in.{" "}
              <Link
                href="/login"
                className="text-blue-600 hover:text-blue-700 font-medium"
                data-testid="project-request-sign-in-link"
              >
                Sign in
              </Link>{" "}
              to view this ProjectRequest.
            </p>
          </Card.Content>
        </Card>
      </div>
    );
  }

  if (!request && (loadingRequest || !bootstrapComplete)) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-12" data-testid="project-request-loading">
        <p className="text-gray-600">Loading ProjectRequest…</p>
      </div>
    );
  }

  if (!request) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-12 space-y-4" data-testid="project-request-empty">
        <Card>
          <Card.Header>
            <Card.Title>ProjectRequest not visible</Card.Title>
            <Card.Description>
              Either the ProjectRequest does not exist or your account is not a current member of
              either its buyer or seller Workspace.
            </Card.Description>
          </Card.Header>
        </Card>
      </div>
    );
  }

  const isBuyerSide = actingWorkspaceId === request.buyerWorkspaceId;
  const isSellerSide = actingWorkspaceId === request.sellerWorkspaceId;
  const side = isBuyerSide ? "Buyer" : isSellerSide ? "Seller" : null;
  const buyerLabel = request.buyerWorkspaceName ?? "Buyer Workspace";
  const sellerLabel = request.sellerWorkspaceName ?? "Seller Workspace";
  const offeringLabel = request.serviceOfferingTitle ?? "ServiceOffering";
  const briefExcerpt = request.briefExcerpt ?? "Brief content unavailable.";
  const canDecide = request.status === "Pending" && isSellerSide && submitting === null;

  return (
    <div className="max-w-3xl mx-auto px-6 py-12 space-y-6" data-testid="project-request-page">
      <Card data-testid="project-request-header">
        <Card.Header>
          <Card.Title>
            {request.status === "Pending"
              ? "Awaiting response"
              : `ProjectRequest ${request.status.toLowerCase()}`}
          </Card.Title>
          <Card.Description>
            {isBuyerSide
              ? "You sent this ProjectRequest. The seller has not yet responded. No Deal, approval, funding, or work has started."
              : isSellerSide
                ? "This is a buyer's invitation to discuss a project. Accepting atomically creates one Negotiating Deal and one AI-drafted, unapproved current TermsVersion. It does not approve terms. It does not begin work."
                : "You are not a current member of either side of this ProjectRequest."}
          </Card.Description>
        </Card.Header>
        <Card.Content>
          <p className="text-sm text-gray-700" data-testid="project-request-side">
            Acting side: <strong>{side ?? "none"}</strong>
          </p>
          <p className="text-sm text-gray-700" data-testid="project-request-parties">
            Buyer: <strong>{buyerLabel}</strong> · Seller: <strong>{sellerLabel}</strong>
          </p>
          <p className="text-sm text-gray-700" data-testid="project-request-offering">
            ServiceOffering: <strong>{offeringLabel}</strong>
          </p>
        </Card.Content>
      </Card>

      <Card data-testid="project-request-workspace-card">
        <Card.Header>
          <Card.Title>Acting Workspace</Card.Title>
          <Card.Description>
            Pick the side of the ProjectRequest you are acting for. Each side sees the same
            ProjectRequest; only the seller side can accept or decline.
          </Card.Description>
        </Card.Header>
        <Card.Content>
          {eligibleWorkspaces.length === 0 ? (
            <p className="text-sm text-red-700" data-testid="project-request-no-acting-workspace">
              Your account is not a current member of this ProjectRequest's buyer or seller
              Workspace.
            </p>
          ) : (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-gray-900">Acting Workspace</legend>
              {eligibleWorkspaces.map((workspace) => {
                const side =
                  workspace.workspaceId === request.buyerWorkspaceId ? "Buyer" : "Seller";
                return (
                  <label
                    key={workspace.workspaceId}
                    className={`flex items-start gap-3 border rounded-md p-3 cursor-pointer ${
                      actingWorkspaceId === workspace.workspaceId
                        ? "border-blue-500 bg-blue-50"
                        : "border-gray-200"
                    }`}
                    data-testid="project-request-workspace-option"
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
                      data-testid="project-request-workspace-radio"
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

      <Card data-testid="project-request-brief-card">
        <Card.Header>
          <Card.Title>ProjectBrief</Card.Title>
          <Card.Description>
            The buyer's structured description of the requested work. This is the same ProjectBrief
            the seller saw in the Matchmaker results.
          </Card.Description>
        </Card.Header>
        <Card.Content>
          <p className="text-sm text-gray-900 break-words" data-testid="project-request-brief">
            {briefExcerpt}
          </p>
          <p className="mt-2 text-xs text-gray-500" data-testid="project-request-constraints">
            The buyer's required constraints (e.g. service mode, ServiceCategory) are enforced at
            the Matchmaker boundary; see the seller's matchmaker record for the full set.
          </p>
        </Card.Content>
      </Card>

      <Card data-testid="project-request-no-deal-card">
        <Card.Header>
          <Card.Title>No Deal, approval, funding, or work yet</Card.Title>
        </Card.Header>
        <Card.Content>
          <p className="text-sm text-gray-700">
            No Deal has been created from this ProjectRequest. No TermsVersion has been approved. No
            funding has been initiated. No work has begun. The seller's Accept/Decline below is the
            only command that changes this state.
          </p>
        </Card.Content>
      </Card>

      {error && (
        <p className="text-sm text-red-700" data-testid="project-request-error">
          {error}
        </p>
      )}

      {actionError && (
        <p className="text-sm text-red-700" data-testid="project-request-action-error">
          {actionError}
        </p>
      )}

      {actionSuccess && (
        <p className="text-sm text-green-700" data-testid="project-request-action-success">
          {actionSuccess}
        </p>
      )}

      <Card data-testid="project-request-decision-card">
        <Card.Header>
          <Card.Title>Seller response</Card.Title>
          <Card.Description>
            Only the seller side can accept or decline. The full acting Workspace is named below so
            the consequence is unambiguous.
          </Card.Description>
        </Card.Header>
        <Card.Content>
          <p className="text-sm text-gray-700" data-testid="project-request-decision-context">
            Acting Workspace:{" "}
            <strong>
              {eligibleWorkspaces.find((w) => w.workspaceId === actingWorkspaceId)?.name ??
                "unknown"}
            </strong>{" "}
            (side: <strong>{side ?? "none"}</strong>).
          </p>
          <p className="mt-2 text-sm text-gray-700" data-testid="project-request-decision-effects">
            Accepting atomically creates one Negotiating Deal AND one AI-drafted, unapproved current
            TermsVersion. It does not approve terms. It does not begin or fund any work. Declining
            records the decision and creates no Deal.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                void onAccept();
              }}
              disabled={!canDecide}
              className="bg-coral text-white px-3 py-1.5 rounded-md text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-colors"
              data-testid="project-request-accept"
            >
              {submitting === "accept" ? "Accepting…" : "Accept"}
            </button>
            <button
              type="button"
              onClick={() => {
                void onDecline();
              }}
              disabled={!canDecide}
              className="bg-white text-red-700 border border-red-300 px-3 py-1.5 rounded-md text-sm font-medium hover:bg-red-50 disabled:opacity-50 transition-colors"
              data-testid="project-request-decline"
            >
              {submitting === "decline" ? "Declining…" : "Decline"}
            </button>
          </div>
          {request.status === "Accepted" && request.sellerConsentAt && (
            <p className="mt-4 text-sm text-green-700" data-testid="project-request-accepted">
              Accepted at {new Date(request.sellerConsentAt).toLocaleString()}. A Negotiating Deal
              was created. Open the Deal page to review the initial TermsVersion.
            </p>
          )}
          {request.status === "Declined" && (
            <p className="mt-4 text-sm text-gray-700" data-testid="project-request-declined">
              Declined at{" "}
              {request.sellerDecisionAt
                ? new Date(request.sellerDecisionAt).toLocaleString()
                : "unknown time"}
              . No Deal was created.
            </p>
          )}
          {request.status === "Pending" && !isSellerSide && (
            <p
              className="mt-4 text-sm text-gray-500"
              data-testid="project-request-decision-disabled"
            >
              Only the seller side can accept or decline. Switch the acting Workspace to the seller
              side to decide.
            </p>
          )}
        </Card.Content>
      </Card>

      {error === null && request.status !== "Pending" && request.sellerDecisionAt && (
        <p className="text-xs text-gray-500" data-testid="project-request-decided-at">
          Decision recorded at {new Date(request.sellerDecisionAt).toLocaleString()}.
        </p>
      )}
    </div>
  );
}
