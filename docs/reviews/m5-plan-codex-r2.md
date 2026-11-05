1. **vtt-1xv.14, .15, .16, .22 — blocker: overflowing binder entries become unreachable.**  
   Contents rows beyond the element’s bottom become an `overflow` count, but no scrolling, paging, or overflow interaction is specified. Expanding a working copy can also push subsequent entries out of reach. This undermines the stocked binder and ordinary binder use in DESIGN §4.7.  
   **Change:** specify viewer-local scrolling or another navigation mechanism, including hit testing and clipping. Require tests that reach the last stocked template and operate an expanded card near the bottom.

2. **vtt-1xv.5, .17, .25 — blocker: giving a shared template produces an ordinary instance.**  
   The prescribed drop performs `spawn`, whose root has `is_template: false` under DESIGN §4.1. The recipient therefore receives a playable instance, not a reusable binder template; expanding it will not create working copies.  
   **Change:** distinguish “give a template” from ordinary instance copying. For the former, atomically spawn and mark the new root as a template using a binding. Test that the recipient can create and discard working copies while retaining the received template.

3. **vtt-1xv.14, .15 — blocker: nested objects lack a complete rendering contract.**  
   Board objects retain M4’s base drawing, but an expanded contained object is represented only by a nested `FaceDrawing`. That structure has no shape/fill/back representation, and the default-face rules only *add* ink, buttons, and contents. No bead owns reproducing the child’s ordinary image/text/shape drawing or enforcing its face-down back.  
   **Change:** define a complete nested-object drawing representation, with base appearance and face-down behavior. Specify accumulated transforms for rendering, hit testing, clipping, and `min_size`. Test an expanded faceless note, an image token, and a face-down card inside a rotated container.

4. **vtt-1xv.16 — blocker: default actions bypass the template prohibition.**  
   Button presses and inspector Run explicitly refuse templates, but the body double-click branch invokes any enabled `default_action`. A board template with `default_action: "Roll"` can therefore be mutated by play, contrary to M5-D12.  
   **Change:** enforce the template check in the common UI invocation path, covering buttons, double-clicks, and inspector Run. Add a double-click test asserting no request, dice consumption, or revision change.

5. **vtt-1xv.5, .7 — should-fix: historical face views need their own wire schema.**  
   `.7` declares snapshot faces as `FaceLayout | null`, while character snapshots and effects must contain filtered elements with stored `index` fields. Those indices are not part of `FaceLayout`; reusing the strict storage schema rejects them, while a loose schema without declared indices strips them.  
   **Change:** define a separate historical face-view type/schema in `.7`, explicitly preserving indices without adding live `shown` state. Require round-trip tests through the actual protocol result parser.

6. **vtt-1xv.7 — should-fix: the removal acceptance criterion conflicts with current visibility.**  
   The bead expects a remove effect to carry a filtered face for Aldric. PROTOCOL §7.6 says nonexistent objects are invisible at the current revision, so immediately after removal that object’s snapshot is omitted from character group views.  
   **Change:** require lossless removal snapshots for the GM, omission for Aldric immediately after removal, and correctly filtered historical snapshots after undo restores visibility.

7. **vtt-1xv.15, .16, .18, .21 — should-fix: integration-test dependencies are missing.**  
   `.16` requires assertions about faces actually drawn and updated, but does not depend on `.15`’s face renderer. `.18` explicitly tests data drops while the ink tool is active, but does not depend on `.21`, which supplies that tool. These beads can start before their test prerequisites exist.  
   **Change:** record `.16 → .15` and `.18 → .21`, or explicitly replace those tests with contract doubles and assign the real integration cases to `.23`. Do not leave the implementing agent to choose.

8. **vtt-1xv.8, .9 — should-fix: the executor extension interface is incomplete and invites circular initialization.**  
   `.8` names `registerStepHandler(kind, handler)` without defining the handler signature or access to expression evaluation, primitive counting, created IDs, and refusal mapping. `.9` must register at module load while being imported by `invoke.ts`, creating a circular initialization risk.  
   **Change:** make `.8` publish a typed handler context and outcome contract. Have `.9` export handlers that an explicit composition function installs, rather than self-registering through an import cycle. Test placement actions through both direct and protocol entry points.

9. **vtt-1xv.17 — should-fix: working-copy reuse and continuation rules are incomplete.**  
   Reusing an existing copy only expands it, although the documented behavior also selects it. Multiple matching copies have no selection rule. The spawn continuation checks only the board, whereas the surrounding interaction contract also protects against viewer changes.  
   **Change:** specify a deterministic match, such as the first matching entry in contents order; select and expand it. Require both board and viewer continuity for selection/expansion continuations, with tests for reuse, multiple matches, and a pending spawn across a viewer switch.

10. **vtt-1xv.5, .22 — should-fix: the supposedly exact example-template specification is still abbreviated.**  
    `.22` requires templates “exactly” as `.5` specifies, but most faces lack rectangles and several listed cells lack initial values. For example, “face image, name and hp badge with `min_size`” supplies neither layout nor threshold. The generic Area Save flow also needs an explicit caster-initialization path. Independent agents must invent decisions that the bead claims are already fixed.  
    **Change:** have `.5` publish complete template records or explicitly identify which defaults and layouts `.22` may choose. Include actor/reference initialization and require the stocked-table flow to work without undisclosed setup edits.

11. **vtt-1xv.10, .12, .13 — should-fix: direct `face_element` expectations do not match protocol visibility.**  
    `.10` checks `show_when`, cell readability, and action existence, but does not explicitly require the object itself to be visible. A button or contents element on an invisible object could pass directly while being absent from the protocol view.  
    **Change:** use the same visibility predicate as live face views, preferably through a shared authority helper. Add parity cases for invisible objects, covered objects, unreadable cells, and nonexistent actions. If `.10` consumes `.12`’s implementation, record that dependency.

12. **vtt-1xv.24 — should-fix: the fixed acceptance matrix leaves board navigation ambiguous.**  
    The driver is told to switch to “the step’s board (Fireball’s `map`)”, but invokes have no board field. In the actual Fireball fixture, `aldric_binder` is on `shelf`; `fb1` and its save rows remain inside it while the deployed zone is on `map`. Those button clicks require the shelf.  
    **Change:** specify navigation by the invoked object’s outermost container’s board, and destination-board navigation for moves, or add an explicit board column. Test the Fireball transitions without relocating fixture objects or bypassing clicks.

13. **vtt-1xv.14, .18 — should-fix: these beads remain oversized for independent review.**  
    `.14` combines recursive layout, default presentation, expansion state, scene augmentation, culling bounds, hit testing, and shared gesture contracts. `.18` combines layout transformations, a canvas tool, a substantial inspector editor, and cross-surface drag/drop. Each contains independently reviewable behavior with different failure modes.  
    **Change:** split `.14` into contracts/state/layout and scene/hit-testing beads; split `.18` into pure operations plus FaceSection, and canvas layout/drop integration. Assign exact files and serialize consumers through explicit dependencies.

**Overall verdict: not ready to implement.** Resolve binder reachability, reusable template distribution, nested rendering, and the default-action bypass first. Then tighten the wire/executor contracts, record the missing dependencies, and split the two large UI beads. These are implementation prerequisites, not polish.