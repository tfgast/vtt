# Protocol

The wire protocol between the authority and its clients (the UI, the MCP
server, tests), version 1, and the MCP surface built on it. DESIGN.md §5.2
says what the surface must cover and §7 says how the authority is built; this
document is the contract every implementation follows. Decisions are cited
as D1–D33; each is the DESIGN.md §10 decision-log row that starts `M3-D<n>.`
(D13, D20 and D31 have no row of their own: D13 is the face-down exemption
set of §7.4, already stated in DESIGN.md §4.4; D20 and D31 are the
`setActions` and `removeBoard` primitives, logged with M2). M4's and M5's
additions cite their rows in full, `M4-D<n>` and `M5-D<n>`.

**Conventions.** Types are written in TypeScript notation. `ObjectId`,
`BoardId`, `Shape`, `ErrorCode`, `ActionDef`, `Actor`, `Board`, `Snapshot`,
`OpGroup`, `Rejection`, `FaceLayout`, `FaceElement` and the scalar value types (`NumberValue`,
`TextValue`, `BooleanValue`, `EmptyValue`, `DiceValue`, `RollValue`,
`InkValue`, `ShapeValue`) are those of `@vtt/schema` (DESIGN.md §4, §7;
FORMULAS.md §2); an `InkValue` stroke is a point list or `{points, color?,
width?}` (M6-D28). Client-to-server messages are parsed strictly: unknown keys
are rejected. Server-to-client messages are parsed loosely: unknown keys are
dropped (§12). `__proto__` is rejected as a key anywhere, in either direction
(as FIXTURES.md §1).

Contents:

1. Transport, framing, envelope, close codes
2. Handshake, authentication, origin, discovery, new table
3. Actors
4. Requests, responses, methods
5. Ops, bindings, input values
6. Revisions, stale writes, deduplication
7. Views, values, redaction, covers, group views
8. Subscriptions, commit events, ordering, reconnection
9. Explain, evaluate, at_position, changes_since, document
10. Errors, rejections, limits
11. MCP
12. Additive extension

## 1. Transport, framing, envelope, close codes

Decisions: D1, D3; M4-D1, M4-D3.

- One WebSocket per client at `ws://127.0.0.1:<port>/ws`. JSON text frames,
  one message per frame. Every message has a `type`.
- Client → server messages: `hello`, `request`. Server → client messages:
  `welcome`, `response`, `event`, `goodbye`.
- Close codes:

  ```ts
  const CLOSE_CODES = { protocol: 4400, unauthorized: 4401, hello_timeout: 4408, slow_consumer: 4429, shutdown: 1001 };
  ```

  These are the codes the server closes with. The client closes a socket it
  abandons with 4000: `ProtocolClient.abortSocket` (used by recovery, §8)
  and the client-side handshake timeout (§2).

- WebSocket upgrades are accepted only on `/ws` (their `Origin` check is in
  §2).

**HTTP routes** (M4-D1, M4-D3). Beside `/ws` the HTTP server answers:

| Route | Answer |
|---|---|
| `GET /healthz` | `200 {"ok":true,"revision":n}` |
| `GET /` (also `/index.html`) | the built UI's `index.html` with exactly one injected session element (§2), `Cache-Control: no-store`; the build itself contains none. Without a build, a short page saying how to build it; with `vtt-serve --no-ui`, 404. |
| `GET /ui-assets/<path>` | the static UI bundles of the build (never under `/assets/`); the resolved path stays inside the bundle directory, dotfiles are refused, content type by extension, `X-Content-Type-Options: nosniff` |
| `GET /assets/<path>` | a table image asset: only a path listed in the table file's `assets` (normalized, no traversal), its bytes with the content type by extension and `Cache-Control: no-store`; any other path 404 |
| `POST /assets` | uploads an image asset (below) |
| anything else | 404 |

- **`Host` check.** Every non-upgrade request except `GET /healthz` must
  carry `Host: 127.0.0.1:<port>` or `Host: localhost:<port>`; any other
  `Host` is answered 421 before routing. This closes DNS rebinding, as the
  `Origin` check does for `/ws`.
- **`POST /assets`.** `Authorization: Bearer <token>` (the session token,
  compared in constant time); the body is the raw file bytes; `X-Filename`
  and optional `X-Slug` headers (URL-encoded) name it. Accepted types are
  PNG, JPEG, WebP and GIF, recognised by their magic bytes (no SVG); at most
  50 MiB. The file is stored as `<table basename>.assets/<slug>-<hash8>.<ext>`
  relative to the table's directory (slug: `X-Slug`, else the file stem,
  lowercased, characters outside `[a-z0-9_-]` replaced by `-`, at most 40
  characters; `hash8`: the first 8 hex digits of the bytes' SHA-256), added to
  the table's asset list for the next save (DESIGN.md §7, **Revisions and assets**), and
  answered `201 {"path": <that relative path>}`; the same bytes and slug give
  the same path without rewriting. Errors: 401 bad token, 413 too large, 415
  unsupported type, 409 for an in-memory table. The UI and `import_asset`
  (§11) both use this route; the path goes into an object's `image` cell
  (DESIGN.md §4.6, **Appearance cells**).

## 2. Handshake, authentication, origin, discovery, new table

Decisions: D4, D5, D8, D25, D33; M4-D1; M6-D5, M6-D35.

```ts
{ type: "hello"; protocol: 1; token: string;
  client: { name: string /* 1–100 chars */; kind: "ui" | "agent" | "test"; instance: string /* 1–64 chars of [A-Za-z0-9_-] */ };
  agent_name?: string /* 1–100 chars */;
  capabilities?: string[] /* at most 32, each 1–64 chars */ }
{ type: "welcome"; protocol: 1; session: string; actor: Actor; revision: number; boards: BoardView[];
  table: { name: string; path: string | null; id: string | null }; limits: Limits;
  capabilities?: Capability[] }
type Capability = "cell_patches";
{ type: "goodbye"; reason: string }
```

**Handshake.**

- The first client message must be `hello`, within 5 s; otherwise the
  connection is closed 4408.
- Client side, `connect` and `reopen` wait at most `handshakeTimeoutMs`
  (a `ProtocolClient` option, default 10 s) from opening the socket for the
  `welcome` (or a refusal). When it passes, the client closes the socket
  with 4000 and rejects the attempt `disconnected`, as for a dropped socket;
  recovery (§8) treats it as any failed attempt and retries with its
  backoff. A server that accepts the socket but never answers therefore
  never leaves the client waiting.
- A wrong token (compared in constant time) or a first message that is not
  `hello`: `goodbye`, then close 4401.
- A `protocol` other than 1: `goodbye`, then close 4400.
- `capabilities` (M6-D35) lists optional behaviours the client supports.
  The authority ignores names it does not know and echoes the ones it
  accepts in `welcome.capabilities`, in `CAPABILITIES` order (`[]` when it
  accepts none). A `hello` without `capabilities` gets a `welcome` without
  them, exactly as before. The only capability is `cell_patches`: commit
  events may carry cell-level patches (§8). `ProtocolClient` sends
  `["cell_patches"]` unless constructed with `cellPatches: false`.
- `session` identifies the authority process run: random, fixed for the life
  of the process, different after every restart.
- `client.instance` is chosen by the client (for example a UUID per client
  object) and reused across that client's reconnects. It scopes `txn_id`
  deduplication (§6).
- `table.name` is the table file's basename, `table.path` its absolute real
  path, and `table.id` the content of `<file>.table-id`. `path` and `id` are
  both null for an in-memory table.

**Session bootstrap (M4-D1).** The page served at `GET /` (§1) carries the
connection credentials in exactly one element in its `<head>`:

```html
<script id="vtt-session" type="application/json">{"url": "ws://127.0.0.1:<port>/ws", "token": "<token>"}</script>
```

The JSON has `<` escaped as `\u003c`, so a token can never close the
element. The UI reads it and connects with these explicit credentials
(`client.kind: "ui"`); an authority restart rotates the token, so the page
must be reloaded to get the new one. The built UI contains no such element;
only the serving authority (or the development server, from
`VTT_URL`/`VTT_TOKEN` or the discovery file) injects it.

**Authentication and origin.**

- The server binds 127.0.0.1 only.
- The token is 32 random bytes, base64url encoded, new at every server start
  unless fixed with `--token`. Tokens never start with `-`, so they are safe
  as a separate CLI argument (a generated token whose first character is not
  alphanumeric is drawn again); `--token=<t>` is the robust spelling for any
  token.
- An upgrade whose `Origin` header is present and is neither
  `http://127.0.0.1:<port>`, `http://localhost:<port>`, nor an
  `--allow-origin` entry is refused with HTTP 403.
- Every authenticated connection has GM authority. `viewer` parameters select
  whose view is computed; in v1 a viewer is a view-as selector, not a
  security boundary (§3).

**Discovery (D5).**

- `vtt-serve` writes `$XDG_CONFIG_HOME/vtt/session.json` (default
  `~/.config/vtt/session.json`) holding `{url, token, pid, table_path,
  table_id}`; the directory has mode 0700 and the file 0600. On shutdown the
  file is removed only when its `pid` matches. The last started authority
  wins.
- Credential refresh. A client constructed from discovery records
  `table_path` and `table_id` at its first successful `welcome` (it may start
  before the authority is reachable) and re-reads the file before every
  reconnect attempt. It adopts the file's `url` and `token` only when both
  `table_path` and `table_id` match the recorded ones; otherwise it stops
  (`closed`) and reports `wrong_table`. A missing file means: keep retrying
  with the last credentials, or, before the first `welcome`, keep waiting for
  the file.
- Whatever credentials were used, the reached authority's `welcome.table` is
  checked against the captured identity (§8).
- A client constructed with explicit credentials never re-reads the file: a
  4401 is terminal and reported as `unauthorized`, and writes in flight report
  `uncertain`.
- Before the first `welcome`, every client reports the connection error
  `disconnected`.

**New table (D25, M5-D19).** `vtt-serve` on a missing file creates it with
one board `gm_board` named "GM", revision 0, and an empty log, holding the
GM binder `gm_binder` on `gm_board`, stocked with the example templates
(DESIGN.md §4.7); with `--empty` it holds no objects. The table host's own
default for a missing file stays the empty table, which tests use. The
default port is 4747.

**Opening a browser (M6-D5).** `vtt-serve --open` opens
`http://127.0.0.1:<port>/` in a browser once listening. `$BROWSER`, when
set, names an executable called with the URL as its only argument; else the
opener is `open` on macOS and `xdg-open` elsewhere. A failure to open logs
one line and the server keeps running. `--open` with `--no-ui` is refused as
a usage error.

**Canonical path.** `<file>` below is the canonical table path: the
`realpath` of the table file, or, when the file does not exist yet, the
`realpath` of its directory joined with its basename. Symlink aliases of one
table therefore share one lock and one identity file. A dangling symlink is
followed to its target first (each hop resolved against the link's real
directory), so a new table is created at the target and the link then points
at it; a symlink loop or a missing target directory refuses the open with an
error naming it.

**Lock file (D25, D33).** `<file>.lock`, content `{pid, nonce, host,
started}`.

- Acquire: `open(lock, "wx")` (exclusive create), write the content, fsync,
  close. Any failure after the open unlinks the lock this process created
  (after checking its nonce) and rethrows.
- On `EEXIST` the lock is read and the start is refused (`locked`) with the
  recorded `pid`, `host`, `started`, and `stale` (true only when `host` is
  this host and the pid is not alive). Unreadable or malformed content is
  `locked` with `stale: false`.
- No code path takes over a lock automatically. Removing a stale lock is a
  human decision, made with `vtt-serve --force-unlock`, which unlinks the lock
  file before acquiring and logs what it removed.
- Release unlinks the lock only if it still holds the owner's nonce, and is
  idempotent.
- Every failed open (load error, corrupt file, initial-save failure) releases
  the lock.

**Table identity (D25).** `<file>.table-id` holds a random UUID on one line.
It is initialized only while the table lock is held: an existing file is
read; a missing one is created by writing `<file>.table-id.tmp-<nonce>` and
renaming it to the final name (safe because the lock serializes writers), the
temp file removed on failure. An existing file that is empty or malformed
fails the open with `TableIdentityError`; a human fixes or deletes it, and it
is never rewritten automatically. (The table file format has no id; this file
keeps it unchanged.)

## 3. Actors

Decision: D9.

- `client.kind: "agent"` → `{type:"agent", name: agent_name ?? client.name}`.
- `client.kind: "ui"` or `"test"` → `{type:"gm"}`.
- A non-agent connection may pass `actor: {type:"character", id}` on
  `transact` and `invoke`, naming an existing object whose `is_character` is
  true (the GM driving a character). The UI passes one on `invoke` for a
  button pressed in view-as (the viewed character, M5-D11) and, in GM view,
  for a button on an object a character owns (that character, M6-D15;
  DESIGN §4.5). An agent passing `actor` is `bad_request`.
- Every connection has GM authority; `viewer` parameters select whose view is
  computed.

## 4. Requests, responses, methods

Decisions: D6, D19, D28, D29, D30; M5-D1; M6-D2; M6-D32.

```ts
{ type: "request"; id: string /* 1–64 chars */; method: M; params: Params<M> }
{ type: "response"; id: string; ok: true; result: Result<M> }
{ type: "response"; id: string | null; ok: false; error: ProtocolError }   // id null when the request id could not be read
type Viewer = { type: "gm" } | { type: "character"; id: ObjectId };
type ObjRef = ObjectId | BindingName;   // BindingName: "$" followed by id characters
```

Methods (18). `viewer` defaults to `{type:"gm"}`. The method kind is in
brackets.

| Method | Params | Result |
|---|---|---|
| transact [write] | `base_revision: number`, `ops: WireOp[]` (1..max_ops), `label?: string` (≤ 200), `txn_id?: string` (1–64), `retry?: true` (only with `txn_id`; set on a client resend, §6), `actor?: Actor` (character only, §3), `expect?: {object: ObjectId, cell: string}[]` (≤ max_ops; the read set, §6) | `TransactResult` = `{status:"committed", revision, index, created: {op_index, id}[], copies: {op_index, root, copies: Record<ObjectId,ObjectId>}[], bindings: Record<BindingName, ObjectId>}` or `{status:"rejected", rejection: ProtocolRejection, op_index?: number}` |
| undo [write] | `target: {type:"latest"} \| {type:"mine"} \| {type:"human"} \| {type:"actor", actor: Actor} \| {type:"group", index: number}`, `expect_index?: number`, `label?: string` | `TransactResult`; `created`, `copies`, `bindings` empty |
| invoke [write] | `object: ObjectId`, `action: string`, `base_revision: number`, `txn_id?: string` (1–64), `retry?: true` (only with `txn_id`, §6), `actor?: Actor` (character only, non-agent connections, §3), `label?: string` (≤ 200), `table?: {board: BoardId, position: [number, number]}` (what the `table` destination resolves to, FORMULAS.md §8.2) | `InvokeResult` = `{status:"committed", revision, index, created: ObjectId[]}` or `{status:"rejected", rejection: ProtocolRejection, step?: number}` |
| save [write] | `{}` | `{status: "saved" \| "saved_not_durable" \| "failed", revision: number, message?: string}` (`revision` = the revision the save captured) |
| collect_assets [write] | `delete?: boolean` | `{unreferenced: string[], deleted: string[]}` (GM only) |
| list_objects [query] | `viewer?`, `filter?: {board?, container?, tag?, name?, is_template?, is_zone?, is_character?}`, `cells?: "all" \| "structural" \| string[]` (default `"structural"`), `cursor?: string`, `limit?: number` (default 50, ≤ max_page) | `{revision, objects: ObjectView[], next_cursor: string \| null}` |
| get_objects [query] | `ids: ObjectId[]` (1..max_ids), `viewer?`, `cells?` (default `"all"`) | `{revision, objects: ObjectView[], missing: ObjectId[]}` |
| evaluate [query] | `source: string` (≤ max_source_length), `this?: ObjectId` | `{revision, value: WireResult}` (GM only, unredacted) |
| zones [query] | `board: BoardId`, `viewer?` | `{revision, zones: {id, contents: ObjectId[], error?: ErrorCode, view: ObjectView}[]}` |
| at_position [query] | `board: BoardId`, `position: [number, number]`, `viewer?` | `{revision, objects: ObjectId[], zones: ObjectId[]}` |
| changes_since [query] | `revision: number`, `viewer?`, `limit?: number` (default 100, ≤ max_groups) | `{revision, floor, groups: GroupView[], truncated: boolean, more: boolean, next_revision: number}` (§9) |
| log [query] | `before?: number`, `limit?` (default 50, ≤ max_page), `viewer?`, `effects?: boolean` | `{first_index, next_index, undo_barrier, groups: GroupView[]}`, newest first |
| document [query] | `{}` | `{snapshot: Snapshot, log: {first_index, groups: OpGroup[], undo_barrier}}` (GM only, canonical, unfiltered) |
| explain_cell [explain] | `object`, `cell`, `viewer?`, `depth?` (1..max_explain_depth, default 1) | `ExplainCellResult` |
| explain_group [explain] | `index: number`, `viewer?` | `ExplainGroupResult` |
| explain_action [explain] | `object`, `action`, `viewer?` | `ExplainActionResult` |
| subscribe [subscribe] | `scope: {type:"board", board} \| {type:"objects", ids: ObjectId[] (1..max_ids), subtree?: boolean} \| {type:"all"} \| {type:"log"}`, `viewer?`, `cells?: "all" \| "structural"` (default `"all"`) | `{subscription: string, revision, objects: ObjectView[], covers: Cover[], groups?: GroupView[]}` |
| unsubscribe [subscribe] | `subscription: string` | `{}` |

Method rules:

- `list_objects`: the filters apply first (`board`: directly on it;
  `container`: directly in it; `tag`: the tag list contains the text; `name`:
  literal name equal; flags equal), then the viewer's visibility. Results are
  ordered by id (code point). `cursor` is the last id of the previous page.
  Each page reports its revision.
- `get_objects`: views in request order; nonexistent and invisible ids go to
  `missing`, indistinguishably.
- `zones`: every `is_zone` object directly on the board that is visible to
  the viewer, ordered by id. `contents` is in FORMULAS.md §5 order, restricted
  to visible objects. When `contents(zone)` evaluates to an error value of any
  code (for example `#TYPE`, `#CYCLE`, `#LIMIT`), `contents` is `[]` and
  `error` is that code; `view` is structural. The request never fails for this
  reason.
- `log`: `before` is an exclusive absolute index; `first_index`,
  `next_index`, and `undo_barrier` are as in DESIGN.md §7.
- `invoke` (M5-D1): runs the object's named action (FORMULAS.md §8) as one
  `action` group labelled with the action's name (or `label`), origin
  `{object, action}`. `created` lists the ids the action spawned, in
  creation order. `step` is the 0-based index of the refusing step
  (FORMULAS.md §8.1). Processing, stale checks and deduplication are in §6.
- `collect_assets` (M6-D32; DESIGN.md §7, **Revisions and assets**):
  removes from the table's asset list every listed path that no string in a
  live object (cell contents and overrides, formula and action source, face,
  tags) or in any effect of a retained group (`before` and `after`, created
  and removed subtrees, undo groups included) contains, so the next save no
  longer lists it and `GET /assets/` no longer serves it. `unreferenced` is
  those paths, in list order. With `delete: true` it also deletes each such
  file that lies directly in `<table basename>.assets/` and that no kept
  path names; `deleted` lists the paths whose files it deleted (a file
  already missing, or one that could not be deleted, is not listed). An
  in-memory table unlists only. A change makes the table unsaved and
  schedules the autosave, as an import does. Collections and imports
  (`POST /assets`) run one at a time, so an import is never undone by a
  collection in progress. It commits no group, changes
  no revision and sends no `commit` event; nothing collects automatically.
- `not_found` applies only to the target ids of query, explain and subscribe
  methods (unknown board, object or subscription ids in their params), except
  `get_objects` ids and `objects` scope ids, which are ignored when absent.
  Ids inside `transact` and `undo` are never `not_found`: they follow §6's
  processing order (structural validation, deduplication, actor checks, floor
  and stale checks, then primitive refusals) and the M2 primitives' rejection
  semantics. So an unknown object in an op is a rejection `invalid` with its
  `op_index`, and an object removed since `base_revision` is `stale_write`.
  The same holds for `invoke`: an unknown object or action is rejected
  `invalid`, and an object removed since `base_revision` is `stale_write`.

## 5. Ops, bindings, input values

Decisions: D6; D20 and D31 (the `set_actions` and `remove_board` primitives come from vtt-75c.18); M4-D12, M4-D17; M5-D7.

```ts
type InputValue = NumberValue | TextValue | BooleanValue | EmptyValue | DiceValue | RollValue | InkValue | ShapeValue
  | { type: "list"; items: InputValue[] } | { type: "ref"; object: ObjRef } | InputViewers;
type InputViewers = { type: "viewers"; viewers: ("all" | "gm" | "owner" | { type: "ref"; object: ObjRef })[] };
type InputCellContent = InputValue | { type: "formula"; source: string };
type Destination = { type: "board"; board: BoardId; position: [number, number] }
                 | { type: "container"; container: ObjRef; index?: number };
type ObjectInit = { is_template?: boolean; is_zone?: boolean; is_character?: boolean; tag?: string[]; shape?: Shape;
                    cells?: Record<string, InputCellContent>; cell_visibility?: Record<string, InputViewers>; actions?: ActionDef[];
                    face?: FaceLayout };   // M5-D7
```

`WireOp` is one of the 20 kinds in the table below, each written
`{type: <op>, ...its fields}`. Every `object`, `container` and `template`
field is an `ObjRef`. Each op maps to one M2 primitive and declares
intended-write keys (§6), computed from its fields before execution. A key
naming a `$binding` is omitted. The destination key is `board:<board>` for a
board destination and `cell:<container>/contents` for a container
destination.

| Op | Fields | Primitive | Declared keys |
|---|---|---|---|
| set_value | object, cell, value: InputValue, replace?: true | writeValue; with `replace`, replaceFormula | `cell:<object>/<cell>` |
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
| set_face | object, face: FaceLayout \| null | setFace | `face:<object>` |
| reorder | container, permutation: number[] | reorder | `cell:<container>/contents` |
| add_board | id, name? | addBoard | `board:<id>` |
| rename_board | id, name | renameBoard | `board:<id>` |
| remove_board | id | removeBoard | `board:<id>` |
| create_object | id?, id_base?: string, as?: BindingName, to: Destination, init?: ObjectInit | createObject | `obj:<id>` when `id` is given; destination key |
| spawn | template, to: Destination, cells?: Record<string, InputCellContent>, as?: BindingName, owned?: Record<ObjectId, BindingName> | spawn | `obj:<template>`; destination key |
| move | object, to: Destination | move | `cell:<object>/board`, `cell:<object>/position`; destination key |
| remove | object | remove | `obj:<object>` |

**`create_object` ids (M4-D12).** With `id`, the object gets that id (it
must be valid and not reserved). Without it, the authority allocates
`<id_base>_<n>` exactly as spawn allocates copies (DESIGN.md §4.1: `n` from
`next_seq`, skipping reserved ids), with `id_base` defaulting to `obj`.
`id_base` must have id syntax. `id` and `id_base` are exclusive: both, or an
invalid `id_base`, is rejected `invalid`. A bound `as` binds the allocated id.

**`set_value` and formulas (M4-D17).** Without `replace`, `set_value` on a
cell holding a formula writes an override (M2 `writeValue`). With
`replace: true` it replaces the stored formula, and any override, by the
literal in one cell effect, which one undo reverses exactly; on a literal or
absent cell it behaves as without it. The guards and type checks are
`writeValue`'s, so it is valid on structural cells such as `visible_to`,
`position` or `rotation`, while protected cells (`id`, `contents`,
`container`, `board`, `is_zone`) stay refused. This is the UI's "Replace
formula with value" (DESIGN.md §4.6, **Typing into a cell**).

**Face layouts (M5-D7).** `set_face` replaces an object's whole layout
(`null` removes it) in one `field: "face"` effect; its key `face:<object>`
conflicts with itself and with `obj:<object>`. The layout is copied verbatim
on spawn and carried in create and remove snapshots; absent means no layout;
there is no `schema_version` change. The encoding (DESIGN.md §4.6):

```ts
type FaceLayout = { elements: FaceElement[]; collapsed?: FaceElement[]; default_action?: string };
type FaceElement =
  | { type: "value" | "editor"; cell: string; rect: Rect; show_when?: string; min_size?: number; style?: FaceStyle }
  | { type: "button"; action: string; rect: Rect; label?: string; show_when?: string; min_size?: number }
  | { type: "contents"; rect: Rect; entries?: "collapsed" | "full"; show_when?: string; min_size?: number; when_selected?: boolean; layout?: "list" | "grid" | "fan" };
type Rect = [x: number, y: number, w: number, h: number];   // finite, w and h > 0
type FaceStyle = { size?: "small" | "normal" | "large" | "huge"; align?: "left" | "center" | "right"; caption?: boolean; format?: FaceNumberFormat };
type FaceNumberFormat = { sign?: "always" | "auto"; decimals?: number };   // decimals an integer 0–10 (FORMULAS.md §11)
```

At most `max_face_elements` (200) elements per list and one `contents`
element per list; `show_when` is non-blank and at most 10,000 characters;
`style.format.decimals` is an integer 0–10. A layout breaking these is
rejected `invalid`; an unknown `format` key or `sign` is a malformed layout
(`bad_request`).

`when_selected` (M6-D12) is optional on contents elements only and must be a
boolean (anything else, or the key on another element kind, is a malformed
layout: `bad_request`); absent means unset. It is presentation for the UI
(DESIGN.md §4.6, **Only when selected**): the authority stores it, and
views, `field: "face"` effects and snapshots carry it unchanged, to the GM
and characters alike.

`layout` (M6-D30) is likewise optional on contents elements only and is one
of `"list"`, `"grid"` or `"fan"` (another value, or the key on another
element kind, is a malformed layout: `bad_request`); absent means `"list"`.
It is presentation (DESIGN.md §4.6): stored, viewed and logged unchanged.

**Bindings.**

- `as` on `create_object` binds the created id; `as` on `spawn` binds the
  root copy; `owned` maps template-subtree ids (plain ids) to bindings for
  their copies.
- A binding is introduced at most once and used only after its introduction,
  in op order.
- Uses are replaced by the bound id in id positions and inside input values at
  any depth (lists, viewers entries).
- Bindings exist only within one `transact`. Views and results never contain
  unresolved binding references: every id in them is a real id.
  `TransactResult.bindings` maps binding names to the ids allocated for them.

**Default label.** For a single op, its type and target
(`"set_value goblin1.hp"`); otherwise `"<n> edits"`.

## 6. Revisions, stale writes, deduplication

Decisions: D7, D8; M5-D1; M6-D2.

**Revisions.** Each commit increments the revision by one (DESIGN.md §7).
`base_revision` must be an integer between 0 and the current revision
(`bad_request` otherwise).

**Floor.** The `base_revision` of the oldest group in the contiguous run of
retained groups that ends at the current revision. When there is no such run
(no retained groups, or the newest group's revision differs from the current
one after a hand edit), the floor is the current revision. The floor rises
when the log is compacted: `vtt-serve --keep-last <n>` (DESIGN.md §7, M6-D33)
keeps only the last n groups at every save, so a revision older than the
oldest kept group's base is answered `truncated: true` by `changes_since` and
a `stale_write`, and undo of a group below them is `nothing_to_undo`. Without
the flag the log is never compacted.

**Processing order of a `transact`**, with precedence from top to bottom:

1. Structural validation, independent of the document: schema, `txn_id`
   shape, op count and size limits, `label` length, binding introduction and
   use order, `actor` allowed for the connection kind. Failure is a
   `bad_request` error (not a rejection, not stored).
2. Deduplication lookup (below).
   - 2b. On a miss, state validation: `base_revision` within 0..current, and
     `actor` names an existing object whose `is_character` is true. Failure
     is `bad_request`, not stored.
3. `base_revision` < floor → rejected `stale_write` with `truncated: true` and
   no conflicts.
4. When `base_revision` < current revision, the declared keys of all ops (§5)
   are checked against every retained group with `revision > base_revision`
   (undo groups included) → rejected `stale_write`.
   - 4b. The read set (M6-D31): the keys `cell:<object>/<cell>` of
     `expect` take part in step 4's check, so a write computed from a cell
     that changed after `base_revision` is rejected `stale_write` even when
     the ops do not write it; an entry naming an object removed since is
     `stale_write` (the removal's `obj:<id>`). Then an entry naming an object
     that does not exist → rejected `invalid` (no `op_index`). An absent or
     empty `expect` checks nothing more.
5. The ops run in order in one transaction. A primitive refusal → rejected
   with that op's `op_index` (0-based); nothing is applied.
6. The touched keys (DESIGN.md §7) of the transaction's effects are checked
   against the same groups → rejected `stale_write`; the transaction is
   aborted with nothing applied and no randomness consumed.
7. Commit.

**Processing order of an `invoke`** (M5-D1) is the same: structural
validation (`txn_id`, `label`, `actor` allowed for the connection kind,
`retry` only with `txn_id`), deduplication, state validation (`actor` an
existing character), floor, then the declared keys `obj:<object>` and
`actions:<object>` against the groups after `base_revision`. The command
then opens the transaction itself and runs the action inside it (the
executor's `runAction`): the `when` guard is evaluated at the current
revision, not at `base_revision`; a refusal aborts with nothing applied
(rejected, with `step`); and, when `base_revision` < current, the touched
keys of the action's effects are checked before commit (→ `stale_write`).
So a refused or stale invoke commits nothing, notifies no listener, and
consumes no randomness.

**Conflicts.** Keys conflict when equal, or when one is `obj:<id>` and the
other names `<id>` (DESIGN.md §7). A conflict entry lists the group's own keys
that conflict with the checked set, so a write to an object removed since
reports the removal's `obj:<id>`.

```ts
{ type: "stale_write"; base_revision: number; revision: number /* current */; floor: number; truncated: boolean;
  conflicts: { index: number; revision: number; actor: Actor; label: string; keys: string[] }[] }
```

Disjoint writes commit. Nothing is rebased or re-evaluated.

**Undo.** Undo takes no `base_revision` and is never stale-checked.
`target: {type:"mine"}` means the connection's actor.
`target: {type:"human"}` selects the latest candidate whose actor is `gm` or
any character (characters are driven only from non-agent connections, §3);
the UI's Ctrl+Z uses it. `expect_index` works with it as with `mine`. With
`expect_index`, a different selected target (or none) is rejected
`{type:"undo_target_changed", expected, actual: number | null}`.

**Deduplication (D8).**

- `transact` and `invoke` share one store. The key is (`client.instance`,
  `txn_id`). The fingerprint is the canonical JSON (keys sorted) of the full
  `transact` params except `retry` (an empty `expect` dropped); for `invoke` it is the canonical JSON of
  `{method: "invoke", params}` with `params` except `retry`, so the method is
  part of the fingerprint and a `txn_id` reused across the two methods is
  "reused with different params".
- Committed and rejected results are stored, the last
  `max_txn_ids_per_client` (1,000) per instance, oldest evicted.
- Same key and fingerprint: the stored result is returned and nothing
  executes.
- Same key, different fingerprint:
  `{status:"rejected", rejection: {type:"invalid", message:"txn_id reused with different params"}}`.
- A `transact` or `invoke` with `retry: true` whose key is not retained
  (evicted, never received, or lost on restart) is answered with error
  `retry_unknown` and does not execute.
- The store is in memory and is lost on restart, which changes `session`.
  (Persistent deduplication is Later.)

**Client retries.**

- A client may resend a `transact` or `invoke` whose response was lost only
  after reconnecting to an authority with the same `session`, once, with the
  same `txn_id` and `retry: true`. A stored result is returned as usual.
- Once a write (`transact`, `invoke` or `undo`) has been written to a socket,
  every outcome not settled by a response is reported as error `uncertain`
  when safe recovery is exhausted: a response timeout; socket loss before the
  response (for `undo`, and for a `transact` or `invoke` without retry); loss
  of the single resend's response; `retry_unknown`; a `session` change before
  the resend; terminal `unauthorized` or `wrong_table`.
- The client never resends twice.
- For writes, `disconnected` is reserved for requests that were never written
  to a socket.

## 7. Views, values, redaction, covers, group views

Decisions: D11, D12, D13 (face-down, referenced), D14, D15; M4-D12; M5-D8, M5-D23, M5-D25.

### 7.1 Values

```ts
type RedactedValue = { type: "redacted" };
type WireValue = NumberValue | TextValue | BooleanValue | EmptyValue | DiceValue | RollValue | InkValue | ShapeValue
  | { type: "list"; items: WireValue[] } | { type: "ref"; object: ObjectId } | WireViewers | RedactedValue;
type WireViewers = { type: "viewers"; viewers: ("all" | "gm" | "owner" | { type: "ref"; object: ObjectId } | RedactedValue)[] };
type WireError = { type: "error"; code: ErrorCode; message?: string; origin?: { object: ObjectId; cell: string } };
type WireResult = WireValue | WireError;
```

### 7.2 Object views

```ts
type CellView = { value: WireResult; kind: "literal" | "formula" | "structural";
                  source?: string; overridden?: boolean; visibility?: WireViewers };
type ActionDefinitionView = { name: string; when?: string; steps?: string[] };   // ActionView: deprecated alias
type ActionStateView = { name: string; enabled: boolean; reason?: "when_false" | "when_error" };
type FaceElementView = FaceElement & { index: number; shown: boolean;
                       reason?: "show_when_false" | "show_when_error" | "no_action"; error?: ErrorCode };
type FaceView = { elements: FaceElementView[]; collapsed?: FaceElementView[]; default_action?: string };
type ObjectView = { id: ObjectId; is_template: boolean; is_character: boolean;
                    cells: Record<string, CellView>; actions: ActionDefinitionView[];
                    action_states: ActionStateView[];   // live object views only (M5-D23)
                    face?: FaceView;                    // M5-D8
                    absent_cell_visibility?: Record<string, WireViewers> };   // GM views only (M4-D12)
type BoardView = { id: BoardId; name?: string };
```

- `kind`: a cell whose stored content is a formula is `"formula"` (also for
  structural cells such as `position` or `visible_to`, and also when an
  override is present, which `overridden` reports). A cell with no stored
  content (field-backed, such as `tag`, `contents`, `board`, or a default) is
  `"structural"`. Every other cell (a stored literal, structural or not) is
  `"literal"`.
- GM view: every stored user cell plus every readable structural cell except
  `id`, defaults included (`STRUCTURAL_VIEW_CELLS`); `source` and `overridden`
  on formula cells; `visibility` when the object has a `cell_visibility` entry
  for that cell; actions with `when` and `steps`; and
  `absent_cell_visibility`, the object's per-cell visibility entries for cell
  names not in the view's `cells`, present whenever there is at least one
  (DESIGN.md §4.4: an entry is valid for an absent cell). Once a cell of that
  name is in `cells`, its entry is that cell's `visibility` instead.
- Character view: the object only when the viewer can effectively see it
  (DESIGN.md §4.4, cover included); a cell only when the viewer can see it; no
  `source`, no `visibility`, never `absent_cell_visibility`; actions with
  `name` only.
- `cells: "structural"` restricts a view to `STRUCTURAL_VIEW_CELLS`; a list
  restricts it to those names.
- `actions` are `ActionDefinitionView`s (the shape formerly called
  `ActionView`: `name`, and for the GM `when` and `steps`), the same type
  used in field effects and snapshots (§7.6). They never carry live state.
- `action_states` (M5-D23), for every viewer: one `ActionStateView` per
  action, in the order of `actions`, `enabled` as `explain_action` computes
  it (§9) and `reason` only when not enabled. It appears only in live object
  views (subscribe results, deltas, `get_objects`, `list_objects`, `zones`
  views), never in effects or snapshots. The authority always sends
  `action_states` in live object views; the wire schema treats it as
  optional per §12 (additive growth), and clients read a missing list as
  empty (M5-D25).
- `face` (M5-D8) is present when the view's `cells` is `"all"` and the object
  has a layout. Every element carries `index`, its position in the stored
  list, and `shown`. `show_when` is evaluated by the authority on the object
  with `this` = the object. The GM view keeps every stored element with its
  `show_when`: `shown` is true when `show_when` is absent or evaluates to
  `true` and, for a button, its action exists; otherwise `shown` is false
  with `reason` `show_when_false`, `show_when_error` (with its `error`
  code), or `no_action` for a button naming no action (`show_when` is
  checked first, so a hidden button with no action reports
  `show_when_false` or `show_when_error`). Character views keep
  only the elements that are shown and whose cell (for a value or editor
  element) they can read, without `show_when`, each keeping its stored
  `index`; `default_action` is kept only when it names an existing action.
- An element is visible to a viewer exactly when it is present in that
  viewer's view with `shown: true` (`faceElementVisible`; FIXTURES.md §7
  `face_element`).

### 7.3 Redaction

Character views only, everywhere a value appears:

- A ref to an object the viewer cannot see, or to an id that is neither a live
  object nor a board, becomes `{type:"redacted"}` in place, at any depth of
  lists and in viewers entries. Containers' `contents` therefore keep their
  count.
- A ref to a board id is kept (the `board` structural cell of a visible token
  keeps its board ref). Boards are not a visibility boundary (DESIGN.md §4.3).
- An error whose `origin` names an object or cell the viewer cannot see
  becomes `{type:"error", code}`.

### 7.4 Face-down

A face-down object shows, to a viewer who can see it, exactly the cells of
vtt-75c.10's `FACE_DOWN_EXEMPT` (`name`, `board`, `position`, `rotation`,
`z`, `container`, `face_up`, `shape`) beyond what its owner rule allows
(DESIGN.md §4.4). Per-cell visibility still applies.

### 7.5 Covers

```ts
type Cover = { key: string; board: BoardId;
               region: { position: [number, number]; rotation: number; shape: Shape } | { whole_board: true } };
```

For each board in scope, the zones directly on that board that are not
effectively visible to the viewer are classified by the table below. "Not
effectively visible" is M2's `isEffectivelyVisible(viewer, zone)` being false,
the predicate M2's cover oracle uses. `canSeeObject` is never used here, so a
zone under another opaque zone does not produce a cover of its own unless it
is itself not effectively visible. The table matches M2's cover oracle (after
vtt-75c.19) exactly, so drawn covers and object visibility agree.

| Zone state | M2 oracle | Presentation |
|---|---|---|
| geometry (`position`, `rotation`, `shape`) unreadable or invalid, any `opaque` | `undetermined` | `Cover` with `{whole_board: true}` |
| valid geometry, `shape` absent or empty | covers nothing | no `Cover` |
| valid geometry with a shape, `opaque` true, an error, or a non-boolean | `covering` when the anchor is inside | `Cover` with `{position, rotation, shape}` (`rotation` empty → 0) |
| valid geometry with a shape, `opaque` false | covers nothing | no `Cover` |

- A region `Cover` is produced only for a non-empty shape.
- `key` is stable per zone for the life of the authority process and does not
  contain the zone id. The zone itself and the objects it covers are absent
  from the viewer's views.
- GM views have no covers.
- Boards in scope: for a `board` scope, its board; for `all`, every board; for
  `objects`, every board one of its objects is on (a contained object counts
  on its outermost container's board); for `log`, none.

### 7.6 Group views

```ts
type GroupHeader = { index: number; revision: number; actor: Actor; kind: "edit" | "action" | "undo"; label: string | null };   // null only in character group views
type GroupView = GroupHeader & { base_revision: number; origin?: { object: ObjectId; action: string };
                 undoes?: number; undone: boolean; names: Record<ObjectId, string>; effects?: EffectView[] };
type CellStateView = { kind: "literal"; value: WireValue } | { kind: "formula"; source?: string; override?: WireValue };
type LocationView = { type: "board"; board: BoardId } | { type: "container"; container: ObjectId | null; index: number };
type ObjectSnapshotView = { id: ObjectId; is_template: boolean; is_zone: boolean; is_character: boolean;
  tag?: string[]; shape?: Shape | null; contents?: (ObjectId | null)[];
  cells: Record<string, CellStateView>; cell_visibility?: Record<string, WireViewers>; actions: ActionDefinitionView[];
  face?: FaceLayoutView | null };   // M5-D7
type FaceLayoutView = { elements: (FaceElement & { index: number })[]; collapsed?: (FaceElement & { index: number })[];
  default_action?: string };   // the stored layout with each element's index; no live `shown`
type EffectView =
  | { type: "cell"; object: ObjectId; cell: string; before: CellStateView | null; after: CellStateView | null; cause: "edit" | "roll"; added?: number }   // added: an add step's amount (M6-D22)
  | { type: "cell_visibility"; object: ObjectId; cell: string; before: WireViewers | null; after: WireViewers | null }
  | { type: "field"; object: ObjectId; field: "tag"; before: string[]; after: string[] }
  | { type: "field"; object: ObjectId; field: "shape"; before: Shape | null; after: Shape | null }
  | { type: "field"; object: ObjectId; field: "is_template" | "is_character"; before: boolean; after: boolean }
  | { type: "field"; object: ObjectId; field: "actions"; before: ActionDefinitionView[]; after: ActionDefinitionView[] }
  | { type: "field"; object: ObjectId; field: "face"; before: FaceLayoutView | null; after: FaceLayoutView | null }
  | { type: "place"; object: ObjectId; before: LocationView; after: LocationView }
  | { type: "create" | "remove"; location: LocationView; objects: ObjectSnapshotView[] }
  | { type: "reorder"; container: ObjectId; before: (ObjectId | null)[]; after: (ObjectId | null)[] }
  | { type: "board"; before: Board | null; after: Board | null }
  | { type: "allocate"; ids: ObjectId[]; seq_before: number; seq_after: number }
  | { type: "retire"; ids: ObjectId[] };
```

**GM group views:** the group's fields plus `undone`, with effects converted
losslessly: literal content → `{kind:"literal", value}`, formula content →
`{kind:"formula", source, override?}`, snapshots with every field, actions
with `when` and `steps`, faces losslessly (every element, `show_when` kept).
`FaceLayoutView` is the wire type of historical faces; `FaceLayout` stays the
storage and op type.

**Character group views** are filtered by visibility at the view's revision
(D15: current visibility, not historical). An object that does not exist at
that revision counts as invisible. Per effect variant:

| Variant | Kept for a character when | Reduced how |
|---|---|---|
| `cell` | the object is visible and the cell readable | no `source`; values redacted |
| `cell_visibility` | never (dropped) | — |
| `field` `tag`, `shape` | that cell is readable | — |
| `field` `is_template`, `is_character` | the object is visible | — |
| `field` `actions` | the object is visible | action names only |
| `field` `face` | the object is visible | no `show_when`; elements naming a cell the viewer cannot read omitted (the others keep their `index`) |
| `place` | the object is visible and its `board` and `container` cells readable | a container the viewer cannot see shown as `null` |
| `create`, `remove` | at least one of its objects is visible | `objects` limited to the visible ones, each with only readable cells, no `source`, no `cell_visibility`, actions names only, `face` reduced as for `field` `face`; `tag`, `shape`, `contents` omitted when unreadable; invisible `contents` ids as `null`; a hidden location container as `null` |
| `reorder` | the container is visible and its `contents` readable | invisible ids as `null` |
| `board` | always | — |
| `allocate`, `retire` | never (dropped) | — |

- Visibility is current (D15): a removed object is invisible, so its remove
  snapshot (and its face) is omitted from a character's group view until an
  undo restores the object, after which it appears filtered.
- `names` holds the names captured at commit: the objects the group touched
  and, when the actor is a character, that character (DESIGN §7, M6-D8).
  `names[id]` is present only when the viewer can see object `id` and read its
  `name` cell.
- `label` is kept only when every effect of the group other than
  `allocate`/`retire` is kept unreduced for the viewer: no effect dropped, and
  no cell, object, value or id omitted, nulled or redacted. Otherwise `label`
  is `null`, and clients show the group's `kind`.
- Commit-event headers go to connections (which have GM authority) and always
  carry the label.
- A character group view whose `names` and filtered effects are both empty is
  omitted (null). The decision is the same whether or not effects are
  requested. Otherwise its header is kept.

## 8. Subscriptions, commit events, ordering, reconnection

Decisions: D10, D22, D23; M6-D35.

**Scopes**, at a revision:

- `board`: every object directly on the board and, recursively, their
  contents.
- `objects`: the ids (with `subtree`, also their descendants).
- `all`: every live object.
- `log`: no objects; the window of the newest `max_log_window` (200) retained
  groups.

At most `max_subscriptions` per connection (beyond that, `busy`).
Subscription ids are opaque strings.

**Subscribe.** `subscribe` returns full views and covers (§7.5). For `log`,
`groups` is the window's group views newest first (character nulls omitted),
and `objects` and `covers` are empty.

**Events.**

```ts
{ type: "event"; event: "commit"; revision: number; group: GroupHeader; boards?: BoardView[]; deltas: SubscriptionDelta[] }
{ type: "event"; event: "save"; status: "saved" | "saved_not_durable" | "failed"; revision: number; message?: string }
type SubscriptionDelta = { subscription: string; objects: ObjectView[]; removed: ObjectId[];
  covers?: { upsert: Cover[]; removed: string[] }; groups_upserted?: GroupView[]; groups_removed?: number[];
  patches?: ObjectPatch[] };   // cell_patches connections only (M6-D35)
type ObjectPatch = { object: ObjectId; cells: Record<string, CellView | null> };
```

- One `commit` event per commit goes to every ready connection. `boards` (all
  boards) is present when the group has any `board` effect. `deltas` holds one
  entry per subscription of that connection whose views changed (`[]` when
  none).
- `objects` are the views whose content changed (whole views). `removed` are
  the ids that left scope, were removed, or became invisible. Covers are
  diffed by key.
- Cell patches (M6-D35). On a connection whose `hello` listed
  `cell_patches`, a changed object is sent in `patches` instead of `objects`
  exactly when the subscription already holds its view (sent and not since
  removed) and every field of the view other than `cells` (`is_template`,
  `is_character`, `actions`, `action_states`, `face`,
  `absent_cell_visibility`, and any later field) is unchanged, compared as
  canonical JSON. The patch names only the cells whose `CellView` changed,
  new or changed cells with their view and cells gone from the view as
  `null`. A created object, one entering scope or becoming visible, and one
  whose other fields changed are whole views in `objects`; `removed`,
  covers and log deltas are unchanged. `patches` is present only when
  non-empty. A client applies a patch by setting or deleting the named cells
  of its held view and nothing else. Which objects are re-viewed and which
  cells are evaluated is the same in both encodings. A connection without
  the capability gets the events above byte for byte.
- For `log`: `groups_upserted` are group views new to the window or changed
  (an undone group re-sent with `undone: true`; older groups whose filtered
  view changed after a reveal, hide or remove); `groups_removed` are indices
  that left the window or became omitted.
- Applying every delta to the initial result yields what a fresh `subscribe`
  at that revision returns.
- Board creation and removal (including by undo) are visibility-relevant for
  character subscriptions. In object views, a literal ref to a removed board
  or object evaluates to `#REF` (FORMULAS.md §2.4), and a `visible_to` holding
  one admits nobody; the holders' views are rebuilt on removal and again on
  restoration. Log-window group views holding refs to it are rebuilt too;
  there the ref is `redacted` while the board is gone and restored on undo,
  the group-view representation (§7.6).

**Evaluation** (FORMULAS.md §7). After each commit the authority evaluates
what the changed subscribed views need: their cells, those cells' transitive
dependencies, and the visibility and geometry inputs the views and covers
need, even outside the scope. Every other dirty cell stays dirty until read.
Each `when` and `show_when` a subscription view evaluates is a tracked
expression of the engine (FORMULAS.md §7, M6-D38): an object is re-viewed for
them only when the commit may have changed something one of them read (on
this or any other object), and objects whose actions or face changed
(including removal or undo) are re-viewed; views are still sent only when
they changed.

**Ordering (D22).**

- Per connection, one message is handled at a time, in arrival order: the
  next waits for the previous response.
- All methods but `save` are handled synchronously. `save` awaits file I/O
  while other connections proceed.
- Commit events are sent before the committing request's response.
- Every connection sees commit events in revision order.
- A `save` response follows its `save` event.

**Heartbeat.** A WebSocket ping every 15 s; two missed pongs terminate the
connection.

**Reconnection (D23).**

- There is no server-side resumption. The client reconnects with backoff,
  sends `hello` with the same `client.instance`, resubscribes every live
  subscription with its original params (the subscription id may change),
  replaces its mirrors, and reports a `resync` (`from_revision`,
  `to_revision`, `session_changed`).
- A resubscribe that fails for a transport reason (socket closed or timeout)
  keeps that subscription `recovering` (mirror kept, not updated); it is
  resubscribed on the next connection.
- A resubscribe answered with an error response (for example `not_found` for
  a board removed meanwhile) makes the subscription terminal: an `error`
  report with the server's `ProtocolError`, its mirror emptied, the
  subscription object (and an MCP handle) kept but no longer updated.
- The client becomes ready for ordinary callers only when every live
  subscription is resubscribed or terminal. Until then `connectionError()` is
  `{code: "disconnected", recovering: true}`.
- Pending queries fail `disconnected`; writes are settled per §6.
- Credentials are refreshed per §2.
- Every successful reconnect's `welcome.table.path` and `welcome.table.id`
  are compared with the identity captured at the first `welcome`, before any
  subscription is rebound or any write is retried. A mismatch is
  `wrong_table`: terminal with explicit credentials; with discovery, the
  client re-reads the session file and retries once with its credentials, and
  a second mismatch is terminal.

**Mirror revision.** On every processed commit event the client advances every
live mirror's `revision` to the event's revision, also for subscriptions with
no delta in it. After a processed commit, a mirror's revision equals the
client's revision.

## 9. Explain, evaluate, at_position, changes_since, document

Decisions: D16, D28, D29, D30; M5-D1.

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
  guard?: { source?: string; value: WireResult }; steps?: string[];   // guard present only when the action has a `when`
  when_parses?: boolean; when_syntax_error?: string;                   // GM only
  step_status?: ({ ok: true } | { ok: false; message: string; offset: number })[] };   // GM only
```

**`explain_cell`.**

- The cell's value first (forcing evaluation), then its recorded dependencies
  breadth first to `depth`, each cell expanded once, at most
  `max_explain_nodes` nodes (`truncated` when cut).
- `error_chain` follows error origins to a self-originating error or a
  repeat, at most 32 steps.
- `last_write` is the header of the newest retained group with a `cell`
  effect on that cell, as the viewer would see it in the log (§7.6: for a
  character, `label` is `null` unless every effect is visible unreduced). It
  is omitted when that group's view is omitted for the viewer.
- Character viewer: a dependency cell it cannot see is
  `{type:"cell", object, cell, hidden: true}` without value; a dependency on
  an object it cannot see has `object: null` and no value; no `source`; values
  redacted; error-chain entries on invisible objects or cells have
  `object: null` or `cell: null`.

**`explain_group`.** The group view with effects (§7.6) and, for the GM when
the origin object still exists, the origin action's current definition
(`current: true`).

**`explain_action`.**

- `enabled` (top level) is true iff the action has no `when`, or its `when`,
  evaluated with `this` = the object, is `true`.
- `reason` (top level, only when not enabled) is `when_false` (any non-error,
  non-true value) or `when_error`.
- `guard` is present only when there is a `when`, with its `value` and, for
  the GM, its `source`.
- `steps` are GM only.
- `when_parses`, `when_syntax_error` (the parser's message when `when` does
  not parse) and `step_status` (one entry per step, in order, from the step
  parser of FORMULAS.md §8.4, with the error's message and offset) are GM
  only.
- An action without `when` gives `{enabled: true}` with no `reason` and no
  `guard`, for every viewer.

**Not found.** A nonexistent object, cell, action or group, and one the viewer
cannot see (invisible object, unreadable cell, omitted group), answer the
identical error `{code:"not_found", message:"not found"}`.

**`evaluate` (D28).** GM only. `source.length` > `max_source_length` is
`bad_request`; an unknown `this` is `not_found`; without `this`, the engine's
ad hoc default applies.

**`at_position` (D29).**

- Candidates come from the spatial index at the point.
- `objects` are the non-zone objects directly on the board whose evaluated
  footprint contains the point (boundary inclusive; shapeless: anchor within
  epsilon), ascending `z` (empty = 0) then id. `zones` likewise. Both are
  filtered by the viewer's visibility. Contained objects are excluded.
- A candidate whose evaluated `position`, `rotation`, `shape` or `z` is an
  error (including `#LIMIT` from an exhausted budget) has no geometry and is
  omitted, as the spatial index treats non-finite bounds. The request never
  fails for this reason.

**`changes_since`.**

- Scans retained groups with `revision > params.revision`, oldest first, at
  most `limit` scanned, and returns the non-omitted group views among them,
  with effects.
- `more`: retained groups remain after the last scanned.
- `next_revision`: the `revision` of the last scanned group (its
  `base_revision` + 1), or the current revision when none was scanned. Passing
  `next_revision` back as `revision` continues after the scanned groups, so
  pages of only invisible groups still advance.
- `truncated`: `params.revision` < `floor` (§6; with no retained groups the
  floor is the current revision).
- `params.revision` above the current revision is `bad_request`.

**`document` (D30).** GM only: the canonical `Snapshot` and the retained log,
unfiltered. It has no MCP tool.

## 10. Errors, rejections, limits

Decisions: D21, D32; M5-D5, M5-D6.

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
  | { type: "invalid"; message: string }
  | { type: "when_false"; object: ObjectId; action: string }                                        // M5-D6
  | { type: "when_error"; object: ObjectId; action: string; code: ErrorCode; message?: string }
  | { type: "step_error"; object: ObjectId; action: string; step: number; code?: ErrorCode; message: string };
type ProtocolRejection = Rejection
  | { type: "stale_write"; base_revision: number; revision: number; floor: number; truncated: boolean;
      conflicts: { index: number; revision: number; actor: Actor; label: string; keys: string[] }[] }
  | { type: "undo_target_changed"; expected: number; actual: number | null };
type Limits = { max_message_bytes: 1048576; max_ops: 1000; max_page: 200; max_ids: 200; max_subscriptions: 16;
  max_explain_depth: 4; max_explain_nodes: 200; max_source_length: 10000; max_groups: 500; max_log_window: 200;
  max_txn_ids_per_client: 1000; max_requests_per_second: 200; max_buffered_bytes: 67108864;
  max_each_items: 1000; max_action_writes: 10000; max_face_elements: 200 };   // M5-D5
```

**Errors and rejections.**

- Errors are protocol failures: the request was not processed as a command.
  Rejections are command outcomes (`status: "rejected"`).
- Action refusals (M5-D6, FORMULAS.md §8.1): `when_false` and `when_error`
  (with the guard's code; `#SYNTAX` for an unparsable guard) come from the
  guard; `step_error` carries the 0-based step index, an optional code
  (`#SYNTAX` for an unparsable step, found before any step runs; `#LIMIT`
  past `max_each_items` or `max_action_writes`) and a message. A primitive's
  own refusal inside a step keeps its type (`protected_cell`,
  `containment_cycle`, `type_error`), and `invoke`'s result carries the step
  index alongside it.
- `disconnected`, `timeout`, `uncertain` and `wrong_table` are produced by the
  client library only. `disconnected` is the code for a request never written
  to a socket; a write already written to a socket never reports it (§6),
  while a query already sent whose socket drops also fails `disconnected`
  (§8). `timeout` is for queries only; a timed-out write is `uncertain`.
  A server error response carrying `disconnected` or `timeout` is a protocol
  violation: the client rejects that request with
  `{code: "internal", message, details: {type: "protocol", method}}` and the
  connection stays open.
- `retry_unknown` is produced by the authority (§6) and mapped to `uncertain`
  by the client.
- A response whose `result` fails the schema of the pending request's method
  rejects that request on the client with
  `{code: "internal", message, details: {type: "protocol", method}}`; the
  connection stays open and no mirror changes.
- An unparseable request is answered `bad_request` and the connection stays
  open. Any unexpected server exception is answered `internal` and the
  connection stays open.

**Limits (D21).**

| Limit | Value | Applies to |
|---|---|---|
| `max_message_bytes` | 1,048,576 (1 MiB) | client-to-server frames only; a larger frame closes the connection |
| `max_ops` | 1,000 | ops per `transact` |
| `max_page` | 200 | `limit` of `list_objects` and `log` |
| `max_ids` | 200 | `get_objects` ids and `objects` scope ids |
| `max_subscriptions` | 16 | subscriptions per connection (`busy` beyond) |
| `max_explain_depth` | 4 | `explain_cell` `depth` |
| `max_explain_nodes` | 200 | nodes in an `explain_cell` dependency tree |
| `max_source_length` | 10,000 | `evaluate` source length |
| `max_groups` | 500 | `changes_since` `limit` |
| `max_log_window` | 200 | groups in a `log` subscription window |
| `max_txn_ids_per_client` | 1,000 | deduplication entries per client instance |
| `max_requests_per_second` | 200 | requests per connection (token bucket); excess answered `busy` |
| `max_buffered_bytes` | 67,108,864 (64 MiB) | a connection's unsent buffer; beyond it the connection is closed 4429 |
| `max_each_items` | 1,000 | items one `each` step iterates (`step_error` `#LIMIT` beyond) |
| `max_action_writes` | 10,000 | primitive calls in one action invocation (`step_error` `#LIMIT` beyond) |
| `max_face_elements` | 200 | elements per face element list (`set_face` rejected `invalid` beyond) |

The `limits` the `welcome` message advertises (§2) carry every row of this
table, the three M5 rows (M5-D5) included.

Server-to-client messages have no size limit: the initial view of a
few-thousand-object table is one response (chunked delivery is Later).
Formula cost stays under the engine budget (FORMULAS.md §7).

## 11. MCP

Decisions: D1, D17, D18, D19; M4-D3; M5-D24; M6-D6; M6-D32.

`vtt-mcp` is a separate stdio process launched by the agent host. It attaches
to the running authority as a protocol client with `client.kind: "agent"`
(D1). The server's `initialize` result carries `instructions`
(`MCP_INSTRUCTIONS` in `packages/authority/src/mcp/instructions.ts`).

**Tools.** The request-surface server (`createMcpServer`) has 16 tools: the
15 query, explain and write tools below plus `invoke`. The composed `vtt-mcp`
process has 20: those 16 plus `subscribe`, `poll_changes`, `unsubscribe` and
`import_asset` (M5-D24; `collect_assets`, M6-D32).

| Tool | Behaviour |
|---|---|
| table_info | `{revision, boards, table /* {name, path, id} */, limits, actor, session}` from the client |
| list_objects, get_objects, evaluate, zones, at_position, changes_since, log | the same-named methods |
| explain_cell, explain_group, explain_action | the same-named methods |
| transact | `transact` with `base_revision` required and `expect` passed through; `txn_id` always generated by the MCP server; a lost response is retried per §6 within 10 s; `uncertain` is reported as an error |
| invoke | `{object, action, base_revision, label?, table?}` → `invoke`; `txn_id` always generated by the MCP server; a lost response is retried as for `transact`; a rejection is `isError: true` with the rejection and `step`; `uncertain` is reported as an error |
| undo | `undo` (targets `latest`, `mine`, `group`; `expect_index`) |
| save | `save` |
| collect_assets | `collect_assets` (`{delete?: boolean}` → `{unreferenced, deleted}`) |
| subscribe | `subscribe` (scopes `board`, `objects`, `all`; GM viewer); returns `{subscription: <handle>, revision, objects: <count>}` |
| poll_changes | `{subscription: <handle>, wait_ms?: 0..30000 (default 0)}` → `{subscription, revision, changes: ChangeRecord[], overflowed: boolean}`; returns and clears the buffer, waiting up to `wait_ms` for the first record |
| unsubscribe | `unsubscribe`; drops the buffer and the handle |
| import_asset | `{path: string, slug?: string}` → `{path}`: uploads a local image file with `POST /assets` (§1), below |

`invoke`'s tool arrives with the UI's buttons (D19); its description says
that actions are defined with `transact` `set_actions` and that `table` is
the board and point the agent wants the `table` destination to mean.
`document` has no tool (D30).

**Input schemas and results.**

- Input schemas are explicit MCP schemas derived from the protocol params
  schemas, strict (unknown keys are an MCP input error), with
  transport-managed fields removed (`transact` and `invoke`: no `actor`,
  `retry`, `txn_id`) and variants narrowed (`undo` target: `latest`, `mine`,
  `group`).
  An input that fails them reaches no handler and sends nothing to the
  authority.
- Results are `structuredContent` plus one JSON text block.
- A `ProtocolError` → `isError: true` with `{code, message}`.
- `status: "rejected"` → `isError: true` with the rejection and `op_index`
  (for `invoke`, `step`).

**`import_asset` (M4-D3).** The input schema is strict and is not derived
from a protocol method (asset upload is HTTP, §1). The MCP process reads the
local file at `path` (absolute, or relative to its working directory),
checks it with the rules of `POST /assets` (PNG, JPEG, WebP or GIF by magic
bytes, at most 50 MiB) before sending, and POSTs it to `/assets` at the
authority's HTTP origin (the connection's WebSocket URL with `http:`, same
host and port) with `Authorization: Bearer <token>` (the connection's current
credentials, also after a discovery refresh) and `X-Filename`/`X-Slug`. It
returns `{path}` as `structuredContent` plus a text block; the agent then
writes that path into an object's `image` cell with `transact` (DESIGN.md
§4.6, **Appearance cells**), which the tool description says. A missing or
unreadable file, an unsupported type, an oversize file, and HTTP 401, 409,
413 or 415 are `isError: true` with a message; the connection gate below
applies, and a gated call sends nothing.

**Handles.** `"m"` followed by a counter, owned by the MCP process. A handle
stays valid across reconnects while the protocol subscription id behind it
changes.

**Connection gate.** While the client reports a connection error
(`disconnected`, including `recovering: true` and the time before the first
`welcome`; `unauthorized`; or `wrong_table`), every tool, including
`table_info` and `poll_changes`, returns `isError: true` with that error
instead of its normal result.

**Change records.**

```ts
type ChangeRecord =
  | { type: "commit"; revision: number; group: GroupHeader; created: ObjectId[]; removed: ObjectId[];
      cells: { object: ObjectId; cell: string; before?: CellView; after?: CellView }[];
      objects: { object: ObjectId; before?: ObjectFacts; after?: ObjectFacts }[] }
  | { type: "resync"; from_revision: number; to_revision: number; session_changed: boolean }
  | { type: "failed"; code: ProtocolErrorCode; message: string };   // the subscription became terminal (§8)
type ObjectFacts = { is_template: boolean; is_character: boolean; actions: ActionDefinitionView[];
                     face?: FaceLayoutView | null };   // M5
```

- Per subscription, a buffer of at most 1,000 records. Beyond that the oldest
  is dropped and the next `poll_changes` result has `overflowed: true` (then
  reset).
- `objects` lists every object whose flags, actions or face differ between
  before and after.
- Each buffered record sends `notifications/resources/updated` for
  `vtt://subscriptions/<handle>`. Reading that resource returns
  `{subscription, revision, overflowed, failed: {code, message} | null, objects: ObjectView[] /* current mirror */, changes: ChangeRecord[]}`
  without clearing, so an agent recovers current state after an overflow by
  reading it.
- The `revision` of `poll_changes` results and of the resource is the
  mirror's revision (§8), which equals the client's current revision after a
  processed commit.
- A failed subscription's handle stays valid until `unsubscribe`. Its polls
  return the buffered records (ending with the `failed` record) and then empty
  results.

**Resources.** `vtt://docs/formulas`, `vtt://docs/design`,
`vtt://docs/protocol` (the docs' text), `vtt://schema/ops` (the JSON Schema of
`WireOp`, 20 kinds), `vtt://subscriptions/<handle>`.

**Tool descriptions** say: ids should be human-meaningful (DESIGN.md §5.3);
writes need the latest `revision`; one `transact` is one undoable group;
formulas and actions follow docs/FORMULAS.md.

**`vtt-mcp [--url u] [--token=t] [--name n]`.**

- Credentials: `--url`/`--token`, else `VTT_URL`/`VTT_TOKEN`, else the
  session file. Discovery mode is selected whenever no explicit credentials
  are given, even when the file is missing: the process stays up and connects
  once the file appears. Credentials are refreshed per §2 on every reconnect
  attempt, and `wrong_table` stops the client. Startup fails only for
  malformed or incomplete explicit credentials.
- `client.kind: "agent"`.
- Startup order: MCP initialization first; then `agent_name` = `--name`, else
  the MCP client's name, else `agent`; then the authority connection, with
  recovery from the start and without requiring an initial successful
  connection (tools answer `disconnected` until the first `welcome`).
- Stdio transport; logs go to stderr only.
- While the authority is unreachable, tools return `isError` `disconnected`
  and the client keeps reconnecting.

## 12. Additive extension

Decision: D32.

Protocol v1 grows only additively: new optional fields, new methods, new ops,
new event kinds. M6 added the undo target `{type:"human"}` this way (an
older authority refuses it as `bad_request`), the method and MCP tool
`collect_assets` (M6-D32; an older authority answers `unknown_method`), and
`hello.capabilities`, `welcome.capabilities` and `SubscriptionDelta.patches`
(M6-D35; an older authority refuses a `hello` with `capabilities` (4401), so
a client meant for one is constructed with `cellPatches: false`; a client
that does not ask never receives patches). M5 added `invoke` behaviour (its optional params `txn_id`,
`retry`, `actor`, `label`, `table` and `InvokeResult`), the MCP tool
`invoke`, the op `set_face` and `ObjectInit.face`, the `field: "face"`
effect and `ObjectSnapshotView.face` (`FaceLayoutView`),
`ObjectView.action_states` and `ObjectView.face`, the rejection variants
`when_false`, `when_error` and `step_error`, the limits `max_each_items`,
`max_action_writes` and `max_face_elements`, the GM-only parse status fields
of `explain_action`, and `ObjectFacts.face` this way; `ActionView` was
renamed `ActionDefinitionView` with the same wire shape. M4 added `create_object.id_base`,
`set_value.replace`, `ObjectView.absent_cell_visibility`, the HTTP routes of
§1 and the MCP tool `import_asset` this way. A change that breaks a v1 client
bumps `protocol`.

**Compatibility policy (D32).**

- The authority parses client messages strictly: unknown keys anywhere are
  `bad_request`, and `__proto__` is always rejected.
- Clients parse server messages forward-compatibly: unknown keys in any object
  are ignored (stripped); a message of unknown `type` or an event of unknown
  `event` kind is ignored with a warning; an unknown `EffectView` variant
  inside a group view is dropped with a warning. None of these closes the
  connection.
- `parseServerMessage` validates only the envelope (`welcome`, `response` with
  `id` and either `result` or `error`, `event`, `goodbye`). The client
  validates and normalizes a response's `result` against the result schema of
  the pending request's method, found by `id` (the wire carries no method on
  responses). Unknown keys inside results, views and effects are stripped at
  that stage, not by envelope parsing.
- An envelope that is malformed in a known shape (missing or mistyped
  required fields) is still invalid. A result that fails its method's schema
  fails only that request (§10).
- Because clients ignore unknown keys, a new field must never change the
  meaning of existing fields; such a change bumps `protocol`.
