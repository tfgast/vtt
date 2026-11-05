1. **vtt-5su.7, vtt-5su.19 — blocker: the recovery seam cannot perform recovery.**  
   `.19` sets the client to `recovering` before resubscribing, but `.7` rejects every request unless the state is `open`. No recovery-only request method is exposed, and `.19` cannot edit `client.ts`. A resubscribe timeout also requires abandoning the current connection, but the only documented socket-closing method permanently closes the client.  
   **Change:** add an internal request path usable during recovery and a reconnectable socket-abort method to `.7`’s seam. Keep ordinary requests gated on readiness. Test recovery exclusively through that seam, including a resubscribe timeout with the socket still open.

2. **vtt-5su.17 — blocker: credential-free startup has contradictory outcomes.**  
   The bead requires discovery-based startup with no running authority or session file to remain alive and connect later. It also requires “with no credentials at all” to exit 1. Those are the same initial conditions.  
   **Change:** make absence of explicit credentials select discovery mode, even when the file is missing. Reserve startup errors for malformed or incomplete explicit credentials. Replace the contradictory exit test accordingly.

3. **vtt-5su.2, vtt-5su.6 — should-fix: drawn covers can disagree with M2 visibility.**  
   The proposed cover contract cannot represent a valid shapeless zone: `Cover.region` requires a `Shape`, while `.6` sends invalid geometry to `whole_board`. The existing cover oracle explicitly treats an otherwise valid shapeless zone as covering nothing. It also treats invalid geometry as undetermined before checking opacity, whereas `.6` first requires opacity. Consequently the promised agreement with the unchanged oracle is not established.  
   **Change:** specify the complete classification table, including absent shape and invalid geometry with `opaque: false`. Either match M2 or assign an explicit upstream amendment and dependency. Add parity tests for these cases.

4. **vtt-5su.9, vtt-5su.20 — should-fix: board existence changes leave character subscriptions stale.**  
   `visibilityRelevant` excludes board creation/removal. An older log effect containing a board reference must change from a reference to `redacted` when that board disappears, but `.20` will not rebuild it. This remains true after the current cell has been overwritten, so `.9`’s current-reference index cannot solve it. Board deletion can also turn a literal viewers value containing that reference into `#REF`, changing inherited visibility.  
   **Change:** include board existence changes, including undo, in character-view invalidation. Add deterministic object-subtree and historical-log tests comparing maintained views with fresh subscriptions.

5. **vtt-5su.2, vtt-5su.19 — should-fix: reconnect validates discovery metadata but not the authority actually reached.**  
   Recovery compares the session file’s identity with the first welcome, then accepts the next welcome without requiring its table identity to match. A missing or stale discovery file can therefore leave old credentials pointing at another authority—for example when a port and explicit token are reused. Mirrors could then switch tables despite the `wrong_table` policy.  
   **Change:** validate each successful reconnect’s `welcome.table.path/id` against the captured identity before rebinding subscriptions or retrying writes. Test mismatched welcomes with both unchanged and missing discovery files.

6. **vtt-5su.2, vtt-5su.5, vtt-5su.8 — should-fix: unknown-id error precedence is contradictory.**  
   PROTOCOL §4 says unknown object and board ids in params produce `not_found`. The command bead instead delegates to M2 primitives, which reject unknown objects as `invalid`, and deliberately gives stale conflicts precedence over primitive refusals. An independent router agent could implement the blanket rule and break command semantics.  
   **Change:** restrict the `not_found` rule explicitly to the relevant query, explain and subscription targets. State that transaction targets follow §6’s processing order and primitive rejection semantics. Add tests distinguishing unknown query targets, unknown transaction targets and stale removed targets.

7. **vtt-5su.2, vtt-5su.3, vtt-5su.16 — should-fix: explanation cannot explicitly report an unguarded action as enabled.**  
   `ExplainActionResult.enabled` exists only inside optional `when`. Yet `.16` promises enabled state when `when` is absent. Neither the schema nor the bead specifies how to encode that result.  
   **Change:** put `enabled` and optional `reason` at the result’s top level, retaining optional guard details separately, or specify another unambiguous representation. Test an action without a guard, including character-view output.

8. **vtt-5su.13 — should-fix: the acceptance test requires a dependency the engine does not record.**  
   The Fireball zone remains inside the card when `explain_cell targets` must show an `index` dependency. Existing `contents(zone)` returns an empty list for a contained zone before asking for board candidates; dependency recording is dynamic under FORMULAS §7.  
   **Change:** assert the empty result and relevant recorded cell dependencies at that point. If acceptance must demonstrate an index dependency, temporarily deploy the zone onto a board, assert it there, then undo the move.

9. **vtt-5su.6, vtt-5su.8 — should-fix: some required test setups violate M2 invariants.**  
   `.6` requires a non-boolean literal `opaque`; `.8` suggests a text literal `position` to obtain `#TYPE`. The store and snapshot validator reject these structural literals, so ordinary `Table` setup cannot produce them.  
   **Change:** use valid formulas that evaluate to the unwanted types, such as a text-producing `opaque` or `position` formula. Where malformed stored geometry itself is intentional, name an explicit test seam rather than requiring an impossible validated table.

10. **vtt-5su.18 — should-fix: exclusive identity-file creation does not guarantee a readable identity.**  
    The required race test assumes a caller receiving `EEXIST` can immediately read the winner’s UUID. The winner may have created the file but not written it yet. A failed write can also leave an empty identity file that future opens must read but may never rewrite.  
    **Change:** serialize identity initialization under the held table lock, including concurrent calls in one process; specify cleanup of failed initialization and handling of malformed existing identities. Test a paused writer and injected write failure.

11. **vtt-5su.3, vtt-5su.12 — should-fix: two beads combine independently reviewable deliverables.**  
    `.3` combines the entire recursive wire model, all method schemas, compatibility parsing and JSON Schema export. `.12` combines a complete fixture-runner adapter with a separate randomized subscription-equivalence harness. Each is a substantial review surface with distinct failure modes.  
    **Change:** split `.3` into foundational values/views/ops and dependent methods/messages/parsers. Split `.12` into fixture parity and subscription equivalence. Give each exclusive files, its own Done-when criteria and recorded dependencies; serialize shared package/index changes where needed.

**Overall verdict: not ready to implement.** Fix the recovery interface and startup contradiction first, then reconcile cover/invalidation semantics and the incompatible acceptance criteria before `.2` freezes the protocol. Apply the proposed splits and record their dependencies before dispatching agents.