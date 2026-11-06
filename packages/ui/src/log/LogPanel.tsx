/**
 * The log panel (vtt-1xv.20; DESIGN.md §4.8 the log panel, M5-D21; §4.4 the
 * log filtered by current visibility; §7 Undo, any group by index; §8.4
 * step 14; PROTOCOL.md §4 `undo` group target, §7.6).
 *
 * - Newest first: the log session's window, bridge and older pages, each
 *   group a header ("GM: Apply") and one sentence per effect
 *   (`describeGroup`). Groups of stale pages are marked "refreshing".
 * - Filters: actor (all, GM, any agent, each agent seen by name, any
 *   character, each character seen; vtt-qf5.58), kind (all, actions, edits,
 *   undos) and text (the actor, the label and the captured names). Choosing
 *   an actor other than All loads older groups, in batches of
 *   `LOG_FILTER_PAGES` pages one after another, until the start of the log,
 *   so every group by that actor is listed in one action; chosen before the
 *   window subscription is live, it starts once it is. The search stops
 *   early only when a batch loads nothing (a failed request; "Load older"
 *   resumes it), when the filter changes, or when the panel closes. A status
 *   line says how far back the search went.
 * - A sentence links to the object it touched: selected when the current
 *   view has it, else a notice "<name> no longer exists or is hidden".
 * - In the GM view, "Undo" on every group that is neither undone nor an
 *   undo sends `undo {target: {type: "group", index}}`: no base revision,
 *   never resent; a refusal or an unknown outcome is a notice. Undone
 *   groups are struck through.
 * - "Load older" pages older groups. Stale older pages are rebuilt as they
 *   are rendered in view (any of their rows): reported by an `IntersectionObserver` when the
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
import { actorName, describeGroup, type GroupDescription, groupSearchText } from "./sentences";

export interface LogPanelProps {
  session: TableSession;
  ui: UiStore;
  /** A log session to show; by default the panel creates one and closes it on unmount. */
  log?: LogSession;
}

/**
 * `agents` and `characters` match any agent or character; `agent:<name>`
 * one agent by name (empty for an unnamed agent), `character:<id>` one
 * character.
 */
export type LogActorFilter =
  | "all"
  | "gm"
  | "agents"
  | "characters"
  | `agent:${string}`
  | `character:${string}`;
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

/** Older pages the actor filter's search asks for per `loadOlder` call. */
export const LOG_FILTER_PAGES = 20;

/** The actor filter value naming exactly `actor`. */
export function logActorKey(actor: GroupView["actor"]): LogActorFilter {
  switch (actor.type) {
    case "gm":
      return "gm";
    case "agent":
      return `agent:${actor.name ?? ""}`;
    case "character":
      return `character:${actor.id}`;
  }
}

function actorMatches(actor: GroupView["actor"], filter: LogActorFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "agents":
      return actor.type === "agent";
    case "characters":
      return actor.type === "character";
    default:
      return logActorKey(actor) === filter;
  }
}

/** Whether `group` passes `filter`. */
export function logFilterMatches(group: GroupView, filter: LogFilter): boolean {
  if (!actorMatches(group.actor, filter.actor)) return false;
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

/** The actors seen in the loaded groups, by filter value, each with its display name. */
interface SeenActors {
  readonly agents: ReadonlyMap<LogActorFilter, string>;
  readonly characters: ReadonlyMap<LogActorFilter, string>;
}

const byName = (a: [LogActorFilter, string], b: [LogActorFilter, string]) =>
  a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]);

interface Row {
  readonly entry: LogEntry;
  readonly description: GroupDescription;
}

const sameViewer = (a: Viewer, b: Viewer) =>
  a.type === b.type && (a.type === "gm" || (b.type === "character" && a.id === b.id));

/** The highest older page among `rows` (their `data-log-page`), 0 for none. */
function maxPage(rows: Iterable<HTMLElement>): number {
  let max = 0;
  for (const el of rows) {
    const page = Number(el.dataset.logPage ?? 0);
    if (page > max) max = page;
  }
  return max;
}

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

  // Actors seen since the viewer was last changed; kept as the entries change.
  const viewerKey = snap.viewer.type === "gm" ? "gm" : `character:${snap.viewer.id}`;
  const seenRef = useRef<{
    viewer: string;
    agents: Map<LogActorFilter, string>;
    characters: Map<LogActorFilter, string>;
  }>({
    viewer: viewerKey,
    agents: new Map(),
    characters: new Map(),
  });
  const seen: SeenActors = useMemo(() => {
    if (seenRef.current.viewer !== viewerKey) {
      seenRef.current = { viewer: viewerKey, agents: new Map(), characters: new Map() };
    }
    const { agents, characters } = seenRef.current;
    for (const { group } of snap.entries) {
      const actor = group.actor;
      if (actor.type === "gm") continue;
      const into = actor.type === "agent" ? agents : characters;
      const key = logActorKey(actor);
      if (!into.has(key)) into.set(key, actorName(actor, group.names));
    }
    return { agents: new Map(agents), characters: new Map(characters) };
  }, [snap.entries, viewerKey]);
  const actorLabel = (key: LogActorFilter): string => {
    if (key === "agents") return "any agent";
    if (key === "characters") return "any character";
    if (key === "gm") return "the GM";
    return seen.agents.get(key) ?? seen.characters.get(key) ?? key.slice(key.indexOf(":") + 1);
  };

  // Choosing an actor loads older groups, batch after batch, until the start of
  // the log. A batch that loads no new page (a failed request) stops the search;
  // a new run (another actor, Load older, a new viewer) or All or unmounting
  // cancels the running one before its next batch.
  const filtering = filter.actor !== "all";
  const [search, setSearch] = useState<"idle" | "running" | "stopped">("idle");
  const searchRun = useRef(0);
  const runSearch = useCallback(() => {
    const run = ++searchRun.current;
    setSearch("running");
    void (async () => {
      for (;;) {
        const before = log.getSnapshot();
        await log.loadOlder(LOG_FILTER_PAGES);
        if (searchRun.current !== run) return;
        const after = log.getSnapshot();
        if (!after.canLoadOlder) break;
        const progressed =
          after.pages.length > before.pages.length || after.generation !== before.generation;
        if (!progressed) {
          setSearch("stopped");
          return;
        }
      }
      if (searchRun.current === run) setSearch("idle");
    })();
  }, [log]);
  // The search waits for the window subscription: before it is live, loadOlder
  // has nothing to page from, so the search starts (or restarts) once it is.
  const live = snap.live;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new viewer drops older pages, so the search reruns
  useEffect(() => {
    if (filter.actor === "all") {
      setSearch("idle");
      return;
    }
    if (!live) {
      setSearch("running");
      return;
    }
    runSearch();
    return () => {
      searchRun.current++;
    };
  }, [filter.actor, runSearch, viewerKey, live]);
  const oldest = snap.entries.at(-1)?.group.index ?? "none";
  const searchStatus = !filtering
    ? null
    : search === "running"
      ? `Searching older groups… (searched back to group ${oldest})`
      : search === "stopped"
        ? `Search stopped at group ${oldest}. Load older to continue.`
        : !snap.canLoadOlder
          ? `Every group by ${actorLabel(filter.actor)} is listed.`
          : snap.loading
            ? `Searching older groups… (searched back to group ${oldest})`
            : `Search stopped at group ${oldest}. Load older to continue.`;

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

  // Stale pages are rebuilt as they are rendered in view. With an observer, every
  // row is observed, so a page counts as in view while any of its rows is (also a
  // row in the middle of a long page); a row's page is read when it is needed, as
  // a rebuild may move it.
  const visibleRows = useRef(new Set<HTMLElement>());
  const tracker = useMemo(() => {
    const refs = new Map<number, (el: HTMLElement | null) => void>();
    const rows = new Map<number, HTMLElement>();
    if (typeof IntersectionObserver === "undefined") return { observer: null, refs, rows };
    const observer = new IntersectionObserver((records) => {
      for (const record of records) {
        const el = record.target as HTMLElement;
        if (record.isIntersecting) visibleRows.current.add(el);
        else visibleRows.current.delete(el);
      }
      const max = maxPage(visibleRows.current);
      if (max > 0) log.showPage(max);
    });
    return { observer, refs, rows };
  }, [log]);
  const observer = tracker.observer;
  useEffect(
    () => () => {
      observer?.disconnect();
      visibleRows.current.clear();
    },
    [observer],
  );
  useEffect(() => {
    const max =
      observer === null
        ? Math.max(0, ...rows.map((row) => row.entry.page ?? 0))
        : maxPage(visibleRows.current);
    if (max > 0) log.showPage(max);
  });
  const rowRef = (index: number) => {
    let ref = tracker.refs.get(index);
    if (ref === undefined) {
      ref = (el: HTMLElement | null) => {
        const old = tracker.rows.get(index);
        if (old === el) return;
        if (old !== undefined) {
          observer?.unobserve(old);
          tracker.rows.delete(index);
          visibleRows.current.delete(old);
        }
        if (el !== null) {
          tracker.rows.set(index, el);
          observer?.observe(el);
        }
      };
      tracker.refs.set(index, ref);
    }
    return ref;
  };

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
            <optgroup label="Agents">
              <option value="agents">Any agent</option>
              {[...seen.agents].sort(byName).map(([key, name]) => (
                <option key={key} value={key}>
                  {name}
                </option>
              ))}
            </optgroup>
            <optgroup label="Characters">
              <option value="characters">Any character</option>
              {[...seen.characters].sort(byName).map(([key, name]) => (
                <option key={key} value={key}>
                  {name}
                </option>
              ))}
            </optgroup>
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
          return (
            <li
              key={group.index}
              ref={rowRef(group.index)}
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
      {searchStatus === null ? null : (
        <p role="status" aria-label="Log search">
          {searchStatus}
        </p>
      )}
      {snap.canLoadOlder ? (
        <button type="button" onClick={() => (filtering ? runSearch() : void log.loadOlder())}>
          Load older
        </button>
      ) : null}
    </section>
  );
}
