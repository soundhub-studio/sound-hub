# AGENTS.md

Guidance for Codex and other engineering agents working in SoundHub.

## Product and authority

SoundHub is an AI-assisted Caribbean creative-services marketplace. Read these before changing
domain behavior:

1. `CONTEXT.md` for canonical terminology
2. Relevant accepted records in `docs/adr/`
3. `spec.md` for the MVP product baseline
4. The applicable feature specification, plan, and contract

Do not revive producer-only or exclusive-role terminology that conflicts with the glossary. Surface
an ADR conflict instead of silently overriding it.

## Current implementation target

Milestone 1 is the completed foundational milestone:

- Specification: `docs/specs/milestone-1-talent-search.md`
- Plan: `docs/plans/milestone-1-talent-search.md`
- API contract: `docs/contracts/search-api.md`

Milestone 1 replaces the pre-release producer-only mock with deterministic PostgreSQL-backed seller
and ServiceOffering search. It establishes a minimal Workspace ownership foundation but excludes
authentication, agents, Redis, uploads, Deals, wallets, escrow, and blockchain behavior.

Milestone 2 is now the implementation-ready milestone. Implementation is governed by:

- Functional and domain completion contract:
  `docs/specs/milestone-2-reconciled-personal-workspace-onboarding.md`
- UX, presentation, and accessibility contract:
  `docs/specs/milestone-2-reconciled-ux.md`
- GitHub issues #82–#89 as the current implementation slices

The historical specification
`docs/specs/milestone-2-authenticated-workspaces-seller-onboarding.md` is superseded and preserved
only for traceability; its deferred scope must not be inferred back into issues #82–#89.

## Actual monorepo

```text
apps/
├── web/       Next.js App Router frontend
└── api/       Express TypeScript API

packages/
├── types/     Shared TypeScript contracts
└── db/        Prisma schema, client, and seed
```

Root configuration includes pnpm workspaces, TypeScript, ESLint, Prettier, and Docker Compose.
PostgreSQL and Redis services are described in Docker Compose; Redis is not a current runtime
dependency.

## Current code status

Milestone 1 (BG1–BG7) is the completed production foundation. Current repository behavior is
defined by accepted ADRs in `docs/adr/`, current specs in `docs/specs/`, current migrations,
executable contracts in `docs/contracts/`, and tests. M2 is the current implementation target.

## Stack

- Node.js 20+ using ESM
- pnpm workspace
- Next.js + React + TypeScript
- Express + TypeScript
- PostgreSQL + Prisma
- ESLint flat configuration + Prettier
- Node test runner for current API tests

Existing approved infrastructure — including the current StorageAdapter abstraction and its
already-supported providers — is a valid existing dependency and may be reused where required by
issues #82–#89.

Do not introduce unrelated new storage systems, queues, caches, vector databases, blockchain
infrastructure, Redis, OpenAI, Pinecone, Google ADK, Polkadot, or other new platform dependencies
unless an approved ticket or spec explicitly requires them. Do not replace the existing storage
abstraction or introduce a new storage provider.

## Commands

```bash
# Install
pnpm install

## Feedback loop

Use the narrowest useful verification during implementation.

1. After a meaningful change, run the closest affected test or package test.
2. Before declaring work ready for review, run `pnpm check:fast`.
3. Run `pnpm test:repository` when repository, persistence, migration,
   transaction, or concurrency behavior changes.
4. Run focused Playwright/E2E coverage when user-visible behavior changes.
5. Run `pnpm build` when build/runtime integration is relevant.
6. Do not repeatedly run the full repository suite while debugging one
   focused failure.
7. If an unrelated required check fails, classify it before modifying code:
   - FIX HERE
   - FOLLOW-UP TICKET
   - PRE-EXISTING / FLAKE
8. GitHub CI is the final broad merge gate.

# Development
pnpm dev
pnpm dev:web
pnpm dev:api

# Quality
pnpm type-check
pnpm lint
pnpm test
pnpm build
pnpm format:check
pnpm check

# Formatting mutation
pnpm format

# Prisma and local infrastructure
pnpm prisma:generate
pnpm --filter @soundhub/db db:migrate
pnpm --filter @soundhub/db db:seed
pnpm --filter @soundhub/db db:studio
pnpm db:up
pnpm db:down
```

`pnpm db:down` removes Compose volumes. Confirm the target and preservation requirements before
running destructive database operations. Do not use `prisma db push` as a substitute for a reviewed
migration.

Expected local ports:

- Web: `http://localhost:3000`
- API: `http://localhost:4000`
- PostgreSQL: `localhost:5432`
- Redis Compose service: `localhost:6379` when explicitly needed later

## Engineering constraints

- Keep public DTOs allow-listed; never serialize Prisma models directly.
- Treat PostgreSQL as canonical. Vector indexes are derived projections.
- Keep agents outside authorization, state-transition, deadline, approval, and payment authority.
- Use runtime validation at untrusted JSON and tool boundaries; TypeScript alone is insufficient.
- Required search constraints may not be silently dropped or relaxed.
- relevanceScore is deterministic strategy-specific ordering, not buyer-facing confidence.
- Preserve immutable terms, approvals, delivery versions, and audit evidence in later milestones.
- Do not expose account identity, membership, wallet, embedding, or storage internals publicly.

## Codex code review

Review changes against the linked GitHub issue, repository specifications,
and established SoundHub architecture.

### Implementation slices

Some tickets use tracked implementation slices.

- Determine the declared current review scope before reporting missing work.
- Do not report requirements explicitly assigned to later slices as blockers.
- Report regressions to previously completed slices.
- When the PR declares the ticket complete or reaches its final slice,
  review the complete ticket acceptance criteria.

### Findings

Prioritize:
1. correctness and broken user journeys
2. authorization and Workspace isolation
3. data integrity and transactional behavior
4. API and DTO contract regressions
5. accessibility and required responsive behavior
6. missing tests for material behavior

Do not block on:
- stylistic preferences already enforced by tooling
- speculative future architecture
- work explicitly outside the current ticket scope

Treat CI, tests, branch protections, and required approvals as separate hard gates.

## Current work

Milestone 1 / BG1–BG7 are completed foundation and must remain regression-safe. Milestone 2 is the
current implementation target.

M2 implementation is governed by:

- Functional and domain completion contract:
  `docs/specs/milestone-2-reconciled-personal-workspace-onboarding.md`
- UX, presentation, and accessibility contract: `docs/specs/milestone-2-reconciled-ux.md`
- GitHub issues #82–#89 in their approved dependency order

Historical and deferred M2 requirements must not be pulled back into current M2. Later-milestone
work must not be introduced without explicit authorization.

When a ticket, spec, or test conflicts with current repository behavior or with an accepted ADR,
stop and surface the conflict rather than silently inventing behavior.

# Branch Review Commands

Use these commands when running the `review-branch` skill in SoundHub.

## Repository defaults

Default branch:

```bash
main
```

Package manager:

```bash
pnpm
```

## Primary fast gate

```bash
pnpm check:fast
```

## Production build

```bash
pnpm build
```

## Package tests

API:

```bash
pnpm --filter @soundhub/api test
```

Web:

```bash
pnpm --filter @soundhub/web test
```

## PostgreSQL repository suite

```bash
pnpm test:repository
```

Run `pnpm test:repository` only when the ticket changes:

- persistence;
- repository behavior;
- transactions;
- concurrency; or
- a ticket explicitly requires repository-level verification.

## Playwright

Run only the Playwright spec or specs relevant to the current ticket unless the ticket is broad enough to justify the full browser suite.

Do not run the full browser suite by default during branch review.

## Read-only review constraints

During review, never use:

- formatting write flags;
- lint auto-fix flags;
- snapshot update flags;
- migration-generation commands;
- dependency installation or upgrade commands; or
- any command intended to modify tracked repository files.

Allowed examples:

```bash
git status --short
git branch --show-current
git rev-parse HEAD
git diff origin/main...HEAD --stat
git diff origin/main...HEAD --name-status
git diff origin/main...HEAD
pnpm check:fast
pnpm build
pnpm --filter @soundhub/api test
pnpm --filter @soundhub/web test
```

Before and after verification, run:

```bash
git status --short
```

If a verification command modifies tracked files, stop and report the change rather than repairing it during review.
