1. **vtt-nb8.17, vtt-nb8.2 — blocker: missing dependency on the amended walkthrough.**  
   `.17` must derive `WALKTHROUGH_STEPS` titles from §8.4 **as amended by `.2`**, but does not depend on `.2`. It can finish with the old titles, which `.12` must then reproduce alongside the amended text.  
   **Change:** record `.17 → .2` and specify the fifteen titles explicitly to remove ambiguity about “first clause.”

2. **vtt-nb8.17, vtt-nb8.9–.11 — blocker: the shared driver contract leaves required capabilities unspecified.**  
   `.9` owns local helpers for image import, uploads, ink and Face-section editing, but `.17` does not specify access to the rendered app, file inputs, camera/coordinate conversion or saved file. The consumers also need defined `PrepResult` and `PlayAResult` shapes, including the map origin and working-copy identities. Because consumers cannot edit the driver, these omissions become blocking handoffs between isolated agents.  
   **Change:** specify the exported context and result interfaces, including the facilities local helpers may use, saved-file access, and how gestures bring offscreen or clipped elements into view. Include contract tests for those facilities.

3. **vtt-nb8.17 — should-fix: the driver bead remains oversized.**  
   It combines authority/file lifecycle, restart and authentication, MCP lifecycle, canvas gestures, nested face interactions, inspector editing, log pagination and package changes. Its acceptance suite effectively builds another broad UI integration suite before the walkthrough can begin.  
   **Change:** split lifecycle/MCP infrastructure from UI gesture helpers, with separate owned files and an explicit dependency. Keep the public interfaces fixed before implementing either.

4. **vtt-nb8.16 — blocker: the instructions test requires a nonexistent template cell.**  
   The prescribed identifier map categorizes `pattern` as a cell that must exist in `stockedTableSnapshot()`. DESIGN §4.7’s records contain no `pattern` cell, and `.5` does not add one. DESIGN §4.6 explicitly permits appearance cells without defaults.  
   **Change:** distinguish documented appearance-cell names from cells present in example records. Validate `pattern` against the appearance contract rather than requiring an unrelated template amendment.

5. **vtt-nb8.9 — blocker: the agent-group assertion contradicts the scripted transactions.**  
   Step 5 sends two transactions: “Room 4: difficult terrain, hatched” and “Fireball for Aldric.” Done-when requires the room changes in an agent group, then says `spell_dc` comes “from that group,” although it belongs to the second transaction.  
   **Change:** assert two separately identified groups with the same agent actor. Require the room changes in the first, and Fireball creation plus `spell_dc` in the second.

6. **vtt-nb8.4 — should-fix: build freshness can incorrectly accept stale or incomplete output.**  
   The hash excludes dependency manifests and `pnpm-lock.yaml`, so dependency upgrades can leave the old bundle marked fresh. An intact `.inputs.json` also marks the build fresh when `dist/index.html` or a generated bundle has been deleted. This undermines the promised missing-or-stale rebuild behavior.  
   **Change:** include dependency/build configuration inputs and verify the required output files exist. Add acceptance cases for a lockfile change and missing output with an unchanged manifest.

7. **vtt-nb8.9, vtt-nb8.12 — should-fix: the goblin ownership setup contradicts the named model.**  
   The goblin is a `tpl_token` copy marked only as a template, yet its die’s `owner` points to it. FORMULAS §3.1 and DESIGN §4.4 define owners as characters; FIXTURES §9 explicitly makes the goblin a character for this scenario.  
   **Change:** mark the goblin template as a character before copying it, and assert that its copies retain the flag. Include this gesture in the guide.

8. **vtt-nb8.12 — should-fix: the miss instructions describe hidden buttons as disabled.**  
   On an Attack miss, `Roll damage` is hidden by `show_when: "hit and dmg = empty"`. Under `.5`, Apply is hidden until damage exists. The guide instead says both remain disabled, so correct behavior can be reported as broken.  
   **Change:** describe these buttons as absent on a miss, retain the Discard-and-retry recovery, and reserve the visible-but-disabled Apply expectation for an already-applied attack.

9. **vtt-nb8.10, vtt-nb8.12 — should-fix: initiative omits the sheet bonuses required by §8.4.**  
   The script orders characters by raw rolls, and the guide explicitly teaches that rule. DESIGN §8.4 step 9 requires adding bonuses by eye from the sheets. Using the supplied Dex values gives Corin 21, Aldric 15, Brenna 9 and Dara 8; the order happens to remain unchanged, masking the omission.  
   **Change:** explicitly identify the sheet value used as the initiative bonus and assert/document the adjusted totals. Keep the tray sum as the sum of raw dice.

**Overall verdict: not ready to implement.** Resolve the blockers first, particularly the driver handoff contract and impossible acceptance assertions. Fix the startup and guide discrepancies before dispatching those beads. File ownership is otherwise largely separated, and the human playtest–triage loop provides a clear path to the epic’s completion criterion.