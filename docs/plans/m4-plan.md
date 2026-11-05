# Plan: M4 Canvas and objects UI (epic vtt-3l6)

Plan for the planning bead vtt-3l6.1, updated after the orchestrator's
decisions (plan-m4-decisions.md), filing on 2026-11-05, and plan reviews r1
r2 and r3 (plan-m4-r1-, -r2-, -r3-dispositions.md; see "Review r1 changes",
"Review r2 changes" and "Review r3 changes" after section 3). Plan
labels map to filed ids: M4-0 vtt-3l6.2, M4-d vtt-3l6.3, M4-c vtt-3l6.4
(session and mirror lifecycle), M4-c2 vtt-3l6.21 (writes, notices and UI
state; split off in r1), M4-e vtt-3l6.5, M4-f vtt-3l6.6, M4-g0a vtt-3l6.22
(interaction contracts and navigation reducer; new in r1, narrowed in r2),
M4-g0b vtt-3l6.23 (interaction runtime and React binding; new in r2), M4-g vtt-3l6.7 (select
tool), M4-h vtt-3l6.8, M4-i vtt-3l6.9, M4-j
vtt-3l6.10, M4-k1 vtt-3l6.11, M4-k2 vtt-3l6.12, M4-k3 vtt-3l6.24 (dependency
tracing; new in r2), M4-l vtt-3l6.13, M4-a1
vtt-3l6.14, M4-a2 vtt-3l6.15 (M4-a was split), M4-b vtt-3l6.16, M4-b0 vtt-3l6.25 (asset generation in save bookkeeping;
split from M4-b in r3), M4-n
vtt-3l6.17, M4-z vtt-3l6.18, M4-p vtt-3l6.19, M4-q vtt-3l6.20 (new: MCP
asset import). Section 2 holds the filed descriptions; section 4 keeps the
questions as reviewed, with their resolution at its top. Cross-epic dependencies name real ids: M2 (vtt-75c) is closed; M3 beads
vtt-5su.2–.20 are open (vtt-5su.2 in progress) and their text, as filed in
plan-m3.md section 2, is the contract M4 consumes.

**What M4 delivers.** A browser-tab client of the authority (→ Q1): it
connects with `@vtt/protocol`'s `ProtocolClient` plus `enableRecovery`
(vtt-5su.7, vtt-5su.19), subscribes per board with a viewer, and draws the
mirrored `ObjectView`s and `Cover`s on an infinite Canvas2D scene behind a
small renderer interface, with React chrome around it. The GM can pan and
zoom, switch, add, rename and remove boards, create objects and zones (rect,
circle, polygon, image), move, stack, flip, resize and rotate them, put
objects into containers and take them out, copy templates by dragging them,
inspect and edit every cell (literals, formulas, overrides, per-cell
visibility, tags, flags), type formulas in one formula bar, edit `name` and
`text` in place on the canvas, view as any character (covers drawn above
everything), undo, and save. The authority additionally serves the built UI
with the session token injected, and stores and serves image assets (→ Q3,
Q4). Appearance is cells (`image`, `color`, `pattern`, `text`; → Q5).

M4 builds no face layouts, show-when, collapsed faces, buttons, contents face
elements, binders, working copies, action invocation or action editing, log
panel, freehand ink or text tool (all M5, vtt-1xv).

**Epic Done-when** ("prep steps 1–4 of §8.4 can be performed by hand minus
binders") is carried by **M4-z** with the interpretation of Q19: an automated
walkthrough of steps 1–4 through the real React app in jsdom against a real
in-process authority; its manual browser checklist is posted on the epic for
the user and does not gate.

---

## 1. Module map and owners

`@vtt/ui` (existing scaffold: `App.tsx`, `main.tsx`, `index.ts`, one test;
React 19.3.1, Vite 8.3.5, jsdom 30.1.3, Testing Library). New workspace
dependencies `@vtt/schema`, `@vtt/formula`, `@vtt/protocol` (M4-d); dev
dependencies `@vtt/authority` (tests and the Vite dev plugin only; never
imported from `src/`, asserted by a test) and `@testing-library/user-event`
14.6.8 (M4-c, vtt-3l6.4) (→ Q17). `src/index.ts` keeps one sorted
`export * from "./<module>"` line per module; each bead adds its own lines.

| Module | Owner | Contents |
|---|---|---|
| `src/values/format.ts`, `input.ts`, `ops.ts`, `rejections.ts` | M4-d | `formatValue`, `parseCellInput`, `toInputText`, `cellInputToOps`, `describeRejection` (pure) |
| `src/session/bootstrap.ts`, `table-session.ts` | M4-c | `readBootstrap`, `TableSession` (connection, directory/board/selection views per viewer, `refLabel(viewer, id)`, board-list tracking, `whenRevision`) |
| `src/session/writes.ts`, `notices.ts`, `hooks.ts`; `src/state/ui-state.ts`, `runtime-inputs.ts`, `camera-store.ts`; `test/support/authority.ts` | M4-c2 | `createWritePort` (implements `WritePort`), `undo` (`mine`), `save`, `NoticeStore` (sole owner of stickiness/expiry), `UiStore` (selection, focused/hovered cell, hovered zone, highlight, typed tool state, camera + `cameraPort()`, viewport), `createRuntimeInputs`, `createToolContext`, camera store (save/restore per board, `needsFit`), React hooks, shared test helper |
| `src/scene/camera.ts`, `appearance.ts`, `scene.ts`, `hit-test.ts`, `polygon.ts` | M4-e | `Camera`, `PX_PER_UNIT`, `readAppearance`, `buildScene` (items, `objectOverlays`, covers; `previews`), `ScenePreviews`, `isCovered`, `hitsAt`, `hitTest`, `marqueeHit`, `polygonProblem`, `normalizePolygon` (pure) |
| `src/render/renderer.ts`, `canvas2d.ts`, `image-cache.ts`, `recording.ts`; `src/canvas/BoardCanvas.tsx` | M4-f | `Renderer`, `createCanvas2DRenderer`, `ImageCache`, `RecordingContext`, `<BoardCanvas>` |
| `src/interaction/contracts.ts`, `events.ts`, `tool.ts`, `overlays.ts`, `effects.ts`, `machine.ts`, `registry.ts` | M4-g0a | `WritePort`, `WriteOutcome`, `CameraPort`, `ToolContext`, `Previews`, `InteractionStamp`; event, tool-state, overlay, effect and continuation unions; pure navigation reducer; tool registry |
| `src/interaction/runtime.ts`, `use-interaction.ts` | M4-g0b | effect runtime (writes, ordered continuations, uploads, previews' lifetime, cancellation and late results, `EditorPort`), `useInteraction` → `{overlays, previews, handlers}`, contract-composition test |
| `src/interaction/select-tool.ts`, `keys.ts` | M4-g | select tool: select, Alt+click cycling, marquee, move, containment, template drag; keyboard commands |
| `src/interaction/create-tools.ts` | M4-h | token, card, note, zone rect/circle/polygon, image tools |
| `src/interaction/handles.ts` | M4-i | resize, vertex and rotate handles |
| `src/nav/BoardTabs.tsx`, `ViewAsMenu.tsx`, `board-ids.ts`, `first-visit-fit.ts` | M4-j | boards, "Move selection to board…", zero-board state, view-as, first-visit fit |
| `src/inspector/CellList.tsx`, `CellRow.tsx`, `ViewersPicker.tsx` | M4-k1 | cell rows, add/rename/delete, override, per-cell visibility |
| `src/inspector/Inspector.tsx`, `ObjectHeader.tsx`, `ShapeControl.tsx`, `ContentsList.tsx`, `ActionsList.tsx`, `ObjectList.tsx` | M4-k2 | panel assembly, flags, tags, shape control (add/change/remove), contents (reorder against the drag-start revision), object list (sets `hoveredZone`), read-only actions |
| `src/inspector/tracing.ts` | M4-k3 | dependency tracing: explain/zones queries keyed by viewer, board, revision; cancellation; precedence; sole writer of highlight |
| `src/formula-bar/FormulaBar.tsx`, `InPlaceEditor.tsx`, `editor-port.ts` | M4-l | formula bar, in-place editor overlay, `EditorPort` implementation |
| `src/assets/upload.ts` | M4-b | `uploadAsset`, `assetUrl` |
| `src/App.tsx`, `src/main.tsx`, `src/app/Toolbar.tsx`, `StatusBar.tsx`, `Notices.tsx`, `keybindings.ts` | M4-n | composition, global keys, banners |
| `test/acceptance/prep.test.tsx`, `prep-script.ts` | M4-z | epic acceptance |

`@vtt/authority` (additive edits to M3 files after their owners merge, → Q23):

| Module | Owner | Contents |
|---|---|---|
| `src/server/http-ui.ts` (new); option `http` (handlers + Host check) in `src/server/server.ts` (vtt-5su.10) | M4-a1 | static UI, session injection, Host check, `injectSession`, `HttpHandler` |
| flags and handler wiring in `src/bin/serve.ts` (vtt-5su.14); `packages/ui/vite.config.ts`; root `dev` script | M4-a2 | `--ui-dir`, `--no-ui`, `build.assetsDir: "ui-assets"`, serve-only Vite `vttSession()` plugin, `/assets` proxy |
| `src/host/assets.ts`, `src/server/http-assets.ts` (new) | M4-b | asset import, upload and serving under `/assets/` only |
| `addAsset`, `assetsGeneration` and pair-based save bookkeeping in `src/host/table-host.ts` (vtt-5su.4) | M4-b0 | asset dirty state in saves (r3) |
| `createObject` `id_base` (M2 `store/structural.ts`), `create_object.id_base` in `@vtt/protocol` `ops.ts` and authority `protocol/commands.ts`; `ObjectView.absent_cell_visibility` in `@vtt/protocol` `views.ts` and authority `protocol/views.ts`; `replaceFormula` in M2 `store/edits.ts` and `set_value.replace` in protocol `ops.ts`/`commands.ts` | M4-p | authority-allocated readable ids; GM views of visibility rules on absent cells (r1); replacing a formula by a literal in one write (r3) |
| `src/mcp/import-asset.ts` (new); registration in `src/bin/mcp.ts` (vtt-5su.17) via `createMcpServer`'s `extensions` (vtt-5su.11) | M4-q | MCP tool `import_asset` |

Docs: M4-0 only (DESIGN §4.4, §4.6, §5.2, §7, §10; PROTOCOL.md §1, §2, §5,
§7.2, §11; CLAUDE.md Conventions).

---

## 2. Beads (as filed, revised after reviews r1–r3)

Type task, parent vtt-3l6, P1 (M4-z P2). Filed 2026-11-05 after the
orchestrator's decisions (plan-m4-decisions.md); each section below is the
bead's description verbatim as recorded in bd after review r3 (plan labels in
the text are replaced by ids). Amendments relative to the draft: M4-a split into M4-a1
(vtt-3l6.14, HTTP hook, static UI, Host check; depends on vtt-5su.10) and
M4-a2 (vtt-3l6.15, `vtt-serve` flags, route wiring, Vite dev plugin; depends
on vtt-5su.14); M4-p filed unconditionally (vtt-3l6.19) and M4-h depends on
it; new M4-q (vtt-3l6.20) MCP `import_asset`; M4-0 owns every doc edit
including PROTOCOL §5/§11 and CLAUDE.md, with the decision-log rows written
out; M4-b serves assets `no-store`; M4-n has no manual gate and builds the UI
in a test; M4-z carries the Q19 interpretation and a manual checklist for the
user that does not gate.

### M4-0 — vtt-3l6.2 — Docs: UI decisions

Implements: DESIGN.md §4.6, §5.2, §7 (Platform; Revisions and assets: "how an
image cell names an asset is M4's decision"), §10; docs/PROTOCOL.md §1, §2,
§5, §7.2, §11; CLAUDE.md Conventions; planning bead vtt-3l6.1 (decisions Q1–Q23 as
accepted with the orchestrator's amendments, plan-m4-decisions.md; plan review r1
findings 1, 4, 5, 6, 8, 16; review r2 findings 1, 2; review r3 findings 3, 7, 8).

Docs only; the only M4 bead that edits docs. Writes the accepted decisions so
every other M4 bead cites a doc section. Exclusive files for this bead:
`docs/DESIGN.md`, `docs/PROTOCOL.md`, `CLAUDE.md` (the orchestrator applies
the CLAUDE.md edit if the implementing agent declines).

- DESIGN §4.6 gains **Appearance cells** (Q5, Q6): the ordinary user cells
  `image` (text: an asset path relative to the table file, as listed in the
  file's `assets`), `color` (text: a CSS color; fill), `pattern` (text:
  `"hatch"` draws 45° lines; other values ignored), `text` (any value, shown
  compact inside the object), and `name` as the label below; unreadable or
  ill-typed appearance cells are simply not drawn (formulas, overrides and
  per-cell visibility apply as to any cell). Drawing rules: non-zones without
  `color` get a neutral fill; zones are transparent with a thin outline unless
  `color`/`pattern`; the GM sees opaque zones with a 35 % dark fill and a
  dashed outline and a badge on objects whose `visible_to` is not exactly
  `all`; a character sees a revealed opaque zone only through its
  `color`/`pattern`; covers are solid and drawn above every object and every
  object-related overlay (selection outlines, handles, highlights, drag
  ghosts, creation previews); only viewer-independent chrome (the marquee
  rectangle, a cursor crosshair) is drawn above covers, and the DOM in-place
  editor opens only when its screen rectangle intersects no cover of the
  current viewer, and closes without committing when a cover appears over it
  or the viewer changes;
  shapeless objects are a 10 px marker; face-down objects show a generic back
  plus `name` to everyone (the GM also sees a face-down glyph), because
  `FACE_DOWN_EXEMPT` has no appearance cell.
- DESIGN §4.6 gains **Typing into a cell** (Q7) and amends **The formula bar**:
  formulas may be typed anywhere a value is typed, by a leading `=` (refused
  in the UI when it does not parse); the formula bar is where the focused
  cell's current formula source is shown and edited (this replaces "the only
  place formulas are typed"); `name` input is always text, even with a
  leading `=`; otherwise literal syntax
  (numbers, `"quoted text"`, `true`/`false`, `empty`, dice expressions,
  lists of literals) is that value, `@id` is a reference, empty input is
  `empty`, anything else is text verbatim; `name` is always text;
  `visible_to` also accepts `all`, `gm`, `owner`, `@id` lists as a viewers
  value; a literal typed over a formula is an override; replacing a formula
  with a value is an explicit inspector command that writes `set_value` with
  `replace: true` (one write, also on structural cells such as `visible_to`).
- DESIGN §4.6 gains **Default rendering until faces** (Q13): until face
  layouts (M5) an object draws its shape, image, color, pattern, `text` and
  `name` label; labels hide below 24 px on screen; edit in place covers
  `text` (else `name`); dependency tracing highlights objects referenced by a
  hovered formula (via `explain_cell`, viewer-filtered) and a hovered zone's
  contents (via `zones`).
- DESIGN §4.6 gains **On the canvas** (Q11, Q12): copy-versus-move is decided
  when a drag starts: dragging exactly one selected template without Alt
  spawns a copy where it is dropped, with Alt it moves the template; any other
  selection (several templates, or templates mixed with other objects) is
  moved, never spawned; for a non-template drag, Alt held at the drop onto an
  object puts the dragged objects into its `contents`, and a plain drop
  places on the board (stacking); Alt+click cycles through the objects under the
  pointer (so a zone under a map image can be selected); objects move between
  boards with "Move selection to board…", not by dragging.
- DESIGN §4.6 gains **View as in the UI** (Q14): view-as switches the viewer of
  what is drawn, inspected and traced; the inspector and formula bar are
  read-only there and show the character's view; canvas edits are still the
  GM's.
- DESIGN §7 Undo (Q9): the UI's undo targets the GM's own latest group
  (`mine`); every UI write carries the revision its interaction began on
  (drag start, editor open, formula bar focus, or the click for instantaneous
  commands), never the latest one; stale writes and uncertain outcomes are
  shown to the GM and never retried automatically.
- DESIGN §7 Platform, render caching (review r1 finding 16): replace
  "Canvas2D with viewport culling and per-object render caching" by:
  "Canvas2D with viewport culling and an image cache; per-object render
  caching is deferred until profiling asks (vtt-qf5.10)".
- DESIGN §7 Platform and Revisions and assets, and §5.2 (Q3, Q4): the
  authority serves the built UI at `/` with the session token injected into
  the page and refuses HTTP requests whose `Host` is not its own loopback
  address; imported images are stored in `<table basename>.assets/` named
  `<slug>-<hash8>.<ext>` (PNG, JPEG, WebP, GIF; no SVG), never
  garbage-collected in v1; image cells hold that relative path; asset upload
  is HTTP (`POST /assets`), and the UI and the MCP process both use it
  (MCP tool `import_asset`), so §5.2's parity rule holds.
- PROTOCOL.md §1: HTTP routes beside `/ws` and `/healthz`: `GET /` (built UI
  with exactly one injected session element, `no-store`; the build itself
  contains none), static UI bundles under `/ui-assets/` (never `/assets/`),
  `GET /assets/<path>` (only paths listed in the table file's `assets`,
  `no-store`), `POST /assets` (bearer token); the `Host` check on every
  non-upgrade request except `/healthz`. §2: the in-page session bootstrap
  element `<script id="vtt-session" type="application/json">{url, token}</script>`.
  §5: `create_object` gains optional `id_base` (the authority allocates
  `<id_base>_<n>` as spawn does; exclusive with `id`); `set_value` gains
  optional `replace: true` (replaces a stored formula, and any override, by
  the literal in one cell effect; valid on structural cells; protected cells
  stay refused; without it a value on a formula cell is an override). §7.2: GM object
  views gain optional `absent_cell_visibility` (the object's per-cell
  visibility entries for cell names not in `cells`); character views never
  carry it. §11: the MCP tool
  `import_asset {path, slug?}`.
- CLAUDE.md Conventions: the UI testing convention of Q16 (pure logic in
  Vitest's node environment; the renderer against a recording 2D context;
  components in jsdom with an injected renderer; integration against a real
  in-process authority; no browser automation in v1's suite) and the
  `@testing-library/user-event` 14.6.8 dev dependency.
- Decision-log rows in DESIGN §10, dated the day of the commit, with these
  decisions (rationale column in the same spirit, wording may be tightened):
  1. The authority serves the built UI at `/` with the session token injected
     into the page and refuses HTTP requests whose `Host` is not its own
     loopback address; image assets are served at `/assets/` only for paths
     listed in the table file's `assets`, with `no-store` and the same `Host`
     check, and uploaded with `POST /assets`. PROTOCOL §1. (One process and
     one URL for the GM; the `Host` check closes DNS rebinding, which the
     WebSocket `Origin` check already covers for `/ws`.)
  2. An image cell is the ordinary text cell `image` holding an asset path
     relative to the table file, as listed in the file's `assets`; imported
     images are stored in `<table>.assets/` as `<slug>-<hash8>.<ext>` and never
     garbage-collected in v1. DESIGN §4.6, §7.
  3. Asset upload is HTTP (`POST /assets`); the UI and the MCP process both use
     it. DESIGN §5.2, §7. (A map image exceeds the 1 MiB client frame limit
     and is not a document operation.)
  4. Appearance is ordinary user cells read by the renderer: `image`, `color`,
     `pattern` (`hatch`), `text`, with `name` as the label; unreadable or
     ill-typed appearance cells are not drawn. DESIGN §4.6.
  5. Face-down objects show a generic back in v1; per-object backs would need
     a cell in the face-down exemption set. DESIGN §4.4, §4.6.
  6. Cell input: a leading `=` is a formula, in any value editor (the formula
     bar shows and edits the current formula source; `name` is always text);
     otherwise literal syntax (numbers,
     quoted text, booleans, `empty`, dice, lists) or `@id` is that value and
     anything else is text; a literal typed over a formula is an override;
     replacing a formula is an explicit command. DESIGN §4.6.
  7. The UI's undo targets the GM's own latest group (`mine`); every UI write
     carries the revision its interaction began on; stale writes and
     uncertain outcomes are shown to the GM and never retried automatically.
     DESIGN §7 Undo.
  8. On the canvas, copy-versus-move is decided at drag start: one selected
     template without Alt spawns a copy where it is dropped, Alt moves it;
     other selections containing templates are moved. DESIGN §4.6, §4.7.
  9. On the canvas, for non-template drags, Alt held at the drop onto an
     object puts the dragged objects into its `contents`; a plain drop places
     on the board (stacking). DESIGN §4.6.
  10. Until face layouts (M5) an object draws its shape, image, color,
      pattern, `text` and `name` label; labels hide below 24 px on screen;
      dependency tracing highlights what a hovered formula references and a
      hovered zone's contents, filtered by the viewer. DESIGN §4.6.
  11. View-as switches the viewer of what is drawn and inspected; the
      inspector is read-only there and shows the character's view; edits on
      the canvas are still the GM's. DESIGN §4.4, §4.6.
  12. `create_object` takes an optional `id_base`; the authority allocates
      `<id_base>_<n>` as spawn does; GM object views carry
      `absent_cell_visibility` so visibility rules on absent cells can be
      inspected. PROTOCOL §5, §7.2; DESIGN §4.1, §4.4, §5.3.
  13. UI tests: pure logic in node, the renderer against a recording 2D
      context, components in jsdom with an injected renderer, integration
      against a real in-process authority; no browser automation in v1's
      test suite. CLAUDE.md Conventions.
  14. `@testing-library/user-event` 14.6.8 (dev dependency of `@vtt/ui`) for
      UI interaction tests.
  15. Per-object render caching is deferred until profiling asks; v1 ships
      viewport culling and an image cache (vtt-qf5.10). DESIGN §7.
  16. Covers are drawn above every object and object-related overlay; only
      viewer-independent chrome is drawn above them, and the in-place editor
      never shows over a cover (its rectangle must intersect none).
      DESIGN §4.4, §4.6.
  17. "Replace formula with value" is `set_value` with `replace: true`: one
      cell effect from the formula (and any override) to the literal, valid
      on structural cells, undoable. PROTOCOL §5; DESIGN §4.2, §4.6.

Done when: each edit above is present with these names and values; DESIGN §10
has the seventeen rows; no code changes; `pnpm lint` and `pnpm format:check`
exit 0.

Out of scope: any code; face layouts, show-when, binders, action syntax, log
sentences (M5); the M3 decisions (vtt-5su.2); per-object card backs
(Later).

Depends on: vtt-5su.2 (PROTOCOL.md must exist; both edit DESIGN §10).

---

### M4-d — vtt-3l6.3 — UI: value formatting, cell input and rejection messages

Implements: FORMULAS.md §2 (values, rolls, errors and origins), §2.4,
§3.1 (structural cell types), §3.2 (literal syntax); DESIGN.md §4.6 Typing
into a cell, Appearance cells (as written by vtt-3l6.2); docs/PROTOCOL.md §5
(`InputValue`, `InputCellContent`, ops), §7.1–§7.3 (`WireResult`, `CellView`,
redaction), §10 (`Rejection`, `ProtocolRejection`); review r1 findings 7, 8; review r2 findings 5, 6; review r3 findings 3, 4, 5.

Pure functions, no React, no session. Exclusive files:
`packages/ui/src/values/format.ts`, `input.ts`, `ops.ts`, `rejections.ts`,
tests `packages/ui/test/values/*.test.ts`. Adds to `@vtt/ui` package.json the
workspace dependencies `@vtt/schema`, `@vtt/formula`, `@vtt/protocol`;
`pnpm install`, lockfile in the same commit. Adds its own sorted `export * from "./<module>"`
lines to `packages/ui/src/index.ts` (CLAUDE.md package index rule).

- `formatValue(v: WireResult, {mode: "compact" | "full", refLabel: (id) => string | null}): Formatted`
  with `Formatted = {text: string; tone: "normal" | "muted" | "error" | "redacted"}`, per Q8: number
  (compact: at most 4 decimals, trailing zeros trimmed; full: `String(n)`),
  text (compact: first line, 40 chars with `…`), boolean, empty (`""` compact,
  `empty` full, muted), list (`[a, b]`, compact capped at 3 items `… +n`),
  ref (`refLabel(id) ?? id`; full: `Label (id)`), dice (`expr`), roll
  (compact `13`; full `13 (4d6dl1: 6, 4, 3; dropped 1)`), viewers (`all`,
  `gm`, `owner`, ref labels, comma-separated), ink (`(ink)`), shape (`rect
  2×1`, `circle r 4`, `polygon, 5 points`), error (compact the code; full
  `#REF: <message> (from <object>.<cell>)`, tone error), redacted (`hidden`,
  tone redacted).
- `parseCellInput(text, {cell}): {ok: true; content: InputCellContent} | {ok: false; message}` per Q7,
  in this order: (1) `cell === "name"` → the text verbatim as text, even when
  it starts with `=` (a formula on `name` is refused by the store); (2) a
  leading `=` → a formula (the rest is the source; it must parse with
  `@vtt/formula`'s `parse`, else `ok: false` with the parser's message);
  formulas may be typed in any value editor this way (DESIGN §4.6 as amended
  by vtt-3l6.2); (3) `cell === "visible_to"` → the viewer forms (`all`, `gm`,
  `owner`, `@id`, comma-separated) as a viewers value; (4) the empty string →
  empty; `@id` (valid id) → ref; (5) a leading `[` → the list grammar:
  comma-separated items, each a scalar literal of (6), `@id`, or a nested
  list, at any depth (quoted text with FORMULAS §3.2 escapes); input that
  fails the list grammar is text; (6) otherwise the input is parsed as a
  formula and accepted as a literal only when the AST is literal-only (number
  with optional prefix minus, text, `true`/`false`, `empty`, a dice
  expression of dice terms and integers combined with `+`/`-` that satisfies
  the limits of FORMULAS §2.2, normalized with `@vtt/formula`'s dice
  notation); (7) anything else → text verbatim.
- `toInputText(cell: CellView, cellName: string): {kind: "formula"; source} | {kind: "literal"; text} | {kind: "unsupported"; reason}`
  (a pure formatter; editing permission is `cellCapabilities`)
  (review r1 finding 7, review r2 findings 5, 6). A formula cell whose
  `source` is present (GM views) → `formula`. Otherwise
  `valueToInputText(cell.value, cellName)` (exported; same result type
  without `formula`):
  - `name`: text verbatim, never quoted;
  - `visible_to`: viewer syntax (`all`, `gm`, `owner`, `@id`,
    comma-separated); a viewers value with a redacted entry → unsupported;
  - numbers: `Number.isInteger(n)` → integer digits, otherwise the shortest
    decimal that parses back to `n`, never exponent notation (if none within
    17 significant digits, or a magnitude that would need an exponent →
    unsupported); text quoted (escaped per FORMULAS §3.2) when the bare text
    would parse as something else; booleans; `empty`; dice (`expr`); refs as
    `@id`; lists recursively in the list grammar (`[@a, "x", 3, [true]]`);
  - rolls, errors (including `#REF` from a dangling reference), shapes,
    ink, viewers outside `visible_to`, redacted values → `unsupported` with a
    reason. Editors show an `unsupported` value of a cell whose capabilities
    allow `literal` as "replace value" (an empty input, same grammar, writing
    a literal or override) and otherwise read-only.
- `cellCapabilities(cellName, view: CellView | undefined, opts?: {readOnly?: boolean}): {literal: boolean; formula: boolean; replace: boolean; control?: "shape" | "tag" | "contents" | "placement" | "flags"}`
  (review r3 finding 4; every editor consults it before offering editing):
  with `readOnly` (character views) everything false; `id`, `template`,
  `is_zone` → nothing; `name` → `literal` only (text; the store refuses
  formulas); `tag` → `control: "tag"`; `contents` → `control: "contents"`;
  `shape` → `control: "shape"`; `board`, `container` → `control:
  "placement"` (moves), no value editing; `position`, `rotation`, `z` →
  `literal`, `formula`, `control: "placement"`; `is_template`,
  `is_character` → `control: "flags"`; `owner`, `face_up`, `opaque`,
  `visible_to` and every user cell → `literal`, `formula`; `replace` is true
  exactly when `formula` is allowed and `view.kind === "formula"`.
  Editors that write a literal or override over a formula cell use
  `valueToInputText(cell.value, cellName)`; editors of the formula source use
  `toInputText`. Round trip: for every `literal` result,
  `parseCellInput(text, {cell: cellName})` yields the same value.
- `cellInputToOps(object, cell, content, current?: CellView): WireOp[]`:
  formula → `set_formula`; literal → `set_value` (on a formula cell this is
  the override, M2 `writeValue`); `replaceFormulaOps(object, cell, value)` →
  `[{type: "set_value", object, cell, value, replace: true}]`, one op
  (vtt-3l6.19; also for structural cells such as `visible_to`);
  `isUnchangedInput(before, after, cellName)` (review r3 finding 5) parses
  both texts with `parseCellInput` for that cell and compares the resulting
  contents structurally (formulas by source with surrounding whitespace
  removed, verbatim text exactly, values by value);
  editors write nothing when it is true.
- `describeRejection(r: ProtocolRejection, refLabel): string` and
  `describeError(e: ProtocolError): string`: one sentence per variant
  (`stale_write` lists conflicting group labels and actors).

Done when: table-driven tests cover every value kind in both modes,
including a roll with dropped dice, a nested list with a redacted ref, an
error with origin and one without, viewers with a redacted entry;
`parseCellInput` cases: `12`, `-2`, `3.5`, `1e5` (text), `true`, `empty`,
`""` (empty text via `""`), `"12"` (text 12), `2d6+3`, `d20` (normalized
`1d20`), `1d6+1d20`, `0d6` (text: it lexes as a dice literal but breaks the
count limit of FORMULAS §2.2, which §3.2 makes `#TYPE` in a formula),
`[1, 2]`, `[@goblin1, "x", [3, @aldric]]`, `[@gm]` (text: reserved id),
`[1, ` (text),
`hello world`, `a + b` (text), `@goblin1`, `@gm` (text: reserved), `=max_hp -
damage_taken`, `=max_hp -` (`ok: false` with a message), `name` given
`=x` (text `=x`), `visible_to` given `gm`, `owner, @aldric`, `@aldric`;
`valueToInputText` round-trips each literal case through `parseCellInput`,
including a `name` of `12`, `=x` and ` padded ` (verbatim), a `visible_to` of
`gm, @aldric`, and a list of refs and quoted text nested two deep;
`0.1`, `1e21`, `1e-7`, `123456789.125` and `-0.5` give decimal text that
parses back to the same number or `unsupported` (never exponent notation);
a roll, a `#REF` error, a shape, ink and a redacted value are `unsupported`
with a reason, `writable` true for a user cell holding them and false for
`shape` and `contents`; `toInputText` of an overridden formula cell is the formula
source while `valueToInputText` of it is the override's literal text;
`isUnchangedInput`: in a text cell `hello` vs ` hello ` and `hello` vs
`hello\n` are changes, a changed `name` spacing is a change, `1` vs ` 1 ` in a
number cell is no change, `=a+b` vs `= a+b ` is no change and `=a+b` vs
`=a + b` is a change;
`cellCapabilities` cases: `board`, `container` and `contents` allow no
`literal`/`formula`, `name` allows `literal` only, `visible_to` holding a
formula allows `replace`, everything is false with `readOnly`;
`replaceFormulaOps` yields one `set_value` with `replace: true`;
`cellInputToOps` yields `set_value` for a literal on a formula cell (override)
and `set_formula` for `=`; `describeRejection` covers every variant of the
union; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
`pnpm test` exit 0.

Out of scope: React components; sending ops (vtt-3l6.21); list editing UI beyond
the grammar; ink input (M5).

Depends on: vtt-3l6.2, vtt-5su.3, vtt-3l6.19.

---

### M4-c — vtt-3l6.4 — UI: session and mirror lifecycle

Implements: DESIGN.md §7 Platform ("the UI and the agent are two clients of the same protocol"; formulas evaluate only in the authority), §4.3 Boards, §4.4 (view as; presentation filtered by effective visibility); docs/PROTOCOL.md §2 (hello `kind: "ui"`, session, explicit credentials, `unauthorized`), §4 (methods), §8 (subscriptions, commit events with `boards`, mirrors, reconnection, terminal resubscribe failures); DESIGN §4.6 View as in the UI (vtt-3l6.2); decisions Q1, Q2 of the M4 plan; review r1 findings 3, 11, 13, 15.

The UI's read side: connection and mirror lifecycle over vtt-5su.7's `ProtocolClient` with vtt-5su.19's `enableRecovery`. Writes, notices, UI state and React hooks are vtt-3l6.21. Exclusive files: `packages/ui/src/session/bootstrap.ts`, `packages/ui/src/session/table-session.ts`, tests `packages/ui/test/session/bootstrap.test.ts`, `packages/ui/test/session/lifecycle.test.ts`, `packages/ui/test/session/viewer-isolation.test.ts`, `packages/ui/test/session/boards.test.ts`. Adds dev dependencies `@vtt/authority` (workspace) and `@testing-library/user-event` 14.6.8 to `@vtt/ui`; `pnpm install`, lockfile in the same commit. A test asserts no file under `packages/ui/src` imports `@vtt/authority` or a `node:` module. Its tests start an in-process authority inline (`TableHost.inMemory` + `startServer({port: 0})`); the shared helper is vtt-3l6.21's. Adds its own sorted `export * from "./<module>"` lines to `packages/ui/src/index.ts` (CLAUDE.md package index rule).

- `readBootstrap(doc = document): {url, token} | null` reads the `<script id="vtt-session" type="application/json">` element (vtt-3l6.14).
- `createTableSession({url, token, WebSocket?}): TableSession`: `new ProtocolClient({url, token, client: {name: "vtt-ui", kind: "ui"}})` and `enableRecovery(client)` with explicit credentials. Read-side state, observable through `subscribe(listener)` / `getSnapshot()`: `{connection: null | ConnectionError, ready, revision, boards, table, activeBoard: BoardId | null, viewer: Viewer}`. `connection` reports `disconnected` (with `recovering`), and the terminal `unauthorized` and `wrong_table` states; an ordinary authority restart rotates the token, so with these explicit credentials it ends in `unauthorized` (vtt-3l6.17 offers a reload).
- Subscriptions (Q2): the **directory** `{scope: {type:"all"}, viewer: gm, cells: "structural"}`; the **board view** `{scope: {type:"board", board: activeBoard}, viewer, cells: "all"}`; a **selection view** `{scope: {type:"objects", ids}, viewer}` for selected ids outside the board view, always with the current viewer. `setView(board, viewer)` subscribes the new board view and, on a viewer change, the new selection view before unsubscribing the old ones (no empty frame); `watchObjects(ids)` maintains the selection view.
- Viewer isolation (review r1 finding 3): `objectView(id)` reads the current viewer's board view, then its selection view, and never another viewer's mirror; `refLabel(viewer, id)` reads only views of that viewer (for `gm`, also the directory) and otherwise returns the id; `directory()` is exposed for GM presentation and the view-as list only. `viewerKey()` returns a stable key of the current viewer for callers that cache queries.
- Boards (review r1 finding 11): `boards` follows `welcome` and every commit event carrying `boards`; when the active board is no longer in the list (a live removal, or a removal noticed after a reconnect), `activeBoard` becomes the first remaining board, or `null` with zero boards (vtt-3l6.10 shows the empty state). A board subscription that becomes `failed` through recovery is reported as a connection-level notice through `onConnectionNotice(listener)` (vtt-3l6.21 shows it) and is not treated as a removal.
- Accessors: `boardView(): {objects, covers, revision} | null`, `directory()`, `objectView(id)`, `refLabel(viewer, id)`, `client` (for vtt-3l6.21), `whenRevision(r): Promise<void>` (resolves once the client's revision reaches `r`).

Done when: tests against a real in-process authority show: `readBootstrap` returns the element's JSON and null without it; the session connects and its snapshot has the GM board, revision 0 and `activeBoard` `gm_board`; the directory lists an object created by a second client; switching to viewer Aldric replaces the board view with Aldric's (a GM-only cell absent, covers present) while the directory stays GM; viewer isolation: an object whose `name` has per-cell visibility gm is visible to Aldric and `refLabel(aldric, id)` returns its id, not the name; a selected object outside the board view is watched with the current viewer and re-subscribed with Aldric's viewer on a switch at an unchanged revision (the GM-only cell disappears without any commit), and `objectView` never returns the GM view while viewing as Aldric; board removal: another client removes the active (emptied) board while connected → `activeBoard` switches to the remaining board; the same removal while the session is disconnected (server-side socket drop with the same token, removal, recovery) → switched after resync; removing the last board → `activeBoard` null; a same-token socket drop recovers and clears `connection`; restarting the authority with a new token ends in `connection.code === "unauthorized"`; `whenRevision` resolves after the commit event; the import-boundary test passes; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: writes, undo, save, notices, `UiStore`, React hooks and the shared test helper (vtt-3l6.21); components (vtt-3l6.10, vtt-3l6.11, vtt-3l6.12, vtt-3l6.13, vtt-3l6.17); log scope subscriptions (M5).

Depends on: vtt-3l6.2, vtt-3l6.3, vtt-5su.7, vtt-5su.19, vtt-5su.10, vtt-5su.4.

---

### M4-c2 — vtt-3l6.21 — UI: writes, notices and UI state

Implements: DESIGN.md §7 Undo, §5.2 ("Writes … carry the revision they were based on, and are rejected on conflict"); docs/PROTOCOL.md §6 (`base_revision`, stale writes, `uncertain`, retries), §10 (rejections, errors); DESIGN §4.6, §7 as written by vtt-3l6.2 (undo `mine`; stale and uncertain writes shown, never retried); decisions Q9, Q10 of the M4 plan; review r1 findings 1, 10, 15; review r2 finding 3; review r3 findings 2, 11, 14.

The UI's write side, notices, local UI state and React bindings, on top of vtt-3l6.4's session. Exclusive files: `packages/ui/src/session/writes.ts`, `packages/ui/src/session/notices.ts`, `packages/ui/src/session/hooks.ts`, `packages/ui/src/state/ui-state.ts`, `packages/ui/src/state/runtime-inputs.ts`, `packages/ui/src/state/camera-store.ts`, `packages/ui/test/support/authority.ts` (the shared helper later beads import: starts an in-process authority, in memory or on a temp file, on port 0 with given `allowOrigins` and optional `http` handlers, returns `{url, token, host, server, client(name)}` and a cleanup), tests `packages/ui/test/session/writes.test.ts`, `packages/ui/test/session/notices.test.ts`, `packages/ui/test/state/ui-state.test.ts`, `packages/ui/test/session/hooks.test.tsx`. Adds its own sorted `export * from "./<module>"` lines to `packages/ui/src/index.ts` (CLAUDE.md package index rule).

- `createWritePort(session): WritePort` implementing vtt-3l6.22's `WritePort` exactly (`write(ops, {baseRevision, label?}): Promise<WriteOutcome>`, `WriteOutcome` as defined there; review r2 finding 3); review r1 finding 1: `baseRevision` is required and is sent unchanged as `base_revision` through `transactWithRetry(client, ops, {label, base_revision: baseRevision, retry: {timeoutMs: 10000}})`; the session never substitutes its latest revision. Callers capture it when an interaction begins (pointer down, editor open, formula bar focus) or at the click for instantaneous commands. A rejection pushes a notice from `describeRejection` (vtt-3l6.3); `stale_write` names the conflicting groups' labels and actors; `uncertain` pushes a sticky notice "may or may not have been applied: <label>"; nothing is retried or rebased.
- `undo(session)`: `undo {target: {type:"mine"}}`, pushing "Undid: <label>" or the refusal (`nothing_to_undo`, `undo_conflict`). `save(session)`; `save` events tracked as `{status, revision}`; `failed` and `saved_not_durable` push notices. Connection notices from vtt-3l6.4 (`onConnectionNotice`) become notices.
- `notices.ts` (sole owner of stickiness and expiry, review r3 finding 14): `Notice = {id, level: "info" | "success" | "warning" | "error", kind?: "stale" | "uncertain", text}`, `NoticeStore` (`push`, `dismiss`, `list`); one policy: `info` and `success` notices expire after 6 s (injectable clock); `warning`, `error` and every `stale`/`uncertain` notice stay until dismissed. vtt-3l6.17 only presents them and calls `dismiss`.
- `ui-state.ts`: `UiStore` = `{selection: ObjectId[], focusedCell: {object, cell} | null, hover: ObjectId | null, hoveredCell: {object, cell} | null, hoveredZone: ObjectId | null, highlight: ObjectId[], tool: {id, options}, camera: Camera, viewport: Viewport}` with setters (`select`, `focusCell`, `setHover`, `setHoveredCell`, `setHoveredZone`, `setHighlight`, `setTool(id, options?)`, `setCamera`, `setViewport`) and `cameraPort(): CameraPort` (vtt-3l6.22's interface; the only owner of camera state); `activeBoard` and `viewer` are read from and set through vtt-3l6.4's session (`setView`). Writers of `hoveredCell` are vtt-3l6.11 and vtt-3l6.13; `hover` and `hoveredZone` are written by vtt-3l6.23's runtime from the select tool's `hover` effect (vtt-3l6.7) and `hoveredZone` also by the object list (vtt-3l6.12); `highlight` is written only by tracing (vtt-3l6.24) (review r1 finding 10). Selection changes call `session.watchObjects`.
- `runtime-inputs.ts` (review r3 finding 2): `createRuntimeInputs(session, ui): RuntimeInputs` (vtt-3l6.22's interface): `views` = vtt-3l6.4's `objectView` (null when absent); `scene()` = vtt-3l6.5's `buildScene` over the current board view and covers, viewer, selection and highlight, with no previews (memoized per revision, viewer, board and selection); `viewport()` from `UiStore`; `activeBoard`, `viewer`, `revision` from the session; `onChange` fires on any change of board, viewer, revision or viewport. `createToolContext(session, ui, {pickFile, upload}): ToolContext` assembles the remaining ports (`write` = `createWritePort(session)`, `camera` = `ui.cameraPort()`, `notify` → `NoticeStore`).
- `camera-store.ts` (review r3 finding 11): `createCameraStore({ui, session, storage = localStorage})` with `restore(board): boolean` and `save(board)`, keyed by (`table.id ?? table.path`, board), every storage access in try/catch; `connect()` subscribes to the session: on an active-board change it saves the camera of the board being left and restores the new board's stored camera; when nothing is stored it marks the board `needsFit` (vtt-3l6.10's first-visit fit consumes and clears the mark).
- `hooks.ts`: `useSession(selector)`, `useUi(selector)`, `useNotices()` over `useSyncExternalStore`.

Done when: tests with the shared helper show: a write carries exactly the given `baseRevision`; the review r1 finding 1 scenario: the session begins an edit at revision r, a second client writes the same cell (r+1) and the session processes that commit, the session then submits with `baseRevision` r → `rejected` `stale_write`, a notice names the second client's label, and the second client's value is unchanged; a write with the current revision commits; `undo` undoes the session's own group and not a newer group of the other client, and a refused undo pushes the `undo_conflict` message; `save` on a file-backed host tracks `saved`; a forced `uncertain` (server dropped after the send, session changed) pushes a sticky notice; notices expire with a fake clock; notices: `info`/`success` expire after 6 s and `warning`/`error`/`stale`/`uncertain` do not (fake clock); `RuntimeInputs.onChange` fires on a board switch, a viewer switch, a commit and `setViewport`, and `scene()` reflects a commit; the camera store saves board A's camera on switching to B, restores it on returning to A, marks an unseen board `needsFit`, and tolerates a throwing `localStorage`; `UiStore` setters notify subscribers, `setTool` keeps options and `cameraPort()` reads and sets the camera; a type test assigns `createWritePort(session)` to `WritePort` and `cameraPort()` to `CameraPort` without casts; a jsdom test renders components with `useSession`, `useUi` and `useNotices` and re-renders on a commit and on a notice; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: connection, subscriptions and viewer switching (vtt-3l6.4); the interaction contracts and runtime (vtt-3l6.22, vtt-3l6.23); components (vtt-3l6.10, vtt-3l6.11, vtt-3l6.12, vtt-3l6.13, vtt-3l6.17).

Depends on: vtt-3l6.4, vtt-3l6.3, vtt-3l6.2, vtt-3l6.22, vtt-3l6.5.

---

### M4-e — vtt-3l6.5 — UI: camera, scene model and hit testing

Implements: DESIGN.md §4.1 (placement, facing), §4.3 (zones, boards,
tolerance), §4.4 (covers drawn above everything, fail-closed `face_up` and
`opaque`), §4.6 Appearance cells and Default rendering until faces (vtt-3l6.2),
§7 Scale ("the renderer may load and draw only the region in view");
FORMULAS.md §3.1 (`position`, `rotation`, `z`, `shape`, `face_up`, `opaque`,
`is_zone` and their defaults), §5 (z then id order); docs/PROTOCOL.md §7.2,
§7.5 (`ObjectView`, `Cover`); review r1 findings 4, 6; review r2 findings 3, 11.

Pure scene derivation and geometry, no canvas. Exclusive files:
`packages/ui/src/scene/camera.ts`, `appearance.ts`, `scene.ts`,
`hit-test.ts`, `polygon.ts`, tests `packages/ui/test/scene/*.test.ts`. Adds its own sorted `export * from "./<module>"`
lines to `packages/ui/src/index.ts` (CLAUDE.md package index rule).

- `Camera = {x, y, zoom}` (board point at the viewport center);
  `PX_PER_UNIT = 64`; zoom clamped to [1/32, 8] (Q18); `toScreen`, `toBoard`,
  `zoomAt(camera, screenPoint, factor, viewport)` (the board point under the
  cursor stays put), `panBy`, `fitBounds(bounds, viewport, margin)`,
  `visibleBounds(camera, viewport)`.
- `readAppearance(view: ObjectView): Appearance` reads `image`, `color`,
  `pattern`, `text`, `name`, `face_up`, `opaque`, `visible_to` from the cell
  views, ignoring values of the wrong kind (a `color` that is not text is no
  color).
- `buildScene({views, covers, board, viewer, selection, hover, highlight,
  previews, formatText}): Scene` with `Scene = {items: DrawItem[] /* back to front */,
  covers: CoverItem[], objectOverlays: OverlayItem[], skipped: ObjectId[]}`:
  items only for objects directly on `board` (`board` cell a ref to it,
  `container` empty) whose `position` is two finite numbers (others go to
  `skipped`); `rotation`/`z` non-numbers read as 0; order ascending `z` then
  id by code point; `previews: ScenePreviews` (`ReadonlyMap<ObjectId, {position?, rotation?,
  shape?}>`, exported; vtt-3l6.22 re-exports it as `Previews`) overrides
  geometry. `DrawItem = {id, anchor, rotation, shape | null,
  bounds, isZone, fill, image?, pattern?, text?, label?, faceDown, opaqueGm,
  hiddenBadge, alpha}` per the rules of Q5/Q6: zones transparent with a thin
  outline unless `color`/`pattern`; in a GM scene an opaque zone has a 35 %
  dark fill and dashed outline (`opaqueGm`) and an object whose `visible_to`
  is not exactly `all` gets `hiddenBadge`; in a character scene a visible
  opaque zone draws only its color/pattern; face-down (`face_up` not `true`
  for a character; `false` for the GM) draws the generic back and the label
  only; shapeless objects are a fixed 10 px marker. `CoverItem` = the
  transformed region of each `Cover` or `whole_board`. `objectOverlays`:
  selection outlines (per item bounds) and highlight outlines; they are
  object-related and are drawn before covers (vtt-3l6.6; DESIGN §4.4 as
  amended by vtt-3l6.2, review r1 finding 4). `isCovered(scene, point)`:
  whether a board point lies inside any `CoverItem` (used by the in-place
  editor and the renderer's clip test).
- `labelVisible(item, camera)`: the name label is drawn only when the item's
  on-screen size is at least 24 px (Q13).
- `polygon.ts` (review r2 finding 11; the only polygon validation in the UI,
  reused by vtt-3l6.8 and vtt-3l6.9): `polygonProblem(points): string |
  undefined` = `@vtt/schema`'s `shapeProblem({type: "polygon", points})`, the
  exact rule the authority enforces (at least three points; adjacent edges
  meet only at their shared vertex, so duplicate and collinear-folding
  vertices fail; non-adjacent edges never meet, touching included; exact
  arithmetic, no tolerance); `normalizePolygon(worldPoints) → {anchor,
  points}` (anchor = bounding-box center, points relative to it).
- `hitsAt(scene, point, camera): ObjectId[]` (review r1 finding 6): every
  item whose footprint contains the point (schema `pointInRegion` with the
  object's shape, anchor and rotation; shapeless within 6 px), ordered
  non-zones before zones, then descending `z`, then descending draw index
  (topmost first); empty when the point lies in a cover. `hitTest(scene,
  point, camera)` = the first entry or null. Callers cycle through the rest
  (Alt+click in vtt-3l6.7).
  `marqueeHit(scene, rect): ObjectId[]`: non-zone items whose bounds lie
  inside `rect`, then zones likewise.

Done when: tests show camera round trips (`toBoard(toScreen(p)) = p`),
`zoomAt` keeps the cursor's board point fixed, zoom clamping, `fitBounds`;
`buildScene` on fixed views orders by z then id, skips a contained object and
an object with an error `position`, applies `previews`, reads appearance
(image, color, hatch, text) and ignores a numeric `color`; GM scene marks an
opaque zone `opaqueGm` and a GM-only object `hiddenBadge`; a character scene
with a `whole_board` cover and a region cover yields two `CoverItem`s; a
face-down card is drawn as a back with its label for a character and for the
GM; `hitsAt` on a token above a map image above a room zone returns token,
image, zone in that order, `hitTest` picks the higher-z of two overlapping
tokens and a token over a zone that contains it, the zone on empty map area
inside it (with no image there), returns nothing inside a cover, handles a
rotated rect and a shapeless object; `isCovered` for points inside and
outside a region cover and anywhere with `whole_board`; selection and
highlight outlines are in `objectOverlays`; `polygonProblem` accepts a
triangle and a concave hexagon and rejects two points, a repeated vertex, a
collinear spike, a bow-tie and a vertex touching a non-adjacent edge, each
agreeing with `shapeProblem`; `normalizePolygon` round-trips world points;
marquee selects only fully enclosed items; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
`pnpm test` exit 0.

Out of scope: drawing (vtt-3l6.6); interaction (vtt-3l6.22, vtt-3l6.7); tool overlays such as handles, ghosts and creation previews (vtt-3l6.22); face layouts and show-when
(M5).

Depends on: vtt-3l6.2, vtt-3l6.3, vtt-5su.3.

---

### M4-f — vtt-3l6.6 — UI: Canvas2D renderer and board canvas

Implements: DESIGN.md §7 Platform as amended by vtt-3l6.2 ("Canvas2D with
viewport culling and an image cache; per-object render caching is deferred
until profiling asks (vtt-qf5.10)", behind a small renderer interface,
objects never DOM nodes, in-place editing a DOM overlay), §4.4 and §4.6 as
amended by vtt-3l6.2 (covers above every object and object-related overlay;
only viewer-independent chrome above covers); decisions Q16, Q18 of the M4
plan; review r1 findings 2, 4, 16.

Exclusive files: `packages/ui/src/render/renderer.ts`, `canvas2d.ts`,
`image-cache.ts`, `recording.ts`, `packages/ui/src/canvas/BoardCanvas.tsx`,
tests `packages/ui/test/render/*.test.ts`, `test/canvas/*.test.tsx`. Adds its own sorted `export * from "./<module>"`
lines to `packages/ui/src/index.ts` (CLAUDE.md package index rule).

- `interface Renderer { render(scene: Scene, toolOverlays: ToolOverlay[],
  camera: Camera, viewport: {width, height, dpr}): void; dispose(): void }`
  (`ToolOverlay` and its object/chrome split from vtt-3l6.22).
- `createCanvas2DRenderer(ctx: Ctx2D, {images: ImageCache})`, where `Ctx2D`
  is the subset of `CanvasRenderingContext2D` the renderer uses (exported).
  Draw order: clear; items back to front, culled against
  `visibleBounds` (an item whose bounds miss the view issues no draw call);
  per item: transform, clip to shape, fill, image (drawn into the shape's
  bounds), hatch (parallel lines at 45°, spacing 8 px, clipped), outline,
  text (wrapped to the shape's width, clipped), label below when
  `labelVisible`, face-down back, hidden badge; then object-related overlays
  (the scene's `objectOverlays`: selection and highlight outlines; tool
  overlays of the object kinds: drag ghosts, handles, creation previews,
  polygon drafts); then covers (solid `#101014`; `whole_board` fills the
  viewport); then only chrome overlays (marquee, crosshair). Nothing
  object-related is drawn after the first cover (review r1 finding 4). DPR
  scaling.
- `ImageCache({resolve: (path) => url, onLoad})`: loads each URL once
  (`HTMLImageElement`), returns the image when loaded, `null` while loading,
  `"error"` after a failure (the renderer draws a crossed placeholder);
  `onLoad` requests a redraw. Default resolver `assetUrl` from vtt-3l6.16 is passed
  in by vtt-3l6.17; the cache itself takes any function.
- `RecordingContext`: implements `Ctx2D` and records calls (name, args,
  current transform), for tests.
- `<BoardCanvas scene toolOverlays camera createRenderer onEvent overlay>`:
  owns a `<canvas>` sized to its container (`ResizeObserver` when
  available), renders on `requestAnimationFrame` when props change, converts
  DOM pointer, double-click, wheel, key and file-drop (`dragover`/`drop` with
  files: `onFileDrop` is part of `onEvent` as vtt-3l6.22's `file_drop`
  event) events into vtt-3l6.22's `InteractionEvent` union using the camera
  and the canvas rect (`inTextField` set when the key event's target is an
  input, textarea or contenteditable), captures the pointer during drags, and
  renders `overlay` (React children, absolutely positioned DOM layer over the
  canvas, for vtt-3l6.13).
  `createRenderer(canvas)` defaults to `createCanvas2DRenderer(canvas.getContext("2d"))`;
  tests inject a recording renderer (jsdom has no 2D context).

Done when: renderer tests with `RecordingContext` show: for a scene with a
region cover that contains a selected, highlighted token with a handle
overlay and a drag ghost, no call that draws an item, an outline, a handle or
a ghost occurs after the first cover fill (call-order assertion), and a clip
test (the recording context tracks the clip region and fill extents) shows
no object-related pixel is filled inside the cover's region after it; the
marquee is drawn after covers; an off-screen item issues no calls; a
`pattern: "hatch"` zone draws clipped hatch lines and a zone without it none;
an image item draws the image once loaded and the placeholder after an error;
a face-down item draws the back and no text; the label is skipped below the
LOD threshold; `whole_board` fills the viewport; DPR 2 doubles the canvas
size and scales the transform; `ImageCache` loads a URL once and calls
`onLoad`; jsdom tests of `BoardCanvas` with an injected renderer show a
pointer down/move/up sequence produces `InteractionEvent`s with correct
board coordinates for a given camera, double-click, wheel and a key event
reach `onEvent` (a key typed in an input has `inTextField: true`), a dropped
`File` produces a `file_drop` event with its board point, and the overlay
children render above the canvas; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
`pnpm test` exit 0.

Out of scope: per-object bitmap caching (vtt-qf5.10); interaction logic
(vtt-3l6.22, vtt-3l6.7); PixiJS; face layouts (M5).

Depends on: vtt-3l6.5, vtt-3l6.22.

---

### M4-g0a — vtt-3l6.22 — UI: interaction contracts and navigation reducer

Implements: DESIGN.md §7 Platform (canvas scene, DOM chrome, in-place editing as a DOM overlay), §4.4 (covers above everything), §4.6 On the canvas, §7 Undo (writes carry the revision their interaction began on), all as written by vtt-3l6.2; docs/PROTOCOL.md §4 (`TransactResult` records with `op_index`), §6 (`base_revision`); review r1 findings 1, 2, 4; review r2 findings 3, 4, 8, 12; review r3 finding 2.

The public interaction contracts and the pure navigation reducer. Types and pure functions only: no session, no React, no promises executed. The runtime is vtt-3l6.23. Exclusive files: `packages/ui/src/interaction/contracts.ts`, `events.ts`, `tool.ts`, `overlays.ts`, `effects.ts`, `machine.ts`, `registry.ts`, tests `packages/ui/test/interaction/contracts.test.ts`, `machine.test.ts`. Adds its own sorted `export * from "./<module>"` lines to `packages/ui/src/index.ts` (CLAUDE.md package index rule).

- `contracts.ts` (review r2 finding 3; implemented elsewhere, defined only here):
  - `WriteOutcome` = `{status: "committed"; revision; index; created: {op_index, id}[]; copies: {op_index, root, copies}[]; bindings}` | `{status: "rejected"; rejection; op_index?}` | `{status: "uncertain"; reason}` | `{status: "failed"; error}`.
  - `WritePort = {write(ops: WireOp[], opts: {baseRevision: number; label?: string}): Promise<WriteOutcome>}` (implemented by vtt-3l6.21).
  - `CameraPort = {get(): Camera; set(camera: Camera): void}` (camera state lives in vtt-3l6.21's `UiStore`).
  - `ToolContext = {activeBoard(): BoardId | null; viewer(): Viewer; revision(): number; camera: CameraPort; write: WritePort; notify(level, text): void; pickFile(accept): Promise<File | null>; upload(file): Promise<{path; width; height}>}` (implemented by vtt-3l6.21's `createToolContext`, with `pickFile` and `upload` supplied by vtt-3l6.17).
  - `Viewport = {width: number; height: number; dpr: number}` (CSS pixels).
  - `RuntimeInputs = {views(id): ObjectView | null; scene(): Scene; viewport(): Viewport; activeBoard(): BoardId | null; viewer(): Viewer; revision(): number; onChange(fn: () => void): () => void}` (review r3 finding 2; implemented by vtt-3l6.21 over the session and `UiStore`; `onChange` fires on board, viewer, revision and viewport changes; vtt-3l6.23 subscribes to it and builds each `ReducerInput` from it).
  - `Previews` = vtt-3l6.5's `ScenePreviews` (re-exported; `buildScene` takes it as `previews`).
  - `InteractionStamp = {interactionId: string; board: BoardId; viewer: Viewer; baseRevision: number}`, captured by a tool when an interaction starts (pointer down, key press, file drop, click) (review r2 finding 8).
- `events.ts`: `InteractionEvent` = pointer down/move/up/cancel `{pointerId, screen, board, button, buttons, modifiers: {shift, alt, ctrl, meta}}` | `double_click` | `wheel {deltaX, deltaY}` | `key_down`/`key_up {key, code, modifiers, inTextField}` | `file_drop {files}` | `settled {interactionId, outcome}` with `outcome` = `{type: "write", result: WriteOutcome}` | `{type: "file_picked", file: File | null}` | `{type: "uploaded", path, width, height}` | `{type: "upload_failed", message}`; all positional events carry `screen` and `board` points.
- `tool.ts`: `ToolId` union (`select`, `token`, `card`, `note`, `zone-rect`, `zone-circle`, `zone-polygon`, `image`); `ToolOptions` tagged per tool (zone tools `{fog: boolean}`); `ToolState<TPhase> = {tool, options, phase: TPhase}`; `Tool<TPhase> = {id, cursor(state), reduce(state, event, input: ReducerInput): {state, effects: Effect[]}, cancel(state): {state, effects}}`; `ReducerInput = {scene: Scene; viewport: Viewport; activeBoard: BoardId | null; viewer: Viewer; revision: number; camera: Camera; selection: ObjectId[]; views: (id) => ObjectView | null}` (a snapshot taken from `RuntimeInputs` and `UiStore`; reducers never call ports; navigation uses `viewport` for `zoomAt`).
- `overlays.ts`: `ToolOverlay` kinds `drag_ghost`, `handles`, `creation_preview`, `polygon_draft` (object-related, drawn before covers) and `marquee`, `crosshair` (chrome, drawn after covers); `OBJECT_OVERLAY_KINDS`, `CHROME_OVERLAY_KINDS`.
- `effects.ts`: `Effect` = `{type: "write"; stamp: InteractionStamp; ops; label; continuations: Continuation[]}` | `{type: "select"; ids}` | `{type: "camera"; camera}` | `{type: "previews"; previews: Previews; hold?: {stamp: InteractionStamp}}` | `{type: "overlays"; overlays: ToolOverlay[]}` | `{type: "hover"; id: ObjectId | null; zone: ObjectId | null}` | `{type: "notice"; level; text}` | `{type: "set_tool"; tool; options?}` | `{type: "pick_file"; stamp; accept}` | `{type: "upload"; stamp; file}` | `{type: "open_editor"; stamp; object; cell?}` | `{type: "close_editor"}`. `Continuation` = `{type: "select_created"; opIndex: number}` (resolved by matching `op_index` in `created`, or the `root` of the `copies` record with that `op_index`; never by array position) | `{type: "select"; ids}` | `{type: "set_tool"; tool}`; continuations run in list order, only on `committed` (review r2 finding 4). A tool that wants "select, then switch to select unless Shift" records the decision taken at the click in the list it emits.
- `machine.ts`: `reduce(state, event, input, registry)` (pure): wheel → `camera` effect from `zoomAt` (factor `1.1^(-deltaY/100)`); middle-button drag or Space + drag → `camera` effects (pan); Escape → the active tool's `cancel`; events with `inTextField` dropped; a tool switch or board change calls the active tool's `cancel` first; everything else goes to the active tool. Reducers emit `camera` effects and never mutate camera state.
- `registry.ts`: `ToolRegistry` (`register`, `get`); a duplicate id throws.

Done when: type-level tests (`expectTypeOf`) pin `WritePort`, `WriteOutcome`, `CameraPort`, `ToolContext`, `Viewport`, `RuntimeInputs`, `ReducerInput`, `Previews`, `InteractionStamp`, the event, effect, continuation, overlay and tool-state unions; machine tests with a stub tool show wheel zoom emits a `camera` effect keeping the cursor's board point, Space-drag and middle-drag emit pan `camera` effects without reaching the tool, Escape and a tool switch call `cancel`, `inTextField` keys are dropped, other events reach the tool; registering a duplicate id throws; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: executing effects, ports, previews' lifetime, React (vtt-3l6.23); concrete tools (vtt-3l6.7, vtt-3l6.8, vtt-3l6.9); drawing (vtt-3l6.6).

Depends on: vtt-3l6.2, vtt-3l6.5.

---

### M4-g0b — vtt-3l6.23 — UI: interaction runtime and React binding

Implements: DESIGN.md §7 Platform, §7 Undo, §5.2 (writes carry their base revision) as written by vtt-3l6.2; docs/PROTOCOL.md §4, §6; decision Q10 of the M4 plan; review r2 findings 3, 4, 8, 12; review r3 findings 1, 2.

The interaction runtime: executes vtt-3l6.22's effects against real ports and binds them to React. Exclusive files: `packages/ui/src/interaction/runtime.ts`, `packages/ui/src/interaction/use-interaction.ts`, tests `packages/ui/test/interaction/runtime.test.ts`, `packages/ui/test/interaction/contract-composition.test.tsx`. Adds its own sorted `export * from "./<module>"` lines to `packages/ui/src/index.ts` (CLAUDE.md package index rule).

- `createInteractionRuntime({registry, inputs: RuntimeInputs, toolContext: ToolContext, ui: UiStore, editor: EditorPort, whenRevision: (r) => Promise<void>})` (`RuntimeInputs` and `ToolContext` from vtt-3l6.22, implemented by vtt-3l6.21; `whenRevision` is vtt-3l6.4's; `EditorPort` = `{open({stamp, object, cell?}), close()}`, exported from this file, implemented by vtt-3l6.13). For each event it builds a `ReducerInput` from `inputs` (`scene()`, `views`, `viewport()`, `activeBoard()`, `viewer()`, `revision()`) and `ui` (selection, camera), calls `reduce`, and executes the effects in order. It keeps every tool's state, so a `settled` result goes to the tool whose effect started it (by `interactionId`), active or not.
  - `write` → `toolContext.write.write(ops, {baseRevision: stamp.baseRevision, label})`; on settle it dispatches `settled`; on `committed` it runs the continuations in order only if the interaction was not cancelled and `stamp.board` is still the active board; otherwise none (the write still applies to `stamp.board`; a non-committed outcome is already a notice from vtt-3l6.21).
  - `upload` → `toolContext.upload(file)`, `pick_file` → `toolContext.pickFile(accept)`, each dispatching `settled` with its stamp's `interactionId`.
  - Lifecycle (review r3 finding 1; the same policy as vtt-3l6.8): the runtime subscribes to `inputs.onChange`; a board or viewer change, Escape or a tool switch calls the active tool's `cancel`, which ends unfinished gestures only (drags, marquees, polygon drafts, a file picker whose dialog is dismissed). A started upload always finishes on its stamped board: its `uploaded` result still reaches the originating tool, which creates the object on `stamp.board`; selection and tool continuations are skipped when the board or tool changed meanwhile. A pending write is always awaited; a non-committed outcome produces its notice.
  - `previews` with `hold` are kept until `whenRevision(committed revision)` resolves and cleared at once on any other outcome or on cancel; `camera` → `toolContext.camera.set`; `select`, `hover`, `set_tool` → `UiStore` setters; `notice` → `toolContext.notify`; `open_editor`/`close_editor` → `EditorPort`.
- `useInteraction({runtime})` returns `{overlays: ToolOverlay[], previews: Previews, handlers}`; `handlers` match vtt-3l6.6's `BoardCanvas` `onEvent`; vtt-3l6.17 passes `previews` into `buildScene` (vtt-3l6.5) and `overlays` to `BoardCanvas`.

Done when: runtime tests with fake ports show: a write uses its stamp's `baseRevision` after the revision advanced; continuations run in order (select created, then `set_tool select`) on `committed`, and with the Shift decision recorded the tool stays; `select_created` in a mixed transaction (a `set_value`, a `create_object`, a `spawn`) selects the records matching the given `op_index` values; a board switch during a pending upload still creates the object on the stamped board and changes neither selection nor tool; a tool switch during a pending upload creates it and keeps the new tool; a tool switch during a pending write runs no continuation and still shows a rejection notice; a viewer change via `onChange` cancels a drag (no write); a held preview stays until `whenRevision` resolves and clears on rejection and on cancel. The contract-composition test (jsdom) wires vtt-3l6.4's real session (in-process authority via vtt-3l6.21's helper), vtt-3l6.21's `UiStore`, `RuntimeInputs` and write port, this runtime and hook, and vtt-3l6.6's `BoardCanvas` with a recording renderer, with no casts or adapters, plus a real view-reading tool defined in the test file (on pointer down it hit-tests `input.scene` with vtt-3l6.5's `hitTest`, reads the hit object's `ObjectView` through `input.views`, and on pointer up writes a `move` of it): a drag over a token on a real board view commits the move, and a wheel event changes the stored camera; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: the contracts and the reducer (vtt-3l6.22); concrete tools (vtt-3l6.7, vtt-3l6.8, vtt-3l6.9); the editor (vtt-3l6.13); app composition (vtt-3l6.17).

Depends on: vtt-3l6.22, vtt-3l6.21, vtt-3l6.6.

---

### M4-g — vtt-3l6.7 — UI: select tool: select, move, pan, zoom, containment, template drag

Implements: DESIGN.md §3.3 (placement, stacking, facing, containment), §4.1 (containment; templates and copying), §4.7 ("Dragging a template straight onto the table creates a copy there"), §8.1 (pan, zoom, stacking, facing, single-parent containment, template copying); FORMULAS.md §3.1 (landing rule), §8.3 (`move`, `spawn`); docs/PROTOCOL.md §5 (`move`, `spawn`, `remove`, `set_value`), §6 (`base_revision`); DESIGN §4.6 On the canvas (vtt-3l6.2); decisions Q10, Q11, Q12 of the M4 plan; review r1 findings 1, 5, 6, 15; review r2 findings 8, 10; review r3 findings 2, 7.

The select tool on vtt-3l6.22's interaction contract: a `Tool` registered under id `select`, plus its keyboard commands. Navigation (wheel zoom, pan) is the contract's machine. Exclusive files: `packages/ui/src/interaction/select-tool.ts`, `packages/ui/src/interaction/keys.ts`, tests `packages/ui/test/interaction/select-tool.test.ts`, `packages/ui/test/interaction/keys.test.ts`, `packages/ui/test/interaction/select-integration.test.tsx`. Adds its own sorted `export * from "./<module>"` lines to `packages/ui/src/index.ts` (CLAUDE.md package index rule).

- Selection: click selects the first entry of `hitsAt` (vtt-3l6.5) at the point (Shift toggles it in the selection); click on empty clears; Alt+click without movement cycles to the next entry of `hitsAt` on repeated clicks at the same point (within 4 px; the cycle resets when the point or the hit list changes), so a room zone under an imported map image can be selected (review r1 finding 6). Drag on empty draws a marquee (`marqueeHit`; a `marquee` chrome overlay). Hovering emits `hover {id, zone}` with `id` = the first hit and `zone` = that hit when it is a zone, else null; after an Alt+click the cycled target is the hover target (`id`, and `zone` when it is a zone) until the pointer leaves that target's footprint (review r2 finding 10), so a room zone over a map image can be traced.
- Dragging: pointer down on a selected or hit object captures an `InteractionStamp` (`board` = active board, `viewer`, `baseRevision` = `input.revision`; review r1 finding 1, review r2 finding 8); the drag's intent is fixed at that pointer down (review r3 finding 7): `spawn` when the selection being dragged is exactly one object, it is a template (`is_template`) and Alt is not held; otherwise `move` (Alt on a single template, several templates, or templates mixed with other objects: all moved, never spawned). Modifier changes during the gesture do not change the intent. Beyond a 4 px threshold the selection is dragged with a `drag_ghost` overlay and `previews`. Drop with intent `spawn` → `spawn {template, to: {type:"board", board: stamp.board, position}}` with `continuations: [{type: "select_created", opIndex: 0}]` (Alt at the drop is ignored). Drop with intent `move`: over another non-zone object not in the selection with Alt held at the drop → one `move` per selected object to `{type:"container", container}` (appending); else one `move` per object to `{type:"board", board: stamp.board, position}` (the landing rule raises them). All ops of one drop are one `write` with the stamp and `previews` held by that stamp; labels "Move <name>", "Move N objects", "Put <name> into <container>", "Copy <template>". A click without movement writes nothing. Drops land only on the active board: there is no cross-board drag in M4 (moving between boards is vtt-3l6.10's "Move selection to board…", review r1 finding 5). A board switch or Escape during a drag cancels it (no write, previews cleared). Double-click on an object → `open_editor {stamp, object}` (the editor decides the cell, vtt-3l6.13).
- Keyboard (`keys.ts`, each capturing a stamp at the key press): Delete/Backspace → one `remove` per selected object; `F` → `set_value face_up` toggled per object; `]` → bring to front (`move` to its own position, landing rule); `[` → send to back (`set_value z` = 1 less than the lowest literal z on the board); arrows nudge by 0.1 unit (Shift: 1) via `set_value position`; Escape clears the selection when no drag is active.

Done when: pure reducer tests on a fixed scene show: click/shift-click/empty-click selection; Alt+click cycling through a token, a map image and a zone stacked at one point, the reset when the point moves, and the cycled zone staying the hover target (`zone` set) until the pointer leaves it; marquee; a drag beyond threshold produces ghost and preview and on drop one `write` with N `move` ops, the right positions and the stamp's `baseRevision` captured at pointer down even though `input.revision` advanced during the drag; `cancel` during a drag emits no write; a drag under 4 px writes nothing; Alt-drop over a token produces container moves; dropping a template dragged without Alt produces one `spawn` with `select_created` and one dragged with Alt a `move`; pressing Alt after a template drag started still spawns and releasing Alt during an Alt template drag still moves; Alt at the drop of a spawn drag does not contain; dragging two templates, or a template and a token, moves both and never spawns; each key command produces its ops (z for send-to-back from literal z only). Integration (jsdom, vtt-3l6.21's helper, `BoardCanvas` with a recording renderer, vtt-3l6.23's runtime): dragging a token moves it in the authority; dragging a template creates a copy with `template` pointing at it and the copy is selected; Alt-dropping a die onto a token puts it in the token's `contents`; a drag that began before another client moved the same token is rejected `stale_write`, the preview clears and the notice shows; Alt+click selects a zone lying under an imported map image; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: the contracts and navigation (vtt-3l6.22); the runtime (vtt-3l6.23); creation tools (vtt-3l6.8); handles (vtt-3l6.9); in-place editing (vtt-3l6.13); cross-board dragging; snapping and grids (vtt-qf5.14); drag from the contents list (vtt-qf5.13).

Depends on: vtt-3l6.22, vtt-3l6.23, vtt-3l6.21, vtt-3l6.5, vtt-3l6.6.

---

### M4-h — vtt-3l6.8 — UI: creation tools (objects, zones, images)

Implements: DESIGN.md §4.3 (zones: rectangle, circle, polygon), §4.4 (opaque zones), §8.1 (objects with image and shape; opaque zones), §8.4 step 3 ("Import the dungeon map as one image … Draw six opaque zones over the rooms, each `visible_to = gm`"); FORMULAS.md §3.1 (`shape`, `is_zone`, `opaque`); FIXTURES.md §3 (shape encoding, polygons relative to the anchor); docs/PROTOCOL.md §4 (`created` records), §5 (`create_object`); DESIGN §4.6 Appearance cells, §7 assets (vtt-3l6.2); decisions Q15, Q21, Q22 of the M4 plan; review r1 findings 1, 2; review r2 findings 4, 8, 11; review r3 finding 1.

Exclusive files: `packages/ui/src/interaction/create-tools.ts`, tests `packages/ui/test/interaction/create-tools.test.ts`, `packages/ui/test/interaction/create-integration.test.tsx`. Adds its own sorted `export * from "./<module>"` lines to `packages/ui/src/index.ts` (CLAUDE.md package index rule).

- Tools (each a vtt-3l6.22 `Tool`, registered in its `ToolRegistry`): `token` (click: circle r 0.5, name "Token"), `card` (click: rect 2.5 × 3.5, name "Card"), `note` (click: rect 2 × 2, `color` "#fff3a0", `text` empty, name "Note"), `zone-rect` and `zone-circle` (drag from corner / center; minimum 0.25 units; a click alone makes a 2 × 2 / r 1 zone), `zone-polygon` (click vertices; close with a click on the first vertex, a double-click or Enter; Escape cancels; the closed polygon is checked with vtt-3l6.5's `polygonProblem` and, if it has a problem, refused with a `notice` and no write; points via vtt-3l6.5's `normalizePolygon`), `image` (a click emits `pick_file {accept: "image/png,image/jpeg,image/webp,image/gif"}`; a `file_drop`, or a `settled` `file_picked` with a file, emits `upload`; on `settled` `uploaded` the tool writes a rect `width / 100 × height / 100` units (Q21) at the click or drop point with `image` = the path and `name` = the file stem; `upload_failed` → `notice`). Zone tools read `{fog}` from `ToolState.options`; with fog the zone also gets `opaque: true` and `visible_to: viewers [gm]`. Previews are `creation_preview` and `polygon_draft` overlays. No polygon validation of its own (review r2 finding 11).
- Each creation captures an `InteractionStamp` at the pointer down, key press, click or drop that starts it (`board` = the active board). Upload policy (review r3 finding 1, the same paragraph as vtt-3l6.23): a started upload always finishes on its stamped board: the image object is created on `stamp.board`, and if the board or tool changed meanwhile, selection and tool stay unchanged; cancellation (Escape, tool or board switch) applies only to unfinished gestures (drags, polygon drafts, a file picker whose dialog is dismissed) and emits one `create_object` write (op 0, anchor = bounding-box center, `id_base` by kind: `token`, `card`, `note`, `zone`, `image`; vtt-3l6.19) with `continuations` `[{type: "select_created", opIndex: 0}]`, plus `{type: "set_tool", tool: "select"}` unless Shift was held at the starting event (decided then and recorded in the list, review r2 finding 4).

Done when: reducer tests show for each tool the emitted effects for given event sequences: shapes, anchors, ids bases, stamps, both continuation lists (with and without Shift), polygon closing by each gesture, Escape cancel, minimum sizes, fog cells, a bow-tie polygon refused with a notice and no write, and for `image` the `pick_file` → `upload` → write sequence driven by `settled` events; integration (jsdom, vtt-3l6.21's helper with vtt-3l6.16's asset handler, vtt-3l6.23's runtime with an injected `upload` measuring a fixed size): the image tool with a small PNG `File` creates an object whose `image` cell is the listed asset path, sized from the measurement, selected, with an `image_<n>` id, and the tool returns to select; with Shift the tool stays; a fog rect zone is created with `is_zone`, `opaque` true and `visible_to` gm; a polygon zone round-trips through the authority with the same world-space vertices; switching boards during the upload still creates the image on the original board and changes neither selection nor tool; switching tools during the upload also creates it and leaves the new tool active; Escape during a polygon draft creates nothing; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: polygon validation (vtt-3l6.5); freehand ink and the text tool (M5); resizing after creation (vtt-3l6.9); grids and snapping (vtt-qf5.14); the select tool (vtt-3l6.7); the runtime (vtt-3l6.23).

Depends on: vtt-3l6.22, vtt-3l6.23, vtt-3l6.21, vtt-3l6.5, vtt-3l6.16, vtt-3l6.14, vtt-3l6.19.

---

### M4-i — vtt-3l6.9 — UI: resize, vertex and rotate handles

Implements: DESIGN.md §4.1 (placement with rotation), §4.3 (shapes),
§8.1 (objects with shape); FORMULAS.md §3.1 (`shape` written only through
`setShape`; `position`, `rotation` writable as hand edits); docs/PROTOCOL.md
§5 (`set_shape`, `set_value`), §6 (`base_revision`); review r1 findings 1,
4, 6; review r2 findings 8, 11.

Exclusive files: `packages/ui/src/interaction/handles.ts`, tests
`packages/ui/test/interaction/handles.test.ts`. Provides a `Tool` decorator
(`withHandles(selectTool)`, typed with vtt-3l6.22's `Tool`) that vtt-3l6.17
composes; no edits to vtt-3l6.7's or vtt-3l6.22's files. Adds its own sorted `export * from "./<module>"`
lines to `packages/ui/src/index.ts` (CLAUDE.md package index rule).

- For exactly one selected object with a shape (GM view only): rect — eight
  handles; dragging a corner keeps the opposite corner fixed (writes
  `set_shape` and `set_value position`, one write); edges change one
  dimension; circle — one radius handle; polygon — one handle per vertex
  (moves that vertex, keeps the anchor; a result for which vtt-3l6.5's
  `polygonProblem` reports a problem is refused with a notice and no write;
  no validation of its own); rotate handle 24 px above the top edge → `set_value rotation`
  (degrees clockwise, Shift snaps to 15°). Handles live in object-local
  coordinates (rotation respected). An `InteractionStamp` is captured at the
  pointer down on a handle; `previews` during the drag; one write on release
  with that stamp and previews held by it; Escape or a board switch cancels
  (no write). Handles are emitted as
  a `handles` tool overlay (an object-related kind, drawn below covers by
  vtt-3l6.6).
- `handlesFor(item, camera)` and `hitHandle(handles, screenPoint)` exported;
  a pointer down that hits no handle is passed to the wrapped select tool
  unchanged (so Alt+click cycling still selects a zone under a map image).

Done when: tests on a rotated rect show corner drag keeps the opposite
corner's world position and yields `set_shape` + `set_value position`;
edge drag; circle radius; polygon vertex move and a refused bow-tie; rotate
with and without snapping; no handles for a shapeless object, for multiple
selection, or in a character view; a handle drag writes with the
stamp's `baseRevision` captured at pointer down even after `input.revision`
advanced; cancel during a handle drag writes nothing;
a non-handle pointer down reaches the wrapped tool; integration (jsdom,
vtt-3l6.21's helper, vtt-3l6.23's runtime and a recording renderer): a room zone lying under
an imported map image is selected with Alt+click and resized with a corner
handle, which changes its shape and `contents(zone)` membership via the
`zones` query (review r1 finding 6); `pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
`pnpm test` exit 0.

Out of scope: creation (vtt-3l6.8); multi-object transforms (vtt-qf5.15); editing
`position` formulas (an override is written, per the store).

Depends on: vtt-3l6.7, vtt-3l6.22, vtt-3l6.23, vtt-3l6.5.

---

### M4-j — vtt-3l6.10 — UI: boards and view-as

Implements: DESIGN.md §4.3 Boards (several boards, navigation, removal only
when empty, ids reserved), §4.1 Characters ("The 'view as' list offers every
object with `is_character` true and `is_template` false"), §4.4 (view as),
§8.1 (multiple boards; view-as in one window); docs/PROTOCOL.md §2
(`welcome.boards`), §5 (`add_board`, `rename_board`, `remove_board`, `move`),
§8 (`boards` on commit events); DESIGN §4.6 View as in the UI (vtt-3l6.2);
decision Q14 of the M4 plan; review r1 findings 1, 5, 11; review r3 finding 11.

Exclusive files: `packages/ui/src/nav/BoardTabs.tsx`, `ViewAsMenu.tsx`,
`board-ids.ts`, `first-visit-fit.ts`, tests `packages/ui/test/nav/*.test.ts(x)`. Adds its own sorted `export * from "./<module>"`
lines to `packages/ui/src/index.ts` (CLAUDE.md package index rule).

- `BoardTabs`: one tab per board in `session.boards` order (name, else id);
  click activates; "+" asks for a name and sends `add_board {id, name}` with
  `id = boardIdFor(name, existing)` (`board-ids.ts`: lowercase, non-id
  characters → `_`, leading non-letter prefixed `b_`, `gm`/`all`/`owner`
  suffixed, `_2`, `_3` … when taken; on an `invalid` "reserved" rejection the
  next suffix is tried, at most five times); double-click renames
  (`rename_board`); the context menu removes (`remove_board`; the refusal for
  a non-empty board shows as a notice). Every board command captures
  `baseRevision` at the click (vtt-3l6.21's `write`).
- "Move selection to board…" (owned here; the only way to move objects
  between boards in M4, review r1 finding 5): a command in the tab bar and
  in each tab's context menu (the tab names the target) that, for the
  selected objects directly on the active board, sends one write with a
  `move` per object to `{type:"board", board: target, position: its current
  position}` (label "Move N objects to <board>"), then activates the target
  board with the moved objects selected. Disabled with no selection or when
  the target is the active board.
- Zero boards (review r1 finding 11): when vtt-3l6.4 reports `activeBoard`
  null, the canvas area shows an empty state "No boards" with an "Add board"
  button (the same flow as "+"). Switching away from a removed active board
  is vtt-3l6.4's; this bead renders the result.
- `ViewAsMenu`: "GM" plus every directory object with `is_character` true and
  `is_template` false, sorted by name then id; choosing one calls
  `session.setView(activeBoard, viewer)` (vtt-3l6.4); while viewing as a character a banner "Viewing as
  <name> — read-only inspector" shows with a "Back to GM" button.
- `first-visit-fit.ts`: `useFirstVisitFit({session, ui, cameraStore})`: when
  the active board is marked `needsFit` by vtt-3l6.21's camera store and its
  board view has arrived, sets the camera to vtt-3l6.5's `fitBounds` of the
  board's item bounds (or centers on 0,0 for an empty board) and clears the
  mark; saving and restoring cameras is vtt-3l6.21's.

Done when: jsdom tests with an in-process authority show: tabs list the
boards, adding "Crypt" creates board `crypt` and activates it, adding
"Crypt" again creates `crypt_2`, a board id retired by an earlier removal is
skipped after the rejection; renaming updates the tab after the commit event;
removing a non-empty board shows the refusal notice, removing an empty one
removes the tab and activates another; another client removing the active
board moves the tabs to the remaining board; removing the last board shows
the empty state and "Add board" creates one; "Move selection to board…" with
three goblins selected on the GM board moves them to Crypt at the same
positions in one undoable group, activates Crypt and keeps them selected,
and is disabled without a selection; the view-as menu lists characters but not character
templates, choosing Aldric switches the board view to Aldric's (a hidden
object disappears, covers appear) and the banner shows; `boardIdFor` cases;
the first-visit fit waits until the board view arrives, then fits its
items, and does nothing for a board whose camera was restored; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
`pnpm test` exit 0.

Out of scope: cross-board dragging; board reordering (vtt-y1w.13); per-board grid/units
(vtt-y1w.14); a separate player window (non-goal for v1).

Depends on: vtt-3l6.21, vtt-3l6.4, vtt-3l6.5.

---

### M4-k1 — vtt-3l6.11 — UI: inspector cells

Implements: DESIGN.md §4.2 ("Every formula is visible and editable … A
computed cell can be manually overridden. The override is visible as such …
the inspector says so"), §4.4 (per-cell visibility as metadata; literal
viewer sets), §4.6 The inspector ("lists every cell as name and value,
formulas shown as formulas with the computed result alongside, overrides
marked … cells are added, removed, renamed, and given their own visibility
… broken references are repaired"), §7 Smaller decisions (rename rules);
FORMULAS.md §2.3 (error message and origin), §3.1 (structural cells,
protected cells); docs/PROTOCOL.md §5 (`set_value`, `set_formula`,
`clear_override`, `delete_cell`, `rename_cell`, `set_cell_visibility`), §7.2
(`CellView`; `absent_cell_visibility` as added by vtt-3l6.19), §6
(`base_revision`); DESIGN §4.6 Typing into a cell and The formula bar
(vtt-3l6.2); decisions Q7, Q8, Q14 of the M4 plan; review r1 findings 1, 7,
8, 9, 10; review r2 findings 5, 6; review r3 findings 3, 4, 6.

Exclusive files: `packages/ui/src/inspector/CellList.tsx`, `CellRow.tsx`,
`ViewersPicker.tsx`, tests `packages/ui/test/inspector/cells*.test.tsx`,
`viewers-picker.test.tsx`. Adds its own sorted `export * from "./<module>"`
lines to `packages/ui/src/index.ts` (CLAUDE.md package index rule).

- `<CellList object view session readOnly>`: user cells alphabetically, then
  a collapsible "Structural" group in FORMULAS §3.1 order (`id` shown from
  `view.id`). Each `CellRow`: name; value (`formatValue` full, tone styling);
  `ƒ` badge and the source for formula cells (GM); an "overridden" marker
  with the text "Overridden: no longer follows its formula" and a "Clear
  override" button (`clear_override`); a visibility glyph when
  `view.visibility` is present; for errors the message and an origin link
  (click selects the origin object and focuses the cell when it exists).
  Click focuses the cell (`UiStore.focusedCell`); hovering a row sets
  `UiStore.hoveredCell` and leaving clears it (this bead only sets it;
  tracing is vtt-3l6.24's, review r1 finding 10). Double-click on the value
  opens an inline **value editor** that writes a literal or, on a formula
  cell, an override: prefilled with `valueToInputText(view.value, cellName)`
  (vtt-3l6.3); typing a leading `=` writes a formula instead (formulas may be
  typed in any value editor, DESIGN §4.6 as amended); an `unsupported` value
  (error, roll, shape, ink…) of a cell whose `cellCapabilities` (vtt-3l6.3)
  allow `literal` opens a **replace value** editor: an empty input with the
  same grammar, the reason shown beside it, writing a literal or override
  (review r2 finding 5); otherwise it is read-only. Every editing affordance
  in a row (value editor, "Edit formula", "Replace formula with value") is
  offered only when `cellCapabilities` allows it (review r3 finding 4); `baseRevision` is captured when the
  editor opens (review r1 finding 1); Enter commits via `cellInputToOps`
  with that `baseRevision`, unless `isUnchangedInput(initial, text, cellName)` (parsed contents equal;
  nothing is written);
  Escape cancels. "Edit formula" (formula cells) focuses the formula bar
  (vtt-3l6.13) on the cell; "Replace formula with value" uses
  `replaceFormulaOps`: one `set_value` with `replace: true` (vtt-3l6.19),
  which also works on structural formula cells such as `visible_to`. Every other command captures `baseRevision` at the
  click.
- Structural cells (review r1 finding 9) follow this matrix, which is
  exactly what `cellCapabilities` encodes; structural rows always display the
  value and either edit generically or delegate:

  | Cell | Editing in the inspector |
  |---|---|
  | `id` | read-only |
  | `name`, `owner`, `face_up`, `opaque` (zones), `rotation`, `z` | generic value editor (`set_value`; `rotation`/`z` also by handles and keys) |
  | `visible_to` | generic value editor and the viewers picker |
  | `position` | generic value editor (`[x, y]`, `set_value`) and canvas drag/nudge |
  | `tag` | delegated: tag control in the object header (vtt-3l6.12) |
  | `contents` | delegated: contents list (vtt-3l6.12) |
  | `shape` | delegated: shape control in the object header (vtt-3l6.12) and handles (vtt-3l6.9); summary shown |
  | `board`, `container` | read-only; changed by moves (canvas drag, Alt-drop, "Move selection to board…", Take out) |
  | `template`, `is_zone` | read-only |

  `is_template` and `is_character` are fields, not cells: toggles in the
  header (vtt-3l6.12).
- Add cell (the name is validated with `@vtt/schema`'s `CellNameSchema`: any
  non-empty string except `__proto__`, so `Max HP` is allowed; an existing
  name is refused locally; formulas refer to such names in backticks,
  FORMULAS §3.2; review r3 finding 6) → `set_value {type:"empty"}`; rename → `rename_cell`;
  delete → `delete_cell` (both hidden for structural cells; store refusals
  surface as notices).
- Visibility rules (review r1 finding 9): a "Visibility rules" section lists
  every per-cell visibility entry of the object, including entries for cell
  names absent from the object (from the GM view's `absent_cell_visibility`,
  vtt-3l6.19), each with the picker and "Clear"; "Add visibility rule" takes
  any cell name valid under `CellNameSchema` (present or absent, user or
  structural) and a viewer
  set → `set_cell_visibility`.
- `<ViewersPicker value onChange characters>`: checkboxes "all", "gm",
  "owner", and each character (directory, not templates); "Default (object's
  visibility)" clears → `set_cell_visibility … null`. Used for per-cell
  visibility here and for the `visible_to` cell's literal value (writes
  `set_value visible_to {type:"viewers", …}`); a formula `visible_to` shows
  the formula and the picker writes an override (with the override marker).
- `readOnly` (character viewer): values only, no edits, no source, no
  visibility glyphs (views carry none).

Done when: jsdom tests against an in-process authority show: rows for a goblin
with literal, formula, overridden and error cells render the formatted value,
source, override text and error origin; typing `14` into a formula cell
overrides it and the marker appears, "Clear override" removes it; typing
`=max_hp - damage_taken` sets a formula; an unparseable formula shows the
message and sends nothing; add, rename and delete a cell; renaming onto an
existing name is refused locally; for the name `Max HP`: add the cell, give
it a visibility rule, rename it to `Max Hit Points` and back, and set another
cell to the formula ``=`Max HP` - damage_taken`` which evaluates; "Replace
formula with value" on a user formula cell and on a zone's `visible_to`
formula each leave a literal and no formula (one write each); rows for
`board`, `container` and `contents` offer no value editor; the overridden-formula round trip: the
value editor on an overridden cell is prefilled with the override's literal
and closing it unchanged writes nothing; a roll value in a user cell opens
the replace-value editor (empty, reason shown) and typing `3` writes `3`;
renaming nothing but adding a trailing space to `name` writes the new name; concurrent write (review r1 finding 1): the value editor opens
at revision r, a second client writes the same cell and the UI applies it,
committing then yields `stale_write`, a notice shows and the second client's
value stays; typing `=max_hp` into the value editor of a literal cell sets a
formula; structural rows: `tag`, `contents` and `shape` rows have no inline
editor, `position` accepts `[3, 4]`, `id`/`board`/`container` are
read-only; "Add visibility rule" for an absent cell `secret` with `gm`
creates the rule, which is listed and cleared again; hovering a row sets and
leaving clears `hoveredCell`; setting `ac` visibility to `gm` with the
picker writes the metadata and viewing as Aldric hides `ac` while `hp`
stays; setting `visible_to` to `gm` with the picker; on a zone whose
`visible_to` is the re-hiding formula the picker writes an override and the
marker shows; a dangling literal ref cell shows `#REF`; double-clicking it opens the
replace-value editor and typing `@goblin2` through the UI repairs it (the
cell holds `{type:"ref", object:"goblin2"}`); read-only mode renders no inputs; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
`pnpm test` exit 0.

Out of scope: object header, flags, tags, contents, actions (vtt-3l6.12);
tracing (vtt-3l6.24); the formula bar (vtt-3l6.13); shape editing (vtt-3l6.9); action
editing (M5).

Depends on: vtt-3l6.21, vtt-3l6.3, vtt-3l6.19.

---

### M4-k2 — vtt-3l6.12 — UI: inspector panel, object section and dependency tracing

Implements: DESIGN.md §4.1 (flags `is_template`, `is_character`; containment; tags), §4.5 / §4.6 ("each action with its steps and precondition" shown; editing is M5), §4.6 The inspector; §4.4 (presentation filtered by the viewer's effective visibility); docs/PROTOCOL.md §5 (`set_tag`, `set_shape`, `set_template_flag`, `set_character_flag`, `reorder`, `move`), §6 (`base_revision`); decisions Q12, Q13, Q14 of the M4 plan; review r1 findings 1, 3, 6; review r2 findings 9, 10, 13; review r3 finding 12.

The inspector panel's components. Dependency tracing is vtt-3l6.24. Exclusive files: `packages/ui/src/inspector/Inspector.tsx`, `ObjectHeader.tsx`, `ShapeControl.tsx`, `ContentsList.tsx`, `ActionsList.tsx`, `ObjectList.tsx`, tests `packages/ui/test/inspector/panel.test.tsx`, `contents.test.tsx`, `shape-control.test.tsx`, `object-list.test.tsx`. Adds its own sorted `export * from "./<module>"` lines to `packages/ui/src/index.ts` (CLAUDE.md package index rule).

- `<Inspector session ui>`: nothing selected → "Nothing selected"; several → "N objects selected"; one → `ObjectHeader`, `CellList` (vtt-3l6.11), `ContentsList`, `ActionsList`; read-only while viewing as a character. Instantaneous commands capture `baseRevision` at the click.
- `ObjectList` tab: the objects directly on the active board in the current view, labelled with `refLabel(viewer, id)`, zones marked, topmost first; click selects; hovering a zone row sets `UiStore.hoveredZone` and leaving clears it (review r2 finding 10), so a room zone under a map image can be selected and traced without the canvas.
- `ObjectHeader`: name and id (copy button); toggles `is_template` and `is_character` (`set_template_flag`, `set_character_flag`); `is_zone` read-only; tags as chips with add/remove (`set_tag`); the shape control.
- `ShapeControl` (the only inspector entry point for `shape`, review r3 finding 12): shows the kind and size; "Add shape" on a shapeless object offers rect (1 × 1), circle (r 0.5) and polygon (a triangle with vertices (0, −0.5), (0.5, 0.5), (−0.5, 0.5)); "Change kind" converts within the current bounding box (rect w × h → circle r = max(w, h) / 2; circle → rect 2r × 2r; polygon → rect of its bounds; rect → polygon of its four corners); "Remove shape" writes `null`; each is one `set_shape` write captured at the click; geometry is adjusted with vtt-3l6.9's handles.
- `ContentsList`: the `contents` refs in order, labelled with `refLabel(viewer, id)` (never the GM directory in view-as) and redacted entries as "hidden"; click selects; drag to reorder captures the revision and the ordered ids at drag start and submits `reorder` with the permutation of those ids against that revision (review r2 finding 9); "Take out" → `move` to the outermost container's board at its position + (1, 0) (disabled when the chain is not on a board).
- `ActionsList`: GM: name, `when`, steps (read-only, "editing arrives with M5"); character: names only.

Done when: jsdom tests with vtt-3l6.21's helper show: header toggles write the flags (a newly flagged character appears in the view-as list's source); tags add/remove; a shapeless token gets a circle, changes to a rect, and loses its shape, each one undoable group (undo restores the previous shape) and every other cell, tag and placement unchanged; a token containing a die lists it and "Take out" moves it beside the token on the board; reorder of three contents writes the permutation; a reorder whose drag began before another client reordered the list (and, separately, removed one of its members) is rejected `stale_write` with a notice and the other client's order is kept; actions show `when` and steps for the GM and names only as Aldric; a contained object whose `name` has per-cell visibility gm is listed by id while viewing as Aldric; the object list selects a zone lying under a map image, and hovering its row sets `hoveredZone`; selection count text; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: tracing requests and highlights (vtt-3l6.24); action editing and invoke (M5); face layout mode (M5); drag from the contents list onto the canvas (vtt-qf5.13).

Depends on: vtt-3l6.11, vtt-3l6.21, vtt-3l6.4.

---

### M4-k3 — vtt-3l6.24 — UI: dependency tracing

Implements: DESIGN.md §4.6 **Dependency tracing** ("Hovering a formula highlights the objects and zones it references on the canvas, filtered by what the viewer may see. Hovering a zone highlights its contents"), §4.4 (presentation filtered by the viewer); FORMULAS.md §9; docs/PROTOCOL.md §9 (`explain_cell`, `zones`); decision Q13 of the M4 plan; review r1 findings 3, 10; review r2 findings 10, 13; review r3 finding 10.

Exclusive files: `packages/ui/src/inspector/tracing.ts`, tests `packages/ui/test/inspector/tracing.test.ts`, `tracing-integration.test.tsx`. Adds its own sorted `export * from "./<module>"` lines to `packages/ui/src/index.ts` (CLAUDE.md package index rule).

- `startTracing({session, ui}): () => void` (the sole writer of `UiStore.highlight`): watches `UiStore.hoveredCell` (set by vtt-3l6.11 rows and vtt-3l6.13's formula bar) and `UiStore.hoveredZone` (set by the select tool's hover, vtt-3l6.7, and the object list, vtt-3l6.12).
  - Hovered formula cell → `explain_cell {object, cell, depth: 1, viewer}` through `session.client`; every dependency node with a non-null `object` other than the cell's own object (cells and `exists` nodes) is highlighted.
  - Hovered zone → `zones {board, viewer}`; that zone's `contents` are highlighted.
  - Precedence: a hovered zone wins over a hovered cell; when both clear, the highlight clears.
  - Requests and their cache are keyed `(viewerKey, board, revision, target)`; a response whose key no longer equals the current key (hover moved, viewer switched, board switched, revision advanced) is dropped; a viewer switch at an unchanged revision recomputes for the new viewer; the disposer clears the highlight and drops pending responses.

Done when: controller tests with a fake client show cache hits per key, dropped late responses after the hover moved, zone-over-cell precedence and fallback, and recomputation on a viewer switch at an unchanged revision; integration tests (jsdom, vtt-3l6.21's helper, rendering vtt-3l6.11's real `CellList`/`CellRow` for the hovered object and driving hover with user-event) show: hovering the goblin's `hit` row highlights the die on it; hovering, as Aldric, a cell whose formula reads a GM-only object highlights nothing from that object; leaving a row before its explanation returns leaves no highlight; hovering a zone while a cell is hovered switches to the zone's contents and back to the cell's dependencies when the zone hover ends; with a zone hovered, switching to Aldric at an unchanged revision refreshes with Aldric's `zones` result; with `hoveredZone` set to a room zone lying over an imported map (as the object list sets it), the tokens inside the room are highlighted; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: setting hover state (vtt-3l6.7, vtt-3l6.11, vtt-3l6.12, vtt-3l6.13); drawing highlights (vtt-3l6.5, vtt-3l6.6).

Depends on: vtt-3l6.21, vtt-3l6.4, vtt-3l6.11, vtt-5su.16.

---

### M4-l — vtt-3l6.13 — UI: formula bar and in-place editing

Implements: DESIGN.md §4.2 ("Every formula is visible and editable in the UI via a formula bar"; overrides), §4.4 (covers drawn above everything), §4.6 **Edit in place** ("Double-click a cell on the face to edit it there … Literals change directly. Formula cells open in the formula bar") and **The formula bar** (as amended by vtt-3l6.2: formulas may be typed in any value editor with a leading `=`; the formula bar is where the current formula source is shown and edited), §7 Platform ("In-place editing is a DOM overlay positioned over the cell"), §5.2 (writes carry their base revision); FORMULAS.md §3.2; DESIGN §4.6 Typing into a cell, Default rendering until faces, View as in the UI (vtt-3l6.2); decisions Q7, Q13 of the M4 plan; review r1 findings 1, 2, 4, 7, 8, 10; review r2 findings 5, 6, 8; review r3 findings 4, 5, 8.

Exclusive files: `packages/ui/src/formula-bar/FormulaBar.tsx`, `packages/ui/src/formula-bar/InPlaceEditor.tsx`, `packages/ui/src/formula-bar/editor-port.ts`, tests `packages/ui/test/formula-bar/formula-bar.test.tsx`, `packages/ui/test/formula-bar/in-place.test.tsx`. Adds its own sorted `export * from "./<module>"` lines to `packages/ui/src/index.ts` (CLAUDE.md package index rule).

- `<FormulaBar session ui>`: shows `object.cell` of `UiStore.focusedCell`. It edits the **formula source**: for a formula cell it shows `=` + source (`toInputText`, vtt-3l6.3), with an "override: <value>" chip and "Clear" (`clear_override`) when overridden; for a literal cell it shows the literal (`valueToInputText(value, cellName)`), and typing `=…` turns it into a formula. `baseRevision` is captured when the bar gains focus (review r1 finding 1). Enter commits via `cellInputToOps` with that `baseRevision`, unless `isUnchangedInput(initial, text, cellName)` (nothing is written); Escape reverts; an unparseable `=` input shows the parser message and disables commit; syntax is checked as you type (debounced). Editing is offered only as vtt-3l6.3's `cellCapabilities(cellName, view)` allows (review r3 finding 4): `formula` permits `=` input, `literal` permits values; a cell with neither (e.g. `board`, `container`, `contents`, `id`) shows its value read-only. An `unsupported` value (error, roll, shape, ink) of a cell allowing `literal` is shown with its reason and an empty input that replaces the value (literal, override or `=` formula); otherwise read-only (review r2 finding 5). Read-only (value only) while viewing as a character or when nothing is focused. Hovering or focusing the bar sets `UiStore.hoveredCell` to the focused cell and clears it on leave/blur (tracing is vtt-3l6.24's, review r1 finding 10).
- `editor-port.ts`: `createInPlaceEditorPort(store)` implements vtt-3l6.23's `EditorPort` (`open({stamp, object, cell?})`, `close()`), through which the runtime opens and closes the in-place editor.
- `<InPlaceEditor session ui camera scene>` (rendered in `BoardCanvas`'s overlay): on `open` for object O, the target cell is `cell` if given, else `text` when O has a `text` cell, else `name`. It writes **literals or overrides**: prefilled with `valueToInputText(view.value, cellName)`; typing `=…` writes a formula (allowed anywhere, DESIGN §4.6 as amended); a non-overridden formula target focuses the formula bar instead of opening; it opens only if `cellCapabilities` allows `literal` for the target cell; an `unsupported` value opens as an empty replace-value input with its reason. A DOM `textarea` (text) or `input` (name) over O's screen bounds follows camera changes; Enter commits with the stamp's `baseRevision` from `open` (Shift+Enter newline in `text`), Escape cancels, blur commits; an unchanged editor writes nothing; `name` input is always text. Covers (review r1 finding 4, review r3 finding 8): it opens only if its rectangle (the object's bounds in screen space) intersects no cover of the current scene, and closes without committing when a cover appears over that rectangle, when the viewer changes (including switching to a character) or when the active board is no longer `stamp.board`; in view-as it does not open.

Done when: jsdom tests with vtt-3l6.21's helper show: focusing a formula cell shows `=source`; committing `=max_hp - damage_taken` sets the formula; typing `9` over a formula cell overrides it and the chip appears; an overridden formula round trip: the in-place editor on it is prefilled with the override's literal, blur without change writes nothing, the formula is kept and still overridden; `=max_hp -` shows the parser message and sends nothing; Escape restores the original text; a roll value and a `#REF` value in user cells open the empty replace-value editor with their reasons, and typing `@goblin2` over the `#REF` repairs it; a number like `1e-7` is shown as decimal text or read-only, never with an exponent; concurrent write (review r1 finding 1): the editor opens at revision r, a second client writes the same cell, the UI applies that commit, committing then yields `stale_write`, a notice shows and the second client's value stays; the bar is read-only as Aldric; double-clicking a note edits its `text`, double-clicking a token edits its `name`, double-clicking an object whose `text` is a formula focuses the formula bar; the overlay editor is positioned at the object's screen bounds for a given camera and moves with it; the editor does not open for a large object whose anchor is uncovered but whose rectangle partly overlaps a cover, and closes without writing when a cover appears over it; switching to view-as Aldric with an open editor closes it without writing; focusing the `board`, `container` and `contents` rows in the formula bar offers no editing; hovering the bar sets and clears `hoveredCell`; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: face editor elements (M5); autocomplete of cell names (vtt-qf5.16); explain requests and highlights (vtt-3l6.12); multi-line formula editing beyond a textarea.

Depends on: vtt-3l6.22, vtt-3l6.23, vtt-3l6.21, vtt-3l6.3, vtt-3l6.5, vtt-3l6.6.

---

### M4-a1 — vtt-3l6.14 — Authority: HTTP route hook, static UI serving and Host check

Implements: DESIGN.md §7 Platform ("serves the UI over localhost"); docs/
PROTOCOL.md §1 (HTTP routes, `Host` check) and §2 (session bootstrap
element) as amended by vtt-3l6.2; decision Q3; review r2 findings 1, 2. The M3 beads leave this to M4
(vtt-5su.10 Out of scope).

Exclusive files: `packages/authority/src/server/http-ui.ts`, tests
`packages/authority/test/server/http-ui.test.ts`, `http-hook.test.ts`;
additive edit after vtt-5su.10 merged: `packages/authority/src/server/server.ts`
(the `http` option only); the sorted line `export * from "./server/http-ui"`
in `packages/authority/src/index.ts`.

- `startServer` gains `http?: HttpHandler[]` with `HttpHandler = (req, res) =>
  boolean | Promise<boolean>` (true = handled). For every non-upgrade request
  other than `GET /healthz`: if the `Host` header is not `127.0.0.1:<port>`
  or `localhost:<port>` the answer is 421 (DNS-rebinding guard); otherwise the
  handlers are tried in order, then 404. With no handlers, behaviour is
  exactly vtt-5su.10's except the `Host` check.
- `injectSession(html, {url, token}): string` removes any existing
  `vtt-session` element and inserts exactly one `<script id="vtt-session"
  type="application/json">` + JSON (with `<` escaped as `\u003c`) +
  `</script>` before `</head>`.
- `createUiHttpHandler({uiDir: string | null, url, token}): HttpHandler`:
  `GET /` and `/index.html` → `<uiDir>/index.html` through `injectSession`,
  `Cache-Control: no-store`; `GET /ui-assets/<path>` → files under
  `<uiDir>/ui-assets/` (the build's bundle directory, vtt-3l6.15; the
  resolved path must stay inside it; dotfiles refused), content type by
  extension (`.js`, `.css`, `.html`, `.svg`, `.png`, `.ico`, `.json`,
  `.woff2`, `.map`), `X-Content-Type-Options: nosniff`; anything else
  (including `/assets/…`, which is vtt-3l6.16's table-image namespace) not
  handled. With `uiDir` null or no `index.html`, `GET /` answers 200 with a
  short page saying to run `pnpm --filter @vtt/ui build`.

Done when: tests with a real server on port 0 and a temp `uiDir` show:
`GET /` contains exactly one session element, with the current token and url,
and `no-store`, also when the `index.html` on disk already contains a stale
`vtt-session` element; `GET /ui-assets/app.js` serves with a JavaScript
content type; `GET /app.js` and `GET /assets/app.js` are not handled (404); `/../secret`, an encoded
traversal and `/.env` are 404; a request with `Host: evil.example:<port>`
is 421 while `/healthz` with any Host still answers; `/ws` upgrades work as
before; two handlers are tried in order; missing `index.html` gives the
build hint page; `injectSession` escapes `</script>` inside a token; `pnpm
typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: `vtt-serve` flags and the Vite dev plugin (vtt-3l6.15); assets
(vtt-3l6.16); TLS and remote access (vtt-y1w.8); CSP headers (Polish).

Depends on: vtt-3l6.2, vtt-5su.10.

---

### M4-a2 — vtt-3l6.15 — Authority: serve flags for the UI and the Vite dev plugin

Implements: DESIGN.md §7 Platform; docs/PROTOCOL.md §1, §2 as amended by
vtt-3l6.2; decision Q3 of the M4 plan; review r1 finding 12; review r2 findings 1, 2.

Wires vtt-3l6.14's and vtt-3l6.16's handlers into the `vtt-serve` process and gives dev
the same bootstrap. Exclusive files: additive edits after their owners
merged: `packages/authority/src/bin/serve.ts` (vtt-5su.14),
`packages/ui/vite.config.ts`, root `package.json` script `"dev": "pnpm
--filter @vtt/ui dev"`; tests `packages/authority/test/server/serve-ui.test.ts`,
`packages/ui/test/dev/vite-config.test.ts`.

- `serve.ts`: passes `http: [createAssetHttpHandler({host, token}) /* vtt-3l6.16 */,
  createUiHttpHandler({uiDir, url, token}) /* vtt-3l6.14 */]` to `startServer`;
  `--ui-dir <dir>` (default: `packages/ui/dist` resolved from the module's
  location), `--no-ui` (the UI handler is omitted; assets are still
  served); logs `Open http://127.0.0.1:<port>/` to stderr once listening;
  `--print-session` gains an `"http"` key (additive). `--allow-origin`
  already exists (vtt-5su.14); the file header documents dev use:
  `vtt-serve <file> --allow-origin http://localhost:5173` next to `pnpm dev`.
- `vite.config.ts`: `build.assetsDir: "ui-assets"`, so built bundles live
  under `/ui-assets/` and never collide with the table-image namespace
  `/assets/` (review r2 finding 1); a `vttSession()` plugin with
  `apply: "serve"` (dev server only, never `vite build`; review r2 finding 2)
  whose `transformIndexHtml` injects the session element with vtt-3l6.14's `injectSession` from
  `VTT_URL`/`VTT_TOKEN`, else `readSessionFile()` (vtt-5su.14); nothing is
  injected when neither exists (the UI shows its "No authority running"
  screen); `server.proxy` forwards `/assets` (GET and POST) to the session's
  http origin with `changeOrigin: true`, so the authority sees its own
  `Host` and vtt-3l6.14's Host check passes (review r1 finding 12).

Done when: a build test runs Vite's `build()` with this config into a temp
directory with `VTT_URL`/`VTT_TOKEN` set and a session file present, and
`dist/index.html` contains no `vtt-session` element and no token (grep),
and every bundle lives under `ui-assets/`; an end-to-end serving test builds
the real UI, serves it with `vtt-serve --ui-dir <that dist>` (asset and UI
handlers both installed), fetches `/` (exactly one session element with the
current token) and every `src`/`href` that `index.html` references, all 200
with the right content types; a subprocess test runs `vtt-serve <tmp file> --port 0 --ui-dir
<tmp dir> --print-session` and shows the printed `http` key, `GET /`
serving the injected page, a `POST /assets` + `GET /assets/<path>` round
trip, and with `--no-ui` `GET /` is 404 while assets still work; a ui test
imports `vite.config.ts` and shows the plugin injects the session from a temp
`XDG_CONFIG_HOME` session file, prefers `VTT_URL`/`VTT_TOKEN`, and injects
nothing without either, and that the `/assets` proxy entry has
`changeOrigin: true`; a real proxy test starts a guarded authority
(vtt-3l6.14's Host check, vtt-3l6.16's asset handler on a temp table) and a
Vite dev server in middleware or listen mode on port 0 with this config, then
`POST /assets` through the Vite server (with the bearer token) returns a path
and `GET /assets/<path>` through it returns the same bytes, while a direct
request to the authority with `Host: localhost:<vite port>` is 421; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
`pnpm test` exit 0.

Out of scope: the handlers themselves (vtt-3l6.14, vtt-3l6.16); running Vite inside the
authority; a combined launcher script.

Depends on: vtt-3l6.14, vtt-3l6.16, vtt-3l6.4 (the `@vtt/authority` dev dependency of
`@vtt/ui`), vtt-5su.14.

---

### M4-b0 — vtt-3l6.25 — Authority: asset generation in save bookkeeping

Implements: DESIGN.md §7 Persistence ("references to assets (images) stored beside it"; saves atomic, two failure stages) and the autosave decision D24 as recorded by vtt-5su.2; review r2 finding 7; review r3 finding 13.

Save bookkeeping for table assets, split from vtt-3l6.16 so the persistence change is reviewed on its own. Exclusive files: additive edit after vtt-5su.4 merged: `packages/authority/src/host/table-host.ts`; tests `packages/authority/test/host/asset-generation.test.ts`.

- `TableHost.addAsset(path)`: adds a relative asset path to the host's asset list, deduplicated; a new path increments `assetsGeneration` (starting at 0 on open); `assets` returns the current list.
- Dirty state is the pair `(revision, assetsGeneration)`. Each save captures the pair and the asset list synchronously when it starts and passes that list to `saveTable`; on `saved` it records the captured pair as saved; `saved_not_durable` and `failed` do not mark it saved (retried as today, vtt-5su.4). A new asset schedules the regular autosave exactly like a commit (debounce, max delay); `save()` and coalescing compare pairs, so a save requested after an import at an already-saved revision runs, and an import during an in-flight save leaves the host dirty and gets a follow-up save; `close()` saves when the current pair differs from the saved pair.

Done when: tests with fake timers, a temp directory and the fs seam show: `addAsset` of a known path does not bump the generation; on an already-saved table, `addAsset` without any commit followed by `save()` writes a file listing it; an `addAsset` while a delayed save is in flight is followed by a second save that lists it, and the first save's file does not; `addAsset` alone triggers the autosave; `close()` right after an `addAsset` saves and the reopened file lists it; a save that ends `saved_not_durable` after an `addAsset` leaves the pair unsaved and is retried; the existing vtt-5su.4 tests still pass; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: writing image files, HTTP routes and the upload helper (vtt-3l6.16); garbage collection (vtt-qf5.12); compaction policy (vtt-qf5.6).

Depends on: vtt-5su.4, vtt-3l6.2.

---

### M4-b — vtt-3l6.16 — Authority and UI: image assets

Implements: DESIGN.md §7 Persistence and Revisions and assets ("references
to assets (images) stored beside it"; "Asset paths in the file are relative
to the file's directory"; "how an image cell names an asset is M4's
decision"), §5.2, §8.1 (objects with image), §8.4 step 3 (import the dungeon
map); docs/PROTOCOL.md §1 (`GET /assets/<path>`, `POST /assets`) as amended
by vtt-3l6.2; decision Q4; review r2 findings 1, 7; review r3 findings 9, 13.

Exclusive files: `packages/authority/src/host/assets.ts`,
`packages/authority/src/server/http-assets.ts`, tests
`packages/authority/test/host/assets.test.ts`,
`packages/authority/test/server/http-assets.test.ts`;
`packages/ui/src/assets/upload.ts`, test `packages/ui/test/assets/upload.test.ts`;
sorted lines in
`packages/authority/src/index.ts` and `packages/ui/src/index.ts`. Wiring into
`vtt-serve` and the dev proxy are vtt-3l6.15's; `TableHost.addAsset` and its
save bookkeeping are vtt-3l6.25's. It never edits `packages/ui/package.json`
or the lockfile (the `@vtt/authority` dev dependency comes from vtt-3l6.4).

- `importAsset(host, {bytes, filename, slug?}) → {path}`: refuses an in-memory
  host; accepts PNG, JPEG, WebP and GIF by magic bytes (SVG refused: it can
  carry script), at most 50 MiB (`MAX_ASSET_BYTES`); path `<table
  basename>.assets/<slug>-<first 8 hex of sha256>.<ext>` relative to the
  table's directory (`slug` = the given slug or the file stem, lowercased,
  non-`[a-z0-9_-]` → `-`, at most 40 chars); written with temp file + rename
  into that directory (created if missing); the same bytes and slug return the
  same path without rewriting; it then calls vtt-3l6.25's `host.addAsset(path)`,
so the next save lists it.
- `createAssetHttpHandler({host, token}): HttpHandler` (vtt-3l6.14's handler type;
  the `Host` check is vtt-3l6.14's): `POST /assets` with `Authorization: Bearer
  <token>` (constant-time comparison), body = bytes, `X-Filename` and
  optional `X-Slug` (URL-encoded) → 201 `{"path"}`; 401 bad token, 413 too
  large, 415 unsupported type, 409 in-memory table. It handles `/assets/` only
  (built UI bundles are under `/ui-assets/`, vtt-3l6.14). `GET /assets/<path>`: only
  a path listed in `host.assets` (normalized, no traversal) → the bytes with
  the content type by extension and `Cache-Control: no-store`; else 404.
- UI `upload.ts`: `uploadAsset(file, {token, base = location.origin}) →
  Promise<{path}>` and `assetUrl(path)` = `"/assets/"` + the path's segments
  URI-encoded.

Done when: tests in a temp directory show: importing a PNG writes the file
under `<name>.assets/` and returns the hashed path; a reimport returns the
same path without a second file; an import followed by `host.save()` writes
a file that lists the asset and `loadTable` reports no missing asset; SVG and text bytes are
415; oversize 413; a wrong token 401; an in-memory host 409; GET of the
listed path returns the bytes with `no-store`, of an unlisted or traversal
path 404; an asset listed by a file loaded from disk (not imported) is
served; with a real in-process server (`startServer({http: [handler]})`, Node
environment) `uploadAsset` returns the path and `assetUrl` encodes spaces;
`pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: garbage collection of unreferenced assets (Polish); image
tiling for very large maps (vtt-y1w.4); the MCP `import_asset` tool (vtt-3l6.20);
`vtt-serve` wiring and the dev proxy (vtt-3l6.15); the image creation tool
(vtt-3l6.8).

Depends on: vtt-3l6.14, vtt-3l6.2, vtt-3l6.25, vtt-3l6.4.

---

### M4-n — vtt-3l6.17 — UI: app shell and composition

Implements: DESIGN.md §7 Platform ("the scene is drawn on a canvas and the
chrome … is DOM"), §8.1 (undo of whole actions; save), §7 Undo; docs/
PROTOCOL.md §2 (connection errors `disconnected`, `recovering`,
`unauthorized`, `wrong_table`; explicit credentials make `unauthorized`
terminal), §6 (`uncertain`); DESIGN §4.4, §4.6 as amended by vtt-3l6.2
(covers above every object-related overlay); decisions Q9, Q14 of the M4
plan; review r1 findings 2, 4, 13; review r2 findings 3, 8, 13; review r3 findings 2, 11, 14.

Exclusive files: `packages/ui/src/App.tsx`, `src/main.tsx`,
`src/app/Toolbar.tsx`, `StatusBar.tsx`, `Notices.tsx`, `keybindings.ts`,
tests `packages/ui/test/app/*.test.tsx` (replaces the scaffold's
`test/app.test.tsx`). Adds its own sorted `export * from "./<module>"`
lines to `packages/ui/src/index.ts` (CLAUDE.md package index rule).

- `main.tsx`: `readBootstrap()`; without it a "No authority running" screen
  with the `vtt-serve` command; else `createTableSession` and `<App session
  createRenderer?>`.
- Layout: toolbar (tools registered in vtt-3l6.22's `ToolRegistry`: the
  select tool of vtt-3l6.7 wrapped by vtt-3l6.9's `withHandles`, and the
  vtt-3l6.8 tools; the fog toggle edits the zone tools' typed options through
  `UiStore.setTool`; view-as menu, undo, save), board tabs above the canvas,
  formula bar above the canvas, inspector on the right; `BoardCanvas` fed
  with `buildScene` (scene objects and `objectOverlays`) from the board view,
  `UiStore` and the `previews` returned by `useInteraction`, the hook's
  `overlays`, and the `ImageCache` with `assetUrl`; vtt-3l6.23's runtime
  created with `inputs: createRuntimeInputs(session, ui)` and `toolContext:
  createToolContext(session, ui, {pickFile: a hidden file input, upload:
  createImageBitmap measurement + vtt-3l6.16's uploadAsset})` (both
  vtt-3l6.21), `whenRevision` from vtt-3l6.4 and `editor:
  createInPlaceEditorPort(...)` (vtt-3l6.13); `BoardCanvas` resizes call
  `ui.setViewport`; vtt-3l6.21's camera store is connected on mount and
  vtt-3l6.10's `useFirstVisitFit` mounted; the in-place
  editor in the canvas overlay; `startTracing({session, ui})` (vtt-3l6.24)
  started on mount and disposed on unmount. The
  composition keeps the render order of vtt-3l6.6 (objects, object-related
  overlays, covers, chrome) and adds nothing drawn above covers except chrome.
- `StatusBar`: connection state (banner for `disconnected`/`recovering`,
  terminal message for `unauthorized` and `wrong_table`; the `unauthorized`
  banner explains that the authority restarted with a new token and offers
  "Reload", which reloads the page to fetch a new bootstrap token, review r1
  finding 13), revision, save
  status ("Saved", "Saving…", "Save failed: …"); `Notices`: presents vtt-3l6.21's `NoticeStore` list with a dismiss
  control per notice (stickiness and expiry are vtt-3l6.21's).
- `keybindings.ts`: Ctrl/Cmd+Z → `undo(session)`; Ctrl/Cmd+S →
  `save(session)` (default prevented) (vtt-3l6.21); tool keys V (select), T (token), C
  (card), N (note), R (zone rect), O (zone circle), P (zone polygon), I
  (image); none fire while focus is in a text field.

Done when: jsdom tests with an in-process authority and a recording renderer
show: without bootstrap the start screen renders; with it the app shows the
GM board tab, toolbar and an empty inspector; creating a token with the
toolbar tool and clicking it fills the inspector; Ctrl+Z undoes it and a
notice names the label; Ctrl+S produces a save event (file-backed host) and
the status shows "Saved"; camera persistence: pan board A, switch to B,
return to A and A's camera is restored; the first visit of a board fits its
items once its board view has arrived; dismissing a sticky error notice
removes it; same-token transport recovery: the helper drops
the app's socket on the same server, the disconnected banner shows and
clears automatically after resync; normal restart: the authority restarts
with a new token, the app reaches the terminal `unauthorized` state and the
banner's "Reload" calls `location.reload` (spied); a selected token under a
cover in a character view (GM selection kept while switching to view-as)
draws no outline after the cover (recording renderer call order); the
`wrong_table` and `unauthorized` messages render from a fake session
snapshot; a stale-write notice from another client's concurrent write
appears; a test runs Vite's `build()` API on the UI with `outDir` in a temp directory
and it succeeds (no browser automation, Q16); `pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
`pnpm test` exit 0.

Out of scope: the log panel (M5); faces (M5); keyboard shortcut help
(vtt-qf5.17); touch input (vtt-qf5.18).

Depends on: vtt-3l6.23, vtt-3l6.24, vtt-3l6.21, vtt-3l6.6, vtt-3l6.7, vtt-3l6.8, vtt-3l6.9, vtt-3l6.10, vtt-3l6.12, vtt-3l6.13, vtt-3l6.16, vtt-3l6.14.

---

### M4-z — vtt-3l6.18 — Epic acceptance: §8.4 prep steps 1–4 by hand, minus binders (P2)

Implements: DESIGN.md §8.4 steps 1–4 as interpreted below (decision Q19),
§8.1; the epic vtt-3l6 Done-when; FORMULAS.md §10 (re-hiding a room; the
goblin's HIT badge); review r1 findings 5, 14; review r2 finding 14.

**Interpretation of "steps 1–4 minus binders" (Q19).** Step 1 without the
stocked GM binder: a new table whose GM board is empty. Step 2 with the
character template made by hand on the GM board (a token with the HIT badge
formula and an owned sheet object), copied four times by template drag,
values typed into the inspector and in place (sheet faces are M5; "each
binder already holds an Attack card template" is skipped). Step 3 as written.
Step 4 as written, the "owned attack d20" being a contained object whose
`owner` is the goblin. The HIT badge is visible in the inspector, not on a
face (faces are M5).

Exclusive files: `packages/ui/test/acceptance/prep.test.tsx`,
`packages/ui/test/acceptance/prep-script.ts`. The test drives the real
`<App>` in jsdom (recording renderer, `BoardCanvas` pointer events in screen
coordinates, user-event typing into the inspector, formula bar and in-place
editor) against an in-process authority on a temp table file
(`TableHost.open(createIfMissing)` + `startServer({http: [vtt-3l6.16's asset
handler]})`). Its header quotes steps 1–4 and maps each sentence to the
blocks below.

1. New table: the GM board exists and is empty.
2. On the GM board: a token "PC" with tag `pc` (header tag control), the HIT
   badge formula `hit = any(on(this).where(tag has "d20").total >= ac)`
   typed in the formula bar, made a character template (`is_character`,
   `is_template` via the header), with a "Sheet" note Alt-dropped into it
   and the sheet's `owner` written explicitly as `@<pc template id>` in the
   inspector (containment does not set ownership); drag the template four
   times on the GM board (four copies, each with its own sheet copy whose
   `owner` is remapped to its copy, and `template` refs); fill `name`, `ac`,
   `hp`, `attack_bonus`, `dex_save` on each copy by typing into the
   inspector, and the name in place.
3. Add board "Crypt"; import a PNG map with the image tool; draw six fog rect
   zones over it (`opaque`, `visible_to` gm); type the re-hiding formula
   `=if(len(contents(this).where(tag has "pc")) > 0, all, gm)` into
   `visible_to` of rooms 2 and 4.
4. Goblin template on the GM board: image, `ac` with per-cell visibility gm,
   `max_hp`, `damage_taken`, `attack_bonus`, `hit`, tag `creature`, and an
   attack die Alt-dropped into it: a token named "d20" with tags `die` and
   `d20`, `owner` = the goblin via `@id`, `value` (a literal), `modifier =
   owner.attack_bonus` and `total = value + modifier`. Drag the goblin
   template eight times on the GM board, select the eight copies with a
   marquee, use "Move selection to board…" → Crypt (vtt-3l6.10; there is no
   cross-board drag in M4, review r1 finding 5), then on Crypt drag four
   into room 3 and four into room 5.
5. Checks driven through the UI, with fixed numbers: the PC copy used here
   has `ac` 13 and the goblin copy used has `attack_bonus` 5 (typed in step 2
   and 4). Move that PC copy to Crypt with "Move selection to board…" and
   place it on the map outside all six zones. View as that PC; in GM view
   drag the PC into room 2 and check, viewing as the PC, that room 2 shows no
   cover; return to GM view, drag the PC out of room 2 to an uncovered spot
   outside all six zones, and check as the PC that room 2 is covered again.
   Return to GM view; take the goblin copy's die out ("Take out") and drag it
   onto the PC token (both outside all zones); type `9` into the die's `value`
   (total 9 + 5 = 14 ≥ 13: the PC's `hit` is true), then `7` (12 < 13:
   false). Finally view as the PC for the six-cover assertion below. Rolling
   stays M5.

Assertions (through the protocol, as a second GM client): every object,
cell, formula, tag, visibility entry, `owner` and containment above (each
sheet copy's `owner` is its own PC copy; each die copy's `owner` is its own
goblin copy); created ids are readable (`token_<n>`, `zone_<n>`, … via
`id_base`); `zones crypt` lists four goblins in room 3 and four in room 5;
each goblin copy's die `modifier` evaluates to that goblin's
`attack_bonus` and its `total` to `value + modifier`; room 2's `visible_to`
evaluates to `all` while the PC is inside and to `gm` after it left; the
PC's `hit` is true with `value` 9 and false with `value` 7; the app viewing as one PC
character on Crypt (the PC and the die outside all zones) draws six covers and no goblin
(recording renderer); `save`, close, reopen the file: the same objects and
the asset are there.

**Manual browser checklist (for the user; does not gate this bead).** On
close, the orchestrator posts this list as a comment on the epic vtt-3l6 for
the user to run:

1. `pnpm --filter @vtt/ui build`, then `pnpm serve /tmp/crypt.table.json`;
   open the printed URL.
2. The GM board tab shows; pan (Space-drag, middle-drag) and zoom (wheel).
3. Create a token, rename it in place, type a formula in the formula bar,
   override it in the inspector and clear the override.
4. Tag it `pc`, make it a character template with an owned note (Alt-drop)
   whose `owner` you set to the template (`@id`); drag the template four
   times on the GM board; fill the copies' cells.
5. Add a "Crypt" board, import a map image, draw six fog zones, put the
   re-hiding formula on two of them.
6. Build the goblin template (GM-only `ac`, tag `creature`, an owned die
   tagged `die` and `d20` with `value`, `modifier = owner.attack_bonus`,
   `total = value + modifier`); drag eight copies on the GM board, select
   them, "Move selection to board…" Crypt, and drag four into room 3 and
   four into room 5.
7. View as a character: six covers, no goblins; back to GM. Move a PC to
   Crypt and into room 2: it reveals itself; move it out: covered again.
   Put a goblin's die on the PC and type its `value`: the PC's `hit`
   follows.
8. Undo once, save, stop the server, restart it, reload: everything is there.

Done when: `prep.test.tsx` passes within 60 s; `pnpm typecheck`, `pnpm
lint`, `pnpm format:check`, `pnpm test` exit 0. (The manual checklist is
posted on close and does not gate.)

Out of scope: binders, faces, buttons and actions (M5); step 5 (vtt-5su.13
and M6); browser automation (none in v1, Q16); feel-good tuning (M6).

Depends on: vtt-3l6.17, vtt-3l6.14, vtt-3l6.15, vtt-3l6.16, vtt-3l6.19.

---

### M4-p — vtt-3l6.19 — Authority and protocol: id_base for created objects and absent-cell visibility in GM views

Implements: DESIGN.md §5.3 ("Object ids … must be human-meaningful by
default"), §4.1 Identity (allocation from `next_seq`, reserved ids skipped),
§4.4 (per-cell visibility is metadata valid for absent cells), §4.2
(overrides; replacing a formula), §7 (operation records, undo); docs/PROTOCOL.md
§5 (`create_object`, `set_value`), §7.2 (GM object views) and §12 (additive extension) as
amended by vtt-3l6.2; review r1 finding 9 (absent-cell visibility rules must
be visible to the GM's inspector); review r3 finding 3 (replacing a formula,
including on structural cells, needs one invariant-preserving write).

Three additive authority/protocol extensions the M4 UI needs. Exclusive files: tests
`packages/authority/test/store/create-id-base.test.ts`,
`packages/protocol/test/create-object-id-base.test.ts`,
`packages/authority/test/protocol/create-id-base.test.ts`,
`packages/protocol/test/absent-cell-visibility.test.ts`,
`packages/authority/test/protocol/absent-cell-visibility.test.ts`,
`packages/authority/test/store/replace-formula.test.ts`,
`packages/authority/test/protocol/set-value-replace.test.ts`; additive
edits after their owners merged:
`packages/authority/src/store/structural.ts` (M2 `createObject` gains
`idBase?: string`: with no explicit id, allocate `<idBase>_<n>` exactly as
spawn allocates copies; `idBase` must be id syntax, else `invalid`; both
`id` and `idBase` is `invalid`), `packages/authority/src/store/edits.ts` (M2:
`replaceFormula(tx, obj, cell, value)`: on a cell whose stored content is a
formula, with or without override, records one cell effect from that
formula state to the literal `value` (the override is gone with the
formula); on a literal or absent cell it behaves exactly as `writeValue`;
the same guards and type checks as `writeValue`, so protected cells (`id`,
`contents`, `container`, `board`, `is_zone`) are refused and structural
cells such as `visible_to`, `position`, `rotation` are allowed),
`packages/protocol/src/ops.ts` (vtt-5su.3: `create_object.id_base?` and
`set_value.replace?: true`), `packages/authority/src/protocol/commands.ts`
(vtt-5su.5: passes `id_base` through, a bound `as` still binds the allocated
id; `set_value` with `replace: true` calls `replaceFormula`, without it
`writeValue` as before; declared keys unchanged), `packages/protocol/src/views.ts` (vtt-5su.3:
`ObjectView.absent_cell_visibility?: Record<string, WireViewers>`, optional)
and `packages/authority/src/protocol/views.ts` (vtt-5su.6: GM views carry the
object's `cell_visibility` entries whose cell name is not in the view's
`cells`, whenever there is at least one; character views never carry it).

Done when: `createObject` with `idBase: "zone"` yields `zone_<n>` and skips a
retired `zone_<n>`; the op round-trips through the protocol schema and a
`transact` (also with `as`, the binding resolving to `zone_<n>`); `id` +
`id_base` is `invalid`; an invalid base is `invalid`; an existing
`create_object` without `id_base` still allocates `obj_<n>`; a GM view of an
object with a visibility entry for an absent cell `secret` carries
`absent_cell_visibility.secret`, loses it after the entry is cleared and
after a cell `secret` is created (then it is the cell's `visibility`), and a
character view never carries the field; a subscription delta includes the
field change; the schema accepts views without the field (older servers);
`replaceFormula` on a user formula cell `hp` (overridden) and on a zone's
`visible_to` formula leaves a literal, no override, one cell effect each,
undo restores the formula (and the override), and a later edit of the same
cell makes that undo `undo_conflict`; on `contents` it is `protected_cell`;
`set_value {replace: true}` round-trips through the protocol schema and a
`transact` with the same results, and `set_value` without `replace` on a
formula cell still overrides;
`pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: renaming ids (never); UI use (vtt-3l6.8, vtt-3l6.11).

Depends on: vtt-3l6.2, vtt-5su.3, vtt-5su.5, vtt-5su.6.

---

### M4-q — vtt-3l6.20 — MCP: import an image asset from a local path

Implements: DESIGN.md §5.2 ("anything a human can do through the UI must be
expressible through this surface"), §7 Revisions and assets as amended by
vtt-3l6.2; docs/PROTOCOL.md §1 (`POST /assets`), §11 (MCP tools, `import_asset`)
as amended by vtt-3l6.2; decision Q4 as amended (plan-m4-decisions.md, 1).

Closes the agent-parity gap for images. Exclusive files:
`packages/authority/src/mcp/import-asset.ts`, test
`packages/authority/test/mcp/import-asset.test.ts`; additive edits after their
owners merged: registration through `createMcpServer`'s `extensions` hook
(vtt-5su.11) in `packages/authority/src/bin/mcp.ts` (vtt-5su.17); the sorted
line `export * from "./mcp/import-asset"` in `packages/authority/src/index.ts`.

- Tool `import_asset {path: string, slug?: string}` (strict input schema):
  the MCP process reads the local file at `path` (absolute, or relative to
  its working directory), checks it with the same type and size rules as
  vtt-3l6.16 (`MAX_ASSET_BYTES`, PNG/JPEG/WebP/GIF magic bytes) before sending,
  POSTs it to `/assets` at the authority's http origin (derived from the
  connection's ws url: same host and port, `http:`) with `Authorization:
  Bearer <token>` (the connection's current credentials, also after a
  discovery refresh) and `X-Filename`/`X-Slug`, and returns
  `{path}` as `structuredContent` plus a text block; the agent then writes
  the `image` cell with `transact`. Errors (`isError: true`): file missing or
  unreadable, unsupported type, too large, HTTP 401/409/413/415 mapped to a
  message, and the connection gate of PROTOCOL §11 (a connection error
  answers that error and sends nothing).
- The tool description says the returned path goes into an object's `image`
  cell (DESIGN §4.6 Appearance cells).

Done when: tests with a real in-process authority on a temp table file
(with vtt-3l6.16's handler) and the MCP server through an in-memory MCP client
transport show: importing a PNG returns a path listed in `host.assets`, a
following `transact` setting `image` to it commits, and `GET /assets/<path>`
returns the bytes; a missing file, an SVG and an oversize file are
`isError` and nothing is uploaded (server request count); a wrong token
(credentials replaced) maps 401 to an error; an in-memory authority maps 409;
while the client reports `disconnected` the tool returns that error; the
tool appears in `tools/list` with its schema; `pnpm typecheck`, `pnpm lint`,
`pnpm format:check`, `pnpm test` exit 0.

Out of scope: importing from URLs; the HTTP endpoint itself (vtt-3l6.16); the UI
image tool (vtt-3l6.8); MCP Streamable HTTP (vtt-y1w.10).

Depends on: vtt-3l6.16, vtt-5su.11, vtt-5su.17.

---

## 3. Dependency digraph (as recorded with `bd dep add`, after review r3)

```
vtt-5su.2 ─► M4-0
M4-0 ─► M4-d, M4-c, M4-c2, M4-e, M4-g0a, M4-a1, M4-b, M4-b0, M4-p
vtt-5su.3, vtt-5su.5, vtt-5su.6 ─► M4-p        vtt-5su.3 ─► M4-d, M4-e
M4-p ─► M4-d, M4-h, M4-k1, M4-z
M4-d ─► M4-c, M4-c2, M4-e, M4-k1, M4-l
vtt-5su.7, vtt-5su.19, vtt-5su.10, vtt-5su.4 ─► M4-c
M4-e ─► M4-f, M4-g0a, M4-c2, M4-g, M4-h, M4-i, M4-j, M4-l
M4-g0a ─► M4-f, M4-c2, M4-g0b, M4-g, M4-h, M4-i, M4-l
M4-c ─► M4-c2, M4-b, M4-j, M4-k2, M4-k3, M4-a2
M4-c2 ─► M4-g0b, M4-g, M4-h, M4-j, M4-k1, M4-k2, M4-k3, M4-l, M4-n
M4-f ─► M4-g0b, M4-g, M4-l, M4-n
M4-g0b ─► M4-g, M4-h, M4-i, M4-l, M4-n
M4-g ─► M4-i, M4-n
M4-k1 ─► M4-k2, M4-k3                vtt-5su.16 ─► M4-k3
vtt-5su.4 ─► M4-b0 ─► M4-b
vtt-5su.10 ─► M4-a1                  vtt-5su.14 ─► M4-a2
M4-a1 ─► M4-b, M4-a2, M4-h, M4-n, M4-z
M4-b ─► M4-a2, M4-h, M4-n, M4-z, M4-q    vtt-5su.11, vtt-5su.17 ─► M4-q
M4-h, M4-i, M4-j, M4-k2, M4-k3, M4-l ─► M4-n
M4-n, M4-a2 ─► M4-z
```

96 edges recorded on the M4 beads; `bd dep cycles` reports none;
a script compared every bead's "Depends on:" line with its recorded `blocks`
dependencies and found no mismatch.

- vtt-3l6.2 (M4-0) depends on vtt-5su.2
- vtt-3l6.3 (M4-d) depends on vtt-3l6.19 (M4-p)
- vtt-3l6.3 (M4-d) depends on vtt-3l6.2 (M4-0)
- vtt-3l6.3 (M4-d) depends on vtt-5su.3
- vtt-3l6.4 (M4-c) depends on vtt-3l6.2 (M4-0)
- vtt-3l6.4 (M4-c) depends on vtt-3l6.3 (M4-d)
- vtt-3l6.4 (M4-c) depends on vtt-5su.10
- vtt-3l6.4 (M4-c) depends on vtt-5su.19
- vtt-3l6.4 (M4-c) depends on vtt-5su.4
- vtt-3l6.4 (M4-c) depends on vtt-5su.7
- vtt-3l6.5 (M4-e) depends on vtt-3l6.2 (M4-0)
- vtt-3l6.5 (M4-e) depends on vtt-3l6.3 (M4-d)
- vtt-3l6.5 (M4-e) depends on vtt-5su.3
- vtt-3l6.6 (M4-f) depends on vtt-3l6.22 (M4-g0a)
- vtt-3l6.6 (M4-f) depends on vtt-3l6.5 (M4-e)
- vtt-3l6.7 (M4-g) depends on vtt-3l6.21 (M4-c2)
- vtt-3l6.7 (M4-g) depends on vtt-3l6.22 (M4-g0a)
- vtt-3l6.7 (M4-g) depends on vtt-3l6.23 (M4-g0b)
- vtt-3l6.7 (M4-g) depends on vtt-3l6.5 (M4-e)
- vtt-3l6.7 (M4-g) depends on vtt-3l6.6 (M4-f)
- vtt-3l6.8 (M4-h) depends on vtt-3l6.14 (M4-a1)
- vtt-3l6.8 (M4-h) depends on vtt-3l6.16 (M4-b)
- vtt-3l6.8 (M4-h) depends on vtt-3l6.19 (M4-p)
- vtt-3l6.8 (M4-h) depends on vtt-3l6.21 (M4-c2)
- vtt-3l6.8 (M4-h) depends on vtt-3l6.22 (M4-g0a)
- vtt-3l6.8 (M4-h) depends on vtt-3l6.23 (M4-g0b)
- vtt-3l6.8 (M4-h) depends on vtt-3l6.5 (M4-e)
- vtt-3l6.9 (M4-i) depends on vtt-3l6.22 (M4-g0a)
- vtt-3l6.9 (M4-i) depends on vtt-3l6.23 (M4-g0b)
- vtt-3l6.9 (M4-i) depends on vtt-3l6.5 (M4-e)
- vtt-3l6.9 (M4-i) depends on vtt-3l6.7 (M4-g)
- vtt-3l6.10 (M4-j) depends on vtt-3l6.21 (M4-c2)
- vtt-3l6.10 (M4-j) depends on vtt-3l6.4 (M4-c)
- vtt-3l6.10 (M4-j) depends on vtt-3l6.5 (M4-e)
- vtt-3l6.11 (M4-k1) depends on vtt-3l6.19 (M4-p)
- vtt-3l6.11 (M4-k1) depends on vtt-3l6.21 (M4-c2)
- vtt-3l6.11 (M4-k1) depends on vtt-3l6.3 (M4-d)
- vtt-3l6.12 (M4-k2) depends on vtt-3l6.11 (M4-k1)
- vtt-3l6.12 (M4-k2) depends on vtt-3l6.21 (M4-c2)
- vtt-3l6.12 (M4-k2) depends on vtt-3l6.4 (M4-c)
- vtt-3l6.13 (M4-l) depends on vtt-3l6.21 (M4-c2)
- vtt-3l6.13 (M4-l) depends on vtt-3l6.22 (M4-g0a)
- vtt-3l6.13 (M4-l) depends on vtt-3l6.23 (M4-g0b)
- vtt-3l6.13 (M4-l) depends on vtt-3l6.3 (M4-d)
- vtt-3l6.13 (M4-l) depends on vtt-3l6.5 (M4-e)
- vtt-3l6.13 (M4-l) depends on vtt-3l6.6 (M4-f)
- vtt-3l6.14 (M4-a1) depends on vtt-3l6.2 (M4-0)
- vtt-3l6.14 (M4-a1) depends on vtt-5su.10
- vtt-3l6.15 (M4-a2) depends on vtt-3l6.14 (M4-a1)
- vtt-3l6.15 (M4-a2) depends on vtt-3l6.16 (M4-b)
- vtt-3l6.15 (M4-a2) depends on vtt-3l6.4 (M4-c)
- vtt-3l6.15 (M4-a2) depends on vtt-5su.14
- vtt-3l6.16 (M4-b) depends on vtt-3l6.14 (M4-a1)
- vtt-3l6.16 (M4-b) depends on vtt-3l6.2 (M4-0)
- vtt-3l6.16 (M4-b) depends on vtt-3l6.25 (M4-b0)
- vtt-3l6.16 (M4-b) depends on vtt-3l6.4 (M4-c)
- vtt-3l6.17 (M4-n) depends on vtt-3l6.10 (M4-j)
- vtt-3l6.17 (M4-n) depends on vtt-3l6.12 (M4-k2)
- vtt-3l6.17 (M4-n) depends on vtt-3l6.13 (M4-l)
- vtt-3l6.17 (M4-n) depends on vtt-3l6.14 (M4-a1)
- vtt-3l6.17 (M4-n) depends on vtt-3l6.16 (M4-b)
- vtt-3l6.17 (M4-n) depends on vtt-3l6.21 (M4-c2)
- vtt-3l6.17 (M4-n) depends on vtt-3l6.23 (M4-g0b)
- vtt-3l6.17 (M4-n) depends on vtt-3l6.24 (M4-k3)
- vtt-3l6.17 (M4-n) depends on vtt-3l6.6 (M4-f)
- vtt-3l6.17 (M4-n) depends on vtt-3l6.7 (M4-g)
- vtt-3l6.17 (M4-n) depends on vtt-3l6.8 (M4-h)
- vtt-3l6.17 (M4-n) depends on vtt-3l6.9 (M4-i)
- vtt-3l6.18 (M4-z) depends on vtt-3l6.14 (M4-a1)
- vtt-3l6.18 (M4-z) depends on vtt-3l6.15 (M4-a2)
- vtt-3l6.18 (M4-z) depends on vtt-3l6.16 (M4-b)
- vtt-3l6.18 (M4-z) depends on vtt-3l6.17 (M4-n)
- vtt-3l6.18 (M4-z) depends on vtt-3l6.19 (M4-p)
- vtt-3l6.19 (M4-p) depends on vtt-3l6.2 (M4-0)
- vtt-3l6.19 (M4-p) depends on vtt-5su.3
- vtt-3l6.19 (M4-p) depends on vtt-5su.5
- vtt-3l6.19 (M4-p) depends on vtt-5su.6
- vtt-3l6.20 (M4-q) depends on vtt-3l6.16 (M4-b)
- vtt-3l6.20 (M4-q) depends on vtt-5su.11
- vtt-3l6.20 (M4-q) depends on vtt-5su.17
- vtt-3l6.21 (M4-c2) depends on vtt-3l6.2 (M4-0)
- vtt-3l6.21 (M4-c2) depends on vtt-3l6.22 (M4-g0a)
- vtt-3l6.21 (M4-c2) depends on vtt-3l6.3 (M4-d)
- vtt-3l6.21 (M4-c2) depends on vtt-3l6.4 (M4-c)
- vtt-3l6.21 (M4-c2) depends on vtt-3l6.5 (M4-e)
- vtt-3l6.22 (M4-g0a) depends on vtt-3l6.2 (M4-0)
- vtt-3l6.22 (M4-g0a) depends on vtt-3l6.5 (M4-e)
- vtt-3l6.23 (M4-g0b) depends on vtt-3l6.21 (M4-c2)
- vtt-3l6.23 (M4-g0b) depends on vtt-3l6.22 (M4-g0a)
- vtt-3l6.23 (M4-g0b) depends on vtt-3l6.6 (M4-f)
- vtt-3l6.24 (M4-k3) depends on vtt-3l6.11 (M4-k1)
- vtt-3l6.24 (M4-k3) depends on vtt-3l6.21 (M4-c2)
- vtt-3l6.24 (M4-k3) depends on vtt-3l6.4 (M4-c)
- vtt-3l6.24 (M4-k3) depends on vtt-5su.16
- vtt-3l6.25 (M4-b0) depends on vtt-3l6.2 (M4-0)
- vtt-3l6.25 (M4-b0) depends on vtt-5su.4

**Waves** (longest chain of M4 dependencies; M3 gates in brackets): (1)
M4-0 [vtt-5su.2]; (2) M4-a1 [vtt-5su.10], M4-p [vtt-5su.3, .5, .6], M4-b0
[vtt-5su.4]; (3) M4-d; (4) M4-c [vtt-5su.7, .19, .10], M4-e; (5) M4-b,
M4-g0a; (6) M4-f, M4-c2, M4-a2 [vtt-5su.14], M4-q [vtt-5su.11, .17]; (7)
M4-j, M4-k1, M4-g0b; (8) M4-g, M4-h, M4-k2, M4-k3, M4-l; (9) M4-i; (10)
M4-n; (11) M4-z.

**Critical path:** vtt-5su.2 → … → vtt-5su.10 (M3) → M4-c → M4-c2 → M4-g0b
→ M4-g → M4-i → M4-n → M4-z. M4-d now waits for M4-p (it emits
`set_value` with `replace`), which waits for vtt-5su.5 and vtt-5su.6; the
pure chain M4-d → M4-e → M4-g0a → M4-f still finishes before vtt-5su.10.

Shared files and serialization: `packages/ui/package.json` + lockfile:
M4-d → M4-c (M4-b never edits it); `packages/ui/vite.config.ts` and
`src/bin/serve.ts`: M4-a2 only; `src/server/server.ts`: M4-a1 only;
`src/host/table-host.ts`: M4-b0 only; `src/store/edits.ts`,
`src/store/structural.ts`, protocol `ops.ts`/`views.ts`, authority
`protocol/commands.ts`/`views.ts`: M4-p only; `packages/ui/src/index.ts`
export lines from M4-d, c, c2, e, f, g0a, g0b, g, h, i, j, k1, k2, k3, l, b,
n; `packages/authority/src/index.ts` lines from M4-a1, M4-b, M4-q.

---

## Review r1 changes

Codex plan review r1 (/Users/tfg/Projects/vtt/.reviews/vtt-3l6-20261105T083257Z.md,
16 findings, all accepted; dispositions in plan-m4-r1-dispositions.md),
applied 2026-11-05. Pre-r1 texts are in m4beads/orig/, applied texts in
m4beads/r1/.

- New beads: **M4-c2 vtt-3l6.21** "UI: writes, notices and UI state" (split
  from vtt-3l6.4, finding 15) and **M4-g0 vtt-3l6.22** "UI: interaction
  contract and tool framework" (findings 2, 15). vtt-3l6.4 keeps its id as
  "UI: session and mirror lifecycle"; vtt-3l6.7 keeps its id as "UI: select
  tool: select, move, pan, zoom, containment, template drag".
- Finding 1 (base revision): vtt-3l6.21's `write` requires `baseRevision`;
  vtt-3l6.22's write effect carries it and the runner never replaces it;
  vtt-3l6.7, .8, .9, .10, .11, .12, .13 capture it at interaction start or
  click; concurrent-write tests in .21, .7, .11, .13.
- Finding 2 (contract): vtt-3l6.22 owns events (incl. double-click, wheel,
  file drop, async `settled` results), typed tool state with options, tool
  overlays split into object-related and chrome kinds, the effect union with
  write continuations, notices, tool changes, file picking, uploads and
  editor open/close, the reducer, registry and runner; `EditorPort` defined
  there and implemented by vtt-3l6.13; `BoardCanvas` (vtt-3l6.6) gains the
  file-drop event.
- Finding 3 (viewer isolation): vtt-3l6.4 binds the selection view to the
  viewer, never falls back across viewers, `refLabel(viewer, id)`; vtt-3l6.12
  labels contents with it and keys tracing caches by viewer, board,
  revision, dropping stale responses.
- Finding 4 (covers): render order objects → object overlays → covers →
  chrome in vtt-3l6.6 (new call-order and clip tests), `objectOverlays` and
  `isCovered` in vtt-3l6.5, the in-place editor never over a cover
  (vtt-3l6.13), composition test in vtt-3l6.17, docs row in vtt-3l6.2.
- Finding 5 (cross-board): no cross-board drag; "Move selection to board…"
  owned and tested by vtt-3l6.10; vtt-3l6.18 and its checklist use it.
- Finding 6 (zones under images): `hitsAt` ordered list (vtt-3l6.5), Alt+click
  cycling (vtt-3l6.7), object list in the inspector (vtt-3l6.12), resize test
  of a zone under a map (vtt-3l6.9).
- Finding 7 (editable values): `valueToInputText`/`toInputText` with
  `literal | formula | unsupported`, decimal serialization,
  `isUnchangedInput` (vtt-3l6.3); formula-source vs literal/override editors
  (vtt-3l6.11, vtt-3l6.13).
- Finding 8 (formula entry): vtt-3l6.2 amends DESIGN §4.6 (formulas typed
  anywhere with `=`; the bar shows and edits the source); vtt-3l6.3 orders
  `name` before `=` and corrects the `0d6` rationale.
- Finding 9 (structural matrix): table in vtt-3l6.11; absent-cell visibility
  rules listed, added and cleared there. Listing rules on absent cells needs
  data the M3 view contract does not carry, so vtt-3l6.19 (M4-p) gains the
  GM-only additive field `ObjectView.absent_cell_visibility` (retitled
  "Authority and protocol: id_base for created objects and absent-cell
  visibility in GM views", new dependency on vtt-5su.6), vtt-3l6.11 depends
  on it, and vtt-3l6.2 documents PROTOCOL §7.2.
- Finding 10 (hover): `hoveredCell`/`hoveredZone` in vtt-3l6.21's `UiStore`;
  .11 and .13 set the cell, the runner sets the zone; vtt-3l6.12 owns
  requests, cancellation, precedence and cleanup.
- Finding 11 (board removal): vtt-3l6.4 detects removal from the board list
  and switches (tests: live, during disconnection, last board); vtt-3l6.10
  renders the zero-board state; failed subscriptions are connection notices.
- Finding 12 (proxy Host): `changeOrigin: true` and a real proxy test in
  vtt-3l6.15.
- Finding 13 (restart): same-token recovery vs new-token `unauthorized` with
  "Reload" (vtt-3l6.4 session tests, vtt-3l6.17 UI tests).
- Finding 14 (acceptance data): `pc` tag, explicit sheet `owner`, functional
  die (`die`/`d20` tags, `value`, `modifier`, `total`), reveal/re-hide and
  HIT-follows-value checks in vtt-3l6.18.
- Finding 16 (render caching): DESIGN §7 deferral sentence and row in
  vtt-3l6.2; vtt-3l6.6's Implements cites it.

Dependency changes: added vtt-3l6.6←vtt-3l6.22, vtt-3l6.7←vtt-3l6.21, vtt-3l6.7←vtt-3l6.22, vtt-3l6.8←vtt-3l6.21, vtt-3l6.8←vtt-3l6.22, vtt-3l6.9←vtt-3l6.22, vtt-3l6.10←vtt-3l6.21, vtt-3l6.11←vtt-3l6.19, vtt-3l6.11←vtt-3l6.21, vtt-3l6.12←vtt-3l6.21, vtt-3l6.13←vtt-3l6.21, vtt-3l6.13←vtt-3l6.22, vtt-3l6.17←vtt-3l6.21, vtt-3l6.17←vtt-3l6.22, vtt-3l6.19←vtt-5su.6, vtt-3l6.21←vtt-3l6.2, vtt-3l6.21←vtt-3l6.3, vtt-3l6.21←vtt-3l6.4, vtt-3l6.22←vtt-3l6.2, vtt-3l6.22←vtt-3l6.21, vtt-3l6.22←vtt-3l6.5;
also vtt-qf5.18 (touch input) re-pointed from vtt-3l6.7 to vtt-3l6.22.
Removed vtt-3l6.7←vtt-3l6.4, vtt-3l6.8←vtt-3l6.7, vtt-3l6.11←vtt-3l6.4, vtt-3l6.13←vtt-3l6.4.

Choices left to the planner: **who needs vtt-3l6.4 vs .21.** vtt-3l6.21
(writes, `UiStore`, hooks, test helper) is what every component and tool
needs, so .7, .8, .10, .11, .12, .13, .17 and .22 depend on .21 (and through
it on .4). Direct edges to vtt-3l6.4 remain where its read-side API is used
by name: .10 (`activeBoard`, `setView`, board list), .12 (`refLabel(viewer,
id)`, `client` for explain/zones), and .15, which needs only the
`@vtt/authority` dev dependency .4 adds. **Who needs M4-g0.** Everything that
produces or consumes interaction events, effects or overlays: .6 (event
union, overlay layering), .7, .8, .9 (tools), .13 (`EditorPort`), .17
(composition); .8 no longer depends on .7, since tools register through the
contract. **Test helper placement:** per the disposition the shared helper is
in .21; .4's own tests start a server inline.

---

## Review r2 changes

Codex plan review r2 (/Users/tfg/Projects/vtt/.reviews/vtt-3l6-20261105T084906Z.md,
14 findings, all accepted; dispositions in plan-m4-r2-dispositions.md),
applied 2026-11-05. Pre-r2 texts are in m4beads/orig/*.pre-r2.md, applied
texts in m4beads/r2/.

- New beads: **M4-g0b vtt-3l6.23** "UI: interaction runtime and React
  binding" and **M4-k3 vtt-3l6.24** "UI: dependency tracing". vtt-3l6.22
  keeps its id as g0a "UI: interaction contracts and navigation reducer".
- Finding 1 (namespaces): `build.assetsDir: "ui-assets"` (vtt-3l6.15);
  vtt-3l6.14 serves `/` and `/ui-assets/` only; vtt-3l6.16 owns `/assets/`
  only; vtt-3l6.15 builds the real UI and fetches every referenced bundle
  through both handlers; vtt-3l6.2 updates PROTOCOL §1.
- Finding 2 (injection): the Vite plugin is `apply: "serve"` and a build test
  greps `dist/index.html` (vtt-3l6.15); `injectSession` replaces any existing
  element so serving yields exactly one (vtt-3l6.14).
- Finding 3 (one contract): vtt-3l6.22 defines `WritePort`, `WriteOutcome`,
  `CameraPort`, `ToolContext`, `Previews` (= vtt-3l6.5's `ScenePreviews`),
  `InteractionStamp`; vtt-3l6.21 implements `WritePort` and `CameraPort`
  (camera state in `UiStore`) and now depends on vtt-3l6.22; reducers emit
  `camera` effects; `useInteraction` returns `{overlays, previews,
  handlers}` and vtt-3l6.17 passes `previews` into `buildScene`;
  vtt-3l6.23's contract-composition test wires the real pieces without casts.
- Finding 4 (continuations): ordered `continuations`, resolved by `op_index`
  matching; Shift decision recorded at the click (vtt-3l6.8); mixed
  transaction and both Shift paths tested (vtt-3l6.23, vtt-3l6.8).
- Finding 5 (replacement editor): `unsupported` carries `writable`
  (vtt-3l6.3); vtt-3l6.11 and vtt-3l6.13 open an empty replace-value editor;
  repairing a dangling ref by typing `@goblin2` through the UI is tested.
- Finding 6 (serialization): `toInputText(cell, cellName)`, verbatim `name`,
  viewer syntax for `visible_to`, recursive list grammar with `@id` at any
  depth, `isUnchangedInput(text, initial, cellName)` exact for `name`
  (vtt-3l6.3, used by .11 and .13).
- Finding 7 (asset dirty state): `assetsGeneration` and pair-based save
  bookkeeping in vtt-3l6.16, with the three tests.
- Finding 8 (lifecycle): `InteractionStamp` captured at interaction start;
  cancellation and late-result rules in vtt-3l6.23; tools write to
  `stamp.board` (vtt-3l6.7, .8, .9); the in-place editor closes when the
  board changes (vtt-3l6.13); board/tool switch during upload and pending
  write tested in vtt-3l6.23 and vtt-3l6.8.
- Finding 9 (reorder): drag-start revision and ids in vtt-3l6.12, with the
  stale test.
- Finding 10 (zone hover): object-list row hover sets `hoveredZone`
  (vtt-3l6.12); the Alt+click-cycled target stays the hover target
  (vtt-3l6.7); tracing a room over a map tested in vtt-3l6.24.
- Finding 11 (polygons): `polygonProblem` (= `@vtt/schema`'s `shapeProblem`,
  the authority's exact rule) and `normalizePolygon` in vtt-3l6.5; .8 and .9
  reuse it and now depend on vtt-3l6.5.
- Finding 12 (split g0): as above; vtt-3l6.6 depends on g0a only; .7, .8,
  .9, .13 on g0a and g0b; .17 on g0b.
- Finding 13 (split tracing): vtt-3l6.24 owns `tracing.ts`; vtt-3l6.12 keeps
  the components and drops vtt-5su.16; vtt-3l6.17 depends on both.
- Finding 14 (acceptance): vtt-3l6.18 returns to GM view before edits, keeps
  PC and die outside all zones, and fixes the numbers.

Dependency changes: added vtt-3l6.7←vtt-3l6.23, vtt-3l6.8←vtt-3l6.23, vtt-3l6.8←vtt-3l6.5, vtt-3l6.9←vtt-3l6.23, vtt-3l6.9←vtt-3l6.5, vtt-3l6.13←vtt-3l6.23, vtt-3l6.17←vtt-3l6.23, vtt-3l6.17←vtt-3l6.24, vtt-3l6.21←vtt-3l6.22, vtt-3l6.23←vtt-3l6.21, vtt-3l6.23←vtt-3l6.22, vtt-3l6.23←vtt-3l6.6, vtt-3l6.24←vtt-3l6.21, vtt-3l6.24←vtt-3l6.4, vtt-3l6.24←vtt-5su.16; removed vtt-3l6.12←vtt-5su.16, vtt-3l6.17←vtt-3l6.22, vtt-3l6.22←vtt-3l6.21.

Choices made: **g0b also depends on vtt-3l6.6**, because its
contract-composition test must include the real `BoardCanvas` and recording
renderer (the disposition asks for "the real session, store, hook and
renderer"). **vtt-3l6.21 now depends on vtt-3l6.22** (it implements
`WritePort` and `CameraPort` defined there), reversing r1's .22 ← .21 edge.
**`Previews` lives in vtt-3l6.5** as `ScenePreviews` and is re-exported by
g0a, since .5 cannot import from g0a (g0a depends on .5). **`whenRevision`**
reaches the runtime as a separate option from vtt-3l6.4 rather than as a
`ToolContext` member, so `ToolContext` stays exactly as the disposition lists
it. **Polygon validation** reuses `@vtt/schema`'s exported `shapeProblem`
instead of a new predicate, so the UI and the authority cannot disagree.
**Acceptance numbers:** the disposition gives "goblin AC 13, PC attack bonus
+5", but the HIT badge on the PC compares the die total with the PC's `ac`,
and the die's `modifier` follows its owner (the goblin); the script therefore
uses PC `ac` 13 and goblin `attack_bonus` 5, giving the same arithmetic (9 +
5 = 14 ≥ 13 true, 7 + 5 = 12 < 13 false) and keeping the goblin covered for
the final six-cover assertion.

---

## Review r3 changes

Codex plan review r3 (/Users/tfg/Projects/vtt/.reviews/vtt-3l6-20261105T090548Z.md,
14 findings, all accepted as text fixes; dispositions in
plan-m4-r3-dispositions.md), applied 2026-11-05; the final planning round.
Pre-r3 texts are in m4beads/orig/*.pre-r3.md, applied texts in m4beads/r3/.

- New bead: **M4-b0 vtt-3l6.25** "Authority: asset generation in save
  bookkeeping" (finding 13), owning `addAsset`, `assetsGeneration` and the
  pair-based save rules in `table-host.ts` (with `saved_not_durable` not
  marking the pair saved); vtt-3l6.16 keeps import, HTTP and the upload
  helper, depends on vtt-3l6.25 and vtt-3l6.4 (finding 9) and never edits the
  UI manifest.
- Finding 1 (upload lifecycle): one policy in vtt-3l6.8 and vtt-3l6.23: a
  started upload finishes on its stamped board (selection and tool unchanged
  if they changed); cancellation ends only unfinished gestures; the runtime
  routes results to the originating tool even when inactive.
- Finding 2 (runtime inputs): `RuntimeInputs` and `Viewport` in vtt-3l6.22;
  `createRuntimeInputs`/`createToolContext` in vtt-3l6.21 (which now depends
  on vtt-3l6.5 for `buildScene`); vtt-3l6.23 subscribes to `onChange` and
  cancels gestures on board or viewer change; vtt-3l6.17 wires them and feeds
  `setViewport`.
- Finding 3 (replace formula): vtt-3l6.19 adds `replaceFormula` and
  `set_value {replace: true}`; vtt-3l6.3's `replaceFormulaOps` emits one op
  (vtt-3l6.3 now depends on vtt-3l6.19); vtt-3l6.2 documents PROTOCOL §5 and a
  seventeenth row; vtt-3l6.11 tests a user formula and a `visible_to`
  formula.
- Finding 4 (capabilities): `cellCapabilities` in vtt-3l6.3; `toInputText` no
  longer carries `writable`; vtt-3l6.11 and vtt-3l6.13 consult it; the formula
  bar offers no editing for `board`, `container`, `contents`.
- Finding 5 (unchanged input): `isUnchangedInput(before, after, cellName)`
  compares parsed contents (vtt-3l6.3), with the whitespace tests.
- Finding 6 (cell names): `CellNameSchema` validation and backtick references
  in vtt-3l6.11, tested with `Max HP`.
- Finding 7 (template drag intent): fixed at drag start (vtt-3l6.7, rows in
  vtt-3l6.2), with mid-gesture modifier tests.
- Finding 8 (editor and covers): the editor's screen rectangle must intersect
  no cover; it closes on viewer change (vtt-3l6.13, vtt-3l6.2).
- Finding 10 (tracing dependency): vtt-3l6.24 depends on vtt-3l6.11 and
  renders the real `CellList`/`CellRow`.
- Finding 11 (camera): camera store in vtt-3l6.21; first-visit fit in
  vtt-3l6.10 (replacing its camera-memory module); app test in vtt-3l6.17.
- Finding 12 (shape control): `ShapeControl` in vtt-3l6.12 (add, change kind,
  remove via `set_shape`).
- Finding 14 (notices): stickiness and expiry only in vtt-3l6.21 (info and
  success expire after 6 s; warnings, errors, stale and uncertain are
  sticky); vtt-3l6.17 presents and dismisses.

Dependency changes: added vtt-3l6.3←vtt-3l6.19, vtt-3l6.16←vtt-3l6.25, vtt-3l6.16←vtt-3l6.4, vtt-3l6.21←vtt-3l6.5, vtt-3l6.24←vtt-3l6.11, vtt-3l6.25←vtt-3l6.2, vtt-3l6.25←vtt-5su.4; removed vtt-3l6.16←vtt-5su.4
(transitive through vtt-3l6.25).

Choices made: **the composition test's real tool** is defined in vtt-3l6.23's
test file (it hit-tests the real scene and reads an `ObjectView` through
`RuntimeInputs.views`) rather than the select tool, because vtt-3l6.7 depends
on vtt-3l6.23 and using it there would be a cycle; vtt-3l6.7's own
integration test covers the select tool on the real runtime. **Spawn intent
and containment:** "Alt at drop only for non-template drags" is read as:
Alt at the drop is ignored for a spawn drag (exactly one template, no Alt at
start), while a move drag (including a template moved with Alt) may still
drop into a container with Alt. **`replace` op location:** the disposition
names "schema ops"; the field lives in `@vtt/protocol`'s `WireOp` (the wire
op schema) and the authority's `commands.ts`; no `@vtt/schema` effect type
changes, since the replacement is one ordinary cell effect. **vtt-3l6.3 now
depends on vtt-3l6.19** (for the `replace` field), which moves it behind
vtt-5su.5/.6 but off the critical path.

---

## 4. Open questions (resolved)

All proposals were accepted on 2026-11-05 except as amended in
plan-m4-decisions.md: Q4 — the MCP import is the M4 bead M4-q (vtt-3l6.20)
and the second row reads "Asset upload is HTTP (`POST /assets`); the UI and
the MCP process both use it"; Q15 — M4-p filed, M4-h depends on it; Q16 — no
browser automation, M4-z's manual checklist is the user's and does not gate;
Q23 — M4-a split into M4-a1/M4-a2; Q3 row adds that `/assets/` GET serves
only listed paths with `no-store` and the same Host check; Q6 — the `back`
cell is a Later bead (vtt-y1w.15); Q13 — dependency tracing included; Q19 —
written into M4-z and posted on vtt-3l6; M4-0 owns every M4 doc edit
including CLAUDE.md. The text below is the draft as reviewed.

**Q1. Data path: protocol client, not an in-process Table.** *Proposal:* the
UI is a WebSocket client of `vtt-serve` through `@vtt/protocol`
(`ProtocolClient` + `enableRecovery` + `transactWithRetry`, vtt-5su.7,
vtt-5su.19), with hello `kind: "ui"` (actor gm). It never imports
`@vtt/authority` at runtime and never evaluates formulas. DESIGN §7:
"Formulas evaluate only in the authority, because they may read cells the
viewer cannot see; clients receive cell results, never inputs. The UI and the
agent are two clients of the same protocol". View-as is the protocol's
`viewer` parameter, so what the GM checks is exactly what a character's
client would get, covers included, and M4 exercises the multiplayer path.
Tests run a real authority in process (`startServer` on port 0) rather than a
fake. *Alternative:* bundle the authority's `Table` into the page for a
serverless mode (contradicts §7; double implementation of filtering).
No decision-log row (already decided by D1/D2 of vtt-5su.2).

**Q2. Which subscriptions.** *Proposal:* a GM directory (`all`,
`structural`) for the character list, ref labels, flags and contents; one
board view (`board`, current viewer, `cells: "all"`) for the active board;
an `objects` subscription only for selected objects outside the board view;
no `log` subscription in M4 (M5). Switching subscribes before unsubscribing.
In view-as, canvas and inspector read only the character's views; the GM
directory feeds only the view-as menu and GM-mode labels, so nothing GM-only
leaks into the character rendering. *Alternative:* `all` with `cells: "all"`
for everything (simplest; heavier commit deltas, and view-as would need a
second `all` subscription per character). No row.

**Q3. Serving the UI and the token.** *Proposal:* the authority serves the
built UI (`packages/ui/dist`, `vite build`) at `/` with the session injected
as `<script id="vtt-session" type="application/json">{url, token}</script>`
and `no-store`; every HTTP request must carry `Host: 127.0.0.1:<port>` or
`localhost:<port>` (421 otherwise) so a DNS-rebinding page cannot read the
token; dev uses Vite with a plugin injecting the same element from the
session file and `vtt-serve --allow-origin http://localhost:5173`.
*Alternatives:* (a) token in the URL fragment printed by `vtt-serve`
(Jupyter style; no injection, but the user must copy a URL and reloads
lose it unless stored); (b) the authority runs Vite in middleware mode (no
build step; heavy dev dependency in the authority). Row: "The authority
serves the built UI at `/` with the session token injected into the page,
and refuses HTTP requests whose `Host` is not its own loopback address;
image assets are served at `/assets/` and uploaded with `POST /assets`.
PROTOCOL §1." Rationale: one process and one URL for the GM; the `Host`
check closes DNS rebinding, which the WebSocket `Origin` check already
covers for `/ws`.

**Q4. Assets.** *Proposal:* an image cell is the user cell `image` holding
**text**: the asset's path relative to the table file's directory, exactly
as listed in the file's `assets`. Imported images live in `<table
basename>.assets/` named `<slug>-<hash8>.<ext>` (readable, collision-free,
deduplicated). Upload is `POST /assets` (bearer token) because a map image
exceeds `max_message_bytes` (1 MiB) and is not a document operation; GET
serves only listed paths. PNG/JPEG/WebP/GIF only (no SVG). No garbage
collection in v1. The agent can point `image` at any listed asset but cannot
import new bytes through MCP in M4: a §5.2 parity gap, filed as a Polish bead
"MCP: import an image asset from a local path" (the MCP process is local and
can read a path and POST it). *Alternatives:* (a) a new value type `{type:
"asset", path}` (schema, fixtures and formula changes for little gain); (b)
upload as a protocol method with chunking (vtt-y1w.12 territory); (c) file
the MCP import as an M4 bead now. Rows: "An image cell is the ordinary text
cell `image` holding an asset path relative to the table file, as listed in
the file's `assets`; imported images are stored in `<table>.assets/` as
`<slug>-<hash8>.<ext>` and never garbage-collected in v1. DESIGN §4.6, §7."
and "Asset upload is HTTP (`POST /assets`), outside the protocol; MCP asset
import is deferred (parity gap acknowledged). DESIGN §5.2, §7."

**Q5. Appearance cells and default drawing.** *Proposal:* ordinary user
cells, read by the renderer when readable for the viewer and of the right
kind: `image` (text, Q4), `color` (text, CSS color; fill), `pattern` (text;
`"hatch"` draws 45° lines; other values ignored), `text` (any value,
formatted compact, drawn inside the shape), and `name` as the label below.
Non-zones without `color` get a neutral fill; zones are transparent with a
thin outline unless `color`/`pattern`; the GM sees opaque zones with a 35 %
dark fill and dashed outline and a badge on objects whose `visible_to` is
not `all`; a character sees a revealed opaque zone only by its
`color`/`pattern` (no outline); covers are solid `#101014` above everything;
shapeless objects are a 10 px marker. This keeps vtt-5su.13's `pattern:
"hatch"` as written (no rename). *Alternatives:* (a) a single structured
`style` cell (a record is not storable; would need a list or text
mini-language); (b) structural appearance cells with defaults (changes
FORMULAS §3.1 and every view). Row: "Appearance is ordinary user cells read
by the renderer: `image`, `color`, `pattern` (`hatch`), `text`, with `name`
as the label; unreadable or ill-typed appearance cells are not drawn. DESIGN
§4.6."

**Q6. Face-down backs.** *Proposal:* v1 draws every face-down object with a
generic back (shape filled with a fixed back color and a diagonal pattern)
plus its `name` label, for every viewer; the GM additionally sees a small
"face down" glyph. `FACE_DOWN_EXEMPT` (vtt-75c.10) stays unchanged, which is
why a per-object back image cannot be shown to non-owners. *Alternative:*
add a `back` (or `back_image`) cell to `FACE_DOWN_EXEMPT` and draw it (M2
change, plus M3 view tests). Row: "Face-down objects show a generic back in
v1; per-object backs would need a cell in the face-down exemption set.
DESIGN §4.4, §4.6."

**Q7. Typing into a cell.** *Proposal:* one grammar for the formula bar,
inspector and in-place editor: a leading `=` makes a formula (refused
locally when it does not parse, with the parser message); otherwise the
input is parsed with the formula parser and accepted as a literal only when
literal-only (numbers, `"quoted text"`, `true`/`false`, `empty`, dice
expressions, lists of literals); `@id` is a reference; empty input is
`empty`; anything else is text verbatim. `name` is always text;
`visible_to` additionally accepts `all`, `gm`, `owner`, `@id` lists as a
viewers value. A literal typed into a formula cell overrides it (M2
`writeValue` semantics; DESIGN §4.2 "manually overridden"); replacing a
formula with a literal is an explicit inspector command (`delete_cell` +
`set_value`). *Alternatives:* (a) no `=` prefix, with a separate
formula/literal toggle (one more control; spreadsheets train `=`); (b)
typing a literal replaces the formula (spreadsheet behaviour, but loses the
override model of §4.2). Row: "Cell input: a leading `=` is a formula;
otherwise literal syntax (numbers, quoted text, booleans, `empty`, dice,
lists) or `@id` is that value and anything else is text; a literal typed
over a formula is an override; replacing a formula is an explicit command.
DESIGN §4.6."

**Q8. Value display.** *Proposal:* as specified in M4-d (compact on canvas,
full in the inspector): rolls show their total, the inspector adds dice and
dropped; refs show the target's name (directory in GM mode; in view-as only
names from the character's own views, else the id); errors show the code and,
in the inspector, message and origin; redacted values show "hidden"; ink and
shapes show placeholders. *Alternative:* raw JSON in the inspector. No row
(presentation detail).

**Q9. Undo, stale writes and uncertain writes.** *Proposal:* Ctrl/Cmd+Z
undoes `{type:"mine"}` (the GM's own latest group; the agent's work is undone
from M5's log panel or by the agent), with a notice naming the undone label
or the refusal; every UI write goes through `transactWithRetry` with
`base_revision` = the client's revision; a `stale_write` is shown with the
conflicting groups' labels and actors and is not retried or rebased
(the mirror already shows the winner); `uncertain` is a sticky notice.
*Alternative:* `latest` (would undo the agent's last edit when the GM
presses Ctrl+Z after an agent write — surprising). Row: "The UI's undo
targets the GM's own latest group (`mine`); stale writes and uncertain
outcomes are shown to the GM and never retried automatically. DESIGN §7
Undo."

**Q10. Optimistic updates.** *Proposal:* none. Drags and handle edits show a
local preview that stays until the commit event's revision reaches the
client (no snap-back flicker) and is cleared on rejection; everything else
waits for the commit event (localhost round trip). *Alternative:* optimistic
mirror patches with rollback (complexity; the mirror is the authority's
truth). No row.

**Q11. Template copying on the canvas.** *Proposal:* dragging an object
whose `is_template` is true spawns a copy at the drop point (the template
stays); Alt+drag moves the template itself. This is §4.7's "dragging a
template straight onto the table creates a copy there", available without
binders, and is how step 2 and step 4 "place eight" are done in M4. M5's
binder drag-out reuses it. *Alternatives:* (a) a "Spawn copy" context-menu
item only; (b) Ctrl+D duplicate (would set `template` to a non-template).
Row: "On the canvas, dragging a template spawns a copy where it is dropped;
Alt-drag moves the template. DESIGN §4.6, §4.7."

**Q12. Containment on the canvas.** *Proposal:* Alt-drop onto a non-zone
object appends the dragged objects to its `contents`; contained objects are
not drawn (no contents face element until M5) and are listed in the
inspector's Contents section with reorder and "Take out" (onto the
container's board beside it). *Alternatives:* (a) any drop onto an object
nests (too easy to do by accident; stacking a die on a token must stay a
board placement for `on()`); (b) a "Put into…" menu. Row: "On the canvas,
Alt-drop onto an object puts the dragged objects into its `contents`; a plain
drop places on the board (stacking). DESIGN §4.6."

**Q13. What "§4.6 (partial)" covers.** *Proposal:* M4: the inspector, the
formula bar, overrides, per-cell visibility, edit in place for `name` and
`text` (the default rendering has no other cells on the surface), a single
zoom level-of-detail rule (labels hidden below 24 px on screen), and
dependency tracing (hover a formula: referenced objects highlighted via
`explain_cell` with the current viewer; hover a zone: its contents via
`zones`). M5: face layouts, value/editor/button/contents elements,
show-when, collapsed faces, layout mode. *Alternative:* defer dependency
tracing to M5 (it is §4.6 but not in §8.1's list). Row: "Until face layouts
(M5) an object draws its shape, image, color, pattern, `text` and `name`
label; labels hide below 24 px on screen. DESIGN §4.6."

**Q14. View-as in the UI.** *Proposal:* the view-as menu changes only the
viewer of the board view and of explain/zones calls; the canvas still
accepts moves (the GM drives everything, §8.4 step 8), written as the GM;
the inspector and formula bar become read-only and show the character's view
(values only, hidden cells absent), which is what "HIT shows; AC does not"
checks. *Alternatives:* (a) view-as fully read-only; (b) inspector hidden in
view-as (DESIGN §4.6: inspector is GM territory). Row: "View-as switches the
viewer of what is drawn and inspected; the inspector is read-only there and
shows the character's view; edits on the canvas are still the GM's. DESIGN
§4.4, §4.6."

**Q15. Readable ids for UI-created objects.** *Proposal:* M4-p adds an
optional `id_base` to `createObject`/`create_object` (authority allocates
`<base>_<n>` from `next_seq` like spawn does, skipping reserved ids); the UI
passes the tool kind (`token`, `zone`, …). Additive (PROTOCOL §12).
*Alternatives:* (a) accept `obj_<n>` (contradicts §5.3 "human-meaningful by
default"); (b) the UI picks `<kind>_<n>` from the directory and retries on a
"reserved" rejection (racy with the agent, needs a retry loop; boards already
need this since `add_board` takes an explicit id — M4-j does that). Row (if
accepted): "`create_object` takes an optional `id_base`; the authority
allocates `<id_base>_<n>` as spawn does. PROTOCOL §5; DESIGN §4.1."

**Q16. Testing approach.** *Proposal:* (1) pure modules (values, camera,
scene, hit test, interaction machine, handles, polygon) in Vitest's node
environment, table-driven; (2) the Canvas2D renderer against
`RecordingContext`, our own implementation of the `Ctx2D` subset, asserting
call order and culling (no native `canvas`, no `vitest-canvas-mock`); (3)
React components in jsdom with Testing Library and user-event, with
`BoardCanvas` taking an injected renderer (jsdom has no 2D context) and
pointer events dispatched in screen coordinates; (4) integration against a
real in-process authority (`startServer` port 0, `allowOrigins` including
jsdom's origin, `TableHost.inMemory` or a temp file) through
`test/support/authority.ts`; (5) no browser automation in `pnpm test`:
M4-n and M4-z close with a manual browser check by the orchestrator, and
`vite build` is exercised in M4-n. *Alternatives:* (a) Playwright e2e
(`@playwright/test` 1.64.1) as a separate `pnpm e2e` script, outside the
four checks, for a real-browser smoke test of M4-z; (b) Vitest browser mode
(`@vitest/browser` 5.1.0 + `@vitest/browser-playwright` 5.1.0 + `playwright`
1.64.1) for pixel tests of the renderer. Both need a Chromium download in CI
and on every machine. Row: "UI tests: pure logic in node, the renderer
against a recording 2D context, components in jsdom with an injected
renderer, integration against a real in-process authority; no browser
automation in v1's test suite. CLAUDE.md Conventions."

**Q17. New dependencies (verified with `npm view` on 2026-11-05).**
*Proposal:* workspace `@vtt/schema`, `@vtt/formula`, `@vtt/protocol`
(runtime, M4-d); `@vtt/authority` (dev only, M4-c);
`@testing-library/user-event` 14.6.8 (dev, M4-c; peer `@testing-library/dom`
≥ 7.21.4, present at 10.4.2). No new runtime third-party dependency. Keep
`vite` at the pinned 8.3.5 (8.3.6 was published today; the rule of pinning
exact, settled versions). Only with Q16 (a)/(b): `@playwright/test` 1.64.1
or `@vitest/browser` 5.1.0 + `@vitest/browser-playwright` 5.1.0 +
`playwright` 1.64.1 (1.64.1 published 2026-10-14). Not proposed:
`vitest-canvas-mock` 1.2.0, `canvas` 3.2.3 (native), `happy-dom` 21.0.4
(jsdom already chosen by the scaffold). Row per D27's rule (each new pinned
dependency is recorded): "`@testing-library/user-event` 14.6.8 (dev) for UI
interaction tests."

**Q18. Renderer scale and caching.** *Proposal:* 64 px per board unit at
zoom 1, zoom range 1/32–8, viewport culling in M4, an image decode cache, and
no per-object bitmap cache until profiling asks (Polish bead; DESIGN §7
allows deferring performance work). *Alternative:* per-object offscreen
caching now (DESIGN §7 names it; adds invalidation logic before any profile).
No row (DESIGN §7 already says "Canvas2D with viewport culling and
per-object render caching"; if deferred, the Polish bead references it).

**Q19. Interpreting the epic Done-when.** *Proposal:* "steps 1–4 by hand
minus binders" means: step 1 without the stocked GM binder (a new table with
an empty GM board); step 2 with the character template made by hand on the
GM board (token with the HIT formula, an owned sheet object), copied four
times by template drag, values typed into the inspector and in place (sheet
faces are M5; "each binder already holds an Attack card" is skipped); step 3
as written; step 4 as written, with the "owned attack d20" a contained
object whose `owner` is the goblin. The HIT badge is visible in the
inspector, not on a face. *Alternative:* require only steps 3–4 in M4 and
move steps 1–2 to M5. Row: none (epic text); the interpretation goes into
M4-z and an epic comment.

**Q20. Where the UI decisions live.** *Proposal:* DESIGN §4.6 and §7 plus
PROTOCOL §1/§2, written by M4-0; implementation details (key bindings,
colors, sizes) stay in bead text. Appearance cells must be in DESIGN because
DESIGN is an MCP resource (`vtt://docs/design`) and the agent needs them to
"hatch" a zone. *Alternative:* a new `docs/UI.md` (not an MCP resource
without an M3 change to the resource list). No row.

**Q21. Image import scale and default sizes.** *Proposal:* an imported image
becomes a rect `width/100 × height/100` board units (100 px per unit, a
common battlemap density), resizable with handles; token r 0.5, card 2.5 ×
3.5, note 2 × 2. *Alternative:* ask for the scale on import (a prompt per
import). No row.

**Q22. Creation tools in M4.** *Proposal:* token, card, note (rect with
`color` and `text`), zone rect/circle/polygon (with the fog option), image.
Freehand ink and a free text tool are M5 ("freehand drawing and text").
*Alternative:* include a text tool in M4 (epic says objects with "text").
No row.

**Q23. Editing M3 files.** *Proposal:* M4 makes small additive edits to M3
files after their owners merge (`server.ts` option `http`, `serve.ts` flags
and route composition, `table-host.ts` `addAsset`, and with M4-p
`ops.ts`/`commands.ts`), as M3 did to M2 files, instead of amending the open
M3 beads now (vtt-5su.2 is in progress; amendments would reopen reviewed
text). Optionally split M4-a's `serve.ts` part into its own small bead so
M4-a/M4-b/M4-h do not wait for vtt-5su.14 (which waits for the MCP bead
vtt-5su.11). *Alternative:* amend vtt-5su.10 (an `http` hook) and
vtt-5su.4 (`addAsset`) now. No row.

---

## 5. Followups (filed)

- Polish (vtt-qf5): vtt-qf5.10 per-object render bitmap cache (Q18);
  vtt-qf5.11 CSP and security headers; vtt-qf5.12 asset garbage collection;
  vtt-qf5.13 drag from the contents list onto the canvas; vtt-qf5.14 snapping
  and grids; vtt-qf5.15 multi-object transforms and multi-select editing;
  vtt-qf5.16 formula-bar autocomplete (P3); vtt-qf5.17 shortcut help;
  vtt-qf5.18 touch and pen input; vtt-qf5.19 minimap (P4).
- Later (vtt-y1w, P4): vtt-y1w.13 board reordering; vtt-y1w.14 per-board
  units and grid metrics; vtt-y1w.15 per-object card backs (Q6, amendment 6).
  Tiling of very large images is the existing vtt-y1w.4.
- MCP image import: not a followup; it is M4-q (vtt-3l6.20).
- M5 inputs: comment "Inputs from the M4 plan" on vtt-1xv (faces through
  buildScene, buttons via the Tool/Effect interface, contents element,
  binder drag-out reusing template drag, action editing, log panel scope and
  `mine` undo, ink and text tool, input grammar and overlay reuse, tracing).
- M6 inputs: comment on vtt-nb8 (the M4-z manual checklist is the user's
  first real-browser run).
- Epic: comment on vtt-3l6 with the Q19 interpretation.

---

## Contradictions and underspecification found

1. Epic Done-when says steps 1–4 "minus binders", but step 1 is mostly the
   stocked GM binder, step 2 types "into the sheet faces" (faces are M5) and
   drags the template out of a binder (M5) → Q19.
2. The epic lists objects with "text"; §8.1 "freehand drawing and text" is in
   the M5 epic. Read as: M4 draws and edits a `text` cell, M5 adds the tool →
   Q22.
3. The epic omits "template copying" although §8.1 lists it with objects and
   step 4 ("place eight") needs it; M5 has only binder drag-out → Q11.
4. "§4.6 (partial)" is undefined → Q13 (dependency tracing in or out).
5. The task brief mentions a log panel to split; the log panel is M5's
   (vtt-1xv). M4 has none; undo feedback is a notice.
6. DESIGN §7 Platform says the authority "serves the UI over localhost", but
   PROTOCOL §1 (vtt-5su.2) says 404 for every path but `/healthz` and `/ws`;
   M4-0 must amend PROTOCOL §1 → Q3. Token injection into a page introduces
   a DNS-rebinding exposure that the M3 contract does not address (Origin is
   checked only on upgrades) → the `Host` check in Q3.
7. `FACE_DOWN_EXEMPT` lacks any appearance cell, so a face-down card's
   per-object back cannot be shown to non-owners → Q6.
8. Asset upload cannot fit the protocol (1 MiB client frames), and HTTP
   upload leaves the agent without an import path, against §5.2's parity
   rule → Q4.
9. DESIGN §5.3 asks for human-meaningful ids, but `createObject` allocates
   `obj_<n>` and `add_board` requires a client-chosen id → Q15, M4-j.
10. DESIGN §4.6 says the inspector is GM territory but §8.4 step 10 checks
    what a character sees ("HIT shows; AC does not"); what the inspector
    does in view-as is unspecified → Q14.
11. vtt-5su.14 depends on vtt-5su.11 only to serialize package.json edits,
    which puts the MCP request surface on M4's critical path → Q23.
