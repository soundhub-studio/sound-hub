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
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useSession } from "../../../components/SessionProvider";
import { Card } from "../../../components/ui/Card";
import { provisionDealApprover } from "../../../lib/deal-approver-client";
import { m2DealApproverConfirmationVersionV1 } from "@soundhub/types";
import { fetchDeal } from "../../../lib/deal-terms-client";

interface ApprovePermissionPageProps {
  readonly params: Promise<{ readonly dealId: string }>;
  readonly searchParams: Promise<{ readonly [key: string]: string | string[] | undefined }>;
}

function generateIdempotencyKey(): string {
  // M2 (#88) Codex finding: the previous generator produced a
  // value that failed the strict `z.string().uuid()` boundary
  // at the route layer, surfacing a generic
  // `DEAL_APPROVER_INVALID` (400) on every submission. The web
  // has access to a crypto-grade UUID generator via the
  // `crypto` global (available in modern browsers and Node 19+).
  // The key is generated once per page lifetime and retained
  // across retries so a same-key retry converges on the
  // existing evidence row.
  return crypto.randomUUID();
}

export default function ApprovePermissionPage({
  params,
  searchParams,
}: ApprovePermissionPageProps): JSX.Element {
  const router = useRouter();
  const { user, loading } = useSession();
  const [resolvedDealId, setResolvedDealId] = useState<string>("");
  const [queryActingWorkspaceId, setQueryActingWorkspaceId] = useState<string>("");
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

  // M2 (#88) Codex finding: the source URL must carry the
  // acting Workspace id. A human who belongs to BOTH Deal-party
  // Workspaces would otherwise have setup silently granted
  // permission to the wrong Workspace (whichever the bootstrap
  // helper happened to try first). The previous implementation
  // also forced the human to discover the right selection on
  // the destination page; the source URL is the only reliable
  // signal.
  useEffect(() => {
    let cancelled = false;
    void searchParams.then((p) => {
      if (cancelled) return;
      const raw = p.actingWorkspaceId;
      const value = Array.isArray(raw) ? raw[0] : raw;
      if (typeof value === "string" && value.length > 0 && value.length <= 128) {
        setQueryActingWorkspaceId(value);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [searchParams]);

  const [actingWorkspaceId, setActingWorkspaceId] = useState<string>("");
  const [bootstrapComplete, setBootstrapComplete] = useState<boolean>(false);
  const [dealStatus, setDealStatus] = useState<"loading" | "found" | "missing">("loading");
  const [confirmChecked, setConfirmChecked] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<boolean>(false);
  const idempotencyKeyRef = useRef<string>("");

  // The page is opened from a context where the human is acting on
  // a specific Deal. The source URL must carry the acting
  // Workspace id; we revalidate that selection against the
  // Deal view (the Workspace must be a current member AND a
  // party to this Deal) and refuse to silently fall back to
  // another Workspace when the human belongs to both Deal
  // parties.
  //
  // M2 (#88) Codex finding: the previous bootstrap searched
  // every membership the human held and silently chose the
  // first Workspace that could read the Deal. A human who is
  // a member of BOTH Deal-party Workspaces would have setup
  // granted to whichever Workspace happened to try first,
  // not the Workspace the human was acting as. The source
  // URL is the only reliable signal.
  useEffect(() => {
    if (!user || !dealId) return;
    if (queryActingWorkspaceId === "") {
      // No selection in the source URL — fail closed. The
      // /deals/:dealId page always threads the acting
      // Workspace through the URL.
      setDealStatus("missing");
      setBootstrapComplete(true);
      return;
    }
    // Membership check: the human must be a current member of
    // the source-URL acting Workspace.
    const memberOfSelection = user.workspaces.some((w) => w.workspaceId === queryActingWorkspaceId);
    if (!memberOfSelection) {
      setDealStatus("missing");
      setBootstrapComplete(true);
      return;
    }
    if (idempotencyKeyRef.current === "") {
      idempotencyKeyRef.current = generateIdempotencyKey();
    }
    let cancelled = false;
    // Re-resolve the Deal against the EXACT selection so the
    // page confirms the Workspace is actually a party to this
    // Deal (and not, e.g., an unrelated Workspace the human
    // belongs to but never bought or sold with).
    void fetchDeal(dealId, queryActingWorkspaceId)
      .then((result) => {
        if (cancelled) return;
        const buyerId = result.deal.deal.buyerWorkspaceId;
        const sellerId = result.deal.deal.sellerWorkspaceId;
        if (queryActingWorkspaceId !== buyerId && queryActingWorkspaceId !== sellerId) {
          setDealStatus("missing");
          setBootstrapComplete(true);
          return;
        }
        setActingWorkspaceId(queryActingWorkspaceId);
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
  }, [user, dealId, queryActingWorkspaceId]);

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
      // Return to the pending Deal page with the acting
      // Workspace preserved. The Deal page reads this query
      // param on mount to revalidate the same Workspace the
      // human was just authorized against. No auto-replay, no
      // DealApproval created during setup.
      const target = new URL(`/deals/${dealId}`, window.location.origin);
      target.searchParams.set("actingWorkspaceId", actingWorkspaceId);
      const targetUrl = `${target.pathname}${target.search}`;
      window.setTimeout(() => {
        router.push(targetUrl as Route);
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
        const target = new URL(`/deals/${dealId}`, window.location.origin);
        target.searchParams.set("actingWorkspaceId", actingWorkspaceId);
        window.setTimeout(() => {
          router.push(`${target.pathname}${target.search}` as Route);
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
