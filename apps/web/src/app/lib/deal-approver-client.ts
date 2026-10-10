// DealApprover client (M2 #88).
//
// Background: ticket #88 requires a Personal-Workspace-only
// self-service command that provisions a `DealApprover`
// authorization. The browser invokes the
// `POST /api/deal-approvers` endpoint through a small typed
// helper. Every call includes `credentials: "include"` so the
// HttpOnly session cookie rides on the request. Responses are
// parsed against the shared Zod schema from `@soundhub/types` so
// the browser cannot drift from the contract.

import type {
  ProvisionDealApproverRequestV1,
  ProvisionDealApproverResponseV1,
} from "@soundhub/types";
import { provisionDealApproverResponseV1Schema } from "@soundhub/types";

export interface DealApproverClientError {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly requestId: string | null;
}

async function parseErrorResponse(response: Response): Promise<DealApproverClientError> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Network or empty body — fall through to a generic error so
    // the UI can render an actionable message.
  }
  const candidate = body as {
    error?: {
      code?: string;
      message?: string;
      requestId?: string;
    };
  } | null;
  return {
    status: response.status,
    code: candidate?.error?.code ?? "DEAL_APPROVER_INTERNAL_FAILED",
    message:
      candidate?.error?.message ?? "DealApprover request failed. Please try again in a moment.",
    requestId: candidate?.error?.requestId ?? null,
  };
}

function ensureError(value: unknown, fallback: DealApproverClientError): Error {
  if (value instanceof Error) return value;
  const err = new Error(fallback.message);
  Object.assign(err, fallback);
  return err;
}

export async function provisionDealApprover(
  input: ProvisionDealApproverRequestV1,
): Promise<ProvisionDealApproverResponseV1> {
  const response = await fetch("/api/deal-approvers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw ensureError(null, await parseErrorResponse(response));
  }
  const raw: unknown = await response.json();
  return provisionDealApproverResponseV1Schema.parse(raw);
}
