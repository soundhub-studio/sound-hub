/* eslint-disable @typescript-eslint/no-floating-promises */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Bg5GetDealResponseV1 } from "@soundhub/types";
import { findVisibleDeal } from "./find-visible-deal.js";

const visibleDeal = {
  deal: {
    deal: {
      dealId: "deal-1",
      buyerWorkspaceId: "ws-buyer",
      sellerWorkspaceId: "ws-seller",
      serviceOfferingId: "offering-1",
      projectBriefId: "brief-1",
      projectRequestId: "request-1",
      status: "Negotiating",
      activatedAt: null,
      createdAt: "2026-09-02T00:00:00.000Z",
    },
    currentTermsVersion: null,
    currentApprovals: [],
    sellerConsent: {
      status: "Accepted",
      sellerConsentAt: "2026-09-02T00:00:05.000Z",
    },
    actingSideHasDealApprover: false,
  },
} satisfies Bg5GetDealResponseV1;

describe("BG5 Deal bootstrap", () => {
  test("loads an authorized Deal before its party Workspaces are known", async () => {
    const calls: string[] = [];
    const result = await findVisibleDeal({
      dealId: "deal-1",
      workspaceIds: ["ws-seller"],
      fetchDeal: (_dealId, workspaceId) => {
        calls.push(workspaceId);
        return Promise.resolve(visibleDeal);
      },
    });

    assert.deepEqual(calls, ["ws-seller"]);
    assert.equal(result.actingWorkspaceId, "ws-seller");
    assert.equal(result.response.deal.deal.dealId, "deal-1");
  });

  test("probes the next current Workspace after a BG5_DEAL_NOT_FOUND from the unrelated one", async () => {
    const calls: string[] = [];
    const notFound = Object.assign(new Error("Deal not found."), {
      code: "BG5_DEAL_NOT_FOUND",
    });
    const result = await findVisibleDeal({
      dealId: "deal-1",
      workspaceIds: ["ws-unrelated", "ws-buyer"],
      fetchDeal: (_dealId, workspaceId) => {
        calls.push(workspaceId);
        if (workspaceId === "ws-unrelated") return Promise.reject(notFound);
        return Promise.resolve(visibleDeal);
      },
    });

    assert.deepEqual(calls, ["ws-unrelated", "ws-buyer"]);
    assert.equal(result.actingWorkspaceId, "ws-buyer");
    assert.equal(result.response.deal.deal.dealId, "deal-1");
  });

  test("does not hide session failures by probing another Workspace", async () => {
    const calls: string[] = [];
    const sessionError = Object.assign(new Error("Session expired."), {
      code: "SESSION_EXPIRED",
    });

    await assert.rejects(
      findVisibleDeal({
        dealId: "deal-1",
        workspaceIds: ["ws-one", "ws-two"],
        fetchDeal: (_dealId, workspaceId) => {
          calls.push(workspaceId);
          return Promise.reject(sessionError);
        },
      }),
      sessionError,
    );
    assert.deepEqual(calls, ["ws-one"]);
  });

  test("stops immediately on an arbitrary non-not-found error", async () => {
    const calls: string[] = [];
    const arbitraryError = Object.assign(new Error("Unexpected boom."), {
      code: "BG5_DEAL_INTERNAL_FAILED",
    });

    await assert.rejects(
      findVisibleDeal({
        dealId: "deal-1",
        workspaceIds: ["ws-unrelated", "ws-buyer"],
        fetchDeal: (_dealId, workspaceId) => {
          calls.push(workspaceId);
          return Promise.reject(arbitraryError);
        },
      }),
      arbitraryError,
    );
    assert.deepEqual(calls, ["ws-unrelated"]);
  });
});
