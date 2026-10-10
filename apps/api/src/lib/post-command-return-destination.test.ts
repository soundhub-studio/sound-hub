// M2 #83 remediation (§5): post-command return-destination
// resolver behaviour. The resolver is the SERVER-SIDE authority
// for `safeReturnTo`. The browser consumes only the resolved
// output and never re-derives authorization.
//
// Coverage:
//   - happy path / open route (`/talent`)
//   - capability-gated route + actor has capability
//   - capability-gated route + actor lacks capability → falls back
//   - Workspace-scoped query param + accessible → kept
//   - Workspace-scoped query param + stale → falls back
//   - action endpoint → falls back
//   - unknown internal route → falls back
//   - shape validation fail (e.g., `https://evil/x`) → falls back
//   - null returnTo → null

import assert from "node:assert/strict";
import { describe, test } from "node:test";

/* eslint-disable @typescript-eslint/no-floating-promises */
import type { Bg1PublicUserV1 } from "@soundhub/types";
import {
  SafeReturnToFallback,
  resolvePostCommandReturnDestination,
} from "./post-command-return-destination.js";

const ALLOWED_ORIGIN = "http://localhost:3000";

function buildUser(input: {
  readonly personal?: boolean;
  readonly org?: boolean;
  readonly buyer?: boolean;
  readonly seller?: boolean;
  readonly personalId?: string;
  readonly orgId?: string;
}): Bg1PublicUserV1 {
  const workspaces: Bg1PublicUserV1["workspaces"] = [];
  if (input.personal) {
    workspaces.push({
      workspaceId: input.personalId ?? "ws-personal",
      slug: "personal",
      name: "Personal",
      workspaceType: "Personal",
      workspaceStatus: "Active",
      capabilities: [
        ...(input.buyer ? ["Buyer" as const] : []),
        ...(input.seller ? ["Seller" as const] : []),
      ],
    });
  }
  if (input.org) {
    workspaces.push({
      workspaceId: input.orgId ?? "ws-org",
      slug: "org",
      name: "Org",
      workspaceType: "Organization",
      workspaceStatus: "Active",
      capabilities: [
        ...(input.buyer ? ["Buyer" as const] : []),
        ...(input.seller ? ["Seller" as const] : []),
      ],
    });
  }
  return {
    userAccountId: "user-1",
    email: "u@example.test",
    displayName: null,
    identityProvider: "deterministic",
    setupState: "converged",
    workspaces,
  };
}

describe("resolvePostCommandReturnDestination", () => {
  test("null returnTo short-circuits to null", () => {
    const user = buildUser({ personal: true, buyer: true });
    const result = resolvePostCommandReturnDestination({
      returnTo: null,
      freshUser: user,
      actingWorkspaceId: "ws-personal",
      allowedOrigin: ALLOWED_ORIGIN,
    });
    assert.equal(result, null);
  });

  test("undefined returnTo short-circuits to null", () => {
    const user = buildUser({ personal: true, buyer: true });
    const result = resolvePostCommandReturnDestination({
      returnTo: undefined,
      freshUser: user,
      actingWorkspaceId: "ws-personal",
      allowedOrigin: ALLOWED_ORIGIN,
    });
    assert.equal(result, null);
  });

  test("valid open route /dashboard is accepted", () => {
    const user = buildUser({ personal: true });
    const result = resolvePostCommandReturnDestination({
      returnTo: "/dashboard",
      freshUser: user,
      actingWorkspaceId: "ws-personal",
      allowedOrigin: ALLOWED_ORIGIN,
    });
    assert.deepEqual(result, { route: "/dashboard", path: "/dashboard" });
  });

  test("valid open route /talent is accepted (no capability required)", () => {
    const user = buildUser({ personal: true }); // no capabilities
    const result = resolvePostCommandReturnDestination({
      returnTo: "/talent",
      freshUser: user,
      actingWorkspaceId: "ws-personal",
      allowedOrigin: ALLOWED_ORIGIN,
    });
    assert.deepEqual(result, { route: "/talent", path: "/talent" });
  });

  // M2 #87: /matchmaker is open (no capability gate). The substantive
  // buyer-flow state (which offering to highlight, which brief / filters
  // to pre-fill) rides in a localStorage record; the URL marker
  // `?from=talent` is a routing hint, not a contract surface, and may
  // be stripped by the bounded return resolver.
  test("valid open route /matchmaker is accepted (no capability required)", () => {
    const user = buildUser({ personal: true }); // no capabilities
    const result = resolvePostCommandReturnDestination({
      returnTo: "/matchmaker",
      freshUser: user,
      actingWorkspaceId: "ws-personal",
      allowedOrigin: ALLOWED_ORIGIN,
    });
    assert.deepEqual(result, { route: "/matchmaker", path: "/matchmaker" });
  });

  test("/matchmaker?from=talent strips the query to /matchmaker (the marker is not part of the bounded route)", () => {
    const user = buildUser({ personal: true, buyer: true });
    const result = resolvePostCommandReturnDestination({
      returnTo: "/matchmaker?from=talent",
      freshUser: user,
      actingWorkspaceId: "ws-personal",
      allowedOrigin: ALLOWED_ORIGIN,
    });
    assert.deepEqual(result, { route: "/matchmaker", path: "/matchmaker" });
  });

  test("/matchmaker is reachable from a signed-in Buyer-capable Workspace (regression gate for the no-capability-gate contract)", () => {
    // A Buyer-only Workspace returning from a non-#87 command must
    // still be able to resume /matchmaker. Adding a Buyer gate to
    // /matchmaker would break the "anonymous discovery on /talent"
    // requirement, so the new route must stay open.
    const user = buildUser({ personal: true, buyer: true });
    const result = resolvePostCommandReturnDestination({
      returnTo: "/matchmaker",
      freshUser: user,
      actingWorkspaceId: "ws-personal",
      allowedOrigin: ALLOWED_ORIGIN,
    });
    if (!result) throw new Error("expected result");
    assert.equal(result.route, "/matchmaker");
    assert.equal(result.path, "/matchmaker");
  });

  test("/deals + actor with Buyer capability is kept", () => {
    const user = buildUser({ personal: true, buyer: true });
    const result = resolvePostCommandReturnDestination({
      returnTo: "/deals",
      freshUser: user,
      actingWorkspaceId: "ws-personal",
      allowedOrigin: ALLOWED_ORIGIN,
    });
    assert.deepEqual(result, { route: "/deals", path: "/deals" });
  });

  // P1-001: `/deals` is gated by Buyer OR Seller. Deals are a
  // party destination for BOTH buyer and seller Workspaces, so a
  // Seller-only Workspace returning from Offer intent or a
  // Seller-Workspace switch must be able to resume the valid
  // `/deals` continuation under the fresh post-command actor.
  test("/deals + Seller-only actor is kept (P1-001: Deals are a party destination)", () => {
    const user = buildUser({ personal: true, seller: true });
    const result = resolvePostCommandReturnDestination({
      returnTo: "/deals",
      freshUser: user,
      actingWorkspaceId: "ws-personal",
      allowedOrigin: ALLOWED_ORIGIN,
    });
    assert.deepEqual(result, { route: "/deals", path: "/deals" });
  });

  test("/deals + dual-capability actor is kept (P1-001)", () => {
    const user = buildUser({ personal: true, buyer: true, seller: true });
    const result = resolvePostCommandReturnDestination({
      returnTo: "/deals",
      freshUser: user,
      actingWorkspaceId: "ws-personal",
      allowedOrigin: ALLOWED_ORIGIN,
    });
    assert.deepEqual(result, { route: "/deals", path: "/deals" });
  });

  test("/deals + actor with neither Buyer nor Seller falls back (P1-001)", () => {
    const user = buildUser({ personal: true }); // no capabilities
    assert.throws(
      () =>
        resolvePostCommandReturnDestination({
          returnTo: "/deals",
          freshUser: user,
          actingWorkspaceId: "ws-personal",
          allowedOrigin: ALLOWED_ORIGIN,
        }),
      (err: unknown) => err instanceof SafeReturnToFallback && err.reason === "missing-capability",
    );
  });

  test("/seller-requests + actor with Seller capability is kept", () => {
    const user = buildUser({ personal: true, seller: true });
    const result = resolvePostCommandReturnDestination({
      returnTo: "/seller-requests",
      freshUser: user,
      actingWorkspaceId: "ws-personal",
      allowedOrigin: ALLOWED_ORIGIN,
    });
    assert.deepEqual(result, { route: "/seller-requests", path: "/seller-requests" });
  });

  test("/seller-requests + actor without Seller capability falls back", () => {
    const user = buildUser({ personal: true }); // no Seller
    assert.throws(
      () =>
        resolvePostCommandReturnDestination({
          returnTo: "/seller-requests",
          freshUser: user,
          actingWorkspaceId: "ws-personal",
          allowedOrigin: ALLOWED_ORIGIN,
        }),
      (err: unknown) => err instanceof SafeReturnToFallback && err.reason === "missing-capability",
    );
  });

  test("/dashboard/audio + actor with Seller capability is kept", () => {
    const user = buildUser({ personal: true, seller: true });
    const result = resolvePostCommandReturnDestination({
      returnTo: "/dashboard/audio",
      freshUser: user,
      actingWorkspaceId: "ws-personal",
      allowedOrigin: ALLOWED_ORIGIN,
    });
    assert.deepEqual(result, { route: "/dashboard/audio", path: "/dashboard/audio" });
  });

  test("workspace-scoped query parameter + accessible workspace is kept", () => {
    const user = buildUser({ personal: true, buyer: true });
    const result = resolvePostCommandReturnDestination({
      returnTo: "/deals?workspace=ws-personal&q=foo",
      freshUser: user,
      actingWorkspaceId: "ws-personal",
      allowedOrigin: ALLOWED_ORIGIN,
    });
    assert.deepEqual(result, { route: "/deals", path: "/deals" });
  });

  test("workspace-scoped query parameter + stale workspace falls back", () => {
    const user = buildUser({ personal: true, buyer: true });
    assert.throws(
      () =>
        resolvePostCommandReturnDestination({
          returnTo: "/talent?workspace=ws-not-mine",
          freshUser: user,
          actingWorkspaceId: "ws-personal",
          allowedOrigin: ALLOWED_ORIGIN,
        }),
      (err: unknown) => err instanceof SafeReturnToFallback && err.reason === "stale-workspace",
    );
  });

  test("/api/* endpoint falls back", () => {
    const user = buildUser({ personal: true });
    assert.throws(
      () =>
        resolvePostCommandReturnDestination({
          returnTo: "/api/auth/sign-out",
          freshUser: user,
          actingWorkspaceId: "ws-personal",
          allowedOrigin: ALLOWED_ORIGIN,
        }),
      (err: unknown) => err instanceof SafeReturnToFallback && err.reason === "action-endpoint",
    );
  });

  test("unknown internal route falls back", () => {
    const user = buildUser({ personal: true });
    assert.throws(
      () =>
        resolvePostCommandReturnDestination({
          returnTo: "/admin",
          freshUser: user,
          actingWorkspaceId: "ws-personal",
          allowedOrigin: ALLOWED_ORIGIN,
        }),
      (err: unknown) => err instanceof SafeReturnToFallback && err.reason === "unknown-route",
    );
  });

  test("Cross-Workspace destination (returnTo names a different accessible workspaceId) routes through the switch interstitial with the original returnTo preserved (P1-003)", () => {
    const user = buildUser({ personal: true, buyer: true, personalId: "ws-personal" });
    user.workspaces.push({
      workspaceId: "ws-org-other",
      slug: "org-other",
      name: "Other Org",
      workspaceType: "Organization",
      workspaceStatus: "Active",
      capabilities: ["Buyer"],
      role: "Owner",
      joinedAt: "2025-01-01T00:00:00.000Z",
    } as never);
    const result = resolvePostCommandReturnDestination({
      returnTo: "/deals?workspaceId=ws-org-other",
      freshUser: user,
      actingWorkspaceId: "ws-personal",
      allowedOrigin: ALLOWED_ORIGIN,
    });
    // The accessible-but-different workspaceId is routed through
    // the switch interstitial instead of leaking a
    // cross-Workspace destination. The ORIGINAL `returnTo` is
    // preserved (URL-encoded) as the `return` query parameter
    // so the post-switch server resolver can re-resolve the
    // continuation under the FRESH post-switch actor.
    assert.equal(result?.route, "/dashboard");
    assert.ok(result, "expected a cross-Workspace ResolvedDestination");
    const switchPath = result.path;
    assert.ok(
      switchPath.startsWith("/workspace/switch?target=ws-org-other&return="),
      `switch path must carry the original returnTo as a URL-encoded ?return= value (got ${switchPath})`,
    );
    // The encoded `return` value must round-trip back to the
    // original `/deals?workspaceId=ws-org-other` path when the
    // switch page reads it back via URLSearchParams.
    const parsed = new URLSearchParams(switchPath.slice(switchPath.indexOf("?") + 1));
    const recovered = decodeURIComponent(parsed.get("return") ?? "");
    assert.equal(recovered, "/deals?workspaceId=ws-org-other");
  });

  test("Cross-Workspace continuation is re-resolved against the post-switch acting Workspace (P1-003)", () => {
    // Round-trip guarantee: when the switch page calls the
    // acting-workspace commit with the preserved `?return=`
    // value, the server resolver runs AGAIN with the
    // POST-SWITCH actor. The result must resolve back to the
    // ORIGINAL cross-Workspace destination (now reachable
    // under the new actor) so the browser navigates there
    // instead of dropping to /dashboard.
    const user = buildUser({ personal: true, buyer: true, personalId: "ws-personal" });
    user.workspaces.push({
      workspaceId: "ws-org-other",
      slug: "org-other",
      name: "Other Org",
      workspaceType: "Organization",
      workspaceStatus: "Active",
      capabilities: ["Buyer"],
      role: "Owner",
      joinedAt: "2025-01-01T00:00:00.000Z",
    } as never);

    // Step 1: acting as `ws-personal`, returnTo names the
    // OTHER accessible Workspace — cross-Workspace branch
    // routes through the switch interstitial.
    const firstPass = resolvePostCommandReturnDestination({
      returnTo: "/deals?workspaceId=ws-org-other",
      freshUser: user,
      actingWorkspaceId: "ws-personal",
      allowedOrigin: ALLOWED_ORIGIN,
    });
    assert.ok(firstPass);
    const switchPath = firstPass.path;
    const parsed = new URLSearchParams(switchPath.slice(switchPath.indexOf("?") + 1));
    const preservedReturnTo = parsed.get("return");
    assert.ok(preservedReturnTo);

    // Step 2: the post-switch acting-Workspace is the OTHER
    // workspace. Re-running the resolver with the same
    // `freshUser` (post-switch server response) and the
    // preserved `returnTo` resolves to the original
    // destination.
    const secondPass = resolvePostCommandReturnDestination({
      returnTo: preservedReturnTo,
      freshUser: user,
      actingWorkspaceId: "ws-org-other",
      allowedOrigin: ALLOWED_ORIGIN,
    });
    assert.equal(secondPass?.route, "/deals");
    assert.equal(secondPass?.path, "/deals");
  });

  test("Cross-Workspace destination with trailing query params preserves the FULL validated original (P1-003)", () => {
    // The preserved `?return=` MUST carry every query parameter
    // the customer had on the URL, not just the workspaceId.
    const user = buildUser({ personal: true, buyer: true, personalId: "ws-personal" });
    user.workspaces.push({
      workspaceId: "ws-org-other",
      slug: "org-other",
      name: "Other Org",
      workspaceType: "Organization",
      workspaceStatus: "Active",
      capabilities: ["Buyer"],
      role: "Owner",
      joinedAt: "2025-01-01T00:00:00.000Z",
    } as never);
    const result = resolvePostCommandReturnDestination({
      returnTo: "/talent?workspaceId=ws-org-other&q=dancehall",
      freshUser: user,
      actingWorkspaceId: "ws-personal",
      allowedOrigin: ALLOWED_ORIGIN,
    });
    assert.ok(result);
    const parsed = new URLSearchParams(result.path.slice(result.path.indexOf("?") + 1));
    const recovered = decodeURIComponent(parsed.get("return") ?? "");
    assert.equal(recovered, "/talent?workspaceId=ws-org-other&q=dancehall");
  });

  // The composed cross-Workspace switch path MUST stay inside the
  // bounded `safeReturnTo` response contract (max length 256,
  // defined in `bg1ActingWorkspaceResponseV1Schema`). URL-encoding
  // expands every reserved byte into a `%xx` triplet, so a
  // 256-character input that explodes during encoding would
  // otherwise overflow the response schema and crash the
  // downstream parser with `too_big`. The resolver MUST bound the
  // composed output: when the encoded-with-`?return=` form would
  // exceed the cap, the resolver drops the preserved continuation
  // and emits the bounded `/workspace/switch?target=<id>` form.
  // The customer can still complete the switch; the post-commit
  // resolver returns the documented safe fallback (`/dashboard`)
  // for the missing continuation.
  test("Cross-Workspace destination with a near-cap (256-char) input stays inside the safeReturnTo response contract", () => {
    const user = buildUser({ personal: true, buyer: true, personalId: "ws-personal" });
    user.workspaces.push({
      workspaceId: "ws-org-other",
      slug: "org-other",
      name: "Other Org",
      workspaceType: "Organization",
      workspaceStatus: "Active",
      capabilities: ["Buyer"],
      role: "Owner",
      joinedAt: "2025-01-01T00:00:00.000Z",
    } as never);

    // Boundary probe: a valid 256-character cross-Workspace `/talent`
    // return. The composed switch URL (prefix + URL-encoded
    // value) MUST stay at or below 256 characters so the
    // `bg1ActingWorkspaceResponseV1Schema.safeReturnTo.max(256)`
    // contract accepts the response.
    const prefix = "/talent?workspaceId=ws-org-other&q=";
    assert.ok(prefix.length < 256);
    const maxReturnTo = `${prefix}${"a".repeat(256 - prefix.length)}`;
    assert.equal(maxReturnTo.length, 256);

    const result = resolvePostCommandReturnDestination({
      returnTo: maxReturnTo,
      freshUser: user,
      actingWorkspaceId: "ws-personal",
      allowedOrigin: ALLOWED_ORIGIN,
    });
    assert.ok(result);
    assert.ok(
      result.path.length <= 256,
      `composed path must stay inside the bounded response contract (got length ${result.path.length})`,
    );
  });

  test("Cross-Workspace destination with maximally-expanding input falls back to the bounded switch URL", () => {
    // Every byte becomes `%xx` during encoding — the worst-case
    // expansion grows a 256-character input to ~768 encoded
    // characters. The resolver MUST drop the encoded `?return=`
    // and emit the bounded `/workspace/switch?target=<id>` form
    // (still a valid bounded destination, still routes through
    // the explicit confirmation interstitial).
    const user = buildUser({ personal: true, buyer: true, personalId: "ws-personal" });
    user.workspaces.push({
      workspaceId: "ws-org-other",
      slug: "org-other",
      name: "Other Org",
      workspaceType: "Organization",
      workspaceStatus: "Active",
      capabilities: ["Buyer"],
      role: "Owner",
      joinedAt: "2025-01-01T00:00:00.000Z",
    } as never);
    // /, ?, &, = are the four percent-encoded characters in a
    // query string. Concatenating them pads the worst case.
    const explosive = `/?&=?&=?&=?&=?&=?&=?&=?&=?&=?&=?&=?&=?&=?&=?&=?&=?&=?&=?&=?&=?&=?&=?&=?&=?&=?&=?&=?&=?&=?&=?&=?&=?&=?&=?&=?&=?&=?&=?&=?&=?&=?&=?&=?&=?&=?`;
    const baseline = `/talent?workspaceId=ws-org-other&x=${explosive}`;
    // Trim or pad to 256 chars exactly.
    const padded256 = baseline.length > 256 ? baseline.slice(0, 256) : baseline.padEnd(256, "a");
    assert.equal(padded256.length, 256);

    const result = resolvePostCommandReturnDestination({
      returnTo: padded256,
      freshUser: user,
      actingWorkspaceId: "ws-personal",
      allowedOrigin: ALLOWED_ORIGIN,
    });
    assert.ok(result);
    assert.ok(
      result.path.length <= 256,
      `composed path must stay inside the bounded response contract (got length ${result.path.length})`,
    );
    // The bounded fallback form MUST NOT carry an encoded
    // `?return=` segment when the composed output would exceed
    // the cap — so the response parser can never see `too_big`.
    assert.equal(
      /[?&]return=/.test(result.path),
      false,
      "the bounded fallback form must NOT carry a `?return=` segment when the composed output exceeds the response contract cap",
    );
  });

  test("Same-Workspace destination (returnTo names the acting workspaceId) is kept", () => {
    const user = buildUser({ personal: true, buyer: true });
    const result = resolvePostCommandReturnDestination({
      returnTo: "/deals?workspaceId=ws-personal",
      freshUser: user,
      actingWorkspaceId: "ws-personal",
      allowedOrigin: ALLOWED_ORIGIN,
    });
    assert.deepEqual(result, { route: "/deals", path: "/deals" });
  });

  test("malformed cross-origin path falls back (shape)", () => {
    const user = buildUser({ personal: true });
    assert.throws(
      () =>
        resolvePostCommandReturnDestination({
          returnTo: "https://evil.example/x",
          freshUser: user,
          actingWorkspaceId: "ws-personal",
          allowedOrigin: ALLOWED_ORIGIN,
        }),
      (err: unknown) => err instanceof SafeReturnToFallback && err.reason === "shape",
    );
  });
});
