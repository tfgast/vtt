# Plan: M3 Protocol and MCP server (epic vtt-5su)

Plan for the planning bead vtt-5su.1, updated after the orchestrator's
decisions and filing on 2026-11-04. Plan labels map to filed ids: M3-0
vtt-5su.2, M3-a vtt-5su.3, M3-h vtt-5su.4, M3-c vtt-5su.5, M3-d vtt-5su.6,
M3-i vtt-5su.7, M3-e vtt-5su.8, M3-f vtt-5su.9, M3-g vtt-5su.10, M3-g2
vtt-5su.14, M3-j vtt-5su.11, M3-j2 vtt-5su.15, M3-k vtt-5su.12, M3-l vtt-5su.13
(M3-g2 and M3-j2 were split off after review r1), M3-e2 vtt-5su.16, M3-j3 vtt-5su.17
(split off after review r2), M3-h2 vtt-5su.18, M3-i2 vtt-5su.19
(split off after review r3), M3-f2 vtt-5su.20
(split off after review r4); the draft's M3-b became the M2
bead vtt-75c.18. Section 2 holds the filed descriptions; section 4 keeps the
reviewed open questions with their resolution noted at its top.

**What M3 delivers.** One local authority process per table file that owns
the M2 `Table` (store, engine, index, visibility) and its file, and serves a
single protocol over a WebSocket on 127.0.0.1: batched, validated write
commands (one command = one op group) carrying `base_revision`; viewer-filtered
queries; explain; and subscriptions that push viewer-filtered deltas of object
views after each commit, with the authority deciding which formula cells to
recompute (exactly those in some subscription's scope, FORMULAS §7). A browser-
and Node-compatible protocol client. An MCP server exposing query, write,
explain and subscribe to whatever agent the GM uses, running as a client of
the same protocol with agent attribution (→ Q1). Autosave and file locking
(DESIGN §7 leaves autosave cadence to M3). M3 builds no UI (M4), no action
runner or invoke (M5), no face layouts (M5).

**Epic Done-when** ("acceptance scenario step 5 — an agent authors a zone and a
card — runs headlessly against the authority") is carried by **M3-l**: a test
that starts the real `vtt-serve` process on a temporary table, builds the
prep state of §8.4 steps 1, 3, 4 (minimal) through the protocol as the GM,
launches the real `vtt-mcp` stdio process through an MCP client, and drives a
scripted agent that makes room 4 difficult terrain and hatches it, and builds
a Fireball card for Aldric with DC 14 and 8d6; the GM then "corrects the DC by
typing over it" through the protocol, and the agent observes the change.
**M3-k** additionally runs all ten fixture scenarios through the protocol and
shows they produce the same reports and documents as the direct M2 runner.

---

## 1. Package layout and main names

New package **`@vtt/protocol`** (→ Q2): browser-safe, depends only on
`@vtt/schema` and `zod` 4.6.7. Scaffolded per CLAUDE.md (exports `"."` →
`./src/index.ts`, `tsconfig.json` extending the base, `typecheck` script,
`vitest.config.ts` with `test.name: "@vtt/protocol"`, at least one test).

- `src/version.ts`: `PROTOCOL_VERSION = 1`, `DEFAULT_PORT` (→ Q25), `LIMITS` (`Limits`, → Q21).
- `src/values.ts`: `RedactedValue` (`{type:"redacted"}`), recursive `WireValue` / `WireViewers` / `WireError` / `WireResult` (redaction at any depth), `InputValue` / `InputViewers` / `InputCellContent` (refs may be `$bindings`), JSON-Schema-compatible schemas (no `z.custom`), `BindingName`, `ObjRef` (review r1).
- `src/views.ts`: `Viewer`, `CellView`, `ObjectView`, `ActionView`, `Cover`, `GroupHeader`, `GroupView`, `BoardView`, `EffectView`, `CellStateView`, `LocationView`, `ObjectSnapshotView`, schemas.
- `src/ops.ts`: `WireOp` (19 op kinds), `Destination`, `ObjectInit`, schemas; `WIRE_OP_TYPES`.
- `src/methods.ts`: per-method `…Params` / `…Result` types and schemas; `METHODS` table (name, params schema, result schema, kind `write | query | explain | subscribe`).
- `src/messages.ts`: `ClientMessage` (`hello`, `request`), `ServerMessage` (`welcome`, `response`, `event`, `goodbye`), `ProtocolError`, `ProtocolErrorCode`, `ProtocolRejection` (schema `Rejection` | `stale_write` | `undo_target_changed`), `CommitEvent`, `SubscriptionDelta`, `SaveEvent`, `CLOSE_CODES`, `ProtocolFailure` (an `Error` carrying a `ProtocolError`); `parseClientMessage`, `parseServerMessage` (envelope only, review r3); `methods.ts` also exports `parseResult(method, result)`.
- `src/client.ts` (M3-i): `ProtocolClient` (incl. `connectionError()` and the recovery seam: `socket_closed`, `reopen`, `requestDuringRecovery` and `abortSocket` (r5), `setState`, `setConnectionError`, `liveSubscriptions`, `sub.rebind`, `sub.markRecovering`, `sub.fail`), `ClientOptions`, `ClientState`, `Subscription`.
- `src/client/recovery.ts` (M3-i2, review r3): `enableRecovery`, `transactWithRetry`.
- `src/mirror.ts`: `ViewMirror` (applies a subscription's initial view and deltas).

`@vtt/schema` (vtt-75c.18, additive, M2): `field` effect gains `"actions"` (before/after `ActionDef[]`).

`@vtt/authority` (adds `@vtt/protocol` workspace dependency, `ws` 8.22.0,
`@modelcontextprotocol/server` 2.3.1, `tsx` 4.23.15, `zod` 4.6.7; dev:
`@types/ws` 8.18.2, `@modelcontextprotocol/client` 2.3.1; → Q27):

- `src/store/edits.ts` (vtt-75c.18, M2): `setActions(tx, obj, actions)`, `removeBoard(tx, id)`.
- `src/protocol/commands.ts`: `executeTransact`, `executeUndo`, `TxnCache`, `StaleWriteError`, `resolveBindings`, `validateOpsStatic`.
- `src/protocol/conflicts.ts`: `staleConflicts(history, baseRevision, keys)`, `historyFloor`, `intersectingKeys` (review r1; `commands.ts` adds `declaredKeys`).
- `src/protocol/views.ts`: `ViewBuilder` (`objectView`, `covers`, `groupView`, `redact`), `STRUCTURAL_VIEW_CELLS`.
- `src/protocol/queries.ts` (M3-e): `listObjects`, `getObjects`, `evaluateAdhoc`, `zonesOnBoard`, `atPosition`, `changesSince`, `logPage`, `documentDump`.
- `src/protocol/explain.ts` (M3-e2, review r2): `explainCell`, `explainGroup`, `explainAction`.
- `src/protocol/subscriptions.ts` (M3-f): `SubscriptionHub` (`subscribe`, `unsubscribe`, `dropConnection`, `onCommitEvent`, `registerScope`), `ScopeProvider`, `isVisibilityRelevant`; `src/engine/table.ts` gains `onCommit` (M3-f, sole owner of that seam).
- `src/protocol/log-window.ts` (M3-f2, review r4): `logScopeProvider`, `createSubscriptionHub`.
- `src/host/table-host.ts`, `new-table.ts` (M3-h): `TableHost` (`open`, `inMemory`, `table`, `dice`, `tableId`, `save`, `close`, `onSave`, `warnings`), `newTableSnapshot`.
- `src/host/lock.ts`, `identity.ts` (M3-h2, review r3; no automatic takeover after r4): `acquireTableLock`, `TableLock`, `removeTableLock` (for `--force-unlock`), `TableLockedError`, `TableIdentityError` (r5), `canonicalTablePath`, `readOrCreateTableId`.
- `src/server/server.ts`, `connection.ts`, `router.ts` (M3-g): `startServer`, `Connection`, `route`; `src/server/session-file.ts` (M3-g2): `writeSessionFile`, `readSessionFile`, `removeSessionFile`.
- `src/mcp/server.ts`, `tools.ts`, `resources.ts`, `gate.ts` (M3-j): `createMcpServer` (with an `extensions` hook), `TOOLS`, `withConnection` (review r3); `src/mcp/subscriptions.ts`, `changes.ts` (M3-j2): `subscriptionTools`, `ChangeBuffer`; `src/mcp/discovery.ts` (M3-j3, review r2): `sessionCredentials`.
- `src/bin/serve.ts` (`vtt-serve`, M3-g2), `src/bin/mcp.ts` (`vtt-mcp`, M3-j3).
- `test/protocol-runner/` (M3-k), `test/acceptance/step5.test.ts` (M3-l).

New doc **`docs/PROTOCOL.md`** (→ Q3): owns the wire format the way
FIXTURES.md owns the fixture format; DESIGN §5 and §7 state the decisions and
point to it.

---

## 2. Beads (as filed, revised after reviews r1–r5)

Filed 2026-11-04 after the orchestrator's decisions (plan-m3-decisions.md), revised after the Codex plan reviews r1–r5 (review-plan-m3-r1.md … -r5.md; dispositions in plan-m3-r1-dispositions.md … -r5-dispositions.md); see the "Review r1–r5 changes" sections after section 3. Each section below is the bead's description verbatim as now recorded in bd (inside vtt-5su.2, headings are demoted by two levels here).

Amendments relative to the draft: M3-b was dropped; its content plus `removeBoard` is the M2 bead **vtt-75c.18** "Authority: setActions and removeBoard primitives" (P1, parent vtt-75c, depends on vtt-75c.14, .5, .8, .11; its text is unchanged by r1–r5). M3-c gains `remove_board` (19 op kinds) and depends on vtt-75c.18. The face-down exemption set (Q13) was written into **vtt-75c.10** (`FACE_DOWN_EXEMPT`). `@vtt/protocol` and zod are added to `@vtt/authority` by M3-a; M3 modules are exported from `packages/authority/src/index.ts` directly (no `protocol/index.ts`).

Review r1: M3-0 (vtt-5su.2) carries the complete protocol contract, every other bead cites PROTOCOL.md; M3-g split into M3-g (vtt-5su.10) and **M3-g2 (vtt-5su.14)**; M3-j split into M3-j (vtt-5su.11) and M3-j2 (vtt-5su.15); vtt-75c.13 gained the `onStep` hook. Review r2: M3-e split into M3-e (vtt-5su.8, query methods) and **M3-e2 (vtt-5su.16)** (explain methods); M3-j2 split into M3-j2 (vtt-5su.15, subscription tools and change buffers) and **M3-j3 (vtt-5su.17)** (vtt-mcp stdio process). Review r3: M3-h split into **M3-h2 (vtt-5su.18)** (table lock and identity files) and M3-h (vtt-5su.4, table host: open, autosave, save, close); M3-i split into M3-i (vtt-5su.7, client: mirror and request correlation) and **M3-i2 (vtt-5su.19)** (client: reconnect, retry and subscription recovery); vtt-75c.17 gained the `saveTable` capture contract. Review r4: M3-f split into M3-f (vtt-5su.9, object and cover subscriptions, owner of the Table notification seam and the `registerScope` interface) and **M3-f2 (vtt-5su.20)** (log window subscriptions); the cover fail-closed rule is fixed in M2 by vtt-75c.19 (filed by the orchestrator), which M3-d depends on; v1 refuses stale locks (manual `vtt-serve --force-unlock`). Review r5 (final): text fixes only, no new beads, no dependency changes. Type task; P1 except M3-k and M3-l (P2); parent vtt-5su.

### vtt-75c.18 (was M3-b) — Authority: setActions and removeBoard primitives

Implements: DESIGN.md §5.2 ("define … actions"), §4.3 (boards), §4.5, §7 (operation records, undo conflict keys, identity); FORMULAS.md §8 (an action has a name, an optional precondition, and a list of steps); DESIGN.md §4.1 Identity (board ids are reserved for the document's lifetime).

Two edit primitives M2 lacks, needed by the M3 protocol (vtt-5su) and the M4/M5 UI. Additive changes to M2 files after their owning beads merge: `packages/schema/src/ops.ts` (vtt-75c.4), `packages/authority/src/store/effects.ts` and `summary.ts` (vtt-75c.5), `store/edits.ts` (vtt-75c.14). Tests in `test/store/actions-boards.test.ts`; the vtt-75c.5 effect round-trip test gains an `actions` example.

- Schema: the `field` effect's `field` union gains `"actions"`, with `before`/`after` of type `ActionDef[]`.
- effects.ts: `applyEffect`, `historicalInverse`/`applyHistoricalInverse` and `invertForUndo` handle `field: "actions"` (exact reversal); `touchedKeys` returns `actions:<obj>` (intersected by `obj:<id>` like every key on that object); `changedCells` returns nothing (actions are not readable cells).
- summary.ts: `ChangeSummary.actionsChanged: ObjectId[]`, deduplicated, filled by `SummaryBuilder` from `field: "actions"` effects.
- `setActions(tx, obj, actions: ActionDef[])` in edits.ts: replaces the object's whole action list with one field effect. Refused as `invalid` (vtt-75c.4 `Rejection`) when the object does not exist, an action name is empty or longer than 100 characters, two actions share a name (exact comparison), or `steps` is not an array of strings. `when` and step text are stored verbatim and not parsed (M5 owns step syntax). Spawn already copies actions (vtt-75c.6); no change there.
- `removeBoard(tx, id)` in edits.ts: refused as `invalid` when the board does not exist or any object is directly on it; otherwise records a `board` effect with `after: null` and a `retire` of the board id. User undo re-creates the board through vtt-75c.5's `invertForUndo` (the id stays retired; a later `addBoard` with that id stays invalid).

Docs, in the same commit: two decision-log rows in DESIGN §10 (dated the commit day) and the matching text: DESIGN §7 operation records list the `actions` field effect; DESIGN §4.3 (or §7 Smaller decisions) states that a board can be removed only when no object is directly on it, and that its id stays reserved.

Done when: tests show: `setActions` records one field effect with exact before/after; undo restores the previous list; a later `setActions` on the same object makes an undo of the earlier one `undo_conflict`, while one on another object does not; a later `remove` of the object conflicts (`obj:<id>`); `actionsChanged` lists the object once for two calls in one transaction; each invalid `setActions` case is refused and leaves document and history unchanged; `removeBoard` of an empty board removes it and retires its id, undo re-creates it with the id still in `retired_ids`, and `addBoard` with that id is then invalid; `removeBoard` of a board with an object on it and of an unknown board is `invalid` with no change; a document with a `field: "actions"` effect and a board removal survives `serializeTable` → `parseTable`, and replay reproduces the stored state; `toFixtureReason` is unaffected; the two decision-log rows exist; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: parsing or running actions, `when` evaluation, invoke (M5); face layouts (M5); cascading board removal (a non-empty board is refused); the protocol ops (vtt-5su beads).

Depends on: vtt-75c.14, vtt-75c.5, vtt-75c.8, vtt-75c.11.

---

### M3-0 — vtt-5su.2 — Docs: protocol, MCP and authority-process decisions

Implements: DESIGN.md §4.4, §5.2, §7, §10; FORMULAS.md §7; new docs/PROTOCOL.md; CLAUDE.md package list. Planning bead vtt-5su.1 (plan accepted with the orchestrator's amendments and the plan review r1 dispositions).

Docs only; the only M3 bead that edits docs. Writes down the decisions below and the complete protocol contract, so every later M3 bead cites a doc section. This description is the single source of the contract: every type, table and rule in "PROTOCOL.md contract" goes into docs/PROTOCOL.md with exactly these names and values (prose may be reworded, nothing may be added or dropped). One decision-log row in DESIGN §10 per numbered decision (D1–D31) except D13, D20 and D31, dated the commit day.

#### Decisions to record

- D1 Process model: one authority process per table (`vtt-serve <file>`) owns the file and the M2 `Table` and serves the protocol over a WebSocket. The MCP server is a separate stdio process (`vtt-mcp`) launched by the agent host; it attaches to the running authority as a protocol client with an `agent` actor. The authority package ships the MCP server (DESIGN §7's "hosts the MCP server" becomes "ships").
- D2 Package: new `@vtt/protocol` (wire schemas, `ProtocolClient`, `ViewMirror`), browser-safe, depends only on `@vtt/schema` and zod; used by authority, MCP server and M4's UI. Wire schemas are JSON-Schema-compatible (no `z.custom`, no transforms) so tool input schemas can be generated; the canonical `@vtt/schema` schemas stay for unfiltered document data.
- D3 Transport: JSON text frames on one WebSocket at `ws://127.0.0.1:<port>/ws`; envelope tagged by `type`; client-chosen request ids echoed in responses; exact-match `protocol: 1` in `hello`. The wire format lives in docs/PROTOCOL.md.
- D4 Auth: bind 127.0.0.1 only; a random 256-bit token per server start, required in `hello`; WebSocket upgrades with an `Origin` other than the server's own origin or an `--allow-origin` entry are refused with 403. Every authenticated connection has GM authority; `viewer` is a view-as selector, not a security boundary, in v1.
- D5 Discovery: `vtt-serve` writes `$XDG_CONFIG_HOME/vtt/session.json` (`{url, token, pid, table_path, table_id}`, mode 0600); `vtt-mcp` uses `--url/--token`, else `VTT_URL`/`VTT_TOKEN`, else that file; the last started authority wins. A discovery-based client re-reads the file on every reconnect attempt and adopts a new url and token only when `table_path` and `table_id` equal the ones recorded at its first connect, else it stops with `wrong_table`; with explicitly supplied credentials a 4401 is terminal (reported `unauthorized`) and in-flight writes report `uncertain`.
- D6 Commands: one write command `transact` carrying a list of ops (19 kinds, one per M2 primitive including `set_actions` and `remove_board`) applied in one transaction = one group = one undo unit, with batch-local `$name` bindings usable in op id positions and in ref values; plus `undo`, `save`, `invoke`.
- D7 Stale writes: every `transact` carries `base_revision`. It is refused `stale_write` when `base_revision` is below the retained-history floor (`truncated`), when a group committed after `base_revision` (undo groups included) shares a key with the ops' declared intended-write keys (checked before any primitive runs, so a write to an object removed since is stale, not a primitive refusal), or when such a group shares a key with the transaction's actual effects (checked after the ops ran, before commit). Keys are the undo-conflict keys of DESIGN §7. Disjoint writes commit; nothing is rebased or re-evaluated. Undo is not stale-checked and may pin its target with `expect_index` (`undo_target_changed`). This replaces "the policy for stale writes belongs to M3's protocol" in §7.
- D8 Retries and identity: `hello` carries a client-chosen `client.instance` that a client keeps across reconnects; `welcome` carries the authority `session` id, new at every authority start. `transact` may carry `txn_id`; the deduplication key is (`client.instance`, `txn_id`) with a fingerprint of the params; a repeat with the same fingerprint returns the stored result, a repeat with a different fingerprint is rejected `invalid`. Only structural, state-independent validation precedes the lookup; checks against the current document (base revision range, actor existence and character flag) run after a cache miss, so an identical retry always gets the stored outcome. The authority keeps the last 1,000 txn ids per client instance, in memory only. A client retries an in-flight write only after reconnecting to the same `session`, marking the resend `retry: true`; the authority answers a marked resend whose key is no longer retained with error `retry_unknown` instead of executing it; after a session change or a `retry_unknown` the client reports the outcome `uncertain` and never re-executes. Persistent deduplication is Later.
- D9 Actors: `client.kind: "agent"` → `{type:"agent", name}`; `ui` and `test` → `gm`; non-agent connections may pass `actor: {type:"character", id}` per `transact` (the GM driving a character); agents cannot.
- D10 Subscriptions: per connection, each with a scope (`board` incl. contents recursively, `objects` with optional subtree, `all`, `log`) and a viewer; `subscribe` returns full views; afterwards one `commit` event per commit per connection with the group header and, per subscription, upserted whole object views, removed ids, cover changes, and for `log` scope group upserts and removals over a bounded window of the newest 200 retained groups. After each commit the authority evaluates what the changed subscribed views need (their cells, those cells' transitive dependencies, and the visibility and geometry inputs the views need, even outside the scope); every other dirty cell stays dirty until read (FORMULAS §7 gains this sentence).
- D11 Cell views: GM views carry value, kind, formula source, override flag, per-cell visibility entry and full actions; character views carry value, kind, override flag and action names only, never formula source, action source or per-cell visibility metadata, in object views, group effects and explain alike. Every readable structural cell (with defaults) is part of a view's `cells`.
- D12 Redaction: in character views a ref (top level, in lists at any depth, in viewers values) to an object the viewer cannot see, or to an id that is neither a live object nor a board, is the wire-only value `{type:"redacted"}` in place, so contents keep their count; a ref to a board is never redacted (boards are not a visibility boundary, DESIGN §4.3); an error whose origin the viewer cannot see keeps only its code. Group effects use separate presentation types (`EffectView`) filtered per effect variant.
- D13 Face-down exemptions are vtt-75c.10's `FACE_DOWN_EXEMPT` (no row here; DESIGN §4.4 already says so). Reference it in PROTOCOL.md §7 only.
- D14 Covers: character views carry, per board in scope, a `Cover` (region: position, rotation, shape; or `whole_board` for an undetermined zone) for each opaque zone on that board that is not effectively visible to the viewer (M2's `isEffectivelyVisible` on the zone, the predicate of M2's cover oracle, never `canSeeObject`), keyed so the zone id is not revealed; the zone and covered objects are absent. An `objects` scope gets the covers of every board its objects are on (a contained object counts on its outermost container's board).
- D15 Log filtering for characters is by current visibility, per effect variant (PROTOCOL §7.6): effects limited to what the viewer can see now, `names` entries only for objects whose `name` cell the viewer can read, an object that no longer exists counts as invisible, groups with nothing left omitted, header kept except that `label` is `null` unless every effect of the group (other than id bookkeeping) is visible to the viewer unreduced.
- D16 Explain: `explain_cell` returns content (source, override, whether it parses), the recorded dependency tree to depth ≤ 4 and ≤ 200 nodes with values (for characters: hidden cells named without value, invisible objects as `object: null`), the error-origin chain and the last writing group; `explain_group` returns effects plus the origin action's current definition; `explain_action` returns the `when` source, value and enabled state, and step text. An explain target the viewer cannot see (object, cell, group) answers exactly the same `not_found` as a nonexistent one.
- D17 MCP tools: `table_info`, `list_objects`, `get_objects`, `evaluate`, `zones`, `at_position`, `changes_since`, `log`, `explain_cell`, `explain_group`, `explain_action`, `transact`, `undo`, `save`, `subscribe`, `poll_changes`, `unsubscribe`; input schemas generated from the protocol schemas; rejected writes return `isError: true`; resources `vtt://docs/formulas`, `vtt://docs/design`, `vtt://docs/protocol`, `vtt://schema/ops`, `vtt://subscriptions/<handle>`.
- D18 MCP subscribe: a change buffer per subscription in the MCP process under a stable MCP handle (unchanged when the protocol subscription id changes on reconnect), drained by `poll_changes` (long poll ≤ 30 s), plus `notifications/resources/updated` on `vtt://subscriptions/<handle>`; records carry cell changes and object flag and action changes; cap 1,000 records, then `overflowed`, after which the agent re-reads the subscription resource for current state.
- D19 `invoke` is part of protocol v1 and answered `unsupported` until M5; M5 adds its MCP tool together with the UI's buttons.
- D20 Actions are defined by the `setActions` primitive (vtt-75c.18; its own rows) — referenced, no row here.
- D21 Limits (PROTOCOL §10): `max_message_bytes` 1 MiB applies to client-to-server frames only; server-to-client messages have no size limit, so an initial view of a few-thousand-object table is one response (chunked delivery is Later); the slow-consumer threshold `max_buffered_bytes` is 64 MiB (closed 4429); the other limits as in the table. Formula cost stays under the engine budget.
- D22 Ordering: each connection's messages are handled one at a time in arrival order; every method except `save` is handled synchronously, so commits are totally ordered by revision, every connection receives every commit event in revision order, and the committer receives the commit event before its response; `save` awaits file I/O while other connections proceed.
- D23 Reconnection: no server-side resumption; the client re-sends `hello` with the same `client.instance`, resubscribes and replaces its mirrors with full views (`resync`); requests never written to a socket fail `disconnected`, while a write already sent whose outcome cannot be settled reports `uncertain` (D8); a resubscribe that fails for a transport reason (socket closed, timeout) leaves the subscription `recovering` and is retried on the next connection, while an error response from the server (e.g. `not_found`) makes it terminal (an `error` report with the server's code, mirror emptied, the subscription object or MCP handle kept); the client is ready for ordinary callers only once every live subscription is resubscribed or terminal, and until then reports the connection error `disconnected` with `recovering: true`; every live mirror's revision advances on every processed commit, including commits with no delta for it; ping every 15 s, two missed pongs terminate.
- D24 Autosave: 2 s after the last commit, at most 10 s after the first unsaved commit, on `save`, and on shutdown. Saves are serialized; each save captures its snapshot and revision synchronously when it starts and marks only that revision saved; the asset list loaded with the file is kept through every save; a failed save is retried after 1 s, 5 s, 30 s, then every 60 s until that revision or a later one is saved; `saved_not_durable` does not mark the revision saved (it is retried like a failure); results are broadcast; shutdown awaits outstanding saves and its final save, never throws for a save failure, reports `{saved, revision, error?}`, and always releases the lock. No automatic compaction in v1 (DESIGN §7 "autosave cadence is M3's" is replaced by this).
- D25 New table and files: a missing file is created with one board `gm_board` named "GM" and no objects; default port 4747; lock and identity paths derived from the canonical (realpath) table path, so symlink aliases share them; lock file `<file>.lock` created exclusively (`wx`), cleaned up on any failure after creation, released only by its owner (nonce check), released on every failed open; table identity file `<file>.table-id` holding a random id, created under the held lock (temp file + rename) and never rewritten; an empty or malformed identity file fails the open (the table file format has no id; this keeps it unchanged).
- D26 Step 5 acceptance writes the hatch as an ordinary cell `pattern: "hatch"` (M4 decides appearance cells) and authors the Fireball card from scratch.
- D27 Runtime dependencies: `ws` 8.22.0 (+ `@types/ws` 8.18.2), `@modelcontextprotocol/server` 2.3.1 (+ `@modelcontextprotocol/client` 2.3.1 for tests), `tsx` 4.23.15 to run the binaries, `zod` 4.6.7. Add a CLAUDE.md line: new runtime dependencies are pinned exactly and recorded in the decision log.
- D28 `evaluate` (ad hoc formulas) is GM-only.
- D29 `at_position`: objects directly on the board whose evaluated footprint contains the point (boundary inclusive; shapeless: anchor within epsilon), zones listed separately, both ascending `z` then id; contained objects excluded.
- D30 A GM-only `document` method returns the canonical snapshot and retained log; no MCP tool.
- D31 Board removal is `removeBoard` (vtt-75c.18) — referenced, no row here.
- D33 Stale locks: v1 refuses stale locks; takeover is manual via `vtt-serve --force-unlock` (no automatic takeover, because no file-system protocol available here can tell a stale lock from a live one created between read and takeover).
- D32 Compatibility: the authority parses client messages strictly (unknown keys are `bad_request`); clients parse server messages forward-compatibly (unknown keys ignored, unknown message types and event kinds ignored with a warning, unknown `EffectView` variants dropped with a warning, never a disconnect for these); a response's `result` is validated by the client against the schema of the pending request's method (looked up by id), and a result that fails it fails that request only; a change that breaks a v1 client bumps `protocol` (PROTOCOL §12).

#### PROTOCOL.md contract

Types are written in TypeScript notation; `ObjectId`, `BoardId`, `Shape`, `ErrorCode`, `ActionDef`, `Actor`, `Board`, `Snapshot`, `OpGroup`, `Rejection` and the scalar value types (`NumberValue`, `TextValue`, `BooleanValue`, `EmptyValue`, `DiceValue`, `RollValue`, `InkValue`, `ShapeValue`) are those of `@vtt/schema` (DESIGN §4, §7; FORMULAS §2). Client-to-server messages are parsed strictly: unknown keys are rejected. Server-to-client messages are parsed loosely: unknown keys are dropped (§12). `__proto__` is rejected as a key anywhere in either direction (as FIXTURES §1).

##### §1 Transport, framing, envelope, close codes

- One WebSocket per client at `ws://127.0.0.1:<port>/ws`; JSON text frames, one message per frame; every message has a `type`.
- Client → server: `hello`, `request`. Server → client: `welcome`, `response`, `event`, `goodbye`.
- `CLOSE_CODES = {protocol: 4400, unauthorized: 4401, hello_timeout: 4408, slow_consumer: 4429, shutdown: 1001}`.
- The HTTP server answers `GET /healthz` with `200 {"ok":true,"revision":n}` and 404 elsewhere; upgrades only on `/ws`.

##### §2 Handshake, authentication, origin, discovery, new table

```ts
{ type: "hello"; protocol: 1; token: string;
  client: { name: string /* 1–100 chars */; kind: "ui" | "agent" | "test"; instance: string /* 1–64 chars of [A-Za-z0-9_-] */ };
  agent_name?: string /* 1–100 chars */ }
{ type: "welcome"; protocol: 1; session: string; actor: Actor; revision: number; boards: BoardView[];
  table: { name: string; path: string | null; id: string | null }; limits: Limits }
{ type: "goodbye"; reason: string }
```

- The first client message must be `hello` within 5 s (else close 4408). Wrong token (constant-time comparison) or a non-`hello` first message: `goodbye` + close 4401. `protocol` other than 1: `goodbye` + close 4400.
- `session` identifies the authority process run: random, fixed for the life of the process, different after every restart. `client.instance` is chosen by the client (e.g. a UUID per client object) and reused across its reconnects; it scopes `txn_id` deduplication (§6).
- `table.name` is the file's basename, `table.path` its absolute real path, `table.id` the content of `<file>.table-id` (both null for an in-memory table).
- Origin: an upgrade whose `Origin` header is present and is neither `http://127.0.0.1:<port>`, `http://localhost:<port>` nor an `--allow-origin` entry is refused with HTTP 403. Bind 127.0.0.1 only. The token is 32 random bytes, base64url, per server start unless fixed with `--token`.
- Discovery (D5): `$XDG_CONFIG_HOME/vtt/session.json` (default `~/.config/vtt/session.json`), `{url, token, pid, table_path, table_id}`, directory 0700, file 0600, removed on shutdown only when its pid matches. Credential refresh: a client constructed from discovery records `table_path` and `table_id` at its first successful `welcome` (it may start before the authority is reachable) and re-reads the file before every reconnect attempt; it adopts the file's `url` and `token` only when both match, otherwise it stops (`closed`) and reports `wrong_table`; a missing file means keep retrying with the last credentials (or, before the first `welcome`, keep waiting for the file). Whatever credentials were used, the reached authority's `welcome.table` is checked against the captured identity (§8). A client constructed with explicit credentials never re-reads: a 4401 is terminal and reported as `unauthorized`, and writes in flight report `uncertain`. Before the first `welcome` every client reports the connection error `disconnected`.
- New table (D25): `vtt-serve` on a missing file creates it with one board `gm_board` named "GM", no objects, revision 0, empty log. Paths: `<file>` below is the canonical table path, `realpath` of the table file, or `realpath` of its directory joined with its basename when the file does not exist yet; symlink aliases therefore share one lock and one identity file. Lock file `<file>.lock` (`{pid, nonce, host, started}`): acquire = `open(lock, "wx")` (exclusive create), write the content, fsync, close; any failure after the open unlinks the lock this process created (after checking its nonce) and rethrows. On `EEXIST` the lock is read and the start is refused (`locked`) with the recorded `pid`, `host`, `started` and `stale` (true only when `host` is this host and the pid is not alive); unreadable or malformed content is `locked` with `stale: false`. No code path takes over a lock automatically: removing a stale lock is a human decision, made with `vtt-serve --force-unlock`, which unlinks the lock file before acquiring and logs what it removed. Release unlinks the lock only if it still holds the owner's nonce, and is idempotent. Every failed open (load error, corrupt file, initial-save failure) releases the lock. Table identity: `<file>.table-id` (a random UUID, one line), initialized only while the table lock is held: an existing file is read; a missing one is created by writing `<file>.table-id.tmp-<nonce>` and renaming it to the final name (safe because the lock serializes writers), the temp file removed on failure; an existing file that is empty or malformed fails the open with `TableIdentityError` (a human fixes or deletes it; it is never rewritten automatically). Default port 4747.

##### §3 Actors

`client.kind: "agent"` → `{type:"agent", name: agent_name ?? client.name}`; `ui`, `test` → `{type:"gm"}`. A non-agent connection may pass `actor: {type:"character", id}` on `transact` naming an existing object with `is_character` true; an agent passing `actor` is `bad_request`. Every connection has GM authority; `viewer` parameters select whose view is computed.

##### §4 Requests, responses, methods

```ts
{ type: "request"; id: string /* 1–64 chars */; method: M; params: Params<M> }
{ type: "response"; id: string; ok: true; result: Result<M> }
{ type: "response"; id: string | null; ok: false; error: ProtocolError }   // id null when the request id could not be read
type Viewer = { type: "gm" } | { type: "character"; id: ObjectId };
type ObjRef = ObjectId | BindingName;   // BindingName: "$" followed by id characters
```

Methods (17; `viewer` defaults to `{type:"gm"}`; kind in brackets):

| Method | Params | Result |
|---|---|---|
| transact [write] | `base_revision: number`, `ops: WireOp[]` (1..max_ops), `label?: string` (≤ 200), `txn_id?: string` (1–64), `retry?: true` (only with `txn_id`; set on a client resend, §6), `actor?: Actor` (character only, §3) | `TransactResult` = `{status:"committed", revision, index, created: {op_index, id}[], copies: {op_index, root, copies: Record<ObjectId,ObjectId>}[], bindings: Record<BindingName, ObjectId>}` or `{status:"rejected", rejection: ProtocolRejection, op_index?: number}` |
| undo [write] | `target: {type:"latest"} \| {type:"mine"} \| {type:"actor", actor: Actor} \| {type:"group", index: number}`, `expect_index?: number`, `label?: string` | `TransactResult`; `created`, `copies`, `bindings` empty |
| invoke [write] | `object: ObjectId`, `action: string`, `base_revision: number` | always error `unsupported` until M5 |
| save [write] | `{}` | `{status: "saved" \| "saved_not_durable" \| "failed", revision: number, message?: string}` (`revision` = the revision the save captured) |
| list_objects [query] | `viewer?`, `filter?: {board?, container?, tag?, name?, is_template?, is_zone?, is_character?}`, `cells?: "all" \| "structural" \| string[]` (default `"structural"`), `cursor?: string`, `limit?: number` (default 50, ≤ max_page) | `{revision, objects: ObjectView[], next_cursor: string \| null}` |
| get_objects [query] | `ids: ObjectId[]` (1..max_ids), `viewer?`, `cells?` (default `"all"`) | `{revision, objects: ObjectView[], missing: ObjectId[]}` |
| evaluate [query] | `source: string` (≤ max_source_length), `this?: ObjectId` | `{revision, value: WireResult}` (GM only, unredacted) |
| zones [query] | `board: BoardId`, `viewer?` | `{revision, zones: {id, contents: ObjectId[], error?: ErrorCode, view: ObjectView}[]}` |
| at_position [query] | `board: BoardId`, `position: [number, number]`, `viewer?` | `{revision, objects: ObjectId[], zones: ObjectId[]}` |
| changes_since [query] | `revision: number`, `viewer?`, `limit?: number` (default 100, ≤ max_groups) | `{revision, floor, groups: GroupView[], truncated: boolean, more: boolean, next_revision: number}` (§9) |
| log [query] | `before?: number`, `limit?` (default 50, ≤ max_page), `viewer?`, `effects?: boolean` | `{first_index, next_index, undo_barrier, groups: GroupView[]}` newest first |
| document [query] | `{}` | `{snapshot: Snapshot, log: {first_index, groups: OpGroup[], undo_barrier}}` (GM only, canonical, unfiltered) |
| explain_cell [explain] | `object`, `cell`, `viewer?`, `depth?` (1..max_explain_depth, default 1) | `ExplainCellResult` |
| explain_group [explain] | `index: number`, `viewer?` | `ExplainGroupResult` |
| explain_action [explain] | `object`, `action`, `viewer?` | `ExplainActionResult` |
| subscribe [subscribe] | `scope: {type:"board", board} \| {type:"objects", ids: ObjectId[] (1..max_ids), subtree?: boolean} \| {type:"all"} \| {type:"log"}`, `viewer?`, `cells?: "all" \| "structural"` (default `"all"`) | `{subscription: string, revision, objects: ObjectView[], covers: Cover[], groups?: GroupView[]}` |
| unsubscribe [subscribe] | `subscription: string` | `{}` |

`list_objects`: filters (`board`: directly on it; `container`: directly in it; `tag`: tag list contains the text; `name`: literal name equal; flags equal), then the viewer's visibility; ordered by id (code point); `cursor` = last id of the previous page; each page reports its revision. `get_objects`: views in request order; nonexistent and invisible ids go to `missing` indistinguishably. `zones`: every `is_zone` object directly on the board visible to the viewer, by id; `contents` in FORMULAS §5 order restricted to visible objects; when `contents(zone)` evaluates to an error value of any code (e.g. `#TYPE`, `#CYCLE`, `#LIMIT`), `contents` is `[]` and `error` is that code; `view` structural; the request never fails for this reason. `log`: `before` is an exclusive absolute index; `first_index`, `next_index`, `undo_barrier` as DESIGN §7. `not_found` applies only to the target ids of query, explain and subscribe methods (unknown board, object or subscription ids in their params), except `get_objects` ids and `objects` scope ids (ignored when absent). Ids inside `transact` and `undo` are never `not_found`: they follow §6's processing order (structural validation, deduplication, actor checks, floor and stale checks, then primitive refusals) and the M2 primitives' rejection semantics, so an unknown object in an op is a rejection `invalid` with its `op_index`, and an object removed since `base_revision` is `stale_write`.

##### §5 Ops, bindings, input values

```ts
type InputValue = NumberValue | TextValue | BooleanValue | EmptyValue | DiceValue | RollValue | InkValue | ShapeValue
  | { type: "list"; items: InputValue[] } | { type: "ref"; object: ObjRef } | InputViewers;
type InputViewers = { type: "viewers"; viewers: ("all" | "gm" | "owner" | { type: "ref"; object: ObjRef })[] };
type InputCellContent = InputValue | { type: "formula"; source: string };
type Destination = { type: "board"; board: BoardId; position: [number, number] }
                 | { type: "container"; container: ObjRef; index?: number };
type ObjectInit = { is_template?: boolean; is_zone?: boolean; is_character?: boolean; tag?: string[]; shape?: Shape;
                    cells?: Record<string, InputCellContent>; cell_visibility?: Record<string, InputViewers>; actions?: ActionDef[] };
```

`WireOp` = one of the 19 kinds in the table below, each `{type: <op>, ...its fields}`; every `object`, `container`, `template` field is an `ObjRef`. Each op maps to one M2 primitive and declares intended-write keys (§6) computed from its fields before execution (a key naming a `$binding` is omitted; destination key: `board:<board>` for a board destination, `cell:<container>/contents` for a container destination):

| Op | Fields | Primitive | Declared keys |
|---|---|---|---|
| set_value | object, cell, value: InputValue | writeValue | `cell:<object>/<cell>` |
| set_formula | object, cell, source | setFormula | `cell:<object>/<cell>` |
| clear_override | object, cell | clearOverride | `cell:<object>/<cell>` |
| delete_cell | object, cell | deleteCell | `cell:<object>/<cell>` |
| rename_cell | object, from, to | renameCell | `cell:<object>/<from>`, `cell:<object>/<to>` |
| set_cell_visibility | object, cell, viewers: InputViewers \| null | setCellVisibility | `cell:<object>/<cell>` |
| set_tag | object, tags: string[] | setTag | `cell:<object>/tag` |
| set_shape | object, shape: Shape \| null | setShape | `cell:<object>/shape` |
| set_template_flag | object, value: boolean | setTemplateFlag | `cell:<object>/is_template` |
| set_character_flag | object, value: boolean | setCharacterFlag | `cell:<object>/is_character` |
| set_actions | object, actions: ActionDef[] | setActions | `actions:<object>` |
| reorder | container, permutation: number[] | reorder | `cell:<container>/contents` |
| add_board | id, name? | addBoard | `board:<id>` |
| rename_board | id, name | renameBoard | `board:<id>` |
| remove_board | id | removeBoard | `board:<id>` |
| create_object | id?, as?: BindingName, to: Destination, init?: ObjectInit | createObject | `obj:<id>` when `id` is given; destination key |
| spawn | template, to: Destination, cells?: Record<string, InputCellContent>, as?: BindingName, owned?: Record<ObjectId, BindingName> | spawn | `obj:<template>`; destination key |
| move | object, to: Destination | move | `cell:<object>/board`, `cell:<object>/position`; destination key |
| remove | object | remove | `obj:<object>` |

Bindings: `as` on `create_object` binds the created id, `as` on `spawn` the root copy, `owned` maps template-subtree ids (plain ids) to bindings for their copies. A binding is introduced at most once and used only after its introduction (op order); uses are replaced by the bound id in id positions and inside input values at any depth (lists, viewers entries). Bindings exist only within one `transact`; views and results never contain unresolved binding references (every id in them is a real id); `TransactResult.bindings` maps binding names to the ids allocated for them. Default label: the single op's type and target (`"set_value goblin1.hp"`), else `"<n> edits"`.

##### §6 Revisions, stale writes, deduplication

- Revisions: each commit increments the revision by one (DESIGN §7); `base_revision` must be an integer between 0 and the current revision (`bad_request` otherwise).
- Floor: the `base_revision` of the oldest group in the contiguous run of retained groups that ends at the current revision; the current revision when there is no such run (no retained groups, or the newest group's revision differs from the current one after a hand edit).
- Processing order of a `transact` (precedence top to bottom): (1) structural validation, independent of the document (schema, `txn_id` shape, op count and size limits, `label` length, binding introduction and use order, `actor` allowed for the connection kind) → `bad_request` error (not a rejection, not stored); (2) deduplication lookup; (2b) on a miss, state validation (`base_revision` within 0..current, `actor` names an existing object whose `is_character` is true) → `bad_request`, not stored; (3) `base_revision` < floor → rejected `stale_write` with `truncated: true` and no conflicts; (4) when `base_revision` < current revision, the declared keys of all ops (§5) are checked against every retained group with `revision > base_revision` (undo groups included) → rejected `stale_write`; (5) the ops run in order in one transaction; a primitive refusal → rejected with that op's `op_index` (0-based), nothing applied; (6) the touched keys (DESIGN §7) of the transaction's effects are checked against the same groups → rejected `stale_write`, the transaction aborted with nothing applied and no randomness consumed; (7) commit.
- Keys conflict when equal, or when one is `obj:<id>` and the other names `<id>` (DESIGN §7). A conflict entry lists the group's own keys that conflict with the checked set, so a write to an object removed since reports the removal's `obj:<id>`.
- `stale_write` rejection: `{type:"stale_write", base_revision, revision /* current */, floor, truncated, conflicts: {index, revision, actor, label, keys: string[]}[]}`.
- Undo takes no `base_revision` and is never stale-checked. `target: {type:"mine"}` = the connection's actor. With `expect_index`, a different selected target (or none) is rejected `{type:"undo_target_changed", expected, actual: number | null}`.
- Deduplication (D8): key (`client.instance`, `txn_id`); fingerprint = canonical JSON (keys sorted) of the full `transact` params except `retry`. Committed and rejected results are stored, the last `max_txn_ids_per_client` (1,000) per instance, oldest evicted. Same key and fingerprint: the stored result is returned, nothing executes. Same key, different fingerprint: `{status:"rejected", rejection: {type:"invalid", message:"txn_id reused with different params"}}`. A `transact` with `retry: true` whose key is not retained (evicted, never received, or lost on restart) is answered with error `retry_unknown` and does not execute. The store is in memory and is lost on restart, which changes `session`.
- Client retries: a client may resend a `transact` whose response was lost only after reconnecting to an authority with the same `session`, once, with the same `txn_id` and `retry: true`; a stored result is returned as usual. Once a write (`transact` or `undo`) has been written to a socket, every outcome that is not settled by a response is reported as error `uncertain` when safe recovery is exhausted: a response timeout, socket loss before the response (for `undo`, and for a `transact` without retry), loss of the single resend's response, `retry_unknown`, a `session` change before the resend, terminal `unauthorized` or `wrong_table`. The client never resends twice. `disconnected` is reserved for requests that were never written to a socket.

##### §7 Views, values, redaction, covers, group views

§7.1 Values:

```ts
type RedactedValue = { type: "redacted" };
type WireValue = NumberValue | TextValue | BooleanValue | EmptyValue | DiceValue | RollValue | InkValue | ShapeValue
  | { type: "list"; items: WireValue[] } | { type: "ref"; object: ObjectId } | WireViewers | RedactedValue;
type WireViewers = { type: "viewers"; viewers: ("all" | "gm" | "owner" | { type: "ref"; object: ObjectId } | RedactedValue)[] };
type WireError = { type: "error"; code: ErrorCode; message?: string; origin?: { object: ObjectId; cell: string } };
type WireResult = WireValue | WireError;
```

§7.2 Object views:

```ts
type CellView = { value: WireResult; kind: "literal" | "formula" | "structural";
                  source?: string; overridden?: boolean; visibility?: WireViewers };
type ActionView = { name: string; when?: string; steps?: string[] };
type ObjectView = { id: ObjectId; is_template: boolean; is_character: boolean;
                    cells: Record<string, CellView>; actions: ActionView[] };
type BoardView = { id: BoardId; name?: string };
```

`kind`: a cell whose stored content is a formula is `"formula"` (also for structural cells such as `position` or `visible_to`, and also when an override is present, which `overridden` reports); a cell with no stored content (field-backed, such as `tag`, `contents`, `board`, or a default) is `"structural"`; every other cell (a stored literal, structural or not) is `"literal"`. GM: every stored user cell plus every readable structural cell except `id` (defaults included; `STRUCTURAL_VIEW_CELLS`), `source` and `overridden` on formula cells, `visibility` when the object has a `cell_visibility` entry for that cell, actions with `when` and `steps`. Character: the object only when the viewer can effectively see it (DESIGN §4.4, cover included); a cell only when the viewer can see it; no `source`, no `visibility`; actions with `name` only. `cells: "structural"` restricts to `STRUCTURAL_VIEW_CELLS`, a list to those names.

§7.3 Redaction (character views only, everywhere a value appears): a ref to an object the viewer cannot see, or to an id that is neither a live object nor a board, becomes `{type:"redacted"}` in place, at any depth of lists and in viewers entries; a ref to a board id is kept (the `board` structural cell of a visible token keeps its board ref); an error whose `origin` names an object or cell the viewer cannot see becomes `{type:"error", code}`.

§7.4 Face-down: a face-down object shows to a viewer who can see it exactly the cells of vtt-75c.10's `FACE_DOWN_EXEMPT` (`name`, `board`, `position`, `rotation`, `z`, `container`, `face_up`, `shape`) beyond what its owner rule allows (DESIGN §4.4).

§7.5 Covers:

```ts
type Cover = { key: string; board: BoardId;
               region: { position: [number, number]; rotation: number; shape: Shape } | { whole_board: true } };
```

For each board in scope, the zones directly on that board that are not effectively visible to the viewer (`isEffectivelyVisible(zone, viewer)` false; the predicate M2's cover oracle uses; `canSeeObject` is never used here, so a zone under another opaque zone does not produce a cover of its own unless it is itself not effectively visible) are classified by this table, which matches M2's cover oracle after vtt-75c.19 exactly, so drawn covers and object visibility agree:

| Zone state | M2 oracle | Presentation |
|---|---|---|
| geometry (`position`, `rotation`, `shape`) unreadable or invalid, any `opaque` | `undetermined` | `Cover` with `{whole_board: true}` |
| valid geometry, `shape` absent or empty | covers nothing | no `Cover` |
| valid geometry with a shape, `opaque` true, an error, or a non-boolean | `covering` when the anchor is inside | `Cover` with `{position, rotation, shape}` (`rotation` empty → 0) |
| valid geometry with a shape, `opaque` false | covers nothing | no `Cover` |

A region `Cover` is produced only for a non-empty shape. `key` is stable per zone for the life of the authority process and does not contain the zone id. GM views have no covers. Boards in scope: `board` scope its board; `all` every board; `objects` every board one of its objects is on (a contained object counts on its outermost container's board); `log` none.

§7.6 Group views:

```ts
type GroupHeader = { index: number; revision: number; actor: Actor; kind: "edit" | "action" | "undo"; label: string | null };   // null only in character group views
type GroupView = GroupHeader & { base_revision: number; origin?: { object: ObjectId; action: string };
                 undoes?: number; undone: boolean; names: Record<ObjectId, string>; effects?: EffectView[] };
type CellStateView = { kind: "literal"; value: WireValue } | { kind: "formula"; source?: string; override?: WireValue };
type LocationView = { type: "board"; board: BoardId } | { type: "container"; container: ObjectId | null; index: number };
type ObjectSnapshotView = { id: ObjectId; is_template: boolean; is_zone: boolean; is_character: boolean;
  tag?: string[]; shape?: Shape | null; contents?: (ObjectId | null)[];
  cells: Record<string, CellStateView>; cell_visibility?: Record<string, WireViewers>; actions: ActionView[] };
type EffectView =
  | { type: "cell"; object: ObjectId; cell: string; before: CellStateView | null; after: CellStateView | null; cause: "edit" | "roll" }
  | { type: "cell_visibility"; object: ObjectId; cell: string; before: WireViewers | null; after: WireViewers | null }
  | { type: "field"; object: ObjectId; field: "tag"; before: string[]; after: string[] }
  | { type: "field"; object: ObjectId; field: "shape"; before: Shape | null; after: Shape | null }
  | { type: "field"; object: ObjectId; field: "is_template" | "is_character"; before: boolean; after: boolean }
  | { type: "field"; object: ObjectId; field: "actions"; before: ActionView[]; after: ActionView[] }
  | { type: "place"; object: ObjectId; before: LocationView; after: LocationView }
  | { type: "create" | "remove"; location: LocationView; objects: ObjectSnapshotView[] }
  | { type: "reorder"; container: ObjectId; before: (ObjectId | null)[]; after: (ObjectId | null)[] }
  | { type: "board"; before: Board | null; after: Board | null }
  | { type: "allocate"; ids: ObjectId[]; seq_before: number; seq_after: number }
  | { type: "retire"; ids: ObjectId[] };
```

GM: the group's fields plus `undone`; effects converted losslessly (literal content → `{kind:"literal", value}`, formula → `{kind:"formula", source, override?}`, snapshots with every field, actions with `when` and `steps`). Character, by visibility at the view's revision (an object that does not exist then counts as invisible), per variant: `cell` kept iff the object is visible and the cell readable, no `source`, values redacted; `cell_visibility` dropped; `field` `tag`/`shape` kept iff that cell is readable, `is_template`/`is_character` iff the object is visible, `actions` iff the object is visible with names only; `place` kept iff the object is visible and its `board` and `container` cells readable, a container the viewer cannot see shown as `null`; `create`/`remove` kept iff at least one of its objects is visible, `objects` limited to the visible ones, each with only readable cells, no `source`, no `cell_visibility`, actions names only, `tag`/`shape`/`contents` omitted when unreadable and invisible contents ids as `null`, a hidden location container as `null`; `reorder` kept iff the container is visible and its `contents` readable, invisible ids as `null`; `board` always kept; `allocate`, `retire` dropped. `names[id]` present only when the viewer can see object `id` and read its `name` cell. `label`: kept only when every effect of the group other than `allocate`/`retire` is kept unreduced for the viewer (no effect dropped, no cell, object, value or id omitted, nulled or redacted); otherwise `null`, and clients show the group's `kind`. Commit-event headers go to connections (GM authority) and always carry the label. A character group view whose names and filtered effects are both empty is omitted (null); the decision is the same whether or not effects are requested. Otherwise its header is kept.

##### §8 Subscriptions, commit events, ordering, reconnection

- Scopes at a revision: `board` = every object directly on the board and, recursively, their contents; `objects` = the ids (with `subtree`, also their descendants); `all` = every live object; `log` = no objects, the window of the newest `max_log_window` (200) retained groups. At most `max_subscriptions` per connection (`busy`). Subscription ids are opaque strings.
- `subscribe` returns full views and covers (§7.5); for `log`, `groups` = the window's group views newest first (character nulls omitted), `objects` and `covers` empty.
- Events:

```ts
{ type: "event"; event: "commit"; revision: number; group: GroupHeader; boards?: BoardView[]; deltas: SubscriptionDelta[] }
{ type: "event"; event: "save"; status: "saved" | "saved_not_durable" | "failed"; revision: number; message?: string }
type SubscriptionDelta = { subscription: string; objects: ObjectView[]; removed: ObjectId[];
  covers?: { upsert: Cover[]; removed: string[] }; groups_upserted?: GroupView[]; groups_removed?: number[] };
```

- One `commit` event per commit to every ready connection; `boards` (all boards) present when the group has any `board` effect; `deltas` holds one entry per subscription of that connection whose views changed (`[]` when none). `objects` = views whose content changed (whole views), `removed` = ids that left scope, were removed or became invisible; covers diffed by key; for `log`: `groups_upserted` = group views new to the window or changed (an undone group re-sent with `undone: true`; older groups whose filtered view changed after a reveal, hide or remove), `groups_removed` = indices that left the window or became omitted. Applying every delta to the initial result yields what a fresh `subscribe` at that revision returns. Board creation and removal (including undo) are visibility-relevant for character subscriptions: object views holding refs to that board (for example in viewers values) are rebuilt, and log-window group views holding refs to it are rebuilt (`redacted` while the board is gone, restored on undo).
- Evaluation (FORMULAS §7): after each commit the authority evaluates what the changed subscribed views need: their cells, those cells' transitive dependencies, and the visibility and geometry inputs the views and covers need, even outside the scope; every other dirty cell stays dirty until read.
- Ordering (D22): per connection, one message at a time in arrival order (the next waits for the previous response); all methods but `save` are synchronous; commit events are sent before the committing request's response; every connection sees commit events in revision order; a `save` response follows its `save` event.
- Heartbeat: ws ping every 15 s; two missed pongs terminate the connection.
- Reconnection (D23): no resumption. The client reconnects with backoff, sends `hello` with the same `client.instance`, resubscribes every live subscription with its original params (the subscription id may change), replaces its mirrors and reports a `resync` (`from_revision`, `to_revision`, `session_changed`). A resubscribe that fails for a transport reason (socket closed or timeout) keeps that subscription `recovering` (mirror kept, not updated) and it is resubscribed on the next connection; a resubscribe answered with an error response (e.g. `not_found` for a board removed meanwhile) makes it terminal: an `error` report with the server's `ProtocolError`, its mirror emptied, the subscription object (and an MCP handle) kept but no longer updated. The client becomes ready for ordinary callers only when every live subscription is resubscribed or terminal; until then `connectionError()` is `{code: "disconnected", recovering: true}`. Pending queries fail `disconnected`; writes per §6. Credentials are refreshed per §2. Every successful reconnect's `welcome.table.path` and `welcome.table.id` are compared with the identity captured at the first `welcome` before any subscription is rebound or any write is retried; a mismatch is `wrong_table`: terminal with explicit credentials; with discovery, the client re-reads the session file and retries once with its credentials, and a second mismatch is terminal.
- Mirror revision: on every processed commit event the client advances every live mirror's `revision` to the event's revision, also for subscriptions with no delta in it; after a processed commit a mirror's revision equals the client's revision.

##### §9 Explain, evaluate, at_position, changes_since, document

```ts
type DepNode = { type: "cell"; object: ObjectId | null; cell: string; value?: WireResult; hidden?: true; dependencies?: DepNode[] }
             | { type: "exists"; object: ObjectId | null; exists?: boolean } | { type: "index" };
type ExplainCellResult = { revision: number; object: ObjectId; cell: string; view: CellView;
  content: { type: "literal" } | { type: "structural" } | { type: "formula"; source?: string; overridden: boolean; parses: boolean; syntax_error?: string };
  dependencies: DepNode[]; truncated: boolean;
  error_chain?: { object: ObjectId | null; cell: string | null; code: string }[];
  last_write?: GroupHeader & { cause: "edit" | "roll" } };
type ExplainGroupResult = { group: GroupView; action?: { object: ObjectId; name: string; when?: string; steps: string[]; current: true } };
type ExplainActionResult = { object: ObjectId; action: string; enabled: boolean; reason?: "when_false" | "when_error";
  guard?: { source?: string; value: WireResult }; steps?: string[] };   // guard present only when the action has a `when`
```

- `explain_cell`: the cell's value first (forcing evaluation), then its recorded dependencies breadth first to `depth`, each cell expanded once, at most `max_explain_nodes` nodes (`truncated` when cut); `error_chain` follows error origins to a self-originating error or a repeat, at most 32 steps; `last_write` = the header of the newest retained group with a `cell` effect on that cell, as the viewer would see it in the log (§7.6: for a character, `label` is `null` unless every effect is visible unreduced; omitted when that group's view is omitted for the viewer). Character viewer: a dependency cell it cannot see is `{type:"cell", object, cell, hidden: true}` without value; a dependency on an object it cannot see has `object: null` and no value; no `source`; values redacted; error-chain entries on invisible objects or cells have `object: null` or `cell: null`.
- `explain_group`: the group view with effects (§7.6) and, for the GM when the origin object still exists, the origin action's current definition (`current: true`).
- `explain_action`: `enabled` (top level) is true iff the action has no `when` or its `when`, evaluated with `this` = the object, is `true`; `reason` (top level, only when not enabled) is `when_false` (any non-error non-true value) or `when_error`; `guard` is present only when there is a `when`, with its `value` and, for the GM, its `source`; `steps` GM only. An action without `when` gives `{enabled: true}` with no `reason` and no `guard`, for every viewer.
- Not found: a nonexistent object, cell, action or group, and one the viewer cannot see (invisible object, unreadable cell, omitted group), answer the identical error `{code:"not_found", message:"not found"}`.
- `evaluate` (D28): GM only; `source.length` > `max_source_length` is `bad_request`; unknown `this` is `not_found`; without `this` the engine's ad hoc default.
- `at_position` (D29): candidates from the spatial index at the point; `objects` = non-zone objects directly on the board whose evaluated footprint contains the point (boundary inclusive; shapeless within epsilon), ascending `z` (empty = 0) then id; `zones` likewise; both filtered by the viewer's visibility. A candidate whose evaluated `position`, `rotation`, `shape` or `z` is an error (including `#LIMIT` from an exhausted budget) has no geometry and is omitted, as the spatial index treats non-finite bounds; the request never fails for this reason.
- `changes_since`: scans retained groups with `revision > params.revision`, oldest first, at most `limit` scanned; returns the non-omitted group views among them with effects; `more` = retained groups remain after the last scanned; `next_revision` = the `revision` of the last scanned group (its `base_revision` + 1), or the current revision when none was scanned; passing `next_revision` back as `revision` continues after the scanned groups, so pages of only invisible groups still advance. `truncated` = `params.revision` < `floor` (§6; with no retained groups the floor is the current revision); `params.revision` above the current revision is `bad_request`.
- `document` (D30): GM only; canonical `Snapshot` and retained log, unfiltered.

##### §10 Errors, rejections, limits

```ts
type ProtocolError = { code: ProtocolErrorCode; message: string; details?: unknown };
type ProtocolErrorCode = "bad_request" | "unknown_method" | "unauthorized" | "protocol_version" | "busy"
  | "too_large" | "not_found" | "unsupported" | "internal" | "disconnected" | "timeout" | "uncertain" | "wrong_table"
  | "retry_unknown";
type Rejection =   // @vtt/schema, complete
  | { type: "protected_cell"; object: ObjectId; cell: string }
  | { type: "containment_cycle"; object: ObjectId; container: ObjectId }
  | { type: "undo_conflict"; target: number; conflicting: number[]; message: string }
  | { type: "nothing_to_undo" }
  | { type: "type_error"; object: ObjectId; cell: string; expected: string }
  | { type: "invalid"; message: string };
type ProtocolRejection = Rejection
  | { type: "stale_write"; base_revision: number; revision: number; floor: number; truncated: boolean;
      conflicts: { index: number; revision: number; actor: Actor; label: string; keys: string[] }[] }
  | { type: "undo_target_changed"; expected: number; actual: number | null };
type Limits = { max_message_bytes: 1048576; max_ops: 1000; max_page: 200; max_ids: 200; max_subscriptions: 16;
  max_explain_depth: 4; max_explain_nodes: 200; max_source_length: 10000; max_groups: 500; max_log_window: 200;
  max_txn_ids_per_client: 1000; max_requests_per_second: 200; max_buffered_bytes: 67108864 };
```

- Errors are protocol failures (the request was not processed as a command); rejections are command outcomes (`status: "rejected"`). `disconnected` (only for requests never written to a socket), `timeout` (queries only; a timed-out write is `uncertain`), `uncertain` and `wrong_table` are produced by the client library only; `retry_unknown` is produced by the authority (§6) and mapped to `uncertain` by the client. A response whose `result` fails the schema of the pending request's method rejects that request on the client with `{code: "internal", message, details: {type: "protocol", method}}`; the connection stays open and no mirror changes. An unparseable request answers `bad_request` and the connection stays open; any unexpected server exception answers `internal` and the connection stays open.
- `max_message_bytes` applies to client-to-server frames only (a larger frame closes the connection); server-to-client messages have no size limit. More than `max_requests_per_second` requests per connection answer `busy` (token bucket). A connection whose unsent buffer exceeds `max_buffered_bytes` is closed 4429.

##### §11 MCP

Tools (17):

| Tool | Behaviour |
|---|---|
| table_info | `{revision, boards, table /* {name, path, id} */, limits, actor, session}` from the client |
| list_objects, get_objects, evaluate, zones, at_position, changes_since, log | the same-named methods |
| explain_cell, explain_group, explain_action | the same-named methods |
| transact | `transact` with `base_revision` required; `txn_id` always generated by the MCP server; a lost response is retried per §6 within 10 s; `uncertain` is reported as an error |
| undo | `undo` (targets `latest`, `mine`, `group`; `expect_index`) |
| save | `save` |
| subscribe | `subscribe` (scopes `board`, `objects`, `all`; GM viewer); returns `{subscription: <handle>, revision, objects: <count>}` |
| poll_changes | `{subscription: <handle>, wait_ms?: 0..30000 (default 0)}` → `{subscription, revision, changes: ChangeRecord[], overflowed: boolean}`; returns and clears the buffer, waiting up to `wait_ms` for the first record |
| unsubscribe | `unsubscribe`, drops the buffer and the handle |

- Input schemas: explicit MCP schemas derived from the protocol params schemas, strict (unknown keys are an MCP input error), with transport-managed fields removed (`transact`: no `actor`, `retry`, `txn_id`) and variants narrowed (`undo` target: `latest`, `mine`, `group`); an input that fails them reaches no handler and sends nothing to the authority. Results are `structuredContent` plus one JSON text block. A `ProtocolError` → `isError: true` with `{code, message}`; `status: "rejected"` → `isError: true` with the rejection and `op_index`.
- Handles: `"m"` + a counter, owned by the MCP process; a handle stays valid across reconnects while the protocol subscription id behind it changes.
- Connection gate: while the client reports a connection error (`disconnected`, including `recovering: true` and the time before the first `welcome`, `unauthorized` or `wrong_table`), every tool, including `table_info` and `poll_changes`, returns `isError: true` with that error instead of its normal result.

```ts
type ChangeRecord =
  | { type: "commit"; revision: number; group: GroupHeader; created: ObjectId[]; removed: ObjectId[];
      cells: { object: ObjectId; cell: string; before?: CellView; after?: CellView }[];
      objects: { object: ObjectId; before?: ObjectFacts; after?: ObjectFacts }[] }
  | { type: "resync"; from_revision: number; to_revision: number; session_changed: boolean }
  | { type: "failed"; code: ProtocolErrorCode; message: string };   // the subscription became terminal (§8)
type ObjectFacts = { is_template: boolean; is_character: boolean; actions: ActionView[] };
```

- Per subscription a buffer of at most 1,000 records; beyond that the oldest is dropped and the next `poll_changes` result has `overflowed: true` (then reset). `objects` lists every object whose flags or actions differ between before and after. Each buffered record sends `notifications/resources/updated` for `vtt://subscriptions/<handle>`; reading that resource returns `{subscription, revision, overflowed, failed: {code, message} | null, objects: ObjectView[] /* current mirror */, changes: ChangeRecord[]}` without clearing, so an agent recovers current state after overflow by reading it. The `revision` of `poll_changes` results and of the resource is the mirror's revision (§8), which equals the client's current revision after a processed commit. A failed subscription's handle stays valid until `unsubscribe`; its polls return the buffered records (ending with the `failed` record) and then empty results.
- Resources: `vtt://docs/formulas`, `vtt://docs/design`, `vtt://docs/protocol` (the docs' text), `vtt://schema/ops` (JSON Schema of `WireOp`, 19 kinds), `vtt://subscriptions/<handle>`.
- Tool descriptions say: ids should be human-meaningful (DESIGN §5.3); writes need the latest `revision`; one `transact` is one undoable group; formulas and actions follow docs/FORMULAS.md.
- `vtt-mcp [--url u] [--token t] [--name n]`, else `VTT_URL`/`VTT_TOKEN`, else the session file (discovery mode, selected whenever no explicit credentials are given, even when the file is missing: the process stays up and connects once the file appears; credentials refreshed per §2 on every reconnect attempt, `wrong_table` stops it; startup fails only for malformed or incomplete explicit credentials); `kind: "agent"`; startup order: MCP initialization first, then `agent_name` = `--name`, else the MCP client's name, else `agent`, then the authority connection with recovery from the start, without requiring an initial successful connection (tools answer `disconnected` until the first `welcome`); stdio; logs to stderr only; while the authority is unreachable tools return `isError` `disconnected` and the client keeps reconnecting.

##### §12 Additive extension

Protocol v1 grows only additively: new optional fields, new methods, new ops, new event kinds. M5 adds `invoke` behaviour, its MCP tool, and face-layout fields on views this way; a change that breaks a v1 client bumps `protocol`.

Compatibility policy (D32): the authority parses client messages strictly (unknown keys anywhere → `bad_request`; `__proto__` always rejected). Clients parse server messages forward-compatibly: unknown keys in any object are ignored (stripped), a message of unknown `type` or an event of unknown `event` kind is ignored with a warning, an unknown `EffectView` variant inside a group view is dropped with a warning; none of these closes the connection. `parseServerMessage` validates only the envelope (`welcome`, `response` with `id` and either `result` or `error`, `event`, `goodbye`); the client validates and normalizes a response's `result` against the result schema of the pending request's method, found by `id` (the wire carries no method on responses); unknown keys inside results, views and effects are stripped at that stage, not by envelope parsing. An envelope that is malformed in a known shape (missing or mistyped required fields) is still invalid; a result that fails its method's schema fails only that request (§10). Because clients ignore unknown keys, a new field must never change the meaning of existing fields; such a change bumps `protocol`.

#### Doc edits

- docs/PROTOCOL.md (new): §1–§12 exactly as the contract above (D3–D30 cross-referenced).
- DESIGN.md §5.2: D1, the tool groups, D7, D21 and the view-as note of D4.
- DESIGN.md §7: Platform paragraph (D1, D2); Revisions (D7, D8); Persistence (D24, D25); a short **Protocol** paragraph pointing to PROTOCOL.md.
- DESIGN.md §4.4: D12, D14, D15, D16 (filtering of query results, explain and the log).
- FORMULAS.md §7 Propagation: "After each commit the authority recomputes what the changed subscribed views need (their cells, those cells' dependencies, and the visibility and geometry inputs of those views) and sends the views that changed; every other dirty cell stays dirty until read."
- CLAUDE.md: `protocol` in the package list (D2); the dependency line (D27).

Done when: every edit above is present; PROTOCOL.md contains every type, table, value and rule of the contract above with the same names (17 methods, 19 ops with their declared keys, 14 error codes, 13 limits, 5 close codes, the `EffectView` variants and their character filtering, the processing order of §6, the `changes_since` cursor, the log window, the credential-refresh, subscription-failure and mirror-revision rules, the lock protocol, the compatibility policy, and the complete `Rejection` union); DESIGN §10 has one row per decision D1–D33 except D13, D20 and D31; no code changes; `pnpm format:check` and `pnpm lint` exit 0.

Out of scope: any code; the M2 docs; vtt-75c.18's two rows; face layouts and action syntax (M5); asset naming and appearance cells (M4); chunked snapshot delivery (vtt-y1w.12) and persistent deduplication (vtt-y1w.11).

Depends on: none.

---

### M3-a — vtt-5su.3 — Protocol: wire schemas and types (@vtt/protocol)

Implements: docs/PROTOCOL.md §1–§10 and §12 (compatibility policy) as written by vtt-5su.2 (the single authoritative contract: every type, field name, method, op, error code, limit and close code is taken from there); DESIGN.md §5.2, §7.

Create `packages/protocol` (`@vtt/protocol`), scaffolded per CLAUDE.md: exports `"."` → `./src/index.ts`, `tsconfig.json` extending the base, `typecheck` script, `vitest.config.ts` with `test.name: "@vtt/protocol"`; dependencies `@vtt/schema` (workspace) and `zod` 4.6.7; also add `"@vtt/protocol": "workspace:*"` and `"zod": "4.6.7"` to `@vtt/authority`'s dependencies (so later authority beads need not edit them); run `pnpm install` and commit `pnpm-lock.yaml` in the same commit. Exclusive files: `packages/protocol/package.json`, `tsconfig.json`, `vitest.config.ts`, `src/index.ts` (created here; later beads add only their own sorted lines), `src/version.ts`, `src/values.ts`, `src/views.ts`, `src/ops.ts`, `src/methods.ts`, `src/messages.ts`, and `test/schema-*.test.ts`. Not owned: `src/client.ts`, `src/mirror.ts` (vtt-5su.7), `src/client/recovery.ts` (vtt-5su.19). Package index rule (CLAUDE.md): one sorted `export * from "./<module>"` line per module.

Modules and exports:

- `version.ts`: `PROTOCOL_VERSION = 1`, `DEFAULT_PORT = 4747`, `LIMITS` (the `Limits` object of PROTOCOL.md §10), `CLOSE_CODES` (§1).
- `values.ts`: `RedactedValue`, `WireValue`, `WireViewers`, `WireError`, `WireResult` (§7.1), `InputValue`, `InputViewers`, `InputCellContent`, `BindingName`, `ObjRef` (§4, §5), with schemas `WireValueSchema`, `WireResultSchema`, `InputValueSchema`, `InputCellContentSchema`, `WireViewersSchema`, `InputViewersSchema`.
- `views.ts`: `Viewer`, `CellView`, `ActionView`, `ObjectView`, `BoardView`, `Cover`, `GroupHeader`, `GroupView`, `CellStateView`, `LocationView`, `ObjectSnapshotView`, `EffectView` (§7.2–§7.6) and their schemas.
- `ops.ts`: `WireOp` (19 kinds), `Destination`, `ObjectInit` (§5), schemas, `WIRE_OP_TYPES`.
- `methods.ts`: per-method params and result types and schemas (every params and result type of PROTOCOL.md §4, §6 and §9, named `<Method>Params` / `<Method>Result` in PascalCase, e.g. `TransactParams`, `TransactResult`, `ChangesSinceResult`, plus `DepNode`, `ExplainCellResult`, `ExplainGroupResult`, `ExplainActionResult`), the `METHODS` table (name, params schema, result schema, kind `write | query | explain | subscribe`), and `Params<M>` / `Result<M>`.
- `messages.ts`: `Hello`, `Welcome`, `Goodbye`, `ClientMessage`, `ServerMessage`, `ProtocolError`, `ProtocolErrorCode`, `ProtocolRejection`, `CommitEvent`, `SaveEvent`, `SubscriptionDelta`, `ProtocolFailure`, `parseClientMessage`, `parseServerMessage` (§1, §2, §4, §8, §10).

Schema rules:

- All schemas are zod, discriminated on `type` (requests on `method`), in two flavours per PROTOCOL.md §12: client-to-server schemas (`hello`, `request`, every params schema, `WireOp`, input values) are strict (unknown keys rejected; `__proto__` rejected as a key anywhere, as FIXTURES §1); server-to-client schemas (`welcome`, `response`, `event`, `goodbye`, results, views, `EffectView`, covers, wire values) are loose: unknown keys are stripped, `__proto__` keys are still rejected. Shared shapes used in both directions (e.g. `Actor`, `Viewer`) exist in both flavours where they differ.
- Wire schemas are JSON-Schema-compatible: no `z.custom`, no transforms or preprocessors anywhere in the params schemas, `WireOp`, values or views. `@vtt/schema`'s `ValueSchema`, `CellContentSchema` and `ViewersValueSchema` are `z.custom` and are therefore not used on the wire; the recursive `WireValue`/`InputValue` schemas are written here (recursion through zod 4 getters or `z.lazy`), structurally matching `@vtt/schema`'s value types (scalar value schemas that are already plain zod may be reused). Refinements are allowed (they are dropped by JSON Schema export). `ActionDef`, `Actor`, `Shape`, `Board` schemas are reused only if they export; otherwise wire copies are written here.
- Canonical schemas remain for unfiltered document data: the `document` result uses `@vtt/schema`'s `SnapshotSchema` and `OpGroupSchema` unchanged (it is not an MCP tool, so it need not export to JSON Schema).
- Redaction is representable at every depth: `{type:"redacted"}` is a `WireValue` at top level, as a list item at any depth and as a viewers entry. `InputValue` never accepts `redacted` or errors; `WireValue` never accepts a `$binding` ref.
- `class ProtocolFailure extends Error { error: ProtocolError }`, constructed as `new ProtocolFailure(code, message, details?)`, is thrown by authority handlers and turned into error responses by the router. `parseClientMessage(text)` returns `{ok: true, message} | {ok: false, error: ProtocolError}`; `parseServerMessage(text)` validates the envelope only (PROTOCOL.md §12): `welcome`, `goodbye` and events fully; a `response` as `{type, id, ok: true, result: unknown}` or `{type, id, ok: false, error: ProtocolError}`; it normalizes the envelope and the notifications whose shape it knows (events, `welcome`, `goodbye`), never a response's `result`, and returns `{ok: true, message, warnings: string[]} | {ok: false, error: ProtocolError} | {ok: "ignored", reason: string}` (`ignored` for a message of unknown `type` or an event of unknown `event` kind). `parseResult(method, result)` is the second stage: it validates and normalizes a success result against `METHODS[method]`'s loose result schema, stripping unknown keys in the result and in nested views and effects, and returns `{ok: true, value, warnings: string[]} | {ok: false, error: ProtocolError}` with `error = {code: "internal", message, details: {type: "protocol", method}}`; the client calls it with the method of the pending request (vtt-5su.7). An unknown `EffectView` variant inside a group view is dropped from `effects` and reported in `warnings` by whichever stage parses it (events: `parseServerMessage`; results: `parseResult`). None of these functions throws.

Done when: `test/schema-messages.test.ts` round-trips (parse → deep-equal) through `parseClientMessage`/`parseServerMessage`, and for results through `parseServerMessage` followed by `parseResult`, a hand-written example of every client and server message, every method's params and result (including a `transact` with `retry: true` and a `zones` result with `error`), every one of the 19 `WireOp` kinds, a `welcome` with `table.id`, every `EffectView` variant, an `explain_action` result with top-level `enabled` both with a `guard` and without one (an action with no `when`), every `ProtocolRejection` and every one of the 14 error codes (including `wrong_table` and `retry_unknown`); nested redaction round-trips through the real message parsers: a `get_objects` response whose view has a list of lists containing `{type:"redacted"}`, a viewers value with a redacted entry, and a `commit` event whose `groups_upserted` group view has a `create` effect snapshot and a `cell` effect with redacted refs; `parseClientMessage` rejects an unknown key at the message, params, op and input-value levels, while `parseServerMessage` accepts an unknown key at the envelope level and in events (message, event, view, effect and value levels) and returns the message without it, and leaves a response's `result` untouched; the two-stage pipeline (`parseServerMessage` then `parseResult`) on a response with unknown keys both in the envelope and inside the result's views and effects returns a value with neither, and an unknown `EffectView` variant in a result is reported in `parseResult`'s `warnings`; `parseServerMessage` returns `ignored` for an unknown message `type` and an unknown `event` kind, drops an unknown `EffectView` variant with a warning, and still returns an error for a known envelope with a missing required field; `parseResult` rejects a malformed result (`get_objects` without `missing`) and a result valid for a different method (an `unsubscribe` result `{}` given as the result of `get_objects`, and a `subscribe` result given as the result of `list_objects`) with code `internal` and `details.type: "protocol"`, while `{}` passes as the result of `unsubscribe`; it rejects a `__proto__` key in `cells`, a request with an unknown method, a `$name` ref inside a view's value, a `redacted` inside an op value, a `transact` with zero ops and with `max_ops + 1` ops, a `list_objects` with `limit` above `max_page`, and a `hello` without `client.instance`; `parseClientMessage` returns an error (not a throw) for invalid JSON; `test/schema-json.test.ts` exports with zod's `z.toJSONSchema` without error the `WireOp` schema, the complete `transact` params schema (ops with init cells, spawn cells, viewers) and every method's params schema, and the exported `WireOp` schema lists 19 `type` constants; no `z.custom` appears in `packages/protocol/src` (a test greps the sources); `METHODS` has exactly the 17 methods and `WIRE_OP_TYPES` exactly the 19 ops; `LIMITS` equals the PROTOCOL.md §10 values (13 keys); a type-level test (`expectTypeOf`) checks `Result<"transact">` and `Params<"subscribe">`; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: the client and mirror (vtt-5su.7); any server code; MCP (vtt-5su.11, vtt-5su.15); `invoke` behaviour and face-layout fields (M5); editing `@vtt/schema`.

Depends on: vtt-5su.2, vtt-75c.3, vtt-75c.4.

---

### M3-c — vtt-5su.5 — Authority: command execution (transact, undo, stale writes)

Implements: DESIGN.md §5.2 Write ("validated commands … carry the revision they were based on, and are rejected on conflict"), §7 (transactions, one group per command, undo targets, undo conflict keys); docs/PROTOCOL.md §3 (actors), §4 (`not_found` applies only to query, explain and subscribe targets), §5 (ops, declared keys, bindings, input values), §6 (revisions, floor, processing order, stale writes, deduplication) as written by vtt-5su.2.

The transport-free command layer. Exclusive files: `packages/authority/src/protocol/commands.ts`, `conflicts.ts`, tests `test/protocol/commands.test.ts`, `conflicts.test.ts`. Adds the sorted lines `export * from "./protocol/commands"` and `export * from "./protocol/conflicts"` to `packages/authority/src/index.ts` (no `protocol/index.ts`; every M3 module is exported from the package index directly). One permitted edit to an M2 file: if vtt-75c.16's `Transaction` has no list of recorded effects, add a read-only `tx.effects(): readonly Effect[]` to `store/transaction.ts` (one method, nothing else). Key conflicts use the existing `keysConflict` / `keysIntersect` of `store/effects.ts` (vtt-75c.5) unchanged; `store/undo.ts` and `store/effects.ts` are not edited.

```ts
type CommandContext = { table: Table; actor: Actor; kind: "ui" | "agent" | "test"; client: string /* hello client.instance */;
                        dice: DiceSource; txns: TxnCache };
executeTransact(ctx: CommandContext, params: TransactParams): TransactResult;
executeUndo(ctx: CommandContext, params: UndoParams): TransactResult;
class TxnCache { constructor(perClient = LIMITS.max_txn_ids_per_client); lookup(client, txnId, fingerprint): TxnLookup; store(client, txnId, fingerprint, result) }
type TxnLookup = { type: "miss" } | { type: "hit"; result: TransactResult } | { type: "mismatch" };
declaredKeys(op: WireOp): string[];                                      // commands.ts, PROTOCOL.md §5 table
historyFloor(history: History, currentRevision: number): number;           // conflicts.ts, PROTOCOL.md §6
intersectingKeys(groupKeys: readonly string[], checked: readonly string[]): string[];   // conflicts.ts
staleConflicts(history: History, baseRevision: number, keys: string[]): StaleWrite | null;   // conflicts.ts
```

- Structural validation (`validateOpsStatic`), before anything else and independent of the document (PROTOCOL.md §6 step 1); failures throw `ProtocolFailure("bad_request", message)`: a binding (`as`, values of `owned`) is introduced at most once; every `$name` use comes after its introduction (op order); `owned` keys are plain ids; `actor` is present only when `ctx.kind` is not `agent`, and has the shape `{type:"character", id}`; `label` ≤ 200 characters (schema, `txn_id` shape and op count were already enforced by the params schema).
- State validation (`validateAgainstDocument`), only after a deduplication miss (or when there is no `txn_id`) (PROTOCOL.md §6 step 2b); failures throw `ProtocolFailure("bad_request", message)` and are not stored: `base_revision` is an integer between 0 and the current revision; `actor`, when present, names an existing object whose `is_character` is true.
- Deduplication (PROTOCOL.md §6): with `txn_id`, the fingerprint is the canonical JSON (keys sorted recursively) of the full params except `retry`; `lookup(ctx.client, txn_id, fp)`: `hit` returns the stored result unchanged without executing; `mismatch` returns `{status:"rejected", rejection: {type:"invalid", message:"txn_id reused with different params"}}` (not stored); `miss` with `retry: true` throws `ProtocolFailure("retry_unknown", …)` and executes nothing (PROTOCOL.md §6); `miss` otherwise executes and stores the result, committed or rejected. `retry: true` without `txn_id` is `bad_request` (structural). Per client instance the last `max_txn_ids_per_client` entries are kept (insertion order, oldest evicted); different client instances never share entries.
- Stale writes, in PROTOCOL.md §6's processing order: (3) `base_revision` < `historyFloor` → `stale_write` with `truncated: true`, `conflicts: []`; (4) when `base_revision` < current revision, K₀ = union of `declaredKeys` over the ops (keys naming a `$binding` omitted), checked by `staleConflicts` against every retained group with `revision > base_revision` (undo groups included; a group's keys = union of `touchedKeys` over its effects) → `stale_write` before any primitive runs; (5) execution; (6) K₁ = union of `touchedKeys` over `tx.effects()`, checked the same way inside the transaction function after the last op, so a refusal aborts with nothing applied and no randomness consumed. A conflict entry is `{index, revision, actor, label, keys}` with `keys = intersectingKeys(groupKeys, checked)` (the group's keys that `keysConflict` with some checked key, in the group's order). `StaleWriteError` carries the rejection out of the aborted transaction.
- Execution: one `transactWithDice(table, actor, {kind: "edit", label}, ctx.dice, fn)` (vtt-75c.15), actor = `params.actor ?? ctx.actor`. Inside `fn` ops run in order. Bindings: `as` on `create_object` binds the created id, `as` on `spawn` the root copy, `owned` maps template-subtree ids to their copies (from spawn's returned copy map). `$name` in id positions and refs inside input values (deep: lists, viewers entries) are replaced by the bound id, and replaced values are re-checked with `isValue`. Mapping: `set_value` → `writeValue`; `set_formula` → `setFormula`; `clear_override` → `clearOverride`; `delete_cell` → `deleteCell`; `rename_cell` → `renameCell`; `set_cell_visibility` → `setCellVisibility`; `set_tag` → `setTag`; `set_shape` → `setShape`; `set_template_flag` → `setTemplateFlag`; `set_character_flag` → `setCharacterFlag`; `reorder` → `reorder`; `add_board` → `addBoard`; `rename_board` → `renameBoard` (vtt-75c.14); `set_actions` → `setActions`; `remove_board` → `removeBoard` (vtt-75c.18); `create_object` → `createObject(tx, init, to, id?)`; `spawn` → `spawn(tx, template, to, cells)`; `move` → `move`; `remove` → `remove` (vtt-75c.6). A `Rejected` thrown by op i is re-thrown annotated with `op_index: i` (0-based). Default label per PROTOCOL.md §5.
- Undo: `target.type: "mine"` becomes `{type:"actor", actor: ctx.actor}`; other targets pass through to vtt-75c.8's `undo(store, actor, selector)`. With `expect_index`, `findUndoTarget` runs first and a different target (or none) is refused `{type:"undo_target_changed", expected, actual}`. Undo takes no `base_revision` and is not stale-checked.
- Result: committed → `revision`, group `index`, `created` (one entry per `create_object`), `copies` (one per `spawn`), `bindings`. Rejected → the `Rejection` or protocol rejection, with `op_index` when an op refused. Any other error propagates unchanged (the router reports it as `internal`).

Done when: tests on a `Table` built in the test show: each of the 19 op kinds commits and has the M2 effect (one test per op, checking stored state); `declaredKeys` matches the PROTOCOL.md §5 table for every op kind, including omitted `$binding` keys and both destination kinds; a batch `create_object fb_aldric` (as `$card`), `create_object` zone into `$card`'s contents (as `$zone`), `set_value fb_aldric.zone {type:"ref", object:"$zone"}` commits as one group and the stored ref is the real id; `spawn` with `owned` returns bindings for the root and the owned copies; a use before introduction, a duplicate binding and `base_revision` above current are `bad_request` with no group; a protected write in the second of three ops is rejected with `op_index: 1` and nothing applied; GM writes `goblin1.hp` taking revision 5 to 6, then an agent transact with `base_revision: 5` writing `goblin1.hp` is `stale_write` naming that group and key `cell:goblin1/hp`, while one writing `goblin1.ac` commits; a stale `move` into a container conflicts with an intervening reorder of that container; a stale `set_value` on an object removed since is `stale_write` with the removal group's `obj:<id>` key (not a primitive refusal, no `op_index`); a current-base `set_value` on an id that never existed is rejected `invalid` with `op_index` (the M2 primitive's refusal, never `not_found`, PROTOCOL.md §4); a stale `move` into a container removed since and a stale `create_object` onto a board removed since are `stale_write`; a stale write whose declared keys are disjoint but whose actual effects conflict (a `move` out of a container reordered since) is `stale_write` with nothing applied; `base_revision` older than the oldest retained group after `compactLog` is refused with `truncated: true`; with zero retained groups the floor is the current revision and any lower `base_revision` is `truncated`; a refused stale write consumes no dice (a `ScriptedDiceSource` keeps its entry); the same `txn_id` twice from one client returns the identical result and appends one group; the same `txn_id` from another client instance executes separately; the same `txn_id` with different ops is rejected `invalid` and appends nothing; a UI transact acting as Aldric with a `txn_id` commits, then another context removes Aldric (or clears his `is_character`), and the identical retry returns the stored committed result instead of `bad_request`, while a new `txn_id` with the same params is `bad_request`; the cache evicts a client's oldest entry after 1,000 without affecting another client's entries; after 1,001 further transactions from the same client, a resend of the first one with `retry: true` is `retry_unknown` and appends no group; a `retry: true` resend of a retained entry returns the stored result; `intersectingKeys` returns the group's keys (`obj:x` against `cell:x/hp` returns `obj:x`); `undo {type:"mine"}` by the agent skips a later GM group; an `expect_index` mismatch is `undo_target_changed`; an agent context passing `actor` is `bad_request`; a UI context acting as Aldric records actor `{type:"character", id:"aldric"}`; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: transport and message parsing (vtt-5su.10); views and events (vtt-5su.6, vtt-5su.9); `invoke` and roll steps (M5); `beside`/`table` destinations (M5); persistent deduplication across restarts (vtt-y1w.11); read-set preconditions (vtt-qf5.5).

Depends on: vtt-5su.3, vtt-75c.18, vtt-75c.6, vtt-75c.8, vtt-75c.12, vtt-75c.15.

---

### M3-d — vtt-5su.6 — Authority: viewer-filtered views

Implements: DESIGN.md §4.3 (boards are not a security mechanism), §4.4 (effective visibility, per-cell visibility, face-down rule, opaque cover, fail-closed inputs, "the log, and the agent's query results are all filtered by the same effective visibility"), §7 ("clients receive cell results, never inputs"); FORMULAS.md §9; docs/PROTOCOL.md §7 (values, object views, redaction, face-down, covers, group views and `EffectView` filtering) as written by vtt-5su.2.

Exclusive files: `packages/authority/src/protocol/views.ts`, `test/protocol/views.test.ts`; one sorted line `export * from "./protocol/views"` in `packages/authority/src/index.ts`. Consumes vtt-75c.10's `Visibility` and `FACE_DOWN_EXEMPT` unchanged (no edit to visibility.ts or cover.ts). The cover rule is PROTOCOL.md §7.5, which M2's cover oracle implements after vtt-75c.19 (valid geometry with an erroneous or non-boolean `opaque` covers exactly its region; only unreadable geometry or anchor is undetermined, i.e. `whole_board`); `covers` applies that rule, so drawn covers agree with `canSeeObject`; zone enumeration and cover geometry classification are done here (M2 offers only `opaqueZonesCovering(object)`, which cannot list covers on a board with no visible objects).

`new ViewBuilder(table, viewer)`: one instance per build pass at one revision; memoizes `canSeeObject` and `canSeeCell` per (object, cell) within the pass. `STRUCTURAL_VIEW_CELLS` = every readable structural cell of `STRUCTURAL_CELLS` (vtt-75c.3) except `id`.

- `objectView(id, cells: "all" | "structural" | string[]): ObjectView | null` per PROTOCOL.md §7.2. GM: never null for a live object; `cells` holds every stored user cell plus every `STRUCTURAL_VIEW_CELLS` cell (defaults included), each `{value: table.value(id, cell), kind, source?, overridden?, visibility?}`, with `kind` per PROTOCOL.md §7.2: `"formula"` when the stored content is a formula (structural cells included, override or not), `"structural"` when there is no stored content (field-backed or defaulted), else `"literal"`; `actions` with `when` and `steps`. Character viewer: null unless `canSeeObject`; a cell appears iff `canSeeCell`; no `source`, no `visibility`; `actions` carry names only. `"structural"` restricts to `STRUCTURAL_VIEW_CELLS`; a list restricts to those names (absent names are missing).
- `redact(value: Result): WireResult` per PROTOCOL.md §7.3, character viewers only (GM: identity conversion): every ref at any depth of lists and every viewers ref entry naming an object the viewer cannot see, or an id that is neither a live object nor a board, becomes `{type:"redacted"}` in place; a ref naming a board id is kept unchanged (boards are checked before objects; `canSeeObject` is never asked about a board id); an error value whose `origin` names an object or a cell the viewer cannot see becomes `{type:"error", code}`.
- `covers(board): Cover[]` per PROTOCOL.md §7.5, character viewers only (GM: `[]`): enumerates every `is_zone` object directly on the board through the store read API; only zones with `visibility.isEffectivelyVisible(zone, viewer)` false are considered (the predicate M2's cover oracle uses; never `canSeeObject`, which also applies cover); each is classified by the table of PROTOCOL.md §7.5, in this order, using vtt-75c.7's schema geometry on the zone's evaluated `position`, `rotation` and `shape`: geometry unreadable or invalid → `{whole_board: true}` whatever `opaque` is; valid geometry with `shape` absent or empty → no cover; valid geometry with a shape and `opaque` `true`, an error or a non-boolean → `{position, rotation (empty → 0), shape}`; `opaque` `false` → no cover. `key` is stable per zone for the life of the process and does not contain the zone id (`"c"` + a counter assigned on first use, kept in a map owned by the `Table`'s lifetime, e.g. a `WeakMap<Table, Map<ObjectId, string>>`). `coverBoards(scopeObjects: ObjectId[]): BoardId[]` returns the boards those objects are on, a contained object counting on its outermost container's board (used for `objects` scopes by vtt-5su.9 and queries).
- `effectView(effect: Effect): EffectView | null` per PROTOCOL.md §7.6, for every effect variant: GM lossless conversion (literal content → `{kind:"literal", value}`, formula content → `{kind:"formula", source, override?}`, create/remove snapshots with every field, actions with `when` and `steps`, `allocate`/`retire` kept); character filtering by visibility at the builder's revision, an object that does not exist counting as invisible: `cell` kept iff object visible and cell readable (no `source`; values redacted; an override shown as `override` without the formula source); `cell_visibility` dropped; `field` `tag`/`shape` iff that cell is readable, `is_template`/`is_character` iff object visible, `actions` iff object visible with names only; `place` iff object visible and its `board` and `container` cells readable, invisible containers as `null`; `create`/`remove` iff at least one object visible, `objects` limited to visible ones with readable cells only, no source, no `cell_visibility`, actions names only, `tag`/`shape`/`contents` omitted when unreadable, invisible contents ids and hidden location containers as `null`; `reorder` iff container visible and `contents` readable, invisible ids as `null`; `board` always; `allocate`, `retire` dropped.
- `groupView(group, {effects: boolean}): GroupView | null`. GM: the group's fields plus `undone` from `History.isUndone`, with converted `effects` when asked. Character viewer: `names[id]` present only when the viewer can see object `id` now and `canSeeCell(id, "name")`; effects filtered by `effectView`; null when names and filtered effects are both empty (decided from the filtered effects whether or not they are returned); otherwise its header (index, revision, actor, kind) is kept and `label` is the group's label only when every effect other than `allocate`/`retire` is kept unreduced by `effectView` (not dropped; no cell, snapshot object, value, ref or id omitted, nulled or redacted), else `null` (PROTOCOL.md §7.6). `effectView` reports whether it reduced an effect so `groupView` can decide.

Done when: tests on Tables built from fixture setups show: the GM view of `goblin1` in goblin-hit.json includes `ac` with its value and `hit` with its formula `source`; Aldric's view omits `ac` and includes `hit`'s value without `source`; Bryn's view of a face-down card owned by Aldric has exactly the `FACE_DOWN_EXEMPT` cells, Aldric's has all its cells; a card `all` in Aldric's hand is null for Bryn, and the hand's `contents` (hand visible to all) shows one `{type:"redacted"}` entry for Bryn; a public cell referencing an invisible goblin shows `redacted`; a list of lists containing a ref to an invisible object is redacted at depth 2 and a viewers value with a ref to an invisible character has that entry redacted; a visible token's `board` structural cell keeps its board ref in Aldric's view; an error whose origin is a GM-only cell is code-only for Aldric and complete for the GM; on a board with a hidden opaque room zone Aldric gets one `Cover` with the zone's geometry and no view of the zone or of a token under it, and the GM gets no cover; an otherwise empty board with one hidden opaque zone gives Aldric one cover; one parity test per row of the PROTOCOL.md §7.5 table, each with a hidden zone, a public token inside its (would-be) region and one outside, asserting the drawn covers agree with M2's `canSeeObject` for Aldric: (a) `position` a formula evaluating to an error, `opaque: true` → `whole_board`, both tokens invisible; the same with `opaque: false` → still `whole_board`; (b) valid position and no `shape` → no cover, both tokens visible; (c) valid geometry, `opaque` a formula evaluating to `#REF` → region cover, inside token invisible, outside visible; the same with `opaque` a formula evaluating to text (`"yes"`) and with `opaque: true`; (d) valid geometry, `opaque: false` → no cover, both visible; every table in these tests passes M2 validation (erroneous or wrongly typed values come only from formulas); `coverBoards` maps a card inside a hand on board `crypt` to `crypt`; with two overlapping hidden opaque zones (one zone's anchor inside the other), the returned covers are exactly the zones M2 does not report effectively visible, and for every public token on that board (`visible_to` all, not a zone) `canSeeObject` (M2) is false exactly when the object's anchor lies in a returned cover's region; a `position` formula on a token and its override give `kind: "formula"` with `overridden: true`, a stored literal `name` gives `"literal"`, a defaulted `rotation` and the `tag` field give `"structural"`; cover keys are equal across two builders and do not contain the zone id; for a public object with a GM-only cell, Aldric's view of its creation group has a `create` snapshot without that cell and without any formula `source`, and the GM's has both; Aldric's view of a group that set a formula and then overrode it shows `{kind:"formula", override}` without `source`; Aldric's view of a `setActions` group shows action names only, the GM's shows `when` and `steps`; Aldric's `groupView` omits a write to a GM-only cell and a `cell_visibility` effect, keeps the header of a group that also wrote a visible cell, and is null for a group touching only invisible objects (with and without `effects`); a remove effect is dropped for Aldric while the object is removed and shown again after an undo re-creates it; a public object whose `name` cell is GM-only has no `names` entry in Aldric's view of a group that wrote one of its public cells, while the GM's view names it; a group that wrote one public and one GM-only cell has `label: null` for Aldric and its label for the GM, and a group whose every effect is visible to Aldric keeps its label for him; the GM `groupView` equals the raw group plus `undone` with effects converted losslessly (a test converts every `Effect` variant); `cells: "structural"` returns exactly `STRUCTURAL_VIEW_CELLS`; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: subscriptions and diffs (vtt-5su.9); queries and explain (vtt-5su.8); log sentences (M5); face layouts and what the back of a card shows (M5); computed vision (Later); changes to visibility.ts (vtt-75c.10).

Depends on: vtt-5su.3, vtt-75c.7, vtt-75c.10, vtt-75c.12, vtt-75c.18, vtt-75c.19.

---

### M3-e — vtt-5su.8 — Protocol: query methods

Implements: DESIGN.md §5.2 Query (list objects paged, read cells, resolve formulas, enumerate zones and their contents, what is at a position, what changed since revision N), §4.4; FORMULAS.md §5 (query order), §9; docs/PROTOCOL.md §4 (methods), §6 (floor), §9 (evaluate, at_position, changes_since cursor, document) as written by vtt-5su.2.

The eight query handlers. Explain is vtt-5su.16. Exclusive files: `packages/authority/src/protocol/queries.ts`, tests `test/protocol/queries.test.ts`; the sorted line `export * from "./protocol/queries"` in `packages/authority/src/index.ts`. Every function takes `(table, params)` and returns the result type of `@vtt/protocol` (vtt-5su.3); failures throw `ProtocolFailure(code, message)`. Views, redaction and group views come from vtt-5su.6's `ViewBuilder`; the history floor from vtt-5su.5's `historyFloor`.

- `listObjects`: candidates are all live objects, filtered by every given `filter` field (`board`: directly on it; `container`: directly in it; `tag`: its tag list contains the text; `name`: literal name equal; flags equal), then by `canSeeObject` for the viewer; ordered by id (code point); `cursor` is the last id of the previous page (results start after it); `limit` defaults to 50; `next_cursor` is null on the last page. Pages may span revisions; each page reports its revision.
- `getObjects`: views in request order; ids that do not exist or are invisible to the viewer go to `missing`, indistinguishably.
- `evaluateAdhoc` (GM only; no viewer parameter): `engine.evaluate(source, {thisId})` (vtt-o9i.16); `source.length` ≤ `max_source_length` else `bad_request`; an unknown `this` is `not_found`; without `this`, `this` evaluates as for a formula with no object (the engine's ad hoc default); results pass through unredacted.
- `zonesOnBoard`: every `is_zone` object directly on the board and visible to the viewer, ordered by id; `contents` = `engine.evaluate("contents(this)", {thisId: zone})` (FORMULAS §5 order), restricted to objects the viewer can see; when that evaluation returns an error, `contents: []` and `error: <code>` (PROTOCOL.md §4; the request still succeeds); `view` = structural view. Unknown board: `not_found`.
- `atPosition`: candidates `index.candidates(board, pointBounds)` (vtt-75c.9) where `pointBounds` is the degenerate box at the point; `objects` = non-zone candidates whose evaluated footprint contains the point by vtt-75c.7's `pointInRegion` (boundary inclusive; a shapeless object matches when its anchor is within `GEOM_EPSILON`), ordered ascending `z` (empty = 0) then id; `zones` = zone candidates containing the point, same order; both filtered by `canSeeObject`; objects in containers are never included. A candidate whose evaluated `position`, `rotation`, `shape` or `z` is an error (including `#LIMIT`) is omitted (PROTOCOL.md §9); the request still succeeds and the remaining candidates keep their order.
- `changesSince` (PROTOCOL.md §9): `params.revision` above the current revision is `bad_request`; `floor = historyFloor(…)`; `truncated = params.revision < floor`; scans retained groups with `revision > params.revision`, oldest first, at most `limit` scanned; returns the non-null `groupView(…, {effects: true})` among them; `more` = retained groups remain after the last scanned; `next_revision` = the `revision` of the last scanned group, or the current revision when none was scanned; result `{revision, floor, groups, truncated, more, next_revision}`.
- `logPage`: retained groups newest first, `before` an exclusive absolute index, `effects` per the parameter, character nulls omitted; `first_index`, `next_index`, `undo_barrier` from `History` (vtt-75c.5).
- `documentDump` (GM only): `store.toSnapshot()` plus the retained log `{first_index, groups, undo_barrier}`, canonical.

Done when: tests show: paging 120 objects with `limit: 50` gives three pages, no duplicates, ascending ids; a `tag: "creature"` filter over fireball.json's setup returns its creatures; Aldric's `list_objects` excludes a GM-only object and `get_objects` lists it in `missing` exactly like a removed id; `evaluate("max_hp - damage_taken", this goblin1)` gives 27, then 22 after a write; a 10,001-character source is `bad_request`; unknown query targets are `not_found` (PROTOCOL.md §4): `zones` and `at_position` on an unknown board, `evaluate` with an unknown `this`, while `get_objects` with an unknown id lists it in `missing`; `zones` on difficult-terrain.json's board lists the zone with the token after a move in and without it after the move out; a zone for which `contents(zone)` evaluates to `#TYPE` (built from a `position` formula evaluating to text, e.g. `position = "here"` as a formula, never a stored text literal, which M2 validation rejects; the test asserts the engine's result first) is listed with `contents: []` and `error: "#TYPE"`; at a point covered by three tokens, one whose `position` formula is a `#CYCLE` and one whose `z` formula is `#LIMIT` (a formula exceeding the FORMULAS §7 budget of 20,000 units; the test documents its construction), `at_position` returns only the third; a zone whose `position` is `#LIMIT` yields `contents: []`, `error: "#LIMIT"` in `zones` and is omitted from `at_position`; `at_position` inside two stacked tokens returns both in ascending `z`, and inside a rotated rect zone returns the zone; `changes_since(r)` after three commits returns three groups oldest first with `next_revision` equal to the third group's revision; for Aldric, with `limit: 2`, five commits touching only GM-only objects followed by one visible write give two pages with `groups: []`, `more: true` and advancing `next_revision`, then a page containing the visible group with `more: false`; after `compactLog` a too-old `r` is `truncated` with `floor` reported, and with zero retained groups `floor` equals the current revision and `r` below it is `truncated`; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: explain methods (vtt-5su.16); subscriptions (vtt-5su.9); transport (vtt-5su.10); log sentences (M5); viewer-specific evaluate (GM only by decision).

Depends on: vtt-5su.5, vtt-5su.6, vtt-75c.7, vtt-75c.12.

---

### M3-e2 — vtt-5su.16 — Protocol: explain methods

Implements: DESIGN.md §5.2 Explain ("the formula, dependency chain, and action steps behind any value or log entry"), §4.4 (dependency tracing filtered by effective visibility); FORMULAS.md §7 (dynamic dependencies), §9; docs/PROTOCOL.md §7.6 (group views), §9 (explain results, not-found rule) as written by vtt-5su.2.

The three explain handlers: bounded dependency traversal, error-origin tracing, group and action explanation. Exclusive files: `packages/authority/src/protocol/explain.ts`, tests `test/protocol/explain.test.ts`; the sorted line `export * from "./protocol/explain"` in `packages/authority/src/index.ts`. Every function takes `(table, params)` and returns the result type of `@vtt/protocol` (vtt-5su.3); failures throw `ProtocolFailure(code, message)`. Views, redaction and group views come from vtt-5su.6's `ViewBuilder`. It needs no code from `queries.ts`; the dependency on vtt-5su.8 serializes the two beads' shared test fixtures and keeps one reviewer context per bead.

- Not found (PROTOCOL.md §9): every explain function answers the identical `ProtocolFailure("not_found", "not found")` for a nonexistent object, cell, action or group and for one the viewer cannot see (object not visible, cell not readable, group view null); the check runs before any evaluation result is exposed.
- `explainCell`: visibility check first (above), then `table.value` (forcing evaluation), then `engine.dependenciesOf` (vtt-o9i.9); dependencies expanded breadth first to `depth`, each cell expanded once, at most `max_explain_nodes` nodes (`truncated` when cut). `content` reports `parses` (and `syntax_error` when it does not) for formula cells. For a character viewer: a cell it cannot see appears as `{type:"cell", object, cell, hidden: true}` without value; a dependency on an object it cannot see has `object: null` and no value; `source` omitted; values redacted. `error_chain` follows the `origin` of the cell's error to the next cell's error until a cell whose error's origin is itself (or a repeat), at most 32 steps, entries on invisible objects or unreadable cells with `object: null` or `cell: null`. `last_write` is the newest retained group with a `cell` effect on that cell, presented as that viewer's log would present it (PROTOCOL.md §9): the header of `groupView(group, …)` for the viewer (so a character gets `label: null` when any effect is hidden or reduced) plus the effect's `cause`; omitted when that group view is null for the viewer.
- `explainGroup`: `{group: groupView(…, {effects: true}), action?}`; `action` is the origin action's current definition when its object still exists and the viewer is the GM, with `current: true`. An index not retained or a group null for the viewer is `not_found`.
- `explainAction`: object visibility check first; result shape per PROTOCOL.md §9: top-level `enabled` (true iff `when` is absent or `engine.evaluate(when, {thisId})` is `true`) and `reason` (only when not enabled: `when_false` for false or another non-error value, `when_error`); `guard: {value, source?}` only when the action has a `when` (`source` GM only); `steps` GM only. An unknown action is `not_found`.

Done when: tests show: `explain_cell` of `hp` at depth 1 lists `max_hp` and `damage_taken` with values, and at depth 2 over a three-cell chain shows the nested node; the dice-tray sum lists an `index` dependency; Aldric's `explain_cell` of `hit` names `goblin1.ac` with `hidden: true` and no value; Aldric's `explain_cell` on a GM-only object, on a GM-only cell of a public object, and on a nonexistent object return deep-equal errors, as do his `explain_action` on a GM-only object versus a nonexistent object and his `explain_group` on a group null for him versus a non-retained index; a `#REF` cell's `error_chain` ends at the cell that read the deleted object; a `#CYCLE` chain terminates; `last_write` names the group that last wrote the cell; for a group that wrote a public cell and a GM-only cell, Aldric's `explain_cell` of the public cell has `last_write.label: null` while the GM's has the label; an unparsable formula reports `parses: false`; `explain_action` on attack-card.json's card reports `Roll` with top-level `enabled: false`, `reason: "when_false"` and a `guard` while `target` is empty, and `enabled: true` after it is set; an action without `when` returns `{object, action, enabled: true}` with no `reason` and no `guard`, plus `steps` for the GM, and exactly `{object, action, enabled: true}` for Aldric; `explain_group` of a committed `setTag` group returns its field effect view; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: query methods (vtt-5su.8); subscriptions (vtt-5su.9); transport (vtt-5su.10); action step parsing and step parse status (M5); log sentences (M5).

Depends on: vtt-5su.8, vtt-5su.6, vtt-75c.12.

---

### M3-f — vtt-5su.9 — Protocol: object and cover subscriptions

Implements: FORMULAS.md §7 ("Propagation is lazy pull with dirty marking … The authority decides which cells to recompute and send", with the sentence vtt-5su.2 adds); DESIGN.md §5.2 Subscribe, §7 (internal synchronization before public notifications), §4.4; docs/PROTOCOL.md §7.5 (boards in scope for covers), §8 (object scopes, commit events, deltas, evaluation rule; the log window is vtt-5su.20) as written by vtt-5su.2.

Exclusive files: `packages/authority/src/protocol/subscriptions.ts`, `test/protocol/subscriptions*.test.ts`; the sorted line `export * from "./protocol/subscriptions"` in `packages/authority/src/index.ts`; the Table notification seam, owned by this bead alone (other beads consume it, none edits it): one addition to `src/engine/table.ts` (vtt-75c.12): `table.onCommit(fn): () => void` whose payload is `{group, summary, dirty: CellKey[]}` (`dirty` = the keys `engine.invalidate` returned), called after the internal hook has updated the index and invalidated the engine, so listeners never read stale values.

`new SubscriptionHub(table)` (object and cover scopes; other scope types plug in through `registerScope`):

- `subscribe(conn: string, params: SubscribeParams): SubscribeResult`: at most `max_subscriptions` per connection (`ProtocolFailure("busy")`); unknown `board` is `not_found`; subscription ids are `"s"` + a hub-wide counter. Scope at the current revision: `board` = every object directly on the board and, recursively, everything in their contents; `objects` = the ids (with `subtree`, also their descendants; ids that do not exist are ignored); `all` = every live object; Builds every view with vtt-5su.6's `ViewBuilder` (viewer and `cells` from params), stores per subscription `last: Map<ObjectId, string>` (canonical JSON of each sent view) and the sent covers by key, and returns `{subscription, revision, objects, covers}`; covers for the boards in scope per PROTOCOL.md §7.5 (`objects` scope via `ViewBuilder.coverBoards`). A scope type with a registered provider (`log`, vtt-5su.20) is delegated to it: the hub allocates the id, enforces the per-connection limit and returns `{subscription, revision, objects: [], covers: [], ...provider.subscribe(...)}`; an unregistered scope type is `ProtocolFailure("unsupported")`.
- Scope providers: `registerScope(type: "log", provider: ScopeProvider)` with `ScopeProvider = {subscribe(sub: {id, conn, viewer, cells}): {groups: GroupView[]}; onCommit(sub, commit: CommitInfo): {groups_upserted?: GroupView[]; groups_removed?: number[]} | null; drop(sub): void}` and `CommitInfo = {group, summary, dirty: CellKey[], visibilityRelevant: boolean}`; the hub calls `onCommit` for each of the provider's subscriptions on every commit and merges a non-null result into that subscription's delta. `isVisibilityRelevant(group, summary, dirty): boolean` (the rule below) is exported for providers.
- `onCommitEvent(fn: (conn: string, event: CommitEvent) => void)`: on each `table.onCommit`, for every connection known to the hub (registered by `addConnection(conn)`, also implicitly by `subscribe`), one `CommitEvent`: `revision`, `group` header, `boards` (all boards) when the group has any `board` effect (create, rename, remove; detected by inspecting the group's effects, no summary field), and `deltas` for that connection's subscriptions that changed; a connection without changes gets `deltas: []`.
- Candidate objects of a commit (all of these, deduplicated): the objects of every key in `summary.changedCells` (cell writes, `tag`/`shape` field effects, derived placement cells, every readable cell of created and removed objects, both containers' `contents` of every move, reordered containers); the object of every `field` effect in the group (`tag`, `shape`, `is_template`, `is_character`, `actions`); `summary.created`, `summary.removed`, `summary.moved` objects and their from/to containers; `summary.visibility` objects; `summary.actionsChanged` (vtt-75c.18); the objects of `dirty` keys; the reference holders below; for a `board` effect, only reference holders become candidates (board names are not in object views) and the event carries `boards`.
- References in effective literal content: a ref read from stored literal content (not through a formula) changes its value when its target disappears or reappears without any formula dependency, so the hub keeps `refTargets: Map<string, Set<ObjectId>>` from each referenced id (object or board) to the objects whose effective literal content names it. Effective literal content of a cell = its literal value, or, for a formula cell with an override, the override value; refs count when direct, inside lists at any depth, or ref entries of viewers values (`visible_to` and other viewers cells), and refs to boards count like refs to objects. The index is built at hub construction from the store and updated on every commit from `summary.changedCells` (re-reading those cells' stored content and overrides, which covers literal writes, override set and clear, formula sets, deletes and renames) and from created and removed objects. On every effect that changes an object's existence (`create`, `remove`, including the ones undo produces; a `retire` effect is treated the same way for its ids) and on every `board` effect that creates or removes a board (including undo inverses), every holder in `refTargets[id]` joins the candidate set, whether or not the target is in any scope.
- Visibility-relevant commit: any changed or dirty key whose cell is `visible_to`, `face_up`, `opaque`, `owner`, `is_zone`, `position`, `rotation`, `shape`, `board`, `container` or `contents`; any `cell_visibility` effect; any create or remove; any `is_character` field effect (on any object, including the viewer itself); any `board` effect that creates or removes a board, including the ones undo produces (PROTOCOL.md §8: refs to a board are kept while it exists and redacted when it is gone, and a viewers value holding a board ref can change). It triggers a full recomputation of every character subscription's scope, views and covers.
- Delta per subscription. GM subscription: re-view the candidates plus objects that entered or left scope. Character subscription: the whole scope when the commit is visibility-relevant, else only the candidates. A view whose canonical JSON differs from `last` goes into `objects`; an object that left scope, was removed, or became invisible goes into `removed`; covers are diffed by key over the boards in scope. Subscriptions of a registered scope type get their delta entries from the provider.
- Evaluation (PROTOCOL.md §8): building a changed view pulls its cells, which may evaluate their transitive dependencies and the visibility and geometry inputs of the views and covers even when those lie outside every scope; no other dirty cell is evaluated by the commit.
- `unsubscribe(conn, id)` (unknown id: `not_found`), `dropConnection(conn)` free state; `stats(): {viewsBuilt}` for tests.

Done when: (1) deterministic tests, one per operation kind, each asserting the exact delta for a GM and an Aldric subscription: a literal `set_tag` and `set_shape` on an object no formula reads, a `reorder` (container re-sent), `set_template_flag`, `set_character_flag` on Aldric (his whole view recomputed), `set_actions`, a `create_object` and a `remove` inside a container (container `contents` re-sent), `rename_board` (`boards` in the event, no object delta), `add_board`, `remove_board`; (2) references in effective literal content, each for a GM `objects` subscription that does not include the target, with each holder's re-sent view equal to a fresh build: a direct ref, a ref nested in a list and a `visible_to` viewers ref, each held once as a literal and once as the override of a formula cell, re-sent when the target is removed and again when the removal is undone; clearing the override of a formula whose source does not mention the target removes the holder from `refTargets` (a later removal of the target sends no delta for that holder); a literal `board` ref to a board that is removed and re-created by undo re-sends the holder both times; (2b) board existence for a character: an object in an Aldric `objects` (subtree) subscription whose literal `visible_to` viewers value and whose literal list cell hold refs to a board, and a child object inside it holding a direct board ref; removing that (empty) board and then undoing the removal each produce deltas after which every maintained view equals a fresh `subscribe` (refs `redacted` while the board is gone, restored after the undo), and `isVisibilityRelevant` is true for both commits; (3) a die moved into the dice tray yields a delta containing the tray with its new sum although the die was never its dependency; (4) revealing a room zone to Aldric yields cover removal and upserts of the tokens under it for Aldric's subscription and only the zone's view for the GM's; an `objects` subscription on a card in a hand on `crypt` receives `crypt`'s covers; (5) on a 3,000-object board a write to a literal cell with no dependents builds at most 3 views for a GM subscription (`stats`); (6) a formula cell not reachable from any subscribed view is not evaluated by the commit (engine `stats().evaluations` unchanged), while a subscribed formula whose dependency lies outside the scope is recomputed together with that dependency; (7) inside the commit listener `table.value` already reflects the commit; (8) a connection with no subscriptions receives `deltas: []`; (9) the 17th subscription is `busy`; (10) a `log` subscription without a registered provider is `unsupported`, and a stub provider registered for `log` receives `subscribe`, one `onCommit` per commit with `visibilityRelevant` set as the rule says, and `drop` on unsubscribe, and its result appears in the delta; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0. The randomized fresh-subscribe equivalence test across object, cover and log scopes lives in vtt-5su.12.

Out of scope: the log window (vtt-5su.20); the randomized cross-component equivalence test (vtt-5su.12); transport and wire ordering (vtt-5su.10); MCP change buffers (vtt-5su.15); finer index dependency keys (Polish); cell-level patches (vtt-qf5.4); chunked initial snapshots (vtt-y1w.12).

Depends on: vtt-5su.6, vtt-75c.12, vtt-75c.18.

---

### M3-f2 — vtt-5su.20 — Protocol: log window subscriptions

Implements: DESIGN.md §4.4 ("the log … filtered by the same effective visibility"), §4.8, §5.2 Subscribe; docs/PROTOCOL.md §7.6 (group views), §8 (`log` scope: window of the newest `max_log_window` retained groups, `groups_upserted`, `groups_removed`) as written by vtt-5su.2.

Historical log-window maintenance for `log` subscriptions, plugged into vtt-5su.9's `SubscriptionHub` through its `registerScope` interface (no edit to `subscriptions.ts` or `table.ts`). Exclusive files: `packages/authority/src/protocol/log-window.ts`, tests `test/protocol/log-window.test.ts`; the sorted line `export * from "./protocol/log-window"` in `packages/authority/src/index.ts`. Group views come from vtt-5su.6's `ViewBuilder.groupView`.

- `logScopeProvider(table): ScopeProvider` (the interface of vtt-5su.9):
  - `subscribe(sub)`: the window = the newest `max_log_window` (200) retained groups; returns `groups` = their non-null group views with effects, newest first, built for `sub.viewer`; stores `lastGroups: Map<number, string>` (canonical JSON per sent index).
  - `onCommit(sub, commit)`: recomputes the window after the commit. GM viewer: views the new group, the undone group of an undo group (now `undone: true`), and drops indices that left the window. Character viewer: when `commit.visibilityRelevant`, re-views every group in the window (older groups' filtered effects, names and labels can change on a reveal, hide or remove, and refs to a board in older effects become `redacted` when the board is removed and are restored when the removal is undone; board creation and removal are visibility-relevant per vtt-5su.9's `isVisibilityRelevant` and PROTOCOL.md §8); otherwise as for the GM. Group views whose canonical JSON differs from `lastGroups` go into `groups_upserted` (newest first); indices that left the window or whose view became null go into `groups_removed`; returns null when both are empty.
  - `drop(sub)`: frees its state.
- `createSubscriptionHub(table): SubscriptionHub`: `new SubscriptionHub(table)` plus `registerScope("log", logScopeProvider(table))`; the server (vtt-5su.10) uses it.

Done when: tests on Tables built in the test, through `createSubscriptionHub`, show: a `log` subscription returns the newest groups newest first, at most 200; for Aldric, revealing a room upserts an older group whose effects become visible to him; hiding it again removes that group from his window (or re-sends it with fewer effects and `label: null`, whichever the view rules give, checked against a fresh `subscribe`); removing an object re-sends older groups without its effects; an undo re-sends the undone group with `undone: true` for the GM and for Aldric; an older group whose `cell` effect wrote a literal ref to a board (the cell since overwritten) is re-sent to Aldric with that ref `redacted` when the board is removed and with the ref restored when the removal is undone, each time equal to a fresh `subscribe`; the 201st group pushes the oldest index into `groups_removed`; a commit that changes no group view in the window yields no `log` delta entry; after each of these steps the maintained window equals a fresh `subscribe` of the same scope; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: object and cover scopes, the Table notification seam and the visibility-relevance rule (vtt-5su.9); the randomized cross-component equivalence test (vtt-5su.12); log sentences (M5); transport (vtt-5su.10).

Depends on: vtt-5su.9, vtt-5su.6.

---

### M3-g — vtt-5su.10 — Authority: WebSocket transport, router, authentication

Implements: DESIGN.md §7 Platform ("a local process … serves the UI over localhost with the op stream over a WebSocket"), §5.2 ("trusts its single connection … Query and write limits exist so a runaway agent cannot stall the table"); docs/PROTOCOL.md §1 (transport, envelope, close codes, `/healthz`), §2 (hello, auth, origin, `session`, `client.instance`), §3 (actors), §8 (ordering, heartbeat), §10 (errors, limits) as written by vtt-5su.2.

The WebSocket transport, router and authentication, in process (no CLI, no discovery file, no signals: vtt-5su.14). Exclusive files: `packages/authority/src/server/server.ts`, `connection.ts`, `router.ts`, tests `test/server/server.test.ts`, `connection.test.ts`, `router.test.ts`, `ordering.test.ts`, `large-snapshot.test.ts`; the sorted line `export * from "./server/server"` in `packages/authority/src/index.ts`. Adds to `@vtt/authority`'s package.json: dependency `ws` 8.22.0, devDependency `@types/ws` 8.18.2; run `pnpm install` and commit `pnpm-lock.yaml` in the same commit.

- `startServer({host: TableHost, port = DEFAULT_PORT, hostname = "127.0.0.1", token?, allowOrigins = [], helloTimeoutMs = 5000}): Promise<RunningServer>` with `RunningServer = {url, port, token, session, close(reason?): Promise<void>}`; `port: 0` picks a free port; `url` is `ws://127.0.0.1:<port>/ws`; the token is the given one or 32 random bytes base64url; `session` is a random id generated once per `startServer` call. Node `http` server: `GET /healthz` → `200 {"ok":true,"revision":n}`; every other path 404; WebSocket upgrades (ws `noServer`, `maxPayload = max_message_bytes`, which bounds incoming frames only) only on `/ws`. An upgrade whose `Origin` header is present and is neither `http://127.0.0.1:<port>`, `http://localhost:<port>` nor in `allowOrigins` is refused with HTTP 403 before upgrading. `close(reason)`: stops accepting, sends `goodbye {reason}` and closes every connection with 1001, stops the heartbeat, closes the HTTP server; resolves when all sockets are closed; it does not close the host.
- Connection (`connection.ts`): `awaiting_hello` → `ready`. No `hello` within `helloTimeoutMs` → close 4408. The first message must be `hello`; any other first message, or a wrong token (constant-time comparison), → `goodbye` + close 4401; a `protocol` other than 1 → `goodbye` + close 4400. Actor: `client.kind: "agent"` → `{type:"agent", name: agent_name ?? client.name}`; otherwise `{type:"gm"}`. Reply `welcome` with `session`, actor, revision, boards, table `{name: basename, path, id: host.tableId}`, `LIMITS`; register the connection with the `SubscriptionHub` (vtt-5su.9). The connection keeps `client.instance` for command contexts.
- Requests: parsed with `parseClientMessage`; a parse failure answers `bad_request` (with the id when it could be read, else null) and keeps the connection. A token bucket of `max_requests_per_second` per connection; an excess request answers `busy`. A connection whose `bufferedAmount` exceeds `max_buffered_bytes` (64 MiB) is closed 4429. `router.ts` maps methods: `transact`, `undo` → vtt-5su.5 (`CommandContext` with the connection's actor, kind and `client.instance`, the host's dice, one server-wide `TxnCache`, which keys entries per client instance); queries → vtt-5su.8; explain → vtt-5su.16; `subscribe`, `unsubscribe` → the server's one hub, built with vtt-5su.20's `createSubscriptionHub(host.table)` (object and cover scopes from vtt-5su.9, `log` from vtt-5su.20); `save` → `await host.save()`; `invoke` → `unsupported`. `ProtocolFailure` → its error; any other exception or rejected promise → `internal` (logged to stderr with the request id), the connection stays open.
- Ordering (PROTOCOL.md §8): handlers may be async (only `save` is); the router processes one message per connection at a time in arrival order (each connection has a queue; the next message starts after the previous response is sent); other connections proceed while one awaits a save. All other handlers are synchronous, so commits are totally ordered; commit events from `hub.onCommitEvent` are sent synchronously as they are produced, so every connection receives them in revision order and the committing connection receives the commit event before its response. A `save` response is sent after the corresponding `save` event.
- Heartbeat: ws ping every 15 s; a connection missing two pongs is terminated. `host.onSave` results are broadcast as `save` events to every ready connection. On close: `hub.dropConnection`.

Done when: tests with a real server on port 0 and Node's global `WebSocket` show: `/healthz` answers with the revision; a wrong token, a wrong protocol, a non-hello first message and a missing hello (`helloTimeoutMs: 100`) each close with their code; a foreign `Origin` gets 403 and an `allowOrigins` entry connects; `welcome` carries `{type:"gm"}` for `ui` and `{type:"agent", name}` for `agent`, and the same `session` for two connections to one server and a different one after restarting the server in the test; a malformed request gets `bad_request` and the next request works; an oversize client frame closes the connection; 300 requests in one burst get some `busy`; two clients: A subscribes to a board, B commits a `transact`, A receives the commit event with a delta, B receives its commit event before its response; ten interleaved transacts from two clients give strictly increasing revisions seen in the same order by both; a `transact` sent by A while A's `save` awaits a delayed write (host with an injected slow fs) is answered after the save response, while B's `transact` sent meanwhile commits before A's save completes; two clients with different `client.instance` using the same `txn_id` both commit, and the same client repeating it gets the stored result; a handler that throws answers `internal` and the connection survives; `invoke` answers `unsupported`; `save` writes the file and broadcasts a `save` event before its response; a subscription to scope `all` on a 3,000-object table returns one response larger than `max_message_bytes` over the real transport and the client stays connected; `close("shutdown")` sends `goodbye` and closes clients with 1001; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: `vtt-serve`, the session file, signals and process exit (vtt-5su.14); serving the UI's static files, token injection into the page, and assets (M4); TLS and remote access (vtt-y1w.8); the client (vtt-5su.7); MCP (vtt-5su.11, vtt-5su.15, vtt-5su.17); multiplayer rights (vtt-y1w.9); chunked snapshot delivery (vtt-y1w.12).

Depends on: vtt-5su.3, vtt-5su.4, vtt-5su.5, vtt-5su.8, vtt-5su.9, vtt-5su.16, vtt-5su.20.

---

### M3-g2 — vtt-5su.14 — Authority: server process (vtt-serve CLI, discovery file, shutdown)

Implements: DESIGN.md §7 Platform (one local authority process), §7 Persistence (save on shutdown); docs/PROTOCOL.md §2 (discovery file with `table_path` and `table_id`, new table, lock file, default port, `--token`, `--allow-origin`) as written by vtt-5su.2.

The `vtt-serve` process around the in-process server: CLI, discovery file, lock and port failures, signal-driven shutdown. Exclusive files: `packages/authority/src/server/session-file.ts`, `src/bin/serve.ts`, tests `test/server/session-file.test.ts`, `test/server/serve-cli.test.ts`; the sorted line `export * from "./server/session-file"` in `packages/authority/src/index.ts`. Adds to `@vtt/authority`'s package.json: dependency `tsx` 4.23.15 and `"bin": {"vtt-serve": "./src/bin/serve.ts"}`; root package.json script `"serve": "node --import tsx packages/authority/src/bin/serve.ts"`; run `pnpm install` and commit `pnpm-lock.yaml` in the same commit. This bead runs after vtt-5su.11 (recorded dependency) so the two package.json edits never happen concurrently. `serve.ts` starts with `#!/usr/bin/env -S node --import tsx`.

- `session-file.ts`: `sessionFilePath()` = `$XDG_CONFIG_HOME/vtt/session.json` (default `~/.config/vtt/session.json`); `writeSessionFile({url, token, pid, table_path, table_id})` (`table_path` = `host.path` (the canonical path, vtt-5su.18's `canonicalTablePath`), `table_id` = `host.tableId`) (directory 0700, file 0600, written atomically); `readSessionFile(): SessionInfo | null` (missing or invalid file → null); `removeSessionFile(pid)` removes the file only when its pid matches.
- `bin/serve.ts`: `vtt-serve <file> [--port n] [--token t] [--allow-origin o]… [--no-autosave] [--print-session] [--force-unlock]` (`--token` fixes the token, e.g. across restarts in tests): with `--force-unlock`, first `removeTableLock(canonicalTablePath(file))` (vtt-5su.18) and log to stderr what it removed (`pid`, `host`, `started`, or that there was no lock), the only place a lock is ever taken over (D33); then `TableHost.open(file, {createIfMissing: true, autosave})` (vtt-5su.4), `startServer` (vtt-5su.10), `writeSessionFile`; `--print-session` prints one JSON line `{"url", "token", "session", "table_path", "table_id"}` to stdout once listening; all logs go to stderr.
- Startup failures: the table is locked (vtt-5su.18's `TableLockedError`, surfaced by `TableHost.open`) → exit 1 with a one-line message naming the file, the recorded pid, host and start time, and, when `stale` is true, telling the user to rerun with `--force-unlock` if no other `vtt-serve` uses the table; the session file is not touched; a `TableIdentityError` (vtt-5su.18) → exit 1 with a one-line message naming the `.table-id` file and saying to fix or delete it; the port is in use → `await host.close()` (releases the lock), exit 1 with a one-line message.
- Shutdown on SIGINT or SIGTERM, in order, once (a second signal during shutdown is ignored): `server.close("shutdown")` (stops accepting, `goodbye`, close 1001); `const r = await host.close()`, which awaits outstanding saves, saves unsaved work, always releases the lock and never throws for a save failure (vtt-5su.4); `removeSessionFile(process.pid)`; exit 0 when `r.saved`, else log `r.error` with the revision to stderr and exit 1.

Done when: unit tests show `writeSessionFile` creates the directory 0700 and the file 0600 under a temp `XDG_CONFIG_HOME`, `readSessionFile` returns null for a missing or corrupt file, and `removeSessionFile` leaves a file written by another pid; subprocess tests spawn `vtt-serve` on a temp file with `--port 0 --print-session` and `XDG_CONFIG_HOME` in a temp directory and show: a missing file is created with the `gm_board` board; the session file is written with mode 0600 and matches the printed line; `/healthz` answers; after a `transact` through a client, SIGTERM saves (the reopened file has the write), removes the session file and the lock file, and exits 0; a `transact` committed immediately before SIGTERM (no autosave yet, `--no-autosave`) is in the file after exit; a second `vtt-serve` on the same file exits 1 naming the lock holder while the first keeps serving; after a `vtt-serve` is killed with SIGKILL (stale lock left), a new `vtt-serve` on the file exits 1 and its message mentions `--force-unlock`, and `vtt-serve --force-unlock` on the file logs the removed lock and starts serving; a `vtt-serve` on a port in use exits 1 and leaves no lock file; restarting with `--port <same> --token <same>` serves the same url and token with a new `session`; restarting without `--token` rewrites the session file with a new token and the same `table_path` and `table_id`; a failing final save: after a commit with `--no-autosave`, the test replaces the table file with a non-empty directory of the same name (so the final save's rename fails, stage `before_replace`), then SIGTERM logs the save error, removes the lock file and exits 1; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: the transport, router and auth (vtt-5su.10); the lock implementation (vtt-5su.18) and save ordering (vtt-5su.4); `vtt-mcp` (vtt-5su.17); serving UI files (M4); running as a daemon or service.

Depends on: vtt-5su.10, vtt-5su.4, vtt-5su.11.

---

### M3-h2 — vtt-5su.18 — Authority: table lock and identity files

Implements: docs/PROTOCOL.md §2 (canonical table path, lock file protocol without automatic takeover, table identity file) as written by vtt-5su.2; DESIGN.md §7 Persistence (one authority owns the file); decision D33 (v1 refuses stale locks; takeover is manual).

File-system ownership of a table, separate from save scheduling (vtt-5su.4). Exclusive files: `packages/authority/src/host/lock.ts`, `host/identity.ts`, tests `test/host/lock.test.ts`, `test/host/identity.test.ts`; sorted lines `export * from "./host/identity"` and `export * from "./host/lock"` in `packages/authority/src/index.ts`.

```ts
canonicalTablePath(path: string, fs?): string;                                   // identity.ts
readOrCreateTableId(canonicalPath: string, lock: TableLock, fs?): Promise<string>;  // identity.ts
acquireTableLock(canonicalPath: string, opts?: {fs?, hostname?: string, isAlive?: (pid: number) => boolean}): Promise<TableLock>;  // lock.ts
interface TableLock { readonly path: string; readonly nonce: string; release(): Promise<void> }
removeTableLock(canonicalPath: string, fs?): Promise<LockInfo | null>;           // lock.ts, for --force-unlock
type LockInfo = { pid: number; nonce: string; host: string; started: string };
class TableLockedError extends Error { info: LockInfo | null; stale: boolean }
class TableIdentityError extends Error { path: string; content: string }
```

- `canonicalTablePath`: `fs.realpathSync(path)` when the file exists; otherwise `realpathSync(dirname(path))` joined with `basename(path)` (the directory must exist, else the error names it). Every lock and identity path is derived from it, so symlink aliases of one table share them.
- `acquireTableLock` (PROTOCOL.md §2): `open("<canonical>.lock", "wx")`, write JSON `{pid, nonce, host, started}` (random `nonce`, `host` = `os.hostname()`), fsync, close → a `TableLock`. Any failure after the open succeeded (write, fsync, close) unlinks the file this call created, after reading it back and checking the nonce when it is readable (an unreadable file this call created is unlinked as well, since the exclusive create proved it was this call's), then rethrows the original error. `EEXIST` → read the lock and throw `TableLockedError` with `info` (null when unreadable or malformed) and `stale` = `info` is valid, `info.host` equals this host and `isAlive(info.pid)` is false (default `isAlive` = `process.kill(pid, 0)` without `ESRCH`); unreadable or malformed content is `stale: false`. No code path takes a lock over.
- `TableLock.release()`: reads the lock and unlinks it only if it holds this lock's nonce; idempotent; a missing file is not an error.
- `removeTableLock`: reads and unlinks `<canonical>.lock` unconditionally, returning what it removed (or null when there was none); used only by `vtt-serve --force-unlock` (vtt-5su.14), never by `TableHost`.
- `readOrCreateTableId(canonical, lock)`: requires the table lock to be held (the `lock` argument documents and checks it: its `path` must be `<canonical>.lock`); calls for the same canonical path are serialized in process by a per-path promise (a second call waits for the first and then reads). If `<canonical>.table-id` exists it is read: one UUID line → that id; empty or malformed → `TableIdentityError` (never rewritten; a human fixes or deletes it). If it is missing: write a new UUID to `<canonical>.table-id.tmp-<nonce>`, fsync, `rename` it to `<canonical>.table-id` (safe: the held table lock serializes writers across processes, the per-path promise within one); on any failure remove the temp file and rethrow, leaving no identity file.

Done when: tests in a temp directory show: acquiring a free lock writes `{pid, nonce, host, started}`; two acquirers racing on the same path (started together, in process and as two child processes) end with exactly one `TableLock` and one `TableLockedError` with `stale: false`; a lock whose pid is an exited child process refuses with `stale: true` and the recorded info; `removeTableLock` then returns that info and a following acquire succeeds; a lock from another host refuses with `stale: false`; a malformed lock file refuses with `info: null, stale: false`; with an injected `fs` whose write (and, separately, fsync) fails after a successful exclusive create, acquire rethrows and leaves no lock file; a `TableLock` whose file was removed and re-acquired by another acquirer does not unlink the new owner's lock on `release()`, and `release()` twice is harmless; a symlink to the table and the table itself give the same canonical path, and acquiring through the symlink while the real path is locked throws `TableLockedError`; `canonicalTablePath` of a missing file in an existing directory resolves the directory's symlinks; `readOrCreateTableId` creates the file once and returns the same id on later calls and through a symlink, a lock for another path is rejected, and two concurrent in-process calls, the first paused (injected `fs`) after writing its temp file, return the same id, the second only after the first has renamed; an injected write failure leaves neither an identity file nor a temp file; an empty and a malformed identity file each throw `TableIdentityError` and are left unchanged; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: opening and saving tables, autosave and `close()` (vtt-5su.4); the `--force-unlock` flag and the session file (vtt-5su.14); the decision-log row for D33 (vtt-5su.2); network file systems beyond refusing foreign-host locks.

Depends on: vtt-5su.2.

---

### M3-h — vtt-5su.4 — Authority: table host (open, autosave, save, close)

Implements: DESIGN.md §7 Persistence (autosave cadence, atomic saves with two failure stages, assets beside the file, hand edits), §8.4 steps 1, 6, 15; docs/PROTOCOL.md §2 (new table; lock and identity files through vtt-5su.18) as written by vtt-5su.2, and the autosave decision D24 recorded by vtt-5su.2 in DESIGN §7.

Opening, saving and closing a table; the lock and identity files are vtt-5su.18's. Exclusive files: `packages/authority/src/host/table-host.ts`, `new-table.ts`, tests `test/host/table-host.test.ts`, `test/host/autosave.test.ts`, `test/host/new-table.test.ts`; sorted lines `export * from "./host/new-table"` and `export * from "./host/table-host"` in `packages/authority/src/index.ts`.

- `TableHost.open(path, {createIfMissing = false, dice?: DiceSource, autosave = {debounceMs: 2000, maxDelayMs: 10000, retryMs: [1000, 5000, 30000, 60000]} | false, clock?, fs?}): Promise<TableHost>`: acquires the lock, then `loadTable(path)` (vtt-75c.17) or, when the file is missing and `createIfMissing`, `newTableSnapshot()` (one board `gm_board` named "GM", no objects, revision 0, empty log, no assets) followed by an immediate save; missing without `createIfMissing` is an error naming the path. After the lock is held, any failure of `open` (load error, corrupt or invalid file, initial-save failure, table-id file failure) releases the lock before the error propagates. `tableId` is the value `readOrCreateTableId` returned (`null` for `inMemory`). Exposes `table` (vtt-75c.12 `Table.fromStore`), `dice` (default vtt-75c.15 `RandomDiceSource` seeded from `crypto.getRandomValues`), `path`, `assets` (the asset list `loadTable` returned, `[]` for a new table), `warnings: string[]` (missing assets, `editedExternally`), `revision`, `lastSavedRevision`. `fs` is the injectable file-system seam passed through to `saveTable`/`loadTable` (tests use it to delay or fail writes).
- `TableHost.inMemory(store, {dice?}): TableHost`: no file, no lock, no autosave; `save()` returns `{status: "failed", revision, message: "no file"}`.
- Lock and identity: `open` calls vtt-5su.18's `canonicalTablePath(path)`, then `acquireTableLock(canonical)` (a `TableLockedError`, stale or not, propagates unchanged; the host never removes a lock), keeps the returned `TableLock`, then `readOrCreateTableId(canonical, lock)`; `path` is the canonical path. `lock.release()` is called on `close()`, only after every save has settled, and on every failed `open` after the lock was acquired.
- Save ordering: saves are serialized through one queue; at most one `saveTable` is in flight. A save captures its state synchronously when it starts: the host records the current revision and calls vtt-75c.17's `saveTable(path, store, assets, fs)` in the same tick, and `saveTable` serializes the store before its first await, so the bytes written are exactly the captured revision (vtt-75c.17's stated contract, with its own same-tick test); on success `lastSavedRevision` becomes the captured revision (never the revision current when the I/O finishes), so commits made during the I/O keep the host dirty and schedule another save. A save requested while one is in flight runs after it and captures its own state then; requests for a revision already saved or captured by a queued save are coalesced. Every `saveTable` call passes the retained `assets` unchanged.
- Autosave: after each commit (via the store's public `onCommit`), schedule a save `debounceMs` after the latest commit, but no later than `maxDelayMs` after the first unsaved commit. `save()` saves now (queued behind an in-flight save) and cancels the pending schedule. Results map to `saved` (ok; `lastSavedRevision` = captured revision), `saved_not_durable` (stage `after_replace`; the bytes are in place but `lastSavedRevision` does not advance and it is retried like a failure), `failed` (stage `before_replace`; the revision stays unsaved), and are emitted to `onSave(listener)` as `{status, revision /* captured */, message?}`. After a failure, retries are scheduled by `retryMs` (1 s, 5 s, 30 s, then every 60 s, repeating the last) until a save of that revision or a later one succeeds, with no further commits needed; a commit during the backoff does not cancel the retry, and the next attempt is the earlier of the retry timer and the regular schedule; a success resets the backoff. No automatic compaction.
- `close(): Promise<{saved: boolean; revision: number; error?: string}>`: cancels timers, awaits the in-flight and queued saves, saves if `revision !== lastSavedRevision`, then always releases the lock; never throws for a save failure; `saved` is true iff `lastSavedRevision === revision` at the end (a final `saved_not_durable` or `failed` gives `saved: false` with `error` the save's message), `revision` the table's revision; idempotent (a second call returns the first call's result). `inMemory` hosts return `{saved: false, revision, error: "no file"}`.

Done when: tests with fake timers and a temp directory show: opening a missing path with `createIfMissing` writes a loadable file with the GM board; without it, an error naming the path; a second `open` on the same path, or through a symlink to it, while the first holds the lock throws `TableLockedError`; an `open` over a stale lock (pid of an exited child) throws `TableLockedError` with `stale: true` and leaves the lock file in place; an `open` with a malformed `.table-id` file rejects with `TableIdentityError` and releases the lock; opening a corrupt file and opening with an injected initial-save failure each reject and leave no lock file; `tableId` is the same after a reopen; three commits 500 ms apart produce one save 2 s after the last; commits every second produce a save at 10 s; `save()` saves immediately and cancels the pending one; a fault-injected `before_replace` failure emits `failed` and the next scheduled save succeeds; a failed autosave followed by no further commits is retried at 1 s, 5 s and 30 s (fake timers, each attempt failing until the third succeeds) and ends saved; an `after_replace` failure emits `saved_not_durable`, leaves `lastSavedRevision` unchanged and schedules a retry; with a delayed write (fs seam), a commit made while the save is in flight leaves `lastSavedRevision` at the captured revision, emits `saved` with that revision, and a second save follows that persists the later commit; a commit in the same tick right after a save starts is not in that save's file; two overlapping `save()` calls run one after the other and the file ends with the newer snapshot; a file opened with two assets keeps both assets in the file after an autosave and after `close()`; `close()` during a delayed save awaits it, saves unsaved work, and only then removes the lock file; `close()` whose final save fails (injected `before_replace`) resolves `{saved: false, revision, error}`, does not throw, and removes the lock file; `close()` with nothing unsaved resolves `{saved: true, revision}`; reopening shows the same snapshot and log (indices, barrier); a hand-edited file opens with an `editedExternally` warning; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: the lock protocol and identity file (vtt-5su.18); the server and process (vtt-5su.10, vtt-5su.14; .14 writes `tableId` into the session file); compaction policy (vtt-qf5.6); stocking the GM binder with example templates (M5); asset import (M4); in-memory checkpoints (Polish).

Depends on: vtt-5su.2, vtt-5su.18, vtt-75c.12, vtt-75c.15, vtt-75c.17.

---

### M3-i — vtt-5su.7 — Client: mirror and request correlation

Implements: docs/PROTOCOL.md §1–§3 (transport, hello with `client.instance`, welcome with `session` and `table`, actors), §8 (commit events, deltas incl. log window, ordering, mirror revision), §10 (client-side result validation), §12 (forward-compatible envelope parsing) as written by vtt-5su.2; DESIGN.md §7 ("The UI and the agent are two clients of the same protocol").

The basic client: one connection, request correlation, per-method result validation, mirrors and events, plus the documented seam vtt-5su.19 uses for reconnection, retry and subscription recovery (which this bead does not implement). Exclusive files: `packages/protocol/src/client.ts`, `mirror.ts`, tests `test/client.test.ts`, `test/mirror.test.ts`, `test/support/fake-server.ts` (vtt-5su.19 imports it); sorted lines `export * from "./client"` and `export * from "./mirror"` in `packages/protocol/src/index.ts`. Browser-safe: neither file imports `node:` modules (a test reads both sources and asserts it).

- `new ProtocolClient({url, token, client: {name, kind}, instance = crypto.randomUUID(), agent_name?: string | (() => string | undefined), WebSocket = globalThis.WebSocket, requestTimeoutMs = 30000, onWarning = console.warn})`. `instance` is sent as `hello.client.instance` on every connect of this client object and never changes. A function `agent_name` is evaluated when each `hello` is sent (so a caller can construct the client before it knows the name).
- `connect(): Promise<Welcome>` (sends `hello` first; rejects on `goodbye` or close, with code `unauthorized` for 4401 and `protocol_version` for 4400); `state`: `"idle" | "connecting" | "open" | "reconnecting" | "recovering" | "closed"` (`idle` before the first `connect`; this bead never enters `reconnecting` or `recovering` by itself; `ready` = `state === "open" && connectionError() === null`); from `welcome`: `session`, `actor`, `limits`, `table` (`{name, path, id}`); `revision` (from `welcome`, then from every commit event); `boards` (from `welcome` and commit events carrying `boards`); `close()` (state `closed`, no further activity).
- `connectionError(): null | {code: "disconnected" | "unauthorized" | "wrong_table"; message: string; recovering?: true}`: `{code: "disconnected"}` from construction until the first successful `welcome` of `connect()`, which clears it; set to `disconnected` when the socket closes other than by `close()`, to `unauthorized` on a 4401; `reopen` does not clear it (vtt-5su.19 clears it when recovery is complete); `wrong_table` and `recovering: true` are only ever set through the seam.
- `request<M>(method, params): Promise<Result<M>>`: request ids are a per-client counter rendered as strings; the pending entry records the method. Every incoming frame goes through `parseServerMessage` (envelope only, PROTOCOL.md §12): an `ignored` result and parse `warnings` go to `onWarning` and never close the socket; an envelope error closes the socket. A success response is validated and normalized with `parseResult(pendingMethod, result)` (vtt-5su.3), whose `value` resolves the request and whose `warnings` go to `onWarning`; on failure the request rejects with that `ProtocolFailure` (`code: "internal"`, `details.type: "protocol"`), the socket stays open, and no mirror changes (a `subscribe` result is validated before any mirror is created or reset). Error responses reject with their `ProtocolError`. A request made while not `open` rejects at once with `disconnected` and `details: {sent: false}`. For a request already written to the socket (PROTOCOL.md §6, §10): a query rejects `timeout` after `requestTimeoutMs` and `disconnected` with `details: {sent: true}` when the socket drops; a write (`transact`, `undo`) rejects `uncertain` with `details: {sent: true, reason: "timeout" | "socket_closed", txn_id?}` in both cases.
- `transact(ops, {label?, base_revision = this.revision, txn_id = crypto.randomUUID(), actor?})`: convenience over `request("transact", …)`; never retries (vtt-5su.19's `transactWithRetry` does).
- `subscribe(params): Promise<Subscription>`; `Subscription = {id, params, mirror: ViewMirror, state: "live" | "recovering" | "failed" | "closed", on(event, fn), close(): Promise<void>}` (close sends `unsubscribe`; on a `failed` subscription it resolves without a request).
- Frozen event contract: `sub.on("delta", (sub, e: DeltaEvent) => void)` with `DeltaEvent = {revision, group: GroupHeader, delta: SubscriptionDelta, before: Map<ObjectId, ObjectView | undefined>, after: Map<ObjectId, ObjectView | undefined>}`, keyed by every id in `delta.objects` and `delta.removed` (`undefined` = absent), called once per delta entry of a commit event, after the mirror has applied it; `sub.on("resync", (sub, e: {from_revision, to_revision, session_changed: boolean}) => void)` and `sub.on("error", (sub, error: ProtocolError) => void)` are emitted only through the seam. `client.on("commit" | "save" | "state", fn)` with the raw event or the new state; for a commit, `client.on("commit")` listeners run after every subscription's delta listeners.
- `ViewMirror` (mirror.ts): `objects: Map<ObjectId, ObjectView>`, `covers: Map<string, Cover>`, `groups: Map<number, GroupView>` with `groupsNewestFirst(): GroupView[]` (log scope), `revision`; `reset(initial: SubscribeResult)`; `clear(revision)` empties it; `advance(revision)` sets `revision` only; `apply(delta: SubscriptionDelta, revision)` upserts objects, deletes `removed`, applies cover upserts and removals, upserts `groups_upserted` by index, deletes `groups_removed`, and sets `revision`. On every processed commit event the client calls `apply` for each live subscription with a delta and `advance` for every other live subscription (PROTOCOL.md §8), so after a processed commit every live mirror's revision equals `client.revision`.
- Recovery seam (exported, documented as used by vtt-5su.19): `client.on("socket_closed", fn({code, reason, byClose: boolean}))`, emitted after pending requests were rejected; `client.reopen(creds?: {url, token}): Promise<Welcome>` opens a new socket to the given (or current) url with the given (or current) token, sends `hello` with the same `instance`, applies the `welcome` (session, revision, boards, table, limits) without clearing `connectionError`, rejecting with the close code's error (or `disconnected` for a transport failure) on failure; `client.connect()` may itself be retried through `reopen` when it never succeeded (then the first successful `welcome` is the client's first); `client.setState(state)`; `client.setConnectionError(error | null)`; `client.liveSubscriptions(): Subscription[]`; `sub.rebind(id, result: SubscribeResult, info: {from_revision, to_revision, session_changed})` validates `result` with `parseResult("subscribe", …)`, replaces the protocol id, resets the mirror and emits `resync`; `client.requestDuringRecovery(method, params)` is `request` with the same correlation, timeout and `parseResult` validation, but allowed in state `recovering` (ordinary `request` stays gated on `open`); `client.abortSocket(reason)` closes the current socket, rejects its pending requests as a drop would, emits `socket_closed` with `{code: 4000, reason, byClose: false}` and sets state `idle`, from which `reopen` can connect again (it never closes the client terminally; `close()` stays the only terminal path); `sub.markRecovering()` sets `state: "recovering"` (mirror kept, no events); `sub.fail(error)` sets `state: "failed"`, clears the mirror and emits `error` once.

Done when: tests against `fake-server.ts` (an in-memory WebSocket-shaped peer scripted per test, injected through the `WebSocket` option) show: `hello` is the first frame and carries the token and `client.instance`; request/response correlation with responses out of order; error responses reject with the error; timeout rejections; `connectionError()` is `disconnected` before `connect()` succeeds; a dropped socket rejects a pending query `disconnected` with `sent: true` and a pending `transact` and `undo` `uncertain` with `reason: "socket_closed"`, a write that times out rejects `uncertain` with `reason: "timeout"` while a query times out with `timeout`, the drop sets `connectionError()` to `disconnected`, and a request while closed rejects `disconnected` with `sent: false`; `connect` against a 4401 rejects `unauthorized` and `connectionError()` reports it; `revision`, `session` and `table` follow `welcome` and commit events; a malformed result (`get_objects` without `missing`) and a result valid for another method (a `subscribe` result answering a pending `list_objects`, `{}` answering `get_objects`) reject that request with `internal` / `details.type: "protocol"` while the connection stays open and a later request succeeds, and a malformed `subscribe` result creates no mirror; a mirror fed an initial view and three deltas equals the expected maps, including an object removal and a cover removal; a log-scope mirror fed `groups_upserted` and `groups_removed` (an undone group re-sent, a group leaving the window) equals the expected window; a `delta` listener receives `before`/`after` for an upserted and a removed object and sees the mirror already updated; a commit event with `deltas: []` advances the revision of every live mirror to the event's revision; an unknown key in a `welcome`, a result and an object view is ignored, an event of unknown kind and a message of unknown type are ignored with a warning, and the connection stays open; a known envelope with a missing required field closes the socket; the seam: `requestDuringRecovery` succeeds in state `recovering` while `request` in that state rejects `disconnected` with `sent: false`; `abortSocket` with the socket still open closes it, rejects pending requests, emits `socket_closed` with `byClose: false`, leaves state `idle`, and a following `reopen` connects again; `reopen` after a drop sends `hello` with the same `instance` and leaves `connectionError` set until `setConnectionError(null)`, `markRecovering` keeps the mirror, `rebind` emits `resync` with the given info and resets the mirror, `fail` emits `error` once and empties the mirror; `transact` fills `base_revision` and a UUID `txn_id`; the two source files contain no `node:` import; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: reconnection, backoff, credential refresh, `wrong_table`, write retries and resubscription (vtt-5su.19); the server (vtt-5su.10); MCP (vtt-5su.11, vtt-5su.15, vtt-5su.17); UI state management (M4); integration with the real server (vtt-5su.11, vtt-5su.12).

Depends on: vtt-5su.3.

---

### M3-i2 — vtt-5su.19 — Client: reconnect, retry and subscription recovery

Implements: docs/PROTOCOL.md §2 (credential refresh, `wrong_table`, explicit credentials, `disconnected` before the first `welcome`), §6 (client retries, `retry: true`, `retry_unknown`, `uncertain` for every unsettled sent write), §8 (reconnection, transport versus terminal resubscribe failures, readiness, resync) as written by vtt-5su.2.

Connection lifecycle, write retry and subscription recovery on top of vtt-5su.7's basic client, through its documented recovery seam only (no edit to `client.ts` or `mirror.ts`). Exclusive files: `packages/protocol/src/client/recovery.ts`, tests `test/recovery.test.ts`; the sorted line `export * from "./client/recovery"` in `packages/protocol/src/index.ts`. Browser-safe: no `node:` imports (a test asserts it). Tests use vtt-5su.7's `test/support/fake-server.ts` unchanged.

- `enableRecovery(client, {reconnect = {initialMs: 250, maxMs: 5000, factor: 2}, credentials?: () => Promise<{url, token, table_path, table_id} | null>}): () => void` (returns a disposer). It may be called before any successful connection: if the client has never connected, it makes the first connection itself through `client.reopen(...)` with the same backoff, and until the first `welcome` `connectionError()` stays `disconnected`. It records the table pair (`client.table.path`, `client.table.id`) of the first successful `welcome`. After every later successful `reopen`, before any subscription is rebound or any write retried, it compares the new `welcome`'s `table.path` and `table.id` with that pair (PROTOCOL.md §8); a mismatch is `wrong_table`: with explicit credentials, recovery ends (`setConnectionError({code: "wrong_table", …})`, state `closed`); with `credentials`, it calls `abortSocket("wrong_table")`, re-reads `credentials()` and reconnects once with them, and a second mismatch ends recovery the same way. On `socket_closed` other than by `close()` and other than 4400 it sets state `reconnecting` and retries `client.reopen(...)` with exponential backoff (`initialMs`, ×`factor`, capped at `maxMs`):
  - With `credentials` (discovery-based): before every attempt it calls `credentials()`; `null` keeps the current url and token; before the first `welcome` any result is used; afterwards a result whose `table_path` and `table_id` equal the recorded pair supplies the url and token, and a different pair ends recovery: `setConnectionError({code: "wrong_table", …})`, state `closed`. A 4401 on an attempt is not terminal (the next attempt re-reads).
  - Without `credentials` (explicit): a 4401, on the close or on an attempt, ends recovery: `setConnectionError({code: "unauthorized", …})`, state `closed`.
- Subscription recovery, after each successful `reopen`: state `recovering`, `setConnectionError({code: "disconnected", recovering: true, …})`; every subscription that is `live` or `recovering` is resubscribed with its original params through `client.requestDuringRecovery("subscribe", …)` (never `request`, which is gated on `open`). Outcome per subscription: a result → `sub.rebind(newId, result, {from_revision, to_revision, session_changed})` (`session_changed` compares the session of its last successful bind with the current one); a transport failure → `sub.markRecovering()`: if the socket closed, recovery returns to reconnecting; if the resubscribe timed out with the socket still open, it calls `client.abortSocket("resubscribe_timeout")` and returns to reconnecting (the subscription is retried on the next connection, keeping its handle and mirror); an error response from the server (`not_found`, `bad_request`, `busy`, or any other `ProtocolError` code the server sent) → `sub.fail(error)`. When every such subscription is rebound or failed, state `open` and `setConnectionError(null)`: the client is ready for ordinary callers.
- `transactWithRetry(client, ops, {label?, base_revision?, txn_id = crypto.randomUUID(), actor?, retry: {timeoutMs}})`: sends `transact`. A rejection `disconnected` with `sent: false` rejects `disconnected`. An `uncertain` with `reason: "socket_closed"` waits up to `timeoutMs` for the client to be ready again, then: same `session` as when sent → resends the identical params once with `retry: true` and returns the response's result (committed or rejected); any other outcome rejects code `uncertain` with `details: {txn_id, reason}`: `"timeout"` (the original timed out), `"not_ready"` (not ready within `timeoutMs`), `"session_changed"` (with `old_session`, `new_session`), `"retry_unknown"`, `"resend_lost"` (the resend's response was lost by socket close or timeout), `"unauthorized"` or `"wrong_table"` (recovery ended). It never resends more than once and never sends again after rejecting.

Done when: tests against `fake-server.ts` show: `enableRecovery` on a client whose authority is not reachable yet keeps `connectionError()` at `disconnected` and connects when the fake server starts accepting, recording the table pair from that first `welcome`; after a dropped socket the client reconnects at 250, 500, 1000 ms (fake timers), sends `hello` with the same `client.instance`, resubscribes with the same params, resets mirrors and emits `resync` (`session_changed` false for the same session, true for a new one) with the same `Subscription` object, and `connectionError()` reads `{code: "disconnected", recovering: true}` between the `welcome` and the last resubscribe result and `null` after it; with three subscriptions, after a drop, the fake server dropping the socket during resubscription on the first and on the second reconnection leaves all three `recovering` (no `error` event, no `failed` state, mirrors kept) and all three are rebound on the third reconnection; a resubscribe answered `not_found` (board removed while disconnected) makes that subscription emit `error`, become `failed` with an empty mirror, while a second subscription on another board resyncs normally; with `credentials`, a reconnect after the fake server changes its token succeeds with the token the callback returns, a callback returning a different `table_id` (and, separately, a different `table_path`) closes the client with `connectionError().code === "wrong_table"`, and `null` retries with the old credentials; without `credentials`, a 4401 closes the client with `unauthorized`; a resubscribe that times out while the socket stays open leads to `abortSocket("resubscribe_timeout")`, a new connection and successful rebinding of every subscription (all resubscribes go through `requestDuringRecovery`, none through `request`); a reconnect whose `welcome` names a different `table.id` with the discovery file unchanged re-reads the file, reconnects once, and on the second mismatch closes the client with `wrong_table` without rebinding or resending anything; the same with the discovery file missing; with explicit credentials, the first mismatched `welcome` closes the client with `wrong_table`; `transactWithRetry` whose socket drops after the send is resent once with the same `txn_id` and `retry: true` after reconnecting to the same session and returns the stored result; each of these rejects `uncertain` with its `reason` and the fake server's count of received `transact` frames proves no further send: the original timing out, recovery not ready within `timeoutMs`, a session change, a `retry_unknown` answer, the resend's response lost, a 4401 with explicit credentials, and `wrong_table`; a send attempted while closed rejects `disconnected` without waiting and without a frame; the source contains no `node:` import; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: the basic client, mirrors and the seam itself (vtt-5su.7); reading the session file and MCP startup order (vtt-5su.17); the server's deduplication (vtt-5su.5); UI reconnect presentation (M4); persistent deduplication (vtt-y1w.11).

Depends on: vtt-5su.7.

---

### M3-j — vtt-5su.11 — MCP: tools and resources (request surface)

Implements: DESIGN.md §5.1, §5.2 (Query, Write, Explain; "anything a human can do through the UI must be expressible through this surface"; limits), §5.3; docs/PROTOCOL.md §11 (MCP tools, results, connection gate, resources, tool descriptions) as written by vtt-5su.2.

The MCP server's request/response surface: tool registration, input schemas, result mapping and the static resources, tested in process. Subscriptions (`subscribe`, `poll_changes`, `unsubscribe`, change buffers, `vtt://subscriptions/<handle>`) are vtt-5su.15; the `vtt-mcp` binary is vtt-5su.17. Exclusive files: `packages/authority/src/mcp/server.ts`, `tools.ts`, `resources.ts`, `gate.ts`, tests `test/mcp/tools.test.ts`, `test/mcp/resources.test.ts`, `test/mcp/support.ts` (shared in-process harness: `TableHost.inMemory` + `startServer` on port 0 + `ProtocolClient` with vtt-5su.19's `enableRecovery` (explicit credentials) + the SDK's in-process transport pair; vtt-5su.15 imports it); the sorted lines `export * from "./mcp/gate"` and `export * from "./mcp/server"` in `packages/authority/src/index.ts`. Adds `@modelcontextprotocol/server` 2.3.1 (dependency) and `@modelcontextprotocol/client` 2.3.1 (devDependency) to `@vtt/authority`; run `pnpm install` and commit `pnpm-lock.yaml` in the same commit. The SDK's exact API (server class, tool and resource registration, an in-process transport pair for tests) is taken from the installed packages' type declarations. If 2.3.1 lacks zod-4 or JSON Schema tool input schemas, stop and report; do not switch SDKs.

`createMcpServer({client: ProtocolClient, name = "vtt", extensions = []})`: registers the tools below and the resources, then calls each `extensions[i](server, client)` (the hook vtt-5su.15 uses to add the subscription tools and resource; no other bead edits `server.ts`). Input schemas (PROTOCOL.md §11) are explicit MCP schemas in `tools.ts`, derived from `@vtt/protocol`'s params schemas (vtt-5su.3) with zod `omit`/`extend`/`strict` and converted with `z.toJSONSchema`: every one is strict (unknown keys are an MCP input error); `transact` omits `actor`, `retry` and `txn_id` (the MCP server always generates `txn_id`); `undo` narrows `target` to `{type:"latest"} | {type:"mine"} | {type:"group", index}`; every other tool's schema is its method's params schema made strict. An input that fails its schema is rejected by the SDK or the handler before any request is sent; results are `@vtt/protocol` result objects returned as `structuredContent` plus one JSON text block.

| Tool | Behaviour |
|---|---|
| table_info | `{revision, boards, table, limits, actor, session}` from the client |
| list_objects, get_objects, evaluate, zones, at_position, changes_since, log | the same-named methods |
| explain_cell, explain_group, explain_action | the same-named methods |
| transact | `transactWithRetry(client, ops, {base_revision /* required */, label, txn_id: crypto.randomUUID(), retry: {timeoutMs: 10000}})` (vtt-5su.19: resent once with the same `txn_id` and `retry: true` after reconnecting to the same `session`; every other unsettled outcome after the send is `uncertain`) |
| undo | `undo` (targets `latest`, `mine`, `group`; `expect_index`) |
| save | `save` |

- Connection gate (gate.ts, PROTOCOL.md §11): `withConnection(client, handler)` wraps a tool handler; when `client.connectionError()` (vtt-5su.7) is non-null it returns `isError: true` with `{code, message}` of that error without calling the handler; otherwise it calls the handler. Every tool defined here is registered through it, `table_info` included (so cached fields are never served while disconnected); vtt-5su.15 wraps its tools with the same function.
- `TOOLS` (tools.ts): the frozen list of these 14 tool names with their params schemas and descriptions; vtt-5su.15 adds `subscribe`, `poll_changes`, `unsubscribe` through the extension hook.
- Results (PROTOCOL.md §11): a `ProtocolError` (including `disconnected` and `uncertain` from the client) → `isError: true` with `{code, message, details?}`; `status: "rejected"` → `isError: true` with the rejection and `op_index`; committed and query results → normal.
- Resources (resources.ts): `vtt://docs/formulas`, `vtt://docs/design`, `vtt://docs/protocol` (docs/FORMULAS.md, DESIGN.md, PROTOCOL.md read at runtime via `new URL("../../../../docs/…", import.meta.url)`), and `vtt://schema/ops` (JSON Schema of `WireOp`, all 19 kinds, from zod's `z.toJSONSchema`).
- Tool descriptions say: ids should be human-meaningful (DESIGN §5.3); writes need the latest `revision` (from `table_info`, a result, or `poll_changes`); one `transact` is one undoable group; formulas and actions follow docs/FORMULAS.md (resource).

Done when: tests use `test/mcp/support.ts` and connect an MCP client to `createMcpServer` through the SDK's in-process transport: the tool list equals the 14-tool table (names and required arguments, frozen as a snapshot in the test); a parity test asserts every protocol method except `invoke`, `document`, `subscribe` and `unsubscribe` has a tool here (the subscription parity is vtt-5su.15's) and that every one of the 19 `WireOp` kinds validates in the `transact` tool's input JSON Schema; one happy path and one error per tool; a stale `transact` returns `isError` with `stale_write`; a `transact` input carrying `actor`, one carrying `retry`, one carrying `txn_id`, and an `undo` with `target: {type:"actor", …}` each return an MCP input error and the server receives no request (checked by the server's request count); a socket dropped during a `transact` after the commit and before the response (simulated by a `WebSocket` wrapper injected into the client through its `WebSocket` option that closes the socket when the commit event frame arrives, which precedes the response frame) is retried once with the same `txn_id`, the tool returns the committed result and exactly one group exists; an extension passed to `createMcpServer` is called with the server and client; with the socket dropped and reconnection held (the injected wrapper refuses new sockets), `table_info` and `get_objects` return `isError` with `disconnected`, and after the test restarts the server on the same port with a different token (the client has explicit credentials), both return `unauthorized`; `withConnection` passes through when the client is connected; reading `vtt://docs/formulas` returns text starting with "# Formula and Action Language"; `vtt://schema/ops` lists 19 op kinds; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: subscriptions, change buffers, the subscription resource (vtt-5su.15); `vtt-mcp` and stdio (vtt-5su.17); the `invoke` tool (M5); a built-in agent (Later); MCP over HTTP (vtt-y1w.10); prompts; character-viewer subscriptions for agents (GM only in v1).

Depends on: vtt-5su.10, vtt-5su.7, vtt-5su.19.

---

### M3-j2 — vtt-5su.15 — MCP: subscription tools and change buffers

Implements: DESIGN.md §5.2 Subscribe ("Receive change notifications"), §5.1; docs/PROTOCOL.md §6 (client retries, `uncertain`), §8 (reconnection, resync, subscription failure, mirror revision), §11 (subscribe, poll_changes, unsubscribe, handles, `ChangeRecord`, overflow, failed subscriptions, `vtt://subscriptions/<handle>`) as written by vtt-5su.2.

The MCP server's subscription side: tools, handles and change buffers, tested in process. The `vtt-mcp` binary is vtt-5su.17. Exclusive files: `packages/authority/src/mcp/subscriptions.ts`, `changes.ts`, tests `test/mcp/subscriptions.test.ts`, `test/mcp/changes.test.ts`; the sorted line `export * from "./mcp/subscriptions"` in `packages/authority/src/index.ts`. No package.json change. Uses vtt-5su.11's `createMcpServer` extension hook, `withConnection` gate and `test/mcp/support.ts` without editing them, vtt-5su.7's `Subscription` events (`delta` with `before`/`after`) and mirror revision, and the `resync` and `error` events that vtt-5su.19's recovery emits. All three tools are registered through `withConnection` (PROTOCOL.md §11 connection gate), so `poll_changes` returns the connection error instead of local buffers while the client reports one.

- `subscriptionTools(): McpExtension` (subscriptions.ts) registers `subscribe`, `poll_changes`, `unsubscribe` and the resource template `vtt://subscriptions/{handle}`:
  - `subscribe` (scopes `board`, `objects`, `all`; GM viewer; `log` scope and viewers other than GM are refused `bad_request`): `client.subscribe(params)`, a new handle `"m"` + counter mapped to the `Subscription` object (stable across reconnects while its protocol id changes), a `ChangeBuffer`; returns `{subscription: <handle>, revision, objects: <count>}`.
  - `poll_changes {subscription: <handle>, wait_ms?: 0..30000 (default 0)}` → `{subscription, revision, changes: ChangeRecord[], overflowed}`: returns and clears the buffer, waiting up to `wait_ms` for the first record; unknown handle → `isError` `not_found`.
  - `unsubscribe {subscription: <handle>}`: `sub.close()`, drops the buffer and the handle.
  - Resource `vtt://subscriptions/<handle>`: `{subscription, revision, overflowed, failed, objects: ObjectView[] /* current mirror */, changes: ChangeRecord[]}`, read without clearing.
- `ChangeBuffer` (changes.ts), fed from `sub.on("delta")` and `sub.on("resync")`: per delta one `ChangeRecord` of type `commit` (PROTOCOL.md §11): `created` / `removed` (ids absent before / after), `cells` (every cell whose `CellView` differs between `before` and `after`, with `before?`/`after?`), `objects` (every object whose `is_template`, `is_character` or `actions` differ, with `ObjectFacts` before/after); per resync one record `{type:"resync", from_revision, to_revision, session_changed}`. At most 1,000 records; beyond that the oldest is dropped and `overflowed` is set until the next `poll_changes` returns it. Each record sends `notifications/resources/updated` for `vtt://subscriptions/<handle>`.
- Revisions (PROTOCOL.md §8, §11): `poll_changes` results and the resource report the mirror's `revision`, which advances on every processed commit even when the subscription had no delta, so it equals the client's current revision after a processed commit.
- Failed subscriptions: on `sub.on("error")` the buffer appends `{type:"failed", code, message}` and the resource's `failed` becomes `{code, message}` (else `null`); the handle stays valid until `unsubscribe`; later polls return the remaining records and then empty results.

Done when: in-process tests (`test/mcp/support.ts` with the extension) show: the tool list is vtt-5su.11's 14 tools plus `subscribe`, `poll_changes`, `unsubscribe`, and every protocol method except `invoke` and `document` now has a tool; after `subscribe`, a GM write through a second `ProtocolClient` releases a pending `poll_changes` (`wait_ms: 2000`) with a cell change carrying `before`, `after` and actor `gm`; a `set_actions` and a `set_character_flag` by the GM each produce a record whose `objects` entry shows the before/after actions or flag; a `create_object` and a `remove` produce `created` and `removed`; 1,001 commits set `overflowed`, and reading `vtt://subscriptions/<handle>` then returns the current mirror (equal to a fresh `get_objects` of the scope); after the server drops all sockets and the client reconnects (same session), `poll_changes` on the old handle returns a `resync` record with `session_changed: false`, a later write is delivered under the same handle, reading the resource works, and `unsubscribe` with the old handle succeeds and frees the protocol subscription; when the authority is restarted in the test (new session) after committing a `transact` and before its response (the same injected `WebSocket` wrapper closes the socket on the commit event frame, then the test starts a new server on the same port and token), that `transact` tool call returns `isError` with `uncertain` and no `transact` request reaches the new server, and the handle's next record is a resync with `session_changed: true`; while the socket is dropped and reconnection is held by the injected wrapper, `poll_changes` returns `isError` with `disconnected` and the buffered records are still there after reconnection; while the client is recovering (`connectionError()` with `recovering: true`), `poll_changes` and `subscribe` return `isError` `disconnected` and no record is added for a subscription in state `recovering`; when the socket is dropped again during resubscription (held by the injected wrapper), no `failed` record appears and each handle gets one `resync` record once recovery completes; a commit that touches nothing in the subscription's scope advances the `revision` returned by `poll_changes` and the resource to the client's revision; after a board subscription's board is removed while the client is disconnected (the test closes the client's socket through the injected `WebSocket` wrapper, holds its reconnect attempts until a second client has removed the empty board, then releases them), `poll_changes` on that handle returns a `failed` record with code `not_found`, the resource shows `failed` and no objects, and a second subscription on another board keeps delivering; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: the 14 request tools, result mapping, static resources, the gate (vtt-5su.11); the client's retry, resync, refresh and failure mechanics (vtt-5su.19); `vtt-mcp`, stdio and discovery (vtt-5su.17); character-viewer and `log` subscriptions for agents; MCP over HTTP (vtt-y1w.10); persistent deduplication (vtt-y1w.11).

Depends on: vtt-5su.11, vtt-5su.19.

---

### M3-j3 — vtt-5su.17 — MCP: stdio process (vtt-mcp CLI, discovery, lifecycle)

Implements: DESIGN.md §5.2 ("bring your own agent"), §7 Platform; docs/PROTOCOL.md §2 (discovery file, credential refresh, `wrong_table`, explicit credentials), §11 (`vtt-mcp`) as written by vtt-5su.2.

The `vtt-mcp` stdio process: CLI, discovery, credential refresh across normal authority restarts, MCP initialization and process lifecycle. Exclusive files: `packages/authority/src/bin/mcp.ts`, `src/mcp/discovery.ts`, tests `test/mcp/stdio.test.ts`, `test/mcp/discovery.test.ts`; the sorted line `export * from "./mcp/discovery"` in `packages/authority/src/index.ts`. Adds `"vtt-mcp": "./src/bin/mcp.ts"` to `@vtt/authority`'s `bin`; run `pnpm install` and commit `pnpm-lock.yaml` in the same commit. Uses vtt-5su.11's `createMcpServer`, vtt-5su.15's `subscriptionTools()`, vtt-5su.19's `enableRecovery` (with or without its `credentials` option), and vtt-5su.14's `readSessionFile` without editing them. The SDK's stdio server transport and stdio client transport are taken from the installed packages' type declarations; if `@modelcontextprotocol/server` 2.3.1 lacks a stdio server transport, stop and report.

- `discovery.ts`: `sessionCredentials(): () => Promise<{url, token, table_path, table_id} | null>` returns a reader over `readSessionFile()` (null when the file is missing or invalid), suitable for `enableRecovery`'s `credentials` option.
- `bin/mcp.ts` (shebang `#!/usr/bin/env -S node --import tsx`): `vtt-mcp [--url u] [--token t] [--name n]`. Credential sources in order: `--url`/`--token`; else env `VTT_URL`/`VTT_TOKEN` (both explicit credentials: no refresh, 4401 terminal and reported `unauthorized`, writes in flight report `uncertain`); else the session file through `sessionCredentials()` (discovery-based: re-read before every reconnect attempt; a new token is adopted only when `table_path` and `table_id` match those of the first successful `welcome`, else the client stops with `wrong_table`). Absence of explicit credentials always selects discovery mode, even when the session file is missing (PROTOCOL.md §11): the process stays up, tools answer `disconnected`, and it connects once the file appears. Startup fails (exit 1 with a one-line message) only for malformed or incomplete explicit credentials: `--url` without `--token` or the reverse, `VTT_URL` without `VTT_TOKEN` or the reverse, or a URL that does not parse as `ws://` or `wss://`. Startup order (PROTOCOL.md §11): (1) construct the `ProtocolClient` (`kind: "agent"`, `agent_name` = a function returning `--name`, else the MCP client's `clientInfo.name` once known, else `"agent"`; url and token from the explicit source, or from one read of the session file, or empty strings when the session file is missing), without connecting; (2) `createMcpServer({client, extensions: [subscriptionTools()]})` and connect it to the SDK's stdio server transport; (3) when the MCP client has initialized, `enableRecovery(client, {credentials: sessionCredentials()})` for discovery or `enableRecovery(client, {})` for explicit credentials, which makes the first connection itself with backoff and does not require it to succeed (vtt-5su.19); the discovery identity is captured at the first successful `welcome`. Until then every tool answers `isError` `disconnected` through the gate. Logs only to stderr. While the authority is unreachable, tools return `isError` with `{code:"disconnected"}` and the client keeps reconnecting; after reconnecting, subscriptions resync and their handles stay valid. After `wrong_table` or a terminal `unauthorized`, every tool returns `isError` with that code and the process keeps serving MCP so the agent can report it. Exits 0 when stdin closes.

Done when: unit tests show `sessionCredentials()` returns null for a missing file and the file's fields otherwise; subprocess tests (real `vtt-serve` from vtt-5su.14 on a temp table, `XDG_CONFIG_HOME` in a temp directory, the SDK's stdio client transport) show: `vtt-mcp --url … --token …` lists 17 tools; `vtt-mcp` without flags connects through the session file; normal restart without `--token`: SIGTERM `vtt-serve` and start it again on the same file without `--token` (new token, new session, session file rewritten), and the discovery-based `vtt-mcp`'s next tool call after reconnecting succeeds, its subscription handle reports a `resync` with `session_changed: true`; a restart onto a different table file (the session file now names another `table_path`) makes `table_info`, `poll_changes` and `get_objects` return `isError` `wrong_table`, and so does the same path with a replaced `.table-id`; with explicit `--url`/`--token`, a restart with a new token makes `table_info`, `poll_changes` and `get_objects` return `isError` `unauthorized` and the process stays up; with the authority stopped `table_info`, `poll_changes` and `get_objects` return `isError` `disconnected` and, after it restarts, the next call of each succeeds; `vtt-mcp` started (discovery-based, and separately with explicit `--url`/`--token`) while no authority is running stays up and answers `table_info` with `isError` `disconnected`, and after `vtt-serve` is started (writing the session file, or on the given port and token) `table_info` succeeds without restarting `vtt-mcp`, and its `actor` is `{type:"agent", name: <the MCP client's name>}` when `--name` is absent; `vtt-mcp` in discovery mode with no session file stays up, answers `table_info` with `isError` `disconnected`, and connects without a restart once `vtt-serve` starts and writes the file; `--url` without `--token`, `--token` without `--url`, and an unparsable `--url` each exit 1; closing stdin exits 0; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: subscription tools and buffers (vtt-5su.15); request tools (vtt-5su.11); the client's refresh mechanics (vtt-5su.7); writing the session file (vtt-5su.14); MCP over HTTP (vtt-y1w.10).

Depends on: vtt-5su.15, vtt-5su.14, vtt-5su.19.

---

### M3-k — vtt-5su.12 — Authority: fixture scenarios over the protocol

Implements: FIXTURES.md §1–§8, §11 (as amended by vtt-75c.2); DESIGN.md §5.2 (the agent and the UI go "through the same invariants"); the M2 runner contract (vtt-75c.13, including its `onStep` observation hook); docs/PROTOCOL.md §4–§8 as written by vtt-5su.2; FORMULAS.md §7 (the maintained views must equal fresh evaluation).

Run all ten fixture scenarios through the protocol and show the protocol path matches the direct engine path; also the integrating subscription equivalence test across object, cover and log scopes (vtt-5su.9, vtt-5su.20). Exclusive files: `packages/authority/test/protocol-runner/*.ts`, `test/protocol-scenarios.test.ts`. Reuses vtt-75c.13's test helpers (`documentFromSetup`, `runScenario` with `onStep`, `RunReport`, value comparison) by import and never edits `test/runner/`; if a needed helper is not exported from its module, export it with a one-line change.

`runScenarioOverProtocol(scenario, {onStep?}): Promise<RunReport>`: `documentFromSetup` → `TableHost.inMemory(store, {dice: new ScriptedDiceSource(scenario.dice)})` (vtt-5su.4, vtt-75c.15) → `startServer` on port 0 (vtt-5su.10) → a `ProtocolClient` (vtt-5su.7, `kind: "test"`, Node's `WebSocket`). Steps: `set` and `override` → `transact [set_value]` (the M2 runner's scenario errors are decided from the GM view's `kind` per PROTOCOL.md §7.2: `set` is a scenario error when `kind` is `"formula"` (structural cells such as `position` included), `override` is a scenario error unless `kind` is `"formula"`, `clear_override` unless `overridden` is true; a `"structural"` or `"literal"` cell takes `set`); `clear_override` → `clear_override`; `move` → `move`; `spawn` → `spawn` with `as`, and `owned` bindings taken from the result's `copies`; `undo` → `undo {type:"latest"}`; `bind` → the contents of `in` (or `list_objects` with the tag filter) compared on GM views by FORMULAS §4 equality; a step's actor → `actor` param (characters as `{type:"character", id}`, GM by default); `base_revision` = the client's revision. Expectations: `cell`, `cell_error`, `override` from the GM view; `exists` from `missing`; `container`, `contents`, `placement` from structural cells; `object_visible` = present in `get_objects` with that viewer; `cell_visible` = the cell is present in that viewer's view (`cells` has the key), whatever its value, so a readable cell holding a redacted ref is visible (FIXTURES §7); `log_groups` from `log`; `log_includes` from `explain_group` (GM `EffectView`s); `replay` from `document`: vtt-75c.16's `replay` of the groups over the setup snapshot, compared with `storedStateEqual`; `rejected` from `status: "rejected"` mapped through `toFixtureReason` (vtt-75c.4). Truncation and skipped expectations exactly as the M2 runner (invoke stops the run; `action` expectations skipped and counted). After setup and after every executed step, `onStep({step, snapshot})` is called with the `document` result's snapshot (step -1 for setup).

Per-step comparison: the test runs each scenario twice, through vtt-75c.13's `runScenario(s, {onStep})` and through `runScenarioOverProtocol(s, {onStep})`, collects both snapshot sequences, and compares them pairwise.

Subscription equivalence (`test/subscription-equivalence.test.ts`, also exclusive to this bead): through `startServer` on port 0 and `ProtocolClient` mirrors (vtt-5su.7), seeded random sequences of 200 commits over a 60-object table (writes, formula sets, overrides set and cleared, moves between boards and containers, spawns, creates and removes inside containers, reorders, tag and shape edits, template and character flag changes including Aldric's own `is_character`, `set_actions`, board add, rename and remove, literal and override refs to objects and boards that are later removed, `visible_to` changes on containers, opaque zone toggles and moves including erroneous `opaque`, face flips, per-cell visibility, undo), for the GM and Aldric and for `board`, `objects` (subtree), `all` and `log` scopes: after every commit each mirror (objects, covers, log-window groups) equals the result of a fresh `subscribe` with the same params at that revision.

Done when: `protocol-scenarios.test.ts` produces for all ten scenarios the same `RunReport` table as vtt-75c.13's `scenarios.test.ts`; for every scenario the two `onStep` sequences have the same length and each pair of snapshots is equal by `storedStateEqual` with identity included; a test shows that `set` on a structural cell holding a formula (`position`) is a scenario error in both runners and `override` on it is accepted in both; a test shows `cell_visible` true for a cell whose value is `{type:"redacted"}` in the viewer's view; `subscription-equivalence.test.ts` passes for at least 5 seeds (seeds printed on failure); a self-test shows a wrong expected value fails with the scenario title, step index and expectation named; the server and client are closed after each scenario; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: `invoke`, `action` expectations and action rejections (M5); round-trip mode over the protocol (the direct runner covers it); new scenarios; fixture format changes; edits to `test/runner/` beyond one-line exports.

Depends on: vtt-5su.10, vtt-5su.4, vtt-5su.7, vtt-5su.8, vtt-5su.9, vtt-5su.16, vtt-5su.20, vtt-75c.13.

---

### M3-l — vtt-5su.13 — Epic acceptance: §8.4 step 5 headless

Implements: DESIGN.md §8.4 step 5 ("Through the MCP server, ask the agent: 'Make room 4 difficult terrain and hatch it, and make a Fireball card for Aldric with DC 14 and 8d6.' Check its work in the inspector. Correct the DC by typing over it."), §5.2, §4.4; FORMULAS.md §10 (Difficult terrain, Fireball); docs/PROTOCOL.md §6 (stale writes, undo targets), §8, §11; the epic vtt-5su Done-when.

The epic acceptance test, black box: the authority and the MCP server run as the real binaries (`vtt-serve` from vtt-5su.14, `vtt-mcp` from vtt-5su.17). Exclusive files: `packages/authority/test/acceptance/step5.test.ts`, `prep.ts`, `agent-script.ts`. The agent is a deterministic script (no model) doing what an agent would.

1. Start `vtt-serve <tmp>/crypt.table.json --port 0 --print-session` as a subprocess (`XDG_CONFIG_HOME` in a temp directory); read `{url, token}`.
2. `prep.ts`, as the GM through a `ProtocolClient` (`kind: "ui"`): board `crypt` "Crypt"; character `aldric` (`is_character`) on `gm_board` with `aldric_binder` (owner `aldric`, `visible_to` owner) on `gm_board`; six zones `room1`…`room6` on `crypt` (`is_zone`, rect shapes, `opaque: true`, `visible_to` gm, names "Room 1"…"Room 6"); a token `pc1` (tag `creature`, `base_speed: 30`, the `speed` formula of FORMULAS §10 Difficult terrain) inside room 4; a goblin `goblin1` (tag `creature`) in room 3.
3. Start `vtt-mcp --url … --token … --name step5-agent` through the MCP SDK's stdio client transport. `agent-script.ts`: `table_info`; `zones {board:"crypt"}` → the zone named "Room 4"; `transact` (label "Room 4: difficult terrain, hatched"): `set_tag room4 ["difficult"]`, `set_value room4.pattern "hatch"` (the hatch is an ordinary cell; M4 decides appearance cells); `get_objects ["pc1"]` → `speed` 15; `transact` (label "Fireball card for Aldric"), one group: `create_object fireball_aldric` into `aldric_binder` with cells `name "Fireball"`, `owner` and `caster` ref `aldric`, `zone` ref `fireball_aldric_zone`, `dc 14`, `damage_dice 8d6`, `damage` empty, `locked false`, `applied false`, `save_row` ref `fireball_save_row`, formulas `targets = contents(zone).where(tag has "creature")` and `rows = contents.where(tag has "save_row")`, and the four actions of FORMULAS §10 Fireball with Roll damage as `roll(damage_dice) -> damage`; `create_object fireball_aldric_zone` into `fireball_aldric` (`is_zone`, a circle shape); `create_object fireball_save_row` into `aldric_binder` (`is_template`, tag `save_row`; cells `target` empty and `save_roll` empty; formulas `card = container`, `save_bonus = target.dex_save`, `passed = save_roll + save_bonus >= card.dc`, `damage_dealt = if(passed, floor(card.damage / 2), card.damage)`; action `Roll save` with `when: save_roll = empty` and steps `["roll(1d20) -> save_roll"]`, all per FORMULAS §10 Fireball); `explain_action` for each of the card's four actions and for the row template's `Roll save` (no `when_error` with `#SYNTAX`); `explain_cell fireball_aldric.targets` while the zone is still inside the card: value `[]`, and the recorded dependencies are cell dependencies only, with no `index` node (`contents(zone)` of a contained zone asks for no board candidates; dependencies are recorded dynamically, FORMULAS §7); then `transact` `move fireball_aldric_zone` onto `crypt` at a point outside every room, `explain_cell fireball_aldric.targets` now lists an `index` dependency, and `undo {type:"mine"}` puts the zone back inside the card (asserted with `get_objects`).
4. Check its work, as the GM: `get_objects` shows the zone, card, row template and every cell as written; the card group is one group whose actor is `{type:"agent", name:"step5-agent"}`; a subscription with scope `all` and viewer Aldric contains the card and its zone, no room zone, six covers on `crypt`, and no `pc1` (covered); the GM `spawn`s `fireball_save_row` into `fireball_aldric` (as `$row`), `get_objects` on the copy shows the `Roll save` action with its `when` and steps and every row cell, the card's `rows` lists the copy, and the GM then undoes that spawn (`undo {type:"mine"}`) so the remaining steps start from the agent's card (invoking `Roll save` stays M5).
5. Correct the DC by typing over it: the agent subscribes to `{type:"objects", ids:["fireball_aldric"]}` beforehand; the GM `transact`s `set_value fireball_aldric.dc 15`; the agent's `poll_changes` returns that cell change with actor `gm`; the agent's `transact` with its old `base_revision` writing `dc` is rejected `stale_write` naming the GM's group; the agent's `undo {type:"group", index: <card group index>}` is refused `undo_conflict` (the GM's later `dc` write touches the card); then the agent's `transact` writing `damage_dice 10d6` with the same old base commits; finally the agent's `undo {type:"mine", expect_index: <card group index>}` is refused `undo_target_changed` with `actual` = the `damage_dice` group's index (its newest group).
6. `save`; SIGTERM the server; restart it on the same file with `--port <same port> --token <same token>`; the MCP process reconnects; the agent's `poll_changes` on its subscription handle returns a `resync` record with `session_changed: true`; the agent's next `get_objects ["fireball_aldric"]` shows `dc 15`, `damage_dice 10d6`, and the four actions; `log` lists the agent's groups with their actor.

Done when: `step5.test.ts` passes within 60 s and leaves no subprocess or lock file behind (asserted in `afterAll`); its header comment quotes §8.4 step 5 and maps each sentence to the numbered blocks above; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` exit 0.

Out of scope: a model in the loop; the inspector UI (M4); invoking the card's actions (M5); hatch rendering (M4).

Depends on: vtt-5su.11, vtt-5su.14, vtt-5su.15, vtt-5su.16, vtt-5su.17.

---

## 3. Dependency digraph (as recorded with `bd dep add`, after review r5; r5 changed no edges)

```
M3-0  ─► M3-a, M3-h2, M3-h
M3-h2 ─► M3-h
M3-a  ─► M3-c, M3-d, M3-i, M3-g
M3-c  ─► M3-e, M3-g                 (vtt-75c.18 ─► M3-c, M3-d, M3-f; vtt-75c.19 ─► M3-d)
M3-d  ─► M3-e, M3-e2, M3-f, M3-f2
M3-f  ─► M3-f2, M3-g, M3-k
M3-f2 ─► M3-g, M3-k
M3-e  ─► M3-e2, M3-k
M3-e, M3-e2, M3-f, M3-f2, M3-h ─► M3-g
M3-g  ─► M3-g2, M3-j, M3-k          (M3-h ─► M3-g2, M3-k)
M3-i  ─► M3-i2, M3-k                (vtt-75c.13 ─► M3-k; M3-e2 ─► M3-k)
M3-i2 ─► M3-j, M3-j2, M3-j3
M3-j  ─► M3-g2, M3-j2               (package.json edits serialized)
M3-j2, M3-g2 ─► M3-j3
M3-j, M3-g2, M3-j2, M3-j3, M3-e2 ─► M3-l
```

vtt-75c.18 depends on vtt-75c.14, vtt-75c.5, vtt-75c.8, vtt-75c.11 (unchanged). vtt-75c.19 (M2, filed by the orchestrator in r4: the cover oracle treats an erroneous `opaque` as opaque) depends on vtt-75c.12; M3-d depends on it. vtt-75c.17 (amended in r3 with the `saveTable` capture contract) still depends on vtt-75c.11; M3-h depends on it.

- vtt-5su.3 (M3-a) depends on vtt-5su.2 (M3-0)
- vtt-5su.3 (M3-a) depends on vtt-75c.3
- vtt-5su.3 (M3-a) depends on vtt-75c.4
- vtt-5su.4 (M3-h) depends on vtt-5su.18 (M3-h2)
- vtt-5su.4 (M3-h) depends on vtt-5su.2 (M3-0)
- vtt-5su.4 (M3-h) depends on vtt-75c.12
- vtt-5su.4 (M3-h) depends on vtt-75c.15
- vtt-5su.4 (M3-h) depends on vtt-75c.17
- vtt-5su.5 (M3-c) depends on vtt-5su.3 (M3-a)
- vtt-5su.5 (M3-c) depends on vtt-75c.12
- vtt-5su.5 (M3-c) depends on vtt-75c.15
- vtt-5su.5 (M3-c) depends on vtt-75c.18
- vtt-5su.5 (M3-c) depends on vtt-75c.6
- vtt-5su.5 (M3-c) depends on vtt-75c.8
- vtt-5su.6 (M3-d) depends on vtt-5su.3 (M3-a)
- vtt-5su.6 (M3-d) depends on vtt-75c.10
- vtt-5su.6 (M3-d) depends on vtt-75c.12
- vtt-5su.6 (M3-d) depends on vtt-75c.18
- vtt-5su.6 (M3-d) depends on vtt-75c.19
- vtt-5su.6 (M3-d) depends on vtt-75c.7
- vtt-5su.7 (M3-i) depends on vtt-5su.3 (M3-a)
- vtt-5su.8 (M3-e) depends on vtt-5su.5 (M3-c)
- vtt-5su.8 (M3-e) depends on vtt-5su.6 (M3-d)
- vtt-5su.8 (M3-e) depends on vtt-75c.12
- vtt-5su.8 (M3-e) depends on vtt-75c.7
- vtt-5su.9 (M3-f) depends on vtt-5su.6 (M3-d)
- vtt-5su.9 (M3-f) depends on vtt-75c.12
- vtt-5su.9 (M3-f) depends on vtt-75c.18
- vtt-5su.10 (M3-g) depends on vtt-5su.16 (M3-e2)
- vtt-5su.10 (M3-g) depends on vtt-5su.20 (M3-f2)
- vtt-5su.10 (M3-g) depends on vtt-5su.3 (M3-a)
- vtt-5su.10 (M3-g) depends on vtt-5su.4 (M3-h)
- vtt-5su.10 (M3-g) depends on vtt-5su.5 (M3-c)
- vtt-5su.10 (M3-g) depends on vtt-5su.8 (M3-e)
- vtt-5su.10 (M3-g) depends on vtt-5su.9 (M3-f)
- vtt-5su.11 (M3-j) depends on vtt-5su.10 (M3-g)
- vtt-5su.11 (M3-j) depends on vtt-5su.19 (M3-i2)
- vtt-5su.11 (M3-j) depends on vtt-5su.7 (M3-i)
- vtt-5su.12 (M3-k) depends on vtt-5su.10 (M3-g)
- vtt-5su.12 (M3-k) depends on vtt-5su.16 (M3-e2)
- vtt-5su.12 (M3-k) depends on vtt-5su.20 (M3-f2)
- vtt-5su.12 (M3-k) depends on vtt-5su.4 (M3-h)
- vtt-5su.12 (M3-k) depends on vtt-5su.7 (M3-i)
- vtt-5su.12 (M3-k) depends on vtt-5su.8 (M3-e)
- vtt-5su.12 (M3-k) depends on vtt-5su.9 (M3-f)
- vtt-5su.12 (M3-k) depends on vtt-75c.13
- vtt-5su.13 (M3-l) depends on vtt-5su.11 (M3-j)
- vtt-5su.13 (M3-l) depends on vtt-5su.14 (M3-g2)
- vtt-5su.13 (M3-l) depends on vtt-5su.15 (M3-j2)
- vtt-5su.13 (M3-l) depends on vtt-5su.16 (M3-e2)
- vtt-5su.13 (M3-l) depends on vtt-5su.17 (M3-j3)
- vtt-5su.14 (M3-g2) depends on vtt-5su.10 (M3-g)
- vtt-5su.14 (M3-g2) depends on vtt-5su.11 (M3-j)
- vtt-5su.14 (M3-g2) depends on vtt-5su.4 (M3-h)
- vtt-5su.15 (M3-j2) depends on vtt-5su.11 (M3-j)
- vtt-5su.15 (M3-j2) depends on vtt-5su.19 (M3-i2)
- vtt-5su.16 (M3-e2) depends on vtt-5su.6 (M3-d)
- vtt-5su.16 (M3-e2) depends on vtt-5su.8 (M3-e)
- vtt-5su.16 (M3-e2) depends on vtt-75c.12
- vtt-5su.17 (M3-j3) depends on vtt-5su.14 (M3-g2)
- vtt-5su.17 (M3-j3) depends on vtt-5su.15 (M3-j2)
- vtt-5su.17 (M3-j3) depends on vtt-5su.19 (M3-i2)
- vtt-5su.18 (M3-h2) depends on vtt-5su.2 (M3-0)
- vtt-5su.19 (M3-i2) depends on vtt-5su.7 (M3-i)
- vtt-5su.20 (M3-f2) depends on vtt-5su.6 (M3-d)
- vtt-5su.20 (M3-f2) depends on vtt-5su.9 (M3-f)

Later beads: vtt-y1w.11 depends on vtt-5su.5, vtt-5su.4, vtt-5su.19 (re-pointed from vtt-5su.7 in r3: the retry rule lives in recovery); vtt-y1w.12 depends on vtt-5su.9, vtt-5su.10, vtt-5su.7, vtt-5su.19 (added in r3: a reconnect restarts the snapshot); vtt-y1w.10 depends on vtt-5su.11; Polish vtt-qf5.4 still depends on vtt-5su.7 (mirror patches) and vtt-5su.9.

`bd dep cycles` reports no cycles. Waves: (1) M3-0, vtt-75c.18 and vtt-75c.19 (once their M2 blockers merge); (2) M3-a, M3-h2; (3) M3-c, M3-d, M3-i, M3-h; (4) M3-e, M3-f, M3-i2; (5) M3-e2, M3-f2; (6) M3-g; (7) M3-j, M3-k; (8) M3-g2, M3-j2; (9) M3-j3; (10) M3-l. Critical path M3-0 → a → c → e → e2 → g → j → g2 → j3 → l. M2 files edited by M3 beads after their owners merge: `transaction.ts` (one accessor, M3-c, if missing), `table.ts` (`onCommit`, M3-f); vtt-75c.13's `onStep` and vtt-75c.17's capture contract are written by those beads themselves. `packages/authority/src/index.ts` gets sorted export lines from M3-c, d, e, e2, f, f2, g, g2, h, h2, j, j2, j3; `packages/protocol/src/index.ts` from M3-a, i, i2. package.json edits, each with `pnpm install` and `pnpm-lock.yaml` in the same commit and serialized by the graph: M3-a (protocol, zod), M3-g (ws, @types/ws), M3-j (MCP SDK), M3-g2 (tsx, bin vtt-serve, root script), M3-j3 (bin vtt-mcp).

---

## Review r1 changes

Codex plan review r1 (review-plan-m3-r1.md, 22 findings) and the orchestrator's dispositions (plan-m3-r1-dispositions.md), applied 2026-11-04. Finding → beads changed:

1. Self-contained contract → vtt-5su.2 now holds the full PROTOCOL.md contract (messages, 17 methods, 19 ops with declared keys, views incl. recursive wire values and `EffectView`, 12 error codes, 13 limits, dedup and session rules, log window, `changes_since` cursor); vtt-5su.3 implements it; every other bead cites PROTOCOL.md sections.
2. Recursive wire values, `EffectView` → vtt-5su.2 §7, vtt-5su.3 (types, nested-redaction round trips through the message parsers), vtt-5su.6 (`effectView`).
3. JSON-Schema-compatible wire schemas → vtt-5su.3 (no `z.custom`; `z.toJSONSchema` of `WireOp`, transact params and every params schema in Done-when).
4. Effect-variant filtering; explain `not_found` indistinguishable → vtt-5su.2 §7.6 and §9, vtt-5su.6, vtt-5su.8.
5. Board refs never redacted → vtt-5su.2 §7.3, vtt-5su.6 (test).
6. Complete delta candidates; full recomputation on `is_character` and visibility inputs → vtt-5su.9 (candidate list, per-op deterministic tests, extended random test).
7. Missing upstream dependency; board change detection → `bd dep add vtt-5su.9 vtt-75c.18`; vtt-5su.9 inspects committed `board` effects (no summary field).
8. Lazy evaluation rule restated → vtt-5su.2 D10, §8 and the FORMULAS §7 sentence; vtt-5su.9 tests both cases.
9. Log window with `groups_upserted` / `groups_removed` → vtt-5su.2 §8, vtt-5su.3, vtt-5su.7 (mirror), vtt-5su.9 (equivalence over log scopes across reveal, hide, remove, undo).
10. Declared intended-write keys, precedence, floor → vtt-5su.2 §5 and §6, vtt-5su.5 (`declaredKeys`, `historyFloor`, tests for removed targets and destinations).
11. Reuse `keysConflict`/`keysIntersect`; new `intersectingKeys` in `protocol/conflicts.ts` → vtt-5su.5 (no edit to `store/undo.ts`).
12. Dedup by (client instance, txn_id) plus fingerprint; authority session id; `uncertain` → vtt-5su.2 §2 and §6, vtt-5su.3 (hello/welcome fields, `uncertain` code), vtt-5su.5 (`TxnCache`), vtt-5su.7 (retry option), vtt-5su.10 (session, instance), vtt-5su.11 and vtt-5su.15 (tool behaviour, restart test); Later bead **vtt-y1w.11** persistent deduplication.
13. `changes_since` cursor (`next_revision`, `floor`) → vtt-5su.2 §9, vtt-5su.8 (invisible-pages test).
14. Serialized saves, captured revision, async router ordering → vtt-5su.4, vtt-5su.10, vtt-5su.14 (shutdown awaits I/O before the lock is released).
15. Assets retained; autosave retry backoff → vtt-5su.4.
16. Board-wide zone enumeration and geometry classification; `objects` scope covers → vtt-5su.6 (`covers`, `coverBoards`; new dependency on vtt-75c.7), vtt-5su.9.
17. Client exposes `table` and `session`; frozen `delta`/`resync` event contract; stable MCP handles → vtt-5su.7, vtt-5su.15.
18. MCP change records with object flags and actions; overflow recovery through the subscription resource → vtt-5su.2 §11, vtt-5su.15.
19. Step 5 undo assertions → vtt-5su.13 (`undo {type:"group"}` on the card group → `undo_conflict`; stale `mine` pin → `undo_target_changed`).
20. `cell_visible` by presence; per-step hook → vtt-5su.12; vtt-75c.13 gains `onStep(report)`; vtt-5su.12 → vtt-75c.13 was already recorded.
21. No chunking in v1; server-to-client messages unbounded; `max_buffered_bytes` 64 MiB → vtt-5su.2 D21 and §10, vtt-5su.10 (large snapshot test); Later bead **vtt-y1w.12** chunked snapshots.
22. Splits → vtt-5su.10 plus new **vtt-5su.14** "Authority: server process (vtt-serve CLI, discovery file, shutdown)"; vtt-5su.11 plus new **vtt-5su.15** "MCP: subscriptions, change buffers, stdio lifecycle (vtt-mcp)"; vtt-5su.8 kept whole. vtt-5su.13 now also depends on vtt-5su.14 and vtt-5su.15.

Other edges added: vtt-5su.8 → vtt-5su.5 (`historyFloor`), vtt-5su.6 → vtt-75c.7 (geometry). The M4 planning bead vtt-3l6.1 got an update comment.

---

## Review r2 changes

Codex plan review r2 (review-plan-m3-r2.md, 13 findings) and the orchestrator's dispositions (plan-m3-r2-dispositions.md), applied 2026-11-05. Finding → beads changed:

1. Truncated tables were a review-script artifact. Verified the two real ellipses in vtt-5su.2: the `WireOp` summary now reads "one of the 19 kinds in the table below" (the table is complete), and the `Rejection` comment is replaced by the complete `@vtt/schema` union (six variants). vtt-5su.3's "…" list of type names was replaced by a naming rule.
2. `bd dep add vtt-5su.6 vtt-75c.18`.
3. `bd dep add vtt-5su.14 vtt-5su.11`; vtt-5su.3, .10, .11, .14 and the new .17 say "run `pnpm install` and commit `pnpm-lock.yaml` in the same commit" (vtt-5su.15 no longer edits package.json after the split; the `vtt-mcp` bin moved to .17).
4. Compatibility policy (D32, PROTOCOL §12): strict client→server parsing, forward-compatible server→client parsing → vtt-5su.2, vtt-5su.3 (two schema flavours, `parseServerMessage` `ignored` result and warnings), vtt-5su.7 (tests: unknown field, unknown event kind, unknown message type).
5. `names[id]` only with `name` readable; `label: null` unless every effect is visible unreduced → vtt-5su.2 (D15, §7.6, `GroupHeader.label: string | null`), vtt-5su.6 (implementation, tests).
6. Structural validation before dedup, state validation after a miss → vtt-5su.2 §6 (step 2b), vtt-5su.5 (`validateAgainstDocument`, retry-after-actor-removed test).
7. Credential refresh for discovery-based clients with `table_path`/`table_id` check (`wrong_table`); explicit credentials: 4401 terminal `unauthorized`, in-flight `uncertain` → vtt-5su.2 (D5, §2, new error code `wrong_table`, welcome `table.id`), vtt-5su.4 (`<file>.table-id`), vtt-5su.14 (session file fields), vtt-5su.7 (`credentials` callback), vtt-5su.10 (welcome `table.id`), vtt-5su.17 (normal restart without `--token`, wrong table, explicit credentials).
8. Mirror revision advances on every processed commit → vtt-5su.2 (D23, §8, §11), vtt-5su.7 (`advance`), vtt-5su.15 (poll and resource revision).
9. Resubscribe failure makes a subscription terminal (`error`, mirror emptied, handle kept) → vtt-5su.2 (D23, §8, `ChangeRecord` `failed`), vtt-5su.7, vtt-5su.15 (board removed while disconnected).
10. `TableHost.close()` resolves `{saved, revision, error?}`, never throws for save failures, always releases the lock; `saved_not_durable` does not advance `lastSavedRevision` → vtt-5su.2 D24, vtt-5su.4, vtt-5su.14 (exit 1 on `saved: false`, CLI test).
11. Ownership-safe lock (`wx`, temp + rename takeover, nonce re-read, nonce-checked release, release on failed open) → vtt-5su.2 (D25, §2), vtt-5su.4 (race and failed-open tests).
12. Save-row template with cells and `Roll save` (guard and steps), verified on a spawned row → vtt-5su.13.
13. Splits: vtt-5su.8 "Protocol: query methods" plus new **vtt-5su.16** "Protocol: explain methods" (depends on .8, .6, vtt-75c.12); vtt-5su.15 "MCP: subscription tools and change buffers" plus new **vtt-5su.17** "MCP: stdio process (vtt-mcp CLI, discovery, lifecycle)" (depends on .15, .14). vtt-5su.10, .12 and .13 depend on .16; .13 on .17; .12 also on .8; the edge vtt-5su.15 → vtt-5su.14 was removed. vtt-y1w.10/.12 needed no re-pointing.

---

## Review r3 changes

Codex plan review r3 (review-plan-m3-r3.md, 13 findings, all accepted) and the orchestrator's dispositions (plan-m3-r3-dispositions.md), applied 2026-11-05. Finding → beads changed:

1. Mutually exclusive lock takeover (rename the stale lock aside, which only one process can do, then race again on `O_EXCL`; at most 3 rounds); canonical (realpath) table path for lock and identity files → vtt-5su.2 (D25, §2), new **vtt-5su.18** (forced-interleaving test through `hooks`, symlink tests).
2. Envelope-only `parseServerMessage`; results validated by the client against the pending request's method (`parseResult`); failures reject that request with `internal` / `details.type: "protocol"` → vtt-5su.2 (D32, §10, §12), vtt-5su.3, vtt-5su.7.
3. `refTargets` reverse index of literal refs (direct, nested lists, viewers); existence changes add holders to the candidates → vtt-5su.9 (test 4a).
4. Covers use `isEffectivelyVisible`, never `canSeeObject` → vtt-5su.2 (D14, §7.5), vtt-5su.6 (overlapping-zones test against M2).
5. `transact` gains `retry?: true`; a marked resend whose key is not retained → error `retry_unknown` (14 codes), mapped to `uncertain` → vtt-5su.2 (D8, §4, §6, §10), vtt-5su.3, vtt-5su.5 (eviction test), vtt-5su.19.
6. `client.connectionError()` (vtt-5su.7); `mcp/gate.ts` `withConnection` owned by vtt-5su.11 and applied to all its tools incl. `table_info`; vtt-5su.15 wraps its tools; vtt-5su.17 tests `table_info` and `poll_changes` in each error state → vtt-5su.2 §11, vtt-5su.7, vtt-5su.11, vtt-5su.15, vtt-5su.17.
7. `last_write` uses the viewer's filtered group header → vtt-5su.2 §9, vtt-5su.16.
8. `zones` entries carry `error?` with `contents: []`; `at_position` omits candidates with erroneous geometry or `z` → vtt-5su.2 (§4, §9), vtt-5su.8 (`#TYPE`, `#CYCLE`, `#LIMIT` cases).
9. Strict parsing only for client→server messages; results contain no unresolved binding references, `TransactResult.bindings` maps names to ids → vtt-5su.2.
10. `CellView.kind` rule (stored formula → `formula`, no stored content → `structural`, else `literal`) → vtt-5su.2 §7.2, vtt-5su.6, vtt-5su.12.
11. vtt-75c.17 states that `saveTable` serializes before its first await, with a same-tick mutation test; vtt-5su.4's "stop and report" clause removed.
12. Split: vtt-5su.7 "Client: mirror and request correlation" (with a documented recovery seam) and new **vtt-5su.19** "Client: reconnect, retry and subscription recovery" (`client/recovery.ts`: `enableRecovery`, `transactWithRetry`). Recovery consumers: vtt-5su.11 (transact tool uses `transactWithRetry`; harness enables recovery), vtt-5su.15 (resync and failed records come from recovery), vtt-5su.17 (enables recovery with discovery credentials). Not dependent: vtt-5su.10 (does not use the client), vtt-5su.12 (one fresh server per scenario, no reconnects; the basic client suffices), vtt-5su.13 and vtt-5su.14 (reach recovery transitively through .17 and .11).
13. Split: new **vtt-5su.18** "Authority: table lock and identity files" (`host/lock.ts`, `host/identity.ts`); vtt-5su.4 retitled "Authority: table host (open, autosave, save, close)" and depends on it.

Edges added: vtt-5su.18 → vtt-5su.2; vtt-5su.4 → vtt-5su.18; vtt-5su.19 → vtt-5su.7; vtt-5su.11, .15, .17 → vtt-5su.19; vtt-y1w.11 → vtt-5su.19; vtt-y1w.12 → vtt-5su.19. Removed: vtt-y1w.11 → vtt-5su.7.

---

## Review r4 changes

Codex plan review r4 (review-plan-m3-r4.md, 11 findings, all accepted) and the orchestrator's dispositions (plan-m3-r4-dispositions.md), applied 2026-11-05. Findings 1 and 2 were defects in rules set in r3; the dispositions replace those rules. Finding → beads changed:

1. No automatic stale-lock takeover in v1: exclusive create, cleanup of a partially created lock on any failure, `TableLockedError` with `info` and `stale`, nonce-checked idempotent `release()`; manual `vtt-serve --force-unlock` (via `removeTableLock`) is the only takeover → vtt-5su.2 (D25, new D33, §2), vtt-5su.18 (rewritten: race on `wx`, stale refusal, fault injection, release after takeover), vtt-5su.4 (uses `acquireTableLock`/`TableLock`, stale refusal test), vtt-5su.14 (`--force-unlock`, message, SIGKILL-then-force test).
2. Cover fail-closed rule fixed in M2 by vtt-75c.19 (filed by the orchestrator) → vtt-5su.6 depends on it and states the rule by reference; tests an erroneous and a non-boolean `opaque` with valid geometry and tokens inside and outside, against `canSeeObject`; vtt-5su.2 §7.5 cites it.
3. `refTargets` indexes effective literal content (literals and overrides; direct, list, viewers refs; board refs); board create/remove produce candidates → vtt-5su.9.
4. Transport resubscribe failures keep subscriptions `recovering` (retried next connection); only error responses mark `failed`; the client is ready only after all live subscriptions are rebound or failed, `connectionError()` is `{code: "disconnected", recovering: true}` until then → vtt-5su.2 (D23, §8), vtt-5su.7 (`markRecovering`, `reopen` no longer clears the error, `recovering` states), vtt-5su.19 (two consecutive drops with three subscriptions), vtt-5su.15 (gate during recovery, no `failed` records).
5. Every unsettled outcome of a write already written to a socket is `uncertain`; `disconnected` only for requests never written → vtt-5su.2 (§6, §10), vtt-5su.7 (writes reject `uncertain` on timeout or socket loss), vtt-5su.19 (one `reason` per path, frame-count tests), vtt-5su.11.
6. Startup order: MCP first, agent name from MCP client info (fallback `agent`), recovery from the start without an initial connection; discovery identity at the first `welcome` → vtt-5su.2 §11, vtt-5su.7 (`agent_name` may be a function; `connectionError()` is `disconnected` before the first `welcome`), vtt-5su.19 (`enableRecovery` makes the first connection), vtt-5su.17 (start while the authority is down).
7. Explicit strict MCP input schemas: `transact` without `actor`, `retry`, `txn_id`; `undo` target narrowed → vtt-5su.2 §11, vtt-5su.11 (input-error tests with server request count).
8. Two-stage parsing: `parseServerMessage` normalizes envelope and notifications; `parseResult` normalizes results and returns `{value, warnings}` → vtt-5su.3, vtt-5su.7.
9. Identity file created with `open("wx")` under the held lock, `EEXIST` reads the winner's id; lock acquisition cleans up after itself → vtt-5su.18, vtt-5su.4, vtt-5su.2 §2.
10. Split: vtt-5su.9 retitled "Protocol: object and cover subscriptions" (owns the Table notification seam and a `registerScope` provider interface); new **vtt-5su.20** "Protocol: log window subscriptions" (`log-window.ts`, `logScopeProvider`, `createSubscriptionHub`). The randomized fresh-subscribe equivalence test moved to the integrating bead vtt-5su.12 (over the protocol, object, cover and log scopes). vtt-5su.10 builds its hub with `createSubscriptionHub`.
11. vtt-5su.3's ownership is an explicit file list excluding `client.ts`, `mirror.ts` and `client/recovery.ts`.

Edges added: vtt-5su.6 → vtt-75c.19; vtt-5su.20 → vtt-5su.9, vtt-5su.6; vtt-5su.10 → vtt-5su.20; vtt-5su.12 → vtt-5su.9, vtt-5su.20. None removed.

---

## Review r5 changes

Codex plan review r5 (review-plan-m3-r5.md, 11 findings) and the orchestrator's final dispositions (plan-m3-r5-dispositions.md), applied 2026-11-05. Findings 1–10 accepted as text fixes; 11 (split vtt-5su.3 and vtt-5su.12) declined, M3 stays at 20 beads. No beads created, no edges added or removed. Finding → beads changed:

1. Recovery seam gains `requestDuringRecovery` (allowed while `recovering`; `request` stays gated on `open`) and `abortSocket(reason)` (closes the socket, state `idle`, reconnectable; `close()` stays the only terminal path) → vtt-5su.7; vtt-5su.19 resubscribes only through `requestDuringRecovery` and aborts on a resubscribe timeout (test with the socket still open).
2. No explicit credentials ⇒ discovery mode even without a session file (stays up, connects when the file appears); exit 1 only for malformed or incomplete explicit credentials → vtt-5su.2 §11, vtt-5su.17.
3. One cover classification table matching M2 after vtt-75c.19 (unreadable geometry → `whole_board` whatever `opaque`; no shape → no cover; opaque true/error/non-boolean → region; opaque false → none) → vtt-5su.2 §7.5, vtt-5su.6 (one parity test per row).
4. Board create/remove (incl. undo) are visibility-relevant; object views and log-window group views holding board refs are rebuilt → vtt-5su.2 §8, vtt-5su.9 (rule, test 2b), vtt-5su.20 (historical-log test).
5. Every reconnect's `welcome.table` is checked against the first identity before rebinding or retrying; mismatch is `wrong_table` (explicit: terminal; discovery: re-read and retry once, then terminal) → vtt-5su.2 (§2, §8), vtt-5su.19.
6. `not_found` only for query, explain and subscribe targets; transaction targets follow §6 and M2 rejection semantics (`invalid` for an unknown object) → vtt-5su.2 §4, vtt-5su.5, vtt-5su.8.
7. `ExplainActionResult` has top-level `enabled` and `reason`, and `guard` only when a `when` exists → vtt-5su.2 §9, vtt-5su.3, vtt-5su.16 (unguarded action, GM and character).
8. Fireball acceptance asserts no `index` dependency while the zone is inside the card, then moves it onto `crypt`, asserts the `index` dependency and undoes the move → vtt-5su.13.
9. Erroneous or wrongly typed `opaque`/`position` only from formulas, never stored literals → vtt-5su.6, vtt-5su.8.
10. Identity initialization serialized under the lock and per path in process, temp file + rename, cleanup on failure, `TableIdentityError` for empty or malformed files → vtt-5su.2 (D25, §2), vtt-5su.18, vtt-5su.4 (open releases the lock), vtt-5su.14 (exit message).
11. Declined.

---

## 4. Open questions (resolved)

All proposals were accepted on 2026-11-04 except: Q13 → written into
vtt-75c.10 (no M3 edit to visibility.ts, no decision-log row); Q20 and Q31 →
the new M2 bead vtt-75c.18 (setActions and removeBoard, with its own two
decision-log rows), and M3-c gains `remove_board`. The accepted answers are
M3-0's decisions D1–D31. The text below is the draft as reviewed.

**Q1. Process model and MCP transport.** *Proposal:* one authority process
per table (`vtt-serve`) owns the file and the `Table` and serves the
WebSocket protocol; the MCP server is a separate stdio process (`vtt-mcp`),
launched by the agent host, that attaches to the authority as a protocol
client with actor `agent`. Stdio is supported by every MCP host; the agent is
literally a peer client of the UI (DESIGN §7); the table outlives agent
sessions. DESIGN §7's "hosts the MCP server" becomes "ships". *Alternatives:*
(a) MCP in-process over Streamable HTTP at `/mcp` (one process, no
discovery; needs HTTP-capable hosts); (b) both; (c) the agent host launches
the authority over stdio (ties the table's life to the agent).

**Q2. Where wire types and the client live.** *Proposal:* new package
`@vtt/protocol` (schemas, `ProtocolClient`, `ViewMirror`), browser-safe,
shared by authority, MCP and M4's UI; CLAUDE.md's package list gains it.
*Alternatives:* (a) schemas in `@vtt/schema`, client behind a `"./client"`
subpath of `@vtt/authority` (breaks the "`.` only" exports rule; UI depends on
the authority); (b) client written by M4 in `@vtt/ui` (MCP then needs a second
client).

**Q3. Transport, envelope, doc home.** *Proposal:* JSON text frames on one
WebSocket at `ws://127.0.0.1:<port>/ws`; envelope tagged by `type` like every
tagged form in the project; client-chosen string request ids echoed in
responses; exact-match `protocol: 1` in `hello`; wire format in a new
`docs/PROTOCOL.md`. *Alternatives:* JSON-RPC 2.0 (matches MCP; clashes with the
`type` convention); DESIGN §7 as the doc home (grows DESIGN by hundreds of
lines).

**Q4. Localhost auth.** *Proposal:* bind 127.0.0.1; a random 256-bit token
per start, required in `hello`; upgrades with a foreign `Origin` refused
(stops web pages driving the table through the browser); `--allow-origin` for
the Vite dev server. Authenticated connections have GM authority.
*Alternatives:* Origin check only (any local process can write); token in
the URL query (leaks into logs and history).

**Q5. Discovery.** *Proposal:* `vtt-serve` writes
`$XDG_CONFIG_HOME/vtt/session.json` (`{url, token, pid, table}`, 0600);
`vtt-mcp` uses `--url/--token`, else `VTT_URL`/`VTT_TOKEN`, else that file;
last started wins. *Alternatives:* `<table>.session.json` beside the table
(the MCP config must name the table); env only.

**Q6. Command model.** *Proposal:* one write command, `transact`: a list of
ops (18 kinds, one per M2 primitive) in one transaction = one group = one
undo unit, with batch-local `$name` bindings usable in op id positions and
ref values, so an agent authors zone, card and links atomically; plus `undo`,
`save`, `invoke` (M5). *Alternatives:* one command per primitive (multi-object
authoring is not one undo unit); a generic document patch (bypasses
primitive invariants, against §5.2).

**Q7. Stale-write policy.** *Proposal:* every `transact` carries
`base_revision`; refused `stale_write` iff a group committed after it (undo
groups included) shares a touched key (vtt-75c.5 `touchedKeys`, the undo
conflict rule) with the transaction's own effects, or when `base_revision`
predates retained history (`truncated`). Disjoint writes commit; ops are
explicit, so nothing is rebased or re-evaluated. Undo is not stale-checked
but may pin its target with `expect_index`. *Alternatives:* (a) any
intervening commit refuses (UI and agent would refuse each other
constantly); (b) last writer wins (contradicts "rejected on conflict"); (c)
additionally declared read sets — Polish if needed.

**Q8. Idempotent retries.** *Proposal:* optional `txn_id`; the last 1,000
results are remembered in memory and a repeat returns the stored result; the
MCP server resends once after reconnecting. *Alternatives:* none (a retry may
double-apply); persistent dedup.

**Q9. Actor attribution.** *Proposal:* `client.kind` fixes the default actor
(`agent` → `{type:"agent", name}`, else `gm`); non-agent connections may pass
`actor: {type:"character", id}` per `transact` (the GM driving a character,
FIXTURES §1); agents cannot impersonate. *Alternatives:* actor fixed per
connection in `hello`; free per request for all.

**Q10. Subscriptions and formula push.** *Proposal:* per-connection
subscriptions with a scope (`board` incl. contents recursively, `objects`
± subtree, `all`, `log`) and a viewer; `subscribe` returns full views; then
one `commit` event per commit per connection with the group header and, per
subscription, upserted whole object views, removed ids, cover changes, group
views (log). After each commit the authority pulls exactly the dirty cells in
some scope and sends changed views (eager when subscribed, lazy otherwise,
FORMULAS §7). *Alternatives:* cell-level patches (Polish); raw op groups
(impossible for character views: results, never inputs); valueless
notifications plus re-query (chatty).

**Q11. What a cell view reveals.** *Proposal:* GM: value, kind, formula
source, override flag, per-cell visibility entry, full actions. Character:
value, kind, override flag, action names; no formula source (a source can
embed secrets like `if(roll >= 15, …)`; FORMULAS §9: the author decides what
a formula publishes). Every readable structural cell (with defaults) is in
`cells`, so per-cell visibility on `tag` or `contents` filters uniformly.
*Alternatives:* sources visible to characters; structural fields as top-level
view fields (special cases for their per-cell visibility).

**Q12. Refs to invisible objects.** *Proposal:* in character views such a
ref (top level, in lists, in viewers values) becomes the wire-only
`{type:"redacted"}` in place: a visible hand's `contents` keeps its count, as
at a real table, without leaking ids, which are meaningful by design (§5.3);
an error with a hidden origin keeps only its code. *Alternatives:* drop such
refs (changes lengths); leave ids visible (leaks `goblin_assassin`).

**Q13. Face-down exemptions (M2 discrepancy).** DESIGN §4.4: a face-down
object shows "its back, its placement, and its name"; vtt-75c.10 exempts only
`name`, so a non-owner cannot place the card. *Proposal:* exempt `name`,
`board`, `position`, `rotation`, `z`, `container`, `face_up`, `shape`;
per-cell entries still apply; M3-d edits `visibility.ts`; M5 decides what the
back shows. *Alternatives:* placement and `name` only; file it as an M2 bug.

**Q14. Cover delivery.** *Proposal:* character views carry `Cover`s for
opaque zones the viewer cannot see: region (position, rotation, shape) under
a key that hides the zone id; undetermined zones are `whole_board`; the zone
and covered objects are absent. *Alternatives:* send the zone with all cells
hidden (leaks id and name).

**Q15. Log filtering for characters.** *Proposal:* by **current**
visibility: names and effects limited to what the viewer sees now, effects on
removed objects dropped, empty groups omitted, header (actor, GM-written
label) kept. *Alternatives:* historical visibility (needs rewind and
re-evaluation per group); hide labels too.

**Q16. Explain.** *Proposal:* `explain_cell`: content (source, override,
parses), the engine's recorded dependency tree to depth ≤ 4 / ≤ 200 nodes with
values; for characters hidden cells named without value and invisible objects
as `object: null`; the error-origin chain; the last writing group.
`explain_group`: effects plus the origin action's *current* definition.
`explain_action`: `when` source, value, enabled; step text. *Alternatives:*
name invisible objects (FORMULAS §9 only forbids highlighting them); record
action definitions in groups at commit (schema change).

**Q17. MCP tool surface.** *Proposal:* the 17 tools of M3-j, input schemas
generated from the protocol schemas; one `transact` tool with a
discriminated op union (short tool list, batches); rejected writes are
`isError: true`; docs as resources (`vtt://docs/formulas`, `design`,
`protocol`, `vtt://schema/ops`). *Alternatives:* a tool per op (18 more tools,
no atomic batches); rejections as normal results; no resources (agents lack
the language spec, against §5.3).

**Q18. MCP subscribe.** *Proposal:* a change buffer per subscription in the
MCP process, drained by `poll_changes` (long poll ≤ 30 s), plus
`notifications/resources/updated` on `vtt://subscriptions/<id>`; cap 1,000
commits, then `overflowed`. *Alternatives:* notifications only (most hosts do
not surface them to the model); `changes_since` only (fails "Subscribe").

**Q19. `invoke` in M3.** *Proposal:* defined in protocol v1, answered
`unsupported` until M5; no MCP tool until M5 adds it with the UI's buttons.
*Alternatives:* add the method additively in M5; an always-failing tool now.

**Q20. Defining actions in M3.** M2 has no primitive that changes `actions`,
yet §5.2 lists "define … actions" and step 5 needs a Fireball card.
*Proposal:* M3-b's `setActions` with a `field: "actions"` effect (key
`actions:<obj>`), source text stored unparsed. *Alternatives:* defer to M5 and
spawn a prepared template in the step-5 test; actions as cells (reopens an M2
schema decision).

**Q21. Limits.** *Proposal:* `max_message_bytes` 1 MiB; `max_ops` 1,000;
`max_page` 200; `max_ids` 200; `max_subscriptions` 16; `max_explain_depth`
4; `max_explain_nodes` 200; `max_source_length` 10,000; `max_groups` 500;
`max_requests_per_second` 200 (`busy`); `max_buffered_bytes` 8 MiB (closed
4429). Formula cost stays under the engine budget. *Alternatives:* other
numbers; no rate limit (a flooding agent starves the UI).

**Q22. Ordering.** *Proposal:* messages handled one at a time in arrival
order (synchronous handlers); commits totally ordered by revision; every
connection gets every commit event in order; the committer gets the event
before its response. *Alternatives:* response first (clients must handle a
known revision whose delta has not arrived).

**Q23. Reconnection.** *Proposal:* no server-side resumption: the client
re-hellos, resubscribes and replaces mirrors with full views (`resync`);
pending requests fail `disconnected` (writes safe by Q8); ping every 15 s,
two missed pongs terminate. *Alternatives:* resume from a revision with
buffered deltas (complex; full views are cheap locally).

**Q24. Autosave and compaction.** *Proposal:* save 2 s after the last commit,
at most 10 s after the first unsaved one, on `save`, on shutdown; failures
retried at the next schedule and broadcast; no automatic compaction in v1.
*Alternatives:* save per commit (drags would fsync constantly); periodic only.

**Q25. New table, port, files.** *Proposal:* a missing file is created with
board `gm_board` "GM" and no objects (M5 stocks the binder); default port
4747 (`0` in tests); examples use `.table.json`; lock `<file>.lock`.
*Alternatives:* random default port (the UI URL changes); a board `table`.

**Q26. Step-5 test content.** "Hatch it" names no cell; appearance cells are
M4's. *Proposal:* the agent writes an ordinary cell `pattern: "hatch"`; M4
renders or renames it. The Fireball card is authored from scratch (create,
cells, `setActions`) to exercise "define actions"; `dc` is a literal 14 since
the request states it. *Alternatives:* fix appearance cell names now
(pre-empts M4); spawn the fixture's template (weaker test of write).

**Q27. New dependencies (exact, all ≥ 2 weeks old).** *Proposal:* `ws`
8.22.0 (2026-09-26; Node 26 has a WebSocket client but no server; no
transitive deps) and `@types/ws` 8.18.2; `@modelcontextprotocol/server` 2.3.1
(2026-10-05; the official SDK's v2 server package, `zod` ^4.2 — compatible
with 4.6.7 — plus `@modelcontextprotocol/core`, without v1's express/hono
tree) and `@modelcontextprotocol/client` 2.3.1 (dev); `tsx` 4.23.15
(2026-09-20) to run the binaries, since extensionless relative imports do not
run under Node's type stripping; `zod` 4.6.7 in protocol and authority.
*Alternatives:* MCP v1 `@modelcontextprotocol/sdk` 1.32.1 (one package,
larger tree); hand-rolled WebSocket framing (a security-sensitive parser to
own).

**Q28. `evaluate` and viewers.** *Proposal:* GM-only; evaluating arbitrary
source "as Aldric" would be an oracle for hidden values. *Alternatives:* allow
it with a filtered result (cannot be filtered meaningfully).

**Q29. `at_position`.** *Proposal:* objects directly on the board whose
evaluated footprint contains the point (boundary inclusive; shapeless:
anchor within epsilon), zones separately, both ascending `z` then id
(FORMULAS §5), contained objects excluded. *Alternatives:* topmost first (a
second order in the product); anchor-only matching.

**Q30. Raw document access.** *Proposal:* GM-only `document` method (snapshot
and retained log) for the protocol runner's `replay` and bulk reads; no MCP
tool in M3. *Alternatives:* also a tool; omit it and check `replay` only in
the direct runner.

**Q31. Board removal.** M2 has no board removal primitive, so neither UI nor
agent can delete a board. *Proposal:* file it in M4 (which manages boards).
*Alternatives:* add it to M3-b.

---

## 5. Followups (filed)

- Polish (vtt-qf5, P3): vtt-qf5.4 cell-level deltas in commit events (Q10);
  vtt-qf5.5 read-set preconditions on transact (Q7 c); vtt-qf5.6 automatic
  log compaction policy (Q24); vtt-qf5.7 persistent txn_id deduplication (Q8).
- Later (vtt-y1w, P4): vtt-y1w.8 remote access over TLS; vtt-y1w.9 multiplayer
  rights over actor and viewer; vtt-y1w.10 MCP Streamable HTTP transport.
- Later, filed by review r1 (vtt-y1w, P4): vtt-y1w.11 persistent command
  deduplication across authority restarts (supersedes vtt-qf5.7, which predates
  client-instance scoping); vtt-y1w.12 chunked initial subscription snapshots.
- M4 inputs: comment on vtt-3l6.1 (protocol client and views, static UI and
  token injection and assets, appearance cells incl. hatch, removeBoard,
  stale-write surfacing).
- M5 inputs: comment on vtt-1xv (invoke and its MCP tool, step parsing and
  explain, commit-time action definitions, face fields, log sentences).
