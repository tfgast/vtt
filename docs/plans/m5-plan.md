# Plan: M5 Faces, actions, binders, log, ink (epic vtt-1xv)

Plan for the planning bead vtt-1xv.1. Filed on 2026-11-05 after the
orchestrator's decisions (plan-m5-decisions.md: every Q1–Q22 proposal
accepted). Plan labels map to filed ids: M5-0 vtt-1xv.5, M5-a vtt-1xv.6, M5-b vtt-1xv.7, M5-c vtt-1xv.8, M5-d vtt-1xv.9, M5-e vtt-1xv.10, M5-f vtt-1xv.11, M5-g vtt-1xv.12, M5-h vtt-1xv.13, M5-i vtt-1xv.14, M5-j vtt-1xv.15, M5-k vtt-1xv.16, M5-l vtt-1xv.17, M5-m vtt-1xv.18, M5-n vtt-1xv.19, M5-o vtt-1xv.20, M5-p vtt-1xv.21, M5-q vtt-1xv.22, M5-y vtt-1xv.23, M5-z vtt-1xv.24; M5-k2 vtt-1xv.25 (split from M5-k in review r1); M5-i2 vtt-1xv.26 and M5-m2 vtt-1xv.27 (split from M5-i and M5-m in review r2); M5-b0 vtt-1xv.28 (split from M5-b in review r3). Section 2 holds the filed
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
| `src/action-limits.ts` (new); `Rejection` variants and `toFixtureReason` in `src/ops.ts` | M5-b0 (r3) | `MAX_EACH_ITEMS`, `MAX_ACTION_WRITES`, `MAX_FACE_ELEMENTS`; action refusals |
| `src/face.ts` (new) | M5-b | `FaceLayout`, `FaceElement`, `FaceLayoutSchema`, `faceProblem`, limits, `COLLAPSED_FRAME`, `defaultFaceFrame(shape)` |
| `src/object.ts` (`SceneObject.face?`), `src/ops.ts` (`field: "face"` effect; `Rejection` gains `when_false`, `when_error`, `step_error`; `toFixtureReason`) | M5-b | additive edits |

`@vtt/authority`:

| Module | Owner | Contents |
|---|---|---|
| `store/face.ts` (new) + additive edits to `store/effects.ts`, `store/structural.ts` (spawn copies `face`, `createObject` init `face`), `store/summary.ts`, `protocol/conflicts.ts` (key `face:<object>`), `persist/canonical.ts`, `protocol/commands.ts` (`set_face`), `protocol/views.ts` (face effect view) | M5-b | `setFace` primitive and its plumbing |
| `engine/invoke.ts`, `engine/steps-value.ts` (new) | M5-c | `StepHandler`/`StepContext`, `createExecutor` (`runAction`, `invokeAction`), `coreHandlers`, error mapping (r2) |
| `engine/steps-place.ts` (new) | M5-d | `placementHandlers` (`move`, `spawn`, `remove`, destinations) |
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
| `src/face/face-contracts.ts`, `face-state.ts`, `face-model.ts`, `face-transform.ts`; export `drawItemFor` from `src/scene/scene.ts` (post-merge) | M5-i | contracts (`FaceHit`, `FacePolicy` with `canInvoke`, `FaceGesture`, `WithFacesOptions`), `FaceStateStore` (expansion, scroll), `resolveFace` with nested `base` drawings, transforms, `screenHeight`, `revealOffset`, `presentationBounds` (r2) |
| `src/face/face-scene.ts`, `face-hit.ts` | M5-i2 (r2) | `attachFaces`, `buildFaceScene`, `faceCullBounds`, `faceHitAt` |
| `src/render/face-draw.ts` | M5-j | `drawFaceItem` (the renderer's `drawItem` hook), `drawFace` (base via `paintItem`, then primitives) |
| `src/actions/invoke.ts`, `src/interaction/face-tool.ts`; `Tool.wheel` in vtt-3l6.22's `tool.ts`/`machine.ts` (post-merge) | M5-k | invoke extension handler, `requestInvoke`, `defaultFacePolicy`, `withFaces` (buttons, inline editing, default action, wheel scrolling) |
| `src/interaction/entry-drag.ts`, `src/interaction/drop-targets.ts` | M5-k2 (r1) | `entryDragGesture`, `faceDropOverride` (reference drops, container insertion) |
| `src/binder/binder-policy.ts`, `src/binder/EditTemplateBanner.tsx` | M5-l | working copies, template rules, gear |
| `src/face-editor/face-ops.ts`, `FaceSection.tsx` | M5-m | pure layout operations, the inspector's Face section |
| `src/face-editor/layout-tool.ts`, `cell-drop.ts`; `CellRow.tsx` drag source (post-merge) | M5-m2 (r2) | canvas layout tool, `cellDropHandler` |
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
| `FaceLayout`, `FaceElement`, `faceProblem`, frames; `ActionDefinitionView`; `ObjectSnapshotView.face` (r1) | M5-b | M5-e, M5-g, M5-i, M5-m, M5-q |
| `Rejection` variants `when_false`/`when_error`/`step_error`, `ProtocolRejection`, `toFixtureReason`, `ActionDefinitionView`, advertised action and face limits | M5-b0 (r3) | M5-c, M5-e, M5-f, M5-k |
| `runAction(tx, ctx, request)` (caller-owned transaction, r1), `invokeAction(table, dice, request)`, `InvokeOutcome` | M5-c (M5-d registers handlers) | M5-e, M5-f, M5-q |
| `InvokeParams`, `InvokeResult`, `client.invoke`, `invokeWithRetry` | M5-f | M5-h, M5-k |
| `FaceView`, `FaceElementView.index`, `ActionStateView`, `ObjectView.action_states` (r1) | M5-g | M5-i, M5-k, M5-n |
| `FaceDrawing`, `buildFaceScene`, `faceCullBounds`, `faceHitAt`, `FaceStateStore`, `FacePolicy`, `FaceGesture`, `WithFacesOptions` | M5-i | M5-j, M5-k, M5-k2, M5-l, M5-m, M5-p, M5-y |
| `withFaces`, `defaultFacePolicy`, `invokeExtension` | M5-k | M5-k2, M5-l, M5-n, M5-y |
| `entryDragGesture`, `faceDropOverride` | M5-k2 | M5-l, M5-y |
| `cellDropHandler` | M5-m2 | M5-y |
| `faceElementVisible` | M5-g | M5-e, live views |
| `FaceLayoutView` | M5-b | M5-g, log consumers |

---

## 2. Beads (as filed, revised after review r3)

Type task, parent vtt-1xv, P1 (M5-z P2). Each section below is the bead's
current description, copied verbatim from bd after review r3 (final) (so the texts
use ids, and the headings give each id's plan label). See "Review r1
changes" and "Review r2 changes" and "Review r3 changes" after section 3. Changes from the draft at filing, per
plan-m5-decisions.md:
- M5-b states that older readers reject `face` as an unknown key, and that
  this is acceptable.
- M5-b owns the `rejections.ts` sentences (vtt-3l6.3 is treated as merged)
  and so gains the dependency on vtt-3l6.3.
- M5-f's Done-when gains the `isWrite` test.

"Exclusive files" are owned by that bead alone while it runs; "post-merge
edits" touch a file another (merged) bead created, and no two M5 beads that
can run concurrently make post-merge edits to the same file (section 3
orders the ones that would).

### M5-0 — vtt-1xv.5 — Docs: M5 decisions

Implements: DESIGN.md §4.1, §4.5, §4.6, §4.7, §4.8, §5.2, §7, §9, §10;
FORMULAS.md §8; docs/PROTOCOL.md §4, §5, §6, §7.2, §7.6, §9, §10, §11, §12;
docs/FIXTURES.md §6, §7, §9 (Attack card), §11; CLAUDE.md Conventions; the
decisions of planning bead vtt-1xv.1 (docs/plans/m5-plan.md §4, Q1–Q22, all
accepted; review r1 findings 1, 3, 5, 7, 15; review r2 findings 1, 2, 3, 5,
10; review r3 findings 1–4, 6–8) and decision beads vtt-1xv.2,
vtt-1xv.3, vtt-1xv.4 (resolved in planning; this bead is the sole owner of
recording their outcomes, rows M5-D16–M5-D18; the orchestrator closes them
when this bead merges). Everything this bead writes is in this text; the plan
is cited only for background.

Docs only; the only M5 bead that edits docs. Exclusive files:
`docs/DESIGN.md`, `docs/FORMULAS.md`, `docs/PROTOCOL.md`, `docs/FIXTURES.md`,
`CLAUDE.md` (the orchestrator applies the CLAUDE.md edit if the implementing
agent declines). DESIGN §4.6 and §10 already hold M4's text and rows
(vtt-3l6.2, merged); add after them.

**1. FORMULAS §8 (actions).** §8.1 gains the evaluation order: the object
must exist and have an action of exactly that name (else the refusal
`invalid`); `when` is evaluated with `this` = the object at the current
revision: `true` runs, an error (`#SYNTAX` when it does not parse) refuses
`when_error` with its code, any other value refuses `when_false`; then every
step is parsed, and the first that does not parse refuses `step_error`
`#SYNTAX` with its 0-based index before any step runs; then the steps run in
order in one transaction. New §8.4 **Step syntax**, a step-level grammar:

```
step  := name "(" args ")" [ "->" path ]        -- "->" only after roll, required there
set(path, expr)   add(path, expr)   append(path, expr)   roll(expr) -> path
move(expr, dest)  spawn(expr, dest [, record])  remove(expr)  shuffle(expr)
each(expr, step)                                 -- the second argument is parsed as a step
path  := a bare name | an expression ending in ".name"   (`this` when bare)
dest  := table | board(expr, expr) | beside(expr) | expr (a container reference)
record:= "{" name ":" expr ("," name ":" expr)* "}"
```

Each `expr` argument is parsed with the expression parser in prefix mode
(it stops at `,` `)` or `->`); `->` is step syntax and never an expression
operator; `each`'s second argument is parsed recursively as a step, which
may not be `each` (one level), so `each(targets, roll(1d20) ->
it.save_roll)` is valid. The expression limits of §3.2 apply to the whole
step source. Step names and `table`, `board`, `beside` are contextual, not
reserved: a cell named `table` used as a destination is written
`this.table`. A spawn record gives evaluated values; a formula initial cell
is possible only through the protocol's `spawn` op.

§8.3 gains the semantics table (Q4):

| Step | Accepts | Writes | Errors |
|---|---|---|---|
| `set(path, v)` | any storable value | `writeValue` (an override on a formula cell); `tag` takes a list of text via `setTag`; `name` takes text | `id`, `contents`, `container`, `board`, `is_zone`, `template`, `shape` → `protected_cell`; a record → `#TYPE` |
| `add(path, v)` | current value and `v` each a number, a roll (its total) or `empty` (0) | the resulting number | anything else `#TYPE` |
| `append(path, v)` | current value a list or `empty` (as `[]`) | the list with `v` appended as one item | other current value `#TYPE` |
| `roll(d) -> path` | a dice value | the roll result (cause `roll`) | not dice `#TYPE` |
| `shuffle(r)` | one reference | its contents reordered by a drawn permutation | |
| `move(r, dest)` | one reference | M2 `move`, landing rule | `containment_cycle` |
| `spawn(t, dest, rec)` | one reference; record values storable | M2 `spawn` with the record as initial cells | record value an error → its code |
| `remove(r)` | one reference | recursive removal; later reads `#REF` | |
| `each(list, step)` | a list; `empty` runs nothing; a scalar runs once (the aggregate rule) | the inner step per item with `it` bound; the list is evaluated once before running | more than 1,000 items `#LIMIT` |

Every path's object part must evaluate to one reference to an existing
object (`empty` → `#REF`, a list or other kind → `#TYPE`, an error → its
code); any expression evaluating to an error refuses `step_error` with that
code. Destinations (Q5): a container destination is one reference
(`empty` → `#REF`, a list → `#TYPE`) and appends; `board(b, p)` needs `b`
a board (else `#REF`) and `p` two finite numbers (else `#TYPE`);
`beside(r)` places on the board of `r`'s outermost on-board container chain
(else `step_error` "not on a board") at that object's anchor + `[wr/2 +
wm/2 + 0.25, 0]` where `wr`, `wm` are the widths of the literal footprint
bounds of that object and of the placed object (0 when shapeless);
`table` resolves to the invoke's `table` parameter and without it is
`step_error` (no code) "the table destination needs the invoker's board and
viewport centre". Limits (Q6): at most 1,000 `each` items and 10,000
primitive calls per invocation (`#LIMIT`). Refusals (Q7): an evaluation
error is `step_error {step, code, message}`; a primitive's own refusal
inside a step keeps its type (`protected_cell`, `containment_cycle`,
`type_error`) with the step index alongside; a primitive's `invalid` becomes
`step_error` without code; the index of a failure inside `each` is the
`each`'s. An action is one `action` group labelled with its name (or the
invoke's `label`), origin `{object, action}`.

**2. DESIGN.**
- §4.1, §4.5: cross-references corrected ("see 4.6" → 4.5 for actions,
  "See 4.7" → 4.6 for face layout, "show-when (4.7)" → 4.6).
- §4.5: the UI never invokes an action on a template (templates are not
  mutated by play; the agent may); in view-as a button press is the GM
  driving that character (actor = the viewed character); a disabled button
  sends nothing and shows the reason.
- §4.6 **Face layouts** (Q8, Q9, Q11): the encoding of section 3 below;
  `show_when` is a formula over the object's cells only, evaluated by the
  authority and sent as a boolean; the zoom input is `min_size` (minimum
  on-screen height of the element's rect in CSS px, applied by the UI); the
  collapsed input is the separate collapsed list; character views get
  neither `show_when` source nor hidden elements nor elements naming cells
  they cannot read. **Default face**: an object without a layout draws the
  M4 default (DESIGN §4.6 "Default rendering until faces") plus its `ink`
  cell, a strip of its action buttons below its frame, and a collapsed list
  of its contents below that; a template object on a board also shows a
  gear. **Gestures**: a single click on an editor element and a double-click
  on a value element edit in place; a double-click elsewhere on an object
  with an enabled `default_action` invokes it (else M4's edit in place);
  dropping an object on another object's editor element sets that cell to a
  reference to it (nothing moves); dropping on a contents element inserts
  there (copy-versus-move is the intent fixed at drag start, M4-D8), except
  that dropping a template onto a binder's contents element gives a template
  (section 2, §4.7); contents elements scroll: a per-session, never-stored
  scroll offset per (object, element), changed by the wheel over the element
  (before any camera zoom), clipped to the element's rect; an entry expanded
  near the bottom is scrolled into view (the whole row when it fits, else
  its top aligned with the list's top); the wheel scrolls the innermost
  enclosing list that overflows; a collapsed entry shows its collapsed face
  (its own `collapsed` list, else its `name`), an expanded contained object
  is drawn exactly as on a board (its base drawing: shape, fill, image,
  text, label, face-down back, then its face), each scaled into its row;
  clicking a row (or an expanded child's empty area) selects that contained
  object for the inspector; a drop resolves, in order, to an editor element
  under the pointer, else the innermost contents element under it (at the
  row's index, or the end), else the board; a cell
  dragged from the inspector onto an object adds a value element (layout
  mode). **Ink and text** (Q19): ink is the cell `ink` (strokes in
  object-local board units, origin at the anchor, y down, unrotated) drawn
  with one fixed pen (0.04 units, dark); the ink tool appends a stroke to the
  topmost object under the pointer or creates an `ink_<n>` object (a
  transparent rect); the text tool creates a `text_<n>` transparent rect
  with an empty `text` and opens the editor.
- §4.7 (Q14, Q15, Q17): binders, sheets and hands are canvas objects with a
  contents element; there is no DOM binder panel; a character's binder or
  sheet is used through the character's face or default contents list or
  dragged out onto a board; contents entries are expanded and collapsed per
  session locally; expanding a template entry spawns a working copy right
  after it (index + 1) and expands and selects it, or expands an existing
  non-template entry of that container whose `template` refers to it; the
  template entry itself never expands; edit-template is the gear (it selects
  the template for editing with an "Editing template" banner; no "save to
  template" in v1); card lifetime is manual (Discard actions or Delete);
  shared templates live in the GM binder. A **binder** is an object whose
  `tag` contains `"binder"`. Dropping a template (an entry or a board
  template) onto a binder's contents element **gives a template**: one
  `transact` `[spawn {template, to: {type: "container", container: binder,
  index}, as: "$copy"}, set_template_flag {object: "$copy", value: true}]`,
  so the recipient holds a reusable template (copy-versus-move intent is
  ignored for this drop; Alt held at drag start moves the template instead);
  dropping onto any other contents element copies an instance (Q11). The
  example templates of section 4 below.
- §4.8 (Q20): the log panel renders the log window's group views as one
  header and one sentence per effect, names as captured at commit, filters
  by actor, kind and text, links sentences to live objects, undoes any group
  by index (`undo {type: "group"}`; Ctrl+Z stays `mine`), pages older groups
  with `log`, reloads loaded pages when visibility or undone state may have
  changed, and is filtered by the viewer; action definitions are not
  recorded in groups (`explain_group` keeps returning the current one).
- §7 Platform: the chrome list becomes "inspector, formula bar, log". §7 New
  tables: `vtt-serve` creates a missing file with the GM binder stocked
  (`--empty` for none); amends D25. §5.2: invoking actions is in the MCP
  surface (tool `invoke`). §9: card lifetime, shared templates and
  edit-template UI are marked decided with pointers to M5-D16–M5-D18.

**3. Face encoding (Q8)** (DESIGN §4.6, PROTOCOL §5, FIXTURES §3):
`SceneObject.face?: FaceLayout`, `FaceLayout = {elements: FaceElement[];
collapsed?: FaceElement[]; default_action?: string}`; `FaceElement` =
`{type: "value" | "editor"; cell; rect; show_when?; min_size?; style?}` |
`{type: "button"; action; rect; label?; show_when?; min_size?}` | `{type:
"contents"; rect; entries?: "collapsed" | "full"; show_when?; min_size?}`;
`rect: [x, y, w, h]` finite, `w`, `h` > 0, in board units in the object's
unrotated local frame (origin at the anchor, y down); the full-face frame is
the shape's bounding box (shapeless: `[-1, -0.5, 2, 1]`); the collapsed
frame is `[0, 0, 6, 0.6]`, scaled to the container row; `style = {size?:
"small" | "normal" | "large" | "huge"; align?: "left" | "center" | "right";
caption?: boolean}`; at most 200 elements per list and one `contents`
element per list; `show_when` non-blank, at most 10,000 characters; the
whole layout is replaced by `set_face` (conflict key `face:<object>`),
copied verbatim on spawn, carried in create/remove snapshots; absent means
no layout; no `schema_version` change. The Attack card face:

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

**4. Example templates (Q18)** — complete records; vtt-1xv.22 copies them
verbatim and may choose nothing else. Notation: `shape` (frames: a rect w ×
h has frame `[-w/2, -h/2, w, h]`, a circle r `[-r, -r, 2r, 2r]`); `tag`;
flags; cells (`name: literal`, `name = formula`; `""` is empty text, `empty`
the empty value, `@id` a reference); actions (`Name [when]: steps`, steps
separated by ` ; `); face elements as `kind cell|action [x, y, w, h]` with
options (`L` style size large, `H` huge, `C` caption, `m=N` min_size N px,
`sw="…"` show_when); `default_action`. Every record not marked otherwise
is a template (`is_template: true`) with default `visible_to`. Ids never end
in `_<digits>`.

- `gm_binder` (not a template; on `gm_board` at `[0, 0]`): rect 7 × 10; tag
  binder; `name: "GM binder"`, `visible_to: [gm]` (viewers); face: `value
  name [-3.3, -4.8, 6.6, 0.6] L`, `contents [-3.3, -4.0, 6.6, 8.8]` (entries
  collapsed). Contents in this order: `tpl_character`, `tpl_attack`,
  `tpl_damage`, `tpl_area_save`, `tpl_save_row`, `tpl_token`, `tpl_zone`,
  `tpl_card`, `tpl_note`, `tpl_sheet`, `tpl_hand`, `tpl_binder`,
  `tpl_stack`, `tpl_d20` (the last is directly playable through a working
  copy, which the scrolling tests use).
- `tpl_d20`: circle r 0.5; tag die, d20; `name: "d20"`, `sides: 20`,
  `modifier: empty`, `value: empty`, `total = value + modifier`; `Roll:
  roll(1d20) -> value`; face `value total [-0.4, -0.35, 0.8, 0.5] H`,
  `button Roll [-0.4, 0.18, 0.8, 0.25] m=10`; `default_action: "Roll"`.
- `tpl_token`: circle r 0.5; tag creature; `name: "Token"`, `image: ""`,
  `ac: empty`, `max_hp: empty`, `damage_taken: 0`, `hp = max_hp -
  damage_taken`; face `value image [-0.5, -0.5, 1, 1]`, `value name [-0.8,
  0.55, 1.6, 0.3] m=12`, `value hp [0.2, -0.6, 0.5, 0.3] m=12`.
- `tpl_zone`: rect 4 × 4, `is_zone`; `name: "Zone"`; no face.
- `tpl_card`: rect 2.5 × 3.5; `name: "Card"`, `title: ""`, `body: ""`; face
  `editor title [-1.15, -1.65, 2.3, 0.5] L`, `editor body [-1.15, -1.05,
  2.3, 2.7]`.
- `tpl_note`: rect 2 × 2; `name: "Note"`, `color: "#fff3a0"`, `text: ""`,
  `ink: empty`; face `value ink [-1, -1, 2, 2]`, `editor text [-0.9, -0.9,
  1.8, 0.6]`.
- `tpl_sheet`: rect 6 × 8; `name: "Sheet"`, `owner: empty`, `ac: empty`,
  `max_hp: empty`, `hp = max_hp - owner.damage_taken`, `attack_bonus:
  empty`, `damage_dice: 1d8`, `dex_save: empty`, `spell_dc: empty`, `notes:
  ""`, `ink: empty`; face `editor name [-2.8, -3.8, 5.6, 0.6] L`, then
  `C m=12` elements `editor ac [-2.8, -3.0, 2.7, 0.5]`, `editor max_hp [0.1,
  -3.0, 2.7, 0.5]`, `value hp [-2.8, -2.4, 2.7, 0.5]`, `editor attack_bonus
  [0.1, -2.4, 2.7, 0.5]`, `editor damage_dice [-2.8, -1.8, 2.7, 0.5]`,
  `editor dex_save [0.1, -1.8, 2.7, 0.5]`, `editor spell_dc [-2.8, -1.2,
  2.7, 0.5]`, then `editor notes [-2.8, -0.6, 5.6, 2.4]`, `value ink [-2.8,
  1.9, 5.6, 1.9]`.
- `tpl_stack`: rect 2.5 × 3.5; `name: "Stack"`, `count = len(contents)`;
  `Shuffle: shuffle(this)`; face `value name [-1.15, -1.65, 2.3, 0.5] L`,
  `value count [-1.15, -1.0, 2.3, 0.8] H C`, `button Shuffle [-1.15, 1.1,
  2.3, 0.5]`.
- `tpl_hand`: rect 6 × 2; tag hand; `name: "Hand"`, `owner: empty`,
  `visible_to = owner`; face `value name [-2.9, -0.95, 5.8, 0.35]`,
  `contents [-2.9, -0.55, 5.8, 1.5]` (entries collapsed).
- `tpl_binder`: rect 7 × 10; tag binder; `name: "Binder"`, `owner: empty`,
  `visible_to = owner`; face as `gm_binder`'s.
- `tpl_character`: circle r 0.5; `is_character`; tag pc, creature; `name:
  "Character"`, `image: ""`, `sheet: @tpl_character_sheet`, `damage_taken:
  0`, `ac = sheet.ac`, `hp = sheet.hp`, `attack_bonus =
  sheet.attack_bonus`, `damage_dice = sheet.damage_dice`, `dex_save =
  sheet.dex_save`, `spell_dc = sheet.spell_dc`; contents
  `tpl_character_sheet`, `tpl_character_binder`; face `value image [-0.5,
  -0.5, 1, 1]`, `value name [-0.8, 0.55, 1.6, 0.3] m=12`, `value hp [0.2,
  -0.6, 0.5, 0.3] m=12`, `contents [-1.5, 0.9, 3, 1.2] m=24` (entries
  collapsed).
  - `tpl_character_sheet` (**not** a template): `tpl_sheet`'s record with
    `owner: @tpl_character`.
  - `tpl_character_binder` (**not** a template): `tpl_binder`'s record with
    `owner: @tpl_character`; contents `tpl_character_attack`.
  - `tpl_character_attack` (template): `tpl_attack`'s record with
    `attacker: @tpl_character`, `owner: @tpl_character`. Spawning the
    character remaps all three references to the new character.
- `tpl_attack`: rect 2.5 × 3.5; `name: "Attack"`, `owner: empty`, `attacker:
  empty`, `target: empty`, `roll: empty`, `dmg: empty`, `applied: false`,
  `bonus = attacker.attack_bonus`, `total = roll + bonus`, `hit = roll !=
  empty and total >= target.ac`; `Roll [target != empty and roll = empty]:
  roll(1d20) -> roll`; `Roll damage [hit and dmg = empty]:
  roll(attacker.damage_dice) -> dmg`; `Apply [hit and dmg != empty and not
  applied]: add(target.damage_taken, dmg) ; set(applied, true)`; `Discard:
  remove(this)`; face: the Attack card face of section 3.
- `tpl_damage`: rect 2.5 × 3.5; `name: "Damage"`, `target: empty`,
  `dmg_dice: 1d6`, `dmg: empty`, `applied: false`; `Roll damage [target !=
  empty and dmg = empty]: roll(dmg_dice) -> dmg`; `Apply [dmg != empty and
  not applied]: add(target.damage_taken, dmg) ; set(applied, true)`;
  `Discard: remove(this)`; face `value name [-1.2, -1.7, 2.4, 0.4] L`,
  `editor target [-1.2, -1.2, 2.4, 0.4] C`, `editor dmg_dice [-1.2, -0.7,
  2.4, 0.4] C`, `value dmg [-1.2, -0.2, 2.4, 0.5] C`, `button "Roll damage"
  [-1.2, 0.5, 2.4, 0.45] sw="dmg = empty"`, `button Apply [-1.2, 1.1, 2.4,
  0.45] sw="not applied"`.
- `tpl_area_save`: rect 2.5 × 3.5; contents `tpl_area_save_zone`; `name:
  "Area save"`, `caster: empty`, `zone: @tpl_area_save_zone`, `save_row:
  @tpl_save_row`, `dc = caster.spell_dc`, `damage_dice: 8d6`, `damage:
  empty`, `locked: false`, `applied: false`, `targets =
  contents(zone).where(tag has "creature")`, `rows = contents.where(tag has
  "save_row")`; `Lock targets [not locked]: each(targets, spawn(save_row,
  this, {target: it, owner: it.owner})) ; set(locked, true)`; `Roll damage
  [locked and damage = empty]: roll(damage_dice) -> damage`; `Apply all
  [locked and damage != empty and all(rows.save_roll != empty) and not
  applied]: each(rows, add(it.target.damage_taken, it.damage_dealt)) ;
  set(applied, true)`; `Discard: remove(zone) ; remove(this)`; face `value
  name [-1.2, -1.7, 2.4, 0.4] L`, `editor caster [-1.2, -1.25, 1.15, 0.35]
  C`, `value dc [0.05, -1.25, 1.15, 0.35] C`, `value damage [-1.2, -0.85,
  2.4, 0.35] C`, `contents [-1.2, -0.45, 2.4, 1.4]` (entries collapsed),
  `button "Lock targets" [-1.2, 1.0, 1.15, 0.35] sw="not locked"`, `button
  "Roll damage" [0.05, 1.0, 1.15, 0.35] sw="locked and damage = empty"`,
  `button "Apply all" [-1.2, 1.4, 1.15, 0.3] sw="not applied"`, `button
  Discard [0.05, 1.4, 1.15, 0.3]`. **Caster initialization:** `caster` is
  `empty` in the GM binder and in every copy made from it (spawning keeps
  external references and an empty value stays empty); the GM sets it by
  dropping the caster's token on the `caster` editor (Q11). Until then `dc`
  is `empty` and the save rows' Roll save is disabled by `card.caster !=
  empty` in its guard. A copy given into a character's binder keeps `caster`
  empty (no inference).
  - `tpl_area_save_zone` (**not** a template): circle r 2, `is_zone`;
    `name: "Area"`.
- `tpl_save_row` (beside `tpl_area_save` in the binder, outside its
  subtree): rect 2.5 × 0.8; tag save_row; `name: "Save"`, `owner: empty`,
  `target: empty`, `save_roll: empty`, `card = container`, `save_bonus =
  target.dex_save`, `passed = save_roll + save_bonus >= card.dc`,
  `damage_dealt = if(passed, floor(card.damage / 2), card.damage)`; `Roll
  save [save_roll = empty and card.caster != empty]: roll(1d20) ->
  save_roll`; face `value target [-1.2, -0.35, 1.0, 0.3]`, `value save_roll
  [-0.15, -0.35, 0.6, 0.3]`, `value passed [0.5, -0.35, 0.7, 0.3]`, `button
  "Roll save" [-1.2, 0.05, 2.4, 0.3] sw="save_roll = empty"`.

These are examples, not game content.

**5. PROTOCOL.**
- §4 `invoke`: params `object`, `action`, `base_revision`, `txn_id?`,
  `retry?` (only with `txn_id`), `actor?` (character, non-agent only),
  `label?` (≤ 200), `table?: {board, position}`; result `{status:
  "committed", revision, index, created: ObjectId[]}` or `{status:
  "rejected", rejection: ProtocolRejection, step?: number}`. §6: processing
  order as `transact`; declared keys `obj:<object>`, `actions:<object>`; the
  action runs inside the command's transaction and its touched keys are
  checked before commit (a stale invoke consumes no randomness); the `when`
  guard is evaluated at the current revision; deduplication in the
  `transact` store, fingerprint including the method.
- §5: the 20th op `set_face {object, face: FaceLayout | null}` (key
  `face:<object>`); `ObjectInit.face`.
- §7.2: `ActionDefinitionView` (the existing `ActionView` shape: `name`,
  and for the GM `when` and `steps`), used in object views, field effects
  and snapshots; `ObjectView.action_states: ActionStateView[]` (`{name,
  enabled, reason?: "when_false" | "when_error"}`, every viewer, one per
  action in order) in live object views only; `ObjectView.face?: FaceView`
  when `cells` is `"all"` and the object has a layout: elements carry
  `index` (position in the stored list) and `shown`; the GM view keeps every
  element with its `show_when`, `shown: false` with a `reason`
  (`show_when_false`, `show_when_error` with its `error` code, or
  `no_action` for a button naming no action) when hidden; character views
  keep only elements that are shown and whose cell they can read, without
  `show_when`, keeping `index`. An element is visible to a viewer exactly
  when it is present in that viewer's view with `shown: true`.
- §7.6: the `field: "face"` effect view and `ObjectSnapshotView.face` use the
  wire type `FaceLayoutView` (the layout with `index` on every element and no
  live `shown`; `FaceLayout` stays the storage type): GM lossless;
  characters keep it when the object is visible now, without `show_when` and
  without elements naming cells unreadable now (so a removed object's
  snapshot is omitted from a character's view until an undo restores it).
- §8 Evaluation: objects with a `when` or `show_when`, and objects whose
  face changed, are re-viewed after every commit.
- §9 `explain_action`: GM-only `when_parses`, `when_syntax_error?`,
  `step_status: ({ok: true} | {ok: false; message; offset})[]`.
- §10: rejections `when_false {object, action}`, `when_error {object,
  action, code, message?}`, `step_error {object, action, step, code?,
  message}`; limits `max_each_items` 1,000, `max_action_writes` 10,000,
  `max_face_elements` 200, in the §10 table and the `limits` the `welcome`
  message advertises (§2).
- §11: tool `invoke {object, action, base_revision, label?, table?}`
  (`txn_id` generated, retried as `transact`; refusals `isError` with the
  rejection and `step`); the request-surface server has 15 tools (14 plus
  `invoke`) and the composed `vtt-mcp` process 19 (adding `subscribe`,
  `poll_changes`, `unsubscribe`, `import_asset`); `ChangeRecord` object
  facts gain `face`. §12: replace "M5 adds …" by the recorded extensions.

**6. FIXTURES.** §3/§6: setup objects take an optional `face` (the encoding
of section 3). §7: expectation `face_element {object, element: number,
list?: "full" | "collapsed", viewer?, shown: boolean}`, where `element` is
the index in the stored list and `shown` means present in that viewer's
face view with `show_when` true. §9 Attack card: the face of section 3 is
part of the scenario, with its show-when asserted. §11 records both
extensions.

**7. CLAUDE.md Conventions** (Q21): the one exception to "`exports` maps
`.` to `./src/index.ts`": `@vtt/authority`'s dev-only `./test-runner`
subpath (scenario runner helpers for other packages' tests).

**8. Decision log.** DESIGN §10 gains these rows verbatim, with the commit
date in the first column; the 2026-11-04 row "Face elements: value, editor,
button, contents; all with show-when conditions over cells plus
viewer-local zoom and collapsed inputs." gets " Amended by M5-D8." appended
to its decision text:

| Date | Decision | Rationale |
|---|---|---|
| <commit date> | M5-D1. `invoke` takes `object`, `action`, `base_revision` and optional `txn_id`, `retry`, `actor` (character), `label` and `table` (the board and point the `table` destination resolves to); it declares `obj:<object>` and `actions:<object>`, is stale-checked on its effects like `transact`, shares `transact`'s deduplication (the method is part of the fingerprint), and evaluates `when` at the current revision; results carry the created ids or the refusal with its step index; the command runs the action inside its own transaction (`runAction`) and checks stale keys before commit. PROTOCOL §4, §6. | Actions consume randomness, so a lost response must be resendable exactly once; the log must name the character the GM drove; the authority cannot know the GM's viewport. |
| <commit date> | M5-D2. Action steps have a step-level grammar in `@vtt/formula`: `set(path, expr)`, `add(path, expr)`, `append(path, expr)`, `roll(expr) -> path`, `move(expr, dest)`, `spawn(expr, dest, {name: expr})`, `remove(expr)`, `shuffle(expr)`, `each(expr, step)` whose second argument is parsed recursively as a step (one level); expression arguments are parsed with the expression parser's prefix mode and `->` is step syntax, never an expression operator; paths are names or `….name`; destinations are `table`, `board(b, p)`, `beside(r)` or a reference; none of these words is reserved. FORMULAS §8.4. | Steps reuse the one expression grammar; reserving words would break cells named `board` or `table`. |
| <commit date> | M5-D3. Step semantics: `add` treats rolls as their totals and `empty` as 0 and writes a number; `append` appends one item to a list or `empty`; `each` over `empty` runs nothing and over a scalar once; `set` refuses protected cells and `shape`; expression errors abort with their code. FORMULAS §8.3. | FORMULAS §8.3 was ambiguous about `empty`, and the Attack card's Apply adds a roll. |
| <commit date> | M5-D4. `beside(r)` places right of `r` (or of its outermost container on a board), touching-plus-0.25 by footprint widths; `table` resolves to the `table` parameter of `invoke` and is a step error without it. FORMULAS §8.2; DESIGN §7 Smaller decisions. | The authority cannot know the GM's viewport; `beside` had no placement rule. |
| <commit date> | M5-D5. Limits: `max_each_items` 1,000 and `max_action_writes` 10,000 per invocation (`#LIMIT`); `max_face_elements` 200 per list. PROTOCOL §10. | A runaway `each` over `objects()` must not stall the table. |
| <commit date> | M5-D6. Action refusals: `when_false`, `when_error` (with code; `#SYNTAX` for an unparsable guard), `step_error` (step index, optional code; `#SYNTAX` for an unparsable step, found before any step runs); primitive refusals inside a step keep their own type. Schema `Rejection`; FIXTURES §6; FORMULAS §8.1. | FIXTURES §6 predicts these reasons; primitive reasons stay distinguishable. |
| <commit date> | M5-D7. A face layout is an object field `face` (`elements`, `collapsed`, `default_action`) replaced whole by `set_face` (conflict key `face:<object>`), copied verbatim on spawn and carried in create/remove snapshots; element rects are board units in the object's unrotated local frame (the shape's bounding box; collapsed faces in a fixed 6 × 0.6 row frame). DESIGN §4.1, §4.6; PROTOCOL §5, §7.2. | Faces are data like actions: one effect per edit, an exact undo, no new value type. |
| <commit date> | M5-D8. Show-when is a formula over cells evaluated by the authority and sent as a boolean; zoom is an element's `min_size` (on-screen px) applied by the UI; collapsed is a separate element list; character views get neither source nor hidden elements. Amends the face-elements row of 2026-11-04. DESIGN §4.6; PROTOCOL §7.2. | Formulas evaluate only in the authority and their sources are GM-only; zoom changes continuously and locally. |
| <commit date> | M5-D9. Objects with guards or show-when are re-viewed after every commit; dependency tracking for them is deferred. PROTOCOL §8. | Simple and exact; tracked expressions are a Polish optimization (vtt-qf5.25). |
| <commit date> | M5-D10. Objects without a face layout show their action buttons and contents below them; contents elements scroll per session (never stored); an expanded contained object is drawn as on a board, scaled into its row; a single click on an editor element and a double-click on a value element edit in place; a double-click on an object with a `default_action` invokes it; dropping an object on an editor element sets that cell to a reference to it; dropping on a contents element inserts it there (a single template without Alt is copied). DESIGN §4.6, §4.7. | Actions and contents must be reachable without authoring a face; §8.4 steps 9 and 10 name these gestures. |
| <commit date> | M5-D11. In view-as, pressing a button invokes as the viewed character (`actor`); other edits remain the GM's. DESIGN §4.4, §4.5. | FIXTURES §1: a character actor is the GM driving that character, and the log records it. |
| <commit date> | M5-D12. The UI never invokes actions on templates; templates change only by editing. DESIGN §4.7. | The template itself is never mutated by play.. |
| <commit date> | M5-D13. Binders are canvas objects with a contents element; there is no DOM binder panel. DESIGN §4.7, §7. | One face renderer and one interaction stack; drag-out and drop-onto-cell are canvas gestures. |
| <commit date> | M5-D14. Expanding a template entry makes (or reuses) a working copy right after it and expands that copy. DESIGN §4.7. | §8.4 step 10: 'expand the Attack card … (a working copy appears). |
| <commit date> | M5-D15. The fixture format gains setup `face` and the `face_element` expectation (shown in a viewer's face); Attack card scenario asserts its show-when. FIXTURES §6, §7, §11. | FORMULAS §10 and FIXTURES §9 anticipate show-when in the format. |
| <commit date> | M5-D16. Card lifetime is manual: cards are discarded by an action or by hand. | DESIGN §9 leaned manual; nothing in v1 needs automation here. |
| <commit date> | M5-D17. Edit-template is a gear that selects the template for editing; no save-to-template in v1. | The least surprising affordance; propagation is vtt-y1w.3. |
| <commit date> | M5-D18. Shared templates live in the GM binder. A binder is an object tagged `binder`; dropping a template onto a binder's contents element gives a template (one `transact`: `spawn` as `$copy`, then `set_template_flag` `$copy` true), while dropping onto any other contents element copies an instance. | The recipient must hold a reusable template that makes working copies; one atomic group keeps undo whole. |
| <commit date> | M5-D19. `vtt-serve` creates new tables with a GM binder stocked with the example templates (`--empty` for none). Amends M3-D25. DESIGN §7, §8.1, §8.4 step 1. | §8.4 step 1 expects a stocked GM binder; tests keep the empty table. |
| <commit date> | M5-D20. Ink is the cell `ink` in object-local units; the ink tool draws onto the object under the pointer or creates an ink object; the text tool creates a text object. DESIGN §4.1, §4.6, §8.1. | Scrawl in the margin travels with the object' (DESIGN §4.1). |
| <commit date> | M5-D21. The log panel renders resolved effects as sentences, filters by actor, kind and text, and undoes any group by index; action definitions are not recorded in groups. DESIGN §4.8. | The log is the record of resolved effects (§4.5, §4.8); recording definitions would be a schema change. |
| <commit date> | M5-D22. `@vtt/authority` exposes its scenario runner helpers at the dev-only subpath `./test-runner`. CLAUDE.md Conventions. | The UI acceptance test needs the runner's setup helper without duplicating it. |
| <commit date> | M5-D23. Object views carry action definitions (`ActionDefinitionView`: name, and for the GM `when` and steps; also used in effects and snapshots) and, separately, live action state (`ActionStateView`: name, enabled, reason) only in live views; face element views carry `index`, their position in the stored layout, which the fixture `face_element.element` names. PROTOCOL §7.2, §7.6; FIXTURES §7. | Historical effects must not need live evaluation; character filtering must not renumber elements. |
| <commit date> | M5-D24. MCP tools: the request-surface server has 15 tools (14 plus `invoke`); the composed `vtt-mcp` process has 19 (with `subscribe`, `poll_changes`, `unsubscribe` and `import_asset`). PROTOCOL §11. | `import_asset` (M4-D3) already exists; counting the composed process avoids deleting it. |

Done when: each edit above is present with these names and values; the 24
rows exist verbatim with the commit date and the 2026-11-04 row carries its
amendment note; no code changes; `pnpm lint` and `pnpm format:check` exit 0.

Out of scope: any code; M4's rows and text (already merged).

Depends on: vtt-3l6.2, vtt-5su.2.

---

### M5-a — vtt-1xv.6 — Formula: action step parser

Implements: FORMULAS.md §8.2, §8.3, §8.4 (step grammar, as written by vtt-1xv.5),
review r1 finding 3,
§3.2 (expression syntax and limits), §2.3 (`#SYNTAX`).

Pure parsing, no evaluation. Exclusive files:
`packages/formula/src/actions/step-parser.ts`, tests
`packages/formula/test/actions/step-parser.test.ts`; its sorted line
`export * from "./actions/step-parser"` in `packages/formula/src/index.ts`.

- `parseStep(source: string): {ok: true; step: Step} | {ok: false; message:
  string; offset: number}` is a step-level recursive-descent parser over M1's
  lexer (`lexToken`, vtt-o9i), per the grammar written by vtt-1xv.5 (FORMULAS
  §8.4; review r1 finding 3): read the step name (an identifier), `(`, then
  the arguments the step kind takes, each an expression parsed with
  `parseExpressionPrefix` (which stops at `,`, `)` or `->`), a destination
  (the bare word `table`, `board(` expr `,` expr `)`, `beside(` expr `)`, or
  an expression), a record (an expression that must be a `Record` node), or,
  for `each`'s second argument, a step parsed recursively (not `each`); then
  `)`, then for `roll` exactly `->` and a path expression; then end of input.
  `->` is never handed to the expression parser as an operator. The
  expression limits of FORMULAS §3.2 (AST depth, node count) are counted over
  the whole step source, not per argument.
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
`each(targets, roll(1d20) -> it.save_roll)` (a nested roll inside `each`);
`each(rows, add(it.target.damage_taken, it.damage_dealt))`; a step whose
arguments together exceed the node limit while each alone would not is
refused (the whole-source limit);
`` set(`Max HP`, 3) ``; and refusals with offsets for `roll(1d20)`,
`set(1, 2)`, `set(a)`, `each(l, each(m, remove(it)))`, `foo(a)`, `set(a, 1)
extra`, `spawn(t, this, 3)`, `spawn(t, this, {a: 1, a: 2})`, `set(a, (1`;
`pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: evaluation and execution (vtt-1xv.8, vtt-1xv.9); changing the expression
grammar or the lexer; storing parsed steps (actions stay source text, D20).

Depends on: vtt-1xv.5.

---

### M5-b0 — vtt-1xv.28 — Schema and protocol: action contracts

Implements: FORMULAS.md §8.1 (refusals, as written by vtt-1xv.5);
FIXTURES.md §6 (rejection reasons); docs/PROTOCOL.md §2 (welcome `limits`),
§7.2 and §7.6 (`ActionDefinitionView`), §10 (rejection variants and the
limits `max_each_items`, `max_action_writes`, `max_face_elements`); M5 plan
decisions Q6, Q7 (docs/plans/m5-plan.md §4); review r1 finding 5; review r3
findings 7, 11 (split from vtt-1xv.7).

The action contracts the executor needs, ahead of the face work. Exclusive
files: `packages/schema/src/action-limits.ts`, tests
`packages/schema/test/action-rejections.test.ts`,
`packages/protocol/test/action-contracts.test.ts`; its sorted index line in
`packages/schema/src/index.ts`. Post-merge additive edits:
`packages/schema/src/ops.ts` (`Rejection`, `RejectionSchema`,
`FixtureRejectionReason`, `toFixtureReason`), `packages/protocol/src/
methods.ts` (`ProtocolRejectionSchema` only), `views.ts` (the
`ActionDefinitionView` rename only), `version.ts` (`LIMITS`), `messages.ts`
(the welcome `LimitsSchema` only), `packages/ui/src/values/rejections.ts`
(vtt-3l6.3, merged: `describeRejection` is exhaustive over
`ProtocolRejection`, so one sentence and one test case per new variant).

- `Rejection` gains `{type: "when_false"; object; action}`, `{type:
  "when_error"; object; action; code: ErrorCode; message?}`, `{type:
  "step_error"; object; action; step: number; code?: ErrorCode; message}`;
  `RejectionSchema` and `ProtocolRejectionSchema` accept them;
  `FixtureRejectionReason` gains `when_false` and `when_error {code}`;
  `toFixtureReason` maps them to `{type: "when_false"}`, `{type:
  "when_error", code}`, `{type: "step_error", code?}`.
- Action views: the protocol `ActionView` schema is renamed
  `ActionDefinitionView` (same wire shape: `name`, and for the GM `when`
  and `steps`; `ActionView` stays as a deprecated type alias). It is the
  type of object views' `actions`, `field: "actions"` effects and
  snapshots' `actions`, and never carries live state (vtt-1xv.12 adds the
  separate `ActionStateView`).
- Limits (review r3 finding 7): `action-limits.ts` exports
  `MAX_EACH_ITEMS = 1000`, `MAX_ACTION_WRITES = 10000`, `MAX_FACE_ELEMENTS
  = 200`; protocol `LIMITS` gains `max_each_items`, `max_action_writes`,
  `max_face_elements` with those values (imported from `@vtt/schema`), and
  the welcome `LimitsSchema` declares them. vtt-1xv.8 enforces the first
  two with these constants and vtt-1xv.7's `faceProblem` the third.

Done when: schema tests accept and round-trip each new variant and map it
with `toFixtureReason`; protocol tests parse each variant in a rejected
`TransactResult`; a welcome message carrying `LIMITS` round-trips through
`parseServerMessage` with the three new values; `field: "actions"` effects
and snapshots validate against `ActionDefinitionView` with no live fields;
`describeRejection` has a sentence for each new variant (`when_false` reads
"<action>: its condition is false"); every package typechecks;
`pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: faces (vtt-1xv.7); executing actions (vtt-1xv.8); live action
state (vtt-1xv.12).

Depends on: vtt-1xv.5, vtt-5su.3, vtt-5su.6, vtt-3l6.3.

---

### M5-b — vtt-1xv.7 — Schema, store and protocol: face layouts and action refusals

Implements: DESIGN.md §4.1 (face layout is data, copied on spawn), §4.6
(face layouts, as written by vtt-1xv.5), §7 (operation records, undo keys,
replay, canonical file); docs/PROTOCOL.md §5 (`set_face`, `ObjectInit.face`),
§6 (keys), §7.6 (face effect view), §12; M5 plan decisions Q8, Q9
(docs/plans/m5-plan.md §4); review r2 findings 5, 6; review r3 finding 11
(the action contracts moved to vtt-1xv.28).

The face storage and protocol changes, carried through every exhaustive
switch in the repo so the build stays green. Exclusive files: `packages/schema/src/face.ts`,
`packages/authority/src/store/face.ts`, tests
`packages/schema/test/face.test.ts`, `packages/authority/test/store/face.test.ts`,
`packages/authority/test/protocol/set-face.test.ts`,
`packages/protocol/test/face-ops.test.ts`,
`packages/authority/test/protocol/face-snapshots.test.ts`; sorted index lines for the
two new modules. Post-merge additive edits: `packages/schema/src/object.ts`,
`ops.ts`; `packages/authority/src/store/effects.ts`, `structural.ts`,
`summary.ts`, `persist/canonical.ts`, `protocol/conflicts.ts`,
`protocol/commands.ts`, `protocol/views.ts` (effect and snapshot conversion
only);
`packages/protocol/src/ops.ts`, `views.ts` (`EffectView`, `ObjectSnapshotView`
and `FaceLayoutView` only); if vtt-5su.11 has merged, the "19 `WireOp`
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
  non-blank `show_when` ≤ 10,000 chars, `min_size` finite ≥ 0, at most
  vtt-1xv.28's `MAX_FACE_ELEMENTS` elements per list, at most one `contents` element per list).
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
  `face:<object>`; `ObjectInit.face`. Historical faces (review r2 finding 5): a wire type `FaceLayoutView` (zod
  schema in protocol `views.ts`: `FaceLayout`'s shape with every element
  carrying `index: number`, its position in the stored list, and no live
  `shown`; `FaceLayout` stays the storage and op type) is used by
  `EffectView` `field: "face"` (`before`/`after: FaceLayoutView | null`) and
  `ObjectSnapshotView.face?: FaceLayoutView | null` (create and remove
  effects). GM views: lossless (every element, `show_when` kept). Character
  views follow D15 (current visibility at the view's revision): kept only
  when the object is visible now, without `show_when` and without elements
  naming a cell the viewer cannot read now; a removed object is invisible,
  so its remove snapshot is omitted from a character's group view until an
  undo restores the object, after which the snapshot appears filtered
  (review r2 finding 6).

Done when: schema tests accept the Attack card face of Q8 and reject each
`faceProblem` case; store tests: `setFace` writes, undoes (layout restored),
replays, conflicts with a later `setFace` and with removal, survives
`serializeTable`/`parseTable`, is copied on spawn, is refused for an unknown
object; a GM `set_face` over the protocol commits, a stale one is
`stale_write` with key `face:<object>`; the character effect view drops an
element naming a GM-only cell and strips `show_when`, and the element after
it keeps its stored `index`; a create effect (spawn of a faced template)
carries the face losslessly for the GM and filtered for Aldric; a remove
effect carries it losslessly for the GM, is omitted from Aldric's group view
right after the removal, and appears filtered after an undo restores the
object; replaying both restores the face; GM and character group views with
face effects and snapshots round-trip through the client's result
validation (`parseResult` for the `log` and `changes_since` results) with
every `index` preserved and no `shown`; `pnpm typecheck`,
`pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: action refusals, `ActionDefinitionView` and the advertised
limits (vtt-1xv.28); face presentation in object views and show-when evaluation
(vtt-1xv.12); executing actions (vtt-1xv.8); the fixture format (vtt-1xv.10); MCP change
records (vtt-1xv.13 adds `face` to `ObjectFacts`).

Depends on: vtt-1xv.5, vtt-5su.5, vtt-5su.6 (commands and views exist), vtt-3l6.19
(it edits `structural.ts`, `commands.ts` and protocol `ops.ts` too; serialize),
vtt-1xv.28 (shares schema `ops.ts` and protocol `views.ts`; uses
`MAX_FACE_ELEMENTS`).

---

### M5-c — vtt-1xv.8 — Authority: action executor (guard, value steps, dice, each)

Implements: DESIGN.md §4.5, §7 (Transactions, operation records); FORMULAS.md
§8.1, §8.2 (paths), §8.3 (`set`, `add`, `append`, `roll`, `shuffle`, `each`),
§8.4 (as written by vtt-1xv.5), §2.2 (rolls act as totals in arithmetic), §7
(budget); FIXTURES.md §5 (dice consumption is transactional), §6
(rejections); M5 plan decisions Q3, Q4, Q6, Q7 (docs/plans/m5-plan.md §4;
the step table is in vtt-1xv.5); review r1 finding 2; review r2 finding 8; review r3
findings 7, 11.

The executor core over M2's `Table`, `ActionContext`, `transactWithDice` and
primitives (vtt-75c.15). Placement steps are vtt-1xv.9's `placementHandlers`;
callers compose them explicitly (no registration at import time). Exclusive files: `packages/authority/src/engine/invoke.ts`,
`packages/authority/src/engine/steps-value.ts`, tests
`packages/authority/test/engine/invoke.test.ts`,
`packages/authority/test/engine/steps-value.test.ts`; sorted lines in
`packages/authority/src/engine/index.ts`.

- Handler contract (review r2 finding 8), exported from `invoke.ts`:
  `StepOutcome = {ok: true} | {ok: false; rejection: Rejection}`;
  `StepHandler = (ctx: StepContext, step: Step) => StepOutcome`;
  `StepHandlerEntry = {kind: Step["kind"]; handle: StepHandler}`;
  `StepContext = {tx; table; dice; thisId: ObjectId; it?: Value;
  tableDestination?: {board; position}; created: ObjectId[] /* handlers
  push spawned ids in creation order */; evaluate(expr: Expr): Result /*
  through the invocation's ActionContext, scope {thisId, it}, a fresh
  20,000-unit budget */; resolvePath(path: PathNode): {ok: true; object;
  cell} | {ok: false; rejection}; primitives: {writeValue, setTag, rollInto,
  shuffleWith, move, spawn, remove} /* M2's, bound to tx and the dice
  source; each call counts one primitive call */; count(n: number): void /*
  extra primitive calls; past `MAX_ACTION_WRITES` (10,000) the executor refuses #LIMIT */;
  refuse(reason: {code?: ErrorCode; message: string}): StepOutcome /* a
  step_error at the current step index */; runStep(step: Step, scope: {it:
  Value}): StepOutcome /* used by each */}`. A primitive's `Rejected`
  thrown inside a handler is caught by the executor and mapped per the
  refusal rules below; any other exception propagates.
- `createExecutor({handlers: StepHandlerEntry[]}): Executor` (a duplicate
  kind throws; a step whose kind has no handler refuses `step_error` "not
  supported") with:
  - `runAction(tx: Transaction, ctx: {table: Table; dice: DiceSource},
    req: {object; action; tableDestination?}): RunOutcome`, which executes
    the whole action inside a transaction the caller opened and never
    commits or aborts it (review r1 finding 2): `RunOutcome` = `{ok: true;
    created: ObjectId[]}` | `{ok: false; rejection: Rejection; step?:
    number}`. On `{ok: false}` the caller must abort by throwing `new
    Rejected(rejection)` from its transaction function (the partial effects
    and the dice drawn are discarded by the store and `transactWithDice`'s
    reset); on `{ok: true}` the caller may check `tx.effects()` (vtt-1xv.11's
    stale check) before returning. Order: object exists and has an action
    of exactly that name, else `invalid`; `when` (if any) with
    `ctx.table.engine.evaluate(source, {thisId})` (the committed revision):
    `true` continues, an error is `when_error` with its code (`#SYNTAX` when
    it does not parse), anything else `when_false`; then every step is
    parsed with vtt-1xv.6's `parseStep` (first failure → `step_error`
    `#SYNTAX` with its index and message); then the steps run through the
    handlers. Nothing before the first `roll` or `shuffle` draws dice.
  - `invokeAction(table, dice, req: {object; action; actor: Actor; label?;
    tableDestination?}): InvokeOutcome` = `transactWithDice(table, actor,
    {kind: "action", label: req.label ?? action, origin: {object, action}},
    dice, (tx) => { const r = runAction(tx, {table, dice}, req); if (!r.ok)
    throw new Rejected(r.rejection); })`, returning `{ok: true; group;
    summary; created}` | `{ok: false; rejection; step?}`.
- `coreHandlers: StepHandlerEntry[]` (`steps-value.ts`): `set`, `add`,
  `append`, `roll`, `shuffle`, `each`. Callers compose `createExecutor({
  handlers: [...coreHandlers, ...placementHandlers]})` (vtt-1xv.10,
  vtt-1xv.11, vtt-1xv.22); this bead's tests use `coreHandlers` alone plus a
  test-local handler for the contract.
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
  the inner step runs per item with `it` bound; at most `MAX_EACH_ITEMS` (1,000) iterations.
  Any expression evaluating to an error is `step_error` with that code; a
  record where a value is needed is `#TYPE`.
- Refusal mapping (Q7): a step's evaluation error → `step_error {step, code,
  message}`; a primitive's `Rejected` inside a step keeps its type
  (`protected_cell`, `containment_cycle`, `type_error`) and the outcome
  carries `step`; a primitive's `invalid` becomes `step_error` without code
  and with the primitive's message; a `ScenarioError` from a scripted dice
  source propagates (never a refusal). `step` is the 0-based index in the
  action's step list (an `each`'s inner failure reports the `each`'s index).
- Limits (Q6): the constants are vtt-1xv.28's `MAX_EACH_ITEMS` and
  `MAX_ACTION_WRITES` (never local literals); more than `MAX_ACTION_WRITES`
  primitive calls in one invocation →
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
every cell (one group); a refused invocation (a `when_false`, and a
`step_error` in the second step after a `roll` in the first) changes neither
the document, the revision, the log, nor the dice position, and no commit
listener runs; `runAction` called in a test-opened transaction that the test
then aborts leaves the store unchanged, and one the test commits produces
the same group as `invokeAction`; a test-local handler uses `evaluate`,
`resolvePath`, `primitives`, `count`, `created` and `refuse` (a primitive's
`Rejected` thrown inside it maps with the step index; `count` past the limit
refuses `#LIMIT`); a duplicate handler kind throws; an unhandled kind
(`move` without placement handlers) refuses "not supported"; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
`pnpm test` exit 0.

Out of scope: `move`, `spawn`, `remove`, destinations (vtt-1xv.9); the protocol
(vtt-1xv.11); the fixture runner (vtt-1xv.10); actors other than the given one; perf
work on `ActionContext.read` (vtt-qf5.9).

Depends on: vtt-1xv.6, vtt-1xv.28, vtt-1xv.5.

---

### M5-d — vtt-1xv.9 — Authority: placement steps and destinations

Implements: FORMULAS.md §8.2 (destinations), §8.3 (`move`, `spawn`,
`remove`), §3.1 (landing rule), §8.4 (as written by vtt-1xv.5); DESIGN.md §4.1
(spawn, remove, containment), §7 Smaller decisions (the `table` destination
is resolved by M5 into a board destination); M5 plan decisions Q4, Q5 (docs/plans/m5-plan.md §4); review r2 finding 8.

Exclusive files: `packages/authority/src/engine/steps-place.ts`, tests
`packages/authority/test/engine/steps-place.test.ts`; its sorted line in
`packages/authority/src/engine/index.ts`. Exports `placementHandlers:
StepHandlerEntry[]` (`move`, `spawn`, `remove`) written against vtt-1xv.8's
`StepContext`; it does not register itself and does not edit `invoke.ts`
(review r2 finding 8). Its tests compose `createExecutor({handlers:
[...coreHandlers, ...placementHandlers]})` and run through `invokeAction`;
vtt-1xv.11 runs placement actions through the protocol entry point.

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

Out of scope: the protocol (vtt-1xv.11); the UI's choice of `tableDestination`
(vtt-1xv.16).

Depends on: vtt-1xv.8.

---

### M5-e — vtt-1xv.10 — Fixtures and direct runner: invoke, action expectations, show-when

Implements: FIXTURES.md §5, §6 (`invoke`; rejections `when_false`,
`when_error`, `step_error`), §7 (`action`; `face_element` and setup `face`
as written by vtt-1xv.5), §8, §9 (all ten fixtures), §11; FORMULAS.md §10; review r1 finding 7; review r2 findings 8, 11;
M5 plan decisions Q9, Q16.

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
vtt-1xv.24 can import them (no other export changes).

- `setup.ts`: copies `face` into objects. `steps.ts`: `invoke` →
  `createExecutor({handlers: [...coreHandlers, ...placementHandlers]})`
  (vtt-1xv.8, vtt-1xv.9; review r2 finding 8) `.invokeAction` with the
  step's actor, the runner's
  `ScriptedDiceSource`; refusals follow the rejection protocol with
  `toFixtureReason` (vtt-1xv.28). `expect.ts`: `action` → `explain`-equivalent
  evaluation (`table.engine.evaluate` of `when`; enabled iff absent or
  `true`); `face_element` → `element` is the index in the stored list
  (review r1 finding 7), evaluated with vtt-1xv.12's
  `faceElementVisible(table, viewer, object, {list, index})` (review r2
  finding 11), the same predicate live face views use, so the direct and
  protocol runners agree: true exactly when the element with that stored
  index is present in the viewer's view with `shown === true` (review r3
  finding 6). The truncation
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

Out of scope: the protocol runner (vtt-1xv.13); the UI driver (vtt-1xv.24); new
scenarios beyond the attack card's face.

Depends on: vtt-1xv.8, vtt-1xv.9, vtt-1xv.7, vtt-1xv.28, vtt-1xv.5, vtt-1xv.12.

---

### M5-f — vtt-1xv.11 — Protocol and authority: `invoke` command, client retry, explain parse status

Implements: DESIGN.md §5.2 ("define and invoke actions"; writes carry their
base revision and are rejected on conflict), §7 Revisions; docs/PROTOCOL.md
§3, §4 (`invoke`), §6 (processing order, stale keys, deduplication, client
retries, `uncertain`), §9 (`explain_action`), §10 as written by vtt-1xv.5; review r1 finding 2;
M5 plan decisions Q2, Q3, Q12.

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
  `actions:<object>` against groups after `base_revision` → the command
  opens the transaction itself (review r1 finding 2), exactly as `transact`
  does in `commands.ts`: `transactWithDice(table, actor, {kind: "action",
  label, origin: {object, action}}, hostDice, (tx) => {…})`, inside which it
  calls `runAction` of the command context's executor (created once as
  `createExecutor({handlers: [...coreHandlers, ...placementHandlers]})`,
  vtt-1xv.8, vtt-1xv.9; review r2 finding 8) as `runAction(tx, {table, dice}, {object, action,
  tableDestination: table})`, throws `new Rejected(rejection)` on a refusal
  (remembering `step`), and, when `base_revision` < current, computes the
  touched keys of `tx.effects()` and throws `StaleWriteError` on a conflict,
  all before the transaction function returns, so nothing commits, no
  listener runs and the dice source is reset → commit. The
  result is `{status: "committed", revision, index, created}` or
  `{status: "rejected", rejection, step?}` and is stored for deduplication.
  An unknown object or action is `rejected` `invalid` (never `not_found`,
  PROTOCOL §4); an object removed since `base_revision` is `stale_write`.
  The `when` guard is evaluated at the current revision, not at
  `base_revision`.
- `explain_action` (GM only): `when_parses: boolean`, `when_syntax_error?`,
  `step_status: ({ok: true} | {ok: false; message; offset})[]` from vtt-1xv.6's
  `parseAction`; character results unchanged.

- Limits (review r3 finding 7): `max_each_items` and `max_action_writes`
  are enforced by the executor with vtt-1xv.28's constants, the same values
  `LIMITS` advertises in `welcome`; a test invokes an action whose `each`
  exceeds `LIMITS.max_each_items` and gets `step_error` `#LIMIT`.

Done when: protocol tests round-trip params and results and reject unknown
keys, `actor` from an agent, `retry` without `txn_id`; authority tests over a
real server on port 0 with Node's `WebSocket` and `ProtocolClient`: the
Attack card's three actions and the Fireball card's Lock targets (a
placement action: spawned rows in `created`) and Discard commit through
`invoke` with scripted dice
(`TableHost.inMemory` with a `ScriptedDiceSource`), `created` lists Lock
targets' rows, a second Apply is `rejected` `when_false`, a repeated `txn_id`
returns the stored result without consuming dice, the same `txn_id` with a
different action is `invalid` "txn_id reused…", a concurrent GM write to the
target's `damage_taken` after `base_revision` makes Apply `stale_write`, and
a concurrent write of `empty` to the card's `dmg` (the guard stays true) makes Roll damage `stale_write`; each
refused invoke changes neither the document, the revision, the log nor the
dice position (`ScriptedDiceSource.remaining()` unchanged after the stale
Roll damage) and sends no commit event to a second connected client; an invoke with `actor` Aldric records that
actor, `invokeWithRetry` resends once after a same-session socket drop and
returns the stored result, and reports `uncertain` after a restart; the
client's `isWrite` gap is closed: an `invoke` whose socket drops after it was
sent (plain `client.invoke`, no retry) rejects `uncertain` with `details.sent:
true`, never `disconnected`, while one never sent rejects `disconnected`;
`explain_action` reports a bad step's offset; `invoke` is no longer
`unsupported`; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`
exit 0.

Out of scope: the MCP tool (vtt-1xv.13); object view fields (vtt-1xv.12); the UI
(vtt-1xv.16).

Depends on: vtt-1xv.8, vtt-1xv.9, vtt-1xv.7, vtt-1xv.28, vtt-1xv.6, vtt-1xv.5, vtt-5su.10, vtt-5su.5, vtt-5su.16,
vtt-5su.19, vtt-5su.7.

---

### M5-g — vtt-1xv.12 — Protocol and authority: faces and action state in object views

Implements: DESIGN.md §4.4 (presentation filtered by effective visibility),
§4.6 (face layouts, show-when, as written by vtt-1xv.5); FORMULAS.md §7
(propagation), §9; docs/PROTOCOL.md §7.2, §8 (deltas), §12; M5 plan decisions Q9,
Q10, Q11 (docs/plans/m5-plan.md §4); review r1 findings 4, 5, 6, 7; review r2 finding 11; review r3 finding 6.

Exclusive files: tests `packages/authority/test/protocol/face-views.test.ts`,
`packages/authority/test/protocol/action-state.test.ts`,
`packages/protocol/test/face-views.test.ts`; post-merge additive edits of
`packages/protocol/src/views.ts` (`FaceView`, `FaceElementView`,
`ActionStateView`, `ObjectView.action_states`, `ObjectView.face`), `packages/authority/src/protocol/views.ts`
(object views only), `packages/authority/src/protocol/subscriptions.ts`
(candidates only); new `packages/authority/src/protocol/face-visibility.ts`
(sorted index line) and test `packages/authority/test/protocol/face-visibility.test.ts`.

- Live action state (review r1 finding 5): a new `ActionStateView = {name;
  enabled: boolean; reason?: "when_false" | "when_error"}` and
  `ObjectView.action_states: ActionStateView[]` (one per action, in the
  order of `actions`, every viewer; the `when` result evaluated as
  vtt-1xv.8 does). It appears only in live object views (subscribe results,
  deltas, `get_objects`, `list_objects`, `zones` views); `actions` stays
  vtt-1xv.28's `ActionDefinitionView[]`, and effects and snapshots never
  carry live state.
- `ObjectView.face?: FaceView` when the view's `cells` is `"all"` and the
  object has a layout: `FaceView = {elements: FaceElementView[]; collapsed?:
  FaceElementView[]; default_action?: string}`; `FaceElementView` = the
  element plus `index` (its position in the stored list; review r1 finding
  7) and `shown: boolean`. GM views (review r3 finding 6) retain every
  stored element with its `show_when` source: `shown` is true when
  `show_when` is absent or evaluates to `true` (on the object, with
  `engine.evaluate`) and, for a button, its action exists; otherwise `shown`
  is false with `reason: "show_when_false" | "show_when_error" |
  "no_action"` (and `error: ErrorCode` for an error). Character views keep
  only the elements that would be `shown: true` for the GM and whose value
  or editor cell the viewer can read, each with `shown: true`, without
  `show_when`; `default_action` is kept only if it names an existing
  action; every kept element keeps its stored `index`.
- `faceElementVisible(table: Table, viewer: Viewer, object: ObjectId,
  element: {list: "full" | "collapsed"; index: number}): boolean` (review r2
  finding 11; defined in review r3 finding 6): true exactly when the
  viewer's live object view of that object (built by the same code) has a
  face element in that list with that stored `index` and `shown === true`;
  false when the object is absent from the view (nonexistent, invisible,
  covered) or the element is absent or has `shown: false`. vtt-1xv.10 and
  (through views) vtt-1xv.13 use exactly this definition.
- Deltas (Q10; review r1 finding 6): after each commit the candidates for
  re-viewing include every object in `summary.faceChanged` (a plain face
  edit, its removal, or its undo), and every in-scope object whose layout has
  a `show_when` or whose actions have a `when`
  (views are still sent only when their canonical JSON changed), so results
  that read other objects stay current without dependency tracking.

Done when: `faceElementVisible` tests, each asserted equal to "present with
`shown === true` in the viewer's live face view": a GM element retained
with `shown: false` (`show_when` false) is false; a GM button naming a
nonexistent action is retained with `shown: false`, `reason: "no_action"`,
and is false; the same elements are omitted from Aldric's view and false; an
invisible object, an object under a cover, an element naming an unreadable
cell (for Aldric), and a visible element; tests with a real server and
mirrors show: the Attack card's GM
view (actions invoked through vtt-1xv.11's `invoke`, scripted dice) carries
the buttons with `shown` and `action_states` matching FORMULAS §10 before and
after each action: Apply shown and disabled before the rolls, enabled after
Roll damage, absent from `shown` elements after Apply; Aldric's view lacks `show_when` and the hidden
Apply button; a value element on the goblin's GM-only `ac` is absent from
Aldric's face view; a button whose guard reads another object's cell
(`target.hp > 0`) changes `enabled` in the delta after a commit that changes
only that other object; a `show_when` error hides the element and the GM view
has its code; a `cells: "structural"` subscription carries no `face`; in
Aldric's view a visible element following one filtered out (a GM-only cell)
keeps its stored `index`; adding, changing, removing and undoing an
unconditional face (no `show_when`, no guards) each produce the delta that
makes the mirror equal a fresh subscribe; effects and snapshots in the log
window carry no `action_states`;
applying deltas equals a fresh subscribe (the M3 equivalence property for
these fields); `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`
exit 0.

Out of scope: drawing (vtt-1xv.14, vtt-1xv.15); dependency-tracked presentation
formulas (followup in section 5); the face effect view (vtt-1xv.7).

Depends on: vtt-1xv.7, vtt-1xv.28, vtt-1xv.5, vtt-1xv.11, vtt-5su.6, vtt-5su.9.

---

### M5-h — vtt-1xv.13 — MCP `invoke` tool and fixture scenarios over the protocol

Implements: DESIGN.md §5.2 (parity: "define and invoke actions"); docs/
PROTOCOL.md §11 (tool `invoke`, change records with `face`) as written by
vtt-1xv.5 (15 request-surface tools, 19 in the composed process); decision D19 (the tool arrives with the buttons); FIXTURES.md §6, §7.

Exclusive files: `packages/authority/src/mcp/invoke-tool.ts`, tests
`packages/authority/test/mcp/invoke-tool.test.ts`; post-merge edits of
`packages/authority/src/mcp/tools.ts` (vtt-5su.11: one line adding the
`invoke` tool to the request surface, so `createMcpServer` has 15 tools),
`src/mcp/changes.ts` (`ObjectFacts.face`; vtt-5su.15), the frozen tool-list
snapshot and the parity exception in `test/mcp/tools.test.ts` (15 tools, no
`invoke` exception) and `test/mcp/subscriptions.test.ts` (no `invoke`
exception), the composed-process tool list in `test/mcp/stdio.test.ts`
(vtt-5su.17: 19 tools: the 15, `subscribe`, `poll_changes`, `unsubscribe`
and vtt-3l6.20's `import_asset`; review r1 finding 15), `test/protocol-runner/*.ts` and
`test/protocol-scenarios.test.ts` (vtt-5su.12: `invoke`, `action`,
`face_element` and the action refusals over the protocol).

- Tool `invoke {object, action, base_revision, label?, table?}` → protocol
  `invoke` through `invokeWithRetry` (vtt-1xv.11) with a generated `txn_id`, the
  connection gate, retry within 10 s like `transact`; `rejected` →
  `isError: true` with the rejection and `step`; `uncertain` → `isError`.
  The description says actions are defined with `transact` `set_actions` and
  that `table` is the board and point the agent wants the `table`
  destination to mean.
- Protocol runner: `invoke` steps → `client.request("invoke", …)` with the
  step's actor; `action` → `explain_action` `enabled`; `face_element` →
  the viewer's `get_objects` face view, finding the element by its `index`
  (shown exactly when present with `shown === true`; absent, or the object
  absent, means not shown; review r3 finding 6); live views
  compute it with vtt-1xv.12's `faceElementVisible`, the predicate the
  direct runner (vtt-1xv.10) uses, so both runners agree (review r2 finding
  11); refusals mapped with
  `toFixtureReason`; the coverage table now expects every scenario complete
  over the protocol, matching the direct runner's snapshots and logs.

Done when: in-process MCP tests (vtt-5su.11's `test/mcp/support.ts`): the
request-surface server lists 15 tools including `invoke` and the parity test
has no `invoke` exception; the stdio process test lists exactly 19 tools,
`import_asset` and `invoke` among them; the agent invokes the Attack card's Roll and gets the committed
revision; a `when_false` refusal is `isError` with the rejection; a
`set_face` by the GM produces a change record whose `objects` entry shows
`face` before and after; all ten scenarios pass over the protocol with the
same final snapshot and log as the direct runner; `pnpm typecheck`,
`pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: a model in the loop; MCP prompts; the UI.

Depends on: vtt-1xv.11, vtt-1xv.12, vtt-1xv.10, vtt-5su.11, vtt-5su.12, vtt-5su.15, vtt-5su.17,
vtt-3l6.20.

---

### M5-i — vtt-1xv.14 — UI: face contracts, state and layout

Implements: DESIGN.md §4.6 (The face, Zoom as level of detail, Face
elements, Collapsed face; default face, contents scrolling, nested objects,
Ink, as written by vtt-1xv.5), §4.4 (face-down objects show their back),
§4.7 (contents entries collapsed by default); docs/PROTOCOL.md §7.2
(`FaceView`, `ActionStateView`, element `index`); M5 plan decisions Q8, Q9,
Q11, Q19 (docs/plans/m5-plan.md §4); review r1 findings 8, 11, 16; review r2
findings 1, 3, 13 (split: the scene and hit testing are vtt-1xv.26); review
r3 findings 1, 2, 3, 5, 8.

Pure, no canvas, no React. Exclusive files: `packages/ui/src/face/
face-contracts.ts`, `face-state.ts`, `face-model.ts`, `face-transform.ts`,
tests `packages/ui/test/face/contracts.test.ts`, `state.test.ts`,
`model.test.ts`, `transform.test.ts`; its sorted index lines; post-merge
additive edit of `packages/ui/src/scene/scene.ts` (vtt-3l6.5, merged): export
`drawItemFor(view, {anchor, rotation, gm, formatText}): DrawItem`, the
existing internal per-item builder that `buildScene` already uses (no
behaviour change; `buildScene`'s tests still pass).

- `face-transform.ts`: `Affine` (2×3), `compose`, `invert`, `apply`,
  `rectToRect(from, to)` (uniform scale, top-left aligned), `aabb(rect,
  affine)`, and `screenHeight(rect, affine, camera)` (the rect's height in CSS
  px after the accumulated transform and the camera); `min_size` everywhere
  compares against `screenHeight`.
- `FaceDrawing = {frame: Rect; bounds: Rect; base: DrawItem | null;
  primitives: FacePrimitive[]}` in the object's local frame (origin at the
  anchor, y down, unrotated). `base` is set for nested drawings only
  (review r2 finding 3): `drawItemFor(childView, {anchor: [0, 0], rotation:
  0, gm, formatText})`, so a contained object gets exactly the board rules
  (shape, fill, image, text, label, face-down back and glyph; for a faced
  child, `image`/`text`/`label` cleared as on the board). A face-down child
  gets `base` and no primitives. `FacePrimitive` (each with `rect`,
  `minSize` in CSS px, and a `target` for hit testing): `text {text, tone,
  size, align, caption?}` (vtt-3l6.3's `formatValue` compact), `image
  {path}`, `ink {strokes}` (object-local units), `button {action, label,
  enabled, reason?, template}` (`enabled`/`reason` from `action_states`),
  `editor {cell, text, tone}`, `gear {id}`, `contents {element: number;
  rect; offset; maxOffset; entries: Entry[]}` with `Entry = {id; expanded;
  list: "full" | "collapsed"; template; row: Rect /* element-local, before
  the offset */; chevron: Rect; gear?: Rect; transform: Affine /* child
  frame → container frame: element rect × row × uniform scale */; drawing:
  FaceDrawing | null /* null only for a redacted or missing entry, drawn as
  "hidden" */}`.
- `resolveFace(view, {views, faceState, list: "full" | "collapsed", gm,
  formatText}): FaceDrawing`: elements in order, identified by `index`;
  `shown: false` elements skipped; contents entries from the `contents`
  cell's refs in order, every visible entry with a drawing (review r3
  finding 1): a collapsed entry is resolved with the child's collapsed list
  (`list: "collapsed"`): its own `face.collapsed` when present, else the
  default collapsed face, one `name` value element filling
  `COLLAPSED_FRAME` (vtt-1xv.7), with no `base`; its row is the collapsed
  frame scaled to the row width minus the chevron (height `rect.w × 0.1`).
  An expanded entry is resolved with the child's full list (`list:
  "full"`; its face or default face, with `base`), scaled uniformly to that
  width, its height by the child's `bounds`. Template entries get a gear in
  both states. Collapsed-face buttons and editors are live targets like
  full-face ones.
- Default face (Q11), for an object whose view has no `face`: the drawing
  adds its `ink` cell (an ink value) as an `ink` primitive over the frame;
  if it has actions, a strip of buttons (1.5 × 0.45 units each, 0.1 apart,
  0.15 below the frame's bottom, `minSize` 12 px); if its `contents` is
  non-empty, a contents primitive below that, 6 units wide and `min(n, 8)`
  rows high (entries collapsed by default, `minSize` 12 px). `bounds` is the
  union of the frame and every primitive.
- Board-template gear: a template object placed directly on the board gets
  `gear {id}`, 0.3 × 0.3 just outside the frame's top-right corner,
  `minSize` 10 px.
- Scrolling (review r2 finding 1): a contents primitive's rows are shifted
  up by `offset = faceState.scrollOffset(object, element)` clamped to `[0,
  maxOffset]` (`maxOffset = max(0, total rows height − rect.h)`); entries are
  clipped to the element rect (consumers clip; the model reports `rect`).
  `revealOffset(contents: ContentsPrimitive, entryId): number` (review r3
  finding 8): when the entry's row (expanded height included) fits in the
  rect, the smallest offset that shows the whole row; when it is taller than
  the rect, the offset that aligns the row's top with the rect's top; the
  rest is reached by scrolling. Clamped to `[0, maxOffset]`.
- `presentationBounds(item: DrawItem, drawing: FaceDrawing | null): Bounds`
  (board space): the item's footprint bounds ∪ the drawing's `bounds` after
  the item's anchor and rotation; vtt-1xv.26 stores it per item.
- `FaceStateStore` (UI-local, never written to the table): `isExpanded(id,
  entriesMode)`, `toggle(id)`, `expand(id)`, `collapse(id)`,
  `scrollOffset(object, element)`, `scrollBy(object, element, dy)`,
  `setScroll(object, element, offset)`, `subscribe`.
- `face-contracts.ts`, the shared gesture contracts (types only; implemented
  by vtt-1xv.16, vtt-1xv.25, vtt-1xv.17, vtt-1xv.26, vtt-1xv.27): `FaceHit
  = {object /* the innermost object under the point (a contained child for
  a hit inside an expanded entry) */; path: Array<{container: ObjectId;
  element: number; list: "full" | "collapsed"; transform: Affine /* that
  container's frame → board */}> /* the enclosing contents elements, from
  the board object inward; empty for a hit on a board object's own face */;
  toLocal: Affine /* board → the hit object's frame */; rect /* board-space
  AABB of the target */; target: {type: "button"; action; enabled; reason?;
  template} | {type: "editor" | "value"; cell} | {type: "entry"; id;
  container; element: number} | {type: "chevron" | "gear"; id} | {type: "contents";
  container; element: number; index /* insertion */} | {type: "body"}}`
  (review r3 finding 3); `DropTarget = {kind: "editor"; object; element:
  number} | {kind: "contents"; container; element: number; index: number} |
  {kind: "board"}` (review r3 finding 2; computed by vtt-1xv.26's
  `dropTargetAt`);
  `FacePolicyContext = {input: ReducerInput; stamp: InteractionStamp;
  faceState: FaceStateStore}`; `FacePolicy = {canInvoke(view: ObjectView):
  {ok: true} | {ok: false; reason: string}; onButton?; onToggle?; onGear?}`
  (handlers `(hit: FaceHit, ctx: FacePolicyContext) => Effect[] | null`,
  null = the default); `FaceGesture<S> = {id; start(hit, event, input,
  stamp): S | null; reduce(state, event, input): {state: S | null; effects:
  Effect[]}; cancel(state): Effect[]; overlays(state): ToolOverlay[]}`;
  `WithFacesOptions = {faceState; policy: FacePolicy; gestures?:
  FaceGesture<unknown>[]}`.

Done when: tests on fixed views show: the Attack card face resolves to
buttons with `enabled` from `action_states`, an element hidden by
`show_when` absent and the following element keeping its `index`; image and
ink primitives; a contents element with three entries (one template, one
redacted) lays out rows, the template with a gear, the redacted one hidden;
an expanded entry's transform scales the child to the row width; nested
drawings inside a rotated container (composing the container's rotation):
an expanded faceless note (base with fill and `text`, plus its ink), an
image token (base with the image), and a face-down card (base back and
glyph, no primitives); `screenHeight` of a nested button at two zooms
decides its `minSize`; a faceless die with Roll gets a strip; a faceless
shapeless binder with ten entries gets an 8-row list with `maxOffset` 1.2
units; `scrollOffset` shifts rows and is clamped; `revealOffset` for an
entry expanded near the bottom brings its whole row into the rect, and for
an expanded sheet taller than its parent's contents rect aligns the sheet's
top with the rect's top; the stocked GM binder's collapsed entries each
resolve to a default collapsed drawing whose text is the template's `name`
(gear on each); a child with a custom collapsed list holding a value and a
button resolves that value and an enabled button in its collapsed row; a
template token on the board has a gear; `presentationBounds` of a rotated
faced card contains its rotated buttons and of a faceless die its strip;
`drawItemFor` equals `buildScene`'s item for the same placed view; the
contract types are pinned with `expectTypeOf`; `pnpm typecheck`, `pnpm lint`,
`pnpm format:check`, `pnpm test` exit 0.

Out of scope: scene augmentation, cull bounds and hit testing
(vtt-1xv.26); drawing (vtt-1xv.15); interaction (vtt-1xv.16); layout
editing (vtt-1xv.18).

Depends on: vtt-1xv.12, vtt-1xv.7, vtt-1xv.5, vtt-3l6.5, vtt-3l6.3,
vtt-3l6.22.

---

### M5-i2 — vtt-1xv.26 — UI: face scene and hit testing

Implements: DESIGN.md §4.6 (faces on the canvas; zoom thresholds; contents
scrolling; nested objects, as written by vtt-1xv.5), §4.4 (covers above
everything; nothing interactive under a cover); M4's scene (vtt-3l6.5) and
renderer culling (vtt-3l6.6 as amended); M5 plan decisions Q8, Q11
(docs/plans/m5-plan.md §4); review r1 finding 8; review r2 findings 1, 3,
13 (split from vtt-1xv.14); review r3 findings 1, 2, 3, 5.

Pure, no canvas, no React. Exclusive files: `packages/ui/src/face/
face-scene.ts`, `face-hit.ts`, tests `packages/ui/test/face/scene.test.ts`,
`hit.test.ts`; its sorted index lines.

- `attachFaces(scene: Scene, views, faceState, {gm, formatText}): FaceScene`
  and `buildFaceScene(input, {faceState})` = vtt-3l6.5's `buildScene` then
  `attachFaces`. `FaceScene = Scene & {faces: ReadonlyMap<ObjectId,
  FaceDrawing>; presentation: ReadonlyMap<ObjectId, Bounds>; transforms:
  ReadonlyMap<ObjectId, Affine> /* object frame → board */}`: one
  vtt-1xv.14 `resolveFace` drawing per board item (full list); for an item
  whose view has a layout, its `DrawItem`'s `image`, `text` and `label` are
  cleared (shape, fill, pattern, badges stay); face-down items get no
  drawing; `presentation` from vtt-1xv.14's `presentationBounds`.
- `faceCullBounds(item, scene: FaceScene): Bounds` (for vtt-3l6.6's
  `cullBounds`): the item's presentation bounds, or `item.bounds` without a
  drawing.
- `faceHitAt(scene: FaceScene, point, camera): FaceHit | null`: nothing
  under a cover (`isCovered`); candidates are the items whose presentation
  bounds contain the point, ordered as vtt-3l6.5's `hitsAt` orders them
  (non-zones before zones, descending `z`, descending draw index); for each
  candidate the point is mapped into its frame and tested against its
  primitives last-drawn first, then its footprint (`body`, by
  `pointInRegion`). Inside a contents primitive the point must lie in the
  element rect (the clip), rows are tested with the scroll offset applied,
  and every entry's drawing, collapsed or expanded (review r3 finding 1), is
  tested through its `transform`: a collapsed row's value, button or editor
  is hit as that target on the child; a hit inside an expanded child's
  drawing is a hit on the child (its buttons, editors, nested contents, and
  its `base` footprint as `body`); the row's remaining area is the `entry`; `minSize` uses vtt-1xv.14's
  `screenHeight` with the accumulated transform. A point in a contents
  element that hits no row yields `{type: "contents", container, element,
  index}` (the insertion index under the point). Every hit carries `path`
  (the enclosing contents elements from the board object inward, each with
  its container, element index, list and accumulated transform) and
  `toLocal` (board → the hit object's frame: the board item's transform for
  a board object, composed with the entry transforms along the path for a
  contained one) (review r3 findings 3, 5).
- `dropTargetAt(scene: FaceScene, point, camera, dragged: ObjectId[]):
  DropTarget` (review r3 finding 2), precedence: (1) an editor element under
  the point (on any object other than the dragged ones, nested included) →
  `{kind: "editor", object, element}`; else (2) the innermost contents
  element (of an object other than the dragged ones) whose rect contains the
  point, scroll applied → `{kind: "contents", container, element, index}`,
  `index` = the row under the point (before it on its upper half, after it
  on its lower half) or the end of the list; else (3) `{kind: "board"}`.
  Covers block (1) and (2).

Done when: tests: `attachFaces` clears `text` and `label` only for faced
items and gives face-down items no drawing; a faceless die whose footprint
lies just outside the viewport but whose strip lies inside: its presentation
bounds intersect the view, `faceCullBounds` returns them and `faceHitAt`
hits its Roll button; a shapeless binder's contents list is hit outside its
10 px marker; with a scroll offset the row under the point is the scrolled
one and a row scrolled out of the rect is not hit; a button inside an
expanded entry inside a rotated container is hit at its transformed
position and not below its `minSize`; a face-down card entry hits as the
entry; of two overlapping faced cards the upper one's button wins where they
overlap and the lower one's is hit where uncovered; a template token's gear
hit-tests `{type: "gear", id}`; insertion indices between entries; nothing
under a cover; a collapsed default row's name is hit as the entry and a
custom collapsed row's button as that button on the child; a button inside
an expanded entry two containers deep has a two-element `path` and its
`toLocal` maps the point to the child's frame; `dropTargetAt` over a
collapsed row → that container's `contents` with the row's index, over a
value inside an expanded row's child → the parent's `contents`, over an
editor inside it → that `editor`, over a list whose rows fill the rect →
`contents` with the row index, elsewhere → `board`; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
`pnpm test` exit 0.

Out of scope: layout and transform math (vtt-1xv.14); drawing (vtt-1xv.15);
gestures (vtt-1xv.16, vtt-1xv.25).

Depends on: vtt-1xv.14, vtt-3l6.5.

---

### M5-j — vtt-1xv.15 — UI: drawing faces

Implements: DESIGN.md §4.6 (faces, zoom thresholds, contents scrolling,
nested objects drawn as on a board; "Canvas text is weak at small sizes,
which show-when zoom thresholds already accommodate"), §4.4 and §4.6 as
amended by vtt-3l6.2 (covers above every object and object-related
overlay), §7 Platform; M5 plan decisions Q1 (A3), Q8, Q19
(docs/plans/m5-plan.md §4); review r1 finding 8; review r2 findings 1, 3; review r3 finding 1.

Exclusive files: `packages/ui/src/render/face-draw.ts`, tests
`packages/ui/test/render/face-draw.test.ts`; its sorted index line.

- `drawFaceItem(ctx: Ctx2D, item: DrawItem, {camera, images, scene:
  FaceScene, selection})` is the `drawItem` hook given to vtt-3l6.6's
  renderer (vtt-1xv.23 wires it): it draws `scene.faces.get(item.id)` with
  `drawFace`; called inside the item's transform, unclipped, after the
  item's own drawing and before object-related overlays and covers, for
  every item whose `faceCullBounds` (vtt-1xv.26) intersect the view.
- `drawFace(ctx, drawing: FaceDrawing, {camera, images, selection,
  transform})`: if `drawing.base` is set (a nested object, review r2
  finding 3), first vtt-3l6.6's `paintItem(ctx, base, {camera, images})`
  (as amended in r2), then the primitives. Text: font size = rect height ×
  {small 0.45, normal 0.6, large 0.8, huge 1.0}, shrunk to fit the width,
  single line with `…`, caption (`cell: `) prefix when set; buttons: rounded
  rect, centred label, disabled (and template) at 40 % alpha; editors: an
  inset outlined box; ink: strokes 0.04 units wide (at least 1 device px),
  `#202020`, round joins; images via the `ImageCache` (placeholder on
  error); gears; contents (review r2 finding 1): `save`, clip to the element
  rect, translate by `-offset`, then per entry its chevron, gear and
  `drawFace(entry.drawing)` under `entry.transform`, for collapsed entries
  (the collapsed drawing) and expanded ones alike (review r3 finding 1), or
  "hidden" for a null drawing, `restore`; a thin scroll indicator when `maxOffset >
  0`; selected entries outlined. A primitive whose vtt-1xv.14
  `screenHeight` (accumulated transform included) is below its `minSize` is
  skipped.

Done when: `RecordingContext` tests (the real vtt-3l6.6 renderer with
`drawItem: drawFaceItem` and `cullBounds: faceCullBounds`) show: a faceless
die whose footprint is just off-screen but whose strip is on-screen has its
strip drawn; a strip below a card is drawn with no clip active; for a faced
card under a region cover every face call precedes the first cover fill and
the selection outline; text sizes by style; a disabled button at 40 % alpha;
an ink stroke's width at two zooms; `minSize` culls a badge, also inside a
scaled entry; inside a rotated container: an expanded faceless note draws
its base (fill, text) then its ink, an image token its base image, a
face-down card only the back and glyph; a scrolled contents element draws
the scrolled rows clipped to its rect and not the rows outside; collapsed
rows of the stocked GM binder draw each template's `name`; a custom
collapsed row draws its value and button;
`pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: the face model and transforms (vtt-1xv.14); scene and hit
testing (vtt-1xv.26); composition (vtt-1xv.23).

Depends on: vtt-1xv.14, vtt-1xv.26, vtt-3l6.6.

---

### M5-k — vtt-1xv.16 — UI: buttons, invoke, inline face editing, default action

Implements: DESIGN.md §4.5 (buttons; the guard says why), §4.6 (Edit in
place on the face; editor elements; double-click; default action), §7 Undo (writes carry the
revision their interaction began on), §5.2; docs/PROTOCOL.md §4 (`invoke`),
§6 (`uncertain`); M4's interaction lifecycle rules (vtt-3l6.23, plan-m4 r2
finding 8, r3 finding 1); M5 plan decisions Q1, Q2, Q11, Q12, Q13 (docs/plans/m5-plan.md §4); review r1
findings 14, 16 (split: entry drags and drops are vtt-1xv.25); review r2
findings 1, 4, 7; review r3 findings 3, 4, 8.

Exclusive files: `packages/ui/src/actions/invoke.ts`,
`packages/ui/src/interaction/face-tool.ts`; post-merge additive edits of
`packages/ui/src/interaction/tool.ts` and `machine.ts` (vtt-3l6.22): `Tool`
gains optional `wheel(state, event, input): {state, effects} | null`, and
the navigation reducer offers a `wheel` event to the active tool's `wheel`
first and zooms the camera only when it returns null (tools without `wheel`
behave as before; vtt-3l6.22's tests still pass); tests
`packages/ui/test/actions/invoke.test.ts`,
`packages/ui/test/interaction/face-tool.test.ts`,
`packages/ui/test/interaction/face-integration.test.tsx`; its sorted index
lines.

- `invoke.ts`: `invokeExtension(session, notices)` is the runtime extension
  handler for `{type: "extension", name: "invoke", stamp, payload: {object,
  action, table, actor?}}` (Q1 A1/A2): `invokeWithRetry(session.client,
  {object, action, base_revision: stamp.baseRevision, table, actor})` (vtt-1xv.11);
  `rejected` → a notice from `describeRejection` (vtt-3l6.3, extended by
  vtt-1xv.7; `when_false` reads "<Action>: its condition is false" and, for the
  GM, adds `when: <source>`); `uncertain` → the sticky notice of
  vtt-3l6.21; never retried beyond `invokeWithRetry`'s single resend.
  `requestInvoke(policy: FacePolicy, view, action, stamp, input): Effect[]`
  is the single UI invocation path (review r2 finding 4), used by face
  buttons, the body double-click and vtt-1xv.19's Run: `policy.canInvoke
  (view)` refused → one notice with its reason and nothing else; the
  action's `action_states` entry disabled → one notice with its reason;
  otherwise the invoke effect with `table` = `{board: stamp.board,
  position: [camera.x, camera.y]}` and `actor` = `{type: "character", id}`
  when the stamp's viewer is a character (Q12).
- `defaultFacePolicy` implements vtt-1xv.14's `FacePolicy`: `canInvoke`
  refuses an object whose `is_template` is true ("Templates are not played:
  drag out a copy", Q13) and allows every other;
  `withFaces(tool, options: WithFacesOptions)` (vtt-1xv.14's contract) wraps
  a Tool (the select tool after vtt-3l6.9's `withHandles`): it computes
  vtt-1xv.26's `attachFaces(input.scene, input.views, faceState, {gm, formatText})` (memoized per scene)
  and on pointer down takes vtt-1xv.26's `faceHitAt`; it first offers the hit to each of
  `options.gestures` in order (`start`; an active gesture then receives every
  event until it ends, and its overlays are added to the tool's), and
  otherwise handles, before delegating:
  - pointer down + up on a button within 4 px → `policy.onButton` or the
    default `requestInvoke` with the stamp captured at pointer down;
  - single click on an editor element, double-click on a value element →
    `open_editor {stamp, object, cell, rect}` (Q1 A5) when vtt-3l6.3's
    `cellCapabilities` allows editing and the viewer is the GM; a formula
    cell focuses the formula bar (vtt-3l6.13's rule);
  - double-click on the body of an object whose face has a
    `default_action` → `requestInvoke` for it (so a template refuses); with
    no `default_action`, delegate (M4's in-place editor);
  - chevron → `policy.onToggle` or the default: `faceState.toggle`, and on
    expanding, `faceState.setScroll(c.container, c.element,
    revealOffset(...))` where `c` is the last entry of the hit's `path` (the
    contents element holding the row), computed from the re-resolved
    drawing (vtt-1xv.14's rule: whole row if it fits, else its top); gear →
    `policy.onGear` (default nothing);
  - wheel (review r2 finding 1, r3 finding 3): the innermost entry of the
    hit's `path` whose contents element overflows (`maxOffset > 0`), or the
    hit's own `contents` target if it overflows, is scrolled by `deltaY /
    100` units, clamped, and the event is consumed; when none overflows →
    null (the camera zooms). So the wheel over a button inside an expanded
    entry scrolls the enclosing list;
  - entry rows and the bodies of contained objects (a `body` hit with a
    non-empty `path`) are claimed by vtt-1xv.25's gesture, which selects on
    click and drags otherwise (review r3 finding 4); buttons and editors of
    a contained object (collapsed or expanded) are handled here as above;
  - anything else → the wrapped tool.
- Lifecycle: every write and invoke carries its stamp; a result arriving
  after a board or viewer change still shows its notice and changes neither
  selection nor tool (vtt-3l6.23's policy).

Done when: reducer tests on fixed face scenes show each gesture's effects
with stamps captured at pointer down although `input.revision` advanced;
integration (jsdom, vtt-3l6.21's helper, the real runtime and `BoardCanvas`
with a recording renderer, the Attack card spawned on the board with a face,
a goblin, scripted dice on the host; `target` set through the inspector):
clicking Roll commits through `invoke` and the face drawn by vtt-1xv.15
updates (recording renderer); Apply is drawn
disabled before the rolls (`show_when: "not applied"` is true, its guard
false) and a press shows the reason and sends nothing (the authority's
revision unchanged); after Roll damage Apply is enabled and a press commits
one group containing the `damage_taken` and `applied` writes (the roll is in
the earlier Roll damage group); after it Apply is no longer drawn; a press on
an Apply drawn enabled from a view that predates another client's Apply
(the press sent before the delta is processed) gets `when_false` from the
authority and a notice; clicking `target`'s editor element opens the
in-place editor at the element's rect; in view-as Aldric a press
records actor Aldric in the log group; a board switch during a pending invoke
shows the result notice and keeps selection; double-clicking a d20 with
`default_action` Roll rolls it, and double-clicking a d20 template with
`default_action` Roll on the board shows the template notice, sends no
request, consumes no dice and leaves the revision unchanged (review r2
finding 4); in a binder with 14 entries in an 8-row list, wheeling over the
list scrolls it (the camera does not zoom), the last entry's chevron is then
hit and expanding its non-template card scrolls it fully into view, and its
button is pressed (review r2 finding 1); wheeling while the pointer is over
a button inside an expanded entry scrolls the enclosing list; expanding a
row inside a binder that is itself an expanded entry of another binder
(two containers deep) scrolls the inner list to reveal it; expanding a sheet
taller than its parent's list aligns its top (review r3 findings 3, 8);
wheeling elsewhere zooms; a gesture registered through
`options.gestures` that claims an entry receives the pointer sequence and
the wrapped tool does not;
`pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: entry drags, drops on editor and contents elements
(vtt-1xv.25); binder rules (working copies, gear; vtt-1xv.17); layout mode (vtt-1xv.18);
composition (vtt-1xv.23); keyboard invocation of buttons (Polish).

Depends on: vtt-1xv.14, vtt-1xv.26, vtt-1xv.15, vtt-1xv.11, vtt-1xv.12, vtt-1xv.28, vtt-3l6.7, vtt-3l6.9, vtt-3l6.13,
vtt-3l6.21, vtt-3l6.22, vtt-3l6.23, vtt-3l6.3.

---

### M5-k2 — vtt-1xv.25 — UI: entry drags, reference drops, container insertion

Implements: DESIGN.md §4.6 (dropping onto editor elements and contents
elements, as written by vtt-1xv.5), §4.7 (drag out of a binder; copy to a
binder), §4.1 (spawn, containment), §7 Undo (writes carry the revision their
interaction began on); docs/PROTOCOL.md §5 (`move`, `spawn`, `set_value`),
§4 (`created` and `copies` records); M4-D8 (copy-versus-move fixed at drag
start); M4's interaction lifecycle rules (vtt-3l6.23); M5 plan decisions Q1
(A4 as amended in r1), Q11, Q14, Q17c (docs/plans/m5-plan.md §4); review r1
findings 9, 16; review r2 finding 2; review r3 findings 2, 4.

Split from vtt-1xv.16 in review r1: entry dragging and the drop behaviour.
Exclusive files: `packages/ui/src/interaction/entry-drag.ts`,
`packages/ui/src/interaction/drop-targets.ts`, tests
`packages/ui/test/interaction/entry-drag.test.ts`,
`packages/ui/test/interaction/drop-targets.test.ts`,
`packages/ui/test/interaction/drop-integration.test.tsx`; its sorted index
lines.

- `entryDragGesture(): FaceGesture` (vtt-1xv.14's contract, passed to
  vtt-1xv.16's `withFaces` in `gestures`): claims a pointer down on an
  `entry` hit, and on a `body` hit whose `path` is non-empty (the body of a
  contained object drawn in an expanded row; review r3 finding 4), the
  dragged object being that entry or child. Pointer up within 4 px is a
  click: it selects that object (`select [id]`, no write; the inspector then
  edits it like any selected object). Beyond 4 px it is a drag with a
  `drag_ghost` overlay; the intent is captured at pointer down (M4-D8):
  exactly one template without Alt → copy (spawn), otherwise move; modifier
  changes later do not change it. On drop the target is vtt-1xv.26's
  `dropTargetAt(scene, point, camera, [dragged])` only (review r3 finding
  2): `editor` → `set_value {object, cell, value: {type: "ref", object:
  dragged}}` and nothing moves or spawns; `contents` of the dragged object's
  own container → nothing (reordering is the inspector's); `contents` of
  another container → with intent copy into a binder (the container's
  `tag` contains `"binder"`) the give-a-template write below, with intent
  copy into any other container an instance `spawn` at the target's `index`
  (`select_created`), with intent move a `move` there; `board` → `spawn`/
  `move` to `{type: "board", board: stamp.board, position}`
  (`select_created` for a spawn).
  One write with the stamp captured at pointer down. Escape, a board or
  viewer change, or a tool switch cancels (no write).
- `faceDropOverride(input, point, draggedIds, intent: {copy: boolean; alt:
  boolean})` for vtt-3l6.7's `dropOverride` hook (amended in r1: called for
  both intents with the intent captured at pointer down, and may return
  `{ops, label, continuations?}`) resolves the drop with the same
  `dropTargetAt`: with exactly one dragged object, a drop
  on another object's editor element → the `set_value` reference write (for
  either intent; nothing moves, no copy); a drop on another object's
  contents element → with `intent.copy` into a binder the give-a-template
  write, with `intent.copy` into any other container a `spawn` of the
  template there at the insertion index with continuations `[{type:
  "select_created", opIndex: 0}]`, otherwise a `move` into it at that
  index;
- Give a template (review r2 finding 2; DESIGN §4.7 as written by
  vtt-1xv.5): one write `[{type: "spawn", template, to: {type:
  "container", container: binder, index}, as: "$copy"}, {type:
  "set_template_flag", object: "$copy", value: true}]`, label "Give
  <template name>", continuations `[{type: "select_created", opIndex:
  0}]`, so the recipient holds a reusable template; anything else → null (the select tool's own drop). Several dragged
  objects → null.
- Lifecycle: writes carry their stamps; a result arriving after a board or
  viewer change shows its notice and changes neither selection nor tool
  (vtt-3l6.23's policy).

Done when: gesture and override tests on fixed face scenes: the intent of an
entry drag and of a board template drag stays as captured when Alt is
pressed or released mid-drag; each drop target produces its ops with the
pointer-down stamp although `input.revision` advanced; integration (jsdom,
vtt-3l6.21's helper, the real runtime with vtt-1xv.16's `withFaces` over the
real select tool created with `dropOverride: faceDropOverride`, `BoardCanvas`
with a recording renderer, the Attack card spawned with its face): dropping
the goblin token on the card's `target` editor writes the reference and
leaves the goblin in place; clicking a card's collapsed row in a binder
selects that contained card (no write) and editing one of its cells in the
inspector writes it; clicking the empty area of an expanded child selects
the child; a dragged card dropped over a collapsed row of another binder is
inserted at that row's index, dropped over a value inside an expanded row's
child is inserted into the outer list (not into the child), dropped over a
list whose rows fill its rect is inserted at the row index; dropping a board template (a d20 template on the
board, no Alt) on a binder's contents element gives a template (one group:
the copy at the index with `is_template` true, selected), dropping it on a
non-binder container's contents element spawns an instance there
(`is_template` false), and dropping it on the card's `target` editor
writes a reference to the template and spawns nothing; dragging a template
entry out of a binder's contents element spawns a copy on the board, and
with Alt held at pointer down moves the template out; dropping a card entry
onto another binder's contents element inserts it at the index; Escape
during an entry drag writes nothing; `pnpm typecheck`, `pnpm lint`,
`pnpm format:check`, `pnpm test` exit 0.

Out of scope: buttons, inline editing and the invoke extension (vtt-1xv.16);
working-copy rules (vtt-1xv.17); reordering within one container (the
inspector's contents list, vtt-3l6.12); cross-board drags.

Depends on: vtt-1xv.16, vtt-1xv.14, vtt-1xv.26, vtt-1xv.12, vtt-3l6.7, vtt-3l6.6,
vtt-3l6.21, vtt-3l6.22, vtt-3l6.23.

---

### M5-l — vtt-1xv.17 — UI: binders, working copies and edit-template

Implements: DESIGN.md §4.7 (binder entries are templates; working copies;
edit-template; drag out), §4.1 (spawn), §8.4 steps 9, 10, 12 (as decided);
M5 plan decisions Q14, Q15, Q17 (docs/plans/m5-plan.md §4); review r1 finding 11; review r2 findings 2, 9; review r3 findings 3, 8.

Exclusive files: `packages/ui/src/binder/binder-policy.ts`,
`packages/ui/src/binder/EditTemplateBanner.tsx`, tests
`packages/ui/test/binder/*.test.ts(x)`; its sorted index lines.

- `binderPolicy({faceState, ui, inputs: RuntimeInputs})` implements vtt-1xv.14's `FacePolicy` (as
  used by vtt-1xv.16's `withFaces`):
  - chevron on a collapsed template entry (review r2 finding 9): the
    working copies are the non-template entries of the same container whose
    `template` cell refers to it; if there are any, the first in contents
    order is selected, expanded and scrolled into view (`revealOffset` on
    the list given by the last entry of the chevron hit's `path`: the whole
    row when it fits, else its top), and
    nothing is written; otherwise one write `spawn {template, to: {type:
    "container", container, index: templateIndex + 1}}` (base revision at
    the click) with the single continuation `{type: "extension", name:
    "expand_created", opIndex: 0, payload: {board, viewer}}` (Q1 A1/A2),
    whose handler (registered by vtt-1xv.23 from this bead's
    `expandCreatedHandler(faceState, ui, inputs)`) selects, expands and
    scrolls the copy into view only if the active board and the viewer
    (`inputs.activeBoard()`, `inputs.viewer()`) still equal the stamp's;
    otherwise it does nothing (the copy still exists). The template itself
    never expands (its face is reached with the gear);
  - chevron on anything else: toggle;
  - gear on a template, from a contents entry or from the gear vtt-1xv.14
    draws on a template object placed directly on a board: select it and show
    `<EditTemplateBanner>` ("Editing template <name>: changes apply to copies
    made from now on") until the selection changes; inspector edits are
    ordinary writes on the template.
- Discarding a working copy is the card's own Discard action or the Delete
  key (card lifetime stays manual, Q17).

Done when: integration tests (jsdom, real authority, real runtime): a binder
object on the board with an Attack card template entry: expanding it spawns
one working copy right after the template, selected and expanded; expanding
again selects and expands that copy instead of spawning; with two working
copies of the template in the binder (the second spawned by protocol) the
first in contents order is chosen; the template's cells are
unchanged after Roll on the copy; a board switch while the spawn write is
pending, and separately a viewer switch, still creates the copy but neither
selects nor expands it; the gear selects the
template and the banner shows; a template token placed directly on the board
(review r1 finding 11): clicking its gear selects it with the banner, an
inspector edit of one of its cells writes the template, and a copy dragged
from it afterwards carries the edit; dragging the working copy out moves it
(vtt-1xv.25's gesture); giving a template (review r2 finding 2): a template entry
dropped on a character's binder contents (tag `binder`) arrives there as a
template (`is_template` true, vtt-1xv.25's give-a-template write); in that
binder, expanding it spawns a working copy, discarding the copy (its
Discard action, or Delete) leaves the received template, and expanding
again spawns a new working copy; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
`pnpm test` exit 0.

Out of scope: "save to template" and propagation (vtt-y1w.3); ephemeral
cards (Q17); the inspector itself (M4); composition (vtt-1xv.23).

Depends on: vtt-1xv.16, vtt-1xv.25, vtt-1xv.14, vtt-3l6.21, vtt-3l6.23.

---

### M5-m — vtt-1xv.18 — UI: layout operations and Face section

Implements: DESIGN.md §4.6 (The inspector; face elements, show-when,
collapsed face, as written by vtt-1xv.5), §7 Undo; docs/PROTOCOL.md §5
(`set_face`), §6; M5 plan decisions Q8, Q9 (docs/plans/m5-plan.md §4);
review r2 finding 13 (split: the canvas layout tool and cell drops are
vtt-1xv.27).

Exclusive files: `packages/ui/src/face-editor/face-ops.ts`,
`FaceSection.tsx`, tests `packages/ui/test/face-editor/face-ops.test.ts`,
`face-section.test.tsx`; its sorted index lines.

- `face-ops.ts` (pure): `addElement`, `moveElement`, `resizeElement`,
  `removeElement`, `reorderElement`, `setElementField`, `addCellElement
  (face | null, view, cell, point)` (a value element for `cell` at the
  object-local `point`, 2 × 0.6 units, clamped into the frame; a null face
  starts from `defaultLayoutFor(view)`), `defaultLayoutFor(view)` ("Create
  face": a `name` value element across the top, one row per user cell with
  captions, one button per action) — each returns a new `FaceLayout`
  validated with vtt-1xv.7's `faceProblem` (an invalid result is reported to
  the caller, which shows a notice and writes nothing) — and
  `setFaceOps(object, face) → [set_face]`.
- `<FaceSection session ui>` (rendered in the inspector by vtt-1xv.23; GM
  only, read-only in view-as): tabs Full / Collapsed; each element with
  kind, cell or action picker, `x y w h`, `show_when` (parse-checked as
  typed with `@vtt/formula`'s `parse`; empty clears), `min_size`, style,
  entries mode; add value / editor / button / contents; up/down; delete;
  default action; "Create face" when there is none; "Remove face"
  (`set_face null`). Text fields capture the base revision on focus and
  write on Enter or blur (unchanged input writes nothing); buttons at the
  click.

Done when: pure tests for each op, `addCellElement` (clamping; from a null
face) and `defaultLayoutFor`; jsdom tests with vtt-3l6.21's helper: editing
`x` writes one `set_face` and one undo restores it; editing `show_when` to
`hp < 5` writes it and a parse error blocks the write; a concurrent
`set_face` by another client between focus and Enter yields a `stale_write`
notice and keeps the other client's face; Create face then Remove face; the
Collapsed tab edits the collapsed list; the section is read-only as Aldric;
`pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: the canvas layout tool, inspector-cell drag and drop
(vtt-1xv.27); template propagation; composition (vtt-1xv.23).

Depends on: vtt-1xv.7, vtt-1xv.12, vtt-1xv.5, vtt-3l6.11, vtt-3l6.21.

---

### M5-m2 — vtt-1xv.27 — UI: layout tool and cell drops

Implements: DESIGN.md §4.6 (The inspector: "A layout mode lets the GM drag
cells onto the face", as written by vtt-1xv.5), §7 Undo; docs/PROTOCOL.md
§5 (`set_face`), §6; M5 plan decisions Q1 (A1 tool id, A2 data-drop
handlers, A3 data drop), Q8 (docs/plans/m5-plan.md §4); review r1 finding
10; review r2 findings 7, 13 (split from vtt-1xv.18); review r3 finding 5.

Exclusive files: `packages/ui/src/face-editor/layout-tool.ts`,
`cell-drop.ts`, tests `packages/ui/test/face-editor/layout-tool.test.ts`,
`cell-drop.test.ts`, `layout-integration.test.tsx`; post-merge edit of
`packages/ui/src/inspector/CellRow.tsx` (vtt-3l6.11): rows become drag
sources of `application/x-vtt-cell` with data `{object, cell}`; its sorted
index lines.

- Tool `layout` (registered in vtt-3l6.22's registry by vtt-1xv.23): with
  exactly one selected board object, outlines its elements (vtt-1xv.26's
  scene for positions) and draws `handles` overlays; drag an element body to
  move (snap 0.05 units), a handle to resize (minimum 0.1); Delete removes
  the selected element; Escape returns to `select`; each gesture is one
  `set_face` write (vtt-1xv.18's ops) with the whole new layout and the base
  revision captured at pointer down; a board or viewer change cancels an
  unfinished gesture.
- `cell-drop.ts`: `cellDropHandler: DataDropHandler` (vtt-3l6.23's type;
  vtt-1xv.23 registers it in the runtime's `dataDropHandlers`, consulted
  before the active tool for every `data_drop`): for mime
  `application/x-vtt-cell` with data `{object, cell}`, when the viewer is
  the GM and vtt-1xv.26's `faceHitAt` at the drop point hits that same
  object (any target on it; the object may be on the board or contained
  and drawn in a binder row), it converts the drop point to that object's
  frame with the hit's `toLocal` (vtt-1xv.14's contract: the board item's
  inverse transform, composed with the inverse entry transforms along
  `path` for a contained object) and returns the effects of one `set_face`
  write of `addCellElement(face, view, cell, localPoint)` stamped at the
  drop;
  otherwise (other mime, another object, view-as) null.

Done when: reducer tests for move, resize, Delete and Escape with stamps
captured at pointer down; integration (jsdom, vtt-3l6.21's helper, the real
runtime with `dataDropHandlers: [cellDropHandler]`, `BoardCanvas` with a
recording renderer, the real `CellRow`): dragging an element moves it and one
undo restores it; resizing clamps; dropping the `hp` row onto a token placed
at `[7, 3]` and rotated 90° adds an `hp` element at the drop point's
object-local coordinates (asserted numerically), and dropping a contained
card's cell row on that card drawn expanded in a binder adds the element at
its local point; dropping the `hp` row onto its token adds
an `hp` element both while `select` is active and while vtt-1xv.21's `ink`
tool is active (the ink tool receives no event for it); a drop on another
object or with another mime is not handled; `pnpm typecheck`, `pnpm lint`,
`pnpm format:check`, `pnpm test` exit 0.

Out of scope: the Face section (vtt-1xv.18); handles on contained entries
(vtt-qf5.30); composition (vtt-1xv.23).

Depends on: vtt-1xv.18, vtt-1xv.26, vtt-1xv.21, vtt-3l6.11, vtt-3l6.21,
vtt-3l6.22, vtt-3l6.23, vtt-3l6.6.

---

### M5-n — vtt-1xv.19 — UI: action editing and Run in the inspector

Implements: DESIGN.md §4.5 ("The inspector shows an action's steps and
precondition and lets the GM edit them, exactly as it does for formulas"),
§4.6 The inspector, §5.2; FORMULAS.md §8 (step grammar); docs/PROTOCOL.md §5
(`set_actions`), §9 (`explain_action`); M5 plan decisions Q3, Q13.

Takes over vtt-3l6.12's read-only `ActionsList`. Exclusive files: post-merge
rewrite of `packages/ui/src/inspector/ActionsList.tsx`; new
`packages/ui/src/inspector/ActionEditor.tsx`, `action-ops.ts`; tests
`packages/ui/test/inspector/actions-edit.test.tsx`, `action-ops.test.ts`
(vtt-3l6.12's `panel.test.tsx` assertions about read-only actions are
updated in place, one test).

- GM: each action shows name, enabled state (vtt-1xv.12's `ObjectView.action_states`: `enabled`,
  `reason`),
  `when` and steps; "Edit" opens `ActionEditor` (name, `when`, one input per
  step, add/remove/reorder steps) capturing the base revision; each field is
  parse-checked as typed (`parse` for `when`, vtt-1xv.6's `parseStep` for steps,
  message and caret at the offset); Save writes one `set_actions` with the
  whole list (this action replaced) unless unchanged; client-side checks
  mirror `setActions`' refusals (name 1–100 chars, unique by exact
  comparison, non-blank `when` and steps) and block the write. Add action,
  Delete, Rename, Move up/down are each one `set_actions` at the click.
- "Run" per action → vtt-1xv.16's `requestInvoke(policy, view, action,
  stamp, input)` with a stamp taken at the click, its effects executed
  through the runtime (`ActionsList` takes the `policy` and runtime as
  props; vtt-1xv.23 passes the composed binder policy), so the template
  refusal and the disabled-reason notice are the same single check as face
  buttons (review r2 finding 4); the button is drawn disabled with the reason
  when `canInvoke` refuses or the action is not enabled.
- Character view (view-as): names and enabled state (`action_states`) only, no editing.

Done when: jsdom tests with a real authority: adding an action with an
invalid step shows the parse message and sends nothing; fixing it saves one
group; renaming to a duplicate is blocked; a concurrent `set_actions` by
another client between Edit and Save yields `stale_write` and keeps the
editor text; Run on the Attack card's Roll commits; Run on a disabled action
shows the reason; Run is disabled on a template and, when forced (a click dispatched on it), sends no request; as Aldric only names and
states show; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`
exit 0.

Out of scope: autocomplete (vtt-qf5.16); a step builder UI (steps are
typed); face buttons (vtt-1xv.16).

Depends on: vtt-1xv.6, vtt-1xv.16, vtt-1xv.12, vtt-3l6.12, vtt-3l6.21.

---

### M5-o — vtt-1xv.20 — UI: log panel

Implements: DESIGN.md §4.8 (the log panel rendered from the operation
stream, sentences, filterable, links, names at the time), §4.4 (the log
filtered by current visibility), §7 Undo (any group, by index), §8.4 step 14
("Scroll the log back"); docs/PROTOCOL.md §4 (`log`, `undo` group target),
§7.6, §8 (log scope); M5 plan decisions Q20 (docs/plans/m5-plan.md §4); M3 input
5, M4 input 6; review r1 findings 4, 12, 14; review r3 finding 9.

Exclusive files: `packages/ui/src/log/log-session.ts`, `sentences.ts`,
`LogPanel.tsx`, tests `packages/ui/test/log/*`; its sorted index lines.

- `createLogSession(session)`: subscribes `{type: "log"}` with the current
  viewer through `session.client`; on a viewer change subscribes the new one
  before unsubscribing the old (no empty frame) and drops older pages; reads
  the mirror's window; `loadOlder()` → `log {before: oldest index, limit: 50,
  viewer, effects: true}`, appended, deduplicated by index; responses for a
  viewer or session other than the current are dropped; a `failed`
  subscription is a connection notice (vtt-3l6.21).
- Older pages form a chain (review r1 finding 12, r3 finding 9; PROTOCOL
  §7.6 filters by current visibility, and `log` limits the *visible* groups
  it returns, so page boundaries move when visibility changes). The chain's
  fixed upper boundary is set when the first older page is loaded: the
  lowest index in the live window, or, when the viewer's window holds no
  groups, the `next_index` of a `log {limit: 1, viewer}` response (so paging
  starts below the newest group). Page 1 is `log {before: boundary, limit:
  50, viewer, effects: true}`; page k+1 uses `before` = the lowest index
  page k returned; the chain ends when a page returns fewer than 50 groups
  or its lowest index is `first_index`. Invalidation marks the whole chain
  stale: for a character viewer on every commit (the client cannot tell
  which commits are visibility-relevant); for the GM viewer on a commit
  whose group is an undo whose `undoes` index is at or below the boundary;
  for every viewer on a resync and on a session change. A stale chain keeps
  showing its last content marked "refreshing" and is rebuilt in order from
  the same boundary, each page's `before` derived from its refreshed
  predecessor, page by page as the pages are rendered in view (an
  `IntersectionObserver` when available, else on the next render). Each
  request is tagged with the revision and chain generation it was made at;
  a response is applied only if the generation, viewer and session are
  unchanged, otherwise dropped.
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
authority, actions invoked through vtt-1xv.11's `invoke` with scripted dice:
the Attack card's Apply shows one group "GM: Apply" whose sentences are the
`damage_taken` write ("0 → 8") and the `applied` write, and the roll is a
sentence of the earlier "GM: Roll damage" group; undoing the Apply group from the panel restores the
cell and strikes it through; undoing an agent's group (a second client with
`kind: "agent"`) works while Ctrl+Z (`mine`) would not reach it; an undo that
conflicts shows the message; as Aldric, a group touching only GM-only cells
is absent and a mixed one has no label; "Load older" after 260 groups pages
past the 200 window; with older pages loaded, as Aldric, hiding an object
whose effects appear only in those pages removes them after the rebuild, and
revealing groups that cross a page boundary yields a gap-free chain (every
visible group below the boundary appears once, in order); as the GM, undoing
a group in a loaded page from a second client strikes it through after the
rebuild; as Aldric with a window that shows no groups (all recent groups
touch only GM-only cells), "Load older" still reaches older visible groups;
a response from a superseded generation is dropped; switching viewer at an unchanged revision replaces the
list without an empty frame; `pnpm typecheck`, `pnpm lint`,
`pnpm format:check`, `pnpm test` exit 0.

Out of scope: communication (vtt-y1w.5); historical action definitions (Q20);
time stamps (groups have none); composition (vtt-1xv.23).

Depends on: vtt-1xv.5, vtt-1xv.11, vtt-3l6.4, vtt-3l6.21, vtt-3l6.3, vtt-5su.20.

---

### M5-p — vtt-1xv.21 — UI: freehand ink and text tools

Implements: DESIGN.md §4.1 (ink is a cell value), §8.1 ("Freehand drawing
and text, so improvisation is cheap"), §8.4 step 6 ("Scribble … in ink on a
sticky note"), §4.6 Ink and text (as written by vtt-1xv.5); docs/PROTOCOL.md §5
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
(vtt-1xv.14 model) and is drawn (vtt-1xv.15, recording renderer); a stroke on empty
board creates an `ink_<n>` object; a concurrent write to the note's `ink`
between pointer down and up yields `stale_write`; the text tool creates a
`text_<n>` object and opens the editor; `pnpm typecheck`, `pnpm lint`,
`pnpm format:check`, `pnpm test` exit 0.

Out of scope: erasing strokes (undo, or replace the value in the inspector);
pen pressure and colours (Polish); handwriting recognition.

Depends on: vtt-1xv.14, vtt-1xv.15, vtt-3l6.5, vtt-3l6.13, vtt-3l6.19, vtt-3l6.21,
vtt-3l6.22, vtt-3l6.23.

---

### M5-q — vtt-1xv.22 — Authority: example templates and stocked new tables

Implements: DESIGN.md §8.1 (example templates: die, token, zone, card,
sheet, sticky note, stack, hand, binder, character, Attack, Damage and Area
Save cards; "examples, not shipped game content"), §8.4 steps 1, 2, 9, 10,
12, §4.7 (binders, per-character binder holding an Attack card), §5.3
(human-meaningful ids), §7 New tables (as amended by vtt-1xv.5); FORMULAS.md §10;
M5 plan decisions Q18, Q14 (docs/plans/m5-plan.md §4); review r2 finding 10; review r3 finding 10.

Exclusive files: `packages/authority/src/host/examples.ts`, tests
`packages/authority/test/host/examples.test.ts`,
`packages/authority/test/host/stocked-table.test.ts`; its sorted index line;
post-merge additive edits: `packages/authority/src/host/table-host.ts` (an
`open` option `newTable?: () => Snapshot`, default `newTableSnapshot`;
vtt-5su.4, after vtt-3l6.25), `packages/authority/src/bin/serve.ts` (missing
files are created with `stockedTableSnapshot`; flag `--empty` keeps the
empty table; vtt-5su.14, after vtt-3l6.15).

- `exampleObjects(): Record<ObjectId, SceneObject>` and
  `stockedTableSnapshot(): Snapshot` (= `newTableSnapshot()` plus
  `gm_binder` and its subtree) copy vtt-1xv.5's section 4 records verbatim
  (review r2 finding 10): every id, shape, tag, flag, cell with its initial
  value, action, face element with its rect and options, the `gm_binder`
  contents order, and the Area Save `caster` rule (left `empty`, set by
  dropping a token on the `caster` editor; the save row's guard requires
  `card.caster != empty`). Nothing is chosen here; a record that does not
  validate is a defect in vtt-1xv.5 reported to the orchestrator, not fixed
  locally. `next_seq` stays 1.

Done when: tests show every formula parses, every `when` and step parses
with vtt-1xv.6, every face passes `faceProblem`, the snapshot passes the file
schema and `serializeTable`/`parseTable`; executor flows (`createExecutor({handlers: [...coreHandlers,
...placementHandlers]})`) on a `Table` from the stocked snapshot (review r3
finding 10). The template records are not edited; only these user
preparation writes (as the GM would make them in the UI) are allowed:
spawn `tpl_character` onto `gm_board` at `[0, 0]` and set its sheet's
`attack_bonus` 5 and `spell_dc` 14; spawn `tpl_token` twice, at `[10, 0]`
(token A) then `[11, 0]` (token B), and set on each `ac` 13, `max_hp` 30 and
`dex_save` (A: 2, B: 0); set the cards' `target`/`caster` as listed; move
the Area Save zone onto `gm_board` at `[10.5, 0]`. Scripted dice, in order:
`1d20` → 12 (the d20), `1d20` → 10 and `1d8` → 6 (the attack), `8d6` →
[3, 5, 2, 6, 4, 1, 6, 1] (total 28), `1d20` → 15 (A's save), `1d20` → 5
(B's save), with no entries left over. Asserted: spawning `tpl_d20` and
Roll gives `total` 12; the character's binder copy of the Attack card has
`attacker` equal to the new character; its working copy (spawned into that
binder) with `target` = A: Roll → `hit` true (10 + 5 ≥ 13), Roll damage →
`dmg` 6, Apply → A's `damage_taken` 6 and `hp` 24, a second Apply refused
`when_false`; the Area Save card spawned onto the board with `caster` = the
character: `dc` 14, `targets` = [A, B] in that order after the zone move;
Lock targets → two rows with `target` A and B in that order; Roll damage →
`damage` 28; A's row: `passed` true, `damage_dealt` 14; B's row: `passed`
false, `damage_dealt` the 28 roll; Apply all → A's `damage_taken` 20, B's
28; Discard → the zone, the card and both rows no longer exist (recursive
removal), the tokens remain;
`vtt-serve` on a missing file creates
the stocked table and `--empty` an empty one (temp directory, the real
binary as vtt-5su.14's tests run it); `pnpm typecheck`, `pnpm lint`,
`pnpm format:check`, `pnpm test` exit 0.

Out of scope: system-specific content (DESIGN §8.3); template propagation;
UI behaviour (vtt-1xv.16, vtt-1xv.17); MCP prompts.

Depends on: vtt-1xv.6, vtt-1xv.7, vtt-1xv.8, vtt-1xv.9, vtt-1xv.5, vtt-5su.4, vtt-5su.14,
vtt-3l6.25, vtt-3l6.15.

---

### M5-y — vtt-1xv.23 — UI: app composition for faces, panels and tools

Implements: DESIGN.md §7 Platform (canvas scene, DOM chrome: inspector,
formula bar, log), §4.5–§4.8 (as written by vtt-1xv.5), §8.1; M4's composition
rules (vtt-3l6.17: render order objects, object overlays, covers, chrome);
M5 plan decisions Q1, Q12, Q19, Q20 (docs/plans/m5-plan.md §4); review r1
findings 8, 10, 11; review r2 findings 1, 4, 13.

Exclusive files: tests `packages/ui/test/app/m5-composition.test.tsx`;
post-merge edits of `packages/ui/src/App.tsx`, `src/app/Toolbar.tsx`,
`src/app/keybindings.ts` (vtt-3l6.17) and
`src/inspector/Inspector.tsx` (vtt-3l6.12).

- The board canvas is fed vtt-1xv.26's `buildFaceScene` with one
  `FaceStateStore` (vtt-1xv.14) per session; the renderer is created with
  vtt-1xv.15's `drawFaceItem` as its `drawItem` hook and vtt-1xv.26's
  `faceCullBounds` as its `cullBounds` (vtt-3l6.6 as amended); the tool
  registry holds `withFaces(withHandles(createSelectTool({dropOverride:
  faceDropOverride})), {faceState, policy: binderPolicy({faceState, ui,
  inputs}), gestures: [entryDragGesture()]})` (vtt-1xv.16, vtt-1xv.25,
  vtt-1xv.17) plus `layout` (vtt-1xv.27), `ink`, `text` (vtt-1xv.21); the
  runtime gets the extensions `invoke` (vtt-1xv.16), `expand_created`
  (vtt-1xv.17's `expandCreatedHandler`), `edit_created` (vtt-1xv.21) and the
  data-drop handlers `[cellDropHandler]` (vtt-1xv.27; vtt-3l6.23 as
  amended); `ActionsList` (vtt-1xv.19) receives the same policy and the
  runtime.
- Right column tabs "Inspector" / "Log" (vtt-1xv.20); the inspector renders
  `EditTemplateBanner` (vtt-1xv.17), vtt-1xv.19's `ActionsList` and vtt-1xv.18's `FaceSection`
  after the cells.
- Toolbar and keys: L layout mode, D ink, W text (none in text fields).

Done when: jsdom tests with an in-process authority (a stocked table from
vtt-1xv.22, scripted dice) and a recording renderer show: the GM binder's face is
drawn with collapsed entries; wheeling over its contents element scrolls it
to the last entry, `tpl_d20`, whose expansion spawns a working copy that is
scrolled into view and whose Roll button is pressed (review r2 finding 1); dragging `tpl_d20` out spawns a die and
double-clicking it rolls; the Attack card working-copy flow from the binder
updates its face and a log entry appears in the Log tab; face calls precede
covers in a character view; a faceless die whose footprint is just off
screen but whose button strip is on screen has its strip drawn and pressable;
dropping an inspector cell row on its object adds a face element while
`select` is active and while `ink` is active; a template token placed
directly on the board shows a gear that selects it with the edit-template
banner, and double-clicking that template (its `default_action`) sends no
request; Run on a template in the inspector sends no request (review r2
finding 4); L, D and W switch tools; the inspector shows
the Face section and the action editor for a selected card; the M4 app
tests still pass; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
`pnpm test` exit 0.

Out of scope: new behaviour beyond wiring; keyboard help (vtt-qf5.17).

Depends on: vtt-1xv.14, vtt-1xv.26, vtt-1xv.15, vtt-1xv.16, vtt-1xv.25, vtt-1xv.27, vtt-1xv.17, vtt-1xv.18, vtt-1xv.19, vtt-1xv.20, vtt-1xv.21, vtt-1xv.22,
vtt-3l6.17, vtt-3l6.12, vtt-3l6.9, vtt-3l6.6, vtt-3l6.23.

---

### M5-z — vtt-1xv.24 — Epic acceptance: every §10 fixture end to end in the UI (P2)

Implements: the epic vtt-1xv Done-when ("every §10 fixture passes end to end
in the UI") as interpreted by M5 plan decision Q16 (docs/plans/m5-plan.md §4;
also a comment on vtt-1xv); FORMULAS.md §10; FIXTURES.md §1–§9; review r1
finding 13; review r2 finding 12.

Exclusive files: `packages/ui/test/acceptance/fixtures-ui.test.tsx`,
`packages/ui/test/acceptance/ui-fixture-driver.ts`. Adds `@vtt/fixtures` as
a workspace devDependency of `@vtt/ui` (`pnpm install`, lockfile in the same
commit).

- For each of the ten scenarios: an in-process authority over
  `documentFromSetup` (from the `@vtt/authority/test-runner` subpath that
  vtt-1xv.10 adds, Q21) with a `ScriptedDiceSource` of the scenario's script;
  the real `<App>` (vtt-1xv.23) in jsdom with a recording renderer. Fixture
  objects have no layouts (except the Attack card's face, vtt-1xv.10), so
  their buttons and contained objects are reached through the default face
  (Q11): the button strip, and the contents list whose non-template entries
  the driver expands (UI-local state, no write; the driver never expands a
  template entry, which would spawn a working copy).
- Navigation (review r2 finding 12): before a click, suppressed or edit
  step the driver makes active the board of the target object's outermost
  container (Fireball's `fb1` and its rows: `shelf`, where `aldric_binder`
  stands); before a drag, the destination board (all drags are within one
  board; Fireball's step 5: `map`); fixture objects are never relocated to
  make a click possible. The matrix's Board column states it (the edit
  target is selected on its board by a click, then edited in the
  inspector; a contained target, such as Fireball's rows, is selected by
  clicking its row, vtt-1xv.25's entry click; review r3 finding 4).
- Action state is never read from button visibility: `action` expectations
  read `action_states` from the expectation's viewer's object view (GM by
  default); `face_element` reads the drawn face of that viewer (and, for an
  element not drawn, asserts its absence). Every other expectation is
  checked through `get_objects`/`log` with the expectation's viewer.
- Paths: **click** = view-as the step's actor (the GM view for `gm`), the
  driver asserts the button is drawn and enabled, then clicks it (located
  with `faceHitAt` on the app's face scene); **suppressed** = the driver
  asserts the UI suppression (button not drawn, or drawn disabled and a
  press sends nothing: the authority's revision is unchanged), then sends
  the `invoke` through the app's own `session.client` with the step's actor
  and asserts the predicted refusal; **drag** = a canvas drag by the GM (an
  entry drag out of a default contents list when the object starts
  contained); **edit** = the GM types into the inspector's value cell (into
  the face editor when the cell has one), `clear_override` = the formula
  bar's Clear; **log** = the log panel's Undo on the newest group that is
  neither undone nor an undo; **protocol** = the app's own `session.client`
  (same connection; reason given).

Fixed matrix (every step of the ten scenarios; step indices 0-based):

| Scenario | Step | Actor | Step | Path | Board | Reason |
|---|---|---|---|---|---|---|
| attack-card | 0 | aldric | spawn attack_card → board, `cells` | protocol | — (protocol) | initial cells have no gesture |
| attack-card | 1 | aldric | set attack1.target | protocol | — (protocol) | non-invoke step by a character (the UI edits only as the GM, M4-D11) |
| attack-card | 2 | aldric | invoke Roll | click | table |  |
| attack-card | 3 | aldric | invoke Roll damage | click | table |  |
| attack-card | 4 | aldric | invoke Apply | click | table |  |
| attack-card | 5 | aldric | invoke Apply (refused `when_false`) | suppressed | table | Apply not drawn (`show_when: "not applied"` false) |
| attack-card | 6 | gm | undo | log | table |  |
| dice-tray | 0, 1, 2 | gm | invoke Roll on die_a, die_b, die_c | click | table |  |
| dice-tray | 3, 4, 5 | gm | move die_a, die_b, gold → board | drag | table |  |
| dice-tray | 6, 7 | gm | move die_c, die_a → cup (index) | protocol | — (protocol) | container moves with an index |
| dice-tray | 8 | gm | move die_c (in cup) → board | drag | table | entry drag from the cup's contents list |
| dice-tray | 9 | gm | move die_b → board | drag | table |  |
| die-with-modifier | 0, 2, 5 | gm | spawn d20 → board (2 and 5 with `cells`) | protocol | — (protocol) | `as` bindings (and initial cells in 2 and 5) have no gesture |
| die-with-modifier | 1, 6 | gm | invoke Roll on gm_die, goblin_die | click | table |  |
| die-with-modifier | 3 | aldric | invoke Roll on aldric_die | click | table |  |
| die-with-modifier | 4 | gm | set aldric.attack_bonus | edit | table |  |
| difficult-terrain | 0–3 | gm | move aldric → board | drag | table |  |
| drawing-a-card | 0, 1 | aldric | invoke Draw | click | table |  |
| drawing-a-card | 2 | aldric | invoke Draw (refused `when_false`) | suppressed | table | Draw drawn disabled (empty deck) |
| drawing-a-card | 3 | aldric | move card_ace → board | protocol | — (protocol) | non-invoke step by a character |
| fireball | 0 | aldric | spawn fireball → aldric_binder, `cells`, `owned` | protocol | — (protocol) | initial cells and `owned` bindings |
| fireball | 1 | aldric | move zone1 → board | protocol | — (protocol) | non-invoke step by a character |
| fireball | 2 | aldric | invoke Lock targets on fb1 | click | shelf | fb1 expanded in aldric_binder's contents list |
| fireball | 3, 4 | — | bind row_g1, row_g2 | protocol | — (protocol) | `bind` reads only (no write) |
| fireball | 5 | gm | move zone1 → board | drag | map |  |
| fireball | 6 | aldric | invoke Roll damage on fb1 | click | shelf |  |
| fireball | 7 | goblin1 | invoke Roll save on row_g1 | click | shelf | row_g1 expanded inside fb1 (aldric_binder is visible to all) |
| fireball | 8 | gm | invoke Roll save on row_g2 | click | shelf |  |
| fireball | 9 | aldric | invoke Apply all on fb1 | click | shelf |  |
| fireball | 10 | gm | set goblin1.dex_save | edit | map |  |
| fireball | 11 | aldric | invoke Discard on fb1 | click | shelf |  |
| goblin-hit | 0 | gm | move die1 (in dice_bag) → board | drag | table | entry drag from dice_bag's contents list |
| goblin-hit | 1, 3 | gm | set die1.z | edit | table |  |
| goblin-hit | 2, 5 | gm | move die1, goblin1 → board | drag | table |  |
| goblin-hit | 4 | aldric | invoke Roll on die1 | click | table |  |
| hit-points | 0, 2 | gm | set aldric.damage_taken | edit | table |  |
| hit-points | 1 | gm | override aldric.hp | edit | table |  |
| hit-points | 3 | gm | clear_override aldric.hp | edit (formula bar Clear) | table |  |
| hit-points | 4 | gm | undo | log | table |  |
| re-hiding-room | 0, 1, 2, 4 | gm | move aldric → board | drag | table |  |
| re-hiding-room | 3 | gm | override room.visible_to | edit | table |  |
| re-hiding-room | 5 | gm | clear_override room.visible_to | edit (formula bar Clear) | table |  |
| shuffling | 0 | gm | invoke Shuffle on stack | click | table |  |
| shuffling | 1 | gm | undo | log | table |  |

If the scenario files differ from this table when the bead is worked
(a step added or moved), the bead is defective and goes back to the
orchestrator; the driver does not choose paths.
- The test asserts all ten complete, zero leftover dice, every expectation
  holding, and the path taken per step equal to the matrix (the driver
  records it).
- A manual checklist (not gating) for §8.4 steps 9–12 in a real browser is
  written into this bead's close comment and posted on vtt-1xv and vtt-nb8
  (M4 decision Q16).

Done when: the acceptance test passes for all ten scenarios with the matrix
above; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit
0.

Out of scope: §8.4 in full (M6, vtt-nb8); browser automation; performance.

Depends on: vtt-1xv.23, vtt-1xv.10, vtt-1xv.13, vtt-1xv.22.

---

## 3. Dependency digraph

```
vtt-3l6.2, vtt-5su.2 ─► M5-0
M5-0 ─► M5-a, M5-b, M5-c, M5-e, M5-f, M5-g, M5-i, M5-o, M5-q
vtt-5su.3, vtt-5su.6, vtt-3l6.3 ─► M5-b0 ─► M5-b, M5-c, M5-e, M5-f, M5-g, M5-k   (r3)
vtt-5su.5, vtt-5su.6, vtt-3l6.19 ─► M5-b
M5-a ─► M5-c, M5-f, M5-n, M5-q
M5-b ─► M5-c, M5-e, M5-f, M5-g, M5-i, M5-m, M5-q
M5-c ─► M5-d, M5-e, M5-f, M5-q
M5-d ─► M5-e, M5-f, M5-q
vtt-5su.10, vtt-5su.5, vtt-5su.16, vtt-5su.19, vtt-5su.7 ─► M5-f
vtt-5su.6, vtt-5su.9 ─► M5-g
M5-e, M5-f, M5-g ─► M5-h ◄─ vtt-5su.11, vtt-5su.12, vtt-5su.15, vtt-5su.17
M5-g ─► M5-i, M5-k, M5-n           vtt-3l6.5, vtt-3l6.3 ─► M5-i
M5-i ─► M5-i2 ─► M5-j, M5-k, M5-k2, M5-m2      M5-j ─► M5-k, M5-p
M5-i ─► M5-l, M5-p      M5-m ─► M5-m2 ◄─ M5-p, vtt-3l6.6, .11, .21, .22, .23
M5-g ─► M5-e (r2)
M5-f ─► M5-k ◄─ vtt-3l6.7, .9, .13, .21, .22, .23, .3
M5-k ─► M5-k2 ◄─ vtt-3l6.7, .6, .21, .22, .23   (M5-i, M5-g ─► M5-k2)
M5-k, M5-k2 ─► M5-l      M5-k ─► M5-n
M5-f ─► M5-g, M5-o (review r1)      vtt-3l6.20 ─► M5-h
vtt-3l6.11, .21, .22, .23 ─► M5-m        vtt-3l6.12, .21 ─► M5-n
vtt-3l6.4, .21, .3, vtt-5su.20 ─► M5-o
M5-j ─► M5-p ◄─ vtt-3l6.5, .13, .19, .21, .22, .23
vtt-5su.4, vtt-5su.14, vtt-3l6.25, vtt-3l6.15 ─► M5-q
M5-i, j, k, k2, l, m, n, o, p, q ─► M5-y ◄─ vtt-3l6.17, vtt-3l6.12, vtt-3l6.9, vtt-3l6.6, vtt-3l6.23
M5-y, M5-e, M5-h, M5-q ─► M5-z
```

Edges recorded with `bd dep add <dependent> <blocker>` (after review r3):

- M5-0 (vtt-1xv.5): vtt-3l6.2, vtt-5su.2
- M5-a (vtt-1xv.6): M5-0 (vtt-1xv.5)
- M5-b0 (vtt-1xv.28): vtt-5su.3, M5-0 (vtt-1xv.5), vtt-5su.6, vtt-3l6.3
- M5-b (vtt-1xv.7): vtt-5su.5, vtt-3l6.19, M5-b0 (vtt-1xv.28), M5-0 (vtt-1xv.5), vtt-5su.6
- M5-c (vtt-1xv.8): M5-b0 (vtt-1xv.28), M5-a (vtt-1xv.6), M5-0 (vtt-1xv.5)
- M5-d (vtt-1xv.9): M5-c (vtt-1xv.8)
- M5-e (vtt-1xv.10): M5-d (vtt-1xv.9), M5-b0 (vtt-1xv.28), M5-0 (vtt-1xv.5), M5-b (vtt-1xv.7), M5-c (vtt-1xv.8), M5-g (vtt-1xv.12)
- M5-f (vtt-1xv.11): M5-b0 (vtt-1xv.28), M5-c (vtt-1xv.8), vtt-5su.10, M5-b (vtt-1xv.7), M5-0 (vtt-1xv.5), vtt-5su.19, vtt-5su.5, M5-a (vtt-1xv.6), vtt-5su.7, vtt-5su.16, M5-d (vtt-1xv.9)
- M5-g (vtt-1xv.12): vtt-5su.9, M5-0 (vtt-1xv.5), M5-f (vtt-1xv.11), vtt-5su.6, M5-b (vtt-1xv.7), M5-b0 (vtt-1xv.28)
- M5-h (vtt-1xv.13): M5-g (vtt-1xv.12), M5-e (vtt-1xv.10), vtt-5su.12, vtt-5su.11, vtt-3l6.20, vtt-5su.15, M5-f (vtt-1xv.11), vtt-5su.17
- M5-i (vtt-1xv.14): vtt-3l6.3, M5-0 (vtt-1xv.5), vtt-3l6.22, M5-b (vtt-1xv.7), M5-g (vtt-1xv.12), vtt-3l6.5
- M5-i2 (vtt-1xv.26): M5-i (vtt-1xv.14), vtt-3l6.5
- M5-j (vtt-1xv.15): vtt-3l6.6, M5-i2 (vtt-1xv.26), M5-i (vtt-1xv.14)
- M5-k (vtt-1xv.16): vtt-3l6.22, M5-g (vtt-1xv.12), M5-b0 (vtt-1xv.28), M5-i2 (vtt-1xv.26), vtt-3l6.3, vtt-3l6.23, vtt-3l6.9, vtt-3l6.7, M5-j (vtt-1xv.15), M5-f (vtt-1xv.11), M5-i (vtt-1xv.14), vtt-3l6.13, vtt-3l6.21
- M5-k2 (vtt-1xv.25): M5-i (vtt-1xv.14), M5-k (vtt-1xv.16), M5-i2 (vtt-1xv.26), M5-g (vtt-1xv.12), vtt-3l6.7, vtt-3l6.6, vtt-3l6.21, vtt-3l6.23, vtt-3l6.22
- M5-l (vtt-1xv.17): M5-i (vtt-1xv.14), M5-k2 (vtt-1xv.25), M5-k (vtt-1xv.16), vtt-3l6.21, vtt-3l6.23
- M5-m (vtt-1xv.18): M5-b (vtt-1xv.7), M5-0 (vtt-1xv.5), M5-g (vtt-1xv.12), vtt-3l6.21, vtt-3l6.11
- M5-m2 (vtt-1xv.27): M5-m (vtt-1xv.18), M5-i2 (vtt-1xv.26), vtt-3l6.22, vtt-3l6.21, M5-p (vtt-1xv.21), vtt-3l6.11, vtt-3l6.6, vtt-3l6.23
- M5-n (vtt-1xv.19): M5-k (vtt-1xv.16), M5-g (vtt-1xv.12), M5-a (vtt-1xv.6), vtt-3l6.12, vtt-3l6.21
- M5-o (vtt-1xv.20): vtt-3l6.3, M5-f (vtt-1xv.11), vtt-3l6.21, M5-0 (vtt-1xv.5), vtt-5su.20, vtt-3l6.4
- M5-p (vtt-1xv.21): vtt-3l6.13, vtt-3l6.22, vtt-3l6.21, vtt-3l6.19, M5-i (vtt-1xv.14), M5-j (vtt-1xv.15), vtt-3l6.23, vtt-3l6.5
- M5-q (vtt-1xv.22): vtt-5su.14, M5-d (vtt-1xv.9), vtt-5su.4, M5-a (vtt-1xv.6), M5-c (vtt-1xv.8), M5-0 (vtt-1xv.5), vtt-3l6.15, M5-b (vtt-1xv.7), vtt-3l6.25
- M5-y (vtt-1xv.23): M5-k (vtt-1xv.16), vtt-3l6.9, M5-k2 (vtt-1xv.25), M5-q (vtt-1xv.22), M5-m2 (vtt-1xv.27), vtt-3l6.6, vtt-3l6.23, M5-o (vtt-1xv.20), M5-j (vtt-1xv.15), M5-n (vtt-1xv.19), M5-i (vtt-1xv.14), M5-m (vtt-1xv.18), M5-i2 (vtt-1xv.26), vtt-3l6.12, M5-l (vtt-1xv.17), M5-p (vtt-1xv.21), vtt-3l6.17
- M5-z (vtt-1xv.24): M5-h (vtt-1xv.13), M5-e (vtt-1xv.10), M5-q (vtt-1xv.22), M5-y (vtt-1xv.23)

Total: 147 edges (67 cross-epic, 80 intra-epic), all recorded; `bd dep cycles` reports none, and a script compared every bead's Depends-on paragraph with its recorded dependencies and found no mismatch. vtt-5su.2, .4, .5, .6, .7,
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

**Waves** (after review r3; M5 UI beads wait on M4):

1. M5-0.
2. M5-a, M5-b0 (after vtt-3l6.3).
3. M5-b (after vtt-3l6.19), M5-c.
4. M5-d.
5. M5-f (after vtt-5su.10), M5-q (after vtt-5su.14, vtt-3l6.25, .15).
6. M5-g, M5-o.
7. M5-e, M5-i (after vtt-3l6.22), M5-m.
8. M5-h (after vtt-5su.11, .12, .15, .17, vtt-3l6.20), M5-i2.
9. M5-j.
10. M5-k (after vtt-3l6.7, .9, .13, .23), M5-p.
11. M5-k2, M5-n, M5-m2.
12. M5-l.
13. M5-y (after vtt-3l6.17).
14. M5-z.

**Critical path** inside the epic (after r3; unchanged by r3, M5-c now waits on M5-b0 instead of M5-b): M5-0 → M5-a → M5-c → M5-d →
M5-f → M5-g → M5-i → M5-i2 → M5-j → M5-k → M5-k2 → M5-l → M5-y → M5-z
(fourteen beads; r2 added M5-i2 and the M5-k → M5-j edge).

---

## Review r1 changes

Review: /Users/tfg/Projects/vtt/.reviews/vtt-1xv-20261105T100340Z.md;
dispositions: plan-m5-r1-dispositions.md (all 16 accepted). Applied
2026-11-05; pre-r1 bead texts in scratchpad/m5beads/orig/, applied texts in
scratchpad/m5beads/r1/; pre-r1 plan in plan-m5.pre-r1.md.

1. Decision payload: M5-0 (vtt-1xv.5) now carries everything it writes
   inline: the step grammar and semantics table, destinations, limits and
   refusals; the face encoding with the Attack card JSON; the example
   template list (ids, cells, actions, faces); the PROTOCOL and FIXTURES
   edits; all 24 decision rows verbatim (M5-D1–M5-D24, adding M5-D23 action
   views and element index and M5-D24 tool counts) plus the amendment note on
   the 2026-11-04 face-elements row. It is the sole owner of recording
   vtt-1xv.2–.4. M5-q (vtt-1xv.22) defers to that list.
2. Transaction ownership: M5-c (vtt-1xv.8) exposes `runAction(tx, ctx,
   req)` inside a caller-owned transaction plus `invokeAction` wrapping it;
   M5-f (vtt-1xv.11) opens the transaction as `transact` does and runs the
   stale check before commit; both test that a refusal changes neither
   document, revision, log, listeners nor dice.
3. Step grammar: step-level recursive parser (M5-a, vtt-1xv.6; and in M5-0),
   `each`'s body parsed as a step, `->` never an expression operator; tests
   for a nested roll and the whole-source limit.
4. Edges: M5-g → M5-f and M5-o → M5-f recorded.
5. Action views: `ActionDefinitionView` (renamed `ActionView`, definitions
   only; effects, snapshots, `actions`) owned by M5-b (vtt-1xv.7);
   `ActionStateView` in `ObjectView.action_states` (live views only) owned by
   M5-g (vtt-1xv.12); `ObjectSnapshotView.face` added by M5-b.
6. Face invalidation: `summary.faceChanged` is a candidate source in M5-g;
   tests for add, change, remove and undo of an unconditional face.
7. Element identity: `FaceElementView.index` (M5-g), kept by character
   views; `face_element.element` is that index (M5-e, M5-h).
8. Presentation bounds: M5-i (vtt-1xv.14) computes them and
   `faceCullBounds`; vtt-3l6.6's A3 refined (`cullBounds` option, unclipped
   hook); M5-j and M5-y wire and test them (off-screen parent with visible
   controls, shapeless binder, rotation, overlapping faces).
9. Drop hook: vtt-3l6.7's A4 amended (both intents, captured intent,
   continuations); M5-k2 (vtt-1xv.25) uses it.
10. Data drops: vtt-3l6.23's A2 amended (`dataDropHandlers`); M5-m
    (vtt-1xv.18) provides `cellDropHandler`; M5-y wires it; tests with
    select and ink active.
11. Board-template gear: drawn and hit-tested by M5-i; handled by M5-l
    (vtt-1xv.17); tested there and in M5-y.
12. Log pages: invalidation and lazy, revision-checked refetch in M5-o
    (vtt-1xv.20).
13. Acceptance: M5-z (vtt-1xv.24) carries a fixed per-step matrix for all
    ten scenarios (click, suppressed-then-protocol, drag, edit, log,
    protocol with reasons); action state is read from `action_states`.
14. Assertions rewritten (M5-k, M5-o) for Apply's real transitions and the
    separate Roll damage group.
15. Tool counts: 15 on the request-surface server, 19 in the composed
    process (M5-0, M5-h; M5-h now depends on vtt-3l6.20).
16. Split: M5-k (vtt-1xv.16, retitled "UI: buttons, invoke, inline face
    editing, default action") and new M5-k2 (vtt-1xv.25, "UI: entry drags,
    reference drops, container insertion"); the shared contracts
    (`FacePolicy`, `FaceGesture`, `WithFacesOptions`) moved to M5-i.

Applied beyond the dispositions: vtt-3l6.6's A3 refinement (finding 8 needs
culling and the unclipped hook in the renderer; the dispositions named only
vtt-3l6.7 and vtt-3l6.23); `DataDropHandler` returns `Effect[] | null`
instead of a boolean, so a handler emits its write through the runtime;
M5-y also depends on vtt-3l6.6 and vtt-3l6.23 directly, M5-l on M5-k2, and
M5-n's text uses `action_states`.

## Review r2 changes

Review: /Users/tfg/Projects/vtt/.reviews/vtt-1xv-20261105T102444Z.md;
dispositions: plan-m5-r2-dispositions.md (all 13 accepted). Applied
2026-11-05; pre-r2 bead texts in scratchpad/m5beads/orig/pre-r2/, applied
texts in scratchpad/m5beads/r2/; pre-r2 plan in plan-m5.pre-r2.md.

1. Contents scrolling: per-session offsets in `FaceStateStore`, layout,
   clipping and `revealOffset` (M5-i), hit testing (M5-i2), drawing (M5-j),
   wheel handling and reveal on expand (M5-k, which also post-merge edits
   vtt-3l6.22's `tool.ts`/`machine.ts` so the active tool may claim a wheel
   before the camera zooms), reveal of new working copies (M5-l); tests reach
   and press the last entry.
2. Give a template: one `transact` spawn as `$copy` plus `set_template_flag`
   when a template is dropped on a binder (tag `binder`); instance copy
   elsewhere (M5-0 rule and M5-D18 amended; M5-k2 implements; M5-l tests the
   recipient's working copies).
3. Nested drawing: `FaceDrawing.base` from `drawItemFor` (M5-i exports it
   from vtt-3l6.5's `scene.ts`), entry `transform`s, `screenHeight` for
   `min_size` (M5-i); drawn with vtt-3l6.6's exported `paintItem` (M5-j).
4. Template prohibition: `FacePolicy.canInvoke` and M5-k's `requestInvoke`
   are the single path for buttons, default-action double-clicks and the
   inspector's Run (M5-n).
5. `FaceLayoutView` for historical faces (M5-b), round-tripped through
   `parseResult`.
6. Removal snapshots: GM lossless; omitted for a character until undo
   restores the object (M5-b).
7. Edges: M5-k → M5-j recorded; the ink-tool dependency is on M5-m2, where
   the test with `ink` active now lives (see below).
8. Executor: `StepHandler`/`StepContext`/`createExecutor`, `coreHandlers`
   (M5-c) and `placementHandlers` (M5-d, no self-registration); M5-e, M5-f
   and M5-q compose both; placement actions tested through both entry
   points.
9. Working copies: first match in contents order, selected and expanded;
   `expand_created` checks board and viewer continuity (M5-l).
10. Template records: M5-0 publishes complete records; M5-q copies them.
11. `faceElementVisible` exported by M5-g, used by M5-e (now depends on M5-g)
    and by live views; parity cases.
12. Acceptance navigation: a Board column in M5-z's matrix (shelf and map
    for Fireball).
13. Splits: M5-i (vtt-1xv.14, "UI: face contracts, state and layout") and
    new M5-i2 (vtt-1xv.26, "UI: face scene and hit testing"); M5-m
    (vtt-1xv.18, "UI: layout operations and Face section") and new M5-m2
    (vtt-1xv.27, "UI: layout tool and cell drops"); consumers re-pointed
    (M5-j, M5-k, M5-k2, M5-y to M5-i2; M5-y to M5-m2).

Applied differently: the `.18 → .21` edge is recorded as M5-m2 → M5-p
(vtt-1xv.27 → vtt-1xv.21) because the split moved the ink-active test into
M5-m2; M5-m no longer has any ink dependency. vtt-3l6.6's amendment was
refined again (`paintItem` export, `scene` in the hook's helpers), and M5-k
post-merge edits vtt-3l6.22 (now in progress) for wheel routing instead of
amending it. Area Save `caster`: no drag-out inference; it stays `empty`
until the GM drops the caster's token on the `caster` editor, and the save
row's guard is `save_roll = empty and card.caster != empty` (the
disposition's `<>` written `!=`). M5-i also depends on vtt-3l6.22
(contract types).

## Review r3 changes

Review: /Users/tfg/Projects/vtt/.reviews/vtt-1xv-20261105T104451Z.md;
dispositions: plan-m5-r3-dispositions.md (all 11 accepted as text fixes;
final round). Applied 2026-11-05; pre-r3 bead texts in
scratchpad/m5beads/orig/pre-r3/, applied texts in scratchpad/m5beads/r3/;
pre-r3 plan in plan-m5.pre-r3.md.

1. Collapsed faces: every visible entry is resolved with its collapsed list
   (own or the default `name` face) or, expanded, its full list (M5-i),
   drawn (M5-j) and hit-tested (M5-i2) either way.
2. Drops: `dropTargetAt` in M5-i2 with editor → innermost contents → board
   precedence; `DropTarget` type in M5-i; M5-k2 uses only it.
3. Hit context: `FaceHit.path` and `toLocal` (M5-i contract, M5-i2);
   the wheel scrolls the innermost overflowing list on the path (M5-k);
   chevrons reveal in the path's list (M5-k, M5-l).
4. Entry clicks: M5-k2's gesture claims rows and contained bodies; a click
   selects (no write); M5-k leaves them to it; M5-z selects contained
   targets this way.
5. Cell drops convert with `toLocal` before `addCellElement`; board and
   contained targets (M5-m2).
6. `faceElementVisible` is "present with `shown === true`"; GM views retain
   hidden elements (and buttons with no action) with `shown: false` and a
   `reason` (M5-g; M5-e, M5-h, M5-0 aligned).
7. Limits advertised in `welcome`: owned by the new M5-b0 (see below);
   enforced by M5-c and checked over the protocol by M5-f.
8. `revealOffset`: the whole row when it fits, else its top (M5-i; M5-k,
   M5-l tests).
9. Log paging: a chain from a fixed upper boundary, rebuilt in order after
   invalidation, generation-tagged responses, a start for an empty window
   (M5-o).
10. Stocked-table flow: permitted preparation writes, exact scripted dice
    and asserted outcomes (M5-q); template records unchanged.
11. Split: M5-b0 (vtt-1xv.28, "Schema and protocol: action contracts")
    takes the refusal variants, `toFixtureReason`, `describeRejection`
    sentences and the `ActionDefinitionView` rename from M5-b (vtt-1xv.7);
    M5-c depends on M5-b0, not M5-b; M5-b, M5-e, M5-f, M5-g and M5-k depend
    on M5-b0 explicitly (shared files or imports).

Applied differently: disposition 7 named vtt-1xv.7 as the owner of the three
advertised limits, but disposition 11 makes vtt-1xv.8 depend on the new
action-contracts bead instead of vtt-1xv.7, and vtt-1xv.8 must enforce two
of them with the shared constants; so the limits (schema constants
`MAX_EACH_ITEMS`, `MAX_ACTION_WRITES`, `MAX_FACE_ELEMENTS`, protocol
`LIMITS` and the welcome `LimitsSchema`, with the welcome round-trip test)
are owned by vtt-1xv.28, and vtt-1xv.7's `faceProblem` uses
`MAX_FACE_ELEMENTS` from it. The schema owns the values because
`@vtt/schema` cannot import `@vtt/protocol`.

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
