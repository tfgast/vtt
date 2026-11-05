# A Table of Dumb Objects

A virtual tabletop built on one idea: every object is a bag of cells, cells hold
literals or formulas, and rules attach to space. Read `docs/DESIGN.md` for the
model and `docs/FORMULAS.md` for the formula and action language. The decision
log at the end of DESIGN.md is the ADR; a commit that changes a decision edits it.

## Stack (decided)

TypeScript end to end, pnpm workspace, Node, Vitest. Formula parser is a
hand-written Pratt parser. UI chrome is React; the scene is Canvas2D behind a
renderer interface. See DESIGN.md section 7.

Packages: `schema` (document and operation types, validation), `formula`
(lexer, parser, evaluator, dice; pure), `authority` (document plus op stream,
undo, persistence, spatial index, WebSocket protocol, MCP server), `ui`,
`fixtures` (machine-readable acceptance fixtures shared by tests and review).

### Conventions

- Before asking for review, run `pnpm typecheck`, `pnpm lint`,
  `pnpm format:check`, and `pnpm test`. All four must exit 0.
- Tooling is pinned to TypeScript 7, Vitest 5, and Biome 2 (exact versions in
  the root `package.json`); configure against those majors.
- Libraries are consumed as TypeScript source: each package's `exports` maps
  `"."` to `./src/index.ts`, and Vite, Vitest, and tsx resolve it directly.
  No build step for libraries in v1.
- Each package has a `tsconfig.json` extending `tsconfig.base.json` and a
  `typecheck` script running `tsc --noEmit`. No composite, no project
  references. With zero packages, `pnpm -r --parallel typecheck` prints
  "No projects matched the filters" and exits 0; no extra flag is needed.
- One `vitest.config.ts` per package. Biome is the only linter and formatter.
- The root `vitest.config.ts` runs `projects: ["packages/*"]`; each package's
  config sets `test.name` to its package name. Tests import their own package
  by name (`"@vtt/<pkg>"`), which resolves through the `exports` self-reference
  with no alias or tsconfig `paths`.
- Every package must have at least one test file. Vitest only fails an
  entirely empty run, so an inline reporter in the root config fails
  `pnpm test` when any project globs zero test files, even on filtered runs.

## Tracking: beads

Issues live in beads (`bd`), prefix `vtt`. `.beads/issues.jsonl` is committed.

- Milestone epics are filed ahead of time. Each starts with one child: a
  planning bead. Working a planning bead means writing that epic's
  implementation beads, then getting them reviewed by Codex as a plan, then
  closing the planning bead.
- A planning bead for epic N is ready once the planning beads of N's
  predecessor epics are closed. Planning runs one epic ahead of implementation
  along the dependency graph, not in a strict line.
- Standing epics `Polish` and `Later` collect followups that are not needed for
  the current milestone.

### Implementation bead shape

Every implementation bead must state, in its description:

1. **Implements:** the doc sections (e.g. `FORMULAS.md §2.2, §6`).
2. **Done when:** fixtures or acceptance criteria that must pass.
3. **Out of scope:** what this bead explicitly does not touch.
4. **Depends on:** other beads, recorded with `bd dep`.

If a subagent finds the scope ambiguous, the bead is defective. Fix the bead,
do not let the agent guess.

## Loop per implementation bead

1. Pick from `bd ready`. Mark in progress.
2. Branch `vtt-<id>/<slug>` in its own worktree. Subagent (Opus 5.5) implements
   from the bead text plus the named doc sections. Tests first.
3. Orchestrator checks the diff against the doc and runs the tests. Does not
   implement.
4. Codex reviews the branch against the bead's stated scope. Findings are
   input, not a gate. Each finding gets one disposition: fix before merge,
   file as a bead in the current milestone epic, or file into Polish or Later.
   Out-of-scope findings never block the bead, however real.
5. Merge to main. Close the bead referencing the merge commit.

Two or three implementation beads run concurrently.

## Commit conventions

- Subject starts with the bead id: `vtt-a3f2dd: parse dice literals`.
- One bead per branch. Planning changes to `.beads/` may ride along.
- Design decisions changed by the work are recorded in the decision log in the
  same commit.
