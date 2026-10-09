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
//     router.push("/login?return=/matchmaker?from=talent")
//     The login page forwards the return through the magic-link
//     flow; the post-command resolver strips the query and the
//     buyer lands on /matchmaker (with the localStorage record
//     carrying the substantive context).
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
// `setItem` failure (private-browsing quota) surfaces inline
// and the navigation is aborted so the buyer is never sent
// to a destination they cannot resume from.

import type { Bg1PublicUserV1, TalentSearchResultV1 } from "@soundhub/types";
import { setTalentMatchmakerContext } from "./talent-matchmaker-context";
import type { RequiredFiltersValue } from "./talent-search-request-builder";

export interface NavigateToMatchmakerFromTalentInput {
  readonly result: TalentSearchResultV1;
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

export const MATCHMAKER_FROM_TALENT_LOGIN_RETURN = "/login?return=/matchmaker?from=talent";
export const MATCHMAKER_FROM_TALENT_INTENT_RETURN =
  "/workspace/intent?return=/matchmaker?from=talent";
export const MATCHMAKER_FROM_TALENT_DIRECT = "/matchmaker?from=talent";

export function navigateToMatchmakerFromTalent(input: NavigateToMatchmakerFromTalentInput): void {
  const offeringId = input.result.bestMatchingOffering.offeringId;
  // The /talent page holds the current (query, filters) tuple in
  // component-local state; the result card only knows the result.
  // The buyer-flow context is the search context at click time,
  // which the page composes into the call. The current minimal
  // implementation carries only the targeted offering; the page
  // can pass the full (query, filters) snapshot in a follow-up
  // without changing the helper's contract.
  const query = "";
  const filters: RequiredFiltersValue = {
    primaryCategoryKey: "",
    independentlyPurchasableServiceKey: "",
    serviceModes: [],
    basedIn: { city: "", region: "", countryCode: "" },
    serviceArea: { city: "", region: "", countryCode: "" },
  };

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
