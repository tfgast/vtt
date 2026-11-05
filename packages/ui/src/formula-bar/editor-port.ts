/**
 * The in-place editor's port and the formula bar's focus requests
 * (vtt-3l6.13; DESIGN.md §4.6 Edit in place, The formula bar; §7 Platform).
 *
 * Both are channels keyed by the `UiStore` they belong to, so the runtime's
 * `EditorPort` (`createInPlaceEditorPort(ui)`), the `<InPlaceEditor>` in the
 * board canvas's overlay and the `<FormulaBar>` meet through the store they
 * are all given, with no extra wiring:
 *
 * - `open` records the request (with a fresh `seq`); `close` clears it. The
 *   in-place editor decides whether a request opens (DESIGN §4.6, §4.4) and
 *   ends it with `endInPlaceEdit` when it closes or refuses.
 * - `requestFormulaBarFocus(ui, cell)` focuses `cell` in the store and asks
 *   the formula bar to take keyboard focus (a formula target of the in-place
 *   editor, or the inspector's "Edit formula").
 */

import type { EditorOpenRequest, EditorPort } from "../interaction/runtime";
import type { CellAddress, UiStore } from "../state/ui-state";

/** An `open` request as the in-place editor sees it; `seq` increases with every `open`. */
export interface InPlaceEditRequest extends EditorOpenRequest {
  readonly seq: number;
}

interface Channel {
  request: InPlaceEditRequest | null;
  seq: number;
  readonly listeners: Set<() => void>;
  readonly focusListeners: Set<(cell: CellAddress) => void>;
}

const channels = new WeakMap<UiStore, Channel>();

function channelOf(store: UiStore): Channel {
  let channel = channels.get(store);
  if (channel === undefined) {
    channel = { request: null, seq: 0, listeners: new Set(), focusListeners: new Set() };
    channels.set(store, channel);
  }
  return channel;
}

function notify<T extends unknown[]>(listeners: Iterable<(...args: T) => void>, ...args: T): void {
  for (const listener of [...listeners]) {
    try {
      listener(...args);
    } catch {
      // A throwing listener must not break the channel.
    }
  }
}

function setRequest(channel: Channel, request: InPlaceEditRequest | null): void {
  if (channel.request === request) return;
  channel.request = request;
  notify(channel.listeners);
}

/**
 * vtt-3l6.23's `EditorPort` over `store`: `open` replaces any open request
 * (an open editor is dropped without committing; a click elsewhere has
 * already committed it by blurring), `close` ends it without committing.
 */
export function createInPlaceEditorPort(store: UiStore): EditorPort {
  const channel = channelOf(store);
  return {
    open(request) {
      channel.seq += 1;
      setRequest(channel, {
        stamp: { ...request.stamp },
        object: request.object,
        ...(request.cell === undefined ? {} : { cell: request.cell }),
        ...(request.rect === undefined ? {} : { rect: { ...request.rect } }),
        seq: channel.seq,
      });
    },
    close() {
      setRequest(channel, null);
    },
  };
}

/** The current in-place edit request of `store`, or null. */
export function inPlaceEditRequest(store: UiStore): InPlaceEditRequest | null {
  return channelOf(store).request;
}

/** Adds a listener called when the request changes; returns its remover. */
export function subscribeInPlaceEdit(store: UiStore, listener: () => void): () => void {
  const { listeners } = channelOf(store);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Ends request `seq` if it is still the current one (the editor closed or refused it). */
export function endInPlaceEdit(store: UiStore, seq: number): void {
  const channel = channelOf(store);
  if (channel.request?.seq === seq) setRequest(channel, null);
}

/** Focuses `cell` (`store.focusCell`) and asks the formula bar of `store` to take keyboard focus. */
export function requestFormulaBarFocus(store: UiStore, cell: CellAddress): void {
  store.focusCell(cell);
  notify(channelOf(store).focusListeners, { object: cell.object, cell: cell.cell });
}

/** Adds a listener for `requestFormulaBarFocus` on `store`; returns its remover. */
export function onFormulaBarFocusRequest(
  store: UiStore,
  listener: (cell: CellAddress) => void,
): () => void {
  const { focusListeners } = channelOf(store);
  focusListeners.add(listener);
  return () => {
    focusListeners.delete(listener);
  };
}
