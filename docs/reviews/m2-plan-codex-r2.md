1. **vtt-75c.12 — blocker: missing function-library dependency.**  
   Its acceptance tests require `max`, `sum`, `len`, and `where`, but its dependencies do not transitively require **vtt-o9i.7**. The M1 engine deliberately excludes that dependency. This bead can therefore start with those functions unavailable. **Change:** add `vtt-75c.12 → vtt-o9i.7`.

2. **vtt-75c.2 / vtt-o9i.10 — should-fix: concurrent ownership of fixture schema and tests.**  
   Both edit `packages/fixtures/src/schema.ts` and `test/format.test.ts`, without an ordering edge. Simply making `.2` depend on `vtt-o9i.10` would introduce a cycle through M1 queries → M2 geometry → M2 schema → `.2`. **Change:** extract M1’s `#SYNTAX` fixture extension into an early bead, then make `.2` depend on it; alternatively, assign both additive extensions to one early owner.

3. **vtt-75c.4 / .5 — blocker: historical inverses cannot all be represented.**  
   `.5` requires `invertForRewind(retire)` to remove IDs from `retired_ids`, but `.4` only defines an additive `retire` effect. No declared effect represents its inverse. The round-trip criterion cannot be implemented through the specified `applyEffect` contract without inventing another representation. **Change:** define an internal historical-inverse type and application API, or replace retirement with an effect carrying reversible before/after state. Explicitly distinguish that representation from persisted user-undo effects.

4. **vtt-75c.3 / .5 / .6 / .14 — blocker: board identity falls outside lifetime reservation.**  
   IDs must be unique across boards and objects, but `isReserved` is described as live-object-or-retired, and `addBoard` records only a board effect. Adding a board, undoing its creation, then reusing its ID is not prevented. Generated object IDs can also collide with board IDs unless agents independently broaden the rule. **Change:** define reservation across both namespaces, include board creation in allocation and undo retirement, and test board/object collisions plus reuse after undo. Also specify the actual `Board` type in `.3`.

5. **vtt-75c.3 — should-fix: canonical validation leaves structural representations ambiguous.**  
   The schema allows arbitrary cell names but does not explicitly reject stored `cells.id`, `cells.contents`, `cells.container`, or other field-backed structural names. It also does not state that overrides require formula content or that structural overrides receive structural type validation. A file could therefore contain contradictory representations or an invalid position override. **Change:** enumerate forbidden stored-cell names, require object-map keys to equal object IDs, define override invariants, and add negative validation tests for each.

6. **vtt-75c.14 — should-fix: rename protection and visibility collisions are underspecified.**  
   `renameCell` says “delete plus create,” but protection must apply to both names: renaming a user cell to `shape` or `container` must not bypass protected writes. Separately, the destination can have visibility metadata even when its cell is absent; moving the source metadata then has an undefined collision policy. **Change:** explicitly reject structural rename endpoints and define whether destination metadata causes refusal or is replaced. Test both cases.

7. **vtt-75c.6 / .13 — should-fix: formula-valued spawn initializers lack a clear contract.**  
   FIXTURES §6 allows initial formulas, including the character die’s `modifier`. `.6` says it uses `writeValue` for initial cells, although that primitive accepts values, not formula content. Its later “cell primitives” wording leaves the agent to choose. The M2 scenario prefix stops before the character-die spawn, so acceptance can miss this. **Change:** type `initialCells` as cell content, explicitly dispatch formulas to `setFormula`, and test a formula initializer that replaces copied content and recomputes after commit.

8. **vtt-75c.15 — blocker: buffering range-specific integers does not provide transactional randomness.**  
   After an aborted d20 roll, a subsequent d6 roll would reuse an integer drawn for `1..20`. It may be invalid, and it will not generally match a control run. The specified test repeats the same roll/shuffle sequence, hiding this problem. **Change:** buffer range-independent random draws and map them to each requested range, or use an RNG with snapshot/restore state. Test aborted and subsequent operations with different dice sizes and shuffle lengths.

9. **vtt-75c.5 / .15 / .13 — should-fix: unexpected exceptions have no defined outcome.**  
   `store.transact` promises a rejection-only failure result while also aborting on “any throw.” `.15` deliberately throws `ScenarioError` for bad scripts. The plan does not say whether these errors propagate, become `invalid`, or get swallowed as expected refusals. **Change:** catch `Rejected` into the rejection result, abort and rethrow other errors, and reset dice in either pre-commit failure case. Add tests proving scenario errors remain scenario errors and listener errors do not reset committed dice.

10. **vtt-75c.5 / .12 / .15 — should-fix: transaction change information is not exposed to its consumers.**  
    `.12` needs `changedCells(effect, docBefore)` after commit, but the listener contract supplies no before-state. `.15` needs to distinguish created objects, written cells, and move-derived changes, but the transaction API promises no change-query interface. Comparing final values also cannot distinguish an explicit same-value write from an untouched cell. **Change:** have `.5` expose a documented transaction change summary and a commit payload containing sufficient before-state or precomputed changes. Require `.12` and `.15` to consume that interface.

11. **vtt-75c.5 / .12 — should-fix: post-commit listener ordering can expose stale evaluation.**  
    `.12` invalidates the engine through an ordinary `onCommit` listener, while promising invalidation “before any read.” A listener registered before `Table.fromStore` can read the new document with the old formula cache. **Change:** distinguish mandatory internal synchronization from public notifications, or make table reads synchronize against store revision. Test an observer registered before table construction.

12. **vtt-75c.10 / .12 — should-fix: fail-closed visibility covers only `visible_to`.**  
    DESIGN §4.4 says visibility errors fail closed. The planned face-down check only restricts cells when `face_up` is exactly false; an error or invalid result can consequently expose them. Error-valued `opaque` or cover geometry also has no stated policy. **Change:** document and test error handling for every evaluated visibility input, including face-up state and opaque-cover geometry, with a conservative visibility result.

13. **vtt-75c.4 / .5 / .11 — should-fix: persisted history lacks relational validation.**  
    Strict schemas alone do not establish contiguous absolute indices, revision continuity, valid undo targets, or compatible `kind`/`undoes` fields. `History.restore` can therefore accept history that makes `nextIndex`, undo selection, and replay disagree. Snapshot hashing does not validate the log. **Change:** assign history validation to one bead, define its invariants—including exceptions for history retained behind a hand-edit barrier—and require load-error tests for malformed histories.

14. **vtt-75c.11 — should-fix: asset checking is assigned to an API without filesystem context.**  
    `parseTable(text)` must warn about missing assets, but it has neither a directory nor filesystem access. Relative paths cannot be resolved there, and the proposed serialization signatures also leave conversion of absolute paths ambiguous. **Change:** keep parsing pure, define `assets` as already-relative paths, and assign existence checks to `loadTable(path, fs)`.

15. **vtt-75c.5 / .11 — should-fix: these beads contain multiple independently reviewable subsystems.**  
    `.5` combines effect algebra, conflict keys, change reporting, history/compaction, transactions, replay, and comparison. `.11` combines encoding, migrations, history restoration, atomic filesystem behavior, assets, and epic acceptance. Their broad acceptance lists make contract mistakes expensive to isolate. **Change:** split `.5` into effect/change contracts, history, and transactional store/replay; split `.11` into serialization/load/migration and atomic I/O/epic acceptance. Give each exclusive files and explicit dependencies.

**Overall verdict: not ready to implement.** Resolve the blockers first, then tighten the validation, transaction, and error contracts and split the infrastructure beads. Those changes should precede parallel implementation.

The M2 review uses the supplied bead text. Cross-milestone checks use the checked-in M1 export because `bd prime` could not open Dolt under the read-only sandbox; verify those M1 edges against live Beads before editing the plan.