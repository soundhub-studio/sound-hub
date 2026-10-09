/* eslint-disable @typescript-eslint/no-floating-promises */
// Talent → Matchmaker navigation helper tests (M2 #87).
//
// Pins the three routing branches and the localStorage record
// write. The localStorage helper is stubbed via the `setContext`
// test seam so the test is independent of the real window.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Bg1PublicUserV1, TalentSearchResultV1 } from "@soundhub/types";
import {
  MATCHMAKER_FROM_TALENT_DIRECT,
  MATCHMAKER_FROM_TALENT_INTENT_RETURN,
  MATCHMAKER_FROM_TALENT_LOGIN_RETURN,
  navigateToMatchmakerFromTalent,
} from "./navigate-to-matchmaker-from-talent.js";

const SAMPLE_RESULT = {
  seller: {
    sellerId: "seller-1",
    professionalName: "Marc-André Pierre",
    specialties: ["Producer"],
    bio: "Brooklyn-based Haitian producer.",
    basedIn: { countryCode: "US" },
    caribbeanAffiliationCodes: ["HT"],
  },
  bestMatchingOffering: {
    offeringId: "of-1",
    title: "Sample",
    description: "Sample",
    primaryCategory: { key: "music-production", name: "Music Production" },
    includedServices: [],
    genreTags: [],
    serviceMode: "Remote" as const,
    serviceAreas: [],
  },
  additionalMatchingOfferings: [],
  relevanceScore: 0.5,
  matchReason: "matched offering title",
} as unknown as TalentSearchResultV1;

function buildUser(input: {
  readonly personal: boolean;
  readonly buyer: boolean;
}): Bg1PublicUserV1 {
  return {
    userAccountId: "user-1",
    email: "u@example.test",
    displayName: null,
    identityProvider: "deterministic",
    setupState: "converged",
    workspaces: input.personal
      ? [
          {
            workspaceId: "ws-personal",
            slug: "personal",
            name: "Personal",
            workspaceType: "Personal",
            workspaceStatus: "Active",
            capabilities: input.buyer ? ["Buyer" as const] : [],
          },
        ]
      : [],
  };
}

describe("navigateToMatchmakerFromTalent (M2 #87)", () => {
  test("anonymous user routes to /login?return=/matchmaker?from=talent", () => {
    const pushes: string[] = [];
    const setCalls: unknown[] = [];
    navigateToMatchmakerFromTalent({
      result: SAMPLE_RESULT,
      user: null,
      actingWorkspace: null,
      actingWorkspaceId: null,
      router: { push: (href) => pushes.push(href) },
      setContext: (input) => setCalls.push(input),
    });
    assert.deepEqual(pushes, [MATCHMAKER_FROM_TALENT_LOGIN_RETURN]);
    assert.equal(setCalls.length, 1, "the localStorage record must be written before any push");
    assert.equal((setCalls[0] as { offeringId: string }).offeringId, "of-1");
  });

  test("signed-in user without Buyer routes to /workspace/intent?return=...", () => {
    const user = buildUser({ personal: true, buyer: false });
    const pushes: string[] = [];
    navigateToMatchmakerFromTalent({
      result: SAMPLE_RESULT,
      user,
      actingWorkspace: user.workspaces[0]!,
      actingWorkspaceId: "ws-personal",
      router: { push: (href) => pushes.push(href) },
      setContext: () => undefined,
    });
    assert.deepEqual(pushes, [MATCHMAKER_FROM_TALENT_INTENT_RETURN]);
  });

  test("signed-in user with Buyer routes directly to /matchmaker?from=talent", () => {
    const user = buildUser({ personal: true, buyer: true });
    const pushes: string[] = [];
    navigateToMatchmakerFromTalent({
      result: SAMPLE_RESULT,
      user,
      actingWorkspace: user.workspaces[0]!,
      actingWorkspaceId: "ws-personal",
      router: { push: (href) => pushes.push(href) },
      setContext: () => undefined,
    });
    assert.deepEqual(pushes, [MATCHMAKER_FROM_TALENT_DIRECT]);
  });

  test("the localStorage record is written BEFORE any push (continuation guarantees resume)", () => {
    const calls: string[] = [];
    navigateToMatchmakerFromTalent({
      result: SAMPLE_RESULT,
      user: null,
      actingWorkspace: null,
      actingWorkspaceId: null,
      router: { push: () => calls.push("push") },
      setContext: () => {
        calls.push("setContext");
      },
    });
    assert.deepEqual(calls, ["setContext", "push"]);
  });
});
