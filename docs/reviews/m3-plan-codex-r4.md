1. **vtt-5su.2, vtt-5su.18 — blocker: stale-lock takeover does not guarantee exclusive ownership.**  
   A and B can both read the stale lock; A renames it and creates its live lock; B then renames **A’s new lock** and successfully creates another. Both believe they own the table. The prescribed test only exercises B’s rename before A recreates the path. Treating unreadable content as stale also lets B steal A’s lock between exclusive creation and writing its metadata.  
   **Change:** replace this algorithm with a locking mechanism that guarantees ownership across these interleavings. Add tests for both races before freezing the protocol in `.2`.

2. **vtt-5su.6, vtt-5su.2, prerequisite vtt-75c.12 — blocker: cover generation and visibility use incompatible fail-closed rules.**  
   M3 produces a bounded region when `opaque` errors but geometry is valid. The cited M2 cover contract classifies *any* erroneous read, including `opaque`, as `undetermined`; `Visibility` treats that as covering the entire board. A token outside the displayed cover can therefore disappear. `.6` forbids changing the underlying visibility implementation.  
   **Change:** reconcile the oracle and presentation contracts in an explicitly owned prerequisite change. Test an erroneous `opaque` with valid geometry and tokens both inside and outside that geometry, asserting agreement between displayed covers and object visibility.

3. **vtt-5su.9 — blocker: subscription invalidation misses references stored in formula overrides.**  
   `refTargets` explicitly indexes literal cells, excluding formulas. But an overridden formula reads its override as a literal; a direct read need not leave a formula dependency that `engine.invalidate` returns. Removing an external override target can change a subscribed cell to `#REF` without resending its object. The required fresh-subscription equivalence consequently fails.  
   **Change:** index references in effective literal content, including overrides, and maintain that index when overrides are set or cleared. Add direct, nested-list and viewers-reference override tests covering removal and undo. Also cover board-reference disappearance and restoration; board effects currently produce no candidates.

4. **vtt-5su.7, vtt-5su.19, vtt-5su.15 — should-fix: recovery turns temporary transport failures into permanent subscription failures.**  
   `.19` calls `sub.fail(error)` for any resubscribe failure. A second socket drop during recovery therefore permanently empties subscriptions that should recover on the next connection. Moreover, `reopen` clears the connection error before subscription recovery finishes, allowing MCP tools to return stale mirrors during that interval.  
   **Change:** distinguish transport failures from terminal subscription responses such as `not_found`; retry transport failures without failing handles. Define when recovery becomes ready for ordinary callers, and gate mirror-dependent tools until then. Test two consecutive disconnects during recovery with multiple subscriptions.

5. **vtt-5su.2, vtt-5su.19, vtt-5su.11 — should-fix: some indeterminate write outcomes are reported as ordinary disconnections or timeouts.**  
   A sent transaction may commit even if recovery exceeds `timeoutMs`, yet `.19` specifies `disconnected`. It also leaves a lost response to the one permitted resend unspecified. A caller can mistake these for non-execution and submit a new transaction id.  
   **Change:** define all unresolved outcomes after a write was sent as `uncertain` once safe recovery is exhausted, including response timeout and loss of the resend response. Reserve ordinary `disconnected` for requests known not to have been sent. Add tests proving no further execution occurs.

6. **vtt-5su.17, vtt-5su.19 — should-fix: initial connection failure has no workable lifecycle.**  
   `.17` connects first and enables recovery afterward, although it promises that an unreachable authority leaves MCP running with `disconnected` tools and continuing reconnects. The default agent name also depends on MCP initialization information that is unavailable before MCP initialization.  
   **Change:** specify startup ordering explicitly: initialize MCP, obtain the agent name, and start authority connection/recovery without requiring an initial successful connection. Capture discovery identity at the first successful welcome. Test startup while the authority is already down, followed by its appearance.

7. **vtt-5su.2, vtt-5su.11 — should-fix: MCP input schemas and handler behavior disagree.**  
   The protocol `transact` schema accepts `actor` and `retry`, but `.11`’s specified wrapper forwards neither. An agent-supplied `actor` can therefore be silently discarded instead of producing the required `bad_request`. Likewise, the protocol undo schema accepts an actor target while the MCP tool promises only `latest`, `mine` and `group`.  
   **Change:** define explicit MCP schemas derived from the protocol schemas, excluding transport-managed fields and narrowing supported variants, or forward fields and enforce the stated rejection rules. Test that unsupported inputs cannot silently become successful writes.

8. **vtt-5su.3 — should-fix: its parser acceptance criteria contradict its parser boundary.**  
   `parseServerMessage` must leave response `result` as `unknown`, but Done-when also requires it to strip unknown fields inside response results and their nested views/effects. It cannot perform method-specific normalization without the pending request’s method.  
   **Change:** require envelope normalization from `parseServerMessage`, and result normalization—including unknown-effect warnings—from `parseResult`. State the warnings field in both functions’ public return types where applicable, and test the two-stage pipeline.

9. **vtt-5su.18, vtt-5su.4 — should-fix: filesystem failure handling leaves ownership gaps.**  
   If exclusive lock creation succeeds but writing or fsync fails, `.18` does not require cleanup; `.4` has no returned lock object to release. Separately, `readOrCreateTableId` assumes rename will refuse an existing destination, although ordinary rename replaces it.  
   **Change:** require acquisition to clean up its own partially created lock on every failure, with fault-injection tests. For identity creation, explicitly require the table lock and test that contract, or use atomic publication that cannot overwrite an existing identity.

10. **vtt-5su.9 — should-fix: the subscription bead is oversized.**  
    It owns a new Table notification interface, scope tracking, reference indexing, selective recomputation, character visibility invalidation, covers, historical log-window refresh, and a substantial property/performance test suite. These contain independently reviewable correctness mechanisms.  
    **Change:** split object/cover subscriptions from log-window maintenance behind an explicit interface. Give the Table notification seam one owner, record dependencies on it, and place cross-component equivalence tests in the integrating bead.

11. **vtt-5su.3, vtt-5su.19 — nit: exclusive ownership declarations overlap.**  
    `.3` claims everything under `packages/protocol/src` except `client.ts` and `mirror.ts`, which includes `.19`’s `client/recovery.ts`. The dependency chain prevents concurrent implementation, but the scope declarations still conflict.  
    **Change:** make `.3`’s ownership an explicit file list, or also exclude the recovery module.

**Verdict: not ready to implement.** Fix the lock protocol, reconcile cover semantics, and complete subscription invalidation first. Resolve the recovery, startup and schema-contract gaps before freezing `.2`, and split `.9` so its correctness mechanisms can be reviewed independently.