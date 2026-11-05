/**
 * React bindings (vtt-3l6.21) over `useSyncExternalStore`: the session
 * snapshot, the `UiStore`, the session's notices and save status, under one
 * `TableProvider`. Selectors must return stable values (primitives or
 * objects the stores own), as `useSyncExternalStore` requires.
 */
import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useSyncExternalStore,
} from "react";
import type { UiState, UiStore } from "../state/ui-state";
import type { Notice, NoticeStore } from "./notices";
import type { SessionSnapshot, TableSession } from "./table-session";
import { type SaveStatus, sessionNotices, sessionSaves } from "./writes";

interface TableContextValue {
  session: TableSession;
  ui: UiStore;
}

const TableContext = createContext<TableContextValue | null>(null);

export interface TableProviderProps {
  session: TableSession;
  ui: UiStore;
  children?: ReactNode;
}

/** Provides the session and the `UiStore` to the hooks below; starts save tracking. */
export function TableProvider({ session, ui, children }: TableProviderProps) {
  // Track `save` events from the first render on.
  sessionSaves(session);
  return createElement(TableContext.Provider, { value: { session, ui } }, children);
}

function useTable(): TableContextValue {
  const value = useContext(TableContext);
  if (value === null) throw new Error("vtt hooks must be used inside a TableProvider");
  return value;
}

/** The table session. */
export function useTableSession(): TableSession {
  return useTable().session;
}

/** The `UiStore`. */
export function useUiStore(): UiStore {
  return useTable().ui;
}

/** `selector` of the session snapshot, re-rendering when it changes. */
export function useSession<T>(selector: (snapshot: SessionSnapshot) => T): T {
  const { session } = useTable();
  const subscribe = useCallback((fn: () => void) => session.subscribe(fn), [session]);
  return useSyncExternalStore(subscribe, () => selector(session.getSnapshot()));
}

/** `selector` of the UI state, re-rendering when it changes. */
export function useUi<T>(selector: (state: UiState) => T): T {
  const { ui } = useTable();
  const subscribe = useCallback((fn: () => void) => ui.subscribe(fn), [ui]);
  return useSyncExternalStore(subscribe, () => selector(ui.getState()));
}

/** The session's notice store (for `dismiss`). */
export function useNoticeStore(): NoticeStore {
  return sessionNotices(useTable().session);
}

/** The session's current notices, oldest first. */
export function useNotices(): readonly Notice[] {
  const store = useNoticeStore();
  const subscribe = useCallback((fn: () => void) => store.subscribe(fn), [store]);
  return useSyncExternalStore(subscribe, () => store.list());
}

/** The session's save status (null until a save is requested or a `save` event arrives). */
export function useSaveStatus(): SaveStatus | null {
  const tracker = sessionSaves(useTable().session);
  const subscribe = useCallback((fn: () => void) => tracker.subscribe(fn), [tracker]);
  return useSyncExternalStore(subscribe, () => tracker.get());
}
