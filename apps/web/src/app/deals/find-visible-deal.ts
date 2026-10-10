import type { Bg5GetDealResponseV1 } from "@soundhub/types";

interface DealClientError extends Error {
  readonly code?: string;
}

export interface FindVisibleDealInput {
  readonly dealId: string;
  readonly workspaceIds: readonly string[];
  readonly fetchDeal: (dealId: string, actingWorkspaceId: string) => Promise<Bg5GetDealResponseV1>;
  /**
   * M2 (#88) Codex finding (post 8d1ac3b): the source URL
   * may carry `?actingWorkspaceId=` to preserve the human's
   * selection across navigation. When supplied, the
   * bootstrap probes this Workspace FIRST (so the human returns
   * to the same selection after the permission-setup flow)
   * and only falls back to the full probe when the URL selection
   * is unknown, no longer a current membership, or no longer a
   * party to this Deal. The API revalidates membership +
   * Deal-party relationship on every request; the helper never
   * trusts client state.
   */
  readonly preferredActingWorkspaceId?: string;
}

export interface VisibleDealResult {
  readonly actingWorkspaceId: string;
  readonly response: Bg5GetDealResponseV1;
}

/**
 * Bootstrap a Deal read before the browser knows which of the
 * authenticated human's current Workspaces is a party to it. Each
 * request still commands one exact acting Workspace and the API remains
 * authoritative for current membership and Deal-party authorization.
 */
export async function findVisibleDeal(input: FindVisibleDealInput): Promise<VisibleDealResult> {
  let lastNotFound: DealClientError | null = null;
  // M2 (#88) Codex finding: probe the source-URL selection
  // FIRST (when it is one of the human's current memberships)
  // so the page returns to the same acting Workspace after
  // permission-setup. The API still revalidates on every call,
  // so a stale `preferredActingWorkspaceId` collapses to NOT_FOUND
  // and the helper falls back to the full probe.
  const probeOrder: string[] = [];
  if (
    input.preferredActingWorkspaceId !== undefined &&
    input.workspaceIds.includes(input.preferredActingWorkspaceId)
  ) {
    probeOrder.push(input.preferredActingWorkspaceId);
  }
  for (const workspaceId of input.workspaceIds) {
    if (!probeOrder.includes(workspaceId)) probeOrder.push(workspaceId);
  }

  for (const workspaceId of probeOrder) {
    try {
      const response = await input.fetchDeal(input.dealId, workspaceId);
      return { actingWorkspaceId: workspaceId, response };
    } catch (error) {
      const candidate = error instanceof Error ? (error as DealClientError) : null;
      if (candidate?.code !== "BG5_DEAL_NOT_FOUND") throw error;
      lastNotFound = candidate;
    }
  }

  if (lastNotFound) throw lastNotFound;
  throw Object.assign(new Error("Deal not found."), { code: "BG5_DEAL_NOT_FOUND" });
}
