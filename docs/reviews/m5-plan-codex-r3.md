1. **vtt-1xv.14, .15, .26 — blocker — Collapsed faces have no complete rendering path.**  
   `.14` defines collapsed layouts, but `.15` draws an entry’s `drawing` only “when expanded.” Neither specifies drawing the collapsed layout—or even the default name—for an ordinary collapsed entry. The stocked binder could pass the listed tests while displaying chevrons and gears without usable headings.  
   **Change:** Require `.14` to resolve each visible entry using its full or collapsed list, and `.15` to draw both. Specify corresponding hit testing in `.26`. Add tests for default collapsed names and a custom collapsed face containing values and a button.

2. **vtt-1xv.14, .25, .26 — blocker — Pointer hits are insufficient to resolve contents drops.**  
   `.26` returns a `contents` hit only when no row is hit. `.25` inserts only on a `contents` hit; an entry hit falls through to placement on the board. Consequently, dropping onto a populated list generally does not insert into that container. Expanded rows introduce another ambiguity: the pointer might identify a child value or button while still being over the parent’s contents element.  
   **Change:** Define a separate drop-target resolver, or include the enclosing contents path and insertion index in hit results. State precedence explicitly: editor reference drop, then eligible containing contents element, then board placement. Test dropping over collapsed rows, expanded rows, and a completely occupied list.

3. **vtt-1xv.14, .16, .17, .26 — should-fix — Nested hits lose context required by scrolling and expansion.**  
   `chevron` hits carry only an entry id, but `.16` needs the container and element for `revealOffset`. Button/editor hits inside expanded entries likewise omit their enclosing contents elements, although wheel events over those regions should scroll the list before zooming the camera.  
   **Change:** Add an ancestor path containing container id, element index, list identity, and transforms to `FaceHit`. Specify which ancestor receives wheel scrolling. Test scrolling while the pointer is over a nested button and expanding a row inside two nested containers.

4. **vtt-1xv.16, .25, .24 — blocker — Clicking a contained entry has no selection behavior.**  
   `.25` claims pointer-down on every entry but defines effects only after the drag threshold. `.16` delegates unclaimed entry input to M4’s select tool, whose scene contains board objects, not contained entries. Neither bead owns selecting the child on a click. This blocks `.24`’s instruction to select contained edit targets by clicking, and ordinary inspector editing of binder entries.  
   **Change:** Assign entry-click selection to `.25`: pointer-up below the threshold selects the entry without writing; dragging follows the existing rules. Specify how expanded child bodies behave and add an integration test that selects a contained object and edits it in the inspector.

5. **vtt-1xv.27, .14, .26 — should-fix — Cell-drop coordinates cross incompatible frames.**  
   `.18` defines `addCellElement(..., point)` as taking an **object-local** point. `.27` passes the drop point obtained from canvas hit testing without specifying conversion; that point is in board coordinates. The error becomes substantial for translated or rotated objects. Contained targets need the accumulated nesting transform too.  
   **Change:** Require inverse transformation before calling `addCellElement`, and expose the needed transform through the hit contract. Either explicitly support contained targets or restrict this bead to board objects. Test a translated, rotated target rather than only an origin-aligned token.

6. **vtt-1xv.12, .10, .13 — should-fix — Visibility semantics and parity tests contradict one another.**  
   `.12` requires GM views to retain hidden elements with `shown: false`, but its parity tests equate `faceElementVisible` with **presence** in the view. Its predicate also rejects nonexistent-action buttons for every viewer, whereas the preceding view specification applies that filtering to characters. These are observably different contracts.  
   **Change:** Define the predicate as “an element with this stored index exists in the resulting view and has `shown === true`,” and explicitly settle nonexistent-action behavior for GM views. Make both fixture runners use that exact definition. Test retained-but-hidden GM elements separately from omitted character elements.

7. **vtt-1xv.5, .7, .11 — should-fix — The new advertised protocol limits have no implementation owner.**  
   `.5` promises `max_each_items`, `max_action_writes`, and `max_face_elements`, but no implementation bead assigns changes to [`version.ts`](/Users/tfg/Projects/vtt/packages/protocol/src/version.ts) or the welcome-message `LimitsSchema` in [`messages.ts`](/Users/tfg/Projects/vtt/packages/protocol/src/messages.ts). Runtime enforcement alone does not fulfill that wire contract.  
   **Change:** Give one bead ownership of all three advertised limits and their schemas/tests. Add a welcome-message round-trip test asserting their values; downstream enforcement should use the agreed constants where package boundaries permit.

8. **vtt-1xv.14, .16, .17 — should-fix — “Scroll the whole expanded row into view” is impossible for oversized entries.**  
   Expanded rows derive their height from the child’s full drawing, while contents rectangles have fixed heights. A character’s binder or sheet can easily be taller than its enclosing viewport. `.14` defines `revealOffset` as revealing the whole row, and downstream beads require that outcome without defining the oversized case.  
   **Change:** Specify deterministic behavior: reveal the entire row when it fits; otherwise align its top or another explicitly chosen anchor. Require scrolling to reach the remaining content, and test an expanded sheet taller than its parent contents viewport.

9. **vtt-1xv.20 — should-fix — Log paging needs a stable range/cursor rule under visibility changes.**  
   The bead refetches a page using its original `before` and `limit`, calling that “the page’s range.” However, [`logPage`](/Users/tfg/Projects/vtt/packages/authority/src/protocol/queries.ts:357) limits **visible returned groups**, so revealing groups can shift page boundaries and leave gaps between independently refreshed pages. Also, an entirely filtered log window has no “oldest index” from which to load older visible history.  
   **Change:** Define pagination independently of the currently displayed groups. For example, rebuild the loaded page chain from a fixed upper boundary after invalidation, deriving each subsequent cursor from the refreshed predecessor. Specify the initial cursor for an empty filtered window. Test both newly revealed groups crossing a page boundary and older visible history behind an empty window.

10. **vtt-1xv.5, .22 — should-fix — The stocked-table acceptance flow is under-specified.**  
    `.22` requires the Area Save flow “with no other setup edits,” but the stocked character’s sheet has `spell_dc: empty`, and the test does not specify dice outcomes or expected damage/pass results. Likewise, the Attack flow uses blank combat statistics. These flows can execute while proving very little about the example formulas.  
    **Change:** List permitted preparation edits and exact scripted results: set the character’s relevant sheet statistics, configure two target tokens, deploy the zone, and assert target order, save outcomes, damage increments, and recursive Discard. Keep the stored template records unchanged; distinguish user preparation from fixture repair.

11. **vtt-1xv.7 — should-fix — This remains oversized and mixes independently reviewable changes.**  
    It owns face storage, validation, persistence, replay, undo, conflicts, protocol operations, historical visibility filtering, an action-view rename, action refusals, UI rejection messages, and MCP snapshots. The separate action changes make its already broad face work harder to review and unnecessarily block the executor behind historical-face work.  
    **Change:** Extract action rejection variants, fixture mapping, rejection messages, and the action-definition rename into a prerequisite bead. Keep face persistence and protocol work together if needed for exhaustive switches. Record both file-sharing dependencies explicitly, then let `.8` depend on the smaller action-contract bead.

**Overall verdict: not ready to implement.** Fix the collapsed rendering, contents-drop, and contained-selection blockers first. Then reconcile the hit/visibility contracts and assign the missing protocol-limit work. The numbered fixes above should be reflected in bead text and acceptance tests before separate agents begin.

I reviewed the supplied dependency records; `bd prime` could not load persistent Beads context because the read-only sandbox prevented opening the database lock. No files or beads were changed.