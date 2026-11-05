1. **vtt-nb8.4, vtt-nb8.12 — blocker: quick start cannot create a table.**  
   `parseStartArgs` requires the file to exist, while DESIGN §7, PROTOCOL §2, and the README require a missing file to create a new table. Also, ignoring `/tables/` does not create that directory; the existing host requires the parent directory to exist. **Change:** accept a missing table file, specify who creates its parent directory, and test the exact quick-start command with neither directory nor file present.

2. **vtt-nb8.2, vtt-nb8.5, vtt-nb8.11 — blocker: step 14 presses a nonexistent Discard button.**  
   The stock Attack card defines a Discard action, but its face contains only Roll, Roll damage, and Apply. DESIGN §4.6 adds automatic action buttons only to objects without a face. Neither template amendment adds Discard. **Change:** add a Discard face element in both the documentation and template beads, with a UI acceptance assertion; alternatively, explicitly replace this gesture with selecting and deleting the working copy.

3. **vtt-nb8.5 — should-fix: the required `save_bonus` result contradicts formula semantics.**  
   With `dex_save: empty`, `save_bonus = target.dex_save` evaluates to `empty`, not numeric zero. FORMULAS §2.1 says empty becomes zero only in arithmetic. **Change:** assert `save_bonus` is `empty`, then verify that `save_roll + save_bonus`, the pass decision, and applied damage behave correctly. Do not change the evaluator or template to satisfy the incorrect assertion.

4. **vtt-nb8.4 — should-fix: build freshness misses bundled workspace sources.**  
   The check watches only UI sources and two UI files. CLAUDE.md specifies source-level workspace imports; the UI already imports runtime code from schema, protocol, and formula. Changes there can leave `pnpm start` serving an obsolete bundle. Deleting a source file is also undetectable by the proposed newest-mtime check. **Change:** define freshness over the actual build inputs, including workspace dependencies and relevant configuration, using a recorded input manifest or fingerprint. Add coverage for dependency changes and deleted inputs.

5. **vtt-nb8.9–vtt-nb8.12 — should-fix: goblin identity is ambiguous.**  
   The driver promises to recover IDs by name, but the eight copies and their template are all named “Goblin.” Subsequent beads require stable G1–G8 identities and associate particular rolls with them. **Change:** explicitly rename copies G1–G8 through UI gestures, or define an unambiguous lookup using board positions and template relationships. Specify that mapping in `PrepResult` and preserve it in the guide.

6. **vtt-nb8.9 — should-fix: the goblin’s HIT formula never becomes a visible badge.**  
   The character setup adds both the formula and a face element. The goblin setup adds only the formula, and `tpl_token` has an explicit face without `value hit`. Consequently, its “HIT badge” cannot appear. **Change:** add the goblin face element before spawning copies and assert that copies retain it and display it when the formula is true.

7. **vtt-nb8.12, vtt-nb8.13, vtt-nb8.15 — should-fix: the human guide needs branches for real rolls.**  
   “Same names and numbers, dice results excepted” does not make the scripted sequence executable with random dice. An attack can miss, disabling Roll damage and Apply; fixed initiative ordering and damage expectations can also become wrong. **Change:** specify recovery for misses in steps 10 and 14, derive initiative and damage expectations from actual rolls, and distinguish a legitimate game outcome from a broken interaction.

8. **vtt-nb8.4 — should-fix: the instructions-validation test rejects the prescribed instructions.**  
   The allowed categories for backticked identifiers omit identifiers present in the verbatim string: `as`, `base_revision`, and `stale_write` are neither tools, operation types, template IDs, template cells, nor the listed exceptions. **Change:** validate identifiers by explicit category, including protocol fields and rejection names, or replace the generic backtick scan with targeted checks.

9. **vtt-nb8.2 — should-fix: the undo amendment leaves contradictory maintained documentation.**  
   DESIGN §4.8 explicitly says “Ctrl+Z stays `mine`,” but the bead changes only the undo description in §7. Section 7 also still introduces “three targets” after adding a fourth. **Change:** include §4.8 in the bead’s scope, change its Ctrl+Z reference to `human`, and update the target-count wording.

10. **vtt-nb8.9 — should-fix: shared driver construction and the entire preparation scenario are too much for one bead.**  
    This bead builds gesture helpers, rendering integration, authority and MCP lifecycles, restart handling, and six substantial scenario steps. Its successors must import the driver unchanged, yet its Done-when only exercises preparation; restart and several play helpers can remain unverified. **Change:** split out a driver-contract bead with explicit helper interfaces and focused acceptance checks, including restart. Make preparation depend on it, followed by play A and play B.

11. **vtt-nb8.4 — should-fix: startup and MCP onboarding are independently reviewable scopes bundled together.**  
    Browser process management, launcher signal handling, build freshness, MCP initialization instructions, and stdio transport tests have separate failure modes and mostly separate files. **Change:** split launcher/browser work from MCP onboarding. Assign root `package.json` to one bead and order the other behind it if both must edit scripts; make the guide depend on both.

12. **vtt-nb8.14, vtt-nb8.15 — should-fix: triage can ignore the reason the milestone failed.**  
    Triage requires dispositions only for per-step friction/broken lines. A user can mark every step “ok” but report `Felt good: not yet` because the overall workflow is exhausting or slow. Repeating the same triage shape can leave that feedback unaddressed indefinitely. **Change:** require dispositions for the overall “why,” unstructured feedback, and any supplied earlier-checklist findings, as well as individual step results.

**Verdict: not ready to implement.** Fix the startup and missing-button blockers, correct the contradictory acceptance criteria, make the walkthrough identities and human branches explicit, and split the shared driver and startup/MCP work before dispatching agents.