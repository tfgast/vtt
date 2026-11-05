# Plan: M5 Faces, actions, binders, log, ink (epic vtt-1xv)

Plan for the planning bead vtt-1xv.1. Filed on 2026-11-05 after the
orchestrator's decisions (plan-m5-decisions.md: every Q1–Q22 proposal
accepted). Plan labels map to filed ids: M5-0 vtt-1xv.5, M5-a vtt-1xv.6, M5-b vtt-1xv.7, M5-c vtt-1xv.8, M5-d vtt-1xv.9, M5-e vtt-1xv.10, M5-f vtt-1xv.11, M5-g vtt-1xv.12, M5-h vtt-1xv.13, M5-i vtt-1xv.14, M5-j vtt-1xv.15, M5-k vtt-1xv.16, M5-l vtt-1xv.17, M5-m vtt-1xv.18, M5-n vtt-1xv.19, M5-o vtt-1xv.20, M5-p vtt-1xv.21, M5-q vtt-1xv.22, M5-y vtt-1xv.23, M5-z vtt-1xv.24. Section 2 holds the filed
descriptions, which have plan labels replaced by ids in bd. The M4 amendments
of Q1 (A1–A5) are applied to vtt-3l6.22, .23, .6, .7, .13 (one test each,
plus a comment on each). The original draft is plan-m5.draft.md. Written 2026-11-05 against
main at b8f5ef4: M1 and M2 closed; M3 (vtt-5su) has vtt-5su.10 and .23 in
progress and .11, .12, .13, .14, .15, .17 open; M4 (vtt-3l6) is fully
planned (vtt-3l6.2–.25, plan-m4.md after review r3) and not started. The M4
bead texts as filed are the contracts M5 consumes; where M5 needs a seam M4
does not have, section 4 Q1 proposes amending the M4 bead now (cheap: none
has started) with "M5 edits the merged M4 file" as the alternative.

**What M5 delivers.** Actions run: `invoke` stops answering `unsupported`.
The authority parses an action's steps (a new pure step parser in
`@vtt/formula`), evaluates `when`, runs the nine step kinds atomically in one
`action` group with transactional dice, and refuses with `when_false`,
`when_error` or `step_error` (plus the primitives' own refusals). The
protocol carries `invoke` with deduplication and the same stale-write
discipline as `transact`, the client retries it like `transact`, and the MCP
server gains an `invoke` tool (D19 parity with the UI's buttons). Objects
gain a face layout (a field like `actions`, edited with a new `set_face` op):
value, editor, button and contents elements with a show-when formula, a
minimum on-screen size and a compact (collapsed) face; object views carry the
face and each action's enabled state, filtered per viewer. The UI draws faces
on the canvas through M4's scene and renderer, presses buttons, edits cells
in place on the face, expands and collapses contents entries, drags entries
out, makes working copies of binder templates, edits templates through a
gear, edits faces in a layout mode and actions in the inspector, shows a log
panel rendered from the log subscription with per-group undo, and adds
freehand ink and a text tool. New tables from `vtt-serve` start with a GM
binder stocked with the §8.1 example templates. Every FORMULAS §10 fixture
runs to completion in the direct runner, over the protocol, and end to end
through the UI (M5-z).

M5 builds no multiplayer rights, no template propagation ("update from
template", vtt-y1w.3), no communication in the log (vtt-y1w.5), no stepped
wizard, no per-object card backs (vtt-y1w.15), and no browser automation
(M4 decision Q16 stands).

**Epic Done-when** ("every §10 fixture passes end to end in the UI") is
carried by **M5-z** with the interpretation of Q16: the ten scenarios run
against a real in-process authority with the real React app in jsdom; every
`invoke` step is a press of the button drawn on the object's face, every
`action` expectation is read from the drawn button's enabled state, every
`set`/`override`/`clear_override` goes through the face or inspector
editors, board `move`s are canvas drags; steps with no UI gesture (`spawn`
with initial cells or `owned` bindings, `bind`, container moves with an
explicit index) go through the same session's protocol client and are
counted and listed in the report.

---

## 1. Module map and owners

No new runtime or dev dependencies are proposed (so no `npm view` checks
were needed); if a bead finds it needs one, it is a question back to the
orchestrator, pinned exactly and recorded in the decision log (CLAUDE.md).

`@vtt/formula` (pure):

| Module | Owner | Contents |
|---|---|---|
| `src/actions/step-parser.ts` | M5-a | `parseStep`, `parseAction`, `Step`, `PathNode`, `DestinationNode`, `StepParseError` |

`@vtt/schema`:

| Module | Owner | Contents |
|---|---|---|
| `src/face.ts` (new) | M5-b | `FaceLayout`, `FaceElement`, `FaceLayoutSchema`, `faceProblem`, limits, `COLLAPSED_FRAME`, `defaultFaceFrame(shape)` |
| `src/object.ts` (`SceneObject.face?`), `src/ops.ts` (`field: "face"` effect; `Rejection` gains `when_false`, `when_error`, `step_error`; `toFixtureReason`) | M5-b | additive edits |

`@vtt/authority`:

| Module | Owner | Contents |
|---|---|---|
| `store/face.ts` (new) + additive edits to `store/effects.ts`, `store/structural.ts` (spawn copies `face`, `createObject` init `face`), `store/summary.ts`, `protocol/conflicts.ts` (key `face:<object>`), `persist/canonical.ts`, `protocol/commands.ts` (`set_face`), `protocol/views.ts` (face effect view) | M5-b | `setFace` primitive and its plumbing |
| `engine/invoke.ts`, `engine/steps-value.ts` (new) | M5-c | `invokeAction`, guard, step loop and handler registry, paths, `set`/`add`/`append`/`roll`/`shuffle`/`each`, error mapping |
| `engine/steps-place.ts` (new) | M5-d | `move`, `spawn`, `remove`, destinations (`container`, `board(...)`, `beside(...)`, `table`) |
| `test/runner/*` (M2 runner), `test/scenarios.test.ts` | M5-e | `invoke` steps, `action` and `face_element` expectations, action rejections |
| `protocol/commands.ts` (invoke command), `protocol/explain.ts` (parse status), `server/router.ts` (dispatch line) | M5-f | `invoke` over the protocol |
| `protocol/views.ts` (face and action state in object views), `protocol/subscriptions.ts` (presentation candidates) | M5-g | read side |
| `mcp/invoke-tool.ts` (new), registration in `bin/mcp.ts`; `test/protocol-runner/*` invoke support | M5-h | MCP `invoke`; protocol scenario runs |
| `host/examples.ts` (new); `TableHost` option `newTable`; `bin/serve.ts` flag `--empty` | M5-q | example templates, stocked new tables |

`@vtt/protocol`:

| Module | Owner | Contents |
|---|---|---|
| `ops.ts` (`set_face`, `ObjectInit.face`), `views.ts` (`EffectView` face variant), `methods.ts` (`ProtocolRejectionSchema` new variants) | M5-b | additive |
| `methods.ts` (`InvokeParams`, `InvokeResult`, `ExplainActionResult` parse fields), `client.ts` (`invoke` is a write; `client.invoke`), `client/recovery.ts` (`invokeWithRetry`) | M5-f | additive |
| `views.ts` (`FaceView`, `FaceElementView`, `ActionView.enabled`, `reason`) | M5-g | additive |

`@vtt/fixtures`: `src/schema.ts` (setup objects gain `face`; expectation
`face_element`), `scenarios/attack-card.json` (face with show-when and its
expectations) — M5-e.

`@vtt/ui`:

| Module | Owner | Contents |
|---|---|---|
| `src/face/face-model.ts`, `face-scene.ts`, `face-hit.ts`, `face-state.ts` | M5-i | `resolveFace`, `buildFaceScene`, `faceHitAt`, `FaceStateStore` (expanded entries) |
| `src/render/face-draw.ts` | M5-j | `drawFace` registered through the renderer's item hook |
| `src/actions/invoke.ts`, `src/interaction/face-tool.ts`, `src/interaction/drop-targets.ts` | M5-k | invoke extension handler, `withFaces(tool, policy)`, drop overrides |
| `src/binder/binder-policy.ts`, `src/binder/EditTemplateBanner.tsx` | M5-l | working copies, template rules, gear |
| `src/face-editor/layout-tool.ts`, `FaceSection.tsx`, `face-ops.ts` | M5-m | layout mode and the inspector's Face section |
| `src/inspector/ActionsList.tsx` (takes over M4-k2's file after it merges), `ActionEditor.tsx`, `action-ops.ts` | M5-n | action editing and Run |
| `src/log/log-session.ts`, `sentences.ts`, `LogPanel.tsx` | M5-o | log panel |
| `src/interaction/ink-tool.ts`, `text-tool.ts` | M5-p | ink and text tools |
| `src/App.tsx`, `src/app/Toolbar.tsx`, `src/app/keybindings.ts`, `src/inspector/Inspector.tsx` (post-merge edits of M4-n and M4-k2 files) | M5-y | composition |
| `test/acceptance/fixtures-ui.test.tsx`, `ui-fixture-driver.ts` | M5-z | epic acceptance |

Docs: M5-0 only (DESIGN §4.1, §4.5–§4.8, §5.2, §7, §9, §10; FORMULAS §8;
PROTOCOL §4–§7, §9–§12; FIXTURES §6, §7, §9 Attack card, §11; CLAUDE.md
Conventions for Q21).

Every package `src/index.ts` keeps one sorted `export * from` line per
module; each bead adds its own lines (CLAUDE.md). The three new formula,
schema and authority modules follow the same rule (`engine/index.ts` for the
engine directory).

**Shared contracts and their single owners** (every other bead consumes them
unchanged):

| Contract | Owner | Consumers |
|---|---|---|
| `Step`, `PathNode`, `DestinationNode`, `parseStep`, `parseAction` | M5-a | M5-c, M5-d, M5-f (explain parse status), M5-n, M5-q |
| `FaceLayout`, `FaceElement`, `faceProblem`, frames | M5-b | M5-e, M5-g, M5-i, M5-m, M5-q |
| `Rejection` variants `when_false`/`when_error`/`step_error`, `ProtocolRejection`, `toFixtureReason` | M5-b | M5-c, M5-e, M5-f, M5-k |
| `invokeAction(table, dice, request)` and `InvokeOutcome` | M5-c (M5-d registers handlers) | M5-e, M5-f, M5-q |
| `InvokeParams`, `InvokeResult`, `client.invoke`, `invokeWithRetry` | M5-f | M5-h, M5-k |
| `FaceView`, `ActionView.enabled/reason` | M5-g | M5-i, M5-k, M5-n |
| `FaceDrawing`, `buildFaceScene`, `faceHitAt`, `FaceStateStore` | M5-i | M5-j, M5-k, M5-l, M5-m, M5-p, M5-y |
| `FacePolicy`, `withFaces`, `invokeExtension` (`InvokeOutcome` notices) | M5-k | M5-l, M5-n, M5-y |

---

## 2. Beads (as filed)

Type task, parent vtt-1xv, P1 (M5-z P2). Each section is the bead's
description as filed (bd shows ids where this text shows plan labels, and
"M5 plan decision(s) Qn" where this text says "decision(s) Qn"). Changes
from the draft, per plan-m5-decisions.md:
- M5-b states that older readers reject `face` as an unknown key, and that
  this is acceptable.
- M5-b owns the `rejections.ts` sentences (vtt-3l6.3 is treated as merged)
  and so gains the dependency on vtt-3l6.3.
- M5-f's Done-when gains the `isWrite` test. "Exclusive files" are owned by that bead alone while it runs;
"post-merge edits" touch a file another (merged) bead created, and no two M5
beads that can run concurrently make post-merge edits to the same file
(section 3 orders the ones that would).

### M5-0 — vtt-1xv.5 — Docs: M5 decisions

Implements: DESIGN.md §4.1, §4.5, §4.6, §4.7, §4.8, §5.2, §7, §9, §10;
FORMULAS.md §8; docs/PROTOCOL.md §4, §5, §6, §7.2, §7.6, §9, §10, §11, §12;
docs/FIXTURES.md §6, §7, §9 (Attack card), §11; planning bead vtt-1xv.1
(decisions Q2–Q21 as accepted); CLAUDE.md Conventions (Q21); decision beads vtt-1xv.2, vtt-1xv.3,
vtt-1xv.4 (their outcomes, Q17).

Docs only; the only M5 bead that edits docs. Exclusive files:
`docs/DESIGN.md`, `docs/FORMULAS.md`, `docs/PROTOCOL.md`, `docs/FIXTURES.md`,
`CLAUDE.md` (the orchestrator applies the CLAUDE.md edit if the implementing
agent declines).

- FORMULAS §8.2–§8.4 (Q3, Q4, Q5): the step grammar (steps are formula-syntax
  calls `set(path, expr)`, …, `roll(expr) -> path`, `each(list, step)` with
  one level, spawn records `{name: expr, …}`; a path is a bare name or an
  expression ending in `.name`; a destination is the bare word `table`,
  `board(expr, expr)`, `beside(expr)`, or any other expression evaluating to
  one reference; step names and `table`/`board`/`beside` are contextual, not
  reserved), evaluation order (object and action exist → `when` → parse every
  step → run steps in one transaction), the exact semantics and error codes of
  each step kind (Q4 table), the destinations' placement rules (Q5), limits
  (Q6), and the mapping of failures to refusals (Q7). §8.1 gains: a `when`
  that does not parse is `when_error` `#SYNTAX`; a step that does not parse is
  `step_error` `#SYNTAX`, found before any step runs.
- DESIGN §4.5 (Q7, Q12, Q13): invoking: one `action` group labelled with the
  action's name, origin `{object, action}`; the UI never invokes an action on
  a template (templates are not mutated by play); in view-as a button press
  is the GM driving that character (actor = the viewed character).
- DESIGN §4.6 (Q8, Q9, Q10, Q11): face layouts as data (the field, element
  kinds, frames and coordinates, `show_when` over cells only, `min_size` as
  the zoom input, the separate collapsed list as the collapsed input,
  `default_action`), the default face of an object without a layout (M4's
  default drawing plus a strip of buttons for its actions, and its `ink`
  cell), double-click, editor elements as drop targets for references, layout
  mode, character filtering of faces; **Ink and text** (Q19).
- DESIGN §4.7 (Q14, Q15, Q17): binders and sheets are objects on the canvas
  (no DOM binder panel); a contents element's entries are expanded and
  collapsed per viewer locally; expanding a template entry spawns a working
  copy right after it (or expands the existing one); edit-template is the
  gear; dropping onto a contents element inserts there (a template spawns a
  copy, Alt moves); card lifetime stays manual; shared templates live in the
  GM binder; example templates (Q18).
- DESIGN §4.8 (Q20): the log panel (subscription, sentences per effect, names
  at commit time, filters, link to objects, per-group undo through
  `undo {type:"group"}`, view-as filtering, paging older groups with `log`);
  the log renders from effects and `explain_group` keeps returning the current
  definition (no schema change, M3 input 3).
- DESIGN §7 Platform: the chrome list becomes "inspector, formula bar, log";
  New tables: `vtt-serve` creates a missing file stocked with the GM binder
  unless `--empty` (Q18; amends D25); §9: the three decided questions are
  removed or marked decided with a pointer to their rows; §5.2: invoking
  actions is in the MCP surface (tool `invoke`).
- PROTOCOL §4 `invoke` (Q2): params `object`, `action`, `base_revision`,
  `txn_id?`, `retry?`, `actor?` (character, non-agent only, as `transact`),
  `label?` (≤ 200), `table?: {board, position}`; result `{status:
  "committed", revision, index, created: ObjectId[]}` or `{status:
  "rejected", rejection: ProtocolRejection, step?: number}`; §5 the 20th op
  `set_face {object, face: FaceLayout | null}` (key `face:<object>`),
  `ObjectInit.face`; §6 invoke's declared keys (`obj:<object>`,
  `actions:<object>`), effect-key stale check, deduplication shared with
  `transact` (fingerprint includes the method); §7.2 `ObjectView.face`
  (present iff `cells` is `"all"` and the object has a layout) and
  `ActionView.enabled`/`reason` for every viewer, character filtering of faces
  (Q9); §7.6 the `field: "face"` effect view and its character reduction;
  §9 `explain_action` gains `when_parses`/`when_syntax_error` and per-step
  `step_status` (GM only); §10 the three rejection variants and the limits of
  Q6; §11 the `invoke` tool (18 tools; `txn_id` generated, retried as
  `transact`), `ChangeRecord.objects` facts gain `face`; §12 remove "M5 adds
  …" in favour of the now-recorded extension.
- FIXTURES §6/§7/§11: setup objects take an optional `face` (the
  `FaceLayout` encoding); expectation `face_element {object, element: number,
  list?: "full" | "collapsed", viewer?, shown: boolean}` (shown = present in
  that viewer's face view with `show_when` true); §9 Attack card: the face
  with show-when on Roll and Apply is now part of the scenario; §11 records
  both additive extensions.
- CLAUDE.md Conventions (Q21): the one exception to "`exports` maps `.` to
  `./src/index.ts`": `@vtt/authority`'s dev-only `./test-runner` subpath.
- DESIGN §4.1, §4.5 cross-references corrected (4.6 → 4.5, 4.7 → 4.6).
- Decision-log rows in DESIGN §10, dated the day of the commit, as written in
  section 4 (one per accepted question that carries a row).

Done when: each edit above is present with these names and values; the rows
exist; no code changes; `pnpm lint` and `pnpm format:check` exit 0.

Out of scope: any code; M4's docs (vtt-3l6.2 owns its rows; this bead adds
its rows after them if vtt-3l6.2 has merged, else after the M3 rows, and the
two beads must not run concurrently since both edit DESIGN §4.6 and §10).

Depends on: vtt-3l6.2 (both edit DESIGN §4.6, §7, §10 and PROTOCOL §5;
serializing avoids conflicts), vtt-5su.2 (closed).

---

### M5-a — vtt-1xv.6 — Formula: action step parser

Implements: FORMULAS.md §8.2, §8.3, §8.4 (step grammar, as written by M5-0),
§3.2 (expression syntax and limits), §2.3 (`#SYNTAX`).

Pure parsing, no evaluation. Exclusive files:
`packages/formula/src/actions/step-parser.ts`, tests
`packages/formula/test/actions/step-parser.test.ts`; its sorted line
`export * from "./actions/step-parser"` in `packages/formula/src/index.ts`.

- `parseStep(source: string): {ok: true; step: Step} | {ok: false; message:
  string; offset: number}` built on `parseExpressionPrefix` and the lexer's
  `->` token (M1, vtt-o9i): the source is one call expression whose callee is
  a bare step name, optionally followed (only for `roll`) by `->` and a path,
  then end of input.
- `Step` = `{kind: "set" | "add" | "append"; path: PathNode; value: Expr}` |
  `{kind: "roll"; dice: Expr; path: PathNode}` | `{kind: "move"; object:
  Expr; to: DestinationNode}` | `{kind: "spawn"; template: Expr; to:
  DestinationNode; cells: {name: string; value: Expr}[]}` | `{kind: "remove"
  | "shuffle"; object: Expr}` | `{kind: "each"; list: Expr; step: Step}`
  (the inner step is never `each`). `PathNode` = `{object: Expr | null; cell:
  string}` (`null` is `this`; from a `NameNode`, or a `DotNode` whose object
  is any expression). `DestinationNode` = `{type: "table"}` (bare `table`) |
  `{type: "board"; board: Expr; position: Expr}` (`board(a, b)`) | `{type:
  "beside"; object: Expr}` (`beside(a)`) | `{type: "container"; container:
  Expr}` (anything else).
- Errors (all `ok: false` with an offset): unknown step name, wrong argument
  count, a path that is not a name or `.name` access, `each` inside `each`,
  `->` on a step other than `roll` or missing on `roll`, a spawn third
  argument that is not a record, duplicate record keys, trailing input, and
  every expression parse failure (its message and offset). Expression limits
  of §3.2 apply to the whole source.
- `parseAction(def: ActionDef): {when?: ParseResult; steps: ReturnType<typeof
  parseStep>[]}` (convenience for explain and the inspector; parses `when`
  with `parse`).
- Step names and `table`, `board`, `beside` are contextual: `set + 1` is an
  ordinary expression elsewhere; a cell named `table` used as a destination is
  written `this.table`.

Done when: table-driven tests parse every step line of FORMULAS §10 (Attack,
Fireball rows and card, Draw, Shuffle, die Roll) into the expected `Step`
values; `roll(attacker.damage_dice) -> dmg`; `each(targets, spawn(save_row,
this, {target: it, owner: it.owner}))`; `move(first(deck.contents),
owner.hand)`; `spawn(t, board(gm_board, [1, 2]))`; `move(x, beside(this))`;
`move(x, table)`; `move(x, this.table)` (a container destination);
`` set(`Max HP`, 3) ``; and refusals with offsets for `roll(1d20)`,
`set(1, 2)`, `set(a)`, `each(l, each(m, remove(it)))`, `foo(a)`, `set(a, 1)
extra`, `spawn(t, this, 3)`, `spawn(t, this, {a: 1, a: 2})`, `set(a, (1`;
`pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: evaluation and execution (M5-c, M5-d); changing the expression
grammar or the lexer; storing parsed steps (actions stay source text, D20).

Depends on: M5-0.

---

### M5-b — vtt-1xv.7 — Schema, store and protocol: face layouts and action refusals

Implements: DESIGN.md §4.1 (face layout is data, copied on spawn), §4.6
(face layouts, as written by M5-0), §7 (operation records, undo keys,
replay, canonical file); FORMULAS.md §8.1 (refusals); docs/PROTOCOL.md §5
(`set_face`, `ObjectInit.face`), §6 (keys), §7.6 (face effect view), §10
(rejection variants), §12; FIXTURES.md §6 (reasons); decisions Q7, Q8, Q9.

All M5 schema changes, carried through every exhaustive switch in the repo
so the build stays green. Exclusive files: `packages/schema/src/face.ts`,
`packages/authority/src/store/face.ts`, tests
`packages/schema/test/face.test.ts`, `packages/authority/test/store/face.test.ts`,
`packages/authority/test/protocol/set-face.test.ts`,
`packages/protocol/test/face-ops.test.ts`,
`packages/schema/test/action-rejections.test.ts`; sorted index lines for the
two new modules. Post-merge additive edits: `packages/schema/src/object.ts`,
`ops.ts`; `packages/authority/src/store/effects.ts`, `structural.ts`,
`summary.ts`, `persist/canonical.ts`, `protocol/conflicts.ts`,
`protocol/commands.ts`, `protocol/views.ts` (effect conversion only);
`packages/protocol/src/ops.ts`, `views.ts` (`EffectView` only), `methods.ts`
(`ProtocolRejectionSchema` only); `packages/ui/src/values/rejections.ts`
(vtt-3l6.3, assumed merged): its `describeRejection` is an exhaustive switch
over `ProtocolRejection`, so this bead adds one sentence per new variant
there and a test case each; if vtt-5su.11 has merged, the "19 `WireOp`
kinds" assertion and the `vtt://schema/ops` snapshot in
`packages/authority/test/mcp/tools.test.ts` and `resources.test.ts` become
20.

- `FaceLayout = {elements: FaceElement[]; collapsed?: FaceElement[];
  default_action?: string}`; `FaceElement` = `{type: "value" | "editor"; cell;
  rect; show_when?; min_size?; style?}` | `{type: "button"; action; rect;
  label?; show_when?; min_size?}` | `{type: "contents"; rect; entries?:
  "collapsed" | "full"; show_when?; min_size?}`; `rect: [x, y, w, h]`
  (finite, `w`, `h` > 0) in the frame of Q8; `style = {size?: "small" |
  "normal" | "large" | "huge"; align?: "left" | "center" | "right"; caption?:
  boolean}`; zod schema strict; `faceProblem(face): string | undefined`
  (cell names per the schema cell-name rule, action names 1–100 chars,
  non-blank `show_when` ≤ 10,000 chars, `min_size` finite ≥ 0, ≤ 200
  elements per list, at most one `contents` element per list).
  `COLLAPSED_FRAME = [0, 0, 6, 0.6]`; `defaultFaceFrame(shape | null)`.
- `SceneObject.face?: FaceLayout` (absent = no layout); the file schema
  accepts it; canonical serialization orders keys as the schema does; no
  `schema_version` bump (Q8): older readers reject a file that uses `face`
  as an unknown key, which is acceptable because no released file exists.
- `setFace(tx, object, face | null)`: replaces the whole layout in one
  `{type: "field"; field: "face"; before: FaceLayout | null; after}` effect;
  refuses `invalid` for an unknown object or a `faceProblem`; touches key
  `face:<object>` (conflicts with itself and with `obj:<object>`); changes no
  readable cell; the change summary lists the object in a new `faceChanged`.
  Undo, replay and rewind handle the effect; spawn copies `face` verbatim (no
  remapping: faces name cells and actions, not objects); `createObject`
  accepts `init.face`.
- Protocol: op `set_face {object, face: FaceLayout | null}` declaring
  `face:<object>`; `ObjectInit.face`; `EffectView` `field: "face"` with GM
  views lossless and character views keeping it when the object is visible,
  reduced to each list's elements without `show_when` and without elements
  naming a cell the viewer cannot read now (D15 current visibility).
- `Rejection` gains `{type: "when_false"; object; action}`, `{type:
  "when_error"; object; action; code: ErrorCode; message?}`, `{type:
  "step_error"; object; action; step: number; code?: ErrorCode; message}`;
  `RejectionSchema`, `ProtocolRejectionSchema` and `toFixtureReason` (→
  `{type: "when_false"}`, `{type: "when_error", code}`, `{type: "step_error",
  code?}`) extended; `FixtureRejectionReason` gains the two `when_*` reasons.

Done when: schema tests accept the Attack card face of Q8 and reject each
`faceProblem` case; store tests: `setFace` writes, undoes (layout restored),
replays, conflicts with a later `setFace` and with removal, survives
`serializeTable`/`parseTable`, is copied on spawn, is refused for an unknown
object; a GM `set_face` over the protocol commits, a stale one is
`stale_write` with key `face:<object>`; the character effect view drops an
element naming a GM-only cell and strips `show_when`; `toFixtureReason` maps
each new variant; `pnpm typecheck`,
`pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: face presentation in object views and show-when evaluation
(M5-g); executing actions (M5-c); the fixture format (M5-e); MCP change
records (M5-h adds `face` to `ObjectFacts`).

Depends on: M5-0, vtt-5su.5, vtt-5su.6 (commands and views exist), vtt-3l6.19
(it edits `structural.ts`, `commands.ts` and protocol `ops.ts` too; serialize),
vtt-3l6.3 (it edits `rejections.ts`).

---

### M5-c — vtt-1xv.8 — Authority: action executor (guard, value steps, dice, each)

Implements: DESIGN.md §4.5, §7 (Transactions, operation records); FORMULAS.md
§8.1, §8.2 (paths), §8.3 (`set`, `add`, `append`, `roll`, `shuffle`, `each`),
§8.4 (as written by M5-0), §2.2 (rolls act as totals in arithmetic), §7
(budget); FIXTURES.md §5 (dice consumption is transactional), §6
(rejections); decisions Q3, Q4, Q6, Q7.

The executor core over M2's `Table`, `ActionContext`, `transactWithDice` and
primitives (vtt-75c.15). Placement steps are M5-d, which registers its
handlers here. Exclusive files: `packages/authority/src/engine/invoke.ts`,
`packages/authority/src/engine/steps-value.ts`, tests
`packages/authority/test/engine/invoke.test.ts`,
`packages/authority/test/engine/steps-value.test.ts`; sorted lines in
`packages/authority/src/engine/index.ts`.

- `invokeAction(table: Table, dice: DiceSource, req: {object; action; actor:
  Actor; label?: string; tableDestination?: {board; position}}):
  InvokeOutcome` where `InvokeOutcome` = `{ok: true; group; summary; created:
  ObjectId[]}` | `{ok: false; rejection: Rejection; step?: number}`. Order:
  object exists and has an action of exactly that name, else `invalid`;
  `when` (if any) with `table.engine.evaluate(source, {thisId})` at the
  committed revision: `true` continues, an error is `when_error` with its code
  (`#SYNTAX` when it does not parse), anything else `when_false`; then every
  step is parsed with M5-a's `parseStep` (first failure → `step_error`
  `#SYNTAX` with its index and message); then one `transactWithDice(table,
  actor, {kind: "action", label: req.label ?? action, origin: {object,
  action}}, dice, fn)`. Nothing before the transaction consumes dice.
- Step loop: an `ActionContext(table, tx)` per invocation; each expression is
  evaluated with M1's `evaluate` on that context with scope `{thisId}` (plus
  `it` inside `each`) under a fresh 20,000-unit budget per expression; a
  handler registry `registerStepHandler(kind, handler)` keyed by `Step.kind`
  (this bead registers `set`, `add`, `append`, `roll`, `shuffle`, `each`;
  M5-d registers `move`, `spawn`, `remove`; an unregistered kind is
  `step_error` "not supported").
- Paths (Q4): `PathNode.object` null → `this`; otherwise it must evaluate to
  one reference to an existing object (`empty` → `#REF`, a list or other kind
  → `#TYPE`, an error → its code).
- Semantics (Q4): `set` writes a storable value with M2's `writeValue`
  (override on a formula cell); `tag` takes a list of text via `setTag`;
  `name` takes text; `id`, `contents`, `container`, `board`, `is_zone`,
  `template`, `shape` are refused `protected_cell` (the primitive's own
  refusal where it has one). `add`: current value (read through the context:
  read-your-writes) and increment each a number, a roll (its total) or
  `empty` (0), else `#TYPE`; writes the resulting number. `append`: current
  value a list or `empty` (as `[]`), else `#TYPE`; appends the value as one
  item. `roll(dice) -> path`: the expression must be a dice value (`#TYPE`
  otherwise); `rollInto` (cause `roll`). `shuffle(ref)`: `shuffleWith` on the
  object's contents. `each(list, step)`: the list is evaluated once (a list;
  `empty` as `[]`; a single value as a one-item list, as aggregates do), then
  the inner step runs per item with `it` bound; at most 1,000 iterations.
  Any expression evaluating to an error is `step_error` with that code; a
  record where a value is needed is `#TYPE`.
- Refusal mapping (Q7): a step's evaluation error → `step_error {step, code,
  message}`; a primitive's `Rejected` inside a step keeps its type
  (`protected_cell`, `containment_cycle`, `type_error`) and the outcome
  carries `step`; a primitive's `invalid` becomes `step_error` without code
  and with the primitive's message; a `ScenarioError` from a scripted dice
  source propagates (never a refusal). `step` is the 0-based index in the
  action's step list (an `each`'s inner failure reports the `each`'s index).
- Limits (Q6): more than 10,000 primitive calls in one invocation →
  `step_error` `#LIMIT`.

Done when: unit tests over M2 `Table`s built in-test with valid documents
(objects with `ActionDef`s that pass the M2 file schema) show: the Attack
card's Roll, Roll damage and Apply against scripted dice give the cells of
FORMULAS §10 and one `action` group each with origin and label; Apply twice →
`when_false` with nothing applied and no dice consumed; a `when` of `#REF` →
`when_error` `#REF`; a `when` of `1 +` → `when_error` `#SYNTAX`; a second step
`set(1, 2)` → `step_error` `#SYNTAX` at index 1 before the first step runs;
`add(hp, "x")` → `step_error` `#TYPE`; `add` on an empty cell with a roll
increment writes the total as a number; read-your-writes (`set(a, 1)` then
`set(b, a + 1)` gives `b` 2) and a formula cell read as of action start;
`set(contents, [])` → `protected_cell` with `step` 0; a roll after a failing
step consumes no script entry (`ScriptedDiceSource.remaining()`); `each` over
a three-item list, over `empty`, over a scalar; 1,001 iterations → `#LIMIT`;
`shuffle(this)` with a scripted permutation; undo of an invocation restores
every cell (one group); `pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
`pnpm test` exit 0.

Out of scope: `move`, `spawn`, `remove`, destinations (M5-d); the protocol
(M5-f); the fixture runner (M5-e); actors other than the given one; perf
work on `ActionContext.read` (vtt-qf5.9).

Depends on: M5-a, M5-b, M5-0.

---

### M5-d — vtt-1xv.9 — Authority: placement steps and destinations

Implements: FORMULAS.md §8.2 (destinations), §8.3 (`move`, `spawn`,
`remove`), §3.1 (landing rule), §8.4 (as written by M5-0); DESIGN.md §4.1
(spawn, remove, containment), §7 Smaller decisions (the `table` destination
is resolved by M5 into a board destination); decisions Q4, Q5.

Exclusive files: `packages/authority/src/engine/steps-place.ts`, tests
`packages/authority/test/engine/steps-place.test.ts`; its sorted line in
`packages/authority/src/engine/index.ts`. Registers its handlers with M5-c's
`registerStepHandler` when the module loads (imported by `invoke.ts`'s
default registry; the bead adds that one import line to `invoke.ts`).

- Destinations: `container` → the expression must be one reference to an
  existing object (`empty` → `#REF`, list → `#TYPE`) → M2 container
  destination without index (appends); `board(b, p)` → `b` a reference to an
  existing board (an object reference or missing id → `#REF`), `p` a list of
  two finite numbers (`#TYPE` otherwise); `beside(r)` (Q5) → `r`'s outermost
  container chain must end on a board (else `step_error` "not on a board"),
  position = that board object's anchor + `[wr / 2 + wm / 2 + 0.25, 0]` where
  `wr` and `wm` are the widths of the literal footprint bounds of that
  on-board object and of the object being placed (0 when shapeless);
  `table` → `req.tableDestination` if given, else `step_error` without code,
  message "the table destination needs the invoker's board and viewport
  centre".
- `move(ref, dest)`: M2 `move` (landing rule, containment cycle refusal kept
  as `containment_cycle`). `spawn(template, dest, {cells})`: M2 `spawn`; each
  record value evaluated in the context (with `it` inside `each`) must be
  storable; the copies' ids join `InvokeOutcome.created` in creation order;
  later steps read spawned formula cells as `empty` (M2 `ActionContext`).
  `remove(ref)`: M2 `remove` (recursive); later reads of removed objects are
  `#REF`.

Done when: tests show: Fireball's Lock targets spawns one row per target in
`targets` order with `target` and `owner` set and returns them in `created`;
Discard removes the deployed zone and the card with its rows; Draw moves the
first card of the deck into the owner's hand (contents order asserted) and
fails `when_false` on an empty deck; `board(gm_board, [3, 4])` places on top
(landing rule z); `board(goblin1, [0, 0])` → `#REF`; `beside(token)` for a
token of width 1 and a die of width 0.5 places at `x + 1.0`; `beside` of a
contained object uses its outermost on-board container; `table` with and
without `tableDestination`; a move into own descendant → `containment_cycle`
with `step`; a step after `remove(x)` reading `x.hp` → `step_error` `#REF`;
`pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: the protocol (M5-f); the UI's choice of `tableDestination`
(M5-k).

Depends on: M5-c.

---

### M5-e — vtt-1xv.10 — Fixtures and direct runner: invoke, action expectations, show-when

Implements: FIXTURES.md §5, §6 (`invoke`; rejections `when_false`,
`when_error`, `step_error`), §7 (`action`; `face_element` and setup `face`
as written by M5-0), §8, §9 (all ten fixtures), §11; FORMULAS.md §10;
decisions Q9, Q16.

Completes the M2 scenario runner. Exclusive files: post-merge edits of
`packages/fixtures/src/schema.ts` (setup object `face`, expectation
`face_element`), `packages/fixtures/scenarios/attack-card.json` (adds the
FORMULAS §10 Attack card face: Roll `show_when: "roll = empty"`, Apply
`show_when: "not applied"`, and `face_element` expectations before and after
Roll and Apply), `packages/fixtures/test/format.test.ts` (cases for the new
variants), `packages/authority/test/runner/{setup,steps,expect,run}.ts`,
`packages/authority/test/scenarios.test.ts`; new test
`packages/authority/test/runner/invoke.test.ts`; new
`packages/authority/test/runner/index.ts` re-exporting `documentFromSetup`,
`runScenario`, `RunReport` and the value comparison, and the `@vtt/authority`
package.json subpath `"./test-runner": "./test/runner/index.ts"` (Q21) so
M5-z can import them (no other export changes).

- `setup.ts`: copies `face` into objects. `steps.ts`: `invoke` →
  `invokeAction` (M5-c) with the step's actor, the runner's
  `ScriptedDiceSource`; refusals follow the rejection protocol with
  `toFixtureReason` (M5-b). `expect.ts`: `action` → `explain`-equivalent
  evaluation (`table.engine.evaluate` of `when`; enabled iff absent or
  `true`); `face_element` → the element exists in that list and its
  `show_when` is absent or evaluates to `true` (GM; with a character `viewer`
  additionally its cell, if any, is readable by that viewer). The truncation
  rule is removed: every step type is supported.
- `scenarios.test.ts`: every scenario `complete` with all steps run and no
  skips, in both direct and round-trip modes.

Done when: the scenario table shows ten complete scenarios in both modes,
including leftover-dice checks; runner self-tests show an unpredicted
`when_false`, a predicted refusal that does not happen, a wrong
`face_element`, and an unused script entry each fail with scenario, step and
expectation named; `@vtt/fixtures` validates the extended attack card and
rejects a `face_element` with an unknown key; `pnpm typecheck`, `pnpm lint`,
`pnpm format:check`, `pnpm test` exit 0.

Out of scope: the protocol runner (M5-h); the UI driver (M5-z); new
scenarios beyond the attack card's face.

Depends on: M5-c, M5-d, M5-b, M5-0.

---

### M5-f — vtt-1xv.11 — Protocol and authority: `invoke` command, client retry, explain parse status

Implements: DESIGN.md §5.2 ("define and invoke actions"; writes carry their
base revision and are rejected on conflict), §7 Revisions; docs/PROTOCOL.md
§3, §4 (`invoke`), §6 (processing order, stale keys, deduplication, client
retries, `uncertain`), §9 (`explain_action`), §10 as written by M5-0;
decisions Q2, Q3, Q12.

Exclusive files: tests `packages/protocol/test/invoke.test.ts`,
`packages/authority/test/protocol/invoke.test.ts`,
`packages/authority/test/protocol/explain-parse.test.ts`,
`packages/protocol/test/invoke-retry.test.ts`; post-merge additive edits of
`packages/protocol/src/methods.ts` (`InvokeParamsSchema`,
`InvokeResultSchema` replacing `z.never()`, `ExplainActionResultSchema` parse
fields), `packages/protocol/src/client.ts` (`isWrite` includes `invoke`;
`client.invoke(params)` with `base_revision` required and a UUID `txn_id` by
default, never retrying), `packages/protocol/src/client/recovery.ts`
(`invokeWithRetry`, the same single same-session resend and `uncertain`
reasons as `transactWithRetry`, sharing its code), `packages/authority/src/
protocol/commands.ts` (the invoke command), `packages/authority/src/protocol/
explain.ts`, `packages/authority/src/server/router.ts` (the `invoke` route
line only; vtt-5su.10).

- Command processing in PROTOCOL §6's order: structural validation (schema,
  `txn_id`, `label`, `actor` allowed only for non-agent connections, `retry`
  only with `txn_id`) → deduplication lookup (store shared with `transact`,
  key `(client.instance, txn_id)`, fingerprint the canonical JSON of
  `{method: "invoke", params minus retry}`) → state validation (`actor` an
  existing character) → floor → declared keys `obj:<object>` and
  `actions:<object>` against groups after `base_revision` → `invokeAction`
  (M5-c, the host's dice source, `tableDestination` from `table`) → touched
  keys of the effects against the same groups (stale aborts with no
  randomness consumed, `transactWithDice` resets the source) → commit. The
  result is `{status: "committed", revision, index, created}` or
  `{status: "rejected", rejection, step?}` and is stored for deduplication.
  An unknown object or action is `rejected` `invalid` (never `not_found`,
  PROTOCOL §4); an object removed since `base_revision` is `stale_write`.
  The `when` guard is evaluated at the current revision, not at
  `base_revision`.
- `explain_action` (GM only): `when_parses: boolean`, `when_syntax_error?`,
  `step_status: ({ok: true} | {ok: false; message; offset})[]` from M5-a's
  `parseAction`; character results unchanged.

Done when: protocol tests round-trip params and results and reject unknown
keys, `actor` from an agent, `retry` without `txn_id`; authority tests over a
real server on port 0 with Node's `WebSocket` and `ProtocolClient`: the
Attack card's three actions commit through `invoke` with scripted dice
(`TableHost.inMemory` with a `ScriptedDiceSource`), `created` lists Lock
targets' rows, a second Apply is `rejected` `when_false`, a repeated `txn_id`
returns the stored result without consuming dice, the same `txn_id` with a
different action is `invalid` "txn_id reused…", a concurrent GM write to the
target's `damage_taken` after `base_revision` makes Apply `stale_write` (the
die script entry not consumed), an invoke with `actor` Aldric records that
actor, `invokeWithRetry` resends once after a same-session socket drop and
returns the stored result, and reports `uncertain` after a restart; the
client's `isWrite` gap is closed: an `invoke` whose socket drops after it was
sent (plain `client.invoke`, no retry) rejects `uncertain` with `details.sent:
true`, never `disconnected`, while one never sent rejects `disconnected`;
`explain_action` reports a bad step's offset; `invoke` is no longer
`unsupported`; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`
exit 0.

Out of scope: the MCP tool (M5-h); object view fields (M5-g); the UI
(M5-k).

Depends on: M5-c, M5-d, M5-b, M5-a, M5-0, vtt-5su.10, vtt-5su.5, vtt-5su.16,
vtt-5su.19, vtt-5su.7.

---

### M5-g — vtt-1xv.12 — Protocol and authority: faces and action state in object views

Implements: DESIGN.md §4.4 (presentation filtered by effective visibility),
§4.6 (face layouts, show-when, as written by M5-0); FORMULAS.md §7
(propagation), §9; docs/PROTOCOL.md §7.2, §8 (deltas), §12; decisions Q9,
Q10, Q11.

Exclusive files: tests `packages/authority/test/protocol/face-views.test.ts`,
`packages/authority/test/protocol/action-state.test.ts`,
`packages/protocol/test/face-views.test.ts`; post-merge additive edits of
`packages/protocol/src/views.ts` (`FaceView`, `FaceElementView`,
`ActionView.enabled`, `reason`), `packages/authority/src/protocol/views.ts`
(object views only), `packages/authority/src/protocol/subscriptions.ts`
(candidates only).

- `ActionView` gains `enabled: boolean` and `reason?: "when_false" |
  "when_error"` for every viewer (the `when` result, evaluated as M5-c does).
- `ObjectView.face?: FaceView` when the view's `cells` is `"all"` and the
  object has a layout: `FaceView = {elements: FaceElementView[]; collapsed?:
  FaceElementView[]; default_action?: string}`; `FaceElementView` = the
  element plus `shown: boolean` (`show_when` absent, or evaluated with
  `engine.evaluate` on the object and `true`; an error hides it and the GM
  view carries `error: ErrorCode`). GM views keep `show_when` source;
  character views drop `show_when`, drop elements whose `shown` is false,
  drop value/editor elements whose cell the viewer cannot read, and drop
  button elements naming no existing action; `default_action` is kept only if
  it names an existing action.
- Deltas (Q10): after each commit every in-scope object whose layout has a
  `show_when` or whose actions have a `when` is a candidate for re-viewing
  (views are still sent only when their canonical JSON changed), so results
  that read other objects stay current without dependency tracking.

Done when: tests with a real server and mirrors show: the Attack card's GM
view carries both buttons with `shown` and `enabled` matching FORMULAS §10
before and after each action; Aldric's view lacks `show_when` and the hidden
Apply button; a value element on the goblin's GM-only `ac` is absent from
Aldric's face view; a button whose guard reads another object's cell
(`target.hp > 0`) changes `enabled` in the delta after a commit that changes
only that other object; a `show_when` error hides the element and the GM view
has its code; a `cells: "structural"` subscription carries no `face`;
applying deltas equals a fresh subscribe (the M3 equivalence property for
these fields); `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`
exit 0.

Out of scope: drawing (M5-i, M5-j); dependency-tracked presentation
formulas (followup in section 5); the face effect view (M5-b).

Depends on: M5-b, M5-0, vtt-5su.6, vtt-5su.9.

---

### M5-h — vtt-1xv.13 — MCP `invoke` tool and fixture scenarios over the protocol

Implements: DESIGN.md §5.2 (parity: "define and invoke actions"); docs/
PROTOCOL.md §11 (tool `invoke`, change records with `face`) as written by
M5-0; decision D19 (the tool arrives with the buttons); FIXTURES.md §6, §7.

Exclusive files: `packages/authority/src/mcp/invoke-tool.ts`, tests
`packages/authority/test/mcp/invoke-tool.test.ts`; post-merge edits of
`packages/authority/src/bin/mcp.ts` (register the tool through
`createMcpServer`'s `extensions`; vtt-5su.17), `src/mcp/changes.ts`
(`ObjectFacts.face`; vtt-5su.15), the frozen tool-list snapshot and the
parity exception in `test/mcp/tools.test.ts` and `test/mcp/subscriptions.test.ts`
(the `invoke` exception removed, 18 tools), `test/protocol-runner/*.ts` and
`test/protocol-scenarios.test.ts` (vtt-5su.12: `invoke`, `action`,
`face_element` and the action refusals over the protocol).

- Tool `invoke {object, action, base_revision, label?, table?}` → protocol
  `invoke` through `invokeWithRetry` (M5-f) with a generated `txn_id`, the
  connection gate, retry within 10 s like `transact`; `rejected` →
  `isError: true` with the rejection and `step`; `uncertain` → `isError`.
  The description says actions are defined with `transact` `set_actions` and
  that `table` is the board and point the agent wants the `table`
  destination to mean.
- Protocol runner: `invoke` steps → `client.request("invoke", …)` with the
  step's actor; `action` → `explain_action` `enabled`; `face_element` →
  the viewer's `get_objects` face view; refusals mapped with
  `toFixtureReason`; the coverage table now expects every scenario complete
  over the protocol, matching the direct runner's snapshots and logs.

Done when: in-process MCP tests (vtt-5su.11's `test/mcp/support.ts`): the
tool list has 18 tools including `invoke` and the parity test has no `invoke`
exception; the agent invokes the Attack card's Roll and gets the committed
revision; a `when_false` refusal is `isError` with the rejection; a
`set_face` by the GM produces a change record whose `objects` entry shows
`face` before and after; all ten scenarios pass over the protocol with the
same final snapshot and log as the direct runner; `pnpm typecheck`,
`pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: a model in the loop; MCP prompts; the UI.

Depends on: M5-f, M5-g, M5-e, vtt-5su.11, vtt-5su.12, vtt-5su.15, vtt-5su.17.

---

### M5-i — vtt-1xv.14 — UI: face model, face scene and face hit testing

Implements: DESIGN.md §4.6 (The face, Zoom as level of detail, Face
elements, Collapsed face; default face, Ink, as written by M5-0), §4.4
(face-down objects show their back; covers above everything), §4.7 (contents
entries collapsed by default); docs/PROTOCOL.md §7.2 (`FaceView`,
`ActionView.enabled`); decisions Q8, Q9, Q11, Q19.

Pure, no canvas, no React. Exclusive files: `packages/ui/src/face/
face-model.ts`, `face-scene.ts`, `face-hit.ts`, `face-state.ts`, tests
`packages/ui/test/face/*.test.ts`; its sorted index lines.

- `FaceDrawing = {frame: Rect; bounds: Rect; primitives: FacePrimitive[]}`
  in object-local board units (origin at the anchor, y down, unrotated). `FacePrimitive` (each
  with `rect`, `minSize` in CSS px of rect height, and a `target` for hit
  testing): `text {text, tone, size, align, caption?}` (from vtt-3l6.3's
  `formatValue` compact), `image {path}` (a value element on a text `image`
  cell), `ink {strokes}` (a value element on an ink cell; strokes in
  object-local units, not scaled), `button {action, label, enabled, reason?,
  template}`, `editor {cell, text, tone}`, `entry {id, expanded, template,
  chevron: Rect, gear?: Rect, drawing: FaceDrawing | null, scale}` (nested,
  `null` for a redacted or missing entry, drawn as "hidden"), `overflow
  {count}`.
- `resolveFace(view, {views, faceState, list: "full" | "collapsed"}):
  FaceDrawing`: elements in order; `shown: false` elements skipped; the
  collapsed list defaults to one `name` value element filling
  `COLLAPSED_FRAME` (M5-b); contents entries from the `contents` cell's refs
  in order, laid out top to bottom: a collapsed entry is a row of height
  `rect.w × 0.1` (the collapsed frame scaled to the element's width minus a
  chevron square), an expanded entry the child's full face (or default face)
  scaled uniformly to that width; rows past the element's bottom are replaced
  by one `overflow` primitive; template entries get a gear.
- Default face (Q11), for an object whose view has no `face`: M4's default
  drawing stays; the drawing adds its `ink` cell (if an ink value) as an
  `ink` primitive over the frame; if it has actions, a strip of buttons
  (1.5 × 0.45 units each, 0.1 apart, 0.15 below the frame's bottom, `minSize`
  12 px); and if its `contents` is non-empty, a contents list below that
  (6 units wide, entries collapsed by default, at most 12 rows then
  `overflow`, `minSize` 12 px). `FaceDrawing` carries `bounds`, the union of
  the frame and every primitive, which is what an expanded entry scales to
  its row width (so a contained object's own strip and list are reachable
  when its entry is expanded).
- `attachFaces(scene: Scene, views, faceState): FaceScene` and
  `buildFaceScene(input, {faceState})` = vtt-3l6.5's `buildScene` then
  `attachFaces`: `FaceScene = Scene & {faces: ReadonlyMap<ObjectId,
  FaceDrawing>}`; for an item whose view has a layout, the `DrawItem`'s
  `image`, `text` and `label` are cleared (shape, fill, pattern, badges
  stay); face-down items get no face drawing.
- `faceHitAt(scene: FaceScene, point, camera): FaceHit | null`: the topmost
  item under the point (vtt-3l6.5's `hitsAt` order), the point mapped into its
  frame (inverse rotation), primitives tested last-drawn first, entries
  recursively, `minSize` honoured at the camera's zoom, nothing under a cover
  (`isCovered`). `FaceHit = {object; rect /* board-space AABB */; target:
  {type: "button"; action; enabled; reason?; template} | {type: "editor" |
  "value"; cell} | {type: "entry"; id; container} | {type: "chevron" |
  "gear"; id} | {type: "contents"; container; index /* insertion */} |
  {type: "body"}}`. The button strip of a default face is hit-testable
  outside the frame.
- `FaceStateStore` (UI-local, never written to the table): `isExpanded(id,
  entriesMode)`, `toggle(id)`, `expand(id)`, `collapse(id)`, `subscribe`.

Done when: tests on fixed views show: the Attack card face of Q8 resolves to
buttons with `enabled` from `ActionView`, the hidden Apply skipped; a value
element on `image` yields an image primitive and on an ink cell an ink
primitive; a contents element with three entries (one template, one
redacted) lays out rows, the template with a gear, the redacted one hidden;
expanding an entry scales the child face to the row width; overflow beyond
the element; a faceless die with a Roll action gets a button strip below its
frame; a faceless shapeless binder holding a card gets a contents list, and
expanding the card's entry exposes the card's own button strip; a faceless note with an `ink` cell gets its strokes; face-down items
have no face; `faceHitAt` hits a button on a rotated card, honours `minSize`
at two zooms, finds nested entries, chevrons and gears, returns an insertion
index between entries, returns null under a cover; `attachFaces` clears
`text` and `label` only for faced items; `pnpm typecheck`, `pnpm lint`,
`pnpm format:check`, `pnpm test` exit 0.

Out of scope: drawing (M5-j); interaction (M5-k); layout editing (M5-m).

Depends on: M5-g, M5-b, M5-0, vtt-3l6.5, vtt-3l6.3.

---

### M5-j — vtt-1xv.15 — UI: drawing faces

Implements: DESIGN.md §4.6 (faces, zoom thresholds; "Canvas text is weak at
small sizes, which show-when zoom thresholds already accommodate"), §4.4 and
§4.6 as amended by vtt-3l6.2 (covers above every object and object-related
overlay), §7 Platform; decisions Q1 (A3), Q8, Q19.

Exclusive files: `packages/ui/src/render/face-draw.ts`, tests
`packages/ui/test/render/face-draw.test.ts`; its sorted index line.

- `drawFace(ctx: Ctx2D, drawing: FaceDrawing, {camera, images, selection})`,
  called through vtt-3l6.6's per-item hook (Q1 A3) inside the item's
  transform, after the item's own drawing and before object-related overlays
  and covers. Text: font size = rect height × {small 0.45, normal 0.6, large
  0.8, huge 1.0}, shrunk to fit the width, single line with `…`, caption
  (`cell: `) prefix when set; buttons: rounded rect, centred label, disabled
  (and template) at 40 % alpha; editors: an inset outlined box; ink: strokes
  0.04 units wide (at least 1 device px), `#202020`, round joins; images via
  the `ImageCache` (placeholder on error); entries: chevron, gear, the child
  drawing clipped to its row and scaled; selected entries outlined;
  primitives whose rect height on screen is below `minSize` are skipped.

Done when: `RecordingContext` tests show for a scene with a faced card under
a region cover: every face call precedes the first cover fill and the
selection outline (call order); text sizes by style; a disabled button drawn
at 40 % alpha; an ink stroke drawn with the computed width at two zooms;
`minSize` culls a badge below threshold; a nested expanded entry draws its
child's primitives clipped to the row; an image primitive draws once loaded;
`pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: the face model (M5-i); hit testing (M5-i); composition (M5-y).

Depends on: M5-i, vtt-3l6.6.

---

### M5-k — vtt-1xv.16 — UI: pressing buttons, editing on the face, contents entries, drops

Implements: DESIGN.md §4.5 (buttons; the guard says why), §4.6 (Edit in
place on the face; editor elements; contents element; double-click), §4.7
(drag out; dropping onto a contents element), §7 Undo (writes carry the
revision their interaction began on), §5.2; docs/PROTOCOL.md §4 (`invoke`),
§6 (`uncertain`); M4's interaction lifecycle rules (vtt-3l6.23, plan-m4 r2
finding 8, r3 finding 1); decisions Q1, Q2, Q11, Q12, Q13, Q14.

Exclusive files: `packages/ui/src/actions/invoke.ts`,
`packages/ui/src/interaction/face-tool.ts`,
`packages/ui/src/interaction/drop-targets.ts`, tests
`packages/ui/test/actions/invoke.test.ts`,
`packages/ui/test/interaction/face-tool.test.ts`,
`packages/ui/test/interaction/face-integration.test.tsx`; its sorted index
lines.

- `invoke.ts`: `invokeExtension(session, notices)` is the runtime extension
  handler for `{type: "extension", name: "invoke", stamp, payload: {object,
  action, table, actor?}}` (Q1 A1/A2): `invokeWithRetry(session.client,
  {object, action, base_revision: stamp.baseRevision, table, actor})` (M5-f);
  `rejected` → a notice from `describeRejection` (vtt-3l6.3, extended by
  M5-b; `when_false` reads "<Action>: its condition is false" and, for the
  GM, adds `when: <source>`); `uncertain` → the sticky notice of
  vtt-3l6.21; never retried beyond `invokeWithRetry`'s single resend.
  `invokeEffect(stamp, view, action, input)` builds the effect: `table` =
  `{board: stamp.board, position: [camera.x, camera.y]}`; `actor` =
  `{type: "character", id}` when the stamp's viewer is a character (Q12).
- `FacePolicy = {onButton?, onToggle?, onGear?, onEntryDrop?}` with
  `defaultFacePolicy`; `withFaces(tool, {faceState, policy})` wraps a Tool
  (the select tool after vtt-3l6.9's `withHandles`): it computes
  `attachFaces(input.scene, input.views, faceState)` (memoized per scene)
  and, before delegating, handles:
  - pointer down + up on an enabled button within 4 px → the invoke effect
    with the stamp captured at pointer down; a disabled button → a notice with
    its reason, no request; a button on a template → the notice "Templates
    are not played: drag out a copy" (Q13);
  - single click on an editor element, double-click on a value element →
    `open_editor {stamp, object, cell, rect}` (Q1 A5) when vtt-3l6.3's
    `cellCapabilities` allows editing and the viewer is the GM; a formula
    cell focuses the formula bar (vtt-3l6.13's rule);
  - double-click on the body of an object whose face has an enabled
    `default_action` → the invoke effect; otherwise delegate (M4's in-place
    editor);
  - chevron → `policy.onToggle` (default `faceState.toggle`); gear →
    `policy.onGear` (default nothing);
  - pointer down on an entry and a drag beyond 4 px → an entry drag with a
    `drag_ghost` overlay; intent fixed at pointer down (vtt-3l6.7's rule): one
    template without Alt → spawn, otherwise move; drop on the board →
    `spawn`/`move` to `{type: "board", board: stamp.board, position}` with
    `select_created` for a spawn; drop on another object's contents element →
    into that container at the insertion index; drop on an editor element →
    `set_value {object, cell, value: ref}` and nothing moves; Escape, a board
    or viewer change cancels (no write).
- `drop-targets.ts`: `faceDropOverride(input, point, draggedIds, alt)` for
  vtt-3l6.7's drop hook (Q1 A4): one dragged object dropped on another
  object's editor element → the `set_value` ref write instead of the move;
  dropped on another object's contents element → moves (or a single
  template without Alt: a spawn) into it at the insertion index.
- Lifecycle: every write and invoke carries its stamp; a result arriving
  after a board or viewer change still shows its notice and changes neither
  selection nor tool (vtt-3l6.23's policy).

Done when: reducer tests on fixed face scenes show each gesture's effects
with stamps captured at pointer down although `input.revision` advanced;
integration (jsdom, vtt-3l6.21's helper, the real runtime and `BoardCanvas`
with a recording renderer, the Attack card spawned on the board with a face,
a goblin, scripted dice on the host): dropping the goblin token on the card's
`target` editor writes the ref and leaves the goblin in place; clicking Roll
commits through `invoke` and the face updates; clicking the hidden-then-shown
Apply twice: the second press of a now-disabled button shows the reason and
sends nothing; a stale view (Apply pressed while another client applied)
gets `when_false` from the authority and a notice; in view-as Aldric a press
records actor Aldric in the log group; a board switch during a pending invoke
shows the result notice and keeps selection; double-clicking a d20 with
`default_action` Roll rolls it; dragging a template entry out of a contents
element spawns a copy on the board, Alt-dragging moves it; dropping a card
onto another container's contents element inserts it at the index;
`pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: binder rules (working copies, gear; M5-l); layout mode (M5-m);
composition (M5-y); keyboard invocation of buttons (Polish).

Depends on: M5-i, M5-f, M5-g, vtt-3l6.7, vtt-3l6.9, vtt-3l6.13,
vtt-3l6.21, vtt-3l6.22, vtt-3l6.23, vtt-3l6.3.

---

### M5-l — vtt-1xv.17 — UI: binders, working copies and edit-template

Implements: DESIGN.md §4.7 (binder entries are templates; working copies;
edit-template; drag out), §4.1 (spawn), §8.4 steps 9, 10, 12 (as decided);
decisions Q14, Q15, Q17.

Exclusive files: `packages/ui/src/binder/binder-policy.ts`,
`packages/ui/src/binder/EditTemplateBanner.tsx`, tests
`packages/ui/test/binder/*.test.ts(x)`; its sorted index lines.

- `binderPolicy({faceState, ui})` implements M5-k's `FacePolicy`:
  - chevron on a collapsed template entry: if the same container holds a
    working copy of it (a non-template entry whose `template` cell refers to
    it), expand that copy; otherwise emit one write `spawn {template, to:
    {type: "container", container, index: templateIndex + 1}}` (base revision
    at the click) with continuations `select_created` and the extension
    continuation `expand_created` (Q1 A1/A2), run only if the stamp's board
    is still active; the template itself never expands (its face is reached
    with the gear);
  - chevron on anything else: toggle;
  - gear on a template (entry or board object): select it and show
    `<EditTemplateBanner>` ("Editing template <name>: changes apply to copies
    made from now on") until the selection changes; inspector edits are
    ordinary writes on the template.
- Discarding a working copy is the card's own Discard action or the Delete
  key (card lifetime stays manual, Q17).

Done when: integration tests (jsdom, real authority, real runtime): a binder
object on the board with an Attack card template entry: expanding it spawns
one working copy right after the template, selected and expanded; expanding
again expands that copy instead of spawning; the template's cells are
unchanged after Roll on the copy; a board switch while the spawn write is
pending still creates the copy but neither selects nor expands it; the gear selects the
template and the banner shows; dragging the working copy out moves it; a
template entry dropped on a character's binder contents spawns a copy there
(copy to binder, Q17); `pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
`pnpm test` exit 0.

Out of scope: "save to template" and propagation (vtt-y1w.3); ephemeral
cards (Q17); the inspector itself (M4); composition (M5-y).

Depends on: M5-k, M5-i, vtt-3l6.21, vtt-3l6.23.

---

### M5-m — vtt-1xv.18 — UI: layout mode and the inspector's Face section

Implements: DESIGN.md §4.6 (The inspector: "A layout mode lets the GM drag
cells onto the face"; face elements, show-when, collapsed face), §7 Undo; docs/PROTOCOL.md §5 (`set_face`), §6; decisions Q1
(A1 tool id, A3 data drop), Q8, Q9.

Exclusive files: `packages/ui/src/face-editor/layout-tool.ts`,
`FaceSection.tsx`, `face-ops.ts`, tests `packages/ui/test/face-editor/*`;
post-merge edit of `packages/ui/src/inspector/CellRow.tsx` (vtt-3l6.11):
rows become drag sources of `application/x-vtt-cell` `{object, cell}`; its
sorted index lines.

- `face-ops.ts` (pure): `addElement`, `moveElement`, `resizeElement`,
  `removeElement`, `reorderElement`, `setElementField`, `defaultLayoutFor
  (view)` ("Create face": a `name` value element across the top, one row
  per user cell with captions, one button per action) — each returns a new
  `FaceLayout` validated with M5-b's `faceProblem` (an invalid result is a
  notice and no write) and `setFaceOps(object, face) → [set_face]`.
- Tool `layout` (registered in vtt-3l6.22's registry): with exactly one
  selected board object, outlines its elements and draws `handles`
  overlays; drag an element body to move (snap 0.05 units), a handle to
  resize (minimum 0.1); Delete removes the selected element; Escape returns
  to `select`; every gesture is one `set_face` write with the whole new
  layout and the base revision captured at pointer down; a `data_drop` of
  `application/x-vtt-cell` (Q1 A3) on the selected object adds a value
  element for that cell at the drop point (2 × 0.6, clamped into the frame).
  Works in any tool for the drop, only in `layout` for moving and resizing.
- `<FaceSection session ui>` (rendered in the inspector by M5-y; GM only,
  read-only in view-as): tabs Full / Collapsed; each element with kind,
  cell or action picker, `x y w h`, `show_when` (parse-checked as typed with
  `@vtt/formula`'s `parse`; empty clears), `min_size`, style, entries mode;
  add value / editor / button / contents; up/down; delete; default action;
  "Create face" when there is none; "Remove face" (`set_face null`). Text
  fields capture the base revision on focus and write on Enter or blur
  (unchanged input writes nothing); buttons at the click.

Done when: pure tests for each op and `defaultLayoutFor`; jsdom tests with a
real authority: dragging an element moves it and one undo restores it;
resizing clamps; dropping the `hp` row onto a token adds an `hp` element;
editing `show_when` to `hp < 5` writes it and a parse error blocks the write;
a concurrent `set_face` by another client between focus and Enter yields a
`stale_write` notice and keeps the other client's face; Create face then
Remove face; the section is read-only as Aldric; `pnpm typecheck`,
`pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: editing faces of contained objects on the canvas (the Face
section edits any selected object; handles work on board objects only);
template propagation; composition (M5-y).

Depends on: M5-i, M5-b, vtt-3l6.11, vtt-3l6.21, vtt-3l6.22, vtt-3l6.23,
vtt-3l6.6.

---

### M5-n — vtt-1xv.19 — UI: action editing and Run in the inspector

Implements: DESIGN.md §4.5 ("The inspector shows an action's steps and
precondition and lets the GM edit them, exactly as it does for formulas"),
§4.6 The inspector, §5.2; FORMULAS.md §8 (step grammar); docs/PROTOCOL.md §5
(`set_actions`), §9 (`explain_action`); decisions Q3, Q13.

Takes over vtt-3l6.12's read-only `ActionsList`. Exclusive files: post-merge
rewrite of `packages/ui/src/inspector/ActionsList.tsx`; new
`packages/ui/src/inspector/ActionEditor.tsx`, `action-ops.ts`; tests
`packages/ui/test/inspector/actions-edit.test.tsx`, `action-ops.test.ts`
(vtt-3l6.12's `panel.test.tsx` assertions about read-only actions are
updated in place, one test).

- GM: each action shows name, enabled state (`ActionView.enabled`, reason),
  `when` and steps; "Edit" opens `ActionEditor` (name, `when`, one input per
  step, add/remove/reorder steps) capturing the base revision; each field is
  parse-checked as typed (`parse` for `when`, M5-a's `parseStep` for steps,
  message and caret at the offset); Save writes one `set_actions` with the
  whole list (this action replaced) unless unchanged; client-side checks
  mirror `setActions`' refusals (name 1–100 chars, unique by exact
  comparison, non-blank `when` and steps) and block the write. Add action,
  Delete, Rename, Move up/down are each one `set_actions` at the click.
- "Run" per action → M5-k's invoke effect path (`invokeEffect` through the
  runtime, or `invokeWithRetry` directly with a stamp taken at the click);
  disabled with the reason when not enabled; disabled on templates (Q13).
- Character view (view-as): names and enabled state only, no editing.

Done when: jsdom tests with a real authority: adding an action with an
invalid step shows the parse message and sends nothing; fixing it saves one
group; renaming to a duplicate is blocked; a concurrent `set_actions` by
another client between Edit and Save yields `stale_write` and keeps the
editor text; Run on the Attack card's Roll commits; Run on a disabled action
shows the reason; Run is disabled on a template; as Aldric only names and
states show; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`
exit 0.

Out of scope: autocomplete (vtt-qf5.16); a step builder UI (steps are
typed); face buttons (M5-k).

Depends on: M5-a, M5-k, M5-g, vtt-3l6.12, vtt-3l6.21.

---

### M5-o — vtt-1xv.20 — UI: log panel

Implements: DESIGN.md §4.8 (the log panel rendered from the operation
stream, sentences, filterable, links, names at the time), §4.4 (the log
filtered by current visibility), §7 Undo (any group, by index), §8.4 step 14
("Scroll the log back"); docs/PROTOCOL.md §4 (`log`, `undo` group target),
§7.6, §8 (log scope); decisions Q20; M3 input 5, M4 input 6.

Exclusive files: `packages/ui/src/log/log-session.ts`, `sentences.ts`,
`LogPanel.tsx`, tests `packages/ui/test/log/*`; its sorted index lines.

- `createLogSession(session)`: subscribes `{type: "log"}` with the current
  viewer through `session.client`; on a viewer change subscribes the new one
  before unsubscribing the old (no empty frame) and drops older pages; reads
  the mirror's window; `loadOlder()` → `log {before: oldest index, limit: 50,
  viewer, effects: true}`, appended, deduplicated by index; responses for a
  viewer or session other than the current are dropped; a `failed`
  subscription is a connection notice (vtt-3l6.21).
- `sentences.ts` (pure): `describeGroup(group: GroupView, viewer)` → a header
  (actor: "GM", the agent's name, or the character's `names` entry or id;
  `label ?? kind`; `undone`) and one sentence per effect: roll ("Rolled 1d20
  → 14 into Attack card.roll"), cell write ("Set goblin.damage_taken to 8
  (was 0)"; formula, override, clear-override and delete variants), place
  (board with position, or "into <container>"), create, remove, reorder,
  field changes (tags, shape, flags, actions, face), board changes;
  `allocate`/`retire` none. Object names from `names` (captured at commit),
  "an object" when absent; values with vtt-3l6.3's `formatValue` compact.
- `<LogPanel session ui>`: newest first; filters by actor (all, GM, agent,
  character), kind (all, actions, edits, undos) and text (names, labels);
  clicking a sentence selects the object if the current view has it, else a
  notice "no longer exists or is hidden"; GM view: "Undo" on each group that
  is neither undone nor an undo → `undo {target: {type: "group", index}}`
  (no base revision, never resent; refusals and `uncertain` as notices);
  undone groups struck through; "Load older" at the end.

Done when: pure tests render every `EffectView` variant, a character group
with `label: null` (shows kind) and missing names; jsdom tests with a real
authority: an Attack card Apply shows one group "GM: Apply" with the roll and
the `damage_taken` sentence; undoing that group from the panel restores the
cell and strikes it through; undoing an agent's group (a second client with
`kind: "agent"`) works while Ctrl+Z (`mine`) would not reach it; an undo that
conflicts shows the message; as Aldric, a group touching only GM-only cells
is absent and a mixed one has no label; "Load older" after 260 groups pages
past the 200 window; switching viewer at an unchanged revision replaces the
list without an empty frame; `pnpm typecheck`, `pnpm lint`,
`pnpm format:check`, `pnpm test` exit 0.

Out of scope: communication (vtt-y1w.5); historical action definitions (Q20);
time stamps (groups have none); composition (M5-y).

Depends on: M5-0, vtt-3l6.4, vtt-3l6.21, vtt-3l6.3, vtt-5su.20.

---

### M5-p — vtt-1xv.21 — UI: freehand ink and text tools

Implements: DESIGN.md §4.1 (ink is a cell value), §8.1 ("Freehand drawing
and text, so improvisation is cheap"), §8.4 step 6 ("Scribble … in ink on a
sticky note"), §4.6 Ink and text (as written by M5-0); docs/PROTOCOL.md §5
(`set_value` with an ink value, `create_object` with `id_base`); decisions
Q1 (A1), Q19.

Exclusive files: `packages/ui/src/interaction/ink-tool.ts`, `text-tool.ts`,
tests `packages/ui/test/interaction/ink-tool.test.ts`, `text-tool.test.ts`,
`ink-integration.test.tsx`; its sorted index lines.

- Tool `ink`: pointer down captures a stamp and the target (vtt-3l6.5's
  `hitTest` at the point: the topmost non-zone object, none under a cover);
  points are collected in board units, dropping points closer than 0.05 to
  the previous, at most 2,000 per stroke, previewed as a `polygon_draft`
  overlay; on pointer up with at least two points: on a target, the points
  in the target's object-local frame (inverse rotation about its anchor)
  appended as a new stroke to its `ink` cell (`set_value {object, cell:
  "ink", value}` with the whole new ink value; an `ink` cell holding a
  non-ink, non-empty value is a notice and no write); with no target,
  `create_object {id_base: "ink", to: {type: "board", board: stamp.board,
  position: bbox centre}, init: {shape: rect max(w, 0.25) × max(h, 0.25),
  cells: {ink, color: "transparent", name: "Ink"}}}`. The tool stays active.
- Tool `text`: a click → `create_object {id_base: "text", …, init: {shape:
  rect 4 × 1, cells: {text: "", color: "transparent", name: "Text"}}}` with
  continuations `select_created`, the extension continuation `edit_created`
  (opens the in-place editor on `text`, Q1 A1/A2) and `set_tool select`
  unless Shift was held.
- Both capture base revisions at pointer down; Escape cancels an unfinished
  stroke; a board or viewer change cancels it.

Done when: reducer tests: thinning, the 2,000-point cap, object-local
transform on a rotated note, the two write shapes, Escape; integration
(jsdom, real authority, real runtime): a stroke on a sticky note appends to
its `ink` cell and the note's face (or default face) carries the stroke
(M5-i model) and is drawn (M5-j, recording renderer); a stroke on empty
board creates an `ink_<n>` object; a concurrent write to the note's `ink`
between pointer down and up yields `stale_write`; the text tool creates a
`text_<n>` object and opens the editor; `pnpm typecheck`, `pnpm lint`,
`pnpm format:check`, `pnpm test` exit 0.

Out of scope: erasing strokes (undo, or replace the value in the inspector);
pen pressure and colours (Polish); handwriting recognition.

Depends on: M5-i, M5-j, vtt-3l6.5, vtt-3l6.13, vtt-3l6.19, vtt-3l6.21,
vtt-3l6.22, vtt-3l6.23.

---

### M5-q — vtt-1xv.22 — Authority: example templates and stocked new tables

Implements: DESIGN.md §8.1 (example templates: die, token, zone, card,
sheet, sticky note, stack, hand, binder, character, Attack, Damage and Area
Save cards; "examples, not shipped game content"), §8.4 steps 1, 2, 9, 10,
12, §4.7 (binders, per-character binder holding an Attack card), §5.3
(human-meaningful ids), §7 New tables (as amended by M5-0); FORMULAS.md §10;
decisions Q18, Q14.

Exclusive files: `packages/authority/src/host/examples.ts`, tests
`packages/authority/test/host/examples.test.ts`,
`packages/authority/test/host/stocked-table.test.ts`; its sorted index line;
post-merge additive edits: `packages/authority/src/host/table-host.ts` (an
`open` option `newTable?: () => Snapshot`, default `newTableSnapshot`;
vtt-5su.4, after vtt-3l6.25), `packages/authority/src/bin/serve.ts` (missing
files are created with `stockedTableSnapshot`; flag `--empty` keeps the
empty table; vtt-5su.14, after vtt-3l6.15).

- `exampleObjects(): Record<ObjectId, SceneObject>` and
  `stockedTableSnapshot(): Snapshot` (= `newTableSnapshot()` plus the GM
  binder `gm_binder` on `gm_board` at `[0, 0]`, tag `binder`, `visible_to`
  gm, a face with a title and a collapsed contents element, holding the
  templates). Ids are readable and never end in `_<digits>` (so spawn
  allocation cannot collide): `tpl_d20` (tags `die`, `d20`; `sides`,
  `modifier`, `value`, `total = value + modifier`; Roll; face showing `total`
  large; `default_action` Roll), `tpl_token`, `tpl_zone`, `tpl_card`,
  `tpl_sheet`, `tpl_note` (with `ink` and an ink face element), `tpl_stack`
  (`count = len(contents)`, Shuffle), `tpl_hand` (`visible_to = owner`),
  `tpl_binder` (`visible_to = owner`, collapsed contents element),
  `tpl_character` (token, `is_character`, tag `pc`, owning a sheet and a
  binder; the token's game cells read the sheet (`ac = sheet.ac`, …) and its
  `damage_taken` is a literal the sheet's `hp` reads through `owner`; the
  binder holds an Attack card template whose `attacker` and `owner` refer to
  `tpl_character`, so spawning the character remaps them), `tpl_attack`
  (FORMULAS §10 Attack card with the face of Q8), `tpl_damage` (target,
  `dmg_dice`, Roll damage, Apply, Discard), `tpl_area_save` (the Fireball
  shape with `damage_dice`, its zone `tpl_area_save_zone` in its contents,
  `save_row` referring to `tpl_save_row`, which sits beside it in the binder,
  outside its subtree), `tpl_save_row`. Every object passes the file schema;
  every formula, `when`, step and face is valid.

Done when: tests show every formula parses, every `when` and step parses
with M5-a, every face passes `faceProblem`, the snapshot passes the file
schema and `serializeTable`/`parseTable`; executor flows on a `Table` from
the stocked snapshot: spawn `tpl_d20` onto the board and Roll; spawn
`tpl_character` and find its binder's Attack card with `attacker` equal to
the new character; spawn a working copy of that card into the binder, set
`target` to a spawned goblin token, Roll, Roll damage, Apply (scripted dice);
the Area Save card's Lock targets / Roll damage / saves / Apply all with its
zone moved over two tokens; Discard; `vtt-serve` on a missing file creates
the stocked table and `--empty` an empty one (temp directory, the real
binary as vtt-5su.14's tests run it); `pnpm typecheck`, `pnpm lint`,
`pnpm format:check`, `pnpm test` exit 0.

Out of scope: system-specific content (DESIGN §8.3); template propagation;
UI behaviour (M5-k, M5-l); MCP prompts.

Depends on: M5-a, M5-b, M5-c, M5-d, M5-0, vtt-5su.4, vtt-5su.14,
vtt-3l6.25, vtt-3l6.15.

---

### M5-y — vtt-1xv.23 — UI: app composition for faces, panels and tools

Implements: DESIGN.md §7 Platform (canvas scene, DOM chrome: inspector,
formula bar, log), §4.5–§4.8 (as written by M5-0), §8.1; M4's composition
rules (vtt-3l6.17: render order objects, object overlays, covers, chrome);
decisions Q1, Q12, Q19, Q20.

Exclusive files: tests `packages/ui/test/app/m5-composition.test.tsx`;
post-merge edits of `packages/ui/src/App.tsx`, `src/app/Toolbar.tsx`,
`src/app/keybindings.ts` (vtt-3l6.17) and
`src/inspector/Inspector.tsx` (vtt-3l6.12).

- The board canvas is fed `buildFaceScene` (M5-i) with one `FaceStateStore`
  per session; the renderer is created with M5-j's `drawFace` as its item
  hook (Q1 A3); the tool registry holds `withFaces(withHandles(selectTool({
  dropOverride: faceDropOverride})), {faceState, policy: binderPolicy})`
  plus `layout` (M5-m), `ink`, `text` (M5-p); the runtime gets the
  extensions `invoke` (M5-k), `expand_created` (M5-l), `edit_created`
  (M5-p).
- Right column tabs "Inspector" / "Log" (M5-o); the inspector renders
  `EditTemplateBanner` (M5-l), M5-n's `ActionsList` and M5-m's `FaceSection`
  after the cells.
- Toolbar and keys: L layout mode, D ink, W text (none in text fields).

Done when: jsdom tests with an in-process authority (a stocked table from
M5-q, scripted dice) and a recording renderer show: the GM binder's face is
drawn with collapsed entries; dragging `tpl_d20` out spawns a die and
double-clicking it rolls; the Attack card working-copy flow from the binder
updates its face and a log entry appears in the Log tab; face calls precede
covers in a character view; L, D and W switch tools; the inspector shows
the Face section and the action editor for a selected card; the M4 app
tests still pass; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
`pnpm test` exit 0.

Out of scope: new behaviour beyond wiring; keyboard help (vtt-qf5.17).

Depends on: M5-i, M5-j, M5-k, M5-l, M5-m, M5-n, M5-o, M5-p, M5-q,
vtt-3l6.17, vtt-3l6.12, vtt-3l6.9.

---

### M5-z — vtt-1xv.24 — Epic acceptance: every §10 fixture end to end in the UI (P2)

Implements: the epic vtt-1xv Done-when ("every §10 fixture passes end to end
in the UI") as interpreted by Q16; FORMULAS.md §10; FIXTURES.md §1–§9.

Exclusive files: `packages/ui/test/acceptance/fixtures-ui.test.tsx`,
`packages/ui/test/acceptance/ui-fixture-driver.ts`.

- For each of the ten scenarios: an in-process authority over
  `documentFromSetup` (M2 runner helper, reached through the
  `@vtt/authority/test-runner` subpath that M5-e adds, Q21; `@vtt/fixtures`
  becomes a workspace devDependency of `@vtt/ui` in this bead, lockfile in
  the same commit) with a `ScriptedDiceSource` of the scenario's script; the
  real `<App>` (M5-y) in jsdom with a recording renderer. Fixture objects have
  no layouts, so their buttons and contained objects are reached through the
  default face (Q11): the button strip, and the contents list whose
  non-template entries the driver expands (UI-local state, no write; the
  driver never expands a template entry, which would spawn a working copy).
- Step mapping: `invoke` by the GM, or by a character whose view shows the
  object → view-as that character (Q12), then a click on the drawn button
  (located with `faceHitAt` on the app's face scene); `action` expectations →
  the drawn button's enabled state in the GM view; `face_element` → the drawn
  face; GM `set` and `override` → typing into the face editor when the cell
  has one, else the inspector's value cell; GM `clear_override` → the formula
  bar's Clear; GM `move` to a board point → a canvas drag (an entry drag when
  the object starts contained); `undo` → the log panel's Undo on the latest
  group. The protocol fallback (the app's own `session.client`, so the
  writes are the same connection's): `spawn` (initial `cells` and `owned`
  bindings have no gesture), `bind`, container moves with an index, any
  non-`invoke` step by a character actor (the UI edits only as the GM, M4
  decision Q14), and an `invoke` by a character who cannot see the object.
  Every other expectation is checked through `get_objects`/`log` with the
  expectation's viewer.
- The report lists, per scenario, steps run through UI gestures and steps
  run through the protocol fallback; the test asserts all ten complete with
  zero leftover dice and the fallback set exactly as the table in this bead
  (filled in by the implementer from the scenarios and reviewed).
- A manual checklist (not gating) for §8.4 steps 9–12 in a real browser is
  written into the bead and posted as a comment on vtt-1xv and vtt-nb8 on
  close (M4 decision Q16).

Done when: the acceptance test passes for all ten scenarios; `pnpm
typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: §8.4 in full (M6, vtt-nb8); browser automation; performance.

Depends on: M5-y, M5-e, M5-h, M5-q.

---

## 3. Dependency digraph

```
vtt-3l6.2, vtt-5su.2 ─► M5-0
M5-0 ─► M5-a, M5-b, M5-c, M5-e, M5-f, M5-g, M5-i, M5-o, M5-q
vtt-5su.5, vtt-5su.6, vtt-3l6.19, vtt-3l6.3 ─► M5-b
M5-a ─► M5-c, M5-f, M5-n, M5-q
M5-b ─► M5-c, M5-e, M5-f, M5-g, M5-i, M5-m, M5-q
M5-c ─► M5-d, M5-e, M5-f, M5-q
M5-d ─► M5-e, M5-f, M5-q
vtt-5su.10, vtt-5su.5, vtt-5su.16, vtt-5su.19, vtt-5su.7 ─► M5-f
vtt-5su.6, vtt-5su.9 ─► M5-g
M5-e, M5-f, M5-g ─► M5-h ◄─ vtt-5su.11, vtt-5su.12, vtt-5su.15, vtt-5su.17
M5-g ─► M5-i, M5-k, M5-n           vtt-3l6.5, vtt-3l6.3 ─► M5-i
M5-i ─► M5-j, M5-k, M5-l, M5-m, M5-p      vtt-3l6.6 ─► M5-j, M5-m
M5-f ─► M5-k ◄─ vtt-3l6.7, .9, .13, .21, .22, .23, .3
M5-k ─► M5-l, M5-n
vtt-3l6.11, .21, .22, .23 ─► M5-m        vtt-3l6.12, .21 ─► M5-n
vtt-3l6.4, .21, .3, vtt-5su.20 ─► M5-o
M5-j ─► M5-p ◄─ vtt-3l6.5, .13, .19, .21, .22, .23
vtt-5su.4, vtt-5su.14, vtt-3l6.25, vtt-3l6.15 ─► M5-q
M5-i, j, k, l, m, n, o, p, q ─► M5-y ◄─ vtt-3l6.17, vtt-3l6.12, vtt-3l6.9
M5-y, M5-e, M5-h, M5-q ─► M5-z
```

Edges recorded with `bd dep add <dependent> <blocker>` on 2026-11-05:

- M5-0 (vtt-1xv.5): vtt-3l6.2, vtt-5su.2
- M5-a (vtt-1xv.6): M5-0 (vtt-1xv.5)
- M5-b (vtt-1xv.7): M5-0 (vtt-1xv.5), vtt-5su.5, vtt-5su.6, vtt-3l6.19, vtt-3l6.3
- M5-c (vtt-1xv.8): M5-a (vtt-1xv.6), M5-b (vtt-1xv.7), M5-0 (vtt-1xv.5)
- M5-d (vtt-1xv.9): M5-c (vtt-1xv.8)
- M5-e (vtt-1xv.10): M5-c (vtt-1xv.8), M5-d (vtt-1xv.9), M5-b (vtt-1xv.7), M5-0 (vtt-1xv.5)
- M5-f (vtt-1xv.11): M5-c (vtt-1xv.8), M5-d (vtt-1xv.9), M5-b (vtt-1xv.7), M5-a (vtt-1xv.6), M5-0 (vtt-1xv.5), vtt-5su.10, vtt-5su.5, vtt-5su.16,
  vtt-5su.19, vtt-5su.7
- M5-g (vtt-1xv.12): M5-b (vtt-1xv.7), M5-0 (vtt-1xv.5), vtt-5su.6, vtt-5su.9
- M5-h (vtt-1xv.13): M5-f (vtt-1xv.11), M5-g (vtt-1xv.12), M5-e (vtt-1xv.10), vtt-5su.11, vtt-5su.12, vtt-5su.15, vtt-5su.17
- M5-i (vtt-1xv.14): M5-g (vtt-1xv.12), M5-b (vtt-1xv.7), M5-0 (vtt-1xv.5), vtt-3l6.5, vtt-3l6.3
- M5-j (vtt-1xv.15): M5-i (vtt-1xv.14), vtt-3l6.6
- M5-k (vtt-1xv.16): M5-i (vtt-1xv.14), M5-f (vtt-1xv.11), M5-g (vtt-1xv.12), vtt-3l6.7, vtt-3l6.9, vtt-3l6.13, vtt-3l6.21,
  vtt-3l6.22, vtt-3l6.23, vtt-3l6.3
- M5-l (vtt-1xv.17): M5-k (vtt-1xv.16), M5-i (vtt-1xv.14), vtt-3l6.21, vtt-3l6.23
- M5-m (vtt-1xv.18): M5-i (vtt-1xv.14), M5-b (vtt-1xv.7), vtt-3l6.11, vtt-3l6.21, vtt-3l6.22, vtt-3l6.23, vtt-3l6.6
- M5-n (vtt-1xv.19): M5-a (vtt-1xv.6), M5-k (vtt-1xv.16), M5-g (vtt-1xv.12), vtt-3l6.12, vtt-3l6.21
- M5-o (vtt-1xv.20): M5-0 (vtt-1xv.5), vtt-3l6.4, vtt-3l6.21, vtt-3l6.3, vtt-5su.20
- M5-p (vtt-1xv.21): M5-i (vtt-1xv.14), M5-j (vtt-1xv.15), vtt-3l6.5, vtt-3l6.13, vtt-3l6.19, vtt-3l6.21,
  vtt-3l6.22, vtt-3l6.23
- M5-q (vtt-1xv.22): M5-a (vtt-1xv.6), M5-b (vtt-1xv.7), M5-c (vtt-1xv.8), M5-d (vtt-1xv.9), M5-0 (vtt-1xv.5), vtt-5su.4, vtt-5su.14, vtt-3l6.25,
  vtt-3l6.15
- M5-y (vtt-1xv.23): M5-i (vtt-1xv.14), M5-j (vtt-1xv.15), M5-k (vtt-1xv.16), M5-l (vtt-1xv.17), M5-m (vtt-1xv.18), M5-n (vtt-1xv.19), M5-o (vtt-1xv.20), M5-p (vtt-1xv.21), M5-q (vtt-1xv.22), vtt-3l6.17,
  vtt-3l6.12, vtt-3l6.9
- M5-z (vtt-1xv.24): M5-y (vtt-1xv.23), M5-e (vtt-1xv.10), M5-h (vtt-1xv.13), M5-q (vtt-1xv.22)

Total: 108 edges (53 cross-epic, 55 intra-epic), all recorded; `bd dep cycles` reports none, and a script compared every bead's Depends-on paragraph with its recorded dependencies and found no mismatch. vtt-5su.2, .4, .5, .6, .7,
.9, .16, .19, .20 are closed (the edges are recorded for the record, as M4
did). Every edge stands for a real import or a file edited after its owner
merges:

- Post-merge file edits that force order (beyond imports): M5-b after
  vtt-3l6.19 (`structural.ts`, `commands.ts`, protocol `ops.ts`); M5-f and
  M5-g after M5-b (protocol `methods.ts`, `views.ts`; authority
  `commands.ts`, `protocol/views.ts`); M5-d after M5-c (`invoke.ts` import
  line); M5-h after M5-e/M5-f/M5-g and the M3 MCP and runner beads; M5-q
  after vtt-3l6.25 (`table-host.ts`) and vtt-3l6.15 (`serve.ts`); M5-n after
  vtt-3l6.12 (`ActionsList.tsx`); M5-m after vtt-3l6.11 (`CellRow.tsx`);
  M5-y after vtt-3l6.17 and vtt-3l6.12 (`App.tsx`, `Toolbar.tsx`,
  `keybindings.ts`, `Inspector.tsx`); M5-0 after vtt-3l6.2 (DESIGN §4.6,
  §7, §10, PROTOCOL §5).
- Concurrency check: no two M5 beads without a path between them edit the
  same file (checked per file in section 1 and the bead texts).
- If Q1's amendments are declined, add M5-k ─► M5-m and M5-k ─► M5-p
  (M5-k then owns the post-merge edits to the M4 contracts, runtime, select
  tool and editor, including the new tool ids), and M5-j/M5-m own the edits
  to `canvas2d.ts`/`BoardCanvas.tsx` respectively.

**Waves** (assuming M3 and M4 progress as planned; M5 UI beads wait on M4):

1. M5-0 (after vtt-3l6.2).
2. M5-a, M5-b (after vtt-3l6.19), M5-o (after vtt-3l6.4, .21, .3).
3. M5-c, M5-g.
4. M5-d, M5-i.
5. M5-e, M5-f (after vtt-5su.10), M5-j, M5-m, M5-q (after vtt-5su.14,
   vtt-3l6.25, .15).
6. M5-h (after vtt-5su.11, .12, .15, .17), M5-k (after vtt-3l6.7, .9, .13,
   .23), M5-p.
7. M5-l, M5-n.
8. M5-y (after vtt-3l6.17).
9. M5-z.

The authority half (M5-a … M5-h, M5-q) does not wait on M4's UI and can run
while M4 is implemented; only M5-0 waits on vtt-3l6.2 and M5-b on
vtt-3l6.19.

**Critical path** inside the epic: M5-0 → M5-a → M5-c → M5-d → M5-f → M5-k
→ M5-l (or M5-n) → M5-y → M5-z (nine beads). Across epics the binding
constraint is M4's composition bead vtt-3l6.17 (which itself sits at the end
of M4's graph) before M5-y, and vtt-3l6.7/.9/.13/.23 before M5-k; on the M3
side vtt-5su.10 (in progress) before M5-f, and vtt-5su.11, .12, .15, .17
before M5-h.

---

## 4. Open questions (resolved)

All accepted as proposed on 2026-11-05 (plan-m5-decisions.md); the Q1
amendments are applied to the M4 beads, Q17's three decision beads carry a
comment and close when M5-0 (vtt-1xv.5) merges, and the Q16 interpretation
is a comment on vtt-1xv. The text below is the draft as decided. Each has a proposal and an alternative; a proposed decision-log row is
given where the answer changes or adds a decision (rows are written by M5-0,
dated its commit day, numbered `M5-D<n>` as M3 did).

**Q1. Seams in M4: amend five M4 beads now.** *Proposal:* M4 has not
started, so add these small, additive contracts to the M4 bead texts before
they are worked (each with one test in that bead):

- A1 vtt-3l6.22 (contracts): `Effect` gains `{type: "extension"; name:
  string; stamp?: InteractionStamp; payload: unknown}`; `Continuation` gains
  `{type: "extension"; name: string; opIndex?: number; payload?: unknown}`
  (run in list order with the created id resolved like `select_created`);
  the `settled` outcome gains `{type: "extension"; name; result: unknown}`;
  `ToolId` gains `"layout" | "ink" | "text"`; `open_editor` gains optional
  `rect` (board-space); `InteractionEvent` gains `data_drop {mime, data,
  screen, board}`.
- A2 vtt-3l6.23 (runtime): `createInteractionRuntime({…, extensions?: {effects?:
  Record<string, (effect, ctx) => Promise<unknown> | void>; continuations?:
  Record<string, (id: ObjectId | null, payload) => void>}})`; an unknown
  extension name is a warning notice; extension effects follow the same
  lifecycle (stamp, cancellation, late results) as writes; `EditorPort.open`
  takes optional `rect`.
- A3 vtt-3l6.6 (renderer, BoardCanvas): `createCanvas2DRenderer(ctx,
  {images, drawItem?: (ctx, item, {camera, images}) => void})` called inside
  each item's transform after its own drawing, before object overlays; the
  recording test asserts the hook's calls precede covers. `BoardCanvas`
  converts drops whose `dataTransfer` has a type starting
  `application/x-vtt-` into `data_drop` events.
- A4 vtt-3l6.7 (select tool): `createSelectTool({dropOverride?: (input,
  point, draggedIds, alt) => {ops: WireOp[]; label: string} | null})`
  consulted at a move drop; a non-null result replaces the move ops.
- A5 vtt-3l6.13 (in-place editor): `open` with a `rect` positions the editor
  over that rect (instead of the object's bounds) and applies the cover rule
  to it.

No amendment is needed for vtt-3l6.5 (M5-i wraps `buildScene` and clears
`image`/`text`/`label` on faced items), vtt-3l6.21 (M5 stores are separate),
vtt-3l6.4 (M5-o subscribes the log scope on `session.client`), vtt-3l6.12
and vtt-3l6.17 (M5-n and M5-y edit their files after they merge). Note for
vtt-3l6.3: `describeRejection` is exhaustive over `ProtocolRejection`; M5-b
extends the union and adds the sentences in `rejections.ts` (vtt-3l6.3 is
treated as merged).
*Alternative:* leave M4 as filed; M5-k takes post-merge ownership of
`effects.ts`, `tool.ts`, `events.ts`, `runtime.ts`, `select-tool.ts`,
`InPlaceEditor.tsx`/`editor-port.ts`, M5-j of `canvas2d.ts`, M5-m of
`BoardCanvas.tsx`; M5-m and M5-p then depend on M5-k (section 3 note). It
works but makes M5-k larger and edits five M4 files. No row (process).

**Q2. `invoke` on the wire.** *Proposal:* params `object`, `action`,
`base_revision`, plus additive `txn_id?`, `retry?` (only with `txn_id`),
`actor?` (a character; non-agent connections only, as `transact`), `label?`
(≤ 200) and `table?: {board, position}`; result `{status: "committed",
revision, index, created: ObjectId[]}` or `{status: "rejected", rejection,
step?}`; processing order as `transact` with declared keys `obj:<object>` and
`actions:<object>` and the effect-key check; deduplication in the
`transact` store with the method in the fingerprint; the `when` guard is
evaluated at the current revision. The client treats `invoke` as a write
(`uncertain` after sending) and offers `invokeWithRetry` with the same single
same-session resend. *Alternative:* keep the M3 params (no `txn_id`: every
lost response is `uncertain`; no `actor`: the log cannot show "Aldric
attacks"; no `table`: the `table` destination always fails). Row: "M5-D1.
`invoke` takes `object`, `action`, `base_revision` and optional `txn_id`,
`retry`, `actor` (character), `label` and `table` (the board and point the
`table` destination resolves to); it declares `obj:<object>` and
`actions:<object>`, is stale-checked on its effects like `transact`, shares
`transact`'s deduplication (the method is part of the fingerprint), and
evaluates `when` at the current revision; results carry the created ids or
the refusal with its step index. PROTOCOL §4, §6. | Actions consume
randomness, so a lost response must be resendable exactly once; the log must
name the character the GM drove; the authority cannot know the GM's
viewport."

**Q3. Step syntax.** *Proposal:* a step is a formula-syntax call parsed with
M1's expression parser: `set(path, expr)`, `add`, `append`, `roll(expr) ->
path`, `move(expr, dest)`, `spawn(expr, dest, {name: expr, …})`,
`remove(expr)`, `shuffle(expr)`, `each(expr, step)` (one level). A path is a
bare name or an expression ending in `.name`. A destination is the bare word
`table`, `board(expr, expr)`, `beside(expr)`, or any other expression
yielding one reference (a container). Step names and the three destination
words are contextual, not reserved (a cell named `table` is written
`this.table` as a destination). Spawn records give values; a formula initial
cell is only possible through `transact` `spawn` (FIXTURES uses that).
*Alternative:* reserve the step names and `table` in the lexer (breaks cells
named `set`, `add`, `table`, `board` — `board` is a structural cell). Row:
"M5-D2. Action steps are formula-syntax calls parsed by `@vtt/formula`:
`set|add|append(path, expr)`, `roll(expr) -> path`, `move(expr, dest)`,
`spawn(expr, dest, {name: expr})`, `remove(expr)`, `shuffle(expr)`,
`each(expr, step)` one level; paths are names or `….name`; destinations are
`table`, `board(b, p)`, `beside(r)` or a reference; none of these words is
reserved. FORMULAS §8.4."

**Q4. Step semantics.** *Proposal:* `set` writes a storable value
(`writeValue`, override on a formula cell; `tag` through `setTag`; `id`,
`contents`, `container`, `board`, `is_zone`, `template`, `shape` refused
`protected_cell`); `add` takes a number, a roll (its total) or `empty` (0)
on each side and writes a number; `append` takes a list or `empty` and
appends the value as one item; `roll` needs a dice value; `each` iterates a
list, nothing for `empty`, a scalar as a one-item list (the aggregate rule);
an expression error is `step_error` with its code; a record is `#TYPE`.
*Alternative:* the literal reading of FORMULAS §8.3 "`#TYPE` if either side
is not a number or empty" (empty refused), rolls refused by `add` (but the
Attack card's Apply adds a roll, and FIXTURES §9 says the applied value is a
number "because `add` is"), `append` concatenating lists. Row: "M5-D3. Step
semantics: `add` treats rolls as their totals and `empty` as 0 and writes a
number; `append` appends one item to a list or `empty`; `each` over `empty`
runs nothing and over a scalar once; `set` refuses protected cells and
`shape`; expression errors abort with their code. FORMULAS §8.3."

**Q5. Destinations.** *Proposal:* `board(b, p)`: `b` a board, `p` two
finite numbers; `beside(r)`: on the board of `r`'s outermost on-board
container chain, at its anchor + `[wr/2 + wm/2 + 0.25, 0]` (literal footprint
bounds widths, 0 when shapeless), landing rule z; `table`: the invoke's
`table` param (the UI sends its active board and viewport centre), else
`step_error` "needs the invoker's board". *Alternative:* `beside` = anchor
+ `[1, 0]` (M4's Take out offset; overlaps wide objects). Row: "M5-D4.
`beside(r)` places right of `r` (or of its outermost container on a board),
touching-plus-0.25 by footprint widths; `table` resolves to the `table`
parameter of `invoke` and is a step error without it. FORMULAS §8.2; DESIGN §7
Smaller decisions."

**Q6. Limits.** *Proposal:* `each` at most 1,000 items; at most 10,000
primitive calls per invocation (`#LIMIT`); faces at most 200 elements per
list, `show_when` ≤ 10,000 chars (`max_source_length`). *Alternative:* only
the formula budget (an `each` over `objects()` spawning thousands of rows
would stall the authority). Row: "M5-D5. Limits: `max_each_items` 1,000 and
`max_action_writes` 10,000 per invocation (`#LIMIT`); `max_face_elements`
200 per list. PROTOCOL §10."

**Q7. Refusals.** *Proposal:* schema `Rejection` gains `when_false`,
`when_error {code}`, `step_error {step, code?, message}`; order: object and
action exist (`invalid`) → `when` → parse all steps (`step_error`
`#SYNTAX`) → run; a primitive refusal inside a step keeps its type
(`protected_cell`, `containment_cycle`, `type_error`→ fixture `step_error`
`#TYPE`) with the step index alongside; a primitive `invalid` becomes
`step_error`. *Alternative:* every failure inside a step is `step_error`
(simpler union, but FIXTURES §6 lists `protected_cell` and
`containment_cycle` as reasons a scenario can predict for steps, and they
would become indistinguishable). Row: "M5-D6. Action refusals: `when_false`,
`when_error` (with code; `#SYNTAX` for an unparsable guard), `step_error`
(step index, optional code; `#SYNTAX` for an unparsable step, found before
any step runs); primitive refusals inside a step keep their own type. Schema
`Rejection`; FIXTURES §6; FORMULAS §8.1."

**Q8. Face layout as an object field.** *Proposal:* `SceneObject.face?:
FaceLayout` (`elements`, optional `collapsed`, optional `default_action`),
replaced whole by `set_face` (key `face:<object>`, like `actions`), copied
verbatim on spawn, viewable in GM and filtered character views. Coordinates:
element `rect: [x, y, w, h]` in board units in the object's local frame
(origin at the anchor, y down, unrotated); the full-face frame is the
shape's bounding box (shapeless: `[-1, -0.5, 2, 1]`); the collapsed frame is
`[0, 0, 6, 0.6]` scaled to the container row. Element kinds `value`,
`editor`, `button` (optional `label`), `contents` (`entries: "collapsed" |
"full"`), each with optional `show_when` and `min_size`; `style` (size,
align, caption) for cell elements. No `schema_version` bump (an optional
field; older code rejects files that use it as an unknown key). The Attack
card face (used by M5-e's fixture and M5-q's template):

```json
{"elements": [
  {"type": "value", "cell": "name", "rect": [-1.2, -1.7, 2.4, 0.4], "style": {"size": "large"}},
  {"type": "editor", "cell": "target", "rect": [-1.2, -1.2, 2.4, 0.4], "style": {"caption": true}},
  {"type": "value", "cell": "total", "rect": [-1.2, -0.7, 1.1, 0.5], "style": {"caption": true}},
  {"type": "value", "cell": "hit", "rect": [0.1, -0.7, 1.1, 0.5], "style": {"caption": true}},
  {"type": "value", "cell": "dmg", "rect": [-1.2, -0.1, 2.4, 0.4], "style": {"caption": true}},
  {"type": "button", "action": "Roll", "rect": [-1.2, 0.5, 1.1, 0.45], "show_when": "roll = empty"},
  {"type": "button", "action": "Roll damage", "rect": [0.1, 0.5, 1.1, 0.45], "show_when": "hit and dmg = empty"},
  {"type": "button", "action": "Apply", "rect": [-1.2, 1.1, 2.4, 0.45], "show_when": "not applied"}],
 "default_action": "Roll"}
```

*Alternative:* the face as a cell with a new value kind (formula-able and
overridable, but a new value type through schema, formula, fixtures and
protocol for no fixture need), or a `schema_version` 2 with a no-op
migration. Row: "M5-D7. A face layout is an object field `face`
(`elements`, `collapsed`, `default_action`) replaced whole by `set_face`
(conflict key `face:<object>`), copied verbatim on spawn; element rects are
board units in the object's unrotated local frame (the shape's bounding box;
collapsed faces in a fixed 6 × 0.6 row frame). DESIGN §4.1, §4.6; PROTOCOL
§5, §7.2."

**Q9. Show-when inputs.** *Proposal:* `show_when` is a formula over the
object's cells only, evaluated by the authority and sent as `shown`; the
zoom input is the element's `min_size` (minimum on-screen height in CSS px,
applied by the UI); the collapsed input is the separate collapsed element
list. Character views carry no `show_when` source and omit hidden elements
and elements naming cells they cannot read. This amends the 2026-11-04 row
"Face elements: …; all with show-when conditions over cells plus
viewer-local zoom and collapsed inputs". *Alternative:* keep one formula
with `zoom` and `collapsed` names, evaluated in the UI over view values
(formulas would evaluate outside the authority, contrary to §7, and the
source would have to reach character views, contrary to D11), or by the
authority per zoom bucket (a protocol round trip per zoom change). Row:
"M5-D8. Show-when is a formula over cells evaluated by the authority and
sent as a boolean; zoom is an element's `min_size` (on-screen px) applied by
the UI; collapsed is a separate element list; character views get neither
source nor hidden elements. Amends the face-elements row of 2026-11-04.
DESIGN §4.6; PROTOCOL §7.2. | Formulas evaluate only in the authority and
their sources are GM-only; zoom changes continuously and locally."

**Q10. Keeping guard and show-when results current.** *Proposal:* after
every commit each subscription re-views every in-scope object that has a
`when` or `show_when` (deltas still carry only views that changed). Simple
and exact; cost is one ad hoc evaluation per guard per commit. *Alternative:*
dependency-tracked expressions in the formula engine (a new engine API with
its own keys, invalidated like cells) — faster on big tables, more work;
filed as a followup. Row: "M5-D9. Objects with guards or show-when are
re-viewed after every commit; dependency tracking for them is deferred.
PROTOCOL §8."

**Q11. Default face and face gestures.** *Proposal:* an object without a
layout draws M4's default and adds its `ink` cell, a strip of its action
buttons below its frame, and a collapsed list of its contents below that;
on any face: an editor element opens the in-place editor on a single click,
a value element on a double-click; a double-click elsewhere on an object
with an enabled `default_action` invokes it (else M4's edit in place);
dropping a dragged object on another object's editor element writes a
reference to it (nothing moves); dropping on a contents element inserts at
that index (one template without Alt spawns a copy there, Alt moves).
*Alternative:* no default buttons or contents (actions run only from the
inspector's Run; fixture objects then cannot be pressed in the UI without
adding faces to every scenario), and double-click always edits (step 9's
"double-clicking each to roll" would need the die's face button instead).
Row: "M5-D10. Objects without a face layout show their action buttons and
contents below them; a single click on an editor element and a double-click
on a value element edit in place; a double-click on an object with a
`default_action` invokes it; dropping an object on an editor element sets
that cell to a reference to it; dropping on a contents element inserts it
there (a single template without Alt is copied). DESIGN §4.6, §4.7."

**Q12. Buttons in view-as.** *Proposal:* a button pressed while viewing as a
character invokes with `actor` = that character (the GM driving them, as
FIXTURES §1 describes), so the log reads "Aldric: Apply"; other edits stay
the GM's and the inspector stays read-only (M4 decision Q14). *Alternative:*
buttons are disabled in view-as (M4's read-only rule extended), with
character actors only through the agent or the protocol. Row: "M5-D11. In
view-as, pressing a button invokes as the viewed character (`actor`);
other edits remain the GM's. DESIGN §4.4, §4.5."

**Q13. Templates are not played.** *Proposal:* the UI never invokes an
action on an object with `is_template` (buttons drawn disabled with the
reason, Run disabled); the agent and the protocol still can. *Alternative:*
allow it with a warning. Row: "M5-D12. The UI never invokes actions on
templates; templates change only by editing. DESIGN §4.7. | 'The template
itself is never mutated by play.'"

**Q14. Binders live on the canvas.** *Proposal:* binders, sheets and hands
are objects drawn on the canvas; their contents elements are interactive
(expand, buttons, drag out); a character's binder or sheet, owned in the
character's contents, is used on the canvas through the character's face or
default contents list and can be dragged out onto a board (a move never
changes `owner`). DESIGN §7's chrome list loses "binder". *Alternative:* a
DOM binder panel showing the viewer's binder (a second face host, and drags
between DOM and canvas for drag-out and "drop a goblin onto target"). Row:
"M5-D13. Binders are canvas objects with a contents element; there is no
DOM binder panel. DESIGN §4.7, §7. | One face renderer and one interaction
stack; drag-out and drop-onto-cell are canvas gestures."

**Q15. Working copies.** *Proposal:* expanding a template entry in any
contents element spawns a working copy right after it (index + 1) in one
write and expands and selects it; if that container already holds a
non-template entry whose `template` refers to it, that copy is expanded
instead; the template entry itself never expands (the gear shows it).
*Alternative:* the copy is made on the first button press or edit (expanding
shows the template read-only), or every expand makes a new copy. Row:
"M5-D14. Expanding a template entry makes (or reuses) a working copy right
after it and expands that copy. DESIGN §4.7. | §8.4 step 10: 'expand the
Attack card … (a working copy appears)'."

**Q16. Epic Done-when and the fixture format.** *Proposal:* M5-z as written
(ten scenarios through the real app in jsdom, invokes as button presses,
documented protocol fallback for steps with no gesture), plus the additive
fixture extensions of M5-e (setup `face`, `face_element`) with the Attack
card's face and its show-when expectations, as FORMULAS §10 and FIXTURES §9
anticipate. The interpretation is posted as a comment on vtt-1xv when
filing. *Alternative:* run the fixtures through the direct and protocol
runners only and test UI flows with hand-written integration tests (weaker
than the epic's words), or add faces to every scenario (edits all ten
files). Row (fixture format only): "M5-D15. The fixture format gains setup
`face` and the `face_element` expectation (shown in a viewer's face);
Attack card scenario asserts its show-when. FIXTURES §6, §7, §11."

**Q17. The three decision beads.** *Proposals:* (a) vtt-1xv.2 card lifetime:
manual in v1; cards are discarded by their own Discard action or Delete; no
ephemeral flag. (b) vtt-1xv.3 edit-template UI: a gear on template entries
and template objects selects the template into the inspector with an
"Editing template" banner; faces are edited in the Face section and layout
mode; no "save to template" from a working copy in v1 (propagation is
vtt-y1w.3). (c) vtt-1xv.4 shared templates: they live in the GM binder;
giving one to a character is dropping its entry onto that character's binder
(a copy is spawned there; Q11's drop rule) or a `transact` `spawn` by the
agent; no table-level binder. *Alternatives:* (a) an `ephemeral` cell
honoured by Apply; (b) right-click menu or a template-edit mode; (c) a
table-level binder everyone can read. Rows: "M5-D16. Card lifetime is manual:
cards are discarded by an action or by hand." "M5-D17. Edit-template is a
gear that selects the template for editing; no save-to-template in v1."
"M5-D18. Shared templates live in the GM binder; a copy is given by dropping
the entry on a character's binder." The orchestrator closes the three
decision beads citing M5-0's commit.

**Q18. Example templates and new tables.** *Proposal:* `vtt-serve` creates a
missing file with `stockedTableSnapshot()` (the GM binder on `gm_board`
holding the templates of M5-q) unless `--empty`; `newTableSnapshot()` stays
empty, so every existing test (M3, M4) is unchanged; the character template
owns a sheet and a binder whose Attack card template refers to the
character, so spawning remaps `attacker`; ids readable, never ending in
`_<digits>`. *Alternative:* an "Add example templates" command (UI and an
MCP prompt) on an empty table, or a separate example file to open. Row:
"M5-D19. `vtt-serve` creates new tables with a GM binder stocked with the
example templates (`--empty` for none). Amends M3-D25. DESIGN §7, §8.1,
§8.4 step 1."

**Q19. Ink and text.** *Proposal:* ink is the ordinary cell `ink` (an ink
value, strokes in object-local board units) drawn by default faces and by
value elements; one fixed pen (0.04 units, dark); the ink tool appends a
stroke to the topmost object under the pointer, or creates an `ink_<n>`
object with a transparent rect when there is none; the text tool creates a
`text_<n>` transparent rect with an empty `text` and opens the editor.
*Alternative:* every stroke is its own object (simpler, but "scrawl in the
margin travels with the object" needs the stroke on the object), or pen
colours now. Row: "M5-D20. Ink is the cell `ink` in object-local units; the
ink tool draws onto the object under the pointer or creates an ink object;
the text tool creates a text object. DESIGN §4.1, §4.6, §8.1."

**Q20. Log panel.** *Proposal:* the panel renders sentences from the log
window's group views (with effects) and pages older groups with `log`; it
offers per-group undo (`undo {type: "group"}`), which is how the GM undoes
an agent's group (Ctrl+Z stays `mine`); no change to the group schema to
record action definitions at commit time (M3 input 3: the log shows resolved
effects, which DESIGN §4.5 asks for, and `explain_group` keeps returning the
current definition). *Alternative:* store each action group's definition
(schema and file change) so the log can show steps as written. Row: "M5-D21.
The log panel renders resolved effects as sentences, filters by actor, kind
and text, and undoes any group by index; action definitions are not recorded
in groups. DESIGN §4.8."

**Q21. Test helpers across packages.** *Proposal:* M5-e adds
`packages/authority/test/runner/index.ts` and the package subpath
`"./test-runner"` so M5-z imports `@vtt/authority/test-runner` (dev-only;
`@vtt/ui` already dev-depends on `@vtt/authority`); M5-z adds `@vtt/fixtures`
as a `@vtt/ui` devDependency. CLAUDE.md's exports convention gains this one
exception (M5-0 writes it; the orchestrator applies it if the agent
declines). *Alternative:* a relative import of
`../../authority/test/runner/…` from the UI test (resolves in Vitest but
typechecks authority test code under the UI's tsconfig and dependencies).
Row: "M5-D22. `@vtt/authority` exposes its scenario runner helpers at the
dev-only subpath `./test-runner`. CLAUDE.md Conventions."

**Q22. Bead count.** *Proposal:* 20 beads (19 P1, M5-z P2), two over the
preferred range, because the authority, formula and protocol half (9 beads) and the UI half
(10 beads) each split along exclusive files and real dependencies.
*Alternative merges* to reach 18: M5-l into M5-k (the policy and banner are
small but M5-k grows), and M5-h's protocol-runner part into M5-e (M5-e then
waits for M5-f and vtt-5su.12). No row.

---

## 5. Followups (filed)

Filed 2026-11-05 under vtt-qf5 (P3) and vtt-y1w (P4), each with its
dependencies recorded:
  - vtt-qf5.25 Formula and authority: dependency-tracked guard and show-when expressions
  - vtt-qf5.26 UI: keyboard access to face buttons and contents entries
  - vtt-qf5.27 UI: ink pen colours, widths and an eraser
  - vtt-qf5.28 UI: scrolling and grid or fan layouts in contents elements
  - vtt-qf5.29 UI: number formatting options on face value elements
  - vtt-qf5.30 UI: layout-mode handles on expanded contained entries
  - vtt-qf5.31 UI: show a guard's value while editing an action
  - vtt-y1w.16 Cards: ephemeral cards that discard themselves once applied
  - vtt-y1w.17 Log: record action definitions in action groups
  - vtt-y1w.18 UI: DOM binder panel
- Comments: vtt-y1w.3 (save to template), vtt-qf5.9 (priority note),
  vtt-1xv (Q16), vtt-1xv.2/.3/.4 (Q17), vtt-nb8 and vtt-nb8.1 (inputs from
  the M5 plan).

Original list:

- Polish (vtt-qf5): dependency-tracked guard and show-when expressions in
  the formula engine, replacing M5-g's per-commit rescan (Q10); keyboard
  access to face buttons and entries; pen colours, widths and an eraser
  (Q19); scrolling and grid or fan layouts in contents elements (hands);
  number formatting options on value elements (FORMULAS §11 "Text
  formatting"); layout-mode handles on contained (expanded) entries;
  dry-run of a guard while editing an action (show `when`'s value as typed).
  vtt-qf5.9 (`ActionContext.read` clones the summary per read) becomes
  relevant once actions run over the wire; raise its priority if the
  Fireball flow profiles slow.
- Later (vtt-y1w): "save to template" from a working copy, joining
  vtt-y1w.3 (comment there); ephemeral cards if play asks (Q17a); recording
  action definitions in groups (Q20); a DOM binder panel if the canvas
  binder proves awkward in M6 (Q14).
- M6 inputs (comment on vtt-nb8): M5-z's manual checklist for §8.4 steps
  9–12 is the user's first real-browser run of actions; stocked new tables
  make step 1 literal (Q18); step 5's agent can now press buttons through
  the `invoke` tool; step 14's "scroll the log back" is the log panel's
  "Load older".
- Epic comment on vtt-1xv: the Q16 interpretation of the Done-when.
- Decision beads vtt-1xv.2, .3, .4: closed with M5-0's commit (Q17).

---

## Contradictions and underspecification found

1. DESIGN §4.1 cross-references are off by one: "Actions. Named lists of
   steps (see 4.6)" should be 4.5, "Face layout … See 4.7" should be 4.6,
   and §4.5's "show-when (4.7)" should be 4.6. M5-0 fixes them.
2. DESIGN §7 lists the binder among DOM chrome, while §8.4 step 1 puts the
   GM binder on the GM board and §4.7 makes binders containers → Q14.
3. The 2026-11-04 face-elements row (show-when over cells plus viewer-local
   zoom and collapsed inputs) conflicts with §7 (formulas evaluate only in
   the authority) and D11 (no formula source in character views) → Q9.
4. FORMULAS §8.3 `add` ("`#TYPE` if either side is not a number or empty")
   is ambiguous about `empty`, and silent about rolls although the Attack
   card's Apply adds a roll and FIXTURES §9 expects a number → Q4.
5. FORMULAS §8.2's `table` destination depends on the GM's viewport, but
   PROTOCOL's `invoke` has no parameter for it; `beside(ref)` has no
   placement rule → Q2, Q5.
6. PROTOCOL `invoke` has no `actor` (FIXTURES invoke steps carry actors and
   §8.4 step 10 is "Aldric attacks") and no `txn_id` (actions consume
   randomness; DESIGN §7 allows one same-session resend only with
   deduplication) → Q2. The client's `isWrite` covers only `transact` and
   `undo` (packages/protocol/src/client.ts:179), so an `invoke` lost after
   sending would wrongly fail `disconnected` → M5-f.
7. Schema `Rejection` lacks the action reasons FIXTURES §7 lists
   (`FixtureRejectionReason`'s comment says they "arrive with M5"); FIXTURES
   §6 lists `protected_cell` and `containment_cycle` among step refusals
   without saying whether an action reports them or `step_error` → Q7.
8. No schema field holds a face layout; FIXTURES §9 (Attack card) and §11
   defer show-when in the format to M5 → Q8, Q16.
9. §4.7 says using a binder card "acts on a working copy" without saying
   when the copy is made; §8.4 step 10 makes it on expand → Q15.
10. §8.4 step 9 rolls dice by double-clicking, but M4 (vtt-3l6.7) makes
    double-click edit in place → `default_action`, Q11.
11. §8.4 step 10 "drop a goblin onto `target`" names a gesture no doc
    defines → Q11 (drop onto an editor element).
12. M3-D25 creates new tables empty; §8.4 step 1 expects a stocked GM binder
    → Q18.
13. The epic's Done-when ("every §10 fixture passes end to end in the UI")
    meets fixtures that have no faces, place binders without shapes, and use
    `spawn` with initial cells, `owned` bindings and `bind`, none of which
    has a UI gesture → Q16, Q11 (default face), M5-z's fallback list.
14. The brief mentions a UI testing convention "added by M4" in CLAUDE.md;
    it is not there yet: vtt-3l6.2 (M4-0) adds it and has not merged. M5's
    UI beads follow M4 decision Q16 (node for pure logic, recording context
    for the renderer, jsdom with an injected renderer, a real in-process
    authority for integration, no browser automation); M5-0 depends on
    vtt-3l6.2, so the convention is in CLAUDE.md before any M5 UI bead runs.
15. M3 input 3 (action definition as of commit time) → Q20, no schema
    change. M3 input 2 (explain_action step parse status) → M5-f.
16. PROTOCOL §5/§11, vtt-5su.11's tests and the `vtt://schema/ops` resource
    say 19 `WireOp` kinds and 17 tools; M5 makes them 20 and 18 (M5-b,
    M5-h). The D6 and D17 rows keep their historical counts; M5-D7 and the
    M5-0 PROTOCOL edits state the new ones.
17. FORMULAS §8.3 says spawn initial cells "may be literals or formulas",
    but a step's record can only give evaluated values → Q3 (formulas only
    through `transact` `spawn`).
18. D19 ties the MCP `invoke` tool to the UI's buttons; in this plan M5-h
    can merge before the buttons (M5-k). Parity holds at the epic's close;
    if the orchestrator wants them in lockstep, add M5-h ─► M5-y or make
    M5-h depend on M5-k.
