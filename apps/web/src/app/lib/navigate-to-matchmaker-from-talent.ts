// Talent → Matchmaker navigation helper (M2 #87).
//
// Background: a buyer who clicks the coral "Send project request"
// button on a /talent result may not be authenticated yet, or may
// not yet have Buyer capability on their Personal Workspace. The
// /talent page must preserve the buyer's search context (the
// targeted offering, the brief text, and the structured filters)
// across the auth / intent round-trip so the matchmaker can
// restore the highlight and pre-fill the brief form when the
// buyer returns.
//
// Three routing branches (M2 #87 acceptance criteria):
//
//   - Anonymous (user === null):
//     router.push("/login?return=/workspace/intent?return=/matchmaker?from=talent")
//     The chain routes a brand-new user through Buyer intent
//     provisioning before landing on /matchmaker. A returning
//     user who already has Buyer capability is detected by the
//     intent page's "no capability change needed" path and is
//     re-routed to the inner return target. Either way, a
//     brand-new buyer can never reach /matchmaker and hit the
//     dead-end "Your account does not currently belong to a
//     Buyer-capable Workspace" warning.
//
//   - Signed in, acting Workspace lacks Buyer:
//     router.push("/workspace/intent?return=/matchmaker?from=talent")
//     The intent page provisions Buyer capability and returns
//     the buyer to /matchmaker.
//
//   - Signed in, Buyer capability present:
//     router.push("/matchmaker?from=talent")
//     Direct navigation; the matchmaker mounts and reads the
//     localStorage record.
//
// Before any push, the helper writes the Talent continuation
// record to localStorage via `setTalentMatchmakerContext`. A
// `setItem` failure (private-browsing quota) is propagated to
// the caller (the talent page) which surfaces the failure
// inline and aborts the navigation so the buyer is never sent
// to a destination they cannot resume from.

import type { Bg1PublicUserV1, TalentSearchResultV1 } from "@soundhub/types";
import { setTalentMatchmakerContext } from "./talent-matchmaker-context";
import type { RequiredFiltersValue } from "./talent-search-request-builder";

export interface NavigateToMatchmakerFromTalentCriteria {
  readonly query: string;
  readonly filters: RequiredFiltersValue;
}

export interface NavigateToMatchmakerFromTalentInput {
  readonly result: TalentSearchResultV1;
  /**
   * M2 (#87): the search criteria that produced the rendered
   * result list. Captured at click time from SearchPage's
   * `submittedCriteria` snapshot so the matchmaker can pre-fill
   * the brief form on return.
   */
  readonly criteria: NavigateToMatchmakerFromTalentCriteria;
  readonly user: Bg1PublicUserV1 | null;
  readonly actingWorkspace: Bg1PublicUserV1["workspaces"][number] | null;
  readonly actingWorkspaceId: string | null;
  readonly router: {
    push(href: string): void;
  };
  /**
   * Test seam so the test can stub the localStorage write without
   * setting up a real window.localStorage. When `undefined`
   * (production default), the helper uses the real
   * `setTalentMatchmakerContext`. The real helper throws on
   * `setItem` failure so the caller can surface the error inline;
   * the test seam always succeeds.
   */
  readonly setContext?: (input: {
    readonly offeringId: string;
    readonly query: string;
    readonly filters: RequiredFiltersValue;
  }) => void;
}

// Chained return context. The post-command return resolver strips
// the inner `?return=` from the OUTER `returnTo` only when the
// outer returnTo is the bounded return; the inner return is
// preserved as a URL query parameter on the intent page and
// read back via `?return=` on the intent page itself, which
// forwards it through the standard intent response cycle.
//
// Length: 89 chars, well within the 256-char safeReturnTo cap.
export const MATCHMAKER_FROM_TALENT_LOGIN_RETURN =
  "/login?return=/workspace/intent?return=/matchmaker%3Ffrom%3Dtalent";
export const MATCHMAKER_FROM_TALENT_INTENT_RETURN =
  "/workspace/intent?return=/matchmaker%3Ffrom%3Dtalent";
export const MATCHMAKER_FROM_TALENT_DIRECT = "/matchmaker?from=talent";

export function navigateToMatchmakerFromTalent(input: NavigateToMatchmakerFromTalentInput): void {
  const offeringId = input.result.bestMatchingOffering.offeringId;
  const { query, filters } = input.criteria;

  // setTalentMatchmakerContext throws on setItem failure; the
  // caller (talent page) catches and surfaces the error inline
  // so the buyer is never sent to a destination they cannot
  // resume from. Throwing here is intentional — a swallowed
  // failure would let the page navigate to /matchmaker where
  // readTalentMatchmakerContext would return null and the
  // matchmaker would silently render without a highlight.
  const setContext = input.setContext ?? setTalentMatchmakerContext;
  setContext({ source: "talent", offeringId, query, filters });

  if (input.user === null) {
    input.router.push(MATCHMAKER_FROM_TALENT_LOGIN_RETURN);
    return;
  }
  const hasBuyer = input.actingWorkspace?.capabilities.includes("Buyer") ?? false;
  if (!hasBuyer) {
    input.router.push(MATCHMAKER_FROM_TALENT_INTENT_RETURN);
    return;
  }
  input.router.push(MATCHMAKER_FROM_TALENT_DIRECT);
}
