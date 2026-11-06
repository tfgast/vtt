/**
 * Command execution (PROTOCOL.md §3–§6; DESIGN.md §5.2, §7; M3-D6, D7, D8;
 * M5-D1): the transport-free `transact`, `undo` and `invoke`. A `transact` is structurally
 * validated, looked up for deduplication, validated against the document,
 * checked for stale writes, and run as one transaction (one group, one undo
 * unit) whose ops map one to one onto the M2 primitives, with batch-local
 * `$name` bindings.
 */
import {
  type InputCellContent,
  type InputValue,
  type InputViewers,
  type InvokeParams,
  LIMITS,
  type ObjRef,
  ProtocolFailure,
  type ProtocolRejection,
  type TransactParams,
  type UndoParams,
  type Destination as WireDestination,
  type InvokeResult as WireInvokeResult,
  type ObjectInit as WireObjectInit,
  type WireOp,
  type TransactResult as WireTransactResult,
} from "@vtt/protocol";
import {
  type Actor,
  type CellContent,
  isValidId,
  isValue,
  type ObjectId,
  type Rejection,
  type Value,
  type ViewersValue,
} from "@vtt/schema";
import type { DiceSource } from "../engine/dice";
import { transactWithDice } from "../engine/dice";
import { createExecutor, type Executor } from "../engine/invoke";
import { placementHandlers } from "../engine/steps-place";
import { coreHandlers } from "../engine/steps-value";
import type { Table } from "../engine/table";
import {
  addBoard,
  clearOverride,
  deleteCell,
  removeBoard,
  renameBoard,
  renameCell,
  reorder,
  replaceFormula,
  setActions,
  setCellVisibility,
  setCharacterFlag,
  setFormula,
  setShape,
  setTag,
  setTemplateFlag,
  writeValue,
} from "../store/edits";
import { touchedKeys } from "../store/effects";
import { setFace } from "../store/face";
import {
  createObject,
  type Destination,
  move,
  type ObjectInit,
  remove,
  spawn,
} from "../store/structural";
import { Rejected, type Transaction } from "../store/transaction";
import { findUndoTarget, type UndoSelector, undo } from "../store/undo";
import { historyFloor, StaleWriteError, staleConflicts } from "./conflicts";

// ---------------------------------------------------------------------------
// Context and deduplication cache

/** The kind of the connection a command came from (`hello` `client.kind`). */
export type CommandKind = "ui" | "agent" | "test";

/** What a command runs against and on behalf of. */
export interface CommandContext {
  table: Table;
  /** The connection's actor (PROTOCOL.md §3). */
  actor: Actor;
  kind: CommandKind;
  /** The connection's `hello` `client.instance`: the deduplication scope. */
  client: string;
  dice: DiceSource;
  txns: TxnCache;
  /** The action executor `invoke` runs; default {@link COMMAND_EXECUTOR}. */
  executor?: Executor;
}

/**
 * The executor every `invoke` runs unless its context names another: created
 * once, with the value steps and the placement steps (vtt-1xv.8, vtt-1xv.9).
 */
export const COMMAND_EXECUTOR: Executor = createExecutor({
  handlers: [...coreHandlers, ...placementHandlers],
});

/** A stored command outcome: a `transact` or an `invoke` result (one store, PROTOCOL.md §6). */
export type StoredResult = WireTransactResult | WireInvokeResult;

export type TxnLookup =
  | { type: "miss" }
  | { type: "hit"; result: StoredResult }
  | { type: "mismatch" };

interface TxnEntry {
  fingerprint: string;
  result: StoredResult;
}

/**
 * Deduplication entries (PROTOCOL.md §6, D8), keyed by (client instance,
 * `txn_id`): the last `perClient` entries of each client instance, in
 * insertion order, oldest evicted. Instances never share entries. In memory
 * only. Results are stored and returned as copies.
 */
export class TxnCache {
  readonly #perClient: number;
  readonly #clients = new Map<string, Map<string, TxnEntry>>();

  constructor(perClient: number = LIMITS.max_txn_ids_per_client) {
    if (!Number.isInteger(perClient) || perClient < 1) {
      throw new RangeError(`TxnCache: bad per-client limit ${perClient}`);
    }
    this.#perClient = perClient;
  }

  lookup(client: string, txnId: string, fingerprint: string): TxnLookup {
    const entry = this.#clients.get(client)?.get(txnId);
    if (entry === undefined) return { type: "miss" };
    if (entry.fingerprint !== fingerprint) return { type: "mismatch" };
    return { type: "hit", result: structuredClone(entry.result) };
  }

  store(client: string, txnId: string, fingerprint: string, result: StoredResult): void {
    let entries = this.#clients.get(client);
    if (entries === undefined) {
      entries = new Map();
      this.#clients.set(client, entries);
    }
    entries.delete(txnId);
    entries.set(txnId, { fingerprint, result: structuredClone(result) });
    for (const oldest of entries.keys()) {
      if (entries.size <= this.#perClient) break;
      entries.delete(oldest);
    }
  }
}

/** JSON with object keys sorted recursively (code-unit order); undefined members dropped. */
function sortedJson(v: unknown): string {
  if (Array.isArray(v))
    return `[${v.map((x) => (x === undefined ? "null" : sortedJson(x))).join(",")}]`;
  if (typeof v === "object" && v !== null) {
    const r = v as Record<string, unknown>;
    const keys = Object.keys(r)
      .filter((k) => r[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${sortedJson(r[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/**
 * The deduplication fingerprint: the canonical JSON of the params except
 * `retry` (§6), an empty `expect` dropped since it means the same as none.
 */
export function txnFingerprint(params: TransactParams): string {
  const { retry: _retry, expect, ...rest } = params;
  return sortedJson(expect === undefined || expect.length === 0 ? rest : { ...rest, expect });
}

/**
 * An `invoke`'s deduplication fingerprint: the canonical JSON of
 * `{method: "invoke", params}` with `params` except `retry` (§6), so a
 * `txn_id` reused across `transact` and `invoke` never matches.
 */
export function invokeFingerprint(params: InvokeParams): string {
  const { retry: _retry, ...rest } = params;
  return sortedJson({ method: "invoke", params: rest });
}

// ---------------------------------------------------------------------------
// Ops: references, bindings, declared keys, labels

const isBinding = (r: string): boolean => r.startsWith("$");

function badRequest(message: string): never {
  throw new ProtocolFailure("bad_request", message);
}

function invalid(message: string): never {
  throw new Rejected({ type: "invalid", message });
}

/** Every ObjRef inside an input value, at any depth. */
function valueRefs(v: InputValue, out: string[]): void {
  switch (v.type) {
    case "list":
      for (const i of v.items) valueRefs(i, out);
      return;
    case "ref":
      out.push(v.object);
      return;
    case "viewers":
      for (const e of v.viewers) if (typeof e !== "string") out.push(e.object);
      return;
    default:
      return;
  }
}

function contentRefs(c: InputCellContent, out: string[]): void {
  if (c.type !== "formula") valueRefs(c, out);
}

function destinationRefs(to: WireDestination, out: string[]): void {
  if (to.type === "container") out.push(to.container);
}

/** Every ObjRef an op uses: its id positions and the refs inside its input values. */
function opRefs(op: WireOp): string[] {
  const out: string[] = [];
  switch (op.type) {
    case "set_value":
      out.push(op.object);
      valueRefs(op.value, out);
      break;
    case "set_cell_visibility":
      out.push(op.object);
      if (op.viewers !== null) valueRefs(op.viewers, out);
      break;
    case "set_formula":
    case "clear_override":
    case "delete_cell":
    case "rename_cell":
    case "set_tag":
    case "set_shape":
    case "set_template_flag":
    case "set_character_flag":
    case "set_actions":
    case "set_face":
    case "remove":
      out.push(op.object);
      break;
    case "move":
      out.push(op.object);
      destinationRefs(op.to, out);
      break;
    case "reorder":
      out.push(op.container);
      break;
    case "add_board":
    case "rename_board":
    case "remove_board":
      break;
    case "create_object":
      destinationRefs(op.to, out);
      for (const c of Object.values(op.init?.cells ?? {})) contentRefs(c, out);
      for (const v of Object.values(op.init?.cell_visibility ?? {})) valueRefs(v, out);
      break;
    case "spawn":
      out.push(op.template);
      destinationRefs(op.to, out);
      for (const c of Object.values(op.cells ?? {})) contentRefs(c, out);
      break;
  }
  return out;
}

/** The bindings an op introduces, in order: `as`, then the values of `owned`. */
function opIntroductions(op: WireOp): string[] {
  if (op.type === "create_object") return op.as === undefined ? [] : [op.as];
  if (op.type === "spawn") {
    return [...(op.as === undefined ? [] : [op.as]), ...Object.values(op.owned ?? {})];
  }
  return [];
}

const cellKeyOf = (object: ObjRef, cell: string): string[] =>
  isBinding(object) ? [] : [`cell:${object}/${cell}`];

const destinationKey = (to: WireDestination): string[] =>
  to.type === "board" ? [`board:${to.board}`] : cellKeyOf(to.container, "contents");

/**
 * The intended-write keys of an op (PROTOCOL.md §5 table), computed from its
 * fields before execution. A key naming a `$binding` is omitted.
 */
export function declaredKeys(op: WireOp): string[] {
  switch (op.type) {
    case "set_value":
    case "set_formula":
    case "clear_override":
    case "delete_cell":
    case "set_cell_visibility":
      return cellKeyOf(op.object, op.cell);
    case "rename_cell":
      return [...cellKeyOf(op.object, op.from), ...cellKeyOf(op.object, op.to)];
    case "set_tag":
      return cellKeyOf(op.object, "tag");
    case "set_shape":
      return cellKeyOf(op.object, "shape");
    case "set_template_flag":
      return cellKeyOf(op.object, "is_template");
    case "set_character_flag":
      return cellKeyOf(op.object, "is_character");
    case "set_actions":
      return isBinding(op.object) ? [] : [`actions:${op.object}`];
    case "set_face":
      return isBinding(op.object) ? [] : [`face:${op.object}`];
    case "reorder":
      return cellKeyOf(op.container, "contents");
    case "add_board":
    case "rename_board":
    case "remove_board":
      return [`board:${op.id}`];
    case "create_object":
      return [...(op.id === undefined ? [] : [`obj:${op.id}`]), ...destinationKey(op.to)];
    case "spawn":
      return [...(isBinding(op.template) ? [] : [`obj:${op.template}`]), ...destinationKey(op.to)];
    case "move":
      return [
        ...cellKeyOf(op.object, "board"),
        ...cellKeyOf(op.object, "position"),
        ...destinationKey(op.to),
      ];
    case "remove":
      return isBinding(op.object) ? [] : [`obj:${op.object}`];
  }
}

/** An op's target, for its default label. */
function opTarget(op: WireOp): string | undefined {
  switch (op.type) {
    case "set_value":
    case "set_formula":
    case "clear_override":
    case "delete_cell":
    case "set_cell_visibility":
      return `${op.object}.${op.cell}`;
    case "rename_cell":
      return `${op.object}.${op.from}`;
    case "set_tag":
    case "set_shape":
    case "set_template_flag":
    case "set_character_flag":
    case "set_actions":
    case "set_face":
    case "move":
    case "remove":
      return op.object;
    case "reorder":
      return op.container;
    case "add_board":
    case "rename_board":
    case "remove_board":
      return op.id;
    case "create_object":
      return op.id;
    case "spawn":
      return op.template;
  }
}

/**
 * The default label (PROTOCOL.md §5): for a single op its type and target
 * (`"set_value goblin1.hp"`), otherwise `"<n> edits"`. A `create_object`
 * without an `id` has no target known before execution and is labelled by
 * its type alone.
 */
export function defaultLabel(ops: readonly WireOp[]): string {
  const [only] = ops;
  if (ops.length !== 1 || only === undefined) return `${ops.length} edits`;
  const target = opTarget(only);
  return target === undefined ? only.type : `${only.type} ${target}`;
}

// ---------------------------------------------------------------------------
// Validation

/**
 * Structural validation, independent of the document (PROTOCOL.md §6 step
 * 1): `retry` only with `txn_id`; `label` at most 200 characters; `actor`
 * only on a non-agent connection, as `{type:"character", id}`; every
 * binding introduced at most once and used only in a later op; `owned` keys
 * plain ids. Throws `ProtocolFailure("bad_request")`. Schema shape, `txn_id`
 * shape and op count are the params schema's.
 */
export function validateOpsStatic(params: TransactParams, kind: CommandKind): void {
  validateCommandStatic(params, kind);
  const introduced = new Set<string>();
  params.ops.forEach((op, i) => {
    for (const r of opRefs(op)) {
      if (isBinding(r) && !introduced.has(r)) {
        badRequest(`op ${i} uses ${r} before it is introduced`);
      }
    }
    if (op.type === "spawn") {
      for (const id of Object.keys(op.owned ?? {})) {
        if (!isValidId(id)) badRequest(`op ${i}: owned key "${id}" is not a plain id`);
      }
    }
    for (const name of opIntroductions(op)) {
      if (introduced.has(name)) badRequest(`op ${i} introduces ${name} again`);
      introduced.add(name);
    }
  });
}

/** The fields `transact` and `invoke` share, for their common checks. */
interface CommandFields {
  base_revision: number;
  txn_id?: string;
  retry?: true;
  label?: string;
  actor?: { type: "character"; id: ObjectId };
}

/**
 * The structural checks `transact` and `invoke` share (PROTOCOL.md §6 step
 * 1): `retry` only with `txn_id`, `label` at most 200 characters, `actor`
 * only on a non-agent connection, as `{type:"character", id}`.
 */
function validateCommandStatic(params: CommandFields, kind: CommandKind): void {
  if (params.retry !== undefined && params.txn_id === undefined) {
    badRequest("retry requires txn_id");
  }
  if (params.label !== undefined && params.label.length > 200) {
    badRequest("label is longer than 200 characters");
  }
  if (params.actor !== undefined) {
    if (kind === "agent") badRequest("an agent connection cannot pass actor");
    const a = params.actor as Record<string, unknown>;
    const keys = Object.keys(a);
    if (
      a.type !== "character" ||
      typeof a.id !== "string" ||
      !isValidId(a.id) ||
      keys.length !== 2 ||
      !keys.includes("id")
    ) {
      badRequest('actor must be {type: "character", id}');
    }
  }
}

/**
 * State validation (PROTOCOL.md §6 step 2b), after a deduplication miss:
 * `base_revision` an integer within 0..current, and `actor`, when given, an
 * existing object whose `is_character` is true. Throws
 * `ProtocolFailure("bad_request")`.
 */
export function validateAgainstDocument(
  table: Table,
  params: Pick<CommandFields, "base_revision" | "actor">,
): void {
  const base = params.base_revision;
  const current = table.store.revision;
  if (!Number.isInteger(base) || base < 0 || base > current) {
    badRequest(`base_revision ${base} is not within 0..${current}`);
  }
  if (params.actor !== undefined) {
    const o = table.store.getObject(params.actor.id);
    if (o === undefined || !o.is_character) {
      badRequest(`actor "${params.actor.id}" is not a character`);
    }
  }
}

// ---------------------------------------------------------------------------
// Execution

/** The bindings of one `transact`, in introduction order. */
class Bindings {
  readonly #ids = new Map<string, ObjectId>();

  bind(name: string, id: ObjectId): void {
    this.#ids.set(name, id);
  }

  /** The real id for a reference. */
  id(r: ObjRef): ObjectId {
    if (!isBinding(r)) return r;
    return this.#ids.get(r) ?? invalid(`${r} is not bound`);
  }

  record(): Record<string, ObjectId> {
    return Object.fromEntries(this.#ids);
  }
}

function resolveValue(v: InputValue, b: Bindings): unknown {
  switch (v.type) {
    case "list":
      return { type: "list", items: v.items.map((i) => resolveValue(i, b)) };
    case "ref":
      return { type: "ref", object: b.id(v.object) };
    case "viewers":
      return resolveViewers(v, b);
    default:
      return structuredClone(v);
  }
}

function resolveViewers(v: InputViewers, b: Bindings): unknown {
  return {
    type: "viewers",
    viewers: v.viewers.map((e) =>
      typeof e === "string" ? e : { type: "ref", object: b.id(e.object) },
    ),
  };
}

/** An input value with its bindings replaced, re-checked as a storable value. */
function value(v: InputValue, b: Bindings): Value {
  const r = resolveValue(v, b);
  if (!isValue(r)) invalid("not a storable value");
  return r;
}

function viewers(v: InputViewers, b: Bindings): ViewersValue {
  const r = resolveViewers(v, b);
  if (!isValue(r) || r.type !== "viewers") invalid("not a viewers value");
  return r;
}

function content(c: InputCellContent, b: Bindings): CellContent {
  return c.type === "formula" ? { type: "formula", source: c.source } : value(c, b);
}

function destination(to: WireDestination, b: Bindings): Destination {
  if (to.type === "board") {
    return { type: "board", board: to.board, position: [to.position[0], to.position[1]] };
  }
  const container = b.id(to.container);
  return to.index === undefined
    ? { type: "container", container }
    : { type: "container", container, index: to.index };
}

function objectInit(init: WireObjectInit | undefined, b: Bindings): ObjectInit {
  const out: ObjectInit = {};
  if (init === undefined) return out;
  if (init.is_template !== undefined) out.is_template = init.is_template;
  if (init.is_zone !== undefined) out.is_zone = init.is_zone;
  if (init.is_character !== undefined) out.is_character = init.is_character;
  if (init.tag !== undefined) out.tag = [...init.tag];
  if (init.shape !== undefined) out.shape = structuredClone(init.shape);
  if (init.actions !== undefined) out.actions = structuredClone(init.actions);
  if (init.face !== undefined) out.face = structuredClone(init.face);
  if (init.cells !== undefined) {
    out.cells = Object.fromEntries(
      Object.entries(init.cells).map(([k, c]) => [k, { content: content(c, b) }]),
    );
  }
  if (init.cell_visibility !== undefined) {
    out.cell_visibility = Object.fromEntries(
      Object.entries(init.cell_visibility).map(([k, v]) => [k, viewers(v, b)]),
    );
  }
  return out;
}

type Committed = Extract<WireTransactResult, { status: "committed" }>;

/** What a running `transact` collects for its result. */
interface RunState {
  bindings: Bindings;
  created: Committed["created"];
  copies: Committed["copies"];
}

/** Runs op `i` through its M2 primitive. */
function runOp(tx: Transaction, op: WireOp, i: number, s: RunState): void {
  const b = s.bindings;
  switch (op.type) {
    case "set_value":
      if (op.replace === true) replaceFormula(tx, b.id(op.object), op.cell, value(op.value, b));
      else writeValue(tx, b.id(op.object), op.cell, value(op.value, b));
      return;
    case "set_formula":
      setFormula(tx, b.id(op.object), op.cell, op.source);
      return;
    case "clear_override":
      clearOverride(tx, b.id(op.object), op.cell);
      return;
    case "delete_cell":
      deleteCell(tx, b.id(op.object), op.cell);
      return;
    case "rename_cell":
      renameCell(tx, b.id(op.object), op.from, op.to);
      return;
    case "set_cell_visibility":
      setCellVisibility(
        tx,
        b.id(op.object),
        op.cell,
        op.viewers === null ? null : viewers(op.viewers, b),
      );
      return;
    case "set_tag":
      setTag(tx, b.id(op.object), [...op.tags]);
      return;
    case "set_shape":
      setShape(tx, b.id(op.object), op.shape === null ? null : structuredClone(op.shape));
      return;
    case "set_template_flag":
      setTemplateFlag(tx, b.id(op.object), op.value);
      return;
    case "set_character_flag":
      setCharacterFlag(tx, b.id(op.object), op.value);
      return;
    case "set_actions":
      setActions(tx, b.id(op.object), structuredClone(op.actions));
      return;
    case "set_face":
      setFace(tx, b.id(op.object), op.face === null ? null : structuredClone(op.face));
      return;
    case "reorder":
      reorder(tx, b.id(op.container), [...op.permutation]);
      return;
    case "add_board":
      addBoard(tx, op.id, op.name);
      return;
    case "rename_board":
      renameBoard(tx, op.id, op.name);
      return;
    case "remove_board":
      removeBoard(tx, op.id);
      return;
    case "create_object": {
      const init = objectInit(op.init, b);
      const id = createObject(tx, init, destination(op.to, b), op.id, op.id_base);
      s.created.push({ op_index: i, id });
      if (op.as !== undefined) b.bind(op.as, id);
      return;
    }
    case "spawn": {
      const template = b.id(op.template);
      const cells: Record<string, CellContent> = {};
      for (const [k, c] of Object.entries(op.cells ?? {})) cells[k] = content(c, b);
      const r = spawn(tx, template, destination(op.to, b), cells);
      s.copies.push({ op_index: i, root: r.root, copies: Object.fromEntries(r.copies) });
      if (op.as !== undefined) b.bind(op.as, r.root);
      for (const [original, name] of Object.entries(op.owned ?? {})) {
        const copy =
          r.copies.get(original) ?? invalid(`"${original}" is not in the subtree of "${template}"`);
        b.bind(name, copy);
      }
      return;
    }
    case "move":
      move(tx, b.id(op.object), destination(op.to, b));
      return;
    case "remove":
      remove(tx, b.id(op.object));
      return;
  }
}

const rejected = (
  rejection: ProtocolRejection | Rejection,
  opIndex?: number,
): WireTransactResult =>
  opIndex === undefined
    ? { status: "rejected", rejection: rejection as ProtocolRejection }
    : { status: "rejected", rejection: rejection as ProtocolRejection, op_index: opIndex };

const union = (keys: Iterable<string>): string[] => [...new Set(keys)];

/** The key an `expect` entry checks (PROTOCOL.md §6 step 4b; M6-D31). */
const expectKey = (e: { object: ObjectId; cell: string }): string => `cell:${e.object}/${e.cell}`;

/** PROTOCOL.md §6 steps 3–7, after validation and a deduplication miss. */
function execute(ctx: CommandContext, params: TransactParams): WireTransactResult {
  const store = ctx.table.store;
  const base = params.base_revision;
  const current = store.revision;
  const floor = historyFloor(store.history, current);
  if (base < floor) {
    return rejected({
      type: "stale_write",
      base_revision: base,
      revision: current,
      floor,
      truncated: true,
      conflicts: [],
    });
  }
  const stale = base < current;
  const expected = params.expect ?? [];
  if (stale) {
    const declared = staleConflicts(
      store.history,
      base,
      union([...params.ops.flatMap(declaredKeys), ...expected.map(expectKey)]),
    );
    if (declared !== null) return rejected(declared);
  }
  // After the stale check, so an object removed since `base_revision` is `stale_write`.
  const unknown = expected.find((e) => store.getObject(e.object) === undefined);
  if (unknown !== undefined) {
    return rejected({
      type: "invalid",
      message: `expect names unknown object "${unknown.object}"`,
    });
  }

  const s: RunState = { bindings: new Bindings(), created: [], copies: [] };
  let failedOp: number | undefined;
  const actor: Actor = params.actor ?? ctx.actor;
  const label = params.label ?? defaultLabel(params.ops);
  try {
    const result = transactWithDice(ctx.table, actor, { kind: "edit", label }, ctx.dice, (tx) => {
      params.ops.forEach((op, i) => {
        try {
          runOp(tx, op, i, s);
        } catch (err) {
          if (err instanceof Rejected) failedOp = i;
          throw err;
        }
      });
      if (stale) {
        const touched = union(tx.effects().flatMap(touchedKeys));
        const conflict = staleConflicts(store.history, base, touched);
        if (conflict !== null) throw new StaleWriteError(conflict);
      }
    });
    if (!result.ok) return rejected(result.rejection, failedOp);
    return {
      status: "committed",
      revision: result.group.revision,
      index: result.group.index,
      created: s.created,
      copies: s.copies,
      bindings: s.bindings.record(),
    };
  } catch (err) {
    if (err instanceof StaleWriteError) return rejected(err.rejection);
    throw err;
  }
}

const REUSED = "txn_id reused with different params";

/**
 * Executes a `transact` (PROTOCOL.md §6). Protocol failures (`bad_request`,
 * `retry_unknown`) throw `ProtocolFailure`; command outcomes are returned,
 * committed or rejected; any other error propagates unchanged. With a
 * `txn_id`, committed and rejected results are stored in `ctx.txns`.
 */
export function executeTransact(ctx: CommandContext, params: TransactParams): WireTransactResult {
  validateOpsStatic(params, ctx.kind);
  const txnId = params.txn_id;
  const fingerprint = txnId === undefined ? undefined : txnFingerprint(params);
  if (txnId !== undefined && fingerprint !== undefined) {
    const found = ctx.txns.lookup(ctx.client, txnId, fingerprint);
    // A transact fingerprint never equals an invoke one (§6), so a hit is a transact result.
    if (found.type === "hit") return found.result as WireTransactResult;
    if (found.type === "mismatch") return rejected({ type: "invalid", message: REUSED });
    if (params.retry === true) {
      throw new ProtocolFailure("retry_unknown", `txn_id "${txnId}" is not retained`);
    }
  }
  validateAgainstDocument(ctx.table, params);
  const result = execute(ctx, params);
  if (txnId !== undefined && fingerprint !== undefined) {
    ctx.txns.store(ctx.client, txnId, fingerprint, result);
  }
  return result;
}

/**
 * Executes an `undo` (PROTOCOL.md §6) as `ctx.actor`. `mine` selects the
 * connection's actor's latest candidate; `human` (M6-D2), the latest by `gm`
 * or any character, goes to the store unchanged for every connection kind.
 * With `expect_index`, a different selected target, or none, is refused
 * `undo_target_changed`. Never
 * stale-checked. `label`, at most 200 characters (else `bad_request`),
 * labels the undo group; without it the store's default applies.
 */
export function executeUndo(ctx: CommandContext, params: UndoParams): WireTransactResult {
  if (params.label !== undefined && params.label.length > 200) {
    badRequest("label is longer than 200 characters");
  }
  const store = ctx.table.store;
  const selector: UndoSelector =
    params.target.type === "mine" ? { type: "actor", actor: ctx.actor } : params.target;
  if (params.expect_index !== undefined) {
    let actual: number | null;
    try {
      actual = findUndoTarget(store.history, selector).index;
    } catch (err) {
      if (!(err instanceof Rejected)) throw err;
      actual = null;
    }
    if (actual !== params.expect_index) {
      return rejected({ type: "undo_target_changed", expected: params.expect_index, actual });
    }
  }
  const result = undo(store, ctx.actor, selector, { label: params.label });
  if (!result.ok) return rejected(result.rejection);
  return {
    status: "committed",
    revision: result.group.revision,
    index: result.group.index,
    created: [],
    copies: [],
    bindings: {},
  };
}

// ---------------------------------------------------------------------------
// invoke

const invokeRejected = (
  rejection: ProtocolRejection | Rejection,
  step?: number,
): WireInvokeResult =>
  step === undefined
    ? { status: "rejected", rejection: rejection as ProtocolRejection }
    : { status: "rejected", rejection: rejection as ProtocolRejection, step };

/**
 * PROTOCOL.md §6's `invoke` order after validation and a deduplication miss:
 * floor, declared keys `obj:<object>` and `actions:<object>` against the
 * groups after `base_revision`, then one transaction the command opens
 * itself, inside which the executor's `runAction` runs the action (its
 * `when` at the current revision) and, when `base_revision` < current, the
 * touched keys of its effects are checked. A refusal or a stale write throws
 * inside the transaction function, so nothing commits, no listener runs and
 * the dice source is reset.
 */
function executeInvokeChecked(ctx: CommandContext, params: InvokeParams): WireInvokeResult {
  const store = ctx.table.store;
  const base = params.base_revision;
  const current = store.revision;
  const floor = historyFloor(store.history, current);
  if (base < floor) {
    return invokeRejected({
      type: "stale_write",
      base_revision: base,
      revision: current,
      floor,
      truncated: true,
      conflicts: [],
    });
  }
  const stale = base < current;
  if (stale) {
    const declared = staleConflicts(store.history, base, [
      `obj:${params.object}`,
      `actions:${params.object}`,
    ]);
    if (declared !== null) return invokeRejected(declared);
  }

  const executor = ctx.executor ?? COMMAND_EXECUTOR;
  const { object, action } = params;
  const actor: Actor = params.actor ?? ctx.actor;
  const label = params.label ?? action;
  let step: number | undefined;
  let created: ObjectId[] = [];
  try {
    const result = transactWithDice(
      ctx.table,
      actor,
      { kind: "action", label, origin: { object, action } },
      ctx.dice,
      (tx) => {
        const outcome = executor.runAction(
          tx,
          { table: ctx.table, dice: ctx.dice },
          params.table === undefined
            ? { object, action }
            : {
                object,
                action,
                tableDestination: {
                  board: params.table.board,
                  position: [params.table.position[0], params.table.position[1]],
                },
              },
        );
        if (!outcome.ok) {
          step = outcome.step;
          throw new Rejected(outcome.rejection);
        }
        created = outcome.created;
        if (stale) {
          const touched = union(tx.effects().flatMap(touchedKeys));
          const conflict = staleConflicts(store.history, base, touched);
          if (conflict !== null) throw new StaleWriteError(conflict);
        }
      },
    );
    if (!result.ok) return invokeRejected(result.rejection, step);
    return {
      status: "committed",
      revision: result.group.revision,
      index: result.group.index,
      created,
    };
  } catch (err) {
    if (err instanceof StaleWriteError) return invokeRejected(err.rejection);
    throw err;
  }
}

/**
 * Executes an `invoke` (PROTOCOL.md §4, §6; M5-D1) in §6's order:
 * structural validation, deduplication (the store shared with `transact`,
 * keyed by client instance and `txn_id`, fingerprinted by
 * {@link invokeFingerprint}), state validation, floor, declared keys, then
 * the action in one transaction. Protocol failures (`bad_request`,
 * `retry_unknown`) throw `ProtocolFailure`; command outcomes are returned
 * and, with a `txn_id`, stored. An unknown object or action is rejected
 * `invalid`; an object removed since `base_revision` is `stale_write`.
 */
export function executeInvoke(ctx: CommandContext, params: InvokeParams): WireInvokeResult {
  validateCommandStatic(params, ctx.kind);
  const txnId = params.txn_id;
  const fingerprint = txnId === undefined ? undefined : invokeFingerprint(params);
  if (txnId !== undefined && fingerprint !== undefined) {
    const found = ctx.txns.lookup(ctx.client, txnId, fingerprint);
    // The fingerprint names the method, so a hit is an invoke result.
    if (found.type === "hit") return found.result as WireInvokeResult;
    if (found.type === "mismatch") return invokeRejected({ type: "invalid", message: REUSED });
    if (params.retry === true) {
      throw new ProtocolFailure("retry_unknown", `txn_id "${txnId}" is not retained`);
    }
  }
  validateAgainstDocument(ctx.table, params);
  const result = executeInvokeChecked(ctx, params);
  if (txnId !== undefined && fingerprint !== undefined) {
    ctx.txns.store(ctx.client, txnId, fingerprint, result);
  }
  return result;
}
