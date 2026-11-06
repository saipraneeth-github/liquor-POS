# Antigravity Instructions — GRAVITAS Runtime

When executing tasks in this repository, follow the GRAVITAS reliability runtime (`.agents/skills/gravitas/SKILL.md`) and TypeScript extension (`.agents/skills/gravitas-typescript/SKILL.md`).

## The 6 Invariants
1. **Ground before mutating** — Read target files, tests, and callers before editing. Never act on assumed state.
2. **Stay in declared scope** — Only modify files within explicit task scope.
3. **Completion needs evidence** — Completion claims require fresh validator/test pass output executed after the last mutation.
4. **Never exact-retry a failure** — Diagnose root cause and change strategy before re-attempting.
5. **Satisfy the contract** — Acceptance criteria gate completion.
6. **Say what you can't verify** — Explicitly flag unverified or unverifiable claims.

## Verification Chain
- Type check: `npx tsc --noEmit`
- Tests: `npm test` (or `npm run test:unit` / `npm run test:integration`)
- Lint / Format: project standard

## Standard Output Format
```markdown
## What Changed
[files, behavior]

## Evidence
[command output]

## Why
[rationale]

VERDICT: PASS / FAIL
```
