/**
 * The UI's write side (vtt-3l6.21): writes, undo and save over vtt-3l6.4's
 * session, with their notices. DESIGN.md §7 Undo, §5.2; PROTOCOL.md §6, §10;
 * M4-D7; review r1 finding 1, r2 finding 3.
 *
 * - Every write carries the `baseRevision` its interaction began on, sent
 *   unchanged as `base_revision` through `transactWithRetry` (whose single
 *   resend after a lost response is the only retry); the session's latest
 *   revision is never substituted.
 * - A rejection is a notice (`describeRejection`); a `stale_write` is a
 *   sticky `stale` notice naming the conflicting groups' labels and actors;
 *   an unsettled write is a sticky `uncertain` notice. Nothing is retried or
 *   rebased: the mirror already shows the winner.
 * - Undo targets the session's own latest group (`mine`).
 * - Save results and `save` events are tracked as `{status, revision}`;
 *   `failed` and `saved_not_durable` events are notices, and so are the
 *   session's connection notices.
 */
import {
  type ProtocolError,
  ProtocolFailure,
  type ProtocolRejection,
  type SaveEvent,
  type TransactResult,
  transactWithRetry,
  type WireOp,
} from "@vtt/protocol";
import type { WriteOptions, WriteOutcome, WritePort } from "../interaction/contracts";
import { describeError, describeRejection } from "../values/rejections";
import { createNoticeStore, type NoticeStore } from "./notices";
import type { TableSession } from "./table-session";

/** How long a write waits for the connection to be ready again before its single resend. */
export const WRITE_RETRY_TIMEOUT_MS = 10_000;

/** A save in progress, or the latest save result or `save` event. */
export interface SaveStatus {
  readonly status: "saving" | SaveEvent["status"];
  /** The revision the save captured; null while saving or when the request itself failed. */
  readonly revision: number | null;
  readonly message?: string;
}

/** The session's save status, observable. */
export interface SaveTracker {
  /** Null until a save is requested or a `save` event arrives. */
  get(): SaveStatus | null;
  /** Adds a listener called after every change; returns its remover. */
  subscribe(listener: () => void): () => void;
}

// ---------------------------------------------------------------------------
// Per-session state

interface WriteState {
  notices: NoticeStore;
  save: SaveStatus | null;
  readonly saveListeners: Set<() => void>;
  readonly tracker: SaveTracker;
}

const states = new WeakMap<TableSession, WriteState>();

function stateOf(session: TableSession): WriteState {
  let state = states.get(session);
  if (state !== undefined) return state;
  const saveListeners = new Set<() => void>();
  const created: WriteState = {
    notices: createNoticeStore(),
    save: null,
    saveListeners,
    tracker: {
      get: () => created.save,
      subscribe(listener) {
        saveListeners.add(listener);
        return () => {
          saveListeners.delete(listener);
        };
      },
    },
  };
  state = created;
  states.set(session, created);
  session.onConnectionNotice((notice) => {
    created.notices.push({ level: "error", text: notice.message });
  });
  session.client.on("save", (event) => {
    setSave(created, {
      status: event.status,
      revision: event.revision,
      ...(event.message === undefined ? {} : { message: event.message }),
    });
    if (event.status === "failed") {
      created.notices.push({ level: "error", text: `Save failed: ${detail(event.message)}.` });
    } else if (event.status === "saved_not_durable") {
      created.notices.push({
        level: "warning",
        text: `Saved revision ${event.revision}, but not durably: ${detail(event.message)}.`,
      });
    }
  });
  return created;
}

const detail = (message: string | undefined) =>
  message === undefined || message.trim() === "" ? "no reason given" : stripPeriod(message.trim());

function stripPeriod(s: string): string {
  return s.endsWith(".") ? s.slice(0, -1) : s;
}

function setSave(state: WriteState, next: SaveStatus): void {
  const prev = state.save;
  if (
    prev !== null &&
    prev.status === next.status &&
    prev.revision === next.revision &&
    prev.message === next.message
  ) {
    return;
  }
  state.save = next;
  for (const listener of [...state.saveListeners]) {
    try {
      listener();
    } catch {
      // A throwing listener must not break the tracker.
    }
  }
}

/**
 * The session's notice store: the one bound with `bindNotices`, else one
 * created for the session (with the global timers). Connection notices and
 * save notices go to it.
 */
export function sessionNotices(session: TableSession): NoticeStore {
  return stateOf(session).notices;
}

/** Makes `store` the session's notice store (for example one with an injected clock). */
export function bindNotices(session: TableSession, store: NoticeStore): void {
  stateOf(session).notices = store;
}

/** The session's save status; tracking starts at the first call. */
export function sessionSaves(session: TableSession): SaveTracker {
  return stateOf(session).tracker;
}

// ---------------------------------------------------------------------------
// Outcomes

function toError(e: unknown): ProtocolError {
  return e instanceof ProtocolFailure ? e.error : { code: "internal", message: String(e) };
}

function pushRejection(session: TableSession, rejection: ProtocolRejection): void {
  const viewer = session.getSnapshot().viewer;
  const text = describeRejection(rejection, (id) => session.refLabel(viewer, id));
  const notices = stateOf(session).notices;
  if (rejection.type === "stale_write") notices.push({ level: "warning", kind: "stale", text });
  else notices.push({ level: "error", text });
}

/** What an unsettled write was: an edit (with its label, when given) or an undo. */
type Subject = { kind: "edit"; label?: string } | { kind: "undo" };

/** A write that ended without a result: `uncertain` once sent, else `failed`. */
function unsettled(session: TableSession, e: unknown, subject: Subject): WriteOutcome {
  const error = toError(e);
  const notices = stateOf(session).notices;
  const label = subject.kind === "edit" ? subject.label : undefined;
  if (error.code === "uncertain") {
    const text =
      subject.kind === "undo"
        ? "The undo may or may not have been applied."
        : label === undefined
          ? "The edit may or may not have been applied."
          : `The edit may or may not have been applied: ${label}`;
    notices.push({ level: "warning", kind: "uncertain", text });
    return { status: "uncertain", reason: describeError(error) };
  }
  const what =
    subject.kind === "undo" ? "The undo" : label === undefined ? "The edit" : `"${label}"`;
  notices.push({ level: "error", text: `${what} was not applied. ${describeError(error)}` });
  return { status: "failed", error };
}

// ---------------------------------------------------------------------------
// Public API

/** The session's `WritePort` (vtt-3l6.22): one transaction per call, never retried beyond `transactWithRetry`. */
export function createWritePort(session: TableSession): WritePort {
  return {
    async write(ops: WireOp[], opts: WriteOptions): Promise<WriteOutcome> {
      const label = opts.label;
      let result: TransactResult;
      try {
        result = await transactWithRetry(session.client, ops, {
          base_revision: opts.baseRevision,
          ...(label === undefined ? {} : { label }),
          retry: { timeoutMs: WRITE_RETRY_TIMEOUT_MS },
        });
      } catch (e) {
        return unsettled(
          session,
          e,
          label === undefined ? { kind: "edit" } : { kind: "edit", label },
        );
      }
      if (result.status === "rejected") pushRejection(session, result.rejection);
      return result;
    },
  };
}

/** The label of the group undone by the undo group at `index`, else `#<n>`. */
async function undoneLabel(session: TableSession, index: number): Promise<string> {
  let target: number | undefined;
  try {
    const own = await session.client.request("log", { before: index + 1, limit: 1 });
    const group = own.groups[0];
    if (group?.index === index) target = group.undoes;
    if (target === undefined) return "the last edit";
    const found = await session.client.request("log", { before: target + 1, limit: 1 });
    const undone = found.groups[0];
    if (undone?.index === target && undone.label) return undone.label;
  } catch {
    // Fall through to the index.
  }
  return target === undefined ? "the last edit" : `#${target}`;
}

/**
 * Undoes the latest group by the GM or any character (`target: {type:
 * "human"}`, M6-D2): a button pressed in view-as is undone, an agent's newer
 * work is not. Pushes "Undid: <label>" or the refusal (`nothing_to_undo`,
 * `undo_conflict`).
 */
export async function undo(session: TableSession): Promise<WriteOutcome> {
  let result: TransactResult;
  try {
    result = await session.client.request("undo", { target: { type: "human" } });
  } catch (e) {
    return unsettled(session, e, { kind: "undo" });
  }
  if (result.status === "rejected") {
    pushRejection(session, result.rejection);
  } else {
    const label = await undoneLabel(session, result.index);
    stateOf(session).notices.push({ level: "success", text: `Undid: ${label}` });
  }
  return result;
}

/**
 * Asks the authority to save. The status is `saving` until the result; a
 * `failed` or `saved_not_durable` result is a notice (from its `save`
 * event), and so is a request that fails without one.
 */
export async function save(session: TableSession): Promise<SaveStatus> {
  const state = stateOf(session);
  setSave(state, { status: "saving", revision: null });
  try {
    const result = await session.client.request("save", {});
    const status: SaveStatus = {
      status: result.status,
      revision: result.revision,
      ...(result.message === undefined ? {} : { message: result.message }),
    };
    setSave(state, status);
    return status;
  } catch (e) {
    const message = describeError(toError(e));
    const status: SaveStatus = { status: "failed", revision: null, message };
    setSave(state, status);
    state.notices.push({ level: "error", text: `Save failed: ${message}` });
    return status;
  }
}
