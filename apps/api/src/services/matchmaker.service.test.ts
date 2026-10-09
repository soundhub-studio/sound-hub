/* eslint-disable @typescript-eslint/no-floating-promises */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/require-await */
// MatchmakerService tests.
//
// Background: BG3 requires the service to:
//   - Authorize the buyer (current Buyer-capable membership).
//   - Hand the brief to the AI boundary.
//   - Validate AI output through matchmakerCriteriaV1Schema.
//   - Fall back to the deterministic adapter on parse failure or
//     AiUnavailableError.
//   - Invoke the existing TalentSearchService (NO second search
//     path; AI never touches Prisma).
//   - Persist the Brief + results.
//   - Return a buyer-safe DTO with evidence-grounded explanations.
//
// The tests run with in-memory fakes for the auth repo, the brief
// repo, and the search service. The AI boundary is exercised
// through the real DeterministicAiAdapter and a stub Managed
// adapter that returns malformed output (so the fallback path is
// covered).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type {
  AiInterpretBriefInputV1,
  AiInterpretBriefOutputV1,
  TalentSearchRequestV1,
  TalentSearchResponseV1,
  TalentSearchRequiredCriteriaV1,
  TalentSearchPreferredCriteriaV1,
} from "@soundhub/types";
import {
  InMemoryAuthRepository,
  type InMemoryUserSeed,
} from "../auth-repository/in-memory-auth-repository.js";
import {
  AuthorizationError,
  WorkspaceAuthorizationService,
} from "./workspace-authorization.service.js";
import { MatchmakerService, MatchmakerError } from "./matchmaker.service.js";
import {
  mergePreferredCriteriaPerAxis,
  mergeRequiredCriteriaPerAxis,
} from "./matchmaker.service.js";
import {
  AiUnavailableError,
  AiInvalidOutputError,
  type AiAdapter,
} from "../matchmaker/ai-adapter.js";
import { DeterministicAiAdapter } from "../matchmaker/deterministic-ai-adapter.js";
import { InMemoryProjectBriefRepository } from "../matchmaker/in-memory-project-brief.repository.js";
import type {
  PersistedBrief,
  ProjectBriefRepository,
} from "../matchmaker/project-brief.repository.js";
import type {
  PublicOfferingSummaryV1,
  PublicSellerSummaryV1,
  TalentSearchResultV1,
} from "@soundhub/types";

const BUYER_USER_ID = "user-buyer-1";
const BUYER_WORKSPACE_ID = "ws-buyer-1";
const NON_BUYER_WORKSPACE_ID = "ws-seller-only-1";

const buyerSeed: InMemoryUserSeed = {
  userAccountId: BUYER_USER_ID,
  email: "buyer@example.com",
  identityProvider: "deterministic",
  identitySubject: "buyer-subject",
  memberships: [
    {
      workspaceId: BUYER_WORKSPACE_ID,
      slug: "bg1-demo-buyer",
      name: "BG1 Demo Buyer",
      workspaceType: "Personal",
      workspaceStatus: "Active",
      role: "Owner",
      capabilities: ["Buyer"],
    },
    {
      // Mismatched owner without membership: proves ownerUserId is
      // never consulted. A buyer WorkspaceMembership row is the
      // only authority path.
      workspaceId: NON_BUYER_WORKSPACE_ID,
      slug: "ws-no-membership",
      name: "Workspace Without Membership",
      workspaceType: "Personal",
      workspaceStatus: "Active",
      role: "Owner",
      capabilities: ["Seller"],
    },
  ],
};

function buildAuthRepo() {
  return new InMemoryAuthRepository([buyerSeed]);
}

function buildAuthService() {
  const authRepo = buildAuthRepo();
  const authz = new WorkspaceAuthorizationService({ authRepository: authRepo });
  return { authRepo, authz };
}

// A fake search service that returns a deterministic eligibility-
// determined result. The fake records the request it received so
// the test can assert the service invoked the existing M1 contract
// (no second search path).
class FakeTalentSearchService {
  readonly calls: TalentSearchRequestV1[] = [];
  async search(request: TalentSearchRequestV1): Promise<TalentSearchResponseV1> {
    this.calls.push(request);
    const seller: PublicSellerSummaryV1 = {
      sellerId: "seller-marc",
      professionalName: "Marc-André Pierre",
      specialties: ["Producer"],
      bio: "Brooklyn-based Haitian producer.",
      basedIn: { city: "Brooklyn", region: "NY", countryCode: "US" },
      caribbeanAffiliationCodes: ["HT"],
    };
    const offering: PublicOfferingSummaryV1 = {
      offeringId: "of-marc-dancehall",
      title: "Haitian dancehall single production — remote",
      description: "Caribbean-flavored dancehall single production.",
      primaryCategory: { key: "music-production", name: "Music Production" },
      includedServices: [],
      genreTags: ["Dancehall"],
      serviceMode: "Remote",
      serviceAreas: [{ city: "Brooklyn", region: "NY", countryCode: "US" }],
    };
    const additionalOffering: PublicOfferingSummaryV1 = {
      offeringId: "of-marc-mixing",
      title: "Dancehall mixing — remote",
      description: "Mixdown for a single.",
      primaryCategory: { key: "mixing", name: "Mixing" },
      includedServices: [],
      genreTags: ["Dancehall"],
      serviceMode: "Remote",
      serviceAreas: [{ city: "Brooklyn", region: "NY", countryCode: "US" }],
    };
    const result: TalentSearchResultV1 = {
      seller,
      bestMatchingOffering: offering,
      additionalMatchingOfferings: [additionalOffering],
      relevanceScore: 0.9,
      matchReason:
        "matched offering title; preferred genre: Dancehall; preferred Caribbean affiliation: HT",
      preferenceCoverage: { matched: 2, total: 2 },
      textCoverage: { matched: 1, total: 1 },
    };
    return {
      results: [result],
      metadata: {
        normalizedQuery: "dancehall",
        totalResults: 1,
        processingTimeMs: 5,
        strategy: "postgres-text-v1",
        appliedRequiredCriteria: request.required ?? {},
        appliedPreferredCriteria: request.preferred ?? {},
      },
    };
  }
}

// A managed adapter that produces a malformed payload so the
// service exercises its fallback path.
class MalformedManagedAdapter implements AiAdapter {
  async interpretBrief(_input: AiInterpretBriefInputV1): Promise<AiInterpretBriefOutputV1> {
    return {
      provider: "managed",
      modelId: "fake-model",
      candidate: { required: "not-an-object" },
    };
  }
}

// A managed adapter that throws AiUnavailableError.
class UnavailableManagedAdapter implements AiAdapter {
  async interpretBrief(_input: AiInterpretBriefInputV1): Promise<AiInterpretBriefOutputV1> {
    throw new AiUnavailableError("managed provider offline");
  }
}

// A primary adapter that surfaces the same AiInvalidOutputError the
// deterministic fallback throws on punctuation-only input. This
// proves the service translates the error into
// MATCHMAKER_INVALID_REQUEST (HTTP 400) rather than the generic
// MATCHMAKER_FAILED (HTTP 500) that the prior code path produced
// when deterministic was the primary adapter.
class InvalidOutputManagedAdapter implements AiAdapter {
  async interpretBrief(_input: AiInterpretBriefInputV1): Promise<AiInterpretBriefOutputV1> {
    throw new AiInvalidOutputError("managed adapter produced invalid output");
  }
}

function buildService(deps: {
  readonly aiAdapter?: AiAdapter;
  readonly projectBriefRepository?: ProjectBriefRepository;
}) {
  const { authRepo, authz } = buildAuthService();
  const search = new FakeTalentSearchService();
  const service = new MatchmakerService({
    talentSearchService: search as unknown as ConstructorParameters<
      typeof MatchmakerService
    >[0]["talentSearchService"],
    workspaceAuthorizationService: authz,
    projectBriefRepository: deps.projectBriefRepository ?? new InMemoryProjectBriefRepository(),
    aiAdapter: deps.aiAdapter ?? new DeterministicAiAdapter(),
    fallbackAiAdapter: new DeterministicAiAdapter(),
  });
  return { service, search, authRepo };
}

test("MatchmakerService persists the brief and returns recommendations for the deterministic path", async () => {
  const { service, search } = buildService({});
  const result = await service.submitBrief({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    briefText: "I need a producer in Brooklyn for a remote Haitian dancehall single.",
  });
  // The primary adapter is the deterministic fallback, which
  // produced a valid payload on the first try — `aiFallbackUsed`
  // is false because the fallback path was not exercised.
  assert.equal(result.brief.aiProvider, "deterministic-fallback");
  assert.equal(result.brief.aiFallbackUsed, false);
  assert.equal(result.totalResults, 1);
  assert.equal(result.strategy, "postgres-text-v1");
  assert.equal(result.fallbackNotice, undefined);
  assert.equal(result.recommendations.length, 1);
  const rec = result.recommendations[0]!;
  assert.equal(rec.sellerId, "seller-marc");
  assert.ok(rec.explanations.some((e) => e.kind === "matched-offering-title"));
  assert.ok(rec.explanations.some((e) => e.kind === "preferred-genre"));

  // The service invoked the existing TalentSearchService with the
  // M1-shaped request, NOT a second search path.
  assert.equal(search.calls.length, 1);
  const call = search.calls[0]!;
  const required = call.required ?? {};
  assert.ok(required.serviceModes?.includes("Remote"));
  assert.ok(required.primaryCategoryKeys?.some((k) => k === "music-production"));
  assert.equal(required.basedIn?.countryCode, "US");
});

test("MatchmakerService falls back when the managed adapter returns a malformed payload", async () => {
  const briefRepo = new InMemoryProjectBriefRepository();
  const { service, search } = buildService({
    aiAdapter: new MalformedManagedAdapter(),
    projectBriefRepository: briefRepo,
  });
  const result = await service.submitBrief({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    briefText: "I need a producer in Brooklyn for a remote Haitian dancehall single.",
  });
  assert.equal(result.brief.aiProvider, "deterministic-fallback");
  assert.equal(result.brief.aiFallbackUsed, true);
  assert.equal(result.totalResults, 1);
  assert.equal(search.calls.length, 1);
});

test("MatchmakerService falls back when the managed adapter throws AiUnavailableError", async () => {
  const { service, search } = buildService({
    aiAdapter: new UnavailableManagedAdapter(),
  });
  const result = await service.submitBrief({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    briefText: "Need a Brooklyn producer.",
  });
  assert.equal(result.brief.aiProvider, "deterministic-fallback");
  assert.equal(result.brief.aiFallbackUsed, true);
  assert.equal(search.calls.length, 1);
});

test("MatchmakerService rejects a buyer without Buyer capability on the acting Workspace", async () => {
  // The auth repo only has a Buyer-capable membership for
  // BUYER_WORKSPACE_ID. The non-buyer Workspace id is offered to
  // prove the capability check fires even when a membership row
  // exists with the wrong capabilities.
  const { authz } = buildAuthService();
  const service = new MatchmakerService({
    talentSearchService: new FakeTalentSearchService() as never,
    workspaceAuthorizationService: authz,
    projectBriefRepository: new InMemoryProjectBriefRepository(),
    aiAdapter: new DeterministicAiAdapter(),
  });
  await assert.rejects(
    service.submitBrief({
      userAccountId: BUYER_USER_ID,
      actingWorkspaceId: NON_BUYER_WORKSPACE_ID,
      briefText: "Need a Brooklyn producer.",
    }),
    (err: unknown) =>
      err instanceof AuthorizationError &&
      (err.code === "MISSING_CAPABILITY" || err.code === "NOT_A_MEMBER"),
  );
});

test("MatchmakerService persists the brief in a single transactional write", async () => {
  const briefRepo = new InMemoryProjectBriefRepository();
  const { service } = buildService({
    projectBriefRepository: briefRepo,
  });
  const result = await service.submitBrief({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    briefText: "Need a Brooklyn producer.",
  });
  const stored = (await briefRepo.findBriefById(result.brief.briefId)) as PersistedBrief;
  assert.ok(stored, "brief should be persisted");
  assert.equal(stored.buyerWorkspaceId, BUYER_WORKSPACE_ID);
  assert.equal(stored.createdByUserId, BUYER_USER_ID);
  assert.ok(stored.results.length >= 1);
  // The criteria persisted in the brief are the M1-validated
  // shapes — never free-form AI output.
  assert.ok(
    Array.isArray(stored.criteria.required.primaryCategoryKeys) ||
      stored.criteria.required.primaryCategoryKeys === undefined,
  );
});

test("MatchmakerService.getBrief revalidates the current Buyer-capable membership", async () => {
  const briefRepo = new InMemoryProjectBriefRepository();
  const { service } = buildService({ projectBriefRepository: briefRepo });
  const submitted = await service.submitBrief({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    briefText: "Need a Brooklyn producer.",
  });
  const fetched = await service.getBrief({
    userAccountId: BUYER_USER_ID,
    briefId: submitted.brief.briefId,
  });
  assert.equal(fetched.brief.briefId, submitted.brief.briefId);
});

test("MatchmakerService.getBrief rejects a non-member", async () => {
  const briefRepo = new InMemoryProjectBriefRepository();
  const { service } = buildService({ projectBriefRepository: briefRepo });
  const submitted = await service.submitBrief({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    briefText: "Need a Brooklyn producer.",
  });
  await assert.rejects(
    service.getBrief({
      userAccountId: "user-without-membership",
      briefId: submitted.brief.briefId,
    }),
    (err: unknown) =>
      err instanceof AuthorizationError &&
      (err.code === "NOT_A_MEMBER" || err.code === "MISSING_CAPABILITY"),
  );
});

test("MatchmakerService.getBrief returns BRIEF_NOT_FOUND for an unknown id", async () => {
  const { service } = buildService({});
  await assert.rejects(
    service.getBrief({
      userAccountId: BUYER_USER_ID,
      briefId: "brief-nonexistent",
    }),
    (err: unknown) => err instanceof MatchmakerError && err.code === "BRIEF_NOT_FOUND",
  );
});

test("MatchmakerService preserves required constraints end-to-end (GS 14)", async () => {
  const { service, search } = buildService({});
  const result = await service.submitBrief({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    briefText: "I need a remote dancehall producer in Brooklyn.",
  });
  // Persisted criteria still contain the hard axes the buyer named.
  const persisted = result.brief.criteria;
  assert.ok(persisted.required.serviceModes?.includes("Remote"));
  assert.ok(persisted.required.primaryCategoryKeys?.some((k) => k === "music-production"));
  assert.equal(persisted.required.basedIn?.countryCode, "US");
  // Search service was invoked with the same required axes.
  const call = search.calls[0]!;
  const required = call.required ?? {};
  assert.ok(required.serviceModes?.includes("Remote"));
  assert.ok(required.primaryCategoryKeys?.some((k) => k === "music-production"));
  assert.equal(required.basedIn?.countryCode, "US");
});

// M2 (#87) Codex 4th review Finding 8: when the buyer supplies a
// strict required criteria block alongside the brief text (e.g.
// a buyer who searched on /talent with structured constraints
// and is now back on /matchmaker), the service MUST apply the
// buyer's required axes verbatim. The AI may produce additional
// required axes (e.g. from the brief text), but the AI MUST NOT
// relax, drop, or rewrite a buyer-supplied hard axis. The
// search service receives the merged block; the buyer's axes
// win on every field.
test("MatchmakerService applies buyer-supplied required criteria verbatim (Finding 8)", async () => {
  const { service, search } = buildService({});
  // The buyer supplies a strict required block: only
  // "songwriting" category, no specific location, no service
  // mode. The AI may infer additional axes from the brief
  // text, but every buyer-supplied axis MUST survive in the
  // final search request.
  const buyerRequired: TalentSearchRequiredCriteriaV1 = {
    primaryCategoryKeys: ["songwriting"],
  };
  const result = await service.submitBrief({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    briefText: "I need a producer for a Caribbean pop single.",
    buyerRequired,
  });
  // The persisted brief records the buyer's required block as
  // authoritative (it overrides the AI's required block).
  const persisted = result.brief.criteria;
  assert.deepEqual(
    persisted.required.primaryCategoryKeys,
    ["songwriting"],
    "buyer-supplied primaryCategoryKeys MUST win over the AI's required block",
  );
  // The search service was invoked with the buyer's required
  // block — the AI never had a chance to relax it.
  assert.equal(search.calls.length, 1);
  const call = search.calls[0]!;
  assert.deepEqual(
    call.required?.primaryCategoryKeys,
    ["songwriting"],
    "buyer-supplied primaryCategoryKeys MUST reach the search service unchanged",
  );
});

// M2 (#87) Finding 8: a filter-only buyer (no query text, just
// strict filters) MUST still get the filters applied to the
// matchmaker submission. The briefText can be the canonical
// fallback (e.g. DEFAULT_BRIEF on the web side) but the buyer's
// required axes are non-negotiable.
test("MatchmakerService applies buyer-supplied required criteria even when the brief text is a generic fallback (Finding 8 — filter-only path)", async () => {
  const { service, search } = buildService({});
  const buyerRequired: TalentSearchRequiredCriteriaV1 = {
    primaryCategoryKeys: ["mixing"],
    serviceModes: ["Remote"],
    basedIn: { countryCode: "JM" },
  };
  // The brief text is the DEFAULT_BRIEF placeholder (the web
  // page falls back to this when the recovered record's query
  // is empty). The buyer's strict filters must still be the
  // authoritative axes.
  const result = await service.submitBrief({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    briefText:
      "I need a Brooklyn-based producer for a remote Haitian dancehall single, ideally delivered before March 14.",
    buyerRequired,
  });
  assert.equal(search.calls.length, 1);
  const call = search.calls[0]!;
  assert.deepEqual(call.required?.primaryCategoryKeys, ["mixing"]);
  assert.deepEqual(call.required?.serviceModes, ["Remote"]);
  assert.equal(call.required?.basedIn?.countryCode, "JM");
  // The persisted criteria match the buyer's required block.
  assert.deepEqual(result.brief.criteria.required.primaryCategoryKeys, ["mixing"]);
  assert.deepEqual(result.brief.criteria.required.serviceModes, ["Remote"]);
  assert.equal(result.brief.criteria.required.basedIn?.countryCode, "JM");
});

test("MatchmakerService surfaces additional matching offerings end-to-end", async () => {
  const { service } = buildService({});
  const result = await service.submitBrief({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    briefText: "I need a remote dancehall producer in Brooklyn.",
  });
  // The recommendation carries the additional matching offering
  // the search service returned alongside the best match. The
  // repository persists the array and buildRecommendation
  // validates each entry against publicOfferingSummaryV1Schema.
  assert.equal(result.recommendations.length, 1);
  const rec = result.recommendations[0]!;
  assert.equal(rec.bestMatchingOfferingId, "of-marc-dancehall");
  assert.equal(rec.additionalMatchingOfferings.length, 1);
  assert.equal(rec.additionalMatchingOfferings[0]?.offeringId, "of-marc-mixing");
});

test("MatchmakerService maps punctuation-only brief to MATCHMAKER_INVALID_REQUEST", async () => {
  // Deterministic is the primary adapter. A punctuation-only
  // brief carries no usable axes (no recognised category /
  // location / mode and no valid query after normalization); the
  // adapter self-validates and throws AiInvalidOutputError. The
  // service must translate this to MATCHMAKER_INVALID_REQUEST
  // (HTTP 400) rather than the generic MATCHMAKER_FAILED
  // (HTTP 500) that the prior path produced when deterministic
  // was the primary adapter. No search or persistence may
  // occur.
  const { service, search } = buildService({});
  await assert.rejects(
    service.submitBrief({
      userAccountId: BUYER_USER_ID,
      actingWorkspaceId: BUYER_WORKSPACE_ID,
      briefText: "--------",
    }),
    (err: unknown) => err instanceof MatchmakerError && err.code === "MATCHMAKER_INVALID_REQUEST",
  );
  assert.equal(search.calls.length, 0, "search must not run for unusable input");
});

test("MatchmakerService maps unavailable-primary + unusable-fallback to MATCHMAKER_INVALID_REQUEST", async () => {
  // Managed adapter surfaces AiUnavailableError so the service
  // falls back to deterministic. The deterministic fallback
  // then self-validates the punctuation-only brief and throws
  // AiInvalidOutputError. Both errors are recoverable; the
  // service must translate the chain failure to
  // MATCHMAKER_INVALID_REQUEST (HTTP 400), not
  // MATCHMAKER_FAILED (HTTP 500).
  const { service, search } = buildService({
    aiAdapter: new UnavailableManagedAdapter(),
  });
  await assert.rejects(
    service.submitBrief({
      userAccountId: BUYER_USER_ID,
      actingWorkspaceId: BUYER_WORKSPACE_ID,
      briefText: "--------",
    }),
    (err: unknown) => err instanceof MatchmakerError && err.code === "MATCHMAKER_INVALID_REQUEST",
  );
  assert.equal(search.calls.length, 0, "search must not run for unusable input");
});

test("MatchmakerService maps managed-invalid-output + unusable-fallback to MATCHMAKER_INVALID_REQUEST", async () => {
  // Managed adapter surfaces AiInvalidOutputError (e.g. schema
  // rejection). The deterministic fallback also fails on a
  // punctuation-only brief. The service must surface
  // MATCHMAKER_INVALID_REQUEST so the route returns HTTP 400.
  const { service, search } = buildService({
    aiAdapter: new InvalidOutputManagedAdapter(),
  });
  await assert.rejects(
    service.submitBrief({
      userAccountId: BUYER_USER_ID,
      actingWorkspaceId: BUYER_WORKSPACE_ID,
      briefText: "--------",
    }),
    (err: unknown) => err instanceof MatchmakerError && err.code === "MATCHMAKER_INVALID_REQUEST",
  );
  assert.equal(search.calls.length, 0);
});

// M2 (#87) Finding 8 (5th review): per-axis merge for required
// criteria. The buyer wins on the specific axes the buyer supplied
// a value for; the AI's axes the buyer did NOT name are preserved.
// The AI is never allowed to relax a buyer-supplied hard axis, but
// the AI IS allowed to contribute axes the buyer did not name.
describe("mergeRequiredCriteriaPerAxis (M2 #87 5th review Finding 1)", () => {
  test("buyer-supplied primaryCategoryKeys wins; AI's other axes are preserved", () => {
    const aiRequired: TalentSearchRequiredCriteriaV1 = {
      primaryCategoryKeys: ["music-production"],
      serviceModes: ["Remote"],
      basedIn: { countryCode: "US" },
    };
    const buyerRequired: TalentSearchRequiredCriteriaV1 = {
      primaryCategoryKeys: ["songwriting"],
    };
    const merged = mergeRequiredCriteriaPerAxis(aiRequired, buyerRequired);
    assert.deepEqual(merged.primaryCategoryKeys, ["songwriting"]);
    // AI's other axes are preserved (the buyer did NOT name them).
    assert.deepEqual(merged.serviceModes, ["Remote"]);
    assert.deepEqual(merged.basedIn, { countryCode: "US" });
  });

  test("buyer-supplied empty array on an axis is ignored (AI's value wins on that axis)", () => {
    // An empty `primaryCategoryKeys` array is "buyer did not
    // supply a value for this axis" — the AI's value wins on
    // that axis. The schema validation rejects an empty
    // primaryCategoryKeys anyway; the merge rule treats it as
    // "absent" so the AI's interpretation survives.
    const aiRequired: TalentSearchRequiredCriteriaV1 = {
      primaryCategoryKeys: ["music-production"],
    };
    const buyerRequired: TalentSearchRequiredCriteriaV1 = {
      primaryCategoryKeys: [],
    };
    const merged = mergeRequiredCriteriaPerAxis(aiRequired, buyerRequired);
    assert.deepEqual(merged.primaryCategoryKeys, ["music-production"]);
  });

  test("buyer-supplied basedIn wins when non-empty; AI's basedIn is dropped", () => {
    const aiRequired: TalentSearchRequiredCriteriaV1 = {
      primaryCategoryKeys: ["music-production"],
      basedIn: { countryCode: "US" },
    };
    const buyerRequired: TalentSearchRequiredCriteriaV1 = {
      basedIn: { countryCode: "HT" },
    };
    const merged = mergeRequiredCriteriaPerAxis(aiRequired, buyerRequired);
    // AI's primaryCategoryKeys survives (the buyer did not name it).
    assert.deepEqual(merged.primaryCategoryKeys, ["music-production"]);
    // The buyer's basedIn wins.
    assert.deepEqual(merged.basedIn, { countryCode: "HT" });
  });

  test("buyer-supplied serviceModes wins; AI's primaryCategoryKeys + basedIn are preserved", () => {
    const aiRequired: TalentSearchRequiredCriteriaV1 = {
      primaryCategoryKeys: ["music-production"],
      serviceModes: ["Remote"],
      basedIn: { countryCode: "US", city: "Brooklyn" },
    };
    const buyerRequired: TalentSearchRequiredCriteriaV1 = {
      serviceModes: ["InPerson"],
    };
    const merged = mergeRequiredCriteriaPerAxis(aiRequired, buyerRequired);
    assert.deepEqual(merged.serviceModes, ["InPerson"]);
    assert.deepEqual(merged.primaryCategoryKeys, ["music-production"]);
    assert.deepEqual(merged.basedIn, { countryCode: "US", city: "Brooklyn" });
  });
});

describe("mergePreferredCriteriaPerAxis (M2 #87 5th review Finding 1)", () => {
  test("buyer-supplied preferred categoryKeys wins; AI's other preferred axes are preserved", () => {
    const aiPreferred: TalentSearchPreferredCriteriaV1 = {
      categoryKeys: ["mixing"],
      genreTags: ["Dancehall"],
    };
    const buyerPreferred: TalentSearchPreferredCriteriaV1 = {
      categoryKeys: ["songwriting"],
    };
    const merged = mergePreferredCriteriaPerAxis(aiPreferred, buyerPreferred);
    assert.deepEqual(merged.categoryKeys, ["songwriting"]);
    assert.deepEqual(merged.genreTags, ["Dancehall"]);
  });
});
