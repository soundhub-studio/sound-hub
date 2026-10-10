"use client";

// Public Talent search surface (M2 #83 + #87).
//
// Background: the M2 spec renames the public search route from
// `/` to `/talent`. The component itself (SearchPage) is
// unchanged from BG3; the route move is the only difference.
// The M2 landing page (`/`) replaces the previous root with
// the new Caribbean Studio public landing that surfaces the
// `Find talent` CTA.
//
// The route is accessible to anonymous and authenticated
// users alike; no capability gate.
//
// M2 (#87): the page wires a `navigateToMatchmakerFromTalent`
// handler that the result card invokes on the coral
// "Send project request" click. The handler writes the Talent
// continuation record to localStorage (the bounded cross-flow
// state container) and routes the buyer to the matchmaker.
// Anonymous buyers go through a chained return context
// `/login?return=/workspace/intent?return=/matchmaker` so a
// brand-new user is provisioned with Buyer capability before
// the matchmaker mounts; signed-in no-Buyer buyers go through
// `/workspace/intent?return=/matchmaker`; signed-in
// Buyer-capable buyers go directly.
//
// The handler MUST wait for the SessionProvider's initial
// `/api/auth/me` request to resolve before classifying the
// visitor. The initial `user` value is `null` for both
// anonymous AND authenticated visitors while `loading` is
// true; classifying an authenticated buyer as anonymous
// would send them through the login chain unnecessarily.
// The action is therefore suppressed while the session is
// loading; the result card disables its button when the
// session is unresolved so the buyer does not see a click
// that does nothing.
//
// localStorage write failures (private-browsing quota, full
// storage) are caught at the page level and surfaced as an
// inline recoverable error so the buyer is never sent to a
// destination they cannot resume from.

import { useState } from "react";
import { SearchPage } from "../components/SearchPage";
import { navigateToMatchmakerFromTalent } from "../lib/navigate-to-matchmaker-from-talent";
import { useSession } from "../components/SessionProvider";
import { useActingWorkspace } from "../components/SessionProvider";
import { useRouter } from "next/navigation";
import { Card } from "../components/ui/Card";

export default function TalentPage() {
  // M2 (#87) Finding 7: read `loading` from useSession so we do
  // not misclassify a still-resolving authenticated buyer as
  // anonymous. The SessionProvider's initial `/api/auth/me`
  // request returns `user: null, loading: true` for both
  // anonymous and authenticated visitors; the helper's three
  // routing branches are all keyed off `user` so an in-flight
  // resolution would push an authenticated buyer through the
  // anonymous /login chain.
  const { user, loading: sessionLoading } = useSession();
  const { actingWorkspaceId, actingWorkspace } = useActingWorkspace();
  const router = useRouter();
  // M2 (#87): localStorage write failures (private-browsing
  // quota) are surfaced inline. The Talent page is the only
  // place that catches the throw from setTalentMatchmakerContext
  // — the helper itself propagates so the page owns the
  // buyer-visible recovery.
  const [talentContextError, setTalentContextError] = useState<string | null>(null);

  return (
    <>
      {talentContextError !== null && (
        <div
          className="max-w-3xl mx-auto px-6 pt-6"
          data-testid="talent-context-storage-error"
          role="alert"
        >
          <Card variant="outlined" className="border-amber-200 bg-amber-50">
            <Card.Content>
              <p className="text-sm text-amber-800">
                {talentContextError} The brief is preserved. You can retry without retyping it.
              </p>
            </Card.Content>
          </Card>
        </div>
      )}
      <SearchPage
        onSendProjectRequest={(result, criteria) => {
          // M2 (#87) Finding 7: do not classify the visitor
          // while the SessionProvider is still resolving their
          // `/api/auth/me` request. An authenticated buyer who
          // clicks during the initial fetch would otherwise be
          // misclassified as anonymous and pushed through the
          // /login chain unnecessarily. The result card also
          // disables its button via the `loading` flag below so
          // a fast click on a still-resolving session has no
          // effect at the click-handler layer either.
          if (sessionLoading) {
            return;
          }
          try {
            navigateToMatchmakerFromTalent({
              result,
              criteria,
              user,
              actingWorkspace,
              actingWorkspaceId,
              router,
            });
            setTalentContextError(null);
          } catch (err) {
            setTalentContextError(
              err instanceof Error
                ? err.message
                : "We couldn't save your selection to continue. Your browser storage may be full or disabled.",
            );
          }
        }}
        sessionLoading={sessionLoading}
      />
    </>
  );
}
