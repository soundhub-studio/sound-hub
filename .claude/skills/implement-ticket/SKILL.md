---
name: implement-ticket
description: Load a SoundHub GitHub issue, establish ticket-specific implementation boundaries, preserve the accepted milestone foundation, and prepare the implementation engineer to execute the ticket. Use together with the implement skill.
disable-model-invocation: true
---

# SoundHub Ticket Implementation

Implement GitHub issue #$ARGUMENTS.

## Live ticket

!`gh issue view $ARGUMENTS --repo soundhub-studio/sound-hub`

The GitHub issue above is the authoritative work order.

Before editing, also read:

- `AGENTS.md`
- `CLAUDE.md`
- `CONTEXT.md`
- the relevant milestone specification
- the relevant milestone implementation plan
- contracts referenced by the ticket
- accepted ADRs referenced by those documents

Do not infer ticket requirements solely from existing code.

## Existing foundation

This ticket inherits all architecture already accepted and merged for
earlier tickets in the milestone.

Extend existing foundations rather than creating parallel mechanisms.

For Milestone 1, do not redesign without concrete conflicting evidence:

- disposable PostgreSQL test infrastructure and safety guards
- deterministic seed architecture
- repository seam and Prisma persistence boundary
- Zod runtime-contract ownership
- PostgreSQL ownership of extensible taxonomy records
- closed behavioral enum strategy
- Next.js proxy/rewrite strategy
- API request and safe-error handling
- Playwright real-stack tracer architecture

If the current ticket cannot be satisfied without contradicting an
accepted architectural decision:

STOP — ARCHITECTURE CONFLICT

Report:

- the conflicting ticket requirement
- the accepted architectural decision
- the relevant files/documents
- why implementation cannot safely proceed

Do not choose new architecture yourself.

## Determine the delta

Before implementation:

1. Read the issue body and acceptance criteria.
2. Read parent/dependency information.
3. Determine what the merged implementation already satisfies.
4. Identify the remaining ticket delta.
5. Implement only that delta.
6. Do not pull later-ticket behavior into the current ticket merely
   because the same files are being edited.

## Working tree

Before editing:

- inspect `git branch --show-current`
- inspect `git status --short`
- preserve unrelated tracked and untracked work
- only stage files belonging to the current ticket

Do not clean or delete unrelated work.

## Completion contract

When implementation and required validation pass:

- prove each ticket acceptance criterion
- create a local ticket-specific commit
- do not push
- do not create a PR
- do not merge
- finish with `READY FOR CODEX REVIEW`
