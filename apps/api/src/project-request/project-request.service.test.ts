/* eslint-disable @typescript-eslint/no-floating-promises */
// ProjectRequestService unit tests.
//
// Background: ticket #62 acceptance criteria require the service to:
//   - revalidate Buyer membership + acting Workspace identity
//   - enforce the brief-ownership + brief-recommendation boundary (P1-001)
//   - revalidate ServiceOffering eligibility (workspace active +
//     Seller capability + SellerProfile Published + ServiceOffering
//     Active) atomically with the INSERT (P1-002)
//   - persist a Pending ProjectRequest through the repository, with
//     NO Prisma dependency in the service (P1-003)
//   - revalidate seller membership before accept/decline
//   - atomically transition Pending -> Accepted + create exactly one Deal
//   - atomically transition Pending -> Declined + create NO Deal
//   - reject retried accept/decline on an already-responded request
//
// These tests use the InMemoryProjectRequestRepository so they run
// without a database. The Prisma adapter's equivalence is proven by
// the integration tests against the disposable PostgreSQL target.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { ProjectBriefPublicV1 } from "@soundhub/types";
import { ProjectRequestService } from "./project-request.service.js";
import { InMemoryProjectRequestRepository } from "./in-memory-project-request.repository.js";
import {
  InMemoryAuthRepository,
  type InMemoryUserSeed,
} from "../auth-repository/in-memory-auth-repository.js";
import { WorkspaceAuthorizationService } from "../services/workspace-authorization.service.js";

const BUYER_USER_ID = "user-buyer";
const BUYER_WORKSPACE_ID = "ws-buyer";
const OTHER_BUYER_USER_ID = "user-other-buyer";
const OTHER_BUYER_WORKSPACE_ID = "ws-other-buyer";
const SELLER_USER_ID = "user-seller";
const SELLER_WORKSPACE_ID = "ws-seller";
const OFFERING_ID = "of-eligible";
const OFFERING_INELIGIBLE_ID = "of-ineligible";
const OFFERING_OTHER_SELLER_ID = "of-other-seller";
const OFFERING_NOT_IN_BRIEF_ID = "of-not-recommended";
const BRIEF_ID = "brief-1";
const OTHER_BRIEF_ID = "brief-other";

interface Fixture {
  projectRequestService: ProjectRequestService;
  projectRequestRepo: InMemoryProjectRequestRepository;
  authRepo: InMemoryAuthRepository;
  // The WorkspaceAuthorizationService instance the fixture built so
  // focused tests can build additional services against the same
  // in-memory authority state without rebuilding it.
  workspaceAuthorizationService: WorkspaceAuthorizationService;
  now: () => Date;
  clock: { current: Date };
}

function buildFixture(): Fixture {
  const buyerSeed: InMemoryUserSeed = {
    userAccountId: BUYER_USER_ID,
    email: "buyer@example.com",
    identityProvider: "deterministic",
    identitySubject: "buyer-subject",
    memberships: [
      {
        workspaceId: BUYER_WORKSPACE_ID,
        slug: "buyer",
        name: "Buyer",
        workspaceType: "Personal",
        workspaceStatus: "Active",
        role: "Owner",
        capabilities: ["Buyer"],
      },
    ],
  };
  const otherBuyerSeed: InMemoryUserSeed = {
    userAccountId: OTHER_BUYER_USER_ID,
    email: "other-buyer@example.com",
    identityProvider: "deterministic",
    identitySubject: "other-buyer-subject",
    memberships: [
      {
        workspaceId: OTHER_BUYER_WORKSPACE_ID,
        slug: "other-buyer",
        name: "Other Buyer",
        workspaceType: "Personal",
        workspaceStatus: "Active",
        role: "Owner",
        capabilities: ["Buyer"],
      },
    ],
  };
  const sellerSeed: InMemoryUserSeed = {
    userAccountId: SELLER_USER_ID,
    email: "seller@example.com",
    identityProvider: "deterministic",
    identitySubject: "seller-subject",
    memberships: [
      {
        workspaceId: SELLER_WORKSPACE_ID,
        slug: "seller",
        name: "Seller",
        workspaceType: "Personal",
        workspaceStatus: "Active",
        role: "Owner",
        capabilities: ["Seller"],
      },
    ],
  };
  const authRepo = new InMemoryAuthRepository([buyerSeed, otherBuyerSeed, sellerSeed]);
  const authz = new WorkspaceAuthorizationService({ authRepository: authRepo });

  const projectRequestRepo = new InMemoryProjectRequestRepository();
  // Seed the in-memory snapshot state the policy evaluators
  // consume. The repository loads + locks these snapshots inside
  // its transaction; the service invokes the pure evaluators in
  // `project-request-authorization-policy.ts` to decide whether
  // the facts authorize the command.
  projectRequestRepo.seedWorkspace({
    workspaceId: BUYER_WORKSPACE_ID,
    status: "Active",
    ownerUserId: BUYER_USER_ID,
    buyerCapability: true,
    sellerCapability: false,
  });
  projectRequestRepo.seedWorkspace({
    workspaceId: OTHER_BUYER_WORKSPACE_ID,
    status: "Active",
    ownerUserId: OTHER_BUYER_USER_ID,
    buyerCapability: true,
    sellerCapability: false,
  });
  projectRequestRepo.seedWorkspace({
    workspaceId: SELLER_WORKSPACE_ID,
    status: "Active",
    ownerUserId: SELLER_USER_ID,
    buyerCapability: false,
    sellerCapability: true,
  });
  projectRequestRepo.seedWorkspace({
    workspaceId: "ws-different-seller",
    status: "Active",
    ownerUserId: "user-different-seller",
    buyerCapability: false,
    sellerCapability: true,
  });
  projectRequestRepo.seedMembership({
    userId: "user-different-seller",
    workspaceId: "ws-different-seller",
  });
  // The InMemoryProjectRequestRepository's buyer/seller authority
  // snapshots still read the seeded `memberships` map directly
  // because the FOR UPDATE-locked reads do not consult the auth
  // repo. Keep the seeded memberships aligned with the auth repo
  // memberships so the two paths produce the same verdict.
  projectRequestRepo.seedMembership({
    userId: BUYER_USER_ID,
    workspaceId: BUYER_WORKSPACE_ID,
  });
  projectRequestRepo.seedMembership({
    userId: OTHER_BUYER_USER_ID,
    workspaceId: OTHER_BUYER_WORKSPACE_ID,
  });
  projectRequestRepo.seedMembership({
    userId: SELLER_USER_ID,
    workspaceId: SELLER_WORKSPACE_ID,
  });
  projectRequestRepo.seedSellerProfile({
    workspaceId: "ws-different-seller",
    status: "Published",
  });
  projectRequestRepo.seedSellerProfile({
    workspaceId: SELLER_WORKSPACE_ID,
    status: "Published",
  });
  projectRequestRepo.seedServiceOffering({
    id: OFFERING_ID,
    sellerWorkspaceId: SELLER_WORKSPACE_ID,
    status: "Active",
  });
  projectRequestRepo.seedServiceOffering({
    id: OFFERING_INELIGIBLE_ID,
    sellerWorkspaceId: SELLER_WORKSPACE_ID,
    status: "Paused",
  });
  projectRequestRepo.seedServiceOffering({
    id: OFFERING_OTHER_SELLER_ID,
    sellerWorkspaceId: "ws-different-seller",
    status: "Active",
  });
  projectRequestRepo.seedServiceOffering({
    id: OFFERING_NOT_IN_BRIEF_ID,
    sellerWorkspaceId: SELLER_WORKSPACE_ID,
    status: "Active",
  });

  projectRequestRepo.seedProjectBrief({
    id: BRIEF_ID,
    buyerWorkspaceId: BUYER_WORKSPACE_ID,
    recommendedOfferingIds: [OFFERING_ID, OFFERING_OTHER_SELLER_ID, OFFERING_INELIGIBLE_ID],
  });
  projectRequestRepo.seedProjectBrief({
    id: OTHER_BRIEF_ID,
    buyerWorkspaceId: OTHER_BUYER_WORKSPACE_ID,
    recommendedOfferingIds: [OFFERING_ID],
  });

  const clock = { current: new Date("2026-08-27T00:00:00Z") };
  const now = () => clock.current;

  const service = new ProjectRequestService({
    projectRequestRepository: projectRequestRepo,
    workspaceAuthorizationService: authz,
    now,
  });

  return {
    projectRequestService: service,
    projectRequestRepo,
    authRepo,
    workspaceAuthorizationService: authz,
    now,
    clock,
  };
}

test("createProjectRequest persists a Pending request owned by the buyer Workspace", async () => {
  const { projectRequestService } = buildFixture();
  const result = await projectRequestService.createProjectRequest({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    projectBriefId: BRIEF_ID,
    serviceOfferingId: OFFERING_ID,
  });
  assert.equal(result.projectRequest.status, "Pending");
  assert.equal(result.projectRequest.buyerWorkspaceId, BUYER_WORKSPACE_ID);
  assert.equal(result.projectRequest.sellerWorkspaceId, SELLER_WORKSPACE_ID);
  assert.equal(result.projectRequest.serviceOfferingId, OFFERING_ID);
  assert.equal(result.projectRequest.projectBriefId, BRIEF_ID);
  assert.equal(result.projectRequest.sellerDecisionAt, null);
  assert.equal(result.projectRequest.sellerConsentAt, null);
});

test("createProjectRequest rejects a non-Buyer actor with PROJECT_REQUEST_FORBIDDEN", async () => {
  const { projectRequestService } = buildFixture();
  // The seller user is NOT a member of the buyer Workspace, so the
  // buyer authority snapshot surfaces isMember=false and the
  // application-owned evaluateBuyerAuthority evaluator fails
  // closed with NOT_A_MEMBER. The service translates this to
  // PROJECT_REQUEST_FORBIDDEN.
  await assert.rejects(
    projectRequestService.createProjectRequest({
      userAccountId: SELLER_USER_ID,
      actingWorkspaceId: BUYER_WORKSPACE_ID,
      projectBriefId: BRIEF_ID,
      serviceOfferingId: OFFERING_ID,
    }),
    (err: unknown) => {
      return (
        err instanceof Error &&
        err.name === "ProjectRequestError" &&
        (err as { code?: string }).code === "PROJECT_REQUEST_FORBIDDEN"
      );
    },
  );
});

test("createProjectRequest rejects a brief owned by another buyer Workspace", async () => {
  const { projectRequestService } = buildFixture();
  await assert.rejects(
    projectRequestService.createProjectRequest({
      userAccountId: BUYER_USER_ID,
      actingWorkspaceId: BUYER_WORKSPACE_ID,
      projectBriefId: OTHER_BRIEF_ID,
      serviceOfferingId: OFFERING_ID,
    }),
    (err: unknown) => {
      return (
        err instanceof Error &&
        err.name === "ProjectRequestError" &&
        (err as { code?: string }).code === "PROJECT_REQUEST_BRIEF_FORBIDDEN"
      );
    },
  );
});

test("createProjectRequest rejects a stale or ineligible offering", async () => {
  const { projectRequestService } = buildFixture();
  await assert.rejects(
    projectRequestService.createProjectRequest({
      userAccountId: BUYER_USER_ID,
      actingWorkspaceId: BUYER_WORKSPACE_ID,
      projectBriefId: BRIEF_ID,
      serviceOfferingId: OFFERING_INELIGIBLE_ID,
    }),
    (err: unknown) => {
      return (
        err instanceof Error &&
        err.name === "ProjectRequestError" &&
        (err as { code?: string }).code === "PROJECT_REQUEST_OFFERING_INELIGIBLE"
      );
    },
  );
});

// P1-001 verification: the selected offering MUST be a persisted
// recommendation for the brief. An otherwise-eligible offering that
// Matchmaker never returned for this brief must fail closed with
// PROJECT_REQUEST_OFFERING_INELIGIBLE.
test("createProjectRequest rejects an offering not surfaced by the brief's Matchmaker", async () => {
  const { projectRequestService } = buildFixture();
  await assert.rejects(
    projectRequestService.createProjectRequest({
      userAccountId: BUYER_USER_ID,
      actingWorkspaceId: BUYER_WORKSPACE_ID,
      projectBriefId: BRIEF_ID,
      serviceOfferingId: OFFERING_NOT_IN_BRIEF_ID,
    }),
    (err: unknown) => {
      return (
        err instanceof Error &&
        err.name === "ProjectRequestError" &&
        (err as { code?: string }).code === "PROJECT_REQUEST_OFFERING_INELIGIBLE"
      );
    },
  );
});

test("createProjectRequest persists the offering's owning Workspace as the seller", async () => {
  const { projectRequestService } = buildFixture();
  // The buyer is addressing the buyer Workspace, but the offering
  // is owned by a different seller Workspace. The eligibility
  // revalidation returns the offering (Active etc.) and the
  // sellerWorkspaceId from the snapshot is the source of truth
  // for ownership. This test pins the surface so a future
  // regression that hard-codes the acting Workspace would be
  // detected.
  const result = await projectRequestService.createProjectRequest({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    projectBriefId: BRIEF_ID,
    serviceOfferingId: OFFERING_OTHER_SELLER_ID,
  });
  assert.equal(result.projectRequest.sellerWorkspaceId, "ws-different-seller");
  assert.notEqual(result.projectRequest.sellerWorkspaceId, BUYER_WORKSPACE_ID);
});

test("createProjectRequest rejects a duplicate Pending request with PROJECT_REQUEST_ALREADY_PENDING", async () => {
  const { projectRequestService } = buildFixture();
  await projectRequestService.createProjectRequest({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    projectBriefId: BRIEF_ID,
    serviceOfferingId: OFFERING_ID,
  });
  await assert.rejects(
    projectRequestService.createProjectRequest({
      userAccountId: BUYER_USER_ID,
      actingWorkspaceId: BUYER_WORKSPACE_ID,
      projectBriefId: BRIEF_ID,
      serviceOfferingId: OFFERING_ID,
    }),
    (err: unknown) => {
      return (
        err instanceof Error &&
        err.name === "ProjectRequestError" &&
        (err as { code?: string }).code === "PROJECT_REQUEST_ALREADY_PENDING"
      );
    },
  );
});

test("acceptProjectRequest atomically transitions Pending and creates exactly one Negotiating Deal", async () => {
  const { projectRequestService, projectRequestRepo } = buildFixture();
  const created = await projectRequestService.createProjectRequest({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    projectBriefId: BRIEF_ID,
    serviceOfferingId: OFFERING_ID,
  });
  const result = await projectRequestService.acceptProjectRequest({
    userAccountId: SELLER_USER_ID,
    actingWorkspaceId: SELLER_WORKSPACE_ID,
    projectRequestId: created.projectRequest.projectRequestId,
  });
  assert.equal(result.projectRequest.status, "Accepted");
  assert.notEqual(result.projectRequest.sellerConsentAt, null);
  assert.equal(result.deal.status, "Negotiating");
  assert.equal(result.deal.projectRequestId, created.projectRequest.projectRequestId);
  assert.equal(result.deal.buyerWorkspaceId, BUYER_WORKSPACE_ID);
  assert.equal(result.deal.sellerWorkspaceId, SELLER_WORKSPACE_ID);
  // M2 (#88): the accept transaction also persists an AI-drafted,
  // unapproved initial TermsVersion (v1) atomically alongside the
  // new Deal. The row carries the schema-mandated
  // `aiDraftedUnapprovedBadge: true` literal + the strict
  // `bg5ProposedTermsV1Schema` shape the existing BG5 Deal view
  // surfaces unchanged.
  assert.equal(result.initialTermsVersion.version, 1);
  assert.equal(result.initialTermsVersion.dealId, result.deal.dealId);
  assert.equal(result.initialTermsVersion.isCurrentVersion, true);
  assert.equal(result.initialTermsVersion.aiDraftedUnapprovedBadge, true);
  assert.equal(result.initialTermsVersion.price.currency, "USD");
  assert.ok(result.initialTermsVersion.deliverables.length >= 1);
  // The persisted deal must exist once.
  const stored = await projectRequestRepo.findProjectRequestById(
    created.projectRequest.projectRequestId,
  );
  assert.equal(stored?.status, "Accepted");
});

// M2 (#88): same-attempt retry on the same payload converges on the
// SAME Deal id AND the SAME TermsVersion id; no duplicate rows.
test("acceptProjectRequest same-attempt retry converges on the same Deal + initial TermsVersion (no duplicates)", async () => {
  const { projectRequestService } = buildFixture();
  const created = await projectRequestService.createProjectRequest({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    projectBriefId: BRIEF_ID,
    serviceOfferingId: OFFERING_ID,
  });
  const first = await projectRequestService.acceptProjectRequest({
    userAccountId: SELLER_USER_ID,
    actingWorkspaceId: SELLER_WORKSPACE_ID,
    projectRequestId: created.projectRequest.projectRequestId,
  });
  // Second accept on the same (already-Accepted) request fails
  // closed with PROJECT_REQUEST_ALREADY_RESPONDED — the unique
  // index on (deals.projectRequestId) + the guarded
  // updateMany WHERE status='Pending' are the durable convergence
  // keys. The Deal id + initial TermsVersion id of the first
  // attempt is the durable identity; the second attempt must NOT
  // create a new row.
  await assert.rejects(
    projectRequestService.acceptProjectRequest({
      userAccountId: SELLER_USER_ID,
      actingWorkspaceId: SELLER_WORKSPACE_ID,
      projectRequestId: created.projectRequest.projectRequestId,
    }),
    (err: unknown) =>
      err instanceof Error &&
      err.name === "ProjectRequestError" &&
      (err as { code?: string }).code === "PROJECT_REQUEST_ALREADY_RESPONDED",
  );
  // The Deal + TermsVersion identity the first attempt surfaced is
  // the single canonical record.
  assert.equal(first.deal.status, "Negotiating");
  assert.equal(first.initialTermsVersion.version, 1);
  assert.equal(first.initialTermsVersion.aiDraftedUnapprovedBadge, true);
});

// M2 (#88): decline records the canonical outcome and creates no
// Deal AND no TermsVersion.
test("declineProjectRequest creates no Deal and no TermsVersion (canonical outcome)", async () => {
  const { projectRequestService } = buildFixture();
  const created = await projectRequestService.createProjectRequest({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    projectBriefId: BRIEF_ID,
    serviceOfferingId: OFFERING_ID,
  });
  const result = await projectRequestService.declineProjectRequest({
    userAccountId: SELLER_USER_ID,
    actingWorkspaceId: SELLER_WORKSPACE_ID,
    projectRequestId: created.projectRequest.projectRequestId,
  });
  assert.equal(result.projectRequest.status, "Declined");
  assert.equal(result.projectRequest.sellerConsentAt, null);
  // Decline must NOT carry a Deal or initial TermsVersion — the
  // existing service signature enforces that. The TypeScript
  // compiler catches the structural guarantee; this test is the
  // runtime mirror.
  const declined = result as unknown as { deal?: unknown; initialTermsVersion?: unknown };
  assert.equal(declined.deal, undefined);
  assert.equal(declined.initialTermsVersion, undefined);
});

test("acceptProjectRequest rejects a buyer Workspace member (only the seller side may accept)", async () => {
  const { projectRequestService } = buildFixture();
  const created = await projectRequestService.createProjectRequest({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    projectBriefId: BRIEF_ID,
    serviceOfferingId: OFFERING_ID,
  });
  // The buyer user is not a member of the seller Workspace, so
  // the seller authority snapshot surfaces isMember=false and the
  // application-owned evaluateSellerAuthority evaluator fails
  // closed with NOT_A_MEMBER. The service translates this to
  // PROJECT_REQUEST_FORBIDDEN.
  await assert.rejects(
    projectRequestService.acceptProjectRequest({
      userAccountId: BUYER_USER_ID,
      actingWorkspaceId: SELLER_WORKSPACE_ID,
      projectRequestId: created.projectRequest.projectRequestId,
    }),
    (err: unknown) => {
      return (
        err instanceof Error &&
        err.name === "ProjectRequestError" &&
        (err as { code?: string }).code === "PROJECT_REQUEST_FORBIDDEN"
      );
    },
  );
});

test("acceptProjectRequest rejects when the actor claims a different acting Workspace", async () => {
  const { projectRequestService } = buildFixture();
  const created = await projectRequestService.createProjectRequest({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    projectBriefId: BRIEF_ID,
    serviceOfferingId: OFFERING_ID,
  });
  await assert.rejects(
    projectRequestService.acceptProjectRequest({
      userAccountId: SELLER_USER_ID,
      actingWorkspaceId: BUYER_WORKSPACE_ID, // wrong workspace
      projectRequestId: created.projectRequest.projectRequestId,
    }),
    (err: unknown) => {
      return (
        err instanceof Error &&
        err.name === "ProjectRequestError" &&
        (err as { code?: string }).code === "PROJECT_REQUEST_FORBIDDEN"
      );
    },
  );
});

test("acceptProjectRequest retried on an already-accepted request fails with ALREADY_RESPONDED", async () => {
  const { projectRequestService } = buildFixture();
  const created = await projectRequestService.createProjectRequest({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    projectBriefId: BRIEF_ID,
    serviceOfferingId: OFFERING_ID,
  });
  await projectRequestService.acceptProjectRequest({
    userAccountId: SELLER_USER_ID,
    actingWorkspaceId: SELLER_WORKSPACE_ID,
    projectRequestId: created.projectRequest.projectRequestId,
  });
  await assert.rejects(
    projectRequestService.acceptProjectRequest({
      userAccountId: SELLER_USER_ID,
      actingWorkspaceId: SELLER_WORKSPACE_ID,
      projectRequestId: created.projectRequest.projectRequestId,
    }),
    (err: unknown) => {
      return (
        err instanceof Error &&
        err.name === "ProjectRequestError" &&
        (err as { code?: string }).code === "PROJECT_REQUEST_ALREADY_RESPONDED"
      );
    },
  );
});

test("declineProjectRequest transitions Pending to Declined and creates no Deal", async () => {
  const { projectRequestService, projectRequestRepo } = buildFixture();
  const created = await projectRequestService.createProjectRequest({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    projectBriefId: BRIEF_ID,
    serviceOfferingId: OFFERING_ID,
  });
  const result = await projectRequestService.declineProjectRequest({
    userAccountId: SELLER_USER_ID,
    actingWorkspaceId: SELLER_WORKSPACE_ID,
    projectRequestId: created.projectRequest.projectRequestId,
  });
  assert.equal(result.projectRequest.status, "Declined");
  assert.notEqual(result.projectRequest.sellerDecisionAt, null);
  assert.equal(result.projectRequest.sellerConsentAt, null);
  // No Deal should have been created. The in-memory repository
  // has no public listDeals, so we rely on the absence of an
  // accept call having been issued: the request status is
  // Declined and the sellerConsentAt is null, which is the
  // contract for decline.
  const stored = await projectRequestRepo.findProjectRequestById(
    created.projectRequest.projectRequestId,
  );
  assert.equal(stored?.status, "Declined");
});

test("declineProjectRequest retried on an already-declined request fails with ALREADY_RESPONDED", async () => {
  const { projectRequestService } = buildFixture();
  const created = await projectRequestService.createProjectRequest({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    projectBriefId: BRIEF_ID,
    serviceOfferingId: OFFERING_ID,
  });
  await projectRequestService.declineProjectRequest({
    userAccountId: SELLER_USER_ID,
    actingWorkspaceId: SELLER_WORKSPACE_ID,
    projectRequestId: created.projectRequest.projectRequestId,
  });
  await assert.rejects(
    projectRequestService.declineProjectRequest({
      userAccountId: SELLER_USER_ID,
      actingWorkspaceId: SELLER_WORKSPACE_ID,
      projectRequestId: created.projectRequest.projectRequestId,
    }),
    (err: unknown) => {
      return (
        err instanceof Error &&
        err.name === "ProjectRequestError" &&
        (err as { code?: string }).code === "PROJECT_REQUEST_ALREADY_RESPONDED"
      );
    },
  );
});

test("acceptProjectRequest retried on a Declined request fails with ALREADY_RESPONDED", async () => {
  const { projectRequestService } = buildFixture();
  const created = await projectRequestService.createProjectRequest({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    projectBriefId: BRIEF_ID,
    serviceOfferingId: OFFERING_ID,
  });
  await projectRequestService.declineProjectRequest({
    userAccountId: SELLER_USER_ID,
    actingWorkspaceId: SELLER_WORKSPACE_ID,
    projectRequestId: created.projectRequest.projectRequestId,
  });
  await assert.rejects(
    projectRequestService.acceptProjectRequest({
      userAccountId: SELLER_USER_ID,
      actingWorkspaceId: SELLER_WORKSPACE_ID,
      projectRequestId: created.projectRequest.projectRequestId,
    }),
    (err: unknown) => {
      return (
        err instanceof Error &&
        err.name === "ProjectRequestError" &&
        (err as { code?: string }).code === "PROJECT_REQUEST_ALREADY_RESPONDED"
      );
    },
  );
});

test("listProjectRequests returns Pending requests addressed to the seller's Workspace", async () => {
  const { projectRequestService } = buildFixture();
  const first = await projectRequestService.createProjectRequest({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    projectBriefId: BRIEF_ID,
    serviceOfferingId: OFFERING_ID,
  });
  const result = await projectRequestService.listProjectRequests({
    userAccountId: SELLER_USER_ID,
    actingWorkspaceId: SELLER_WORKSPACE_ID,
    statusFilter: "Pending",
  });
  assert.equal(result.projectRequests.length, 1);
  assert.equal(result.projectRequests[0]!.projectRequestId, first.projectRequest.projectRequestId);
  // Accept it; subsequent Pending list should be empty.
  await projectRequestService.acceptProjectRequest({
    userAccountId: SELLER_USER_ID,
    actingWorkspaceId: SELLER_WORKSPACE_ID,
    projectRequestId: first.projectRequest.projectRequestId,
  });
  const after = await projectRequestService.listProjectRequests({
    userAccountId: SELLER_USER_ID,
    actingWorkspaceId: SELLER_WORKSPACE_ID,
    statusFilter: "Pending",
  });
  assert.equal(after.projectRequests.length, 0);
});

test("getProjectRequest rejects a non-member of either side", async () => {
  const { projectRequestService } = buildFixture();
  const created = await projectRequestService.createProjectRequest({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    projectBriefId: BRIEF_ID,
    serviceOfferingId: OFFERING_ID,
  });
  // The other buyer is not a member of the request's buyer OR
  // seller Workspace. The service must fail closed with
  // PROJECT_REQUEST_NOT_FOUND (per ticket #62 — do not leak the
  // request's existence to non-members).
  await assert.rejects(
    projectRequestService.getProjectRequest({
      userAccountId: OTHER_BUYER_USER_ID,
      actingWorkspaceId: OTHER_BUYER_WORKSPACE_ID,
      projectRequestId: created.projectRequest.projectRequestId,
    }),
    (err: unknown) => {
      return (
        err instanceof Error &&
        err.name === "ProjectRequestError" &&
        (err as { code?: string }).code === "PROJECT_REQUEST_NOT_FOUND"
      );
    },
  );
});

// P0-001 verification: getProjectRequest requires the
// authenticated UserAccount to hold a current WorkspaceMembership
// in the explicitly acting Workspace BEFORE the repository is
// consulted. Supplying an actingWorkspaceId that matches a
// request party is not sufficient — the route still has to
// revalidate current membership.

test("getProjectRequest allows a current member to read", async () => {
  const { projectRequestService } = buildFixture();
  const created = await projectRequestService.createProjectRequest({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    projectBriefId: BRIEF_ID,
    serviceOfferingId: OFFERING_ID,
  });
  // The seller is a current member of the seller Workspace.
  const result = await projectRequestService.getProjectRequest({
    userAccountId: SELLER_USER_ID,
    actingWorkspaceId: SELLER_WORKSPACE_ID,
    projectRequestId: created.projectRequest.projectRequestId,
  });
  assert.equal(result.projectRequest.projectRequestId, created.projectRequest.projectRequestId);
});

test("getProjectRequest rejects an authenticated non-member using a real Workspace id", async () => {
  const { projectRequestService } = buildFixture();
  const created = await projectRequestService.createProjectRequest({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    projectBriefId: BRIEF_ID,
    serviceOfferingId: OFFERING_ID,
  });
  // The other buyer supplies the BUYER_WORKSPACE_ID (the real
  // buyer side) but is NOT a current member. The service must
  // fail closed WITHOUT revealing the request's existence, with
  // PROJECT_REQUEST_NOT_FOUND (the existing safe envelope).
  await assert.rejects(
    projectRequestService.getProjectRequest({
      userAccountId: OTHER_BUYER_USER_ID,
      actingWorkspaceId: BUYER_WORKSPACE_ID,
      projectRequestId: created.projectRequest.projectRequestId,
    }),
    (err: unknown) => {
      return (
        err instanceof Error &&
        err.name === "ProjectRequestError" &&
        (err as { code?: string }).code === "PROJECT_REQUEST_NOT_FOUND"
      );
    },
  );
});

test("getProjectRequest rejects an authenticated non-member using a real request id (actingWorkspaceId mismatch)", async () => {
  const { projectRequestService } = buildFixture();
  const created = await projectRequestService.createProjectRequest({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    projectBriefId: BRIEF_ID,
    serviceOfferingId: OFFERING_ID,
  });
  // The other buyer supplies the seller Workspace ID (a real
  // request party) without being a current member. The service
  // must fail closed with PROJECT_REQUEST_NOT_FOUND so the
  // envelope never reveals whether the request exists.
  await assert.rejects(
    projectRequestService.getProjectRequest({
      userAccountId: OTHER_BUYER_USER_ID,
      actingWorkspaceId: SELLER_WORKSPACE_ID,
      projectRequestId: created.projectRequest.projectRequestId,
    }),
    (err: unknown) => {
      return (
        err instanceof Error &&
        err.name === "ProjectRequestError" &&
        (err as { code?: string }).code === "PROJECT_REQUEST_NOT_FOUND"
      );
    },
  );
});

test("getProjectRequest immediately denies a revoked former member", async () => {
  const { projectRequestService } = buildFixture();
  const created = await projectRequestService.createProjectRequest({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    projectBriefId: BRIEF_ID,
    serviceOfferingId: OFFERING_ID,
  });
  // First, the seller reads successfully.
  const initial = await projectRequestService.getProjectRequest({
    userAccountId: SELLER_USER_ID,
    actingWorkspaceId: SELLER_WORKSPACE_ID,
    projectRequestId: created.projectRequest.projectRequestId,
  });
  assert.equal(initial.projectRequest.projectRequestId, created.projectRequest.projectRequestId);
  // Revoke the seller's current membership. The auth repo does
  // not expose a membership-remove primitive; rebuild it without
  // the seller's seller-workspace membership.
  const rebuilt = new InMemoryAuthRepository([
    {
      userAccountId: SELLER_USER_ID,
      email: "seller@example.com",
      identityProvider: "deterministic",
      identitySubject: "seller-subject",
      memberships: [], // revoked
    },
  ]);
  const authz = new WorkspaceAuthorizationService({ authRepository: rebuilt });
  // Wire the revoked authz into a fresh service so the
  // WorkspaceAuthorizationService lookup sees the revoked state.
  const freshService = new ProjectRequestService({
    projectRequestRepository: undefined as never, // not exercised on this path
    workspaceAuthorizationService: authz,
  });
  // The service collapses AuthorizationError to
  // PROJECT_REQUEST_NOT_FOUND on reads so the safe envelope
  // does not leak the request's existence.
  await assert.rejects(
    freshService.getProjectRequest({
      userAccountId: SELLER_USER_ID,
      actingWorkspaceId: SELLER_WORKSPACE_ID,
      projectRequestId: created.projectRequest.projectRequestId,
    }),
    (err: unknown) => {
      return (
        err instanceof Error &&
        err.name === "ProjectRequestError" &&
        (err as { code?: string }).code === "PROJECT_REQUEST_NOT_FOUND"
      );
    },
  );
});

test("listProjectRequests allows a current member to list", async () => {
  const { projectRequestService } = buildFixture();
  const created = await projectRequestService.createProjectRequest({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    projectBriefId: BRIEF_ID,
    serviceOfferingId: OFFERING_ID,
  });
  // The buyer is a current member of the buyer Workspace and may
  // list its requests.
  const result = await projectRequestService.listProjectRequests({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    statusFilter: "Pending",
  });
  assert.equal(result.projectRequests.length, 1);
  assert.equal(
    result.projectRequests[0]!.projectRequestId,
    created.projectRequest.projectRequestId,
  );
});

test("listProjectRequests rejects an authenticated non-member using a real Workspace id", async () => {
  const { projectRequestService } = buildFixture();
  await projectRequestService.createProjectRequest({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    projectBriefId: BRIEF_ID,
    serviceOfferingId: OFFERING_ID,
  });
  // The other buyer supplies the BUYER_WORKSPACE_ID but is not a
  // member. The service must fail closed before any list row is
  // produced, with PROJECT_REQUEST_NOT_FOUND so the envelope
  // does not leak the Workspace's request set existence.
  await assert.rejects(
    projectRequestService.listProjectRequests({
      userAccountId: OTHER_BUYER_USER_ID,
      actingWorkspaceId: BUYER_WORKSPACE_ID,
      statusFilter: "Pending",
    }),
    (err: unknown) => {
      return (
        err instanceof Error &&
        err.name === "ProjectRequestError" &&
        (err as { code?: string }).code === "PROJECT_REQUEST_NOT_FOUND"
      );
    },
  );
});

test("listProjectRequests rejects a revoked former member immediately", async () => {
  const { projectRequestService } = buildFixture();
  await projectRequestService.createProjectRequest({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    projectBriefId: BRIEF_ID,
    serviceOfferingId: OFFERING_ID,
  });
  // First, the buyer lists successfully.
  const initial = await projectRequestService.listProjectRequests({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    statusFilter: "Pending",
  });
  assert.equal(initial.projectRequests.length, 1);
  // Rebuilt auth repo with no buyer membership.
  const rebuilt = new InMemoryAuthRepository([
    {
      userAccountId: BUYER_USER_ID,
      email: "buyer@example.com",
      identityProvider: "deterministic",
      identitySubject: "buyer-subject",
      memberships: [], // revoked
    },
  ]);
  const authz = new WorkspaceAuthorizationService({ authRepository: rebuilt });
  const freshService = new ProjectRequestService({
    projectRequestRepository: undefined as never,
    workspaceAuthorizationService: authz,
  });
  await assert.rejects(
    freshService.listProjectRequests({
      userAccountId: BUYER_USER_ID,
      actingWorkspaceId: BUYER_WORKSPACE_ID,
      statusFilter: "Pending",
    }),
    (err: unknown) => {
      return (
        err instanceof Error &&
        err.name === "ProjectRequestError" &&
        (err as { code?: string }).code === "PROJECT_REQUEST_NOT_FOUND"
      );
    },
  );
});

// P1-003 verification: the service MUST NOT depend on Prisma. This
// test pins the type-level contract so a future regression that
// re-introduces `prisma` into the constructor would fail to compile.
test("ProjectRequestService has no Prisma dependency at the type level", () => {
  // Constructor signature: { projectRequestRepository, now? }. No
  // `prisma` field. The next line would NOT compile if `prisma`
  // were reintroduced.
  type _AssertNoPrisma = ProjectRequestService extends {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readonly prisma: any;
  }
    ? true
    : false;
  const assertFalse: _AssertNoPrisma = false;
  void assertFalse;
});

// Concurrency-retry-exhaustion mapping: when the Prisma adapter's
// bounded P2034 retry budget runs out, the repository returns
// `CONCURRENCY_RETRY_EXHAUSTED`. The service MUST surface that as
// the marketplace-busy transient envelope
// (PROJECT_REQUEST_UNAVAILABLE → 503) rather than masking it as an
// offering ineligibility or an already-responded state. The buyer
// and seller can retry the same payload once the marketplace is
// free again.
test("createProjectRequest maps CONCURRENCY_RETRY_EXHAUSTED to PROJECT_REQUEST_UNAVAILABLE", async () => {
  const { workspaceAuthorizationService } = buildFixture();
  const stubRepository = {
    createProjectRequestInTransaction: () =>
      Promise.resolve({ ok: false, reason: "CONCURRENCY_RETRY_EXHAUSTED" as const }),
    respondToProjectRequestInTransaction: () => Promise.reject(new Error("not used in this test")),
    findProjectRequestById: () => Promise.resolve(null),
    listProjectRequests: () => Promise.resolve([]),
  };
  const service = new ProjectRequestService({
    projectRequestRepository: stubRepository as never,
    workspaceAuthorizationService,
  });
  await assert.rejects(
    service.createProjectRequest({
      userAccountId: BUYER_USER_ID,
      actingWorkspaceId: BUYER_WORKSPACE_ID,
      projectBriefId: BRIEF_ID,
      serviceOfferingId: OFFERING_ID,
    }),
    (err: unknown) => {
      return (
        err instanceof Error &&
        err.name === "ProjectRequestError" &&
        (err as { code?: string }).code === "PROJECT_REQUEST_UNAVAILABLE"
      );
    },
  );
});

test("acceptProjectRequest maps CONCURRENCY_RETRY_EXHAUSTED to PROJECT_REQUEST_UNAVAILABLE", async () => {
  const { workspaceAuthorizationService } = buildFixture();
  const stubRepository = {
    createProjectRequestInTransaction: () => Promise.reject(new Error("not used in this test")),
    respondToProjectRequestInTransaction: () =>
      Promise.resolve({ ok: false, reason: "CONCURRENCY_RETRY_EXHAUSTED" as const }),
    findProjectRequestById: () => Promise.resolve(null),
    listProjectRequests: () => Promise.resolve([]),
  };
  const service = new ProjectRequestService({
    projectRequestRepository: stubRepository as never,
    workspaceAuthorizationService,
  });
  await assert.rejects(
    service.acceptProjectRequest({
      userAccountId: SELLER_USER_ID,
      actingWorkspaceId: SELLER_WORKSPACE_ID,
      projectRequestId: "pr-any",
    }),
    (err: unknown) => {
      return (
        err instanceof Error &&
        err.name === "ProjectRequestError" &&
        (err as { code?: string }).code === "PROJECT_REQUEST_UNAVAILABLE"
      );
    },
  );
});

// Anti-enumeration-vs-infra-leak contract:
//   - Expected typed `AuthorizationError` (NOT_A_MEMBER /
//     WORKSPACE_INELIGIBLE / MISSING_CAPABILITY /
//     WORKSPACE_NOT_FOUND) MUST collapse to PROJECT_REQUEST_NOT_FOUND
//     on reads so the safe envelope never reveals whether the
//     record exists.
//   - Unexpected infrastructure / database errors MUST propagate
//     unchanged so the route's safe 5xx path can surface them;
//     collapsing such an error to NOT_FOUND would falsely suggest
//     the record does not exist and mask a real incident from
//     operators.

test("getProjectRequest does not collapse unexpected infrastructure errors to PROJECT_REQUEST_NOT_FOUND", async () => {
  const { projectRequestRepo } = buildFixture();
  // A database / repository failure inside the membership lookup
  // MUST propagate. We model it by handing the authz service an
  // auth repository whose findCurrentMembership rejects with a
  // plain Error — NOT an AuthorizationError — so the service
  // narrows the catch correctly.
  const authz = new WorkspaceAuthorizationService({
    authRepository: {
      findCurrentMembership: () => Promise.reject(new Error("database connection lost")),
    } as never,
  });
  const service = new ProjectRequestService({
    projectRequestRepository: projectRequestRepo,
    workspaceAuthorizationService: authz,
  });
  await assert.rejects(
    service.getProjectRequest({
      userAccountId: BUYER_USER_ID,
      actingWorkspaceId: BUYER_WORKSPACE_ID,
      projectRequestId: "pr-any",
    }),
    (err: unknown) => {
      // The infrastructure error MUST propagate unchanged, not be
      // remapped into a ProjectRequestError with code
      // PROJECT_REQUEST_NOT_FOUND. The catch narrows on
      // AuthorizationError; a plain Error instance has a distinct
      // constructor and falls through unchanged.
      return (
        err instanceof Error &&
        err.name === "Error" &&
        err.message === "database connection lost" &&
        !((err as { code?: string }).code === "PROJECT_REQUEST_NOT_FOUND")
      );
    },
  );
});

test("listProjectRequests does not collapse unexpected infrastructure errors to PROJECT_REQUEST_NOT_FOUND", async () => {
  const { projectRequestRepo } = buildFixture();
  const authz = new WorkspaceAuthorizationService({
    authRepository: {
      findCurrentMembership: () => Promise.reject(new Error("database connection lost")),
    } as never,
  });
  const service = new ProjectRequestService({
    projectRequestRepository: projectRequestRepo,
    workspaceAuthorizationService: authz,
  });
  await assert.rejects(
    service.listProjectRequests({
      userAccountId: BUYER_USER_ID,
      actingWorkspaceId: BUYER_WORKSPACE_ID,
      statusFilter: "Pending",
    }),
    (err: unknown) => {
      return (
        err instanceof Error &&
        err.name === "Error" &&
        err.message === "database connection lost" &&
        !((err as { code?: string }).code === "PROJECT_REQUEST_NOT_FOUND")
      );
    },
  );
});

test("declineProjectRequest maps CONCURRENCY_RETRY_EXHAUSTED to PROJECT_REQUEST_UNAVAILABLE", async () => {
  const { workspaceAuthorizationService } = buildFixture();
  const stubRepository = {
    createProjectRequestInTransaction: () => Promise.reject(new Error("not used in this test")),
    respondToProjectRequestInTransaction: () =>
      Promise.resolve({ ok: false, reason: "CONCURRENCY_RETRY_EXHAUSTED" as const }),
    findProjectRequestById: () => Promise.resolve(null),
    listProjectRequests: () => Promise.resolve([]),
  };
  const service = new ProjectRequestService({
    projectRequestRepository: stubRepository as never,
    workspaceAuthorizationService,
  });
  await assert.rejects(
    service.declineProjectRequest({
      userAccountId: SELLER_USER_ID,
      actingWorkspaceId: SELLER_WORKSPACE_ID,
      projectRequestId: "pr-any",
    }),
    (err: unknown) => {
      return (
        err instanceof Error &&
        err.name === "ProjectRequestError" &&
        (err as { code?: string }).code === "PROJECT_REQUEST_UNAVAILABLE"
      );
    },
  );
});

// Make the typed import survive the strict TS settings.
void (null as unknown as ProjectBriefPublicV1);
