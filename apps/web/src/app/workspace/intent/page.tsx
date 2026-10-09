"use client";

// Intent selection page (M2 #83).
//
// Background: a freshly-converged Personal Workspace has no
// marketplace capability. The human must explicitly choose
// `Hire talent`, `Offer services`, or `Both` to provision Buyer /
// Seller capability. The intent page renders the three mutually
// exclusive choices as a semantic radio group styled as cards
// plus an explicit Submit button — standard browser keyboard
// semantics (arrow keys move the radio selection, Space/Enter
// activates, Tab moves to Submit). No custom keyboard handlers,
// no custom aria-pressed buttons, no Escape-to-clear.
//
// Authorization rules:
//
//   - The page reads `useActingWorkspace()` and ONLY accepts the
//     request when the COMMITTED acting Workspace is the user's
//     Personal Workspace. If the human is acting as an
//     Organization, the page redirects to /workspace/switch
//     with the Personal Workspace as the target so the explicit
//     switch completes BEFORE intent self-service. This closes
//     the "intent can provision a Workspace different from the
//     committed actor" gap.
//
//   - The page reads `user.setupState` for the recovery surface.
//     Recovery renders a calm explanation; intent self-service
//     is unavailable and the page never submits.
//
// Server contract (already validated by `intentRequestV1Schema`):
//
//   - `intent`: "Hire" | "Offer" | "Both".
//   - No `sellerAcceptance` field is carried on the intent surface.
//     #83 does NOT collect a generic Seller participation/terms
//     acceptance at capability-provisioning time — context-specific
//     confirmations are owned by their later boundaries
//     (SellerProfile publication, media use, ServiceOffering
//     activation, Deal approval authority / approval).
//   - `returnTo`: optional. The browser reads `?return=<path>`
//     from the URL, pre-filters it to a same-origin path shape,
//     and submits it on the intent body. The route revalidates
//     it via `isValidReturnPath` and resolves a server-
//     authorized `safeReturnTo` against the FRESH post-provision
//     user payload; the browser consumes only
//     `safeReturnTo`. A malformed or external value is silently
//     dropped to `null` and the destination falls back to
//     `/dashboard`.
//
// Errors:
//   - INTENT_INVALID: malformed submission.
//   - INTENT_FORBIDDEN: not a current member of the target
//     Workspace, including the recovery-state refusal and the
//     Personal-Workspace boundary.

import { Suspense, useEffect, useMemo, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useActingWorkspace, useSession } from "../../components/SessionProvider";
import { Card } from "../../components/ui/Card";
import { Alert } from "../../components/ui/Alert";
import { submitIntent } from "../../lib/auth-client";
import { navigateAfterIntent } from "../../lib/navigate-after-intent";
import type { IntentKindV1, IntentRequestV1, MarketplaceCapabilityV1 } from "@soundhub/types";
import { isLocallyValidReturnPath } from "../../lib/return-path-shape";

export default function IntentPage() {
  // `useSearchParams` requires a Suspense boundary at static-export
  // time. The intent page is client-rendered and dynamic; the inner
  // component reads `useSearchParams` so the route's static
  // generation can resolve.
  return (
    <Suspense fallback={<IntentLoading />}>
      <IntentPageInner />
    </Suspense>
  );
}

function IntentLoading() {
  return (
    <div className="min-h-screen bg-canvas">
      <div className="max-w-[1440px] mx-auto px-6 lg:px-12 py-12">
        <div className="max-w-2xl mx-auto" data-testid="intent-loading">
          <Alert role="status" variant="status" title="Loading…">
            Just a moment.
          </Alert>
        </div>
      </div>
    </div>
  );
}

function IntentPageInner() {
  const { user, loading, refresh } = useSession();
  const { actingWorkspace } = useActingWorkspace();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [intent, setIntent] = useState<IntentKindV1 | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Stable identifier of the most recent error. Drives the
  // error-specific recovery affordance (e.g., the
  // `INTENT_CONFLICT` reload button).
  const [lastCode, setLastCode] = useState<string | null>(null);

  const personalWorkspace = useMemo(() => {
    if (!user) return null;
    return user.workspaces.find((w) => w.workspaceType === "Personal") ?? null;
  }, [user]);

  // Read the validated `?return=` query parameter (same-origin
  // path shape only). The server is the authoritative validator
  // (`isValidReturnPath`); this client helper pre-filters obvious
  // junk so the user does not submit a value that would be
  // silently dropped server-side. A
  // non-same-origin, malformed, or `/api/` value is treated as
  // absent (the route will fall back to `/dashboard`).
  const validatedReturnTo = useMemo(() => {
    const raw = searchParams.get("return");
    if (!raw) return null;
    return isLocallyValidReturnPath(raw) ? raw : null;
  }, [searchParams]);

  // Read the COMMITTED acting Workspace (P1-001). The intent page
  // is Personal-Workspace-only; if the actor is not Personal,
  // redirect to the switch interstitial with the Personal
  // Workspace as the explicit target.
  const personalActor =
    actingWorkspace && actingWorkspace.workspaceType === "Personal" ? actingWorkspace : null;

  // Redirect signed-out visitors to /login. The redirect lives in
  // a useEffect callback (NOT in the render body) so the browser
  // never receives a navigation call during render — calling
  // `router.replace` directly during render triggers
  // "Cannot update Router while rendering IntentPageInner" (Codex
  // React correctness finding). While the session is still
  // resolving OR the user is null but the redirect has not yet
  // resolved, the render keeps returning the loading surface; the
  // effect runs after commit, navigates once, and the new
  // destination mounts under the new route.
  useEffect(() => {
    if (loading) return;
    if (!user) {
      void router.replace("/login?return=/workspace/intent");
    }
  }, [loading, user, router]);

  if (loading || !user) {
    return (
      <div className="min-h-screen bg-canvas">
        <div className="max-w-[1440px] mx-auto px-6 lg:px-12 py-12">
          <div className="max-w-2xl mx-auto" data-testid="intent-loading">
            <Alert role="status" variant="status" title="Loading…">
              Just a moment.
            </Alert>
          </div>
        </div>
      </div>
    );
  }

  // Recovery state: render only. Intent self-service is
  // unavailable and the server's INTENT_FORBIDDEN refusal
  // makes sure no mutation can occur even if the user submits
  // the form via curl.
  if (user.setupState === "recovery") {
    return (
      <div className="min-h-screen bg-canvas">
        <div className="max-w-[1440px] mx-auto px-6 lg:px-12 py-12">
          <div className="max-w-2xl mx-auto" data-testid="intent-recovery">
            <Card variant="recovery">
              <Card.Header>
                <Card.Title>Workspace setup needs your attention</Card.Title>
              </Card.Header>
              <Card.Content>
                <p className="text-base text-muted">
                  SoundHub did not guess, merge, or automatically select a Personal Workspace for
                  this account. Intent selection is unavailable while Workspace ownership is in
                  recovery.
                </p>
              </Card.Content>
            </Card>
          </div>
        </div>
      </div>
    );
  }

  // No Personal Workspace accessible — render the calm empty
  // state and stop. (Server convergence classifies this as
  // recovery normally; reaching this branch means the user has
  // no Personal membership at all.)
  if (!personalWorkspace) {
    return (
      <div className="min-h-screen bg-canvas">
        <div className="max-w-[1440px] mx-auto px-6 lg:px-12 py-12">
          <div className="max-w-2xl mx-auto" data-testid="intent-no-personal">
            <Card variant="parchment">
              <Card.Header>
                <Card.Title>No Personal Workspace</Card.Title>
              </Card.Header>
              <Card.Content>
                <p className="text-base text-muted">
                  Intent selection is available on your Personal Workspace. SoundHub could not find
                  one for this account.
                </p>
              </Card.Content>
            </Card>
          </div>
        </div>
      </div>
    );
  }

  // P1-001: actor is not Personal → require an EXPLICIT switch
  // BEFORE intent. The user lands here after choosing Offer/Both
  // while acting as an Organization. Surface the switch
  // interstitial so the human makes the acting-Workspace choice
  // consciously; do NOT use the first Personal Workspace path
  // id as a fallback.
  if (!personalActor) {
    return (
      <div className="min-h-screen bg-canvas">
        <div className="max-w-[1440px] mx-auto px-6 lg:px-12 py-12">
          <div className="max-w-2xl mx-auto" data-testid="intent-not-personal-actor">
            <Card variant="parchment">
              <Card.Header>
                <Card.Title>Switch to your Personal Workspace</Card.Title>
              </Card.Header>
              <Card.Content>
                <p className="text-base text-muted mb-4">
                  Intent selection is Personal-only. You are currently acting as{" "}
                  <span className="font-medium text-ink" data-testid="intent-current-actor-name">
                    {actingWorkspace?.name ?? "another Workspace"}
                  </span>
                  . Switch to your Personal Workspace to choose how you want to use SoundHub as an
                  individual.
                </p>
                <a
                  href={`/workspace/switch?target=${encodeURIComponent(personalWorkspace.workspaceId)}${
                    validatedReturnTo ? `&return=${encodeURIComponent(validatedReturnTo)}` : ""
                  }`}
                  className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] py-3 px-6 text-base font-medium text-white bg-aubergine hover:bg-aubergine-hover rounded focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine"
                  data-testid="intent-switch-to-personal"
                >
                  Switch to your Personal Workspace
                </a>
              </Card.Content>
            </Card>
          </div>
        </div>
      </div>
    );
  }

  const personalWorkspaceId = personalActor.workspaceId;
  // Derive the affordance shape from the Personal Workspace's
  // current capabilities (the state the human observed when
  // they landed on the page). The intent command is additive:
  // the request carries the chosen set + `expectedCapabilities`
  // so the server can detect a stale UI.
  const currentCapabilities = personalActor.capabilities;
  const isBuyer = currentCapabilities.includes("Buyer");
  const isSeller = currentCapabilities.includes("Seller");
  const hasBoth = isBuyer && isSeller;

  const submitDisabled = intent === null || submitting;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (intent === null || submitting || !personalWorkspaceId) return;
    setSubmitting(true);
    setError(null);
    setLastCode(null);

    // Carry the validated `?return=` forward. The schema requires
    // the field to be present-or-omitted
    // (`.strict()` rejects `null`); we submit it only when validated
    // to avoid sending junk that the server would silently drop.
    const bodyBase: IntentRequestV1 = {
      intent,
      expectedCapabilities: [...currentCapabilities],
    };
    const intentBody: IntentRequestV1 =
      validatedReturnTo !== null ? { ...bodyBase, returnTo: validatedReturnTo } : bodyBase;

    void (async () => {
      try {
        const response = await submitIntent({
          workspaceId: personalWorkspaceId,
          intent: intentBody,
        });
        await refresh();
        navigateAfterIntent({ router, response });
      } catch (err) {
        const apiErr = err as {
          status?: number;
          code?: string;
          message?: string;
          // INTENT_CONFLICT carries the FRESH persisted capability
          // set on the client error envelope so the UI can render
          // an actionable recovery affordance. The web auth-client
          // parses `error.freshCapabilities` into a top-level
          // `freshCapabilities` field on the thrown error.
          freshCapabilities?: readonly MarketplaceCapabilityV1[];
        };
        if (apiErr.code === "INTENT_INVALID") {
          setError("Please choose how you want to use SoundHub.");
          setLastCode("INTENT_INVALID");
        } else if (apiErr.code === "INTENT_CONFLICT" || apiErr.status === 409) {
          const fresh = apiErr.freshCapabilities ?? [];
          const summary =
            fresh.length > 0
              ? `Your Personal Workspace now has ${fresh.join(" and ")}.`
              : "Your Personal Workspace capabilities changed.";
          setError(`${summary} Reload to continue with the current state.`);
          setLastCode("INTENT_CONFLICT");
        } else if (apiErr.code === "INTENT_FORBIDDEN" || apiErr.status === 403) {
          setError("You are not a current member of this Workspace.");
          setLastCode("INTENT_FORBIDDEN");
        } else if (apiErr.message) {
          setError(apiErr.message);
          setLastCode(apiErr.code ?? null);
        } else {
          setError("Something went wrong. Please try again.");
          setLastCode(null);
        }
      } finally {
        setSubmitting(false);
      }
    })();
  };

  const handleReload = () => {
    void (async () => {
      await refresh();
      setError(null);
      setLastCode(null);
      setIntent(null);
    })();
  };

  return (
    <div className="min-h-screen bg-canvas">
      <div className="max-w-[1440px] mx-auto px-6 lg:px-12 py-12">
        <div className="max-w-2xl mx-auto" data-testid="intent-page">
          {hasBoth ? (
            <>
              <h1 className="text-3xl font-serif text-ink mb-3" data-testid="intent-heading">
                You have both capabilities
              </h1>
              <p className="text-base text-muted mb-8" data-testid="intent-summary">
                {validatedReturnTo !== null
                  ? "Your Personal Workspace is set up for hiring and offering services. Continue to where you were."
                  : "Your Personal Workspace is set up for hiring and offering services. Return to the dashboard to continue."}
              </p>
              <a
                href={validatedReturnTo ?? "/dashboard"}
                className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] py-3 px-6 text-base font-medium text-white bg-aubergine hover:bg-aubergine-hover rounded focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine"
                data-testid={
                  validatedReturnTo !== null ? "intent-continue" : "intent-back-to-dashboard"
                }
              >
                {validatedReturnTo !== null ? "Continue" : "Return to dashboard"}
              </a>
            </>
          ) : (
            <>
              <h1 className="text-3xl font-serif text-ink mb-3" data-testid="intent-heading">
                {isBuyer
                  ? "Add Offer services too?"
                  : isSeller
                    ? "Add Hire talent too?"
                    : "How do you want to use SoundHub?"}
              </h1>
              <p className="text-base text-muted mb-8" data-testid="intent-summary">
                {isBuyer
                  ? "You currently have Buyer capability. You can add Seller capability any time."
                  : isSeller
                    ? "You currently have Seller capability. You can add Buyer capability any time."
                    : "Choose how you want to use SoundHub. You can add the other capability later from the dashboard."}
              </p>

              {validatedReturnTo !== null && currentCapabilities.length > 0 && (
                <a
                  href={validatedReturnTo}
                  className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] mb-4 py-2 px-4 text-sm font-medium text-aubergine hover:text-aubergine-hover border border-aubergine rounded focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine"
                  data-testid="intent-skip-to-return"
                >
                  Continue without changing capabilities
                </a>
              )}

              <form onSubmit={handleSubmit} className="space-y-4" data-testid="intent-form">
                <fieldset disabled={submitting} className="space-y-3" data-testid="intent-fieldset">
                  <legend className="sr-only">Marketplace intent</legend>
                  {currentCapabilities.length === 0 ? (
                    <>
                      <IntentChoice
                        value="Hire"
                        title="Hire talent"
                        description="Find Caribbean producers, songwriters, and performers. Send project requests and approve work."
                        selected={intent === "Hire"}
                        disabled={submitting}
                        onSelect={setIntent}
                        testId="intent-choice-hire"
                      />
                      <IntentChoice
                        value="Offer"
                        title="Offer services"
                        description="Publish a profile and one or more services. Receive project requests from buyers."
                        selected={intent === "Offer"}
                        disabled={submitting}
                        onSelect={setIntent}
                        testId="intent-choice-offer"
                      />
                      <IntentChoice
                        value="Both"
                        title="Both"
                        description="Hire talent and offer services from the same Personal Workspace."
                        selected={intent === "Both"}
                        disabled={submitting}
                        onSelect={setIntent}
                        testId="intent-choice-both"
                      />
                    </>
                  ) : isBuyer ? (
                    <IntentChoice
                      value="Offer"
                      title="Add Offer services too"
                      description="Publish a profile and one or more services. Receive project requests from buyers."
                      selected={intent === "Offer"}
                      disabled={submitting}
                      onSelect={setIntent}
                      testId="intent-choice-offer"
                    />
                  ) : (
                    <IntentChoice
                      value="Hire"
                      title="Add Hire talent too"
                      description="Find Caribbean producers, songwriters, and performers. Send project requests and approve work."
                      selected={intent === "Hire"}
                      disabled={submitting}
                      onSelect={setIntent}
                      testId="intent-choice-hire"
                    />
                  )}
                </fieldset>

                <button
                  type="submit"
                  disabled={submitDisabled}
                  className="w-full sm:w-auto inline-flex items-center justify-center min-h-[44px] min-w-[44px] py-3 px-6 text-base font-medium text-white bg-coral hover:bg-coral-hover rounded disabled:opacity-50 transition-colors focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-coral"
                  data-testid="intent-submit"
                >
                  {submitting ? "Submitting…" : "Continue"}
                </button>
              </form>
            </>
          )}

          {error && (
            <div className="mt-6" data-testid="intent-error">
              <Alert role="alert" variant="failure" title="Could not submit your choice">
                {error}
              </Alert>
              {lastCode === "INTENT_CONFLICT" ? (
                <button
                  type="button"
                  onClick={handleReload}
                  className="mt-3 inline-flex items-center justify-center min-h-[44px] min-w-[44px] py-2 px-4 text-sm font-medium text-aubergine hover:text-aubergine-hover border border-aubergine rounded focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine"
                  data-testid="intent-reload"
                >
                  Reload
                </button>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface IntentChoiceProps {
  readonly value: IntentKindV1;
  readonly title: string;
  readonly description: string;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onSelect: (value: IntentKindV1) => void;
  readonly testId: string;
}

function IntentChoice({
  value,
  title,
  description,
  selected,
  disabled,
  onSelect,
  testId,
}: IntentChoiceProps) {
  return (
    <label
      className={`block cursor-pointer rounded-lg border p-4 transition-colors focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-aubergine ${
        selected ? "border-aubergine bg-surface" : "border-borderWarm bg-canvas hover:bg-surface"
      }`}
      data-testid={testId}
      data-selected={selected ? "true" : "false"}
    >
      <div className="flex items-start gap-3">
        <input
          type="radio"
          name="intent"
          value={value}
          checked={selected}
          onChange={() => onSelect(value)}
          disabled={disabled}
          className="mt-1 h-4 w-4 accent-aubergine focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine"
          data-testid={`${testId}-input`}
        />
        <div>
          <span className="block text-base font-medium text-ink">{title}</span>
          <span className="block text-sm text-muted mt-1">{description}</span>
        </div>
      </div>
    </label>
  );
}
