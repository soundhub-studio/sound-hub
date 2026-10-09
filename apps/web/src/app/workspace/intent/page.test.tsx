// Focused contract coverage for the M2 #83 intent page. The repo's
// existing test pattern uses source-level contract assertions
// (readFileSync + regex) rather than a React DOM testing library;
// this test file pins the BEHAVIORAL contract — verbatim UI
// rendering, capability-only intent CTA, server-resolved safe
// navigation — by reading the page source.
//
// Cross-tab / browser behaviour (arrow keys, focus management,
// network wiring) is covered end-to-end by the Playwright spec
// at apps/web/e2e/intent-and-workspace-switch.spec.ts.

/* eslint-disable @typescript-eslint/no-floating-promises */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const repoRoot = `${new URL("../../../../", import.meta.url).pathname}`;

function readFile(relativePath: string): string {
  return readFileSync(`${repoRoot}src/app/${relativePath}`, "utf8");
}

describe("IntentPage — M2 #83 capability-only contract (#83 re-revision)", () => {
  test("Intent page does NOT fetch a Seller participation terms helper", () => {
    // #83 re-revision: the M2 #83 slice does NOT collect a generic
    // Seller participation/terms acceptance at capability-
    // provisioning time. The page therefore has no
    // fetchSellerParticipationTerms call. Check the CODE only —
    // the file documents the #83 re-revision in comments.
    const source = readFile("workspace/intent/page.tsx");
    assert.ok(
      !/fetchSellerParticipationTerms/.test(source),
      "intent page MUST NOT call fetchSellerParticipationTerms",
    );
    const codeOnly = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .filter((line) => !line.trim().startsWith("/*") && !line.trim().startsWith("*/"))
      .join("\n");
    assert.ok(
      !/Seller participation terms|seller.participation/i.test(codeOnly),
      "intent page code MUST NOT render Seller participation acceptance copy",
    );
  });

  test("Intent page submits `expectedCapabilities` from the current capability set, with optional `returnTo`", () => {
    const source = readFile("workspace/intent/page.tsx");
    // The body MUST carry `expectedCapabilities` (the state the
    // UI observed) so the server can detect a stale submission.
    // The schema is `.strict()`; the page never constructs
    // `null` / junk / `sellerAcceptance`.
    assert.ok(
      /expectedCapabilities:\s*\[\.\.\.currentCapabilities\]/.test(source),
      "page MUST submit `expectedCapabilities` derived from the current capability set",
    );
    assert.ok(
      /const intentBody:\s*IntentRequestV1\s*=/.test(source),
      "page MUST submit an IntentRequestV1 typed payload",
    );
    assert.ok(
      /\.\.\.bodyBase/.test(source) || /\{ \.\.\.bodyBase/.test(source),
      "page MUST spread bodyBase when carrying the validated return",
    );
    // Check the CODE (strip JSDoc/comment lines) for sellerAcceptance;
    // the file documents the #83 re-revision decision in comments, but
    // the implementation must not contain the field.
    const codeOnly = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .filter((line) => !line.trim().startsWith("/*") && !line.trim().startsWith("*/"))
      .join("\n");
    assert.ok(
      !/sellerAcceptance/.test(codeOnly),
      "intent page MUST NOT construct a sellerAcceptance payload",
    );
  });

  test("Intent page derives affordances from current Personal Workspace capabilities", () => {
    const source = readFile("workspace/intent/page.tsx");
    // The page reads `actingWorkspace.capabilities` and switches
    // between the three affordance shapes (none / Buyer-only /
    // Seller-only / Both). The Both branch renders a calm panel
    // with no form; the Buyer/Seller branches render a single
    // explicit "Add … too" affordance carrying the observed
    // capability set as `expectedCapabilities`.
    assert.ok(
      /currentCapabilities\.length\s*===\s*0/.test(source),
      "empty-capability branch renders the three-card initial form",
    );
    assert.ok(
      /isBuyer\s*\?\s*\(/i.test(source) || /isBuyer\b/.test(source),
      "Buyer-only branch renders the Offer add affordance",
    );
    assert.ok(
      /hasBoth/.test(source),
      "Both-capability branch renders the calm panel without a form",
    );
  });

  test("Intent page surfaces INTENT_CONFLICT recovery (freshCapabilities + reload button)", () => {
    const source = readFile("workspace/intent/page.tsx");
    assert.ok(/INTENT_CONFLICT/.test(source), "page MUST handle the INTENT_CONFLICT error code");
    assert.ok(
      /freshCapabilities/.test(source),
      "page MUST surface freshCapabilities from the INTENT_CONFLICT envelope",
    );
    assert.ok(
      /data-testid="intent-reload"/.test(source),
      "INTENT_CONFLICT surfaces a reload affordance",
    );
  });

  test("Intent page reads + validates `?return=` from the URL", () => {
    const source = readFile("workspace/intent/page.tsx");
    assert.ok(/useSearchParams\(\)/.test(source), "page reads the query string");
    assert.ok(/validatedReturnTo/.test(source), "page derives `validatedReturnTo` from the URL");
    assert.ok(
      /isLocallyValidReturnPath/.test(source),
      "page uses the local same-origin path validator",
    );
  });

  test("Switch link threads `?return=` through (cross-Workspace continuation)", () => {
    const source = readFile("workspace/intent/page.tsx");
    assert.ok(
      /\/workspace\/switch\?target=/.test(source),
      "switch link includes the `target` parameter",
    );
    // The switch link's return parameter is now derived from a
    // `switchReturn` variable (M2 #87 Finding 9: the return must
    // route through /workspace/intent so the human re-presents
    // their intent choice before landing on the original return).
    // The post-switch destination still preserves the validated
    // `?return=` value as the inner intent return.
    assert.ok(
      /switchReturn/.test(source),
      "switch link MUST derive a switch return target rather than passing validatedReturnTo directly",
    );
    assert.ok(
      /\/workspace\/intent\?return=/.test(source),
      "switch return MUST be threaded through /workspace/intent so intent is never bypassed",
    );
  });

  test("Submit is disabled only until intent is chosen", () => {
    const source = readFile("workspace/intent/page.tsx");
    assert.ok(
      /submitDisabled\s*=\s*intent\s*===\s*null\s*\|\|\s*submitting/.test(source),
      "submitDisabled MUST be `intent === null || submitting`",
    );
    assert.ok(
      !/termsAccepted|sellerAcceptanceRequired|sellerBlocked/.test(source),
      "intent page MUST NOT introduce Seller-terms / acceptance gating",
    );
  });

  test("Intent page does NOT invent production legal copy — no Seller terms text", () => {
    const source = readFile("workspace/intent/page.tsx");
    // The page MUST NOT contain any hardcoded Seller legal
    // copy in CODE. #83 re-revision lifts this boundary entirely.
    // The file documents the #83 re-revision decision in comments
    // (which is fine); only code lines are checked.
    const codeLines = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .filter((line) => !line.trim().startsWith("/*") && !line.trim().startsWith("*/"));
    for (const trimmed of codeLines) {
      if (/\b(shall|hereby|terms of service)\b/i.test(trimmed)) {
        assert.fail(`intent page MUST NOT invent production legal copy; found line: ${trimmed}`);
      }
    }
  });

  test("POST success navigates via navigateAfterIntent (server-resolved safeReturnTo only)", () => {
    const source = readFile("workspace/intent/page.tsx");
    assert.ok(/import\s*\{\s*navigateAfterIntent/.test(source));
    assert.ok(
      /navigateAfterIntent\(\s*\{\s*router\s*,\s*response\s*\}\s*\)/.test(source),
      "page MUST navigate via the navigateAfterIntent seam with the response",
    );
  });

  // Codex React correctness finding: visiting /workspace/intent
  // without a valid session must not trigger navigation during
  // render. The previous implementation called
  // `router.replace("/login?return=/workspace/intent")` directly
  // inside an `if (!user)` branch in the render body, which
  // throws "Cannot update Router while rendering IntentPageInner"
  // when React's reconciler schedules the navigation against the
  // live render. The fix moves the redirect into a `useEffect`
  // callback so it executes after commit, and keeps the loading
  // surface mounted for both the still-loading and the signed-
  // out branches (the redirect fires from the effect, not from
  // render).
  test("Signed-out redirect lives inside useEffect — NEVER in the render body", () => {
    const source = readFile("workspace/intent/page.tsx");

    // The redirect target MUST be reachable from a useEffect
    // callback body. Extract every useEffect body (anchored on
    // the `useEffect(` opener and the matching `[deps]` close)
    // and assert at least one of them issues the /login
    // redirect.
    const effectBodies: string[] = [];
    const effectRegex =
      /useEffect\(\s*(?:\(\s*\)\s*=>\s*\{|\(\s*\(\s*\)\s*=>\s*\{|\(\s*\(\)\s*=>\s*\{)[\s\S]*?\}\s*,\s*\[[^\]]+\]\s*\)/g;
    let effectMatch: RegExpExecArray | null;
    while ((effectMatch = effectRegex.exec(source)) !== null) {
      effectBodies.push(effectMatch[0]);
    }
    assert.ok(
      effectBodies.length >= 1,
      "page MUST define at least one useEffect callback so the redirect can run after commit",
    );
    const effectIssuesRedirect = effectBodies.some((body) =>
      /router\.replace\([\s\S]*?\/login\?return=\/workspace\/intent/.test(body),
    );
    assert.ok(
      effectIssuesRedirect,
      "the signed-out redirect (router.replace('/login?return=/workspace/intent')) MUST live inside a useEffect callback so it never fires during render",
    );

    // Now strip every useEffect body from the source and assert
    // the remaining render code does NOT issue the redirect.
    // A regression that puts the redirect back in the render
    // body would leave a `router.replace("/login?return=...`)`
    // call in the residue and fail here.
    let renderResidue = source;
    for (const body of effectBodies) {
      renderResidue = renderResidue.replace(body, "/* useEffect body elided */");
    }
    assert.equal(
      /router\.replace\(\s*["'`]\/login\?return=\/workspace\/intent/.test(renderResidue),
      false,
      "render body MUST NOT call router.replace('/login?return=/workspace/intent') — the redirect is owned by useEffect so it fires after commit, never during render",
    );
  });

  test("Render guard keeps the loading surface mounted for both loading=true and user=null", () => {
    // While the session is still resolving OR the user is null
    // (signed out), the page renders the loading surface — the
    // useEffect fires after commit and navigates. The render
    // guard MUST therefore cover `loading || !user`, not just
    // `loading`, so a signed-out visitor sees the loading
    // surface (data-testid="intent-loading") for the brief
    // window before the useEffect commits the redirect.
    const source = readFile("workspace/intent/page.tsx");
    assert.ok(
      /if\s*\(\s*loading\s*\|\|\s*!user\s*\)/.test(source),
      "the render guard MUST cover both `loading` and `!user` so the loading surface stays mounted for signed-out visitors until the useEffect redirect commits",
    );
    // And the loading surface MUST render `data-testid="intent-loading"`
    // inside that branch — the Playwright walkToIntentPage
    // helper and the existing render contract both depend on it.
    const guardMatch = source.match(
      /if\s*\(\s*loading\s*\|\|\s*!user\s*\)\s*\{[\s\S]*?\}\s*(?=(if|return)\s*\()/,
    );
    if (guardMatch) {
      assert.ok(
        /data-testid="intent-loading"/.test(guardMatch[0]),
        'the loading||!user branch MUST render the intent-loading surface (data-testid="intent-loading")',
      );
    }
  });

  test("Intent page reads `loading` from useSession so the redirect fires only after the session settles", () => {
    // The useEffect MUST guard on `loading` so the redirect
    // never fires for a transient null user mid-fetch. This
    // mirrors the dashboard's pattern
    // (`apps/web/src/app/dashboard/page.tsx`) where the
    // capability redirect checks `loading` first.
    const source = readFile("workspace/intent/page.tsx");
    const useSessionMatch = source.match(/useSession\(\)/);
    assert.ok(useSessionMatch, "page MUST consume useSession()");
    assert.ok(
      /\{\s*user\s*,\s*loading\s*,\s*refresh\s*\}/.test(source),
      "page MUST destructure `loading` from useSession so the redirect effect can guard on it",
    );
    assert.ok(
      /useEffect\([\s\S]*?if\s*\(\s*loading\s*\)\s*return[\s\S]*?\}\s*,\s*\[\s*loading\s*,\s*user\s*,\s*router\s*\]/.test(
        source,
      ),
      "the redirect useEffect MUST guard on `loading`, depend on [loading, user, router], and short-circuit while the session is still resolving",
    );
  });
});

describe("navigateAfterIntent — server-resolved safeReturnTo seam (§5 / P1-005)", () => {
  test("helper consumes only `safeReturnTo` from the response (no client-side validator)", () => {
    const source = readFile("lib/navigate-after-intent.ts");
    assert.ok(/input\.response\.safeReturnTo/.test(source));
    const codeOnly = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join("\n");
    assert.ok(
      !/response\.user/.test(codeOnly),
      "seam code MUST NOT inspect response.user (server is the resolver authority)",
    );
    assert.ok(
      !/window\.location|location\.search|URLSearchParams/.test(codeOnly),
      "seam code MUST NOT read raw location / URL parameters",
    );
  });

  test("helper defaults to /dashboard when safeReturnTo is null", () => {
    const source = readFile("lib/navigate-after-intent.ts");
    assert.ok(/safeReturnTo\s*\?\?\s*"\/dashboard"/.test(source));
  });
});

describe("ActingWorkspaceSelector — #83 context model (§4 / P1-005)", () => {
  test("handleSelect does NOT write localStorage (it only calls setPendingTarget)", () => {
    const source = readFile("components/ActingWorkspaceSelector.tsx");
    const handleSelectMatch = source.match(/(?:const|function)\s+handleSelect\b[\s\S]*?\n {2}\};?/);
    assert.ok(handleSelectMatch, "handleSelect must exist");
    const handleBody = String(handleSelectMatch)
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join("\n");
    assert.ok(
      /setPendingTarget\(targetId\)/.test(handleBody),
      "handleSelect MUST call setPendingTarget (no localStorage write on select)",
    );
    assert.ok(
      !/localStorage|writeRemembered/.test(handleBody),
      "handleSelect code MUST NOT write localStorage before explicit confirmation",
    );
    assert.ok(
      /\/workspace\/switch\?/.test(handleBody) && /target:/.test(handleBody),
      "handleSelect MUST navigate to the switch interstitial with the target query parameter",
    );
  });
});

describe("Switch interstitial — commit / cancel behaviour (§4 / P1-005)", () => {
  test("Switch page calls commitPendingTarget on Switch and continue", () => {
    const source = readFile("workspace/switch/page.tsx");
    // The continue handler forwards the validated `?return=`
    // (queryReturnTo) into commitPendingTarget so the server can
    // re-resolve it under the post-commit actor.
    assert.ok(
      /commitPendingTarget\(queryReturnTo\)/.test(source),
      "Switch and continue MUST forward queryReturnTo into commitPendingTarget",
    );
  });

  test("Switch page calls cancelPendingTarget on Cancel (commit state untouched)", () => {
    const source = readFile("workspace/switch/page.tsx");
    assert.ok(/cancelPendingTarget\(\)/.test(source));
  });

  test("Switch page promotes a query-target to pending on mount (P1-002 deep-link / hard reload)", () => {
    const source = readFile("workspace/switch/page.tsx");
    assert.ok(/useSearchParams\(\)/.test(source), "page reads query string via useSearchParams");
    assert.ok(
      /setPendingTarget\(\s*queryCandidate\.workspaceId\s*\)/.test(source) ||
        /setPendingTarget\(queryCandidate\.workspaceId\)/.test(source) ||
        /setPendingTarget\(\s*candidate\.workspaceId\s*\)/.test(source) ||
        /setPendingTarget\(candidate\.workspaceId\)/.test(source),
      "page promotes membership-validated query target into pending state (P2-001 shared queryCandidate variable)",
    );
    assert.ok(
      /workspaceStatus.*Active/.test(source) || /status === "Active"/.test(source),
      "page only promotes ACTIVE Workspaces",
    );
  });

  // Switch interstitial contract: the cross-Workspace `?return=`
  // is read + validated at page entry so the Continue handler
  // can hand it to the server for re-resolution under the
  // POST-COMMIT acting Workspace context. Cancel never
  // consumes the target Workspace's return continuation — it
  // returns to the safe current-Workspace dashboard.
  test("Switch page reads + validates `?return=`; Cancel returns to /dashboard (does not follow the cross-Workspace return)", () => {
    const source = readFile("workspace/switch/page.tsx");
    assert.ok(/queryReturnTo/.test(source), "switch page derives `queryReturnTo` from the URL");
    assert.ok(
      /isLocallyValidReturnPath/.test(source),
      "switch page uses the local same-origin path validator",
    );
    // The Cancel handler must navigate to `/dashboard` and NOT
    // follow `queryReturnTo` — Cancel performs no switch and
    // never lands the customer on a destination owned by a
    // Workspace they are no longer acting as.
    const handleCancelMatch = source.match(/const handleCancel\s*=[\s\S]*?\n\s*\};/);
    assert.ok(handleCancelMatch, "switch page exposes a handleCancel handler");
    const cancelBody = handleCancelMatch ? handleCancelMatch[0] : "";
    assert.ok(
      /router\.replace\("\/dashboard"\)/.test(cancelBody),
      "Cancel must navigate to /dashboard (not the cross-Workspace ?return=)",
    );
    assert.ok(
      !/queryReturnTo/.test(cancelBody),
      "Cancel handler MUST NOT consume the target Workspace's return continuation",
    );
  });
});

describe("Dashboard — capability-truthful copy (§4 / P1-005 / P1-004)", () => {
  // Deals is a Deal-party destination, not a Buyer-only one.
  // Sellers are also Deal parties; the action is available when
  // EITHER capability is present.
  test('Dashboard renders "View your deals" when Buyer OR Seller capability is present', () => {
    const source = readFile("dashboard/page.tsx");
    // The "View your deals" link MUST be inside an `||` guard that
    // matches either capability.
    assert.ok(
      /capabilities\.includes\("Buyer"\)\s*\|\|\s*actingWorkspace\.capabilities\.includes\("Seller"\)/.test(
        source,
      ),
      "View your deals MUST render for Buyer OR Seller acting Workspaces",
    );
  });

  test("Dashboard Seller-readiness copy does NOT expose internal ticket numbers (#84, #85)", () => {
    const source = readFile("dashboard/page.tsx");
    assert.ok(
      !/(#84|#85)/.test(source),
      "dashboard copy MUST NOT expose internal ticket numbers to customers (Codex P1-004)",
    );
    assert.ok(
      /Selling your services|Manage your services|ServiceOffering|services are set up/i.test(
        source,
      ),
      "dashboard Seller copy MUST remain capability-aware and customer-safe",
    );
  });

  // The previous "Profile and service setup unlocks after your
  // first deal" copy reversed the documented M2 journey. The
  // new copy must reflect the forward progression (publish
  // profile + activate service → receive requests). Strip
  // comment lines so the test only asserts on rendered copy.
  test("Dashboard Seller-readiness copy reflects forward journey (no reversed first-deal wording)", () => {
    const source = readFile("dashboard/page.tsx");
    const codeOnly = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .filter((line) => !line.trim().startsWith("/*") && !line.trim().startsWith("*/"))
      .join("\n");
    assert.ok(
      !/unlocks after your first deal/i.test(codeOnly),
      "dashboard MUST NOT contain the reversed 'unlocks after your first deal' copy",
    );
    assert.ok(
      /Publish your professional profile|Publish|private drafts/i.test(codeOnly),
      "dashboard Seller readiness copy MUST reflect the forward journey",
    );
  });

  test("Dashboard never renders Choose-intent CTA when actor is Organization", () => {
    const source = readFile("dashboard/page.tsx");
    assert.ok(
      /actingWorkspace\.workspaceType\s*!==\s*"Personal"/.test(source),
      "Choose intent CTA / auto-redirect MUST only fire when actor is Personal",
    );
  });
});

describe("Shell — capability-truthful destinations (§4 / P1-005 / P1-004)", () => {
  test("Shell reads actingWorkspace from useActingWorkspace (NOT user.workspaces[0])", () => {
    const source = readFile("components/Shell.tsx");
    assert.ok(
      /useActingWorkspace\(\)/.test(source) && /actingWorkspace/.test(source),
      "Shell MUST derive destinations from the acting-Workspace provider",
    );
    assert.ok(
      !/user\.workspaces\[0\]/.test(source),
      "Shell MUST NOT pick the first workspace from user.workspaces array",
    );
  });

  // The Shell exposes the Deals destination for Buyer OR
  // Seller capability. Sellers are also Deal parties.
  test("Shell exposes Deals destination for Buyer OR Seller capability", () => {
    const source = readFile("components/Shell.tsx");
    assert.ok(
      /capabilities\.includes\("Buyer"\)\s*\|\|\s*capabilities\.includes\("Seller"\)/.test(source),
      "Shell MUST expose Deals when Buyer OR Seller capability is present",
    );
  });

  test("Finding 8 — Buyer-only branch exposes a Continue link when validatedReturnTo is set", () => {
    const source = readFile("workspace/intent/page.tsx");
    // The skip-to-return link MUST be rendered when the user
    // already has a capability (Buyer-only or Seller-only) AND
    // validatedReturnTo is set. The M2 #87 Finding 12
    // refinement further gates this on `isBuyer` when the return
    // is to /matchmaker, but the Buyer-only-or-Seller-only
    // capability floor is the original Finding 8 contract.
    //
    // The gate is now centralised into `skipLinkEligible` (a
    // named variable) so the JSX reads the named gate rather
    // than an inline expression. The test pins the existence of
    // that named gate.
    assert.ok(
      /skipLinkEligible/.test(source),
      "intent page MUST centralize skip-link eligibility into a named gate (the Finding 12 refinement reads isBuyer through this gate)",
    );
    assert.ok(
      /data-testid="intent-skip-to-return"/.test(source),
      "intent page MUST render the skip-to-return link with a stable testid for buyer-flow e2e coverage",
    );
    assert.ok(
      /href=\{validatedReturnTo\}/.test(source),
      "skip-to-return link MUST use the validatedReturnTo href so the buyer-flow continuation is honored",
    );
  });

  // M2 (#87) P2 — Codex 4th review Finding 12. The
  // "Continue without changing capabilities" link was exposed
  // to Seller-only Workspaces heading to /matchmaker. A
  // Seller-only Workspace cannot use /matchmaker, so following
  // the link lands the buyer on the matchmaker's no-Buyer
  // dead-end. The page must gate the skip link on isBuyer when
  // the return target is /matchmaker. For other return targets
  // (e.g. /dashboard), the original behavior is preserved:
  // any partial-capability Workspace can skip.
  test("Finding 12 — skip link is gated on isBuyer when the return target is /matchmaker", () => {
    const source = readFile("workspace/intent/page.tsx");
    assert.ok(
      /isMatchmakerReturn/.test(source) ||
        /validatedReturnTo\.startsWith\("\/matchmaker"\)/.test(source),
      "intent page MUST detect /matchmaker as a return target that requires Buyer capability",
    );
    assert.ok(
      /isBuyer\s*\|\|\s*!isMatchmakerReturn/.test(source),
      "skip link MUST be eligible only for Buyer-capable Workspaces when returning to /matchmaker",
    );
    // The skip link is rendered from the new `skipLinkEligible`
    // gate (the prior inline condition was too permissive for
    // /matchmaker returns).
    assert.ok(
      /skipLinkEligible/.test(source),
      "intent page MUST centralize skip-link eligibility into a named gate",
    );
  });

  // M2 (#87) P2 — Codex 4th review Finding 9. The previous
  // switch link used `&return=${validatedReturnTo}` directly,
  // which sent the post-switch navigation straight to
  // /matchmaker and skipped intent entirely. The page now
  // routes the switch through /workspace/intent so the human
  // re-presents their intent choice before landing on the
  // original return. This is the only path that prevents a
  // non-Personal acting Workspace from bypassing intent.
  test("Finding 9 — switch link routes through /workspace/intent to preserve the intent round-trip", () => {
    const source = readFile("workspace/intent/page.tsx");
    // The switch return must be derived, not raw validatedReturnTo.
    assert.ok(
      /switchReturn/.test(source),
      "intent page MUST derive a switch return target that routes through /workspace/intent",
    );
    // The switch return must include /workspace/intent in the URL.
    assert.ok(
      /\/workspace\/intent\?return=/.test(source),
      "switch return MUST include /workspace/intent as the post-switch destination",
    );
  });
});
