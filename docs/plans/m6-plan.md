# Plan: M6 First session (epic vtt-nb8)

Plan for the planning bead vtt-nb8.1. Filed on 2026-11-05 after the orchestrator's decisions (plan-m6-decisions.md: every Q1–Q16 proposal accepted, with eight notes). Plan labels map to filed ids: M6-0 vtt-nb8.2, M6-a vtt-nb8.3, M6-b vtt-nb8.4, M6-b2 vtt-nb8.16, M6-c vtt-nb8.5, M6-d vtt-nb8.6, M6-e vtt-nb8.7, M6-f vtt-nb8.8, M6-g0 vtt-nb8.17, M6-g1 vtt-nb8.18, M6-g vtt-nb8.9, M6-h vtt-nb8.10, M6-i vtt-nb8.11, M6-j vtt-nb8.12, M6-k vtt-nb8.13, M6-l vtt-nb8.14, M6-m vtt-nb8.15 (M6-b2 and M6-g0 split in review r1, M6-g1 in review r2). Section 2 holds the filed descriptions. Followups filed: vtt-qf5.33, vtt-qf5.34, vtt-qf5.35; vtt-qf5.28 rewritten; vtt-qf5.17 superseded by vtt-nb8.8. The draft is plan-m6.draft.md. Written against main at c5c366c (since then vtt-3l6.21 has merged). The orchestrator runs the Codex plan review next (two rounds at most).

**The epic as written.** "Run DESIGN.md §8.4 start to finish. Scripted
walkthrough plus a real playtest. Fix what is not pleasant. Done when the GM
says it felt good." Three parts, read literally:

1. **Scripted walkthrough**: all fifteen §8.4 steps automated end to end
   through the real app (jsdom, real authority, real MCP server for step 5),
   so the user's browser time is not spent on breakage a test can find
   (M6-g, M6-h, M6-i).
2. **A real playtest**: the user, in a real browser, following a written
   guide (docs/FIRST-SESSION.md, M6-j) and reporting per step. The
   orchestrator cannot run a browser (M4-D13), so the playtest is a
   human-gated bead (M6-k).
3. **Fix what is not pleasant**: cannot be specified before the playtest.
   Proposed (Q1): a planning-style triage bead (M6-l) turns the playtest
   report into fix beads under vtt-nb8, reviewed by Codex as a plan; a final
   playtest bead (M6-m) closes the epic when the GM says it felt good.

Before the playtest, M6 also fixes what reading §8.4 against the M4/M5 bead
texts already shows to be broken or missing (the "known gaps" below): a
step that cannot be done as written, or only through a workaround a first
user would not find. Those fixes are M6-0, M6-a, M6-c, M6-e, M6-f. Startup
and first-user ergonomics (one command to serve and open, agent hookup,
README, the guide) are M6-b and M6-j; example content (a map and a goblin
image) is M6-d.

**Known gaps found by walking §8.4 through the filed M4/M5 contracts**
(each traced to a question or bead):

| # | Step | Gap | Where |
|---|---|---|---|
| G1 | 15 | "the deleted-then-restored goblin": no earlier step deletes a goblin | Q4, M6-0 |
| G2 | 7 | "Only the entrance room is uncovered", but step 3 makes all six rooms `visible_to = gm` and nothing reveals room 1 before step 7 | Q4, M6-0 |
| G3 | 14 | Ctrl+Z is `undo mine` (M4-D7) = the connection's actor `gm`; a button pressed in view-as commits with actor = that character (M5-D11), so Ctrl+Z after Aldric's Apply skips it and undoes an older GM group | Q5, M6-a |
| G4 | 10 | "Pressing Apply again does nothing and says why", but the Attack card face hides Apply once applied (`show_when: "not applied"`), so there is nothing to press | Q6, M6-c |
| G5 | 11 | "drag a goblin's own attack die onto a PC": a goblin built from `tpl_token` has a face with no contents element, and the default contents list exists only for faceless objects (M5-D10), so its die is not drawn and cannot be dragged (only Inspector "Take out" reaches it) | Q6, M6-c |
| G6 | 4 | Putting the d20 into the goblin: a template drag is a copy fixed at drag start (M4-D8), and Alt-at-drop containment (M4-D9) applies only to non-template drags; a drop onto a contents element inserts a copy (M5-D10), but the goblin has none (G5) | Q6, M6-c |
| G7 | 12 | Fireball rows read `target.dex_save`; a goblin built from `tpl_token` with step 4's cell list has no `dex_save`, so `save_bonus` is `#NAME` (FORMULAS §2.1) and Apply all aborts | Q4, Q6, M6-0, M6-c |
| G8 | 2 | "Fill in name … by typing into the sheet faces": the sheet's `name` editor names the sheet, not the character (`name` is literal only, FORMULAS §3.1), so four sheets read "Sheet" and the tokens stay "Character" | Q6, M6-c |
| G9 | 4 | "Make a goblin template once: image, …": there is no UI to put an image into a token's `image` cell; the image tool makes a separate image object, and the only path is typing an asset path the user never sees | Q7, M6-e |
| G10 | 9, 12, 13 | The GM binder is on the GM board, the map on Crypt, and objects change boards only through "Move selection to board…" (DESIGN §4.6); d20s dragged out of the GM binder land on the GM board, not in a tray beside the map | Q3, Q8 |
| G11 | 10, 12 | A character's binder is drawn inside the token's contents element (`[-1.5, 0.9, 3, 1.2]`, `min_size` 24 px); expanding the binder and then a card inside a 1-unit token needs deep zoom; the walkthrough drags the binder out onto Crypt (a move never changes `owner`) | Q3 |
| G12 | all | No one-command start: today `pnpm --filter @vtt/ui build`, then `pnpm serve <file>`, then open the printed URL by hand; no documented way to attach an agent to `vtt-mcp` | Q9, Q10, M6-b |
| G13 | all | No first-user docs: README covers only the dev workflow; the M4 and M5 manual checklists are partial (steps 1–4 minus binders; 9–12) | Q14, M6-j |
| G14 | 3 | Step 3 needs a dungeon map image; none ships | Q11, M6-d |
| G15 | all | Gestures a first user cannot discover: Alt at drag start, Alt+click cycling, double-click default action, wheel over a list, the gear, layout mode | Q12, M6-f |

M6 builds no multiplayer, no cross-board drag (Q8 proposes deferring it to
triage), no grid or snapping (vtt-qf5.14 stays in Polish unless the
playtest asks), no browser automation (M4-D13 stands), and no game-system
content (DESIGN §8.3).

---

## 1. Module map and owners

New dependencies: `@modelcontextprotocol/client` 2.3.1 and
`@modelcontextprotocol/server` 2.3.1 as **dev** dependencies of `@vtt/ui`
(M6-g0), for the in-process MCP agent of step 5. Both are already pinned
exactly at 2.3.1 in `@vtt/authority` (M3-D27) and in the lockfile; checked
with `npm view` on 2026-11-05: 2.3.1 published 2026-10-05 (2.4.0 exists,
2026-10-23; staying on the workspace pin keeps one version). No runtime
dependency is added; the browser opener uses `node:child_process` only.

`@vtt/authority`:

| Module | Owner | Contents |
|---|---|---|
| `src/store/undo.ts` (selector `human`), `src/protocol/commands.ts` (passes `human`; post-merge after vtt-1xv.7, vtt-1xv.11); also `@vtt/protocol` `methods.ts` (undo target `human`, after vtt-1xv.11) and `@vtt/ui` `session/writes.ts` (Ctrl+Z sends `human`; vtt-3l6.21) | M6-a | undo target `human` |
| `src/server/open-browser.ts`, `src/server/launcher.ts` (build-input manifest `dist/.inputs.json`), `src/bin/start.ts` (new); `src/bin/serve.ts` flag `--open` (post-merge after vtt-3l6.15, vtt-1xv.22) | M6-b | startup |
| `src/mcp/instructions.ts` (new); `src/mcp/server.ts` (passes `instructions`; post-merge) | M6-b2 (r1) | MCP onboarding |
| `src/host/examples.ts` (post-merge after vtt-1xv.22) and its test | M6-c | template amendments |

Root: `package.json` script `start` and `.gitignore` line `/tables/` — M6-b;
script `mcp` — M6-b2 (after M6-b). `README.md` — M6-j.

`@vtt/fixtures`: `assets/crypt-map.png`, `assets/goblin.png`,
`src/example-assets.ts` (geometry constants and paths), its index line,
`src/node.d.ts` (adds `node:zlib` `inflateSync` and a `readFile` bytes
overload, test use only), `test/example-assets.test.ts`,
`test/support/raster.ts` (the deterministic rasterizer the test compares
against), `test/support/write-assets.ts` (writes the two PNGs) — M6-d.

`@vtt/ui`:

| Module | Owner | Contents |
|---|---|---|
| `src/assets/image-cell.ts` (new), post-merge edit of `src/inspector/CellRow.tsx` (after vtt-3l6.11, vtt-1xv.27) | M6-e | Upload… on `image` rows |
| `src/app/HelpPanel.tsx`, `src/app/help-content.ts` (new); post-merge edits of `src/app/keybindings.ts`, `src/app/Toolbar.tsx`, `src/App.tsx` (after vtt-1xv.23) | M6-f | help overlay |
| `test/walkthrough/contract.ts` (`DriverContext`, `Gestures`, `PrepResult`, `PlayAResult`), `steps.ts` (`WALKTHROUGH_STEPS`, fifteen fixed titles), `infra.ts` (`startWalkthrough`, agent, restart), `infra.test.tsx`; `package.json` dev deps + lockfile | M6-g0 (r1, narrowed r2) | driver infrastructure and contract |
| `test/walkthrough/gestures.ts` (`createGestures`, `bringIntoView`), `gestures.test.tsx` | M6-g1 (r2) | UI gesture helpers |
| `test/walkthrough/prep.ts` (`runPrep`, `PREP_DICE`), `test/walkthrough/prep.test.tsx` | M6-g | steps 1–6 |
| `test/walkthrough/play-a.ts` (`runPlayA`), `test/walkthrough/play-a.test.tsx` | M6-h | steps 7–11 |
| `test/walkthrough/play-b.test.tsx` | M6-i | steps 12–15 |
| `test/walkthrough/guide-sync.test.ts` | M6-j | guide ↔ steps |

Docs: M6-0 owns `docs/DESIGN.md` and `docs/PROTOCOL.md` (the only M6 bead
editing them). M6-j owns `README.md` and the new `docs/FIRST-SESSION.md`.
FORMULAS.md and FIXTURES.md are not edited.

**Shared contracts and their single owners:**

| Contract | Owner | Consumers |
|---|---|---|
| Amended §8.4 text (steps 2, 4, 5, 7, 10, 11, 14) and the amended template records | M6-0 | M6-c, M6-g–i, M6-j |
| Undo target `{type: "human"}` (store and wire); `mine` unchanged | M6-a | M6-i (step 14) |
| `openBrowser`; `--open`; `buildInputs`/`uiBuildIsStale`/`runStart`; root `start` script | M6-b | M6-b2, M6-j |
| Root `mcp` script; `MCP_INSTRUCTIONS` | M6-b2 | M6-j |
| `CRYPT_MAP`, `GOBLIN_IMAGE`, `exampleAssetPath(name)` | M6-d | M6-g, M6-j |
| `WALKTHROUGH_STEPS`, `startWalkthrough`, `DriverContext`, the `Gestures` interface, `PrepResult`, `PlayAResult` | M6-g0 | M6-g1, M6-g, M6-h, M6-i, M6-j |
| `createGestures` (implements `Gestures`) | M6-g1 | M6-g, M6-h, M6-i |
| `runPrep`, `PREP_DICE`, the §8.4 readings table | M6-g | M6-h, M6-i, M6-j |
| `runPlayA` | M6-h | M6-i |
| `HELP_GESTURES`, `KEY_BINDINGS` export | M6-f | M6-j (README key table mirrors it) |

Every package `src/index.ts` keeps one sorted `export * from` line per
module; each bead adds its own lines (CLAUDE.md).

---

## 2. Beads (as filed, revised after review r2)

Type task, parent vtt-nb8. Each section below is the bead's description as filed in bd (plan labels replaced by ids), with the heading giving label, id, title and priority. Changes from the draft, per plan-m6-decisions.md: M6-a adds the wire target `human` and switches the UI's Ctrl+Z to it (`mine` unchanged); M6-b's `pnpm start` is a launcher that rebuilds only a missing or stale UI build, with `--no-build`; M6-0 carries the further §8.4 edits (steps 2, 5, 10, 11) and the CLAUDE.md sentence; step 5's agent writes Aldric's sheet `spell_dc` (M6-g, M6-i); human beads are titled "Human:" and say what the user posts; the triage bead is "Plan: M6 triage". Review r1 split M6-b2 (vtt-nb8.16) out of M6-b and M6-g0 (vtt-nb8.17) out of M6-g; see "Review r1 changes" after section 3. Review r2 split M6-g1 (vtt-nb8.18) out of M6-g0; see "Review r2 changes".

### M6-0 — vtt-nb8.2 — Docs: M6 decisions (P1)

Implements: DESIGN.md §4.6, §4.7, §5.2, §7, §8.4, §10; docs/PROTOCOL.md §2, §4, §6, §11, §12; CLAUDE.md Conventions; the decisions of planning bead vtt-nb8.1 (docs/plans/m6-plan.md §4, Q1–Q16, all accepted, with the orchestrator's notes 2, 3, 5, 7; review r1 findings 2, 6, 9). Everything this bead writes is in this text; the plan is cited only for background.

Docs only; the only M6 bead that edits `docs/DESIGN.md`, `docs/PROTOCOL.md` and `CLAUDE.md` (exclusive files; the orchestrator applies the CLAUDE.md sentence if the implementing agent declines). DESIGN §4.6, §4.7, §7 and §10 already hold M4's and M5's text (vtt-3l6.2, vtt-1xv.5, merged); edit after them. README.md and docs/FIRST-SESSION.md are vtt-nb8.12's.

**1. DESIGN §8.4 narrative** (Q4, note 2). Replace these sentences; keep everything else:
- Step 2: "Fill in name, AC, HP, attack bonus, Dex save by typing into the sheet faces." becomes "Name each character on its token, then fill in AC, HP, attack bonus and Dex save by typing into the sheet faces; each sheet's header shows its character's name."
- Step 4: after "`attack_bonus`," insert "`dex_save`," (the list reads "image, `ac` (GM-only cell), `max_hp`, `damage_taken`, `attack_bonus`, `dex_save`, the HIT badge formula, …").
- Step 5: after the quoted request insert: "The agent gives Aldric's binder a copy of the Area Save card named Fireball with `caster` Aldric and `damage_dice` 8d6, and writes 14 into Aldric's sheet `spell_dc`, which the card's `dc` follows." The sentences "Check its work in the inspector. Correct the DC by typing over it." stay (typing over `dc` overrides it).
- Step 7 becomes: "Show the Crypt board in "view as" Aldric: every room is covered. Reveal room 1, the entrance, by hand; now only it is uncovered. Toggle back to GM view as needed."
- Step 10: "Pressing Apply again does nothing and says why." becomes "Apply stays visible but disabled, and says why."
- Step 11: "drag a goblin's own attack die onto a PC token" becomes "drag a goblin's own attack die out of the goblin's contents list onto a PC token".
- Step 14 becomes: "Discard the spent Attack card with its Discard button, attack the wrong goblin with a fresh one, and undo once after applying the damage. Delete a goblin by mistake and undo that too. Scroll the log back to confirm what happened."

**2. DESIGN §4.7 example template records** (Q6), amendments to the records vtt-1xv.5 wrote, in the same notation:
- `tpl_token`: cells gain `attack_bonus: empty`, `dex_save: empty` and `hit: false` (after `damage_taken`); face gains `value hit [-0.7, -0.6, 0.5, 0.3] m=12 sw="hit"` (the HIT badge; a copy's GM replaces `hit` with a formula) and `contents [-0.8, 0.9, 1.6, 0.8] m=24` (entries collapsed).
- `tpl_sheet`: the first face element `editor name [-2.8, -3.8, 5.6, 0.6] L` gains `sw="owner = empty"`, and a new element `value owner [-2.8, -3.8, 5.6, 0.6] L sw="owner != empty"` follows it (an owned sheet's header shows its owner's name; the character is named on its token).
- `tpl_attack`: the Apply button becomes `button Apply [-1.2, 1.1, 1.15, 0.45] sw="dmg != empty"` (it stays drawn after Apply, disabled by its guard, which shows the reason) and a new `button Discard [0.05, 1.1, 1.15, 0.45]` (always shown) follows it.
- `tpl_damage`: the same two changes: `button Apply [-1.2, 1.1, 1.15, 0.45] sw="dmg != empty"`, then `button Discard [0.05, 1.1, 1.15, 0.45]`. (`tpl_area_save` already has a Discard button.)
- `tpl_area_save`: the Apply all button's `sw="not applied"` becomes `sw="damage != empty"`.
- `tpl_character_sheet`, `tpl_character_binder`, `tpl_character_attack` inherit the amended `tpl_sheet` and `tpl_attack` records as before.
The fixture Attack card face (FIXTURES §9, `attack-card.json`) is unchanged: it is a fixture, not the example template.

**3. DESIGN §4.6 Appearance cells** (Q7): after the table: "The inspector's row for a cell named `image` offers Upload…: it imports a PNG, JPEG, WebP or GIF through `POST /assets` and writes the returned path into the cell (one `set_value`, the revision captured at the click)."

**4. DESIGN §7.**
- Undo: "chosen by one of three targets" becomes "chosen by one of four targets"; the table gains the row "`human` | The latest such group whose actor is the GM or any character." Paragraph "Undo and writes in the UI": "The UI's undo targets the GM's own latest group (`mine`: the `actor` target with the connection's own actor, docs/PROTOCOL.md §6), so the GM's undo never reverses the agent's newer work." becomes "The UI's undo targets `human`: the latest group by the GM or by a character the GM drove (a button pressed in view-as, §4.5), docs/PROTOCOL.md §6, so the GM's undo never reverses the agent's newer work."
- Platform (Q9, note 5): "`pnpm start <file>` builds the UI when `packages/ui/dist` is missing or older than its sources (`--no-build` skips that) and runs `vtt-serve <file> --open`, which opens the served page in a browser once listening (`$BROWSER` if set, else the platform opener); a failure to open is logged and never stops the server. `pnpm mcp` runs `vtt-mcp`."
- §5.2 (Q10): "At `initialize` the MCP server sends instructions: a short orientation naming the resources, the first queries, the GM binder's templates, how to give a template to a character, and the stale-write rule."

- §4.8 (the log panel text vtt-1xv.5 wrote): "Ctrl+Z stays `mine`" becomes "Ctrl+Z stays `human` (§7)".

**5. PROTOCOL.**
- §2 (serve flags): add `--open`: open `http://127.0.0.1:<port>/` in a browser once listening; `$BROWSER` names an executable called with the URL as its only argument, else `open` on macOS, `xdg-open` elsewhere; a failure logs one line and the server keeps running; refused as a usage error with `--no-ui`.
- §4 methods table, undo row: the target union gains `{type:"human"}`. §6 Undo, after the `mine` sentence: "`target: {type:"human"}` selects the latest candidate whose actor is `gm` or any character (characters are driven only from non-agent connections, §3); the UI's Ctrl+Z uses it. `expect_index` works with it as with `mine`." §12: note that `human` is an additive variant (older authorities refuse it as `bad_request`).
- §11: "The server's `initialize` result carries `instructions` (`MCP_INSTRUCTIONS` in `packages/authority/src/mcp/instructions.ts`)." The MCP `undo` tool's targets are unchanged (`latest`, `mine`, `group`).

**6. CLAUDE.md** (note 7), Conventions, one bullet: "README.md (quick start, agent hookup, keys) and docs/FIRST-SESSION.md (the playtest guide, kept in step with the walkthrough tests) are maintained docs: a change that alters what they describe updates them in the same commit."

**7. Decision log.** DESIGN §10 gains these rows verbatim, dated with the commit day:

| Decision | Rationale |
|---|---|
| M6-D1. §8.4 is amended: step 2 names characters on their tokens (sheet headers show the owner); step 4's goblin has `dex_save`; step 5's agent writes Aldric's sheet `spell_dc` 14, which the card's `dc` follows; step 7 reveals room 1 by hand before checking the view; step 10's Apply stays visible, disabled, with the reason; step 11's die comes out of the goblin's contents list; step 14 discards the spent card first and also deletes a goblin and undoes it. DESIGN §8.4. | Step 7 contradicted step 3 (every room starts `gm`); step 15 checked a deleted-then-restored goblin no step made; Fireball save rows read `target.dex_save`; a sheet cannot name its character; a hidden button cannot be pressed again. |
| M6-D2. Undo gains the target `human`: the latest group by `gm` or any character (characters are driven only from non-agent connections). The UI's Ctrl+Z uses it, so it reverses a button the GM pressed in view-as and never the agent's work; `mine` is unchanged. Amends M4-D7 (the UI's undo target). Additive on the wire. PROTOCOL §4, §6, §12; DESIGN §7. | A view-as press commits as the character (M5-D11); `mine` would skip it. |
| M6-D3. Example templates: tokens carry `attack_bonus`, `dex_save`, a HIT badge (`hit`, shown when true) and a contents list; an owned sheet's header shows its owner; Apply buttons stay drawn once their roll exists, disabled with the reason after use; Attack and Damage cards show a Discard button. DESIGN §4.7. | §8.4 steps 2, 4, 10, 11 and 12 could not be done as written with the M5 records. |
| M6-D4. The inspector's `image` row offers Upload…, writing the imported asset's path. DESIGN §4.6. | §8.4 step 4 puts an image on a token; the image tool makes a separate object. |
| M6-D5. `pnpm start <file>` builds the UI only when its build is missing or older than its sources (`--no-build` skips) and runs `vtt-serve --open`; `--open` uses `$BROWSER` or the platform opener and never fails the server; `pnpm mcp` runs `vtt-mcp`; local tables live in the gitignored `tables/`. DESIGN §7; PROTOCOL §2. | One command from clone to table without a needless rebuild; stdio MCP launched through `pnpm --silent`. |
| M6-D6. The MCP server sends `instructions` at `initialize`. DESIGN §5.2; PROTOCOL §11. | A bring-your-own agent should find the templates and the write rules without being told by the GM. |
| M6-D7. Example images (`crypt-map.png`, `goblin.png`) ship in `@vtt/fixtures/assets`, generated in-repo. | §8.4 step 3 needs a map; generated art has no licence question. |

Done when: the text above is in the docs and CLAUDE.md; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: README and docs/FIRST-SESSION.md (vtt-nb8.12); FORMULAS.md, FIXTURES.md; any code.

Depends on: vtt-1xv.5.

---

### M6-a — vtt-nb8.3 — Authority, protocol and UI: undo target `human` for Ctrl+Z (P1)

Implements: docs/PROTOCOL.md §4, §6, §12 and DESIGN.md §7 Undo as amended by vtt-nb8.2 (M6-D2); §8.4 step 14; M6 plan decision Q5 and orchestrator note 3 (docs/plans/m6-plan.md §4).

Exclusive files: tests `packages/authority/test/protocol/undo-human.test.ts`, `packages/ui/test/session/undo-human.test.ts`; post-merge edits of `packages/authority/src/store/undo.ts` (M2), `packages/authority/src/protocol/commands.ts` (after vtt-1xv.7 and vtt-1xv.11, which edit it), `packages/protocol/src/methods.ts` (after vtt-1xv.11), `packages/ui/src/session/writes.ts` (vtt-3l6.21), and, only where an existing assertion pins the UI's undo to `mine` against a second GM connection, `packages/ui/test/session/*.test.ts` of vtt-3l6.21 (that case is rewritten with the second client as an `agent`, the case the rule protects).

- Store: `UndoSelector` gains `{type: "human"}`: the most recent candidate whose actor is `gm` or `character` (any id), found in the same backwards scan as `actor`.
- Protocol: the `undo` params' target union gains `z.strictObject({type: z.literal("human")})` (additive, PROTOCOL §12; strict parsing makes an older authority answer `bad_request`).
- Authority: `executeUndo` passes `human` to the store unchanged, for every connection kind; `expect_index` uses it like any target. `mine`, `latest`, `actor` and `group` are unchanged.
- UI: vtt-3l6.21's `undo(session)` sends `{type: "human"}` instead of `{type: "mine"}`; notices unchanged.
- The MCP `undo` tool's input schema is unchanged.

Done when: authority tests over the protocol (in-process authority; a `ui` client and an `agent` client; a setup with a character object `aldric` and an object with an action) show: the ui client invokes with `actor: {type:"character", id:"aldric"}`, then `undo {type:"human"}` reverses that group while `undo {type:"mine"}` from the same client would not select it (asserted with `expect_index`: `mine` names an older `gm` group or is `undo_target_changed` with `actual: null`); with a newer agent group present, `human` still selects the latest `gm`/character group and leaves the agent's; a `gm` transact newer than a character invoke is selected first; `expect_index` with `human` is refused `undo_target_changed` when a newer `gm` group exists; the protocol schema round-trips `{type:"human"}`; existing M3 undo tests pass unchanged; a UI test with an in-process authority shows Ctrl+Z's `undo(session)` sends `human` and reverses a character-actor invoke made by the same session, but not a newer agent group; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: the MCP `undo` tool; the log panel's per-group undo; multiplayer rights (vtt-y1w.9).

Depends on: vtt-nb8.2, vtt-1xv.7, vtt-1xv.11, vtt-3l6.21.

---

### M6-b — vtt-nb8.4 — Startup: pnpm start, launcher, vtt-serve --open (P1)

Implements: DESIGN.md §7 Platform and New tables as amended by vtt-nb8.2 (M6-D5); docs/PROTOCOL.md §2 as amended (`--open`; a missing file is created); M6 plan decision Q9 with orchestrator note 5; review r1 findings 1, 4, 11; review r2 finding 6 (docs/plans/m6-plan.md §4).

Exclusive files: `packages/authority/src/server/open-browser.ts`, `packages/authority/src/server/launcher.ts`, `packages/authority/src/bin/start.ts`, their sorted index lines (not for the bin); tests `packages/authority/test/server/open-browser.test.ts`, `packages/authority/test/server/launcher.test.ts`, `packages/authority/test/server/start-bin.test.ts`, `packages/authority/test/server/serve-open.test.ts`, `packages/authority/test/root-scripts.test.ts`; post-merge edits of `packages/authority/src/bin/serve.ts` (after vtt-3l6.15 and vtt-1xv.22, which both edit it), root `package.json` (the `start` script; after vtt-3l6.15's `dev`), `.gitignore`. MCP onboarding (`pnpm mcp`, instructions) is vtt-nb8.16's, which edits root `package.json` after this bead.

- `openBrowser(url, {env, platform, spawn?}): Promise<{ok: true} | {ok: false; message: string}>`: `env.BROWSER` if non-empty (an executable called with the URL as its only argument, no shell), else `open` on `darwin`, else `xdg-open`; spawned detached with `stdio: "ignore"` and unref'd; `ok: false` on a spawn error (e.g. `ENOENT`) or a non-zero exit within 2 s; never throws. `win32`: `ok: false` with "unsupported platform".
- `serve.ts`: boolean `--open` (default false; `--no-open` from `allowNegative`). After the existing "Open http://…" log line it calls `openBrowser` on `http://127.0.0.1:<port>/`; on `ok: false` it logs `vtt-serve: could not open a browser (<message>); open <url>` and keeps serving. `--open` with `--no-ui` is a usage error (exit 1). The usage string and file header list `--open`.
- `launcher.ts` (the `pnpm start` logic, testable; paths relative to a `repoRoot` argument):
  - `buildInputs(repoRoot): Promise<Record<string, string>>`: every file under `packages/ui/src`, `packages/schema/src`, `packages/formula/src`, `packages/protocol/src` (recursive), plus `packages/ui/index.html`, `packages/ui/vite.config.ts`, `pnpm-lock.yaml`, `tsconfig.base.json`, the root `package.json` and `packages/{ui,schema,formula,protocol}/package.json`, keyed by repo-relative POSIX path, valued by the hex sha256 of its bytes.
  - The manifest `packages/ui/dist/.inputs.json` is `{inputs: Record<string, string>, outputs: string[]}`: the build inputs, and every file under `packages/ui/dist` after the build (dist-relative POSIX paths, excluding the manifest itself). `writeBuildManifest(repoRoot, inputs)` writes it; it is called only after a successful build, with the inputs computed before the build started.
  - `uiBuildIsStale(repoRoot): Promise<boolean>`: true when the manifest is missing or unreadable, when its `inputs` are not deep-equal to `buildInputs(repoRoot)` (an edit, an added file and a deleted file each make it stale), or when `dist/index.html` or any recorded output is missing.
  - `parseStartArgs(argv)`: removes every `--no-build`; the first remaining argument is the table file and must be present and not start with `-` (else the usage error `usage: pnpm start <file> [--no-build] [vtt-serve flags…]`); the file need not exist (vtt-serve creates it); the rest is forwarded. When the forwarded flags contain `--ui-dir`, the build step is skipped (a custom UI directory is served as given).
  - `runStart({argv, repoRoot, cwd, build, serve, log}): Promise<number>`: usage error → log and 1; creates the table file's parent directory (resolved against `cwd`) with `mkdir -p`; unless skipped, when `uiBuildIsStale` it awaits `build()` (non-zero → log "UI build failed" and return 1) and then `writeBuildManifest`; then `serve([file, ...rest, "--open"])` and resolves with the child's exit code. Lifecycle: while the child runs, the launcher ignores SIGINT and SIGTERM itself and forwards SIGTERM to the child (Ctrl+C reaches both through the terminal's process group; the child saves and exits); it never exits before the child.
- `bin/start.ts`: wires `runStart` with `repoRoot` resolved from the module's location, `cwd = process.cwd()`, `build` = spawn `pnpm --filter @vtt/ui build` in `repoRoot` (stdio inherited), `serve` = spawn `process.execPath --import tsx <bin/serve.ts> …args` (stdio inherited); exits with the code.
- Root `package.json` script, verbatim: `"start": "node --import tsx packages/authority/src/bin/start.ts"` (pnpm runs it in the repo root, so `pnpm start tables/crypt.table.json` means `<repo>/tables/crypt.table.json`). `.gitignore` gains `/tables/`.

Done when:
- `open-browser.test.ts` (node): the command chosen for `BROWSER` set, `darwin` and `linux` with an injected `spawn`; `ok: false` for ENOENT, a non-zero exit and `win32`; it never throws.
- `launcher.test.ts`, on a temp tree with the same `packages/*` layout: stale when `.inputs.json` is missing; fresh right after `writeBuildManifest`; stale after editing a file under `packages/schema/src` (a dependency package), after adding a file under `packages/ui/src`, after deleting a file under `packages/formula/src`, and after changing `pnpm-lock.yaml`; stale when a recorded bundle under `dist/` is deleted with the manifest unchanged, and when `dist/index.html` is deleted; `parseStartArgs` rejects no arguments and a first argument starting with `-`, accepts a missing file, strips `--no-build` anywhere; `runStart` with fakes calls `build` only when stale and never with `--no-build` or `--ui-dir`, writes the manifest only after a successful build, returns 1 without serving when `build` fails, creates the missing parent directory, appends `--open`, and resolves with the fake child's exit code.
- `start-bin.test.ts`: from a temp `cwd` with neither `tables/` nor the file present, runs `node --import tsx <abs>/packages/authority/src/bin/start.ts tables/crypt.table.json --port 0 --ui-dir <tmp dir with an index.html> --print-session` (the quick-start command; `--ui-dir` keeps the test from building the real UI) with `BROWSER=<tmp executable node script appending its argv[2] to a file>`: that file receives `http://127.0.0.1:<port>/`, `GET /` answers 200, the protocol shows a new table with the stocked GM binder; SIGTERM to the launcher → it exits 0 after the server's final save and `tables/crypt.table.json` exists under the temp `cwd`.
- `serve-open.test.ts`: the real `vtt-serve --open` with `BROWSER=/nonexistent` logs the "could not open a browser" line while `GET /` answers 200; `--open --no-ui` exits 1 with the usage message.
- `root-scripts.test.ts`: the root `start` script verbatim and `.gitignore` contains `/tables/`.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: Windows; a default table file; `pnpm mcp` and MCP instructions (vtt-nb8.16); README text (vtt-nb8.12); building the UI inside `vtt-serve`.

Depends on: vtt-nb8.2, vtt-3l6.15, vtt-1xv.22.

---

### M6-b2 — vtt-nb8.16 — MCP onboarding: pnpm mcp and MCP instructions (P1)

Implements: DESIGN.md §5.2 as amended by vtt-nb8.2 (M6-D6) and the `pnpm mcp` part of M6-D5; docs/PROTOCOL.md §11 as amended; M6 plan decision Q10; review r1 findings 8, 11; review r2 finding 4 (docs/plans/m6-plan.md §4).

Exclusive files: `packages/authority/src/mcp/instructions.ts` and its sorted index line; tests `packages/authority/test/mcp/instructions.test.ts`, `packages/authority/test/mcp/pnpm-mcp.test.ts`; post-merge edits of `packages/authority/src/mcp/server.ts` (vtt-5su.11) and root `package.json` (the `mcp` script; after vtt-nb8.4's `start`).

- Root `package.json` script, verbatim: `"mcp": "node --import tsx packages/authority/src/bin/mcp.ts"`. `pnpm --silent --dir <repo> mcp` is the stdio command an agent host launches (no pnpm banner on stdout; discovery finds the running authority).
- `MCP_INSTRUCTIONS` (exported string), passed as `instructions` in the `McpServer` options inside `createMcpServer`. Text, verbatim:

```
You are attached to one table of "A Table of Dumb Objects", a virtual tabletop where every object is a bag of cells (literals or formulas) and rules attach to space.
Read the resources vtt://docs/design (the model; section 4.7 lists the example templates) and vtt://docs/formulas (the formula and action language) before writing formulas or actions.
Start with `table_info`, then `list_objects` or `zones` for a board. `get_objects` shows cells, formulas and actions; `explain_cell` shows why a value is what it is.
The GM binder `gm_binder` holds example templates: `tpl_character`, `tpl_attack`, `tpl_damage`, `tpl_area_save`, `tpl_save_row`, `tpl_token`, `tpl_zone`, `tpl_card`, `tpl_note`, `tpl_sheet`, `tpl_hand`, `tpl_binder`, `tpl_stack`, `tpl_d20`. They are examples: copy and edit them, never mutate them by play.
To give a card to a character, `transact` a `spawn` of the template into that character's binder (the object in the character's contents tagged "binder") with `as` set to `$copy`, then `set_template_flag` on `$copy` with value true, then set its cells in the same batch. For `tpl_area_save` set `name`, `caster` and `damage_dice`; its `dc` follows the caster's `spell_dc`, which lives on the character's sheet (the character's `sheet` cell).
Every `transact` carries the `base_revision` you last read. On `stale_write`, re-read and decide again; never resend blindly.
Appearance is ordinary cells: `color`, `pattern` ("hatch"), `text`, `image` (import a local file with `import_asset`).
Run an object's action with `invoke`. Undo your own latest group with `undo` and target `mine`.
Rules that must outlive this conversation go into the table as formulas or actions.
```

Done when:
- `instructions.test.ts` holds an explicit map from every backticked identifier in `MCP_INSTRUCTIONS` to one category, asserts the set of backticked identifiers equals the map's keys, and checks each entry in its category: **tool** (`table_info`, `list_objects`, `zones`, `get_objects`, `explain_cell`, `transact`, `import_asset`, `invoke`, `undo`) — registered by the composed `vtt-mcp` process (its tools/list); **op** (`spawn`, `set_template_flag`) — a `WireOp` `type` literal; **template** (`gm_binder` and the fourteen `tpl_*`) — an object id in `stockedTableSnapshot()` (vtt-1xv.22); **cell** (`name`, `caster`, `damage_dice`, `dc`, `spell_dc`, `sheet`) — a cell of some record in that snapshot; **appearance** (`color`, `pattern`, `text`, `image`) — a cell named in the Appearance cells table of docs/DESIGN.md §4.6 (read from the file; appearance cells need not appear in any record); **field** (`as` — a key of the `spawn` op schema; `base_revision` — a key of the `transact` params schema); **rejection** (`stale_write` — a `ProtocolRejection` `type`); **exception** (`mine` — an undo target type; `$copy` — a batch binding name matching the `$name` binding syntax). Each `vtt://` URI is a registered resource.
- `pnpm-mcp.test.ts` asserts the root `mcp` script verbatim, starts an in-process authority (port 0), spawns `pnpm --silent mcp --url <ws url> --token <token>` with `cwd` the repo root through the MCP SDK's `StdioClientTransport`, completes `initialize`, lists tools including `transact` and `invoke`, and reads `instructions` equal to `MCP_INSTRUCTIONS`.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: a checked-in `.mcp.json` (Q10); MCP prompts; README text (vtt-nb8.12).

Depends on: vtt-nb8.2, vtt-nb8.4, vtt-1xv.22, vtt-1xv.13, vtt-3l6.20, vtt-5su.17.

---

### M6-c — vtt-nb8.5 — Authority: example template amendments (P1)

Implements: DESIGN.md §4.7 example templates as amended by vtt-nb8.2 (M6-D3); §8.4 steps 2, 4, 10, 11, 12, 14; FORMULAS.md §2.1 (empty in arithmetic); M6 plan decision Q6; review r1 findings 2, 3, 6 (docs/plans/m6-plan.md §4).

Exclusive files: tests `packages/authority/test/host/examples-m6.test.ts`; post-merge edits of `packages/authority/src/host/examples.ts` (vtt-1xv.22) and, only where an existing assertion pins an amended record, of `packages/authority/test/host/examples.test.ts`.

Apply exactly these record amendments (the same as vtt-nb8.2 section 2); nothing else changes (ids, `next_seq`, the `gm_binder` contents order are untouched):
- `tpl_token`: cells gain `attack_bonus: empty`, `dex_save: empty` and `hit: false` (after `damage_taken`); face gains `value hit [-0.7, -0.6, 0.5, 0.3]` (`min_size` 12, `show_when: "hit"`) and `contents [-0.8, 0.9, 1.6, 0.8]` (`min_size` 24, entries collapsed).
- `tpl_sheet`: the face element `editor name [-2.8, -3.8, 5.6, 0.6]` (style size large) gains `show_when: "owner = empty"`, and a new element `value owner [-2.8, -3.8, 5.6, 0.6]` (style size large, `show_when: "owner != empty"`) follows it.
- `tpl_attack` and `tpl_damage`: the Apply button becomes `button Apply [-1.2, 1.1, 1.15, 0.45]` with `show_when: "dmg != empty"`, followed by a new `button Discard [0.05, 1.1, 1.15, 0.45]` (no `show_when`).
- `tpl_area_save`: the Apply all button's `show_when` becomes `"damage != empty"`.
- `tpl_character_sheet`, `tpl_character_attack` follow because they are built from `tpl_sheet`/`tpl_attack`.

Done when: on a `Table` from `stockedTableSnapshot()` with the executor (`coreHandlers` + `placementHandlers`) and scripted dice: spawning `tpl_token` gives a copy whose `dex_save` and `attack_bonus` read `empty` (not `#NAME`) and whose face has one `contents` element and a `value hit` element hidden while `hit` is false; replacing that copy's `hit` with the formula `any(on(this).where(tag has "d20").total >= ac)` (`ac` 13) and spawning a `tpl_d20` onto the board at its anchor with scripted `1d20` → 15 then Roll shows the element (`faceElementVisible` true); spawning `tpl_d20` into that token copy (container destination) appends it to the token's contents; spawning `tpl_character` gives a sheet copy whose GM face view shows the `value owner` element and hides `editor name` (`faceElementVisible`, vtt-1xv.12), and a standalone `tpl_sheet` copy the reverse; the Attack flow of vtt-1xv.22's test with scripted `1d20` → 12, `1d8` → 6 against a `tpl_token` copy (`ac` 13; the character's sheet `attack_bonus` 5): after Apply the Apply element is still shown, its `action_states` entry is `enabled: false` with a reason, and a second invoke is refused `when_false`; the working copy's Discard element is shown and pressing it (invoke Discard) removes the copy; the Area Save flow against two `tpl_token` copies whose `dex_save` is never set: each row's `save_bonus` is `empty`; with scripted save rolls 15 and 12 against `dc` 14, `save_roll + save_bonus` evaluates to 15 and 12 (empty is 0 in arithmetic), `passed` is true and false, `damage_dealt` is half and full of the damage roll, and Apply all adds exactly those to each target's `damage_taken`; every amended face passes `faceProblem`; the snapshot round-trips through `serializeTable`/`parseTable`; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: new templates (no dice tray, Q15); UI; the fixture Attack card face.

Depends on: vtt-nb8.2, vtt-1xv.22, vtt-1xv.12.

---

### M6-d — vtt-nb8.6 — Fixtures: example map and goblin images (P2)

Implements: DESIGN.md §8.4 step 3 ("Import the dungeon map as one image") and step 4 (the goblin's image); M6-D7 as written by vtt-nb8.2 (the asset files do not depend on it); M4 plan decision Q21 (100 px per board unit); M6 plan decision Q11 (docs/plans/m6-plan.md §4).

Exclusive files: `packages/fixtures/assets/crypt-map.png`, `packages/fixtures/assets/goblin.png`, `packages/fixtures/src/example-assets.ts` and its sorted index line, `packages/fixtures/src/node.d.ts` (additive: `node:zlib` `inflateSync(data: Uint8Array): Uint8Array` and `deflateSync(data: Uint8Array): Uint8Array`, and a `readFile(path: string): Promise<Uint8Array>` overload), `packages/fixtures/test/example-assets.test.ts`, `packages/fixtures/test/support/raster.ts`, `packages/fixtures/test/support/write-assets.ts`.

- `CRYPT_MAP` (exported constant): `{file: "crypt-map.png", width_px: 2400, height_px: 1600, px_per_unit: 100, rooms: Room[], corridors: Rect[]}`, `Room = {n: 1 | 2 | 3 | 4 | 5 | 6; name: string; rect_px: [x, y, w, h]}`. Rooms, in pixels from the image's top-left: 1 "Entrance" `[100, 1100, 500, 400]`, 2 "Hall" `[700, 1100, 500, 400]`, 3 "Guard room" `[1300, 900, 700, 600]`, 4 "Stair" `[100, 100, 600, 600]`, 5 "Barracks" `[900, 100, 700, 600]`, 6 "Shrine" `[1800, 100, 500, 600]`; corridors `[600, 1250, 100, 100]`, `[1200, 1250, 100, 100]`, `[300, 700, 100, 400]`, `[1400, 700, 100, 200]`, `[1600, 300, 200, 100]`. `GOBLIN_IMAGE = {file: "goblin.png", width_px: 128, height_px: 128}`. `exampleAssetPath(file)`: the absolute path under `packages/fixtures/assets/` (via `import.meta.dirname`).
- `raster.ts`: `rasterCryptMap(): Uint8Array` — one palette index per pixel, row-major: 0 rock `#2b2b2b` everywhere outside rooms and corridors, 1 floor `#b8a888` inside them, 2 wall `#5a4a3a` for a 4 px border along the inside of each room rect (not corridors), 3 numeral `#1a1a1a` for the room number drawn with a 5 × 7 bitmap digit scaled ×12 with its top-left at `[x + 30, y + 30]` of the room (any legible digit bitmaps; they stay inside `[x + 30, y + 30, 60, 84]`). `rasterGoblin(): Uint8Array` — index 1 green `#4f8a3a` for pixels within 60 px of `[64, 64]`, index 0 elsewhere (transparent through a tRNS chunk).
- `write-assets.ts` encodes both as 8-bit palette PNGs (colour type 3, filter 0 on every scanline, `deflateSync`) and writes them to `packages/fixtures/assets/`; it is run once from the repo root with `node --import tsx packages/fixtures/test/support/write-assets.ts` and both PNGs are committed.

Done when: `example-assets.test.ts` reads both committed PNGs, checks the signature, every chunk's CRC, IHDR (dimensions as above, bit depth 8, colour type 3), inflates the IDAT data with `inflateSync`, un-filters the scanlines, and asserts the pixel indices equal `rasterCryptMap()`/`rasterGoblin()` exactly (so the test never depends on deflate output bytes); every room centre is floor, pixel `[50, 50]` is rock, rooms are pairwise disjoint and inside the image; each file is under 200 KiB; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: PC token images; any UI; importing the assets (vtt-nb8.9 and the user do that).

Depends on: none.

---

### M6-e — vtt-nb8.7 — UI: choose an image for a cell (P1)

Implements: DESIGN.md §4.6 Appearance cells as amended by vtt-nb8.2 (M6-D4); §8.4 step 4 ("image"); docs/PROTOCOL.md §1 (`POST /assets`); DESIGN §7 Undo and writes in the UI (base revision at the click); M6 plan decision Q7 (docs/plans/m6-plan.md §4).

Exclusive files: `packages/ui/src/assets/image-cell.ts` and its sorted index line, tests `packages/ui/test/assets/image-cell.test.tsx`; post-merge edit of `packages/ui/src/inspector/CellRow.tsx` (vtt-3l6.11, then vtt-1xv.27's drag source).

- `uploadIntoCell({file, object, cell, baseRevision, session})`: calls vtt-3l6.16's `uploadAsset(file, {token})`, then sends one `transact` `set_value {object, cell, value: {type: "text", text: path}}` with the `baseRevision` captured at the click, through vtt-3l6.21's write path (label "Set image of <name>"); an upload error (401/413/415/409) or a refusal pushes a notice through vtt-3l6.21's `NoticeStore` and writes nothing. The upload completes before the write is sent; if the row unmounts or the selection changes meanwhile, the write is still sent with the captured revision (a stale result is shown as any stale write is).
- `CellRow`: for a cell named `image` in a GM view (not in view-as, where the inspector is read-only, M4-D11), an "Upload…" button opens a hidden `<input type="file" accept="image/png,image/jpeg,image/webp,image/gif">`; a chosen file calls `uploadIntoCell`. Rows of other cells are unchanged.

Done when: jsdom tests with an in-process authority on a temp file table (vtt-3l6.16's asset handler installed) show: selecting a token and choosing a PNG through the hidden input sets its `image` cell to the returned path in one group; the base revision sent is the one at the click (a second client's write to the same cell between the click and the upload's completion makes it `stale_write` and a stale notice appears); a 415 response pushes an error notice and sends no `transact`; the button is absent for non-`image` rows and in view-as; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: dropping OS files onto the canvas (vtt-qf5.33); image cropping or scaling; template propagation.

Depends on: vtt-nb8.2, vtt-3l6.11, vtt-1xv.27, vtt-3l6.16, vtt-3l6.21, vtt-3l6.4.

---

### M6-f — vtt-nb8.8 — UI: keyboard and gesture help (P2)

Implements: DESIGN.md §4.6 On the canvas and §4.7 (the gestures as written by vtt-3l6.2 and vtt-1xv.5); vtt-qf5.17's intent ("generated from the binding tables so it cannot drift"), which this bead supersedes; M6 plan decision Q12 (docs/plans/m6-plan.md §4).

Exclusive files: `packages/ui/src/app/HelpPanel.tsx`, `packages/ui/src/app/help-content.ts`, their sorted index lines, tests `packages/ui/test/app/help.test.tsx`; post-merge edits of `packages/ui/src/app/keybindings.ts`, `src/app/Toolbar.tsx`, `src/App.tsx` (vtt-3l6.17, then vtt-1xv.23).

- `keybindings.ts` exports `KEY_BINDINGS: readonly {keys: string; label: string}[]`, the table its handler dispatches from (refactored so dispatch and help read the one table if it does not already); `?` (Shift+/) toggles help and is added to the table; no binding fires while focus is in a text field.
- `help-content.ts` exports `HELP_GESTURES: readonly {gesture: string; effect: string}[]`, verbatim, in this order: "Space-drag or middle-drag" — "pan"; "Wheel" — "zoom (over a list that scrolls: scroll it)"; "Click" — "select"; "Alt+click" — "cycle through the objects under the pointer"; "Drag one template" — "drop a copy"; "Alt held at drag start" — "move the template instead of copying it"; "Alt held at drop onto an object" — "put the dragged objects inside it"; "Drop on a card's editor field" — "set that cell to the dropped object"; "Drop on a list" — "insert there"; "Drop a template on a binder" — "give that binder a template"; "Double-click" — "run the object's default action, else edit in place"; "Click an editor field" — "edit it"; "Chevron on a list entry" — "expand or collapse it (a template entry makes a working copy)"; "Gear" — "edit a template"; "Drag a cell row from the inspector onto an object (layout mode)" — "show the cell on the face"; "Delete" — "remove the selection"; "Move selection to board…" — "move objects between boards".
- `HelpPanel`: a dialog listing `KEY_BINDINGS` then `HELP_GESTURES`; opened by `?` and by a toolbar "?" button; Esc and its close button close it.

Done when: a jsdom test of the composed `<App>` (in-process authority) opens help with `?` and with the toolbar button and finds every `KEY_BINDINGS` entry and every `HELP_GESTURES` entry; Esc closes it; `?` typed in the formula bar does not open it; the M4 and M5 app tests still pass; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: rebinding keys; tooltips on every control; a tutorial.

Depends on: vtt-1xv.23, vtt-3l6.17.

---

### M6-g0 — vtt-nb8.17 — Walkthrough: driver infrastructure and contract (P1)

Implements: the shared harness of the epic's "scripted walkthrough" (M6 plan decisions Q1, Q2, Q13); M4-D13 (jsdom, recording renderer, in-process authority, no browser automation); DESIGN.md §8.4 as amended by vtt-nb8.2 (step titles); review r1 finding 10, review r2 findings 1–3 (docs/plans/m6-plan.md §4).

Exclusive files: `packages/ui/test/walkthrough/contract.ts`, `packages/ui/test/walkthrough/steps.ts`, `packages/ui/test/walkthrough/infra.ts`, `packages/ui/test/walkthrough/infra.test.tsx`; `packages/ui/package.json` (dev dependencies `@modelcontextprotocol/client` 2.3.1 and `@modelcontextprotocol/server` 2.3.1, exact, as already pinned in `@vtt/authority`; after vtt-1xv.24's edit of the same file) and `pnpm-lock.yaml` in the same commit. The gesture helpers are vtt-nb8.18's (`gestures.ts`), implementing the `Gestures` interface fixed here. vtt-nb8.9, vtt-nb8.10 and vtt-nb8.11 import these files unchanged, and their local helpers use only `DriverContext` and `Gestures`; a missing facility is a defect of this bead or vtt-nb8.18, reported to the orchestrator.

- `steps.ts`: `WALKTHROUGH_STEPS`, exactly these fifteen `{id, title}` entries (short titles for the steps of §8.4 as amended by vtt-nb8.2; the guide uses them as headings): s1 "Open a new table"; s2 "Add the HIT badge, then make four characters"; s3 "Import the Crypt map and draw six opaque rooms"; s4 "Make a goblin template and place eight"; s5 "Ask the agent for difficult terrain and a Fireball card"; s6 "Scribble a note in ink and save"; s7 "View the Crypt as Aldric and reveal room 1"; s8 "Move the party, reveal room 3, watch room 2"; s9 "Roll initiative in a dice tray and line up the tokens"; s10 "Aldric attacks with the Attack card"; s11 "A goblin attacks back with its own die"; s12 "Aldric casts Fireball"; s13 "The rogue triggers the stair trap"; s14 "Undo the wrong goblin's damage and a mistaken delete"; s15 "Save, close and reopen".
- `contract.ts` (types only; `Point = [number, number]` in board units on the active board):
  - `DriverContext`: `root: HTMLElement` (the rendered app's container, for Testing Library queries); `session` (the app's own vtt-3l6.4 `TableSession`); `ui` (the app's vtt-3l6.21 `UiStore`); `renderer` (the recording renderer the app draws with); `gm: ProtocolClient` (assertions only, never writes); `file: string` (absolute table path); `toScreen(p): Point` and `toBoard(p): Point` (client px ↔ board units through the current camera); `setCamera({center, zoom}): Promise<void>` (through `ui`, resolving after the next frame); `frame(): Promise<void>`; `pickFile(file: File): void` (queues a `File` for the next hidden `<input type="file">` the app opens: the image tool and Upload…); `upload(bytes: Uint8Array, name: string): Promise<{path: string}>` (`POST /assets` with the session token); `savedFile(): Promise<string>` (the table file's text on disk); `byName(name, board?): ObjectId` (exactly one live object with that `name`, else it throws naming the matches); `startAgent(name): Promise<{mcp: Client; close(): Promise<void>}>`; `restart(): Promise<void>`; `close(): Promise<void>`.
  - `Gestures` (implemented by vtt-nb8.18; every gesture first calls `bringIntoView` on its targets): `bringIntoView(target: ObjectId | {container, entry} | {object, element: {cell} | {action}})` (pans and zooms the camera and scrolls enclosing contents elements until the target is unclipped, on screen and at least its `min_size`); `addBoard(name)`, `showBoard(name)`, `viewAs(name | "GM")`, `moveSelectionToBoard(name)`; `drag(from, to, {alt?})`, `dragObject(id, to, {alt?})`, `marquee(from, to)`, `click(id)`, `doubleClick(id)`, `key(combo)`; `drawZone(from, to, {fog?}): Promise<ObjectId>`; `pressButton(object, action, {expectDisabled?})`; `expandEntry(container, entry)`, `gear(entry)`; `dragEntry(container, entry, to: Point | {object, cell} | {object, contents: true})`; `dropOnEditor(dragged, target, cell)`; `editInPlace(object, cell, text)`; `inspectorSet(object, cell, text)`, `inspectorAddCell(object, cell, text)`, `inspectorCellVisibility(object, cell, viewersText)`, `inspectorFlags(object, {template?, character?})`; `elementShown(object, {cell} | {action}): boolean`, `elementEnabled(object, action): boolean`, `covers(): number`; `logGroups(): {index, label, actor, undone, sentences}[]`, `logLoadOlder()`. `createGestures(ctx: DriverContext): Gestures`.
  - `PrepResult`: `characters: Record<"Aldric" | "Brenna" | "Corin" | "Dara", {token, sheet, binder, attackTemplate}>`; `gmBinder`; `crypt`; `map`; `mapOrigin: Point` (the map's top-left `M`); `unitsPerPx: 0.01`; `rooms: Record<1 | … | 6, {id, rect: [x, y, w, h]}>` (board units on Crypt); `goblinTemplate`; `goblins: ObjectId[]` (G1–G8 in order); `goblinDice: ObjectId[]` (same order); `fireballTemplate`; `note`.
  - `PlayAResult`: `initiative: {name, roll, total}[]` (strip order); `tray`, `strip`, `trayDice: ObjectId[]`; `aldricBinder` (on Crypt); `attackCopy` (the step-10 working copy); `goblinDie` (G2's die, now on Aldric); `hp: Record<string, number>` (current `hp` of the four characters and G1–G8).
- `infra.ts`: `startWalkthrough({dice: DiceEntry[]}) → Promise<DriverContext>`: an in-process authority on a temp table file created with `stockedTableSnapshot()` (vtt-1xv.22's `newTable` option), vtt-3l6.16's asset handler installed, a `ScriptedDiceSource` with `dice`; the real `<App>` as composed by vtt-1xv.23 in jsdom with a recording renderer. If jsdom lacks `createImageBitmap`, it is stubbed the way vtt-3l6.18's test does, reporting the uploaded image's real PNG dimensions. `startAgent` = `createMcpServer` with an `agent` `ProtocolClient` named `name`, connected to an MCP `Client` through `InMemoryTransport.createLinkedPair()`. `restart()` closes the server with a final save, reopens the same file with a new token, and remounts `<App>` after the `unauthorized` banner's Reload, resolving once connected on the previously active board. `close()` disposes the agent, sockets, server and temp files; tests call it in `afterEach`.

Done when: `infra.test.tsx`, each case on a fresh stocked table, exercises every `DriverContext` facility: `root` contains the toolbar; `session` and `ui` are the app's (a `ui.select` shows in the inspector); `toBoard(toScreen(p))` round-trips within 1e-6 at two zooms set by `setCamera`; `pickFile` + the image tool imports a PNG whose object reports its dimensions; `upload` returns a path served at `/assets/`; `savedFile` after `Ctrl+S` parses as JSON; `byName("GM binder")` resolves and `byName` throws for two objects named "Token"; `startAgent` lists tools including `transact` and commits a `transact` whose group actor is the agent; `restart` after a write leaves every object equal through `gm` and the app connected on the same board; `close` leaves no open handles (the test exits); `WALKTHROUGH_STEPS` equals the fifteen entries above; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Lifecycle (Q13): this bead never changes product code; a facility that cannot be built against the merged app is reported to the orchestrator, who files a blocking fix bead.

Out of scope: gesture helpers (vtt-nb8.18); the §8.4 steps (vtt-nb8.9, vtt-nb8.10, vtt-nb8.11); product code.

Depends on: vtt-nb8.2, vtt-1xv.24, vtt-1xv.23, vtt-1xv.22, vtt-3l6.16, vtt-3l6.18.

---

### M6-g1 — vtt-nb8.18 — Walkthrough: UI gesture helpers (P1)

Implements: the gesture half of the walkthrough harness (M6 plan decisions Q2, Q13); DESIGN.md §4.6 On the canvas, §4.7 (the gestures as written by vtt-3l6.2 and vtt-1xv.5); review r2 findings 2, 3 (docs/plans/m6-plan.md §4).

Exclusive files: `packages/ui/test/walkthrough/gestures.ts`, `packages/ui/test/walkthrough/gestures.test.tsx`. Implements exactly the `Gestures` interface and `createGestures(ctx)` signature fixed in vtt-nb8.17's `contract.ts`, using only `DriverContext`; it never edits vtt-nb8.17's files (an interface problem goes back to the orchestrator).

- Gestures dispatch pointer, keyboard and wheel events in screen coordinates on the app's canvas (`ctx.toScreen`) and use Testing Library and user-event on `ctx.root` for DOM chrome (board tabs, view-as menu, "Move selection to board…", inspector rows, flags, Log tab).
- `bringIntoView` (called first by every gesture on its targets): when the target's screen rect is off screen, clipped by an enclosing contents element, or below its `min_size`, it re-centres and zooms the camera with `ctx.setCamera` and wheels each enclosing contents element (innermost first) until the target row is fully visible; it throws naming the target when that is impossible.
- Face targets are located with `faceHitAt` on the app's face scene; `pressButton` asserts the button is drawn and enabled and clicks it, or with `expectDisabled` asserts it is drawn and disabled, clicks, and asserts the authority's revision is unchanged; `elementShown`/`elementEnabled` read the drawn face and `action_states`; `covers` counts cover draws in the last frame of `ctx.renderer`.
- `drawZone` uses the rect zone tool (R) with the fog option when `fog`, and returns the created id; `logGroups`/`logLoadOlder` read and page the Log tab.

Done when: `gestures.test.tsx`, each case on a fresh table from `startWalkthrough`, shows: `dragEntry` of the `tpl_d20` entry (scrolled to the last row of the GM binder's list by `bringIntoView`) to a board point spawns a die there, `doubleClick` rolls it (scripted 7) and `pressButton(die, "Roll")` on a second die rolls 11; `bringIntoView` reaches an editor element inside an expanded entry nested two lists deep (a character's sheet inside the token's list) from a zoomed-out camera; `editInPlace`, `inspectorSet`, `inspectorAddCell` with a formula, `inspectorCellVisibility` and `inspectorFlags` each commit one group; `addBoard`, `showBoard`, `marquee` + `moveSelectionToBoard` move two objects; `drawZone` with `fog` makes an opaque zone and `viewAs` a spawned character gives `covers()` 1; `dropOnEditor` sets a working Attack copy's `target`; `pressButton` with `expectDisabled` sends no request; `logGroups` lists the groups above and `logLoadOlder` loads more after 60 groups; `key("Ctrl+Z")` undoes one group; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Lifecycle (Q13): this bead never changes product code; a gesture that cannot be performed against the merged app is reported to the orchestrator, who files a blocking fix bead.

Out of scope: infrastructure and the contract (vtt-nb8.17); the §8.4 steps; product code.

Depends on: vtt-nb8.17, vtt-1xv.20, vtt-1xv.23, vtt-3l6.10.

---

### M6-g — vtt-nb8.9 — Walkthrough: prep (§8.4 steps 1–6) (P1)

Implements: DESIGN.md §8.4 steps 1–6 as amended by vtt-nb8.2 (M6-D1, M6-D3) and read as M6 plan decision Q3 states (table below); the epic's "scripted walkthrough" (Q1, Q2); M6 plan decision Q13; review r1 findings 5, 6, 10; review r2 findings 2, 5, 7 (docs/plans/m6-plan.md §4).

Exclusive files: `packages/ui/test/walkthrough/prep.ts`, `packages/ui/test/walkthrough/prep.test.tsx`. Uses vtt-nb8.17's `DriverContext` and contract and vtt-nb8.18's `Gestures` unchanged. Prep-only actions are local helpers in `prep.ts` built only from those: image import (image tool key I, a click, `ctx.pickFile`), Upload… (`ctx.pickFile`), ink strokes (key D, then `drag`), the Face section (Testing Library on `ctx.root`).

**Readings of §8.4 used by all three walkthrough beads and the guide (Q3):**

| Step | Reading |
|---|---|
| 2 | The HIT badge is a cell `hit` plus a face element `value hit` with `show_when: "hit"`, added once to `tpl_character` through its gear and the inspector's Face section. Names are typed on the tokens; sheet values on the sheets (whose headers then show the token's name). |
| 3 | After creating Crypt, the GM binder is moved to Crypt with "Move selection to board…" so templates drop beside the map. |
| 4 | The goblin starts as a copy of `tpl_token`, which already has the HIT badge element (vtt-nb8.5); the GM types the formula into its `hit`. The goblin template is marked a character (FIXTURES §9 makes the goblin one), so its die's `owner` names a character and copies keep the flag. The d20 goes in by dropping the `tpl_d20` entry on the goblin's contents list; `owner` typed as `@id`. The template sits on Crypt; copies are dragged straight into rooms 3 and 5 and renamed G1–G8 in the inspector so each can be told apart. |
| 5 | The agent gives Aldric a template copy of `tpl_area_save` (M5-D18's recipe) and writes Aldric's sheet `spell_dc` 14; the GM corrects the card's `dc` to 15 by typing over it in the inspector (an override). |
| 6 | The note is made on Crypt and moved to the GM board; the scribble is three ink strokes. "Readable" = indented JSON naming "Room 4" and "Fireball". |
| 9 | The tray is a zone whose `text` is `=sum(contents(this).where(tag has "die").value)` (FORMULAS §10, typed; no template). "The tokens" in the strip are the four PCs. |
| 10, 12, 14 | Aldric's binder is dragged out of his token onto Crypt first; Aldric's actions are pressed in view-as Aldric (actor Aldric, M5-D11). |
| 12 | Brenna steps into room 3 before the cast so the nudge can miss the fighter. |
| 14 | The spent step-10 working copy is discarded with its Discard button; the wrong-goblin Apply uses a fresh working copy; the delete is a Delete-key removal. |

Exports: `PREP_DICE = [1d20 → 15]` (the only roll prep makes; play tests start their scripts with it) and `runPrep(ctx) → Promise<PrepResult>`, which performs steps 1–6 through UI gestures (the single exception: step 5's agent, through `ctx.startAgent`) and returns vtt-nb8.17's `PrepResult` (`goblins` are the copies in the order spawned below, renamed "G1"…"G8").

1. New table: `gm_board` holds exactly `gm_binder`, whose contents are the fourteen stocked templates in order.
2. Gear on `tpl_character`'s entry → "Editing template" → add cell `hit` with `=any(on(this).where(tag has "d20").total >= ac)`; through the Face section (vtt-1xv.18) add `value hit [-0.5, -0.95, 1, 0.3]` with `show_when` `hit`. Drag the `tpl_character` entry onto `gm_board` at `[10, 0]`, `[12, 0]`, `[14, 0]`, `[16, 0]`. On each: `editInPlace` the token's `name`: Aldric, Brenna, Corin, Dara; expand the sheet entry in the token's contents list and `editInPlace` `ac`/`max_hp`/`attack_bonus`/`dex_save`: Aldric 16/24/5/1, Brenna 18/30/6/0, Corin 14/18/5/4, Dara 12/16/4/2.
3. `addBoard("Crypt")`; the image tool (key I) imports `crypt-map.png` (vtt-nb8.6's `exampleAssetPath`); `M` = the map's top-left corner read from its view; `drawZone` with `fog` six times exactly over `CRYPT_MAP.rooms` (100 px per unit from `M`); rename each in place "Room 1" … "Room 6"; type `=if(len(contents(this).where(tag has "pc")) > 0, all, gm)` into `visible_to` of rooms 2 and 4. On `gm_board` select `gm_binder`, `moveSelectionToBoard("Crypt")`, then drag it to `M + [27, 5]`.
4. Drag the `tpl_token` entry out of the GM binder to `M + [-4, 8]`; rename it "Goblin"; Upload… `goblin.png` into `image` (vtt-nb8.7); `ac` 13 made GM-only (`inspectorCellVisibility` `gm`); `max_hp` 7, `attack_bonus` 4, `dex_save` 2; type `=any(on(this).where(tag has "d20").total >= ac)` into `hit`; `inspectorFlags({character: true, template: true})`. Badge check: drag the `tpl_d20` entry to `M + [-4, 8]` (it lands on top of the goblin), `doubleClick` it (15): the goblin's `hit` element is shown; select the die and press Delete: the element is hidden again. Drag the `tpl_d20` entry onto the goblin's contents list (a copy is inserted); select that die in the list; type `owner` `@<goblin id>` and `modifier` `=owner.attack_bonus`. Drag the goblin template to room 3 at `M + [14.5, 10.5]`, `[15.5, 12]`, `[14.5, 13.5]`, `[18.5, 13.5]` and to room 5 at `M + [11, 2.5]`, `[12.5, 2.5]`, `[11, 4.5]`, `[12.5, 4.5]`; right after each drop, `inspectorSet` the new copy's `name` to "G1" … "G8" in that order.
5. `ctx.startAgent("walkthrough-agent")`; MCP tool calls: `zones {board: <crypt id>}` → the zone named "Room 4"; `transact` (label "Room 4: difficult terrain, hatched") `set_tag room4 ["difficult"]`, `set_value room4.pattern "hatch"`; `list_objects`/`get_objects` → Aldric, his `sheet` reference and his binder (the contents entry tagged `binder`); `transact` (label "Fireball for Aldric", one batch with the base revision just read) `spawn tpl_area_save → container <binder> as "$fb"`, `set_template_flag $fb true`, `set_value $fb.name "Fireball"`, `set_value $fb.caster ref aldric`, `set_value $fb.damage_dice 8d6`, `set_value <aldric's sheet>.spell_dc 14`. The GM then expands Aldric's binder entry in his token's list, `gear`s the Fireball entry, reads `dc` 14, `caster` Aldric and `damage_dice` 8d6 in the inspector, and types `15` over `dc` (an override; the formula stays).
6. Drag `tpl_note` out of the GM binder to `M + [-4, 12]`; `moveSelectionToBoard("GM")`; the ink tool (key D) draws three strokes over the note (each appended to its `ink`); `Ctrl+S`; the status shows "Saved".

Done when: `prep.test.tsx` runs `runPrep` with `PREP_DICE` within 90 s and asserts through `ctx.gm`: step 1 as stated; four characters with `hp` 24, 30, 18, 16 and `ac` 16, 18, 14, 12 (through the sheet formulas), each with its own sheet (`owner` = the character; `value owner` shown, `editor name` hidden) and binder holding an Attack template whose `attacker` is the character, each with `hit` false and a `hit` face element; Crypt with the map (24 × 16 units) and six opaque rooms named "Room 1" … "Room 6", `visible_to` `gm` on 1, 3, 5, 6 and the formula on 2 and 4 (evaluating to `gm`); the goblin's badge was shown with the die on it and hidden after its deletion; `byName("G1")` … `byName("G8")` resolve, `zones` on Crypt lists G1–G4 in Room 3 and G5–G8 in Room 5, and the goblin template and every G have `is_character` true (the template also `is_template`, the copies not); every G has `image` = the goblin asset path, the `hit` formula with `hit` false and its `hit` element hidden, a die whose `owner` is that G with `modifier` 4, and an `ac` absent from Aldric's view; two separate groups whose actor is `{type:"agent", name:"walkthrough-agent"}`: "Room 4: difficult terrain, hatched" (room 4's tag `difficult` and `pattern` "hatch") and, after it, "Fireball for Aldric" (the Fireball template's creation and Aldric's sheet `spell_dc` 14); the Fireball template in Aldric's binder is a template with `caster` Aldric, `damage_dice` 8d6 and `dc` overridden to 15 by a GM group (formula `caster.spell_dc` kept); the note on `gm_board` has three ink strokes; the saved file parses as JSON, is indented (contains a newline followed by two spaces), and contains "Room 4" and "Fireball"; zero leftover dice; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Lifecycle (Q13): this bead never changes product code in any package. A step that cannot be done through the merged UI is reported to the orchestrator with the failing gesture; the orchestrator files a fix bead under vtt-nb8 that blocks this one.

Out of scope: steps 7–15 (vtt-nb8.10, vtt-nb8.11); the driver (vtt-nb8.17); judging feel; product code.

Depends on: vtt-nb8.17, vtt-nb8.18, vtt-nb8.5, vtt-nb8.6, vtt-nb8.7, vtt-1xv.18.

---

### M6-h — vtt-nb8.10 — Walkthrough: play, steps 7–11 (P1)

Implements: DESIGN.md §8.4 steps 7–11 as amended by vtt-nb8.2 (M6-D1) and read as M6 plan decision Q3 states (the readings table in vtt-nb8.9); M6-D3 (Apply stays visible; the goblin's contents list); M6 plan decision Q13; review r1 findings 5, 10; review r2 findings 2, 9 (docs/plans/m6-plan.md §4).

Exclusive files: `packages/ui/test/walkthrough/play-a.ts` (`runPlayA(ctx, prep) → Promise<PlayAResult>`), `packages/ui/test/walkthrough/play-a.test.tsx`. Imports vtt-nb8.17's `DriverContext` and contract, vtt-nb8.18's `Gestures`, and vtt-nb8.9's `runPrep` and `PREP_DICE` unchanged; local helpers use only those; returns vtt-nb8.17's `PlayAResult`; goblins are addressed by their names G1–G8 (`ctx.byName`).

Scripted dice for the whole run, in order: `PREP_DICE`, then `1d20` 14, 9, 17, 6 (initiative); `1d20` 15, `1d8` 6 (Aldric's attack); `1d20` 13 (the goblin's die).

7. Switch to Crypt; view as Aldric: six covers drawn. GM view: select Room 1, type `all` into `visible_to`. View as Aldric: five covers; Room 1 uncovered.
8. GM view. On `gm_board`, marquee the four characters, "Move selection to board…" Crypt (positions kept), then drag them to Room 1 at `M + [2, 12]`, `[3, 12]`, `[4, 12]`, `[5, 12]`. Room 3: type `all` into `visible_to`. Drag Aldric to `M + [9, 13]` (Room 2): viewing as Aldric, Room 2 is uncovered; GM view, drag him back to `M + [2, 13]`: viewing as Aldric, Room 2 is covered again.
9. GM view. Rect zone tool: "Tray" from `M + [0, 17]` to `M + [6, 20]`; inspector: add cell `text` with `=sum(contents(this).where(tag has "die").value)`. Drag `tpl_d20` from the GM binder into the tray four times (`M + [1, 18.5]`, `[2, 18.5]`, `[3, 18.5]`, `[4, 18.5]`); double-click each: `value` 14, 9, 17, 6, the initiative dice of Aldric, Brenna, Corin and Dara in that order; the tray's `text` is 46 (the raw dice). The initiative bonus is each sheet's `dex_save` (the stocked records have no other Dex cell), added by eye: totals Corin 21, Aldric 15, Brenna 9, Dara 8. Zone "Initiative" from `M + [8, 17]` to `M + [20, 18]`; drag Corin, Aldric, Brenna, Dara into it at x = 9, 11, 13, 15 (y 17.5), in that order; `PlayAResult.initiative` records each name, roll and total in strip order, and the test asserts the totals equal roll + that character's `dex_save` read through `ctx.gm`.
10. Drag Aldric's binder entry out of his token's contents list to `M + [27, 15]` (a move; `owner` unchanged). View as Aldric. Expand its Attack template entry: a working copy appears right after it, expanded and selected. Drag G1 onto the copy's `target` editor (G1 does not move). Press Roll: `total` 20, `hit` true shown; G1's `ac` absent from Aldric's view. Press Roll damage: `dmg` 6. Press Apply: G1 `damage_taken` 6 and `hp` 1 on G1's face; the Log tab's newest group is labelled Apply with actor Aldric and a sentence naming G1. Apply is still drawn, disabled, with its reason shown; pressing it sends no request (the authority's revision is unchanged).
11. GM view. Drag G2's die out of G2's contents list onto Aldric (a plain drop; it lands on top). Double-click the die: `value` 13, `total` 17; Aldric's `hit` is true and his `hit` element is drawn.

Done when: `play-a.test.tsx` runs `runPrep` then `runPlayA` within 120 s with zero leftover dice and asserts every outcome above through the assertion client and, where stated, the recording renderer (cover counts, drawn and disabled elements); `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Lifecycle (Q13): this bead never changes product code; a step that fails because of a product defect is reported to the orchestrator, who files a blocking fix bead under vtt-nb8.

Out of scope: steps 12–15 (vtt-nb8.11); judging feel; product code.

Depends on: vtt-nb8.9, vtt-nb8.17, vtt-nb8.18.

---

### M6-i — vtt-nb8.11 — Walkthrough: play, steps 12–15 (P1)

Implements: DESIGN.md §8.4 steps 12–15 as amended by vtt-nb8.2 (M6-D1, step 14) and read as M6 plan decision Q3 states (the readings table in vtt-nb8.9); DESIGN §7 (save, reopen, undo across a restart); M6-D2 (Ctrl+Z is `human`); M6-D3 (Discard buttons); M6 plan decision Q13; review r1 findings 2, 5, 10; review r2 finding 2 (docs/plans/m6-plan.md §4).

Exclusive files: `packages/ui/test/walkthrough/play-b.test.tsx`. Imports vtt-nb8.17's `DriverContext` and contract, vtt-nb8.18's `Gestures`, vtt-nb8.9's `runPrep` and `PREP_DICE`, and vtt-nb8.10's `runPlayA` unchanged (local helpers use only those); goblins are addressed by their names G1–G8 (`ctx.byName`).

Scripted dice after `PREP_DICE` and vtt-nb8.10's entries, in order: `8d6` [6, 5, 4, 3, 2, 1, 6, 1] (28); `1d20` 15, 5, 12 (saves); `1d20` 8 (trap); `1d20` 18, `1d8` 5 (wrong goblin).

12. GM view: drag Brenna from the strip to `M + [17, 11]` (Room 3). View as Aldric. Drag the Fireball template entry from Aldric's binder to `M + [27, 22]` (a copy, with its zone; its `dc` override 15 is copied). Drag the zone entry out of the card's contents list to `M + [15.5, 11.5]`: `targets` = {G1, G2, Brenna}; drag the zone to `M + [14.8, 12]`: `targets` = [G1, G2, G3] (Brenna missed). Press Lock targets: three rows. Press Roll damage: `damage` 28. Expand each row in order and press Roll save: G1 15 (15 + 2 ≥ 15, passes, 14), G2 5 (fails, 28), G3 12 (fails, 28). Press Apply all: G1 `damage_taken` 20, G2 28, G3 28; the newest log group has one damage sentence per goblin.
13. GM view: drag `tpl_note` from the GM binder to `M + [7, 19]`; click its text editor and type "DC 12". Drag `tpl_d20` into the tray at `M + [5, 18.5]`; double-click it: `value` 8; the tray's `text` is 54.
14. View as Aldric. The step-10 working copy's Discard button is drawn and enabled; press it: the copy is removed; expand the Attack template entry again: a new working copy. Drop G4 on its `target`; Roll (18), Roll damage (5), Apply: G4 `damage_taken` 5. Ctrl+Z: G4 `damage_taken` 0 and the copy's `applied` false (one undo reversed the character's whole Apply group, vtt-nb8.3). GM view: select G4, Delete: G4 is gone; Ctrl+Z: G4 is back under its id with its die. Log tab: the Apply group is marked undone; "Load older" until the agent's "Fireball for Aldric" group is listed.
15. Ctrl+S ("Saved"); `restart()`; after Reload the app shows Crypt. Through the assertion client: every object, cell (value, formula, override) and containment equals the state captured before the restart; the log's groups (index, label, actor, undone flags) are equal; G4 exists. Ctrl+Z reverses exactly the group the captured log predicts: the newest group that is neither undone nor an undo and whose actor is `gm` or a character.

Done when: `play-b.test.tsx` runs prep, play A and the steps above within 180 s with zero leftover dice and every assertion above holding; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Lifecycle (Q13): this bead never changes product code; a step that fails because of a product defect is reported to the orchestrator, who files a blocking fix bead under vtt-nb8.

Out of scope: judging feel; product code.

Depends on: vtt-nb8.10, vtt-nb8.17, vtt-nb8.18, vtt-nb8.3.

---

### M6-j — vtt-nb8.12 — Docs: README quick start and the first-session guide (P1)

Implements: the epic's "a real playtest" (the guide it runs from); DESIGN.md §8.4 as amended by vtt-nb8.2; M6-D5, M6-D6; CLAUDE.md Conventions as amended by vtt-nb8.2 (README.md and docs/FIRST-SESSION.md are maintained docs); M6 plan decision Q14 and orchestrator note 7; review r1 findings 1, 5, 7; review r2 findings 7, 8, 9 (docs/plans/m6-plan.md §4).

Exclusive files: `README.md`, `docs/FIRST-SESSION.md` (new), test `packages/ui/test/walkthrough/guide-sync.test.ts`.

- **README.md** (the existing Workflow section is kept, after a new first part): one paragraph on what the project is; **Quick start**: prerequisites (Node 26 per `engines`, pnpm 10.32 via `corepack enable`), `pnpm install`, `pnpm start tables/crypt.table.json` (run in the repo root; creates `tables/` and the table with the stocked GM binder, `--empty` for none; builds the UI first only when it is missing or stale, `--no-build` skips; opens the browser; Ctrl+C saves and stops; running it again reopens the table and an old tab offers Reload); **Attach an agent**: the stdio command `pnpm --silent --dir <absolute repo path> mcp`, the Claude Code form `claude mcp add vtt -- pnpm --silent --dir <repo> mcp`, and the generic JSON form `{"command": "pnpm", "args": ["--silent", "--dir", "<repo>", "mcp"]}`; discovery needs no token while the table is being served; **Keys and gestures**: a table mirroring `KEY_BINDINGS` and `HELP_GESTURES` (vtt-nb8.8) and a pointer to `?`; **Docs**: DESIGN, FORMULAS, PROTOCOL, FIXTURES, FIRST-SESSION.
- **docs/FIRST-SESSION.md**: a header covering setup (`pnpm start tables/crypt.table.json` on a fresh file; attach an agent before step 5 and paste the step-5 request verbatim), where the example images are (`packages/fixtures/assets/crypt-map.png`, `goblin.png`) and the room numbering, how to report (copy the filled result lines, the overall line and any other feedback into one comment on vtt-nb8, or hand them to the orchestrator), and what the result words mean ("broken": an interaction did not do what the guide says; "friction": it worked but was awkward, slow or confusing; a different roll or game outcome is not a fault and is marked in its own field); then the fifteen steps, one `### Step N — <title>` heading per entry of `WALKTHROUGH_STEPS` (vtt-nb8.17) in the same order with the same titles, each with: the amended §8.4 text quoted; the concrete gestures as vtt-nb8.9, vtt-nb8.10 and vtt-nb8.11 perform them, in prose, with the same names (including marking the goblin template a character as well as a template before placing copies, and renaming the goblin copies G1–G8 in the inspector), positions and typed values and the readings table of vtt-nb8.9; "You should see", with every dice-dependent expectation stated as a rule over the user's own rolls (initiative is each d20's value plus that character's sheet `dex_save`, highest first (the tray still shows the raw dice sum); `hp` = `max_hp` − `damage_taken`; an attack hits when `total` ≥ the target's AC; a Fireball row passes when `save_roll` + `dex_save` ≥ `dc` and then takes half the damage, floored); in steps 10 and 14, the recovery for a miss (when `hit` is false, Roll damage and Apply are not shown at all: press Discard, expand the Attack template again for a fresh copy as the next turn, and repeat until it hits; Apply is drawn but disabled only after it has been applied; the step is ok if the buttons behaved as described); and the line `Result: ok / friction / broken — game went differently: yes / no — notes:`. It ends with the line `Felt good: yes / not yet — why:`.

Done when: `guide-sync.test.ts` parses docs/FIRST-SESSION.md and asserts its `### Step N — <title>` headings equal `WALKTHROUGH_STEPS` in order, that each step section contains a line matching `Result: ok / friction / broken — game went differently: yes / no — notes:`, that steps 10 and 14 mention Discard and the file ends with the `Felt good:` line, and that README.md contains `pnpm start tables/crypt.table.json`, `--no-build`, `pnpm --silent --dir` and every `KEY_BINDINGS` key; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: DESIGN, PROTOCOL and CLAUDE.md edits (vtt-nb8.2); MCP resources (the guide is not one); screenshots.

Depends on: vtt-nb8.2, vtt-nb8.4, vtt-nb8.16, vtt-nb8.6, vtt-nb8.7, vtt-nb8.8, vtt-nb8.17, vtt-nb8.11.

---

### M6-k — vtt-nb8.13 — Human: playtest 1, the first session in a real browser (P1)

Implements: the epic's "a real playtest" (M6 plan decision Q1 and orchestrator note 1, docs/plans/m6-plan.md §4); DESIGN.md §8.4 in full, as amended.

Human bead: worked by the user, not by an agent. No code and no branch. The orchestrator posts the start command and a pointer to docs/FIRST-SESSION.md as a comment here when this bead becomes ready, and never closes it on its own.

The user runs docs/FIRST-SESSION.md in a real browser on a fresh table (`pnpm start tables/<new name>.table.json`) with their own agent attached for step 5, fills in each step's `Result:` line and the final `Felt good:` line (with its why), adds any other feedback in free text, and posts them as one comment on vtt-nb8. Results from earlier manual checklists (vtt-3l6.18's on vtt-3l6, vtt-1xv.24's on vtt-1xv), if the user ran them, go in the same comment.

Done when: the user has posted on vtt-nb8 one comment holding fifteen `Result:` lines in the guide's form (ok / friction / broken, game went differently yes / no, notes) and the `Felt good:` line with its why; the orchestrator closes this bead citing that comment.

Out of scope: fixing anything (vtt-nb8.14 files the fixes).

Depends on: vtt-nb8.12, vtt-3l6.18, vtt-1xv.24.

---

### M6-l — vtt-nb8.14 — Plan: M6 triage (P1)

Implements: the epic's "Fix what is not pleasant" (M6 plan decision Q1; review r1 finding 12; docs/plans/m6-plan.md §4); CLAUDE.md "Tracking: beads" planning conventions.

Planning bead, worked by the orchestrator as planning beads are. Input: the playtest comment of vtt-nb8.13 on vtt-nb8.

- Record one disposition for each of: every `Result:` line marked friction or broken; the `Felt good:` line's why (whatever the verdict, when it names a problem); each point of free-text feedback; and each finding from earlier manual checklists posted on vtt-nb8, vtt-3l6.18 or vtt-1xv.24. A disposition is a fix bead under vtt-nb8 in the CLAUDE.md shape (Implements / Done when / Out of scope / Depends on; exclusive files; tests first where tests apply; dependencies recorded with `bd dep`), or a bead in Polish (vtt-qf5) or Later (vtt-y1w) with the reason it can wait, or "no action" with a reason.
- Already-filed candidates are reused (re-parented under vtt-nb8 and rewritten) rather than duplicated: vtt-qf5.14 grids and snapping, vtt-qf5.26 keyboard access to face buttons, vtt-qf5.27 pen colours, vtt-qf5.28 grid and fan list layouts, vtt-y1w.18 DOM binder panel, and vtt-qf5.35 (drop onto a board tab).
- Every M6 fix bead is recorded as a blocker of vtt-nb8.15; when a fix changes what docs/FIRST-SESSION.md describes, the fix bead updates it (CLAUDE.md maintained docs).
- The new beads are reviewed by Codex as a plan (`scripts/review-plan.sh vtt-nb8`), at most two rounds; each finding gets a disposition.

Done when: every item listed above has a disposition recorded in one comment on vtt-nb8; every M6 fix bead is filed and blocks vtt-nb8.15; the Codex review findings are dispositioned.

Out of scope: implementing the fixes.

Depends on: vtt-nb8.13.

---

### M6-m — vtt-nb8.15 — Human: playtest 2, it felt good (P1)

Implements: the epic's Done-when ("Done when the GM says it felt good"); M6 plan decision Q1 and orchestrator note 1 (docs/plans/m6-plan.md §4).

Human bead: worked by the user, not by an agent. No code and no branch. The orchestrator never closes it on its own.

After every fix bead vtt-nb8.14 filed has merged, the user reruns docs/FIRST-SESSION.md (as updated by the fixes) in a real browser on a fresh table with their agent attached, and posts the fifteen `Result:` lines in the guide's form, the `Felt good:` line with its why, and any other feedback as one comment on vtt-nb8.

Done when: the user has posted that comment and its line reads `Felt good: yes`; the orchestrator then closes this bead and the epic vtt-nb8 citing the comment. If the line reads `Felt good: not yet`, the orchestrator files another triage bead and playtest bead pair of the same shape as vtt-nb8.14 and this one (the new triage dispositions this run's why, free text and step results), and closes this bead as superseded by the new playtest bead.

Out of scope: fixing anything.

Depends on: vtt-nb8.14 (and every fix bead vtt-nb8.14 files, recorded there).

---

## 3. Dependency digraph (after review r2)

```
vtt-1xv.5 ─► M6-0
vtt-1xv.11, vtt-1xv.7, vtt-3l6.21, M6-0 ─► M6-a
vtt-1xv.22, vtt-3l6.15, M6-0 ─► M6-b
vtt-1xv.13, vtt-1xv.22, vtt-3l6.20, vtt-5su.17, M6-0, M6-b ─► M6-b2
vtt-1xv.12, vtt-1xv.22, M6-0 ─► M6-c
(none) ─► M6-d
vtt-1xv.27, vtt-3l6.11, vtt-3l6.16, vtt-3l6.21, vtt-3l6.4, M6-0 ─► M6-e
vtt-1xv.23, vtt-3l6.17 ─► M6-f
vtt-1xv.22, vtt-1xv.23, vtt-1xv.24, vtt-3l6.16, vtt-3l6.18, M6-0 ─► M6-g0
vtt-1xv.20, vtt-1xv.23, vtt-3l6.10, M6-g0 ─► M6-g1
vtt-1xv.18, M6-g0, M6-g1, M6-c, M6-d, M6-e ─► M6-g
M6-g0, M6-g1, M6-g ─► M6-h
M6-h, M6-g0, M6-g1, M6-a ─► M6-i
M6-i, M6-b2, M6-g0, M6-0, M6-b, M6-d, M6-e, M6-f ─► M6-j
vtt-1xv.24, vtt-3l6.18, M6-j ─► M6-k
M6-k ─► M6-l
M6-l ─► M6-m
```

Ids: M6-0 = vtt-nb8.2, M6-a = vtt-nb8.3, M6-b = vtt-nb8.4, M6-b2 = vtt-nb8.16, M6-c = vtt-nb8.5, M6-d = vtt-nb8.6, M6-e = vtt-nb8.7, M6-f = vtt-nb8.8, M6-g0 = vtt-nb8.17, M6-g1 = vtt-nb8.18, M6-g = vtt-nb8.9, M6-h = vtt-nb8.10, M6-i = vtt-nb8.11, M6-j = vtt-nb8.12, M6-k = vtt-nb8.13, M6-l = vtt-nb8.14, M6-m = vtt-nb8.15.

Edges (`bd dep add <dependent> <blocker>`), as recorded:

- M6-0 (vtt-nb8.2): vtt-1xv.5
- M6-a (vtt-nb8.3): vtt-1xv.11, vtt-1xv.7, vtt-3l6.21, M6-0 (vtt-nb8.2)
- M6-b (vtt-nb8.4): vtt-1xv.22, vtt-3l6.15, M6-0 (vtt-nb8.2)
- M6-b2 (vtt-nb8.16): vtt-1xv.13, vtt-1xv.22, vtt-3l6.20, vtt-5su.17, M6-0 (vtt-nb8.2), M6-b (vtt-nb8.4)
- M6-c (vtt-nb8.5): vtt-1xv.12, vtt-1xv.22, M6-0 (vtt-nb8.2)
- M6-d (vtt-nb8.6): —
- M6-e (vtt-nb8.7): vtt-1xv.27, vtt-3l6.11, vtt-3l6.16, vtt-3l6.21, vtt-3l6.4, M6-0 (vtt-nb8.2)
- M6-f (vtt-nb8.8): vtt-1xv.23, vtt-3l6.17
- M6-g0 (vtt-nb8.17): vtt-1xv.22, vtt-1xv.23, vtt-1xv.24, vtt-3l6.16, vtt-3l6.18, M6-0 (vtt-nb8.2)
- M6-g1 (vtt-nb8.18): vtt-1xv.20, vtt-1xv.23, vtt-3l6.10, M6-g0 (vtt-nb8.17)
- M6-g (vtt-nb8.9): vtt-1xv.18, M6-g0 (vtt-nb8.17), M6-g1 (vtt-nb8.18), M6-c (vtt-nb8.5), M6-d (vtt-nb8.6), M6-e (vtt-nb8.7)
- M6-h (vtt-nb8.10): M6-g0 (vtt-nb8.17), M6-g1 (vtt-nb8.18), M6-g (vtt-nb8.9)
- M6-i (vtt-nb8.11): M6-h (vtt-nb8.10), M6-g0 (vtt-nb8.17), M6-g1 (vtt-nb8.18), M6-a (vtt-nb8.3)
- M6-j (vtt-nb8.12): M6-i (vtt-nb8.11), M6-b2 (vtt-nb8.16), M6-g0 (vtt-nb8.17), M6-0 (vtt-nb8.2), M6-b (vtt-nb8.4), M6-d (vtt-nb8.6), M6-e (vtt-nb8.7), M6-f (vtt-nb8.8)
- M6-k (vtt-nb8.13): vtt-1xv.24, vtt-3l6.18, M6-j (vtt-nb8.12)
- M6-l (vtt-nb8.14): M6-k (vtt-nb8.13)
- M6-m (vtt-nb8.15): M6-l (vtt-nb8.14)

Total: 61 edges (30 cross-epic, 31 intra-epic), all recorded; `bd dep cycles` reports none; every bead's Depends-on line equals its recorded dependencies (script check). vtt-5su.17, vtt-3l6.4 and vtt-3l6.21 are closed (recorded for the record). M6-m also waits on every fix bead M6-l files.

Why each edge (real imports or post-merge file edits):
- M6-a edits `commands.ts` after vtt-1xv.7 and vtt-1xv.11, protocol `methods.ts` after vtt-1xv.11, and vtt-3l6.21's `writes.ts` (and its test where it pins `mine`).
- M6-b edits `serve.ts` after vtt-3l6.15 and vtt-1xv.22, root `package.json` after vtt-3l6.15; M6-b2 edits root `package.json` after M6-b and `mcp/server.ts`; its tests list `invoke` (vtt-1xv.13) and `import_asset` (vtt-3l6.20) in the composed process, read `stockedTableSnapshot` (vtt-1xv.22) and DESIGN §4.6 as amended by M6-0.
- M6-c edits `examples.ts` (vtt-1xv.22) and asserts with `faceElementVisible`/`action_states` (vtt-1xv.12).
- M6-e edits `CellRow.tsx` after vtt-3l6.11 and vtt-1xv.27; imports `uploadAsset` (vtt-3l6.16), the write path and notices (vtt-3l6.21), the session (vtt-3l6.4).
- M6-f edits `App.tsx`, `Toolbar.tsx`, `keybindings.ts` after vtt-1xv.23.
- M6-g0 fixes the step titles from §8.4 as amended (M6-0), edits `packages/ui/package.json` and the lockfile after vtt-1xv.24, and starts the vtt-1xv.23 app on the vtt-1xv.22 stocked table with the asset handler (vtt-3l6.16); copies patterns from vtt-3l6.18.
- M6-g1 implements M6-g0's `Gestures` against the app (vtt-1xv.23), the Log tab (vtt-1xv.20) and board commands (vtt-3l6.10).
- M6-g uses M6-g0, M6-g1, M6-c's records, M6-d's assets, M6-e's Upload… and the Face section (vtt-1xv.18); M6-h and M6-i import M6-g0, M6-g1 and their predecessors; M6-i's step 14 needs M6-a.
- M6-j's sync test imports `WALKTHROUGH_STEPS` (M6-g0) and `KEY_BINDINGS` (M6-f); its text quotes M6-b's and M6-b2's commands, M6-d's paths, M6-e's Upload… and the walkthrough (M6-i).
- Concurrency: `serve.ts` (M6-b), root `package.json` (M6-b, then M6-b2), `mcp/server.ts` (M6-b2), `commands.ts`/`undo.ts`/`methods.ts`/`writes.ts` (M6-a), `examples.ts` (M6-c), `CellRow.tsx` (M6-e), `App.tsx`/`Toolbar.tsx`/`keybindings.ts` (M6-f), `ui/package.json` and the walkthrough contract (M6-g0), `gestures.ts` (M6-g1), docs (M6-0 and M6-j, disjoint files).

**Waves** (M6 waits on M5's tail):

1. M6-d (now), M6-0 (after vtt-1xv.5).
2. M6-a (after vtt-1xv.11), M6-c (after vtt-1xv.22, .12), M6-b (after vtt-3l6.15, vtt-1xv.22), M6-e (after vtt-1xv.27).
3. M6-b2 (after M6-b, vtt-1xv.13, vtt-3l6.20), M6-f (after vtt-1xv.23).
4. M6-g0 (after vtt-1xv.24).
5. M6-g1.
6. M6-g.
7. M6-h.
8. M6-i.
9. M6-j.
10. M6-k (human).
11. M6-l (planning), then the fix beads it files.
12. M6-m (human).

**Critical path:** … vtt-1xv.23 → vtt-1xv.24 → M6-g0 → M6-g1 → M6-g → M6-h → M6-i → M6-j → M6-k → M6-l → fixes → M6-m.

---

## Review r1 changes

Review: /Users/tfg/Projects/vtt/.reviews/vtt-nb8-20261105T112534Z.md; dispositions: plan-m6-r1-dispositions.md (all 12 accepted). Applied 2026-11-05; pre-r1 bead texts in scratchpad/m6beads/orig/, applied texts in scratchpad/m6beads/r1/; pre-r1 plan in plan-m6.pre-r1.md.

1. Quick start creates the table: the launcher accepts a missing file and `mkdir -p`s its parent; `start-bin.test.ts` runs the quick-start command from a temp cwd with neither `tables/` nor the file (M6-b); README says `tables/` is created (M6-j).
2. Discard: `button Discard` added to the Attack and Damage faces (Apply narrowed to share the row; Area Save already had one) in M6-0 and M6-c; §8.4 step 14 presses it; M6-i asserts it drawn and enabled.
3. `save_bonus`: M6-c asserts `empty`, then `save_roll + save_bonus`, `passed`, `damage_dealt` and Apply all.
4. Build freshness: `dist/.inputs.json`, sha256 per file under `packages/{ui,schema,formula,protocol}/src` plus `packages/ui/index.html` and `vite.config.ts`; written after a successful build; tests for a dependency change, an added and a deleted input (M6-b).
5. Goblin identity: copies renamed G1–G8 through the inspector right after each drop; `PrepResult` records them; later steps use `byName`; the guide tells the user to do the same.
6. Goblin HIT badge: `tpl_token` gains `hit: false` and `value hit` shown when `hit` (M6-0, M6-c); M6-g types the formula, checks the badge with a d20 rolled onto the goblin template (`PREP_DICE` = one `1d20` 15), deletes the die, and asserts the copies carry the element.
7. Guide branches: dice-dependent expectations as rules over the user's rolls, miss recovery in steps 10 and 14, a "game went differently" field in the result line (M6-j, M6-k, M6-m).
8. Instructions validation: an explicit identifier → category map (tool, op, template, cell, field, rejection, exception) in M6-b2; the text now says "`as` set to `$copy`" so every backticked string is one identifier.
9. Undo docs: M6-0 also edits §4.8 ("Ctrl+Z stays `human`") and §7's "one of four targets".
10. Split: M6-g0 (vtt-nb8.17, "Walkthrough: driver contract") owns `driver.ts`, `steps.ts`, the dev dependencies and `driver.test.tsx` (focused checks including restart); M6-g keeps steps 1–6; M6-h and M6-i depend on both.
11. Split: M6-b (vtt-nb8.4) retitled "Startup: pnpm start, launcher, vtt-serve --open"; new M6-b2 (vtt-nb8.16, "MCP onboarding: pnpm mcp and MCP instructions") after it; M6-j depends on both.
12. Triage scope: dispositions for each friction/broken step, the overall why, free-text feedback and earlier checklist findings (M6-l); M6-m's follow-up pair inherits it.

Applied differently: the dispositions' filing line says "three new beads (10, 11)"; findings 10 and 11 each create one, so two were filed (vtt-nb8.16, vtt-nb8.17). With `--ui-dir` the launcher skips the build (a custom UI is served as given), which lets the quick-start test avoid building the real UI. Edges removed: vtt-nb8.4 → vtt-1xv.13, vtt-3l6.20, vtt-5su.17 (moved to M6-b2); vtt-nb8.9 → vtt-1xv.24, vtt-1xv.23, vtt-1xv.22, vtt-3l6.10, vtt-3l6.16, vtt-3l6.18 (moved to M6-g0).

## Review r2 changes

Review: /Users/tfg/Projects/vtt/.reviews/vtt-nb8-20261105T114102Z.md; dispositions: plan-m6-r2-dispositions.md (all 9 accepted as text fixes; final round). Applied 2026-11-05; pre-r2 bead texts in scratchpad/m6beads/orig/pre-r2/, applied texts in scratchpad/m6beads/r2/; pre-r2 plan in plan-m6.pre-r2.md.

1. Edge and titles: `vtt-nb8.17 → vtt-nb8.2` recorded; `WALKTHROUGH_STEPS` lists the fifteen titles verbatim in M6-g0.
2. Contract: M6-g0's `contract.ts` fixes `DriverContext` (app root, session, UI store, renderer, assertion client, file, `toScreen`/`toBoard`, `setCamera`, `frame`, `pickFile`, `upload`, `savedFile`, `byName`, `startAgent`, `restart`, `close`), the `Gestures` interface (with `bringIntoView`), `PrepResult` (characters with sheets, binders and Attack templates; map origin and scale; rooms with rects; G1–G8 and their dice; binder and Fireball ids) and `PlayAResult` (initiative, tray and strip, Aldric's binder, the working copy, G2's die, current HP); `infra.test.tsx` exercises every `DriverContext` facility; M6-g, M6-h and M6-i build local helpers only from these.
3. Split: M6-g0 (vtt-nb8.17) retitled "Walkthrough: driver infrastructure and contract"; new M6-g1 (vtt-nb8.18, "Walkthrough: UI gesture helpers") owns `gestures.ts` and its test, after M6-g0; M6-g, M6-h, M6-i depend on both.
4. Instructions test: `color`, `pattern`, `text`, `image` form an **appearance** category checked against DESIGN §4.6's Appearance cells table (M6-b2).
5. Step 5: two agent groups asserted separately, "Room 4: difficult terrain, hatched" and "Fireball for Aldric" (card plus sheet `spell_dc`) (M6-g).
6. Freshness: inputs add `pnpm-lock.yaml`, `tsconfig.base.json`, root and four package `package.json` files; the manifest records outputs, and a missing `dist/index.html` or recorded output is stale; tests for a lockfile change and a deleted bundle (M6-b).
7. Goblin as character: `inspectorFlags({character: true, template: true})` before copying; template and copies asserted `is_character` (M6-g); the guide says so (M6-j).
8. Miss instructions: on a miss Roll damage and Apply are not shown; recovery is Discard and retry; Apply drawn-but-disabled only after it has been applied (M6-j).
9. Initiative: the bonus is each sheet's `dex_save`; totals Corin 21, Aldric 15, Brenna 9, Dara 8 asserted (M6-h) and documented (M6-j); the tray stays the raw sum 46.

Applied differently: §8.4's steps have no titles, so "verbatim as they will read in §8.4" is met by fixing short titles in M6-g0's text (the guide uses them as headings) rather than quoting sentences. Edges removed: vtt-nb8.17 → vtt-1xv.20, vtt-3l6.10 (moved to M6-g1). The `createImageBitmap` stub now reports the uploaded PNG's real dimensions rather than a fixed 2400 × 1600, so the contract test can import any PNG.

## 4. Open questions (resolved)

All accepted as proposed on 2026-11-05 (plan-m6-decisions.md), with these notes: (1) human beads' Done-when is what the user posts, never closed by the orchestrator on its own; (2) M6-0 also edits §8.4 steps 2, 5, 10 and 11 (folded into row M6-D1); (3) Q5 is a new wire target `human` used by the UI's Ctrl+Z, `mine` unchanged, M4-D7 amended (row M6-D2); (4) Q6 stays a separate bead after vtt-1xv.22; (5) Q9: `pnpm start` rebuilds only a missing or stale UI build, `--no-build` skips, usage without a file; (6) Q13 accepted; (7) Q14: README and FIRST-SESSION.md are deliverables, and CLAUDE.md names them maintained docs; (8) 14 beads. The text below is the draft as decided; where a note changed it, the filed bead text in section 2 wins.

**Q1. Interpreting the epic: scripted walkthrough, playtest, fix loop.**
*Proposal:* (1) the scripted walkthrough is M6-g/h/i (all fifteen steps
through the real app in jsdom, Q2); (2) the real playtest is a human-gated
bead M6-k run by the user from docs/FIRST-SESSION.md; (3) "fix what is not
pleasant" is a planning-style triage bead M6-l that files fix beads under
vtt-nb8 (Codex-reviewed as a plan, two rounds at most), each blocking a
final human bead M6-m whose Done-when is the GM's "Felt good: yes"; a "not
yet" spawns another triage/playtest pair. The interpretation is posted as
a comment on vtt-nb8 when filing. *Alternative:* file only M6-0…M6-j now
and leave the playtest and its fixes to the epic's owner outside beads
(the epic then has no bead that carries its Done-when), or pre-file
speculative polish (grids, keyboard face buttons) now without playtest
evidence. No decision row (process; the epic comment records it).

**Q2. How the walkthrough is automated.** *Proposal:* real `<App>` in jsdom
with a recording renderer against an in-process authority on a temp file
(M4-D13), every step through UI gestures, except step 5's agent, which
calls the real MCP tools through `createMcpServer` + the SDK's
`InMemoryTransport` (adds the two MCP SDK packages, already pinned at 2.3.1
in the workspace, as `@vtt/ui` dev dependencies). Split into prep (1–6),
play A (7–11), play B (12–15), each test rerunning from scratch (90/120/180
s budgets). *Alternatives:* (a) the step-5 agent as a plain `agent`
`ProtocolClient` sending the same `transact`s (no new dev deps, but step 5
says "through the MCP server"; vtt-5su.13 already covers the stdio
binaries headless); (b) Playwright (rejected by M4-D13; needs a browser
download); (c) one walkthrough bead (too large for one agent: M5-z alone
was the largest M5 bead). No row (M4-D13 covers the approach); the dev
dependencies get a row only if the orchestrator wants D27's rule applied to
dev deps (M4 did: M4-D14) — then "M6-D8. `@modelcontextprotocol/client`
and `@modelcontextprotocol/server` 2.3.1 are dev dependencies of `@vtt/ui`
for the walkthrough's MCP agent."

**Q3. The walkthrough's reading of §8.4 where it leaves gestures open.**
*Proposal* (copied into M6-g/h/i and the guide):

| Step | Reading |
|---|---|
| 2 | The HIT badge is a `hit` cell plus a `value hit` face element with `show_when: "hit"`, added once to `tpl_character` through the gear and the Face section. Names are typed on the tokens; sheet values on the sheets (with Q6's header the sheet shows the token's name). |
| 3 | After creating Crypt, the GM binder is moved to Crypt with "Move selection to board…" so templates drop beside the map (G10). |
| 4 | The goblin starts as a copy of `tpl_token`; the d20 goes in by dropping the `tpl_d20` entry on the goblin's contents list (Q6); `owner` typed as `@id`. The template sits on Crypt; copies are dragged straight into rooms 3 and 5. |
| 5 | The agent gives Aldric a template copy of `tpl_area_save` (M5-D18 recipe) with `dc` replaced by 14; the GM corrects it to 15 in the inspector via the gear. |
| 6 | The note is made on Crypt and moved to the GM board; the scribble is three ink strokes. "Readable" = indented JSON naming "Room 4" and "Fireball". |
| 9 | The tray is a zone whose `text` is `=sum(contents(this).where(tag has "die").value)` (FORMULAS §10, typed; no template, Q15). "The tokens" in the strip are the four PCs. |
| 10, 12, 14 | Aldric's binder is dragged out of his token onto Crypt first (G11); Aldric's actions are pressed in view-as Aldric (actor Aldric, M5-D11). |
| 12 | Brenna steps into room 3 before the cast so the nudge can "miss the fighter". |
| 14 | The wrong-goblin Apply is a fresh working copy (the step-10 copy is discarded first); the delete is a Delete-key removal. |

*Alternative:* leave readings to the implementing agents (CLAUDE.md: an
ambiguous bead is defective), or change §8.4's text to match each reading
(heavier doc churn; only G1/G2/G7 contradict the text, the rest are gesture
choices). No row.

**Q4. Amend §8.4 where it contradicts itself (G1, G2, G7).** *Proposal:* the
three text edits of M6-0 section 1 (step 4 adds `dex_save`; step 7 reveals
room 1 by hand; step 14 adds a delete and its undo), row M6-D1.
*Alternatives:* (a) step 7: ship a map with an entrance area outside the
six rooms instead of revealing room 1 (then step 8's "into room 1" still
needs a reveal); (b) step 15: drop "deleted-then-restored goblin" instead of
adding a delete to step 14 (loses the check that undo of a removal survives
a reopen, which DESIGN §4.1 Removal promises); (c) G7: make Fireball rows
tolerate a missing `dex_save` (`save_bonus = if(target.dex_save = empty, 0,
…)` still reads `#NAME` for an absent cell, so this needs `tpl_token` to
carry the cell anyway).

**Q5. Ctrl+Z after a button pressed in view-as (G3).** *Proposal:* on `ui`
and `test` connections `undo mine` selects the latest group by `gm` or any
character (new store selector `human`; wire unchanged; M6-a), row M6-D2.
In v1 the GM is the only person and drives every character; multiplayer
(vtt-y1w.9) will need per-participant actors anyway. *Alternatives:* (a)
the UI computes the target from the log window and sends `undo {type:
"group", index, expect_index}` (UI-only, but duplicates candidate and
barrier logic and needs the log subscription loaded); (b) revert M5-D11 so
view-as presses commit as `gm` (the log loses "Aldric: Apply"); (c) keep
both and tell the user to undo character groups from the log panel (step
14 then fails as written for a view-as attack).

**Q6. Example template amendments (G4–G8).** *Proposal:* M6-c applies five
record changes (M6-0 section 2): `tpl_token` gains `attack_bonus`,
`dex_save` (empty) and a collapsed contents list; an owned `tpl_sheet`
shows its owner in its header (`value owner` with `show_when`); Apply
buttons on Attack, Damage and Area Save stay drawn once their roll exists
(`show_when` on the roll, the guard disables them after use and shows the
reason), row M6-D3. Done post-merge on vtt-1xv.22's `examples.ts` because
vtt-1xv.5 (which holds the records) is in progress. *Alternatives:* (a)
amend vtt-1xv.5 and vtt-1xv.22 now so M5 ships the fixed records (cheaper
code, but .5 is mid-flight; amending a running bead's payload risks a
mismatch); (b) leave the templates and have the walkthrough and guide use
workarounds (Inspector "Take out" for the die, typing names twice, a
`dex_save` cell added by hand, Apply that vanishes; step 10's "says why"
stays unmet).

**Q7. Putting an image on a token (G9).** *Proposal:* an "Upload…" button on
the inspector's `image` row (M6-e), row M6-D4. *Alternatives:* (a)
dropping an OS image file onto an object sets its `image` (more natural,
but needs `BoardCanvas` file-drop handling and a hit test; a Polish
followup); (b) none: the guide tells the user to import with the image tool
and copy the path from that object's `image` cell into the token's (works
today, poor first impression).

**Q8. Cross-board friction (G10, G11).** *Proposal:* no new feature before
the playtest; the walkthrough and guide move the GM binder to Crypt and drag
Aldric's binder out onto Crypt (Q3); the playtest decides whether a
cross-board gesture is needed, and triage (M6-l) files it. *Alternative:*
add a bead now: dropping a selection on a board tab moves it there (and a
template drag dropped on a tab spawns there), which removes three "Move
selection to board…" detours from the guide.

**Q9. One command to serve and open.** *Proposal:* root script `pnpm start
<file>` = build the UI, then `vtt-serve <file> --open`; `--open` uses
`$BROWSER` else `open`/`xdg-open`, logs and continues on failure; no
default file (README uses `tables/crypt.table.json`, `/tables/` gitignored);
the UI is rebuilt on every start (a few seconds; never stale), row M6-D5.
*Alternatives:* (a) build only when `packages/ui/dist` is missing (faster,
can serve a stale UI after a pull); (b) a default table path when none is
given; (c) a separate launcher script (`scripts/start.ts`) instead of a
flag on `vtt-serve` (keeps the authority free of browser logic, but two
entry points).

**Q10. Attaching the user's agent.** *Proposal:* root script `pnpm mcp`;
docs give `pnpm --silent --dir <repo> mcp` (works from any cwd; `--silent`
keeps pnpm's banner off the stdio stream; discovery finds the running
authority); no checked-in `.mcp.json` (it would attach every coding agent
working in this repo to a table); the MCP server sends `instructions`
(M6-b, text inline), row M6-D6. *Alternatives:* (a) check in `.mcp.json`
(one-click for Claude Code users of this repo, at the cost above); (b) no
instructions (the agent reads DESIGN on its own; step 5 then depends on
the agent's diligence); (c) an MCP prompt `first_session` in addition.

**Q11. Example content.** *Proposal:* ship a generated crypt map (2400 ×
1600 px, six numbered rooms with the geometry in M6-d) and a goblin image in
`@vtt/fixtures/assets`, used by the walkthrough and the guide, row M6-D7.
No prepped example table (the epic asks to run prep). *Alternatives:* (a)
the user brings any map (the guide cannot name rooms; the walkthrough still
needs a PNG); (b) also ship a prepped table produced by the walkthrough so
play can start immediately (useful for repeat playtests; a followup).

**Q12. Polish promotions.** *Proposal:* promote vtt-qf5.17 (keyboard
help) as M6-f, extended with gestures (G15); leave vtt-qf5.14 (grids and
snapping), vtt-qf5.26 (keyboard face buttons), vtt-qf5.27 (pen colours),
vtt-qf5.28 (list layouts) and vtt-y1w.18 (DOM binder panel) for triage to
promote on evidence. Edit vtt-qf5.28's text: M5 (review r2) already made
contents elements scroll, so it keeps only grid and fan layouts.
*Alternative:* no promotion (the guide and README list the gestures), or
also promote vtt-qf5.14 now (battlemap play usually wants a grid).

**Q13. Defects found by the walkthrough beads.** *Proposal:* the walkthrough
beads never change product code; a step that fails because of a product
defect goes back to the orchestrator with the failing gesture, who files a
fix bead under vtt-nb8 that blocks the walkthrough bead (as M5-q treats a
bad template record). *Alternative:* allow the walkthrough agent to fix
defects of at most ~30 lines in the failing module with a regression test
(faster, but blurs exclusive-file ownership and Codex review scope).

**Q14. First-user docs.** *Proposal:* README gains a quick start, agent
hookup and key table; a new docs/FIRST-SESSION.md is the playtest guide
(steps mirror `WALKTHROUGH_STEPS`, enforced by a sync test); neither is an
MCP resource. *Alternative:* put the guide in README (long), or make it an
MCP resource so the agent can follow along (the agent only acts in step 5).

**Q15. Dice tray template.** *Proposal:* none; step 9 says "draw", and the
guide gives the formula (FORMULAS §10). *Alternative:* add `tpl_dice_tray`
(a zone with the `text` formula) to the GM binder (a §8.1 list change and a
row).

**Q16. Bead count.** *Proposal:* 14 beads (11 implementation incl. docs, 2
human, 1 planning), at the top of the preferred range. *Alternative
merges:* M6-e into M6-c (different packages; no), M6-f dropped (Q12
alternative), M6-h and M6-i merged (one 15-minute-plus test, oversized).

---

## 5. Followups (filed)

Filed 2026-11-05 under vtt-qf5 (P3), dependencies recorded: vtt-qf5.33 UI: drop an image file onto an object to set its image (on vtt-nb8.7); vtt-qf5.34 Examples: a prepped first-session table for repeat playtests (on vtt-nb8.11); vtt-qf5.35 UI: drop a drag on a board tab to move or copy there (on vtt-3l6.10, vtt-1xv.23). vtt-qf5.28 retitled "UI: grid or fan layouts in contents elements" and rewritten (scrolling removed). vtt-qf5.17 superseded by vtt-nb8.8 (closed by `bd supersede`). Comments posted on vtt-nb8 (Done-when interpretation), vtt-3l6.18 and vtt-1xv.24 (post manual-checklist results on vtt-nb8), vtt-qf5.28 and vtt-qf5.17.

Original list:

- Polish (vtt-qf5): dropping an OS image file onto an object sets its
  `image` (Q7 a); a prepped example table generated from the walkthrough
  for repeat playtests (Q11 b); drop on a board tab moves or spawns there
  (Q8 alternative, if triage does not take it first).
- Edit vtt-qf5.28 (scrolling done in M5; keep grid and fan) (Q12).
- Re-parent and rewrite vtt-qf5.17 as M6-f (Q12).
- Comments: vtt-nb8 (the Q1 interpretation; the walkthrough readings of
  Q3); vtt-3l6.18 and vtt-1xv.24 (their manual checklists can be run any
  time; results go on vtt-nb8 for M6-l).
- Performance: none filed; DESIGN §7 sets no numeric target. If the
  playtest reports lag, triage considers vtt-qf5.9, vtt-qf5.10, vtt-qf5.25.

---

## Proposed amendments to open M4/M5 beads

None required. Optional, if the orchestrator prefers Q6 (a): amend
vtt-1xv.5 section 4 and vtt-1xv.22 with the M6-0 record changes and drop
M6-c (vtt-1xv.5 is in progress, so this needs the implementing agent's
branch updated). Also optional: vtt-1xv.24's manual checklist could point
at docs/FIRST-SESSION.md once it exists (it closes earlier, so no).

---

## Contradictions and underspecification found

1. §8.4 step 15 checks "the deleted-then-restored goblin", but no step
   deletes one (G1) → Q4.
2. §8.4 step 7 "Only the entrance room is uncovered" vs. step 3 "six opaque
   zones … each `visible_to = gm`" and step 8 revealing only room 3 (G2) →
   Q4.
3. §8.4 step 10 "Pressing Apply again does nothing and says why" vs. the
   Attack card face's `show_when: "not applied"` on Apply (vtt-1xv.5 §3,
   FIXTURES §9) (G4) → Q6. The fixture face keeps the M5 behaviour.
4. Step 14's Ctrl+Z (`mine`, M4-D7) vs. view-as presses committing as the
   character (M5-D11) (G3) → Q5.
5. Step 4's goblin cell list lacks `dex_save`, which Fireball rows read
   (`#NAME` for an absent cell, FORMULAS §2.1) (G7) → Q4, Q6.
6. Step 2 "Fill in name … by typing into the sheet faces": `name` is
   per-object and literal only, so the sheet cannot name its character (G8)
   → Q6.
7. Step 11 needs the goblin's die on the canvas; M5's default contents list
   is only for faceless objects and `tpl_token` has a face (G5); step 4's
   "owned attack d20" has no containment gesture for a template drag (G6)
   → Q6.
8. Step 4 "image" has no UI path into a token's `image` cell (G9) → Q7.
9. Steps 9, 12, 13 assume templates drop beside the map, but the GM binder
   lives on the GM board and there is no cross-board drag (DESIGN §4.6)
   (G10); step 10 and 12's binder lives inside a 1-unit token (G11) → Q3,
   Q8.
10. Step 5 "a Fireball card for Aldric with DC 14": `tpl_area_save` has
    `dc = caster.spell_dc`, and step 2 never fills `spell_dc`; whether the
    agent writes the card or the sheet is open → Q3 (card, replaced).
11. Step 9 "Line the tokens up in a strip zone" would pull the fighter out
    of room 3 before step 12's "miss the fighter" → Q3 (Brenna steps back).
12. The epic Done-when ("the GM says it felt good") is subjective and the
    orchestrator cannot run a browser → Q1 (human beads).
13. vtt-3l6.15 lists "a combined launcher script" as out of scope and no
    later bead owns it → M6-b.
14. vtt-qf5.28's text asks for contents scrolling, which M5 review r2 already
    added (vtt-1xv.14/.16) → Q12.
15. vtt-qf5.17 depends on vtt-3l6.17 only, but M5 adds keys (L, D, W) in
    vtt-1xv.23 → M6-f depends on vtt-1xv.23.
16. CLAUDE.md says not to create documentation unless requested; the epic's
    first-user aim needs README and a guide → Q14 (the orchestrator's
    acceptance is the request).
17. DESIGN §7 promises responsiveness "on a table of a few thousand
    objects" without a number; the first session has ~60 objects, so M6
    does not test performance → followups note.
