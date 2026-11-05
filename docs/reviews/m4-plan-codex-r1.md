1. **vtt-3l6.4, .7, .9, .11, .13 — blocker: edits do not preserve their base revision.**  
   `write(ops, {label?})` has no way to receive the revision on which an edit began. If another client changes a cell while an editor or drag is open, using the latest session revision at submission silently overwrites that change. This defeats DESIGN §5.2 and PROTOCOL §6.  
   **Change:** add an explicit `baseRevision` to writes and write effects. Capture it when editing or dragging begins and retain it through submission and recovery. Test a concurrent write arriving *before* the user commits, with the UI already having processed that event.

2. **vtt-3l6.4, .6–.9, .13, .17 — blocker: the shared interaction contract cannot express its consumers’ requirements.**  
   `.7` provides no effects for notices, tool changes, image picking/uploading, or selecting a returned creation ID. `UiStore.tool` is a string, while `.8` needs tool options. `BoardCanvas` has no file-drop callback; the machine’s event union omits double-click; creation previews and handle overlays have no specified representation. `.13` consumes `.7`’s edit effect without depending on it. These agents must invent incompatible interfaces or edit one another’s exclusive files.  
   **Change:** introduce an early interaction-contract bead specifying events, tool state/options, previews, overlay variants, asynchronous effects and write-result continuations. Make all consumers depend on it, and explicitly assign the hook that connects edit effects to the in-place editor.

3. **vtt-3l6.4, .12 — blocker: view-as can reuse GM information.**  
   The selection subscription’s viewer and replacement lifecycle are unspecified; `objectView` falls back to it. `.12` explicitly labels contents from the GM directory, which can reveal a hidden `name` even when the referenced object is visible. Its zones cache is keyed only by revision, so switching viewers without a commit can reuse GM results. This violates DESIGN §4.4’s presentation filtering.  
   **Change:** bind selection mirrors to the current viewer, invalidate them on switches, use viewer-filtered `refLabel` throughout character presentation, and key query caches by viewer, board and revision. Reject late responses from previous viewers. Test hidden names and viewer switches at an unchanged revision.

4. **vtt-3l6.5, .6, .17 — blocker: overlays are explicitly drawn above opaque covers.**  
   `.6` requires and tests covers followed by selection/highlight overlays, contradicting DESIGN §4.4’s cover-above-everything rule. Even an object whose anchor is outside fog can have an outline extending into it. Retained previews or DOM editors introduce further paths around the cover.  
   **Change:** draw object-related overlays before covers, or clip them against covers; define equivalent handling for DOM editors and previews. Replace the ordering test with one proving no object presentation appears through a cover.

5. **vtt-3l6.7, .10, .18 — blocker: the acceptance script requires an undefined cross-board drag.**  
   `.18` says to drag the goblin template from the GM board onto Crypt. The select tool drops only onto the active board, and board tabs define neither drag-hover activation nor drop handling.  
   **Change:** either implement and test cross-board dragging, or rewrite acceptance to spawn copies on the GM board, use the existing “Move selection here” command, and position them on Crypt. The manual checklist must use the same supported workflow.

6. **vtt-3l6.5, .8, .9 — should-fix: map images make zones effectively unselectable.**  
   Hit testing always prefers a non-zone over a zone, regardless of relative z. The imported dungeon map is a non-zone covering every room, so clicking any room selects the map instead of its zone. The promised fog editing and resize workflow lacks a reliable selection gesture.  
   **Change:** specify an alternate-selection gesture, zone-edit mode, or object list that can select zones beneath/above map images. Test selecting and resizing a room zone over an imported map.

7. **vtt-3l6.3, .13 — should-fix: `toInputText` promises an impossible round trip and mishandles overridden formulas.**  
   `CellView` contains evaluated results, not every stored literal: a dangling reference is already `#REF`. Rolls, shapes and ink have no input grammar. Numbers formatted by `String` may use exponent notation, which the grammar rejects. For an overridden formula, `.3` emits `=source`, but `.13` uses that to prefill an in-place literal editor; an unchanged blur could submit `set_formula` instead of preserving the override.  
   **Change:** separate formula-source editing from literal/override editing. Return an explicit unsupported state for values without editable syntax, specify decimal serialization, and prevent unchanged editors from writing. Narrow the round-trip promise and add overridden-formula and unsupported-value tests.

8. **vtt-3l6.2, .3, .11, .13 — should-fix: formula-entry rules contradict each other and DESIGN §4.6.**  
   The existing design says the formula bar is the only place formulas are typed, while `.11` explicitly accepts formulas inline. `.2` does not remove that restriction. `.3` also places leading-`=` handling before its `name` exception, despite requiring `name =x` to remain text.  
   **Change:** have `.2` explicitly resolve the formula-entry policy, then align all editors. State `name` handling before formula recognition. Correct the `0d6` rationale too: FORMULAS §3.2 says it lexes as dice but violates a semantic limit.

9. **vtt-3l6.11, .12 — should-fix: cell metadata editing is incomplete and overlaps specialized controls.**  
   DESIGN §4.4 permits visibility metadata on absent cells, but `.11` only exposes existing cell rows. It also generically edits structural values with `set_value`, although shape and protected placement/containment fields require dedicated primitives; `.12` owns separate tag and contents controls.  
   **Change:** specify a structural-cell capability matrix: generic editable, dedicated control, or read-only. Add a way to inspect, set and clear visibility for absent cell names. Clarify whether structural rows delegate tag/contents editing or merely display them.

10. **vtt-3l6.11–.13 — should-fix: dependency-tracing event ownership is missing.**  
    `.12` must react to hovering rows owned by `.11` and the formula bar owned by `.13`, but neither component specifies callbacks or shared hover state for cells. `.12` and `.13` can run concurrently.  
    **Change:** define a shared cell-hover/focus interface before these components run. Assign subscription setup, cleanup, request cancellation and highlight precedence to one owner. Add tests for leaving a row before its explanation returns and switching between formula and zone highlights.

11. **vtt-3l6.4, .10 — should-fix: live board deletion is confused with failed resubscription.**  
    `.4` relies on the active board subscription becoming `failed`. PROTOCOL §8 specifies terminal failure during resubscription; ordinary board removal arrives through commit events containing the board list. No fallback is specified when the final empty board is removed.  
    **Change:** detect active-board removal from the current board list, switch to a remaining board, and define the zero-board state. Test deletion while continuously connected, deletion during disconnection, and removal of the last board.

12. **vtt-3l6.14, .15 — should-fix: the Vite asset proxy can fail the Host check.**  
    `.14` accepts only the authority’s host and port. `.15` specifies a proxy target but not rewriting `Host`; forwarding `localhost:5173` will be rejected with 421. Its tests inspect injection rather than exercise the proxy.  
    **Change:** explicitly require `changeOrigin: true` or equivalent authority-Host rewriting. Add a real Vite proxy upload/download test against the guarded authority.

13. **vtt-3l6.4, .17 — should-fix: restart acceptance contradicts explicit-credential recovery.**  
    The UI uses the injected token as explicit credentials. PROTOCOL §2 rotates that token on an ordinary authority restart and makes unauthorized reconnect terminal. `.17` nevertheless expects restarting on the same port to clear the banner automatically.  
    **Change:** distinguish a same-token transport-recovery test from a normal restart test. The latter should show the terminal state and offer page reload to obtain a new bootstrap token.

14. **vtt-3l6.18 — should-fix: acceptance permits incomplete prep data.**  
    The PCs never receive the `pc` tag used by the re-hiding formula. “Owned Sheet” is not accompanied by an explicit `owner` write, although containment does not set ownership. The attack d20 only needs an owner and modifier, so it can lack the `d20` tag, value and total needed by the HIT formula. Six covers and no goblins do not detect these omissions.  
    **Change:** specify the owner writes and functional die cells/tag, add `pc` to the character template, and assert that a PC entering and leaving a formula-driven room reveals and re-hides it. Assert a die’s total drives HIT; rolling actions can remain deferred to M5.

15. **vtt-3l6.4, .7 — should-fix: these beads are oversized foundational integration tasks.**  
    `.4` combines bootstrap, mirror lifecycle, recovery, writes, notices, React hooks, local state and shared test infrastructure. `.7` combines the tool framework, selection, navigation, movement, containment, spawning, keyboard commands and React execution. Their dependents need different portions, while their broad exclusive ownership makes interface repairs expensive.  
    **Change:** split `.4` into session/mirror lifecycle and write/state integration; split `.7` into the shared interaction framework and select/move behavior. Give each independently testable Done-when criteria and use the framework split to resolve finding 2.

16. **vtt-3l6.2, .6 — should-fix: render caching is deferred without updating the cited requirement.**  
    DESIGN §7 explicitly includes per-object render caching. `.6` excludes it as Polish, but the sole docs bead does not amend that requirement. Thus implementation can satisfy the bead while contradicting its Implements section.  
    **Change:** either include caching or explicitly document its deferral in `.2`, with a tracked follow-up and a clear statement of what M4’s renderer delivers.

**Overall verdict: not ready to implement.** Resolve the base-revision, interaction-contract, viewer-isolation, cover-ordering and cross-board acceptance blockers first. Then reconcile the editor contracts and remaining acceptance gaps before dispatching independent agents.