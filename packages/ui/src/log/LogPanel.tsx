/**
 * The log panel (vtt-1xv.20; DESIGN.md §4.8 the log panel, M5-D21; §4.4 the
 * log filtered by current visibility; §7 Undo, any group by index; §8.4
 * step 14; PROTOCOL.md §4 `undo` group target, §7.6).
 *
 * - Newest first: the log session's window, bridge and older pages, each
 *   group a header ("GM: Apply") and one sentence per effect
 *   (`describeGroup`). Groups of stale pages are marked "refreshing".
 * - Filters: actor (all, GM, agent, character), kind (all, actions, edits,
 *   undos) and text (the actor, the label and the captured names).
 * - A sentence links to the object it touched: selected when the current
 *   view has it, else a notice "<name> no longer exists or is hidden".
 * - In the GM view, "Undo" on every group that is neither undone nor an
 *   undo sends `undo {target: {type: "group", index}}`: no base revision,
 *   never resent; a refusal or an unknown outcome is a notice. Undone
 *   groups are struck through.
 * - "Load older" pages older groups. Stale older pages are rebuilt as they
 *   are rendered in view: reported by an `IntersectionObserver` when the
 *   platform has one, else on the next render.
 *
 * DOM contract (for composition and drivers): the list is `role="list"`
 * named "Log entries"; each group is an `li` with `aria-label` = its header
 * and `data-log-index`, `data-log-page` (older pages only), `data-kind`,
 * `data-undone`; sentence links are buttons with `data-log-sentence`; the
 * panel root has `data-log-live` while the window is live.
 */
import { type GroupView, type ProtocolError, ProtocolFailure, type Viewer } from "@vtt/protocol";
import type { ObjectId } from "@vtt/schema";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { TableSession } from "../session/table-session";
import { sessionNotices } from "../session/writes";
import type { UiStore } from "../state/ui-state";
import { describeError, describeRejection } from "../values/rejections";
import { createLogSession, type LogEntry, type LogSession } from "./log-session";
import { describeGroup, type GroupDescription, groupSearchText } from "./sentences";

export interface LogPanelProps {
  session: TableSession;
  ui: UiStore;
  /** A log session to show; by default the panel creates one and closes it on unmount. */
  log?: LogSession;
}

export type LogActorFilter = "all" | "gm" | "agent" | "character";
export type LogKindFilter = "all" | "actions" | "edits" | "undos";

export interface LogFilter {
  readonly actor: LogActorFilter;
  readonly kind: LogKindFilter;
  readonly text: string;
}

const KIND_OF: Record<Exclude<LogKindFilter, "all">, GroupView["kind"]> = {
  actions: "action",
  edits: "edit",
  undos: "undo",
};

/** Whether `group` passes `filter`. */
export function logFilterMatches(group: GroupView, filter: LogFilter): boolean {
  if (filter.actor !== "all" && group.actor.type !== filter.actor) return false;
  if (filter.kind !== "all" && group.kind !== KIND_OF[filter.kind]) return false;
  const text = filter.text.trim().toLowerCase();
  return text === "" || groupSearchText(group).includes(text);
}

/** A group that the panel's Undo may target: neither undone nor itself an undo. */
export const canUndoGroup = (group: GroupView): boolean => !group.undone && group.kind !== "undo";

const PANEL_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  fontSize: 13,
  minHeight: 0,
};
const LIST_STYLE: CSSProperties = { listStyle: "none", margin: 0, padding: 0, overflowY: "auto" };
const GROUP_STYLE: CSSProperties = { borderBottom: "1px solid #ddd", padding: "4px 0" };
const SENTENCES_STYLE: CSSProperties = { listStyle: "none", margin: "2px 0 0", paddingLeft: 12 };
const LINK_STYLE: CSSProperties = {
  background: "none",
  border: "none",
  padding: 0,
  font: "inherit",
  textAlign: "left",
  cursor: "pointer",
  color: "inherit",
};

interface Row {
  readonly entry: LogEntry;
  readonly description: GroupDescription;
}

const sameViewer = (a: Viewer, b: Viewer) =>
  a.type === b.type && (a.type === "gm" || (b.type === "character" && a.id === b.id));

export function LogPanel({ session, ui, log: injected }: LogPanelProps) {
  const [owned, setOwned] = useState<LogSession | null>(null);
  useEffect(() => {
    if (injected !== undefined) return;
    const created = createLogSession(session);
    setOwned(created);
    return () => {
      created.close();
      setOwned(null);
    };
  }, [session, injected]);
  const log = injected ?? owned;
  if (log === null) return <section aria-label="Log" style={PANEL_STYLE} />;
  return <LogView session={session} ui={ui} log={log} />;
}

function LogView({ session, ui, log }: { session: TableSession; ui: UiStore; log: LogSession }) {
  const subscribeLog = useCallback((fn: () => void) => log.subscribe(fn), [log]);
  const snap = useSyncExternalStore(subscribeLog, () => log.getSnapshot());
  const subscribeSession = useCallback((fn: () => void) => session.subscribe(fn), [session]);
  const current = useSyncExternalStore(subscribeSession, () => session.getSnapshot());
  const [filter, setFilter] = useState<LogFilter>({ actor: "all", kind: "all", text: "" });
  const [pending, setPending] = useState<ReadonlySet<number>>(new Set());

  const boards = current.boards;
  const rows: Row[] = useMemo(() => {
    const boardName = (id: string) => {
      const name = boards.find((b) => b.id === id)?.name;
      return name !== undefined && name !== "" ? name : id;
    };
    return snap.entries
      .filter((entry) => logFilterMatches(entry.group, filter))
      .map((entry) => ({
        entry,
        description: describeGroup(entry.group, snap.viewer, { boardName }),
      }));
  }, [snap, filter, boards]);

  const gmView = snap.viewer.type === "gm" && current.viewer.type === "gm";
  const notices = sessionNotices(session);

  const undoGroup = async (row: Row) => {
    const index = row.entry.group.index;
    setPending((p) => new Set(p).add(index));
    try {
      const result = await session.client.request("undo", { target: { type: "group", index } });
      if (result.status === "rejected") {
        const viewer = session.getSnapshot().viewer;
        notices.push({
          level: "error",
          text: describeRejection(result.rejection, (id) => session.refLabel(viewer, id)),
        });
      } else {
        notices.push({ level: "success", text: `Undid: ${row.description.title}` });
      }
    } catch (e) {
      const error: ProtocolError =
        e instanceof ProtocolFailure ? e.error : { code: "internal", message: String(e) };
      if (error.code === "uncertain") {
        notices.push({
          level: "warning",
          kind: "uncertain",
          text: "The undo may or may not have been applied.",
        });
      } else {
        notices.push({ level: "error", text: `The undo was not applied. ${describeError(error)}` });
      }
    } finally {
      setPending((p) => {
        const next = new Set(p);
        next.delete(index);
        return next;
      });
    }
  };

  const follow = async (group: GroupView, id: ObjectId) => {
    const viewer = session.getSnapshot().viewer;
    let present = session.objectView(id) !== null;
    if (!present) {
      try {
        const found = await session.client.request("get_objects", {
          ids: [id],
          viewer,
          cells: "structural",
        });
        present = found.objects.length > 0;
      } catch {
        present = false;
      }
    }
    // The view may have changed while asking.
    if (present && sameViewer(viewer, session.getSnapshot().viewer)) {
      ui.select([id]);
      return;
    }
    const name = group.names[id] ?? "That object";
    notices.push({ level: "info", text: `${name} no longer exists or is hidden.` });
  };

  // Stale pages are rebuilt as they are rendered in view.
  const anchors = useRef(new Map<number, HTMLElement>());
  const inView = useRef(new Set<number>());
  // The observer (when the platform has one) and stable ref callbacks per page reporting to it.
  const tracker = useMemo(() => {
    const refs = new Map<number, (el: HTMLElement | null) => void>();
    if (typeof IntersectionObserver === "undefined") return { observer: null, refs };
    const observer = new IntersectionObserver((records) => {
      for (const record of records) {
        const page = Number((record.target as HTMLElement).dataset.logPage);
        if (record.isIntersecting) inView.current.add(page);
        else inView.current.delete(page);
      }
      const max = Math.max(0, ...inView.current);
      if (max > 0) log.showPage(max);
    });
    return { observer, refs };
  }, [log]);
  const observer = tracker.observer;
  useEffect(() => () => observer?.disconnect(), [observer]);
  useEffect(() => {
    const shown = observer === null ? [...anchors.current.keys()] : [...inView.current];
    const max = Math.max(0, ...shown);
    if (max > 0) log.showPage(max);
  });
  const anchor = (page: number) => {
    let ref = tracker.refs.get(page);
    if (ref === undefined) {
      ref = (el: HTMLElement | null) => {
        const old = anchors.current.get(page);
        if (old === el) return;
        if (old !== undefined) {
          observer?.unobserve(old);
          anchors.current.delete(page);
          inView.current.delete(page);
        }
        if (el !== null) {
          anchors.current.set(page, el);
          observer?.observe(el);
        }
      };
      tracker.refs.set(page, ref);
    }
    return ref;
  };

  const firstOfPage = new Set<number>();
  const seenPages = new Set<number>();
  for (const row of rows) {
    const page = row.entry.page;
    if (page !== null && !seenPages.has(page)) {
      seenPages.add(page);
      firstOfPage.add(row.entry.group.index);
    }
  }

  return (
    <section
      aria-label="Log"
      style={PANEL_STYLE}
      {...(snap.live ? { "data-log-live": "" } : {})}
      aria-busy={snap.loading}
    >
      <fieldset aria-label="Log filters" style={{ display: "flex", gap: 6, border: 0, padding: 0 }}>
        <label>
          Actor{" "}
          <select
            aria-label="Actor"
            value={filter.actor}
            onChange={(e) => setFilter({ ...filter, actor: e.target.value as LogActorFilter })}
          >
            <option value="all">All</option>
            <option value="gm">GM</option>
            <option value="agent">Agent</option>
            <option value="character">Character</option>
          </select>
        </label>
        <label>
          Kind{" "}
          <select
            aria-label="Kind"
            value={filter.kind}
            onChange={(e) => setFilter({ ...filter, kind: e.target.value as LogKindFilter })}
          >
            <option value="all">All</option>
            <option value="actions">Actions</option>
            <option value="edits">Edits</option>
            <option value="undos">Undos</option>
          </select>
        </label>
        <input
          type="search"
          aria-label="Search the log"
          placeholder="Search"
          value={filter.text}
          onChange={(e) => setFilter({ ...filter, text: e.target.value })}
        />
      </fieldset>
      <ol aria-label="Log entries" style={LIST_STYLE}>
        {rows.map((row) => {
          const { entry, description } = row;
          const group = entry.group;
          const page = entry.page;
          const first = page !== null && firstOfPage.has(group.index);
          return (
            <li
              key={group.index}
              ref={first ? anchor(page) : undefined}
              aria-label={description.header}
              data-log-index={group.index}
              {...(page === null ? {} : { "data-log-page": page })}
              data-kind={group.kind}
              data-undone={group.undone ? "true" : "false"}
              {...(entry.refreshing ? { "data-refreshing": "" } : {})}
              style={{ ...GROUP_STYLE, ...(entry.refreshing ? { opacity: 0.6 } : {}) }}
            >
              <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
                <strong style={{ flex: 1 }}>
                  {group.undone ? <s>{description.header}</s> : description.header}
                </strong>
                {entry.refreshing ? <em>refreshing</em> : null}
                {gmView && canUndoGroup(group) ? (
                  <button
                    type="button"
                    aria-label={`Undo ${description.header}`}
                    disabled={pending.has(group.index)}
                    onClick={() => void undoGroup(row)}
                  >
                    Undo
                  </button>
                ) : null}
              </div>
              {description.sentences.length > 0 ? (
                <ul style={SENTENCES_STYLE}>
                  {description.sentences.map((sentence, k) => {
                    const object = sentence.object;
                    return (
                      // biome-ignore lint/suspicious/noArrayIndexKey: sentences are positional
                      <li key={k}>
                        {object === null ? (
                          sentence.text
                        ) : (
                          <button
                            type="button"
                            data-log-sentence=""
                            style={LINK_STYLE}
                            onClick={() => void follow(group, object)}
                          >
                            {sentence.text}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ol>
      {snap.canLoadOlder ? (
        <button type="button" onClick={() => void log.loadOlder()}>
          Load older
        </button>
      ) : null}
    </section>
  );
}
