"use client";

// Seller inbox page (BG4).
//
// Background: ticket #62 requires the seller-side response UI. After
// signing in as the seller (deterministic identity or managed magic
// link) and selecting a Seller-capable Workspace, the seller sees
// every Pending ProjectRequest addressed to that Workspace. Each
// request has an Accept / Decline action; the response call goes
// through the BG4 API and revalidates current membership, the
// request's Pending status, and the ProjectRequest identity.
//
// The page reuses the BG1 SessionProvider so the same session
// refresh hooks keep the inbox consistent across sign-in / sign-out
// in other tabs.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type {
  AcceptProjectRequestResponseV1,
  DeclineProjectRequestResponseV1,
  ProjectRequestPublicV1,
} from "@soundhub/types";
import { useSession } from "../components/SessionProvider";
import { Card } from "../components/ui/Card";
import {
  acceptProjectRequest,
  declineProjectRequest,
  listProjectRequests,
} from "../lib/project-requests-client";

export default function SellerRequestsPage() {
  const { user, loading, refresh } = useSession();
  const [actingWorkspaceId, setActingWorkspaceId] = useState<string>("");
  const [requests, setRequests] = useState<readonly ProjectRequestPublicV1[]>([]);
  const [loadingList, setLoadingList] = useState<boolean>(false);
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const sellerWorkspaces = useMemo(
    () => user?.workspaces.filter((w) => w.capabilities.includes("Seller")) ?? [],
    [user],
  );

  const reload = useCallback(async (workspaceId: string) => {
    if (!workspaceId) {
      setRequests([]);
      return;
    }
    setLoadingList(true);
    setError(null);
    try {
      const result = await listProjectRequests({
        actingWorkspaceId: workspaceId,
        statusFilter: "Pending",
      });
      setRequests(result.projectRequests);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load requests.");
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    if (sellerWorkspaces.length === 0) {
      setRequests([]);
      return;
    }
    if (!actingWorkspaceId || !sellerWorkspaces.some((w) => w.workspaceId === actingWorkspaceId)) {
      setActingWorkspaceId(sellerWorkspaces[0]!.workspaceId);
    }
  }, [sellerWorkspaces, actingWorkspaceId]);

  useEffect(() => {
    void reload(actingWorkspaceId);
  }, [actingWorkspaceId, reload]);

  const onSessionInvalid = useCallback(() => {
    void refresh();
  }, [refresh]);

  const onAccept = useCallback(
    async (request: ProjectRequestPublicV1) => {
      setSubmittingId(request.projectRequestId);
      setError(null);
      setSuccess(null);
      try {
        const result: AcceptProjectRequestResponseV1 = await acceptProjectRequest(
          request.projectRequestId,
          { actingWorkspaceId },
        );
        setSuccess(`Accepted — a Negotiating Deal (${result.deal.dealId}) was created.`);
        await reload(actingWorkspaceId);
      } catch (err) {
        if (
          err instanceof Error &&
          ((err as { code?: string }).code === "SESSION_INVALID" ||
            (err as { code?: string }).code === "AUTH_FAILED" ||
            (err as { code?: string }).code === "SESSION_EXPIRED")
        ) {
          onSessionInvalid();
        }
        setError(err instanceof Error ? err.message : "Could not accept the request.");
      } finally {
        setSubmittingId(null);
      }
    },
    [actingWorkspaceId, reload, onSessionInvalid],
  );

  const onDecline = useCallback(
    async (request: ProjectRequestPublicV1) => {
      setSubmittingId(request.projectRequestId);
      setError(null);
      setSuccess(null);
      try {
        const result: DeclineProjectRequestResponseV1 = await declineProjectRequest(
          request.projectRequestId,
          { actingWorkspaceId },
        );
        setSuccess(`Declined — no Deal was created.`);
        void result;
        await reload(actingWorkspaceId);
      } catch (err) {
        if (
          err instanceof Error &&
          ((err as { code?: string }).code === "SESSION_INVALID" ||
            (err as { code?: string }).code === "AUTH_FAILED" ||
            (err as { code?: string }).code === "SESSION_EXPIRED")
        ) {
          onSessionInvalid();
        }
        setError(err instanceof Error ? err.message : "Could not decline the request.");
      } finally {
        setSubmittingId(null);
      }
    },
    [actingWorkspaceId, reload, onSessionInvalid],
  );

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-12" data-testid="seller-requests-loading">
        <p className="text-gray-600">Loading inbox…</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-12" data-testid="seller-requests-signed-out">
        <Card>
          <Card.Content>
            <p className="text-gray-700">
              You are not signed in.{" "}
              <Link
                href="/login"
                className="text-blue-600 hover:text-blue-700 font-medium"
                data-testid="seller-requests-sign-in-link"
              >
                Sign in
              </Link>{" "}
              to view your ProjectRequest inbox.
            </p>
          </Card.Content>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-12 space-y-6" data-testid="seller-requests-page">
      <Card data-testid="seller-requests-header">
        <Card.Header>
          <Card.Title>Seller inbox</Card.Title>
          <Card.Description>
            Pending ProjectRequests addressed to your Seller-capable Workspace. Accepting a request
            atomically creates one Negotiating Deal; declining records the decision and creates no
            Deal.
          </Card.Description>
        </Card.Header>
        <Card.Content>
          {sellerWorkspaces.length === 0 ? (
            <p className="text-sm text-red-700" data-testid="seller-requests-no-seller-workspace">
              Your account does not currently belong to a Seller-capable Workspace.
            </p>
          ) : (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-gray-900">Acting Workspace</legend>
              {sellerWorkspaces.map((workspace) => (
                <label
                  key={workspace.workspaceId}
                  className={`flex items-start gap-3 border rounded-md p-3 cursor-pointer ${
                    actingWorkspaceId === workspace.workspaceId
                      ? "border-blue-500 bg-blue-50"
                      : "border-gray-200"
                  }`}
                  data-testid="seller-requests-workspace-option"
                  data-workspace-id={workspace.workspaceId}
                >
                  <input
                    type="radio"
                    name="actingWorkspaceId"
                    value={workspace.workspaceId}
                    checked={actingWorkspaceId === workspace.workspaceId}
                    onChange={() => setActingWorkspaceId(workspace.workspaceId)}
                    className="mt-1"
                    data-testid="seller-requests-workspace-radio"
                  />
                  <span>
                    <span className="block text-sm font-medium text-gray-900">
                      {workspace.name}
                    </span>
                    <span className="block text-xs text-gray-500">
                      {workspace.workspaceType} · {workspace.workspaceStatus}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
          )}
        </Card.Content>
      </Card>

      <Card data-testid="seller-requests-list-card">
        <Card.Header>
          <Card.Title>Pending requests</Card.Title>
          <Card.Description>
            One row per Pending ProjectRequest. Each accept / decline is audited and revalidates the
            acting Workspace membership.
          </Card.Description>
        </Card.Header>
        <Card.Content>
          {error && (
            <p className="text-sm text-red-700 mb-3" data-testid="seller-requests-error">
              {error}
            </p>
          )}
          {success && (
            <p className="text-sm text-green-700 mb-3" data-testid="seller-requests-success">
              {success}
            </p>
          )}
          {loadingList ? (
            <p className="text-sm text-gray-600" data-testid="seller-requests-loading-list">
              Loading requests…
            </p>
          ) : requests.length === 0 ? (
            <p className="text-sm text-gray-700" data-testid="seller-requests-empty">
              No pending requests.
            </p>
          ) : (
            <ul className="space-y-3" data-testid="seller-requests-list">
              {requests.map((request) => (
                <RequestRow
                  key={request.projectRequestId}
                  request={request}
                  submitting={submittingId === request.projectRequestId}
                  onAccept={() => {
                    void onAccept(request);
                  }}
                  onDecline={() => {
                    void onDecline(request);
                  }}
                />
              ))}
            </ul>
          )}
        </Card.Content>
      </Card>
    </div>
  );
}

function RequestRow({
  request,
  submitting,
  onAccept,
  onDecline,
}: {
  readonly request: ProjectRequestPublicV1;
  readonly submitting: boolean;
  readonly onAccept: () => void;
  readonly onDecline: () => void;
}) {
  // Render human-readable context as the primary label so the
  // seller can distinguish multiple Pending requests by the
  // content of the request, not by opaque internal ids. The
  // ids remain on the row (data-request-id, data-buyer-id, …)
  // for test selectors and audit correlation, but they MUST NOT
  // be the primary user-facing text — that was the P3-002
  // acceptance QA finding.
  const buyerWorkspaceLabel = request.buyerWorkspaceName ?? "Unknown buyer Workspace";
  const offeringLabel = request.serviceOfferingTitle ?? "Unknown ServiceOffering";
  const briefLabel = request.briefExcerpt ?? "Brief content unavailable.";
  return (
    <li
      className="border border-gray-200 rounded-md p-3 space-y-2"
      data-testid="seller-request-row"
      data-request-id={request.projectRequestId}
    >
      <div className="min-w-0">
        <p
          className="text-sm font-medium text-gray-900 break-words"
          data-testid="seller-request-title"
        >
          <Link
            href={`/project-requests/${request.projectRequestId}`}
            className="text-blue-600 hover:text-blue-700 font-medium focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 rounded"
            data-testid="seller-request-title-link"
          >
            From {buyerWorkspaceLabel} — {offeringLabel}
          </Link>
        </p>
        <p
          className="text-xs text-gray-600 break-words line-clamp-3"
          data-testid="seller-request-brief"
        >
          {briefLabel}
        </p>
        <p className="text-xs text-gray-500" data-testid="seller-request-created-at">
          Received {formatCreatedAt(request.createdAt)}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onAccept}
          disabled={submitting}
          className="bg-green-600 text-white px-3 py-1.5 rounded-md text-sm font-medium hover:bg-green-700 disabled:opacity-50 transition-colors"
          data-testid="seller-request-accept"
        >
          Accept
        </button>
        <button
          type="button"
          onClick={onDecline}
          disabled={submitting}
          className="bg-white text-red-700 border border-red-300 px-3 py-1.5 rounded-md text-sm font-medium hover:bg-red-50 disabled:opacity-50 transition-colors"
          data-testid="seller-request-decline"
        >
          Decline
        </button>
      </div>
    </li>
  );
}

// Human-readable creation time. The DTO already returns an ISO
// datetime string; this formatter renders it in the user's locale
// without requiring a date library. A null/invalid value renders
// as "unknown time" rather than the raw string so the row stays
// readable when the timestamp is missing.
function formatCreatedAt(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "unknown time";
  return parsed.toLocaleString();
}
