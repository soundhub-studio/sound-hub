// Express DealApprover router (M2 #88).
//
// Background: ticket #88 requires a single endpoint
// `POST /api/deal-approvers` that provisions a `DealApprover`
// authorization for the acting Personal-Workspace human. The
// router wires the handler under the same path and dispatches
// by HTTP method.

import { Router } from "express";
import {
  createProvisionDealApproverHandler,
  type DealApproverRouteDeps,
} from "./deal-approver-handlers.js";

export type { DealApproverRouteDeps };

export function createDealApproverRouter(deps: DealApproverRouteDeps): Router {
  const router = Router();
  const handler = createProvisionDealApproverHandler(deps);
  router.post("/", (req, res, next) => {
    void handler(req, res).catch(next);
  });
  return router;
}
