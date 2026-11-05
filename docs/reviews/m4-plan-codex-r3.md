1. **vtt-3l6.8, vtt-3l6.23 — blocker: contradictory upload cancellation rules.**  
   `.8` requires switching boards during an upload to create the image on the original board without changing selection or tool. `.23` explicitly cancels that interaction, drops the uploaded result, and tests that nothing is created. Its later “current interaction whose board is no longer active” branch cannot handle a board switch under that rule.  
   **Change:** choose one policy and align both beads’ lifecycle rules and tests. To preserve `.8`, distinguish cancelling an unfinished gesture from allowing an already-started upload to finish on its stamped board.

2. **vtt-3l6.22, vtt-3l6.23, vtt-3l6.17 — blocker: the runtime cannot obtain all its required inputs through the specified contracts.**  
   `ReducerInput` requires `views(id)`, but neither `ToolContext` nor `UiStore` supplies it. The runtime must observe session board changes, but receives only getter functions, with no session subscription. The hook receives `scene` and `viewport`, but no explicit contract delivers these to the runtime or supplies viewport dimensions to navigation. Separate agents must invent these connections.  
   **Change:** define a complete snapshot/update interface, including object views, scene, viewport, and board/viewer changes. Specify who feeds it and when cancellation occurs. Make the composition test exercise a real tool that reads an object view, rather than only a stub.

3. **vtt-3l6.2, vtt-3l6.3, vtt-3l6.11 — should-fix: “Replace formula with value” cannot work on structural formula cells.**  
   `replaceFormulaOps` emits `delete_cell` followed by `set_value`. The existing store rejects deletion of every structural cell, including `visible_to`, `position`, and `rotation`. Consequently, a room’s visibility formula cannot be removed using the promised command. An override does not remove the formula.  
   **Change:** add an explicit, invariant-preserving operation for replacing stored formula content with a literal, with protocol/store coverage and dependencies; alternatively, explicitly restrict the command and revise the promise. Test replacement of both a user formula and a `visible_to` formula.

4. **vtt-3l6.3, vtt-3l6.11, vtt-3l6.13 — should-fix: formatting support is being used as editing permission.**  
   `writable` exists only on an `unsupported` result. Protected cells such as `board`, `container`, and `contents` can produce supported reference/list text, so the formula bar’s rules offer editing even though the inspector matrix declares them read-only or delegated.  
   **Change:** define cell editing capabilities independently of value serialization, including literal writes, formulas, replacement, and dedicated controls. Apply the same capabilities in every editor. Test focusing protected structural rows in the formula bar.

5. **vtt-3l6.2, vtt-3l6.3, vtt-3l6.11, vtt-3l6.13 — should-fix: unchanged-input detection discards valid text edits.**  
   The grammar preserves otherwise-unrecognized text verbatim, but `isUnchangedInput` trims every cell except `name`. Changing a user text cell from `hello` to ` hello ` therefore writes nothing despite changing its parsed value.  
   **Change:** compare parsed content, or preserve exact comparison whenever either input is verbatim text. Add tests for leading/trailing spaces and newlines in ordinary text cells, while allowing insignificant whitespace in numeric/formula syntax.

6. **vtt-3l6.11 — should-fix: cell-name validation excludes names supported by the model.**  
   Add-cell and visibility-rule controls require identifier syntax. FORMULAS §3/§3.2 explicitly supports non-identifier cell names through backticks, and the existing store accepts them. The UI therefore cannot create or fully manage legal cells such as `Max HP`.  
   **Change:** validate against the canonical cell-name rules rather than the formula identifier grammar. Test creation, rename, visibility metadata, and formula references for a non-identifier name.

7. **vtt-3l6.2, vtt-3l6.7 — should-fix: template drag semantics differ between the decision and implementation.**  
   The decision says Alt-drag moves a template. `.7` decides at drop time, and only spawns when exactly one object is dragged. Releasing Alt during a drag can unexpectedly spawn; dragging a selection containing templates silently moves them without Alt.  
   **Change:** capture copy-versus-move intent at drag start, separately from Alt-drop containment intent. Specify mixed/multiple-template selection behavior—spawn each, or explicitly refuse it—and test modifier changes during the gesture.

8. **vtt-3l6.2, vtt-3l6.13 — should-fix: the DOM editor’s cover check is weaker than the promised rendering rule.**  
   `.2` says the editor never appears over a cover. `.13` tests only the object’s anchor. A large object can have an uncovered anchor while its editor rectangle overlaps a covered room. Also, an already-open GM editor is not explicitly cancelled when entering view-as.  
   **Change:** prohibit or clip editor bounds intersecting covers, and cancel without committing on viewer changes. Test partial overlap and switching to a character while an editor is open.

9. **vtt-3l6.16, vtt-3l6.4 — should-fix: missing dependency for the UI asset test.**  
   `.16` requires testing `uploadAsset` against an in-process authority from the UI package, but `.4` installs that package’s `@vtt/authority` dev dependency. `.16` can currently run before `.4`; the checked-in UI package does not have that dependency.  
   **Change:** record `.16 → .4`, or move shared dependency installation into an earlier prerequisite. Do not let `.16` independently edit the same manifest and lockfile.

10. **vtt-3l6.24, vtt-3l6.11 — should-fix: tracing integration requires an unrecorded sibling dependency.**  
    `.24` promises an integration test that hovers the goblin’s actual cell row, but the row and its hover wiring belong to `.11`, which can run concurrently. A synthetic hover fixture could pass without verifying the promised connection.  
    **Change:** record `.24 → .11` and explicitly use `CellList`/`CellRow` in that test. Add dependencies on other component owners only where their actual components are tested.

11. **vtt-3l6.10, vtt-3l6.17, vtt-3l6.21 — should-fix: camera persistence lacks an explicit composition owner and adequate acceptance criteria.**  
    `.10` defines camera storage and initial fitting; `.21` owns camera state; `.17` composes the application. No bead clearly owns connecting board/session changes to saving and restoring the live camera. `.10` can pass its remount test with a working storage helper that the app never uses.  
    **Change:** assign the connection to one bead and name its API. Require an application test that pans board A, switches to B, then returns to A with its camera restored; also test first-visit fitting after board data arrives.

12. **vtt-3l6.9, vtt-3l6.11, vtt-3l6.12 — should-fix: shape editing has no entry point for shapeless objects or changing shape kind.**  
    Handles operate only on an existing shape. Both inspector locations make shape read-only, and creation tools only create new objects. Thus an existing shapeless object cannot acquire a shape, nor can an existing circle become a rectangle or have its shape removed, although `set_shape` supports these operations.  
    **Change:** assign a shape control to one inspector bead, using `set_shape` for add/change/remove and retaining handles for geometric adjustment. Include undo and preservation of the object’s other cells.

13. **vtt-3l6.16 — should-fix: split persistence changes from asset transport.**  
    This bead combines a substantial change to save/coalescing/autosave/close semantics with filesystem import, HTTP authentication and serving, and browser upload helpers. The persistence change is independently consequential and reviewable.  
    **Change:** extract asset-generation save bookkeeping into a prerequisite bead owning `table-host.ts` and its race/failure tests. Make asset import/HTTP depend on it. Explicitly retain the existing rule that `saved_not_durable` does not mark the captured state saved.

14. **vtt-3l6.17, vtt-3l6.21 — nit: notice expiration has overlapping ownership.**  
    `.21` owns expiry with an injectable clock; `.17` also specifies auto-dismiss behavior. The descriptions additionally differ between “non-sticky info” and “others” expiring.  
    **Change:** make `.21` the sole owner of stickiness and expiration, and `.17` presentation plus explicit dismissal. State one policy for error notices.

**Overall verdict: not ready to implement.** Resolve the contradictory upload lifecycle and incomplete runtime contract first. Then fix structural formula replacement, shared editing rules, the missing dependency edges, and the uncovered integration requirements. Split the persistence work before assigning concurrent implementation agents.