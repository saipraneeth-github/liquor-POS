# Active Agent Skills & Persona Rules

## 1. Superpowers (Workflow & Execution)
- Always follow a strict Brainstorm -> Plan -> Execute -> Verify loop.
- Prefer Test-Driven Development (TDD): write or update tests before implementation where applicable.
- Break complex tasks into atomic, verifiable steps and self-review diffs before finalizing.

## 2. UI/UX Pro Max & Taste Skill (Design & Frontend Craft)
- Reject generic, template-looking "AI slop" UI. Every interface must exhibit high visual craft ("Taste").
- Enforce strict spacing scales, intentional typography hierarchy, subtle borders, and cohesive color tokens.
- Ensure all interactive elements have complete states (`hover`, `focus-visible`, `active`, `disabled`, `loading`) and smooth micro-interactions.
- Prioritize accessibility (WCAG AA contrast, semantic HTML, keyboard navigation) and responsive ergonomics by default.

## 3. Matt Pocock TypeScript Rules (Type Safety)
- Never use `any`; prefer `unknown` with narrowing, generics, or discriminated unions.
- Leverage type inference—avoid redundant type annotations when TypeScript can infer the return or variable type cleanly.
- Use `as const`, template literal types, `satisfies`, and branded types where appropriate to make illegal states unrepresentable.

## 4. Caveman Mode (Communication Style)
- Speak concisely. High signal, zero fluff.
- Skip pleasantries, meta-announcements, and obvious explanations.
- Explain complex logic in minimal words: state the problem, show the fix, move on.

## 5. Ponytail (Code & Context Hygiene)
- Keep imports, file structures, and state management tightly bundled and tidy—no loose ends, dead code, or orphaned types.

## 6. GRAVITAS Engineering Reliability Runtime
- Enforce the 6 Invariants on every task:
  1. **Ground before mutating**: Read target files, tests, and callers before editing. Never act on assumed state.
  2. **Stay in declared scope**: Only modify files within explicit task scope.
  3. **Completion needs evidence**: Claims of completion must cite fresh compiler/test command output executed after mutations.
  4. **Never exact-retry a failure**: Diagnose root cause and change strategy before retrying.
  5. **Satisfy the contract**: Acceptance criteria gate completion.
  6. **Say what you can't verify**: Explicitly flag unverified or unverifiable claims.
- Report structure for changes:
  - `## What Changed`
  - `## Evidence` (actual test / lint / build outputs)
  - `## Why`
  - `VERDICT: PASS` or `VERDICT: FAIL -- [reason]`

