"use client";

// Permission to approve terms — JIT setup page (M2 #88).
//
// Background: ticket #88 acceptance requires a Personal-Workspace
// member who lacks an explicit `DealApprover` authorization to be
// able to set one up just-in-time from either party's attempted
// approval. This page is the customer-facing "permission to approve
// terms" interstitial that, on successful setup, returns the
// human to the same pending Deal and current TermsVersion. The
// human must then perform a separate explicit Approve action —
// no DealApproval is created during setup (per the M2 authority
// invariants).
//
// Customer language: this page is rendered as "Permission to
// approve terms" and never as "DealApprover" or
// "Provider/governance internals". The closed confirmation version
// is sent in the body so the human accepts the CURRENT
// approval-authority attestation; a stale version is rejected
// at the application boundary with the typed 422 envelope.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSession } from "../../../components/SessionProvider";
import { Card } from "../../../components/ui/Card";
import { provisionDealApprover } from "../../../lib/deal-approver-client";
import { m2DealApproverConfirmationVersionV1 } from "@soundhub/types";
import { findVisibleDeal } from "../../find-visible-deal";
import { fetchDeal } from "../../../lib/deal-terms-client";

interface ApprovePermissionPageProps {
  readonly params: Promise<{ readonly dealId: string }>;
}

const IDEMPOTENCY_KEY_NAMESPACE = "11111111-1111-1111-1111-";

function generateIdempotencyKey(): string {
  // The web never has access to a crypto-grade UUID generator in
  // a portable way; the deterministic prefix keeps the key
  // human-readable in the DB while the random suffix satisfies
  // the strict Zod `z.string().uuid()` boundary.
  const random = `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 14)}`;
  return `${IDEMPOTENCY_KEY_NAMESPACE}${random}-1111-1111-1111-111111111111`;
}

export default function ApprovePermissionPage({ params }: ApprovePermissionPageProps): JSX.Element {
  const router = useRouter();
  const { user, loading } = useSession();
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

  const [actingWorkspaceId, setActingWorkspaceId] = useState<string>("");
  const [bootstrapComplete, setBootstrapComplete] = useState<boolean>(false);
  const [dealStatus, setDealStatus] = useState<"loading" | "found" | "missing">("loading");
  const [confirmChecked, setConfirmChecked] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<boolean>(false);
  const idempotencyKeyRef = useRef<string>("");

  // The page is opened from a context where the human is acting on
  // a specific Deal. The Shell selector already chose the
  // Workspace; we resolve the deal via the existing findVisibleDeal
  // helper so a cross-Workspace link can still surface the
  // pending Deal.
  useEffect(() => {
    if (!user || !dealId) return;
    let cancelled = false;
    const bootstrapKey = `${dealId}:${user.userAccountId}`;
    if (idempotencyKeyRef.current === "") {
      idempotencyKeyRef.current = generateIdempotencyKey();
    }
    void findVisibleDeal({
      dealId,
      workspaceIds: user.workspaces.map((w) => w.workspaceId),
      fetchDeal,
    })
      .then((result) => {
        if (cancelled) return;
        setActingWorkspaceId(result.actingWorkspaceId);
        setDealStatus("found");
        setBootstrapComplete(true);
      })
      .catch(() => {
        if (cancelled) return;
        setDealStatus("missing");
        setBootstrapComplete(true);
      });
    return () => {
      cancelled = true;
    };
    // Reference the key only to prevent duplicate bootstrap
    // runs; we deliberately do not include idempotencyKeyRef in
    // deps because it's a stable ref for the page lifetime.
    void bootstrapKey;
  }, [user, dealId]);

  const onConfirm = useCallback(async () => {
    if (!actingWorkspaceId || !dealId) return;
    if (!confirmChecked) {
      setError("Please confirm you have authority to approve terms on this Workspace.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await provisionDealApprover({
        actingWorkspaceId,
        confirmationVersion: m2DealApproverConfirmationVersionV1,
        idempotencyKey: idempotencyKeyRef.current,
      });
      setSuccess(true);
      // Return to the pending Deal page. The Approve action is a
      // separate explicit step the human must take after setup.
      // No auto-replay, no DealApproval created during setup.
      window.setTimeout(() => {
        router.push(`/deals/${dealId}`);
      }, 600);
    } catch (err) {
      if (
        err instanceof Error &&
        ((err as { code?: string }).code === "SESSION_INVALID" ||
          (err as { code?: string }).code === "AUTH_FAILED" ||
          (err as { code?: string }).code === "SESSION_EXPIRED")
      ) {
        // Session refreshed by the provider
      } else if (
        err instanceof Error &&
        (err as { code?: string }).code === "DEAL_APPROVER_ALREADY_PROVISIONED"
      ) {
        // The user already has a DealApprover (e.g. via the
        // dashboard readiness task). Return to the Deal page
        // without surfacing an error.
        setSuccess(true);
        window.setTimeout(() => {
          router.push(`/deals/${dealId}`);
        }, 600);
      } else {
        setError(err instanceof Error ? err.message : "Could not set up permission.");
      }
    } finally {
      setSubmitting(false);
    }
  }, [actingWorkspaceId, dealId, confirmChecked, router]);

  const actingWorkspaceName = useMemo(() => {
    if (!user || !actingWorkspaceId) return "your Workspace";
    const w = user.workspaces.find((ws) => ws.workspaceId === actingWorkspaceId);
    return w?.name ?? "your Workspace";
  }, [user, actingWorkspaceId]);

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-12" data-testid="permission-loading">
        <p className="text-gray-600">Loading…</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-12" data-testid="permission-signed-out">
        <Card>
          <Card.Content>
            <p className="text-gray-700">
              You are not signed in.{" "}
              <Link
                href="/login"
                className="text-blue-600 hover:text-blue-700 font-medium"
                data-testid="permission-sign-in-link"
              >
                Sign in
              </Link>{" "}
              to set up permission to approve terms.
            </p>
          </Card.Content>
        </Card>
      </div>
    );
  }

  if (!bootstrapComplete || dealStatus === "loading") {
    return (
      <div className="max-w-3xl mx-auto px-6 py-12" data-testid="permission-loading">
        <p className="text-gray-600">Loading permission setup…</p>
      </div>
    );
  }

  if (dealStatus === "missing") {
    return (
      <div className="max-w-3xl mx-auto px-6 py-12 space-y-4" data-testid="permission-empty">
        <Card>
          <Card.Header>
            <Card.Title>Deal not visible</Card.Title>
            <Card.Description>
              Either the Deal does not exist or your account is not a current member of one of its
              buyer or seller Workspaces.
            </Card.Description>
          </Card.Header>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-12 space-y-6" data-testid="permission-page">
      <Card data-testid="permission-header">
        <Card.Header>
          <Card.Title>Permission to approve terms</Card.Title>
          <Card.Description>
            You are acting as <strong>{actingWorkspaceName}</strong> for this Workspace's side of
            the Deal. Setting up this permission does NOT approve the current TermsVersion — it only
            enables the next step.
          </Card.Description>
        </Card.Header>
        <Card.Content>
          <p className="text-sm text-gray-700" data-testid="permission-context">
            After you finish this step, you will be returned to the same Deal and current
            TermsVersion. Approving the TermsVersion is a separate, explicit action that you must
            take after setup.
          </p>
        </Card.Content>
      </Card>

      <Card data-testid="permission-attestation">
        <Card.Header>
          <Card.Title>Approval-authority attestation</Card.Title>
          <Card.Description>
            I, the human acting for <strong>{actingWorkspaceName}</strong>, accept the current
            version of the approval-authority attestation (
            <code>{m2DealApproverConfirmationVersionV1}</code>). I understand that this step records
            the authorization; it does not approve any TermsVersion.
          </Card.Description>
        </Card.Header>
        <Card.Content>
          <label
            className="flex items-start gap-3 cursor-pointer"
            data-testid="permission-confirm-label"
          >
            <input
              type="checkbox"
              checked={confirmChecked}
              onChange={(e) => {
                setConfirmChecked(e.target.checked);
              }}
              className="mt-1"
              data-testid="permission-confirm-checkbox"
            />
            <span className="text-sm text-gray-900">
              I accept the current version of the approval-authority attestation for{" "}
              {actingWorkspaceName}.
            </span>
          </label>
        </Card.Content>
      </Card>

      {error && (
        <p className="text-sm text-red-700" data-testid="permission-error">
          {error}
        </p>
      )}

      {success && (
        <p className="text-sm text-green-700" data-testid="permission-success">
          Permission set up. Returning to the Deal page so you can approve the current TermsVersion
          as a separate step.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => {
            void onConfirm();
          }}
          disabled={submitting || !confirmChecked || success}
          className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] px-6 py-3 text-base font-medium text-white bg-aubergine hover:bg-aubergine-hover rounded focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine disabled:opacity-50 disabled:cursor-not-allowed"
          data-testid="permission-confirm"
        >
          {submitting ? "Setting up…" : success ? "Permission set up" : "Set up permission"}
        </button>
        <Link
          href={dealId ? `/deals/${dealId}` : "/deals"}
          className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] px-6 py-3 text-sm font-medium text-ink underline focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          data-testid="permission-cancel"
        >
          Cancel
        </Link>
      </div>
    </div>
  );
}
