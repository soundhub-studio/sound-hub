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
// Anonymous buyers go through `/login?return=/matchmaker?from=talent`;
// signed-in no-Buyer buyers go through `/workspace/intent?return=...`;
// signed-in Buyer-capable buyers go directly.

import { SearchPage } from "../components/SearchPage";
import { navigateToMatchmakerFromTalent } from "../lib/navigate-to-matchmaker-from-talent";
import { useSession } from "../components/SessionProvider";
import { useActingWorkspace } from "../components/SessionProvider";
import { useRouter } from "next/navigation";

export default function TalentPage() {
  const { user } = useSession();
  const { actingWorkspaceId, actingWorkspace } = useActingWorkspace();
  const router = useRouter();

  return (
    <SearchPage
      onSendProjectRequest={(result) => {
        navigateToMatchmakerFromTalent({
          result,
          user,
          actingWorkspace,
          actingWorkspaceId,
          router,
        });
      }}
    />
  );
}
