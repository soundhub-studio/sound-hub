/* eslint-disable @typescript-eslint/no-floating-promises */
// Prisma adapter retry-helper tests for the bounded P2034
// behaviour.
//
// Background: ticket #62 acceptance criteria require that a
// PostgreSQL Serializable conflict (Prisma error code P2034) on a
// BG4 command is retried up to a small fixed maximum and surfaces
// as a safe typed failure after exhaustion. The retry helper
// lives in the Prisma adapter; these tests drive it through a
// real `PrismaClient` against the disposable test database by
// installing a one-shot P2034 wrapper around the production
// repository. The wrapper is enabled via the existing test seam
// only; no generalized retry framework is introduced.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createPrismaClient, type PrismaClient } from "@soundhub/db";
import { assertDisposableTestDatabase, readTestDatabaseUrl } from "../lib/test-database.js";
import { PrismaProjectRequestRepository } from "./prisma-project-request.repository.js";
import { loadOrCreateFixture, type ProjectRequestFixture } from "./test-fixture.js";
import { buyerOkUseCase } from "./test-use-cases.js";
import { PrismaClientKnownRequestError } from "@soundhub/db/dist/generated/internal/prismaNamespace.js";

let prisma: PrismaClient;
let fixture: ProjectRequestFixture;

before(async () => {
  const url = readTestDatabaseUrl();
  assertDisposableTestDatabase(url);
  prisma = createPrismaClient(url);
  fixture = await loadOrCreateFixture(prisma);
});

after(async () => {
  if (prisma) await prisma.$disconnect();
});

/**
 * Build a real Prisma `P2034` error whose code property matches
 * the production check. The retry helper identifies a
 * serialization conflict by `code === "P2034"`; we hand-craft a
 * PrismaClientKnownRequestError instance so the retry helper
 * observes a real error type and surface.
 */
function buildP2034Error(): PrismaClientKnownRequestError {
  // The shape Prisma uses for `PrismaClientKnownRequestError` is
  // intentionally narrow. We construct it via the constructor
  // signature Prisma documents: `new PrismaClientKnownRequestError(
  //   message, { code, clientVersion, meta, batchRequestIndex })`.
  // `clientVersion` must match the running Prisma client version
  // but the retry helper does not check it.
  return new PrismaClientKnownRequestError(
    "Transaction failed due to a write conflict or a deadlock. Please retry your transaction.",
    {
      code: "P2034",
      clientVersion: "test",
    },
  );
}

/**
 * A Prisma `PrismaClient` proxy whose `$transaction` throws the
 * injected error the requested number of times, then passes
 * through to the underlying `prisma.$transaction`. Used to drive
 * the retry helper's success-after-P2034 path and its retry-
 * exhaustion path deterministically.
 */
function withTransactionFailureProxy(underlying: PrismaClient, failCount: number): PrismaClient {
  let remaining = failCount;
  // The proxy's wrapped `$transaction` intentionally bypasses
  // Prisma's typed overload set so it can throw a synthetic
  // serialization-conflict error before delegating to the real
  // implementation. The unsafe `any` cast is contained to this
  // test seam; production code never uses `any`.
  type TransactionFn = (...args: unknown[]) => Promise<unknown>;
  const original = underlying.$transaction.bind(underlying) as TransactionFn;
  const wrapped: TransactionFn = (...args: unknown[]) => {
    if (remaining > 0) {
      remaining -= 1;
      throw buildP2034Error();
    }
    return original(...args);
  };
  const proxy = new Proxy(underlying, {
    get(target, prop, receiver): unknown {
      if (prop === "$transaction") {
        return wrapped;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return proxy;
}

test("bounded P2034 retry success: the helper retries on P2034 and succeeds on the next attempt", async () => {
  // Reset the BG4 rows so the test starts clean. M2 (#88) initial
  // TermsVersion rows hold a RESTRICT FK to deals; remove them
  // first.
  await prisma.dealApproval.deleteMany({
    where: { termsVersion: { deal: { projectBriefId: fixture.brief.id } } },
  });
  await prisma.termsVersion.deleteMany({
    where: { deal: { projectBriefId: fixture.brief.id } },
  });
  await prisma.deal.deleteMany({ where: { projectBriefId: fixture.brief.id } });
  await prisma.projectRequest.deleteMany({ where: { projectBriefId: fixture.brief.id } });

  const proxy = withTransactionFailureProxy(prisma, 1);
  const wrappedRepo = new PrismaProjectRequestRepository(proxy);

  const result = await wrappedRepo.createProjectRequestInTransaction(
    {
      buyerWorkspaceId: fixture.buyerWorkspace.id,
      projectBriefId: fixture.brief.id,
      serviceOfferingId: fixture.offering.id,
      userAccountId: fixture.buyerUser.id,
    },
    buyerOkUseCase,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.status, "Pending");
  // Exactly one ProjectRequest row exists; no partial state from
  // the failed attempt.
  const count = await prisma.projectRequest.count({
    where: { projectBriefId: fixture.brief.id },
  });
  assert.equal(count, 1);
});

test("bounded P2034 retry exhaustion: after the budget the helper returns CONCURRENCY_RETRY_EXHAUSTED with no partial state", async () => {
  // Reset the BG4 rows so the test starts clean. M2 (#88) initial
  // TermsVersion rows hold a RESTRICT FK to deals; remove them
  // first.
  await prisma.dealApproval.deleteMany({
    where: { termsVersion: { deal: { projectBriefId: fixture.brief.id } } },
  });
  await prisma.termsVersion.deleteMany({
    where: { deal: { projectBriefId: fixture.brief.id } },
  });
  await prisma.deal.deleteMany({ where: { projectBriefId: fixture.brief.id } });
  await prisma.projectRequest.deleteMany({ where: { projectBriefId: fixture.brief.id } });

  // Fail 3 times — the budget is 3 attempts; after the third
  // failure the helper returns CONCURRENCY_RETRY_EXHAUSTED.
  const proxy = withTransactionFailureProxy(prisma, 3);
  const wrappedRepo = new PrismaProjectRequestRepository(proxy);

  const result = await wrappedRepo.createProjectRequestInTransaction(
    {
      buyerWorkspaceId: fixture.buyerWorkspace.id,
      projectBriefId: fixture.brief.id,
      serviceOfferingId: fixture.offering.id,
      userAccountId: fixture.buyerUser.id,
    },
    buyerOkUseCase,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "CONCURRENCY_RETRY_EXHAUSTED");
  // No partial state from any of the failed attempts.
  const count = await prisma.projectRequest.count({
    where: { projectBriefId: fixture.brief.id },
  });
  assert.equal(count, 0);
});
