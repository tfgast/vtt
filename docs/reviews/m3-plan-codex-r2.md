1. **vtt-5su.2, .3, .5, .11 — blocker — The authoritative contract is incomplete.**  
   As supplied, the method, op, and MCP tables contain literal truncations such as `base_revision: number,…`, `cell:<object>/<c…`, and `same-named methods`. Yet .2 forbids adding anything and .3 requires exact schemas. Separate agents cannot recover identical required fields, defaults, result shapes, or conflict keys. **Change:** replace every truncated table entry with complete definitions before closing the planning bead. Include complete `TransactResult`, subscription params/results, and all declared-key rules.

2. **vtt-5su.6 → vtt-75c.18 — blocker — The views bead lacks its actions-effect dependency.**  
   .6 must handle canonical `field: "actions"` effects and test `setActions`, but those arrive in vtt-75c.18. The current canonical `Effect` union does not contain that variant. .6 can become runnable without its required input. **Change:** record a direct dependency on vtt-75c.18.

3. **vtt-5su.11, .14 — should-fix — Concurrent package ownership remains unresolved.**  
   These siblings can run concurrently and both change `packages/authority/package.json` and the dependency lockfile. CLAUDE.md explicitly permits independent sorted barrel-export additions, but gives no equivalent rule for manifests or lockfiles. **Change:** consolidate runtime dependency and binary declarations into a prerequisite packaging bead, or serialize .14 after .11 and require each dependency-changing bead to update the lockfile.

4. **vtt-5su.2, .3, .7 — should-fix — Strict parsing contradicts the additive-extension promise.**  
   §12 promises new optional fields and event kinds within protocol v1. But all objects reject unknown keys, and .7 closes the connection on any invalid server message. An M5 face-layout field would therefore disconnect an M3 client. **Change:** choose and document a compatible policy—such as strict incoming requests with forward-compatible client response parsing—or require a protocol version bump. Add compatibility tests for the chosen policy.

5. **vtt-5su.2, .6 — should-fix — Historical names bypass per-cell visibility.**  
   `GroupView.names` is filtered by object visibility alone. A public object with a GM-only `name` cell consequently exposes its captured name through the log, despite DESIGN §4.4 requiring the same effective visibility there. Raw labels can also disclose identifiers or values removed from filtered effects. **Change:** filter captured names through `canSeeCell(object, "name")`; define whether character-facing labels are deliberately public or require a filtered presentation. Test a visible object with an unreadable name and a mixed public/private transaction.

6. **vtt-5su.2, .5, .7 — should-fix — Deduplication is preceded by mutable-state validation.**  
   .5 checks that an actor still exists and remains a character before consulting the transaction cache. A UI transaction committed as Aldric can therefore return `bad_request` on an identical retry after another connection removes Aldric or clears his character flag, instead of returning its cached outcome. **Change:** put only structural, state-independent validation before deduplication; perform current-document checks after a cache miss. Add that retry scenario to Done when.

7. **vtt-5su.2, .7, .14, .15 — blocker — Normal authority restart breaks the promised MCP recovery.**  
   The authority generates a new token on every start, while `ProtocolClient` retains its original token and treats 4401 as terminal. MCP reads discovery only at startup. All restart acceptance tests fix the token, concealing this failure in ordinary use. **Change:** specify discovery refresh and credential replacement for discovery-based connections, with protection against accidentally attaching to a different table. Define the recovery behavior for explicitly supplied credentials. Test a normal restart without `--token`.

8. **vtt-5su.7, .9, .15 — should-fix — Mirror revisions can remain stale indefinitely.**  
   The server omits a subscription delta when its views do not change. The client updates its own revision on every commit, but the specified mirror updates its revision only through `apply(delta, revision)`. An unchanged subscription can thus report an old revision despite being current, undermining MCP’s advice to obtain the latest revision from `poll_changes`. **Change:** advance every active mirror’s revision on each processed commit, including commits with `deltas: []`, and specify which revision subscription resources and polls return.

9. **vtt-5su.2, .7, .15 — should-fix — Reconnection has no subscription-failure policy.**  
   A board subscription can outlive its board. After disconnection, resubscribing to that board returns `not_found`, whereas the client contract promises to resubscribe every live subscription and preserve its object/handle. It does not say whether other subscriptions recover or what the failed handle reports. **Change:** define terminal subscription errors or an explicit empty-state policy, and test deleting a subscribed board before reconnecting.

10. **vtt-5su.4, .14 — blocker — Shutdown depends on an unspecified save-failure interface.**  
    .14 must log a failed final save and exit 1, but .4 does not specify whether `close()` returns a save result, throws, or resolves after emitting failure. It also does not clearly state whether `saved_not_durable` advances `lastSavedRevision`. Independent implementations can disagree while satisfying their local tests. **Change:** freeze the close result/error contract, lock-release behavior, and durability-status bookkeeping. Test final-save failure through both the host and CLI.

11. **vtt-5su.4 — should-fix — Lock ownership and cleanup need stronger acceptance criteria.**  
    The lock specification covers a single stale-lock takeover, but not two processes racing to replace it. A read/check/unlink implementation can remove another process’s newly acquired lock. Errors during load or initial save also have no explicit lock-cleanup requirement. **Change:** require an ownership-safe takeover/release algorithm and cleanup on every failed open. Test simultaneous stale-lock takeover and corrupt-file/open failures.

12. **vtt-5su.13 — should-fix — The authored save-row template is incomplete.**  
    The acceptance script creates `fireball_save_row` with “cells per the Fireball fixture,” but never requires its **Roll save** action. The test can pass with a card whose future spawned rows cannot perform the procedure in FORMULAS §10. **Change:** explicitly create and verify the row template’s action and guard, as well as its cells. Invocation can remain deferred to M5.

13. **vtt-5su.8, .15 — should-fix — These beads combine independently reviewable work.**  
    .8 combines eight query handlers with bounded dependency traversal, error-origin tracing, and three explain handlers. Sharing a read-only Table API does not make those one responsibility. .15 combines subscription diff/buffer semantics with CLI discovery, MCP initialization, and subprocess lifecycle. **Change:** split .8 into queries and explain; split .15 into subscription tools/buffers and the stdio process. Give each exclusive files and make integration/acceptance depend on both outputs.

**Overall verdict: not ready to implement.** Complete the contract, add the missing dependency, and resolve restart authentication and shutdown semantics first. Then fix the compatibility, visibility, client-state, ownership, and acceptance gaps above before dispatching independent agents.