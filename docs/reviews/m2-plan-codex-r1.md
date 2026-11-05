1. **vtt-75c.2, .3, .4, .7 — blocker: the dependency graph does not enforce “docs first.”**  
   `.3` can run before `.2`, although its defaults and invariants depend on those decisions; `.4` inherits that problem. Also, `.4` and `.7` can concurrently edit `packages/schema/src/index.ts`.  
   **Change:** make `.3` depend on `.2`, and serialize shared export-file edits or assign them to one integration bead. Coordinate `.2` with M1’s documentation edits explicitly; the exported M1 plan also assigns edits to FORMULAS.md and DESIGN.md.

2. **vtt-75c.3, .5, .10, .13 — blocker: structural-cell visibility has no defined storage representation.**  
   FIXTURES §3 permits visibility on `tag`, `contents`, `container`, and other field-backed or derived cells. The proposed object stores visibility only inside `Cell`, which requires content. There is no specified representation for visibility on these cells without introducing duplicate or fictitious content.  
   **Change:** define canonical metadata storage independent of cell content, including absent structural cells. Specify its validation, mutation effects, spawn remapping, undo, serialization, and fixture conversion. Add a round-trip test for private `contents` and `tag`.

3. **vtt-75c.2, .4–.6, .8 — blocker: identity bookkeeping is underspecified and undo can violate “never reused.”**  
   The `seq` effect contains only numeric before/after values but claims to cover `retired_ids` too. Create/remove effects do not specify retirement transitions. Reversing allocation counters and removing spawned copies can make their IDs available again after undo. Selectively undoing an older allocation must also preserve later allocations.  
   **Change:** define explicit allocation and retirement effects, distinguish historical rewind from user undo, and preserve lifetime ID reservation after undoing creation. Test spawn → undo → spawn, explicit-ID creation after undo, and selective undo with later allocations. Amend the “exact snapshot restoration” criteria where monotonic identity bookkeeping intentionally differs.

4. **vtt-75c.5, .6, .8, .12 — blocker: create/remove effects omit the external parent’s `contents` key.**  
   `touchedKeys` gives create/remove only `obj:<id>` keys. Creating or removing a child also changes its surviving parent’s contents. Consequently, undo can overlook a conflicting reorder or sibling insertion, and the formula adapter can leave `parent.contents` dependents cached. An invariant check will not catch an incorrect but valid ordering.  
   **Change:** include the external container’s `contents` key for both effects and specify all derived changes. Test parent formula invalidation and undo conflicts involving spawn/remove followed by reorder or sibling insertion.

5. **vtt-75c.5, .8, .11 — blocker: the shared store/history API is incomplete.**  
   `.5` exposes `log` as an array, while `.8` expects `log.undo_barrier` and `.11` needs `first_index`, retained-history restoration, and compaction. `.8` also needs to record inverse effects and `undoes`, neither of which the transaction contract exposes. Separate agents must invent incompatible extensions or edit the same store files.  
   **Change:** have the store bead own a complete history abstraction and explicit APIs for restoring history, recording effects, committing undo metadata, and compacting. Downstream beads should consume those APIs.

6. **vtt-75c.8, .13 — should-fix: replay’s revision contract contradicts its acceptance criteria.**  
   Replay only applies effects, none of which updates `Snapshot.revision`, yet `.8` requires exact snapshot equality and `.13` compares replay directly with `toSnapshot()`. `.2` explicitly excludes revision from replay expectations.  
   **Change:** specify whether replay/rewind restore revision from group metadata, and use a shared stored-state comparison that excludes revision for fixture replay. Test nonzero starting revisions and no-effect groups.

7. **vtt-75c.11 — blocker: the external-edit undo barrier is wrong after compaction.**  
   Setting `undo_barrier` to log length confuses retained-array length with stable group indices. With retained groups 100–109, a barrier of 10 permits undoing all pre-edit groups.  
   **Change:** use the next absolute group index, with defined behavior for an empty retained log. Test compact → save → hand-edit → load, then verify old groups are blocked and newly committed groups remain undoable.

8. **vtt-75c.7, .9 — blocker: footprint-only indexing is not conservative for anchor queries.**  
   Polygon coordinates need not surround the anchor. An object can have its anchor inside a zone while its entire footprint lies outside the zone’s bounds; `.9` would omit it from `contents(zone)`. Exact geometry also admits points within epsilon of boundaries, while candidate bounds have no specified tolerance expansion.  
   **Change:** index the union of footprint bounds and the anchor, or maintain separate anchor and footprint indexes. Expand query/index bounds consistently with exact-test tolerances. Add an offset-polygon example and epsilon-boundary tests against brute-force anchor membership.

9. **vtt-75c.2, .7 — should-fix: the geometry contract contains contradictory definitions.**  
   `dx² + dy² <= r² + eps` does not implement a tolerance of `eps` board units; the tolerance varies with radius. “Positive-area overlap” also conflicts with the explicit point-footprint exception.  
   **Change:** use a distance-consistent circle tolerance, explicitly document point-versus-shape overlap as an exception, and define near-tangent behavior consistently. Test very small and large circles, plus concave polygon overlap—not only point membership.

10. **vtt-75c.2, .10 — blocker: empty visibility fails open.**  
    `.2` says any non-viewers value hides an object, consistent with DESIGN §4.4’s fail-closed rule. `.10` instead turns an empty evaluated value into `all`. A formula returning `empty` can therefore reveal an object.  
    **Change:** distinguish an absent cell, which receives the default, from a present cell evaluating to `empty`, an error, or another wrong type, which admits nobody. Add explicit tests for each case.

11. **vtt-75c.12 — blocker: ActionContext does not define correct reads for newly created or removed objects.**  
    A spawned object’s copied literal cells fall through to `table.value`, where the object does not yet exist. Conversely, checking earlier writes before removal can return a value from an object already removed in the transaction. The contract also leaves structural field writes and copied overrides unclear.  
    **Change:** define transaction-local existence first, then reads of new objects’ literal/overridden/structural cells, then existing-object writes, then start-of-action values. Specify how query and existence methods complete M1’s `EvalEnv` contract. Test copied literals, copied overrides, move-derived cells, and write → remove → read.

12. **vtt-75c.12 — should-fix: RandomDiceSource rollback lacks an implementation contract and acceptance test.**  
    An arbitrary injected RNG cannot generally be rewound, but `mark/reset` promises transactional consumption for both dice-source implementations. Seeded determinism alone does not verify rollback.  
    **Change:** require a rewindable RNG or buffer generated randomness with a resettable cursor. Test that an aborted roll and shuffle leave subsequent randomness identical to a control run without the aborted transaction.

13. **vtt-75c.3, .5, .12 — should-fix: formula-valued names have no coherent lookup and logging policy.**  
    `name` may hold a formula, but the store must capture names without evaluation and `DocumentHost.objectsNamed` must provide exact-name lookup without a defined evaluated-name mechanism. Removed objects also have no live name “at commit time.”  
    **Change:** either make names literal-only through an explicit documented decision, or define evaluated lookup, dependency invalidation, and historical-name capture. Specify that removal captures the name before deletion. Test rename, removal, and whichever formula-name policy is chosen.

14. **vtt-75c.11 — should-fix: the atomic-save failure guarantee is impossible as written.**  
    If rename succeeds and directory fsync then fails, the original file has already been replaced. The promise that *any* failure leaves the original untouched cannot hold for this algorithm.  
    **Change:** distinguish failures before replacement from durability failures after replacement. Require an intact old file before rename and an intact new file afterward, with an accurate error result. Fault-test both stages separately.

15. **vtt-75c.5 — should-fix: transaction ordering and commit failure boundaries are undefined.**  
    Two transactions can begin from the same revision and later commit working copies; no rule prevents lost updates. Also, “abort on any throw” is ambiguous if a commit listener throws after state and history have been published. M3’s stale-client policy does not resolve these internal store issues.  
    **Change:** enforce one active transaction or reject a commit whose base revision is no longer current. Define the commit point and listener-error handling so a committed operation cannot be reported as an aborted transaction. Add focused tests.

16. **vtt-75c.5, .12 — should-fix: these beads combine independently reviewable subsystems.**  
    `.5` owns the store, transactions, every effect interpreter/inverse, conflict keys, cell edits, field edits, reordering, and board edits. `.12` combines host integration, cache invalidation, cover geometry, action reads, randomness, and M1 test-host migration. Their current breadth makes contract mistakes hard to isolate.  
    **Change:** split `.5` into effect/history infrastructure and store/edit primitives. Split `.12` into host/recompute/visibility integration and action-context/dice support. Give each split explicit file ownership and acceptance tests; make the runner depend on both.

**Verdict: not ready to implement.** Resolve the schema, effect/history, identity, spatial-index, visibility, and action-read blockers first, then record the dependency and ownership changes. The plan has substantial acceptance coverage, but several current criteria permit mutually incompatible implementations.

The review used the supplied M2 bead text and repository docs. Beads storage was unavailable under the read-only sandbox; supplementary M1 contracts were inspected from the passive export.