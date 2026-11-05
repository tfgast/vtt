/**
 * The log panel's read side (vtt-1xv.20; DESIGN.md §4.4 the log filtered by
 * current visibility, §4.8 the log panel, §7 Undo; PROTOCOL.md §4 `log`,
 * §7.6 group views, §8 log scope; M5 plan Q20; review r1 finding 12, r3
 * finding 9).
 *
 * - **The window**: a `{type: "log"}` subscription with the session's
 *   current viewer, its mirror's groups shown newest first. On a viewer
 *   change the new viewer's subscription is made before the old one is
 *   closed (no empty frame), and the older pages are dropped.
 * - **Older pages** form a chain anchored at a fixed upper `boundary`, set
 *   when the first older page is requested: the lowest index in the window,
 *   or, when the viewer's window holds no groups, the `next_index` of a
 *   `log {limit: 1}` response. Page 1 is `log {before: boundary, limit: 50,
 *   effects: true}`; page k+1 uses `before` = the lowest index page k
 *   returned; the chain ends when a page returns fewer than 50 groups or
 *   reaches `first_index`.
 * - **The bridge**: groups at or above the boundary that later leave the
 *   window (new groups push the oldest out) are kept, so the list stays
 *   gap-free between the window and page 1. They are taken from the last
 *   window seen and refetched (`log` below the window, down to the
 *   boundary) whenever the chain is rebuilt.
 * - **Invalidation** marks the whole chain stale and starts a new
 *   generation: for a character viewer on every commit (the client cannot
 *   tell which commits are visibility-relevant); for the GM on a commit
 *   whose group is an undo of an index at or below the boundary (an undo of
 *   a bridge group is applied to the bridge directly, as GM group views
 *   change in nothing but `undone`); for every viewer on a resync and on an
 *   authority session change. A stale page keeps its last content
 *   (`refreshing`) and is rebuilt in order from the same boundary, each
 *   page's `before` derived from its refreshed predecessor, once the panel
 *   reports it in view (`showPage`).
 * - Every request is tagged with the generation, viewer, authority session
 *   and revision it was made at; a response is applied only if the
 *   generation, viewer and session are unchanged, otherwise dropped.
 * - A subscription that fails (refused, or terminal after a reconnect) is a
 *   connection notice in the session's notice store (vtt-3l6.21); it is
 *   retried on the next ready transition or viewer change.
 */
import {
  type CommitEvent,
  type GroupView,
  type LogParams,
  type LogResult,
  type ProtocolError,
  ProtocolFailure,
  type ResyncInfo,
  type Subscription,
  type Viewer,
} from "@vtt/protocol";
import type { TableSession } from "../session/table-session";
import { sessionNotices } from "../session/writes";
import { describeError } from "../values/rejections";

/** The size of an older page. */
export const LOG_PAGE_SIZE = 50;

/** One group in the list. */
export interface LogEntry {
  readonly group: GroupView;
  /** The 1-based older page holding it; null for the window (and the bridge above page 1). */
  readonly page: number | null;
  /** Its page (or the bridge) is stale and being rebuilt; the content is the last one received. */
  readonly refreshing: boolean;
}

export interface LogPageInfo {
  /** 1-based. */
  readonly page: number;
  readonly refreshing: boolean;
}

export interface LogSnapshot {
  /** Whose groups these are (the viewer of the window shown). */
  readonly viewer: Viewer;
  /** The window subscription is live. */
  readonly live: boolean;
  /** Every group shown, newest first, each index once. */
  readonly entries: readonly LogEntry[];
  /** The loaded older pages, in order. */
  readonly pages: readonly LogPageInfo[];
  /** The chain's fixed upper boundary; null until the first older page is requested. */
  readonly boundary: number | null;
  /** False once the last older page reached the start of the retained log. */
  readonly canLoadOlder: boolean;
  /** Requests are in flight. */
  readonly loading: boolean;
  /** Increases on every invalidation and viewer change. */
  readonly generation: number;
}

export interface LogSession {
  /** Adds a listener called after every snapshot change; returns its remover. */
  subscribe(listener: () => void): () => void;
  /** The current snapshot; the same object until something changes. */
  getSnapshot(): LogSnapshot;
  /**
   * Loads the next older page (rebuilding stale pages first, in order).
   * Resolves once the requests settle; never rejects.
   */
  loadOlder(): Promise<void>;
  /** The panel shows older page `page` (1-based): stale pages up to it are rebuilt, in order. */
  showPage(page: number): void;
  /** Resolves once no subscription or page request is in flight. */
  idle(): Promise<void>;
  /** Unsubscribes and stops for good. */
  close(): void;
}

// ---------------------------------------------------------------------------
// Internals

const keyOf = (viewer: Viewer): string => (viewer.type === "gm" ? "gm" : `character:${viewer.id}`);

const copyViewer = (viewer: Viewer): Viewer =>
  viewer.type === "gm" ? { type: "gm" } : { type: "character", id: viewer.id };

interface Held {
  readonly sub: Subscription;
  readonly viewer: Viewer;
  readonly key: string;
  readonly offs: (() => void)[];
}

interface Page {
  /** The exclusive upper index it was requested with. */
  readonly before: number;
  /** Newest first, never empty. */
  readonly groups: readonly GroupView[];
  fresh: boolean;
  /** The client revision the page was requested at. */
  readonly revision: number;
}

interface Chain {
  /** Null until resolved (the first older page request). */
  boundary: number | null;
  pages: Page[];
  /** The last page ended the chain. */
  ended: boolean;
  /** Groups at or above the boundary that left the window, by index. */
  bridge: Map<number, GroupView>;
  bridgeFresh: boolean;
  /** Pages (a count, from page 1) the panel shows and wants rebuilt. */
  wanted: number;
  /** Older pages asked for with `loadOlder` and not yet loaded. */
  more: number;
}

interface Tag {
  readonly generation: number;
  readonly viewer: string;
  readonly session: string | null;
  readonly revision: number;
}

const lowestIndex = (groups: Iterable<number>): number | undefined => {
  let low: number | undefined;
  for (const i of groups) if (low === undefined || i < low) low = i;
  return low;
};

const lastIndex = (page: Page): number => (page.groups.at(-1) as GroupView).index;

class Log implements LogSession {
  readonly #session: TableSession;
  readonly #listeners = new Set<() => void>();
  readonly #offs: (() => void)[] = [];

  #held: Held | null = null;
  /** The viewer key whose subscription failed; not retried until the next ready transition or a change. */
  #blocked: string | null = null;
  #opening: Promise<void> | null = null;
  #reopen = false;
  #wasReady = false;

  #chain: Chain | null = null;
  #generation = 0;
  /** The window as last seen, to keep groups that leave it. */
  #window = new Map<number, GroupView>();
  #pumping: Promise<void> | null = null;
  #repump = false;
  #closed = false;

  #snapshot: LogSnapshot;

  constructor(session: TableSession) {
    this.#session = session;
    this.#snapshot = this.#build();
    const client = session.client;
    this.#wasReady = client.ready;
    this.#offs.push(
      session.subscribe(() => this.#onSession()),
      client.on("state", () => this.#onState()),
      client.on("commit", (event) => this.#onCommit(event)),
    );
    void this.#reconcile();
  }

  // -------------------------------------------------------------------------
  // Public

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  getSnapshot(): LogSnapshot {
    return this.#snapshot;
  }

  loadOlder(): Promise<void> {
    if (this.#closed || this.#held === null) return Promise.resolve();
    if (this.#chain === null) {
      this.#chain = {
        boundary: lowestIndex(this.#held.sub.mirror.groups.keys()) ?? null,
        pages: [],
        ended: false,
        bridge: new Map(),
        bridgeFresh: true,
        wanted: 0,
        more: 0,
      };
    }
    const chain = this.#chain;
    if (chain.ended && chain.pages.every((p) => p.fresh)) return this.idle();
    chain.more++;
    this.#refresh();
    return this.#pump();
  }

  showPage(page: number): void {
    const chain = this.#chain;
    if (this.#closed || chain === null || page <= chain.wanted) return;
    chain.wanted = page;
    if (chain.pages.some((p) => !p.fresh)) void this.#pump();
  }

  async idle(): Promise<void> {
    while (this.#opening !== null || this.#pumping !== null) {
      await (this.#opening ?? this.#pumping);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const off of this.#offs.splice(0)) off();
    this.#release(this.#held);
    this.#held = null;
    this.#chain = null;
    this.#refresh();
    this.#listeners.clear();
  }

  // -------------------------------------------------------------------------
  // The window subscription

  #wantedViewer(): Viewer {
    return this.#session.getSnapshot().viewer;
  }

  #onSession(): void {
    const key = keyOf(this.#wantedViewer());
    if (this.#held?.key !== key) {
      if (this.#blocked !== key) this.#blocked = null;
      void this.#reconcile();
    }
  }

  #onState(): void {
    const ready = this.#session.client.ready;
    if (ready && !this.#wasReady) {
      this.#blocked = null;
      void this.#reconcile();
      if (this.#chain !== null) void this.#pump();
    }
    this.#wasReady = ready;
  }

  /** Brings the window subscription to the wanted viewer; serialized. */
  #reconcile(): Promise<void> {
    if (this.#opening !== null) {
      this.#reopen = true;
      return this.#opening;
    }
    const run = async () => {
      await null;
      try {
        do {
          this.#reopen = false;
          await this.#open();
        } while (this.#reopen && !this.#closed);
      } finally {
        this.#opening = null;
        this.#refresh();
      }
    };
    this.#opening = run();
    return this.#opening;
  }

  async #open(): Promise<void> {
    const client = this.#session.client;
    if (this.#closed || !client.ready) return;
    const viewer = copyViewer(this.#wantedViewer());
    const key = keyOf(viewer);
    if (this.#held?.key === key && this.#held.sub.state === "live") return;
    if (this.#blocked === key) return;
    let sub: Subscription;
    try {
      sub = await client.subscribe({ scope: { type: "log" }, viewer });
    } catch (e) {
      if (this.#closed) return;
      if (e instanceof ProtocolFailure && e.local && e.error.code === "disconnected") return;
      this.#blocked = key;
      this.#notice(
        e instanceof ProtocolFailure ? e.error : { code: "internal", message: String(e) },
      );
      return;
    }
    if (this.#closed || keyOf(this.#wantedViewer()) !== key) {
      // Closed, or the viewer changed meanwhile: not current, dropped.
      sub.close().catch(() => undefined);
      if (!this.#closed) this.#reopen = true;
      return;
    }
    const held: Held = { sub, viewer, key, offs: [] };
    held.offs.push(
      sub.on("resync", (_, info) => this.#onResync(held, info)),
      sub.on("error", (_, error) => this.#onFailed(held, error)),
    );
    const old = this.#held;
    this.#held = held;
    if (old?.key === key) {
      this.#invalidate(); // The same viewer resubscribed: the chain may be out of date.
    } else {
      this.#chain = null; // A new viewer: older pages are dropped.
      this.#generation++;
    }
    this.#window = new Map(sub.mirror.groups);
    this.#refresh();
    this.#release(old);
  }

  #onResync(held: Held, _info: ResyncInfo): void {
    if (this.#held !== held || this.#closed) return;
    // Missed commits, and on a new authority session also a new history: rebuild.
    this.#window = new Map(held.sub.mirror.groups);
    this.#invalidate();
    this.#refresh();
  }

  #onFailed(held: Held, error: ProtocolError): void {
    if (this.#held !== held || this.#closed) return;
    this.#blocked = held.key;
    this.#notice(error);
    this.#refresh();
  }

  #release(held: Held | null): void {
    if (held === null) return;
    for (const off of held.offs.splice(0)) off();
    held.sub.close().catch(() => undefined);
  }

  #notice(error: ProtocolError): void {
    sessionNotices(this.#session).push({
      level: "error",
      text: `The log could not be updated. ${describeError(error)}`,
    });
  }

  // -------------------------------------------------------------------------
  // Commits and invalidation

  #onCommit(event: CommitEvent): void {
    const held = this.#held;
    if (this.#closed || held === null || held.sub.state !== "live") return;
    const current = held.sub.mirror.groups;
    const chain = this.#chain;
    if (chain !== null && chain.boundary !== null) {
      const boundary = chain.boundary;
      // Groups pushed out of the window stay shown, above page 1.
      const low = lowestIndex(current.keys()) ?? Number.POSITIVE_INFINITY;
      for (const [i, g] of this.#window) {
        if (!current.has(i) && i >= boundary && i < low) chain.bridge.set(i, g);
      }
      for (const i of chain.bridge.keys()) if (current.has(i)) chain.bridge.delete(i);
      if (held.viewer.type === "character") {
        this.#invalidate();
      } else if (event.group.kind === "undo") {
        const undoes = current.get(event.group.index)?.undoes;
        const bridged = undoes === undefined ? undefined : chain.bridge.get(undoes);
        if (undoes === undefined || undoes <= boundary) this.#invalidate();
        else if (bridged !== undefined) chain.bridge.set(undoes, { ...bridged, undone: true });
      }
    } else if (chain !== null && held.viewer.type === "character") {
      this.#invalidate(); // A boundary request in flight is superseded.
    }
    this.#window = new Map(current);
    this.#refresh();
  }

  #invalidate(): void {
    this.#generation++;
    const chain = this.#chain;
    if (chain === null) return;
    for (const page of chain.pages) page.fresh = false;
    chain.bridgeFresh = chain.boundary === null;
    chain.wanted = 0;
    void this.#pump();
  }

  // -------------------------------------------------------------------------
  // Paging

  #tag(): Tag {
    const client = this.#session.client;
    return {
      generation: this.#generation,
      viewer: this.#held?.key ?? "",
      session: client.session,
      revision: client.revision,
    };
  }

  #current(tag: Tag, chain: Chain): boolean {
    return (
      !this.#closed &&
      this.#chain === chain &&
      tag.generation === this.#generation &&
      tag.viewer === this.#held?.key &&
      tag.session === this.#session.client.session
    );
  }

  /** Runs the page loop (again) and resolves when it is idle. */
  #pump(): Promise<void> {
    if (this.#pumping !== null) {
      this.#repump = true;
      return this.#pumping;
    }
    const run = async () => {
      await null;
      try {
        do {
          this.#repump = false;
          await this.#loop();
        } while (this.#repump && !this.#closed);
      } finally {
        this.#pumping = null;
        this.#refresh();
      }
    };
    this.#pumping = run();
    this.#refresh();
    return this.#pumping;
  }

  async #loop(): Promise<void> {
    for (;;) {
      const chain = this.#chain;
      const held = this.#held;
      if (this.#closed || chain === null || held === null || held.sub.state !== "live") return;
      if (!this.#session.client.ready) return; // Resumed by the next ready transition.
      let step: "applied" | "dropped" | "failed";
      if (chain.boundary === null) {
        step = await this.#fetchBoundary(chain, held);
      } else if (!chain.bridgeFresh) {
        step = await this.#fetchBridge(chain, held, chain.boundary);
      } else {
        const stale = chain.pages.findIndex((p) => !p.fresh);
        if (stale >= 0 && (stale < chain.wanted || chain.more > 0)) {
          step = await this.#fetchPage(chain, held, stale);
        } else if (stale < 0 && chain.more > 0 && !chain.ended) {
          step = await this.#fetchPage(chain, held, chain.pages.length);
          if (step === "applied") chain.more--;
        } else {
          chain.more = 0;
          return;
        }
      }
      if (step === "failed") {
        if (this.#chain === chain) chain.more = 0;
        return;
      }
      this.#refresh();
    }
  }

  async #request(params: LogParams): Promise<LogResult | "failed"> {
    try {
      return await this.#session.client.request("log", params);
    } catch (e) {
      if (this.#closed) return "failed";
      const local = e instanceof ProtocolFailure && e.error.code === "disconnected";
      if (!local) {
        const error =
          e instanceof ProtocolFailure
            ? e.error
            : { code: "internal" as const, message: String(e) };
        sessionNotices(this.#session).push({
          level: "error",
          text: `Older log entries could not be loaded. ${describeError(error)}`,
        });
      }
      return "failed";
    }
  }

  async #fetchBoundary(chain: Chain, held: Held): Promise<"applied" | "dropped" | "failed"> {
    const tag = this.#tag();
    const result = await this.#request({ limit: 1, viewer: copyViewer(held.viewer) });
    if (result === "failed") return "failed";
    if (!this.#current(tag, chain)) return "dropped";
    chain.boundary = result.next_index;
    return "applied";
  }

  async #fetchBridge(
    chain: Chain,
    held: Held,
    boundary: number,
  ): Promise<"applied" | "dropped" | "failed"> {
    const tag = this.#tag();
    const top = lowestIndex(held.sub.mirror.groups.keys());
    const collected = new Map<number, GroupView>();
    if (top === undefined || top > boundary) {
      let before = top;
      for (;;) {
        const result = await this.#request({
          ...(before === undefined ? {} : { before }),
          limit: LOG_PAGE_SIZE,
          viewer: copyViewer(held.viewer),
          effects: true,
        });
        if (result === "failed") return "failed";
        if (!this.#current(tag, chain)) return "dropped";
        for (const g of result.groups) if (g.index >= boundary) collected.set(g.index, g);
        const last = result.groups.at(-1);
        if (
          result.groups.length < LOG_PAGE_SIZE ||
          last === undefined ||
          last.index <= boundary ||
          last.index === result.first_index
        ) {
          break;
        }
        before = last.index;
      }
    }
    // Groups that left the window while the bridge was fetched stay.
    for (const [i, g] of chain.bridge) {
      if (!collected.has(i) && top !== undefined && i >= top) collected.set(i, g);
    }
    for (const i of held.sub.mirror.groups.keys()) collected.delete(i);
    chain.bridge = collected;
    chain.bridgeFresh = true;
    return "applied";
  }

  async #fetchPage(chain: Chain, held: Held, k: number): Promise<"applied" | "dropped" | "failed"> {
    const boundary = chain.boundary as number;
    const prev = chain.pages[k - 1];
    const before = k === 0 || prev === undefined ? boundary : lastIndex(prev);
    const tag = this.#tag();
    const result = await this.#request({
      before,
      limit: LOG_PAGE_SIZE,
      viewer: copyViewer(held.viewer),
      effects: true,
    });
    if (result === "failed") return "failed";
    if (!this.#current(tag, chain)) return "dropped";
    const groups = result.groups;
    const ended = groups.length < LOG_PAGE_SIZE || groups.at(-1)?.index === result.first_index;
    if (groups.length === 0) {
      chain.pages.splice(k);
      chain.ended = true;
      return "applied";
    }
    chain.pages[k] = { before, groups, fresh: true, revision: tag.revision };
    if (ended) {
      chain.pages.splice(k + 1);
      chain.ended = true;
    } else if (k === chain.pages.length - 1) {
      chain.ended = false;
    }
    return "applied";
  }

  // -------------------------------------------------------------------------
  // Snapshot

  #build(): LogSnapshot {
    const held = this.#closed ? null : this.#held;
    const chain = this.#closed ? null : this.#chain;
    const byIndex = new Map<number, LogEntry>();
    if (held !== null) {
      for (const [i, group] of held.sub.mirror.groups) {
        byIndex.set(i, { group, page: null, refreshing: false });
      }
    }
    const pages: LogPageInfo[] = [];
    if (chain !== null && chain.boundary !== null) {
      for (const [i, group] of chain.bridge) {
        if (!byIndex.has(i) && i >= chain.boundary) {
          byIndex.set(i, { group, page: null, refreshing: !chain.bridgeFresh });
        }
      }
      // Fresh pages (a prefix) cover down to the lowest index they returned; a stale
      // page's content is shown only below that.
      let covered = chain.boundary;
      let prefix = true;
      chain.pages.forEach((page, k) => {
        const fresh = prefix && page.fresh;
        if (!fresh) prefix = false;
        pages.push({ page: k + 1, refreshing: !fresh });
        for (const group of page.groups) {
          if (byIndex.has(group.index)) continue;
          if (!fresh && group.index >= covered) continue;
          byIndex.set(group.index, { group, page: k + 1, refreshing: !fresh });
        }
        if (fresh) covered = lastIndex(page);
      });
    }
    const entries = [...byIndex.values()].sort((a, b) => b.group.index - a.group.index);
    return {
      viewer: held?.viewer ?? copyViewer(this.#wantedViewer()),
      live: held?.sub.state === "live",
      entries,
      pages,
      boundary: chain?.boundary ?? null,
      canLoadOlder: held !== null && (chain === null || !chain.ended),
      loading: this.#pumping !== null,
      generation: this.#generation,
    };
  }

  #refresh(): void {
    this.#snapshot = this.#build();
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch {
        // A throwing listener must not break the log.
      }
    }
  }
}

/**
 * The log window of `session`'s current viewer and its older pages (see the
 * module comment). Close it when done.
 */
export function createLogSession(session: TableSession): LogSession {
  return new Log(session);
}
