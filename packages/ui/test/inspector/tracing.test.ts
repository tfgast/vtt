// @vitest-environment node
/**
 * Dependency tracing's controller (vtt-3l6.24; DESIGN.md §4.6 Dependency
 * tracing, §4.4; FORMULAS.md §9; PROTOCOL.md §9 `explain_cell`, `zones`;
 * review r1 findings 3, 10) against a fake session and client: requests and
 * their cache keyed by viewer, board, revision and target; late responses
 * dropped; zone-over-cell precedence; recomputation on a viewer switch at an
 * unchanged revision.
 */
import {
  type DepNode,
  type ExplainCellResult,
  ProtocolFailure,
  type Viewer,
  type ZonesResult,
} from "@vtt/protocol";
import type { ObjectId } from "@vtt/schema";
import {
  createUiStore,
  type SessionSnapshot,
  startTracing,
  type TracingSession,
  type UiSession,
  type UiStore,
} from "@vtt/ui";
import { describe, expect, test } from "vitest";

interface Call {
  readonly method: string;
  readonly params: Record<string, unknown>;
  resolve(result: unknown): void;
  reject(error: unknown): void;
}

const GM: Viewer = { type: "gm" };
const ALDRIC: Viewer = { type: "character", id: "aldric" };
const keyOf = (v: Viewer) => (v.type === "gm" ? "gm" : `character:${v.id}`);

/** A session stand-in whose client answers only when a test resolves a call. */
function fakeSession() {
  const calls: Call[] = [];
  const listeners = new Set<() => void>();
  let snapshot: SessionSnapshot = {
    connection: null,
    ready: true,
    revision: 5,
    boards: [{ id: "gm_board", name: "GM" }],
    table: null,
    activeBoard: "gm_board",
    viewer: GM,
    viewVersion: 0,
  };
  const set = (patch: Partial<SessionSnapshot>) => {
    snapshot = { ...snapshot, ...patch, viewVersion: snapshot.viewVersion + 1 };
    for (const l of [...listeners]) l();
  };
  const client = {
    request(method: string, params: Record<string, unknown>): Promise<unknown> {
      return new Promise((resolve, reject) => {
        calls.push({ method, params, resolve, reject });
      });
    },
  };
  const session = {
    client,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    viewerKey: () => keyOf(snapshot.viewer),
  } as unknown as TracingSession;
  const uiSession: UiSession = {
    getSnapshot: () => snapshot,
    setView: async () => undefined,
    watchObjects: async () => undefined,
  };
  return { session, uiSession, calls, set, listeners };
}

const cellNode = (object: ObjectId | null, cell: string, deps?: DepNode[]): DepNode => ({
  type: "cell",
  object,
  cell,
  ...(deps ? { dependencies: deps } : {}),
});

function explained(object: ObjectId, cell: string, dependencies: DepNode[]): ExplainCellResult {
  return {
    revision: 5,
    object,
    cell,
    view: { value: { type: "empty" }, kind: "formula" },
    content: { type: "formula", overridden: false, parses: true },
    dependencies,
    truncated: false,
  };
}

function zonesResult(zones: Record<ObjectId, ObjectId[]>): ZonesResult {
  return {
    revision: 5,
    zones: Object.entries(zones).map(([id, contents]) => ({
      id,
      contents,
      view: { id, is_template: false, is_character: false, cells: {}, actions: [] },
    })),
  };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

function setup() {
  const fake = fakeSession();
  const ui = createUiStore({ session: fake.uiSession });
  const stop = startTracing({ session: fake.session, ui });
  return { ...fake, ui, stop };
}

const highlight = (ui: UiStore) => ui.getState().highlight;

describe("hovered cell", () => {
  test("explains with depth 1 and the viewer, highlighting other non-board objects of cell and exists nodes", async () => {
    const { ui, calls } = setup();
    ui.setHoveredCell({ object: "goblin", cell: "hit" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("explain_cell");
    expect(calls[0]?.params).toEqual({
      object: "goblin",
      cell: "hit",
      depth: 1,
      viewer: { type: "gm" },
    });
    calls[0]?.resolve(
      explained("goblin", "hit", [
        cellNode("goblin", "ac"),
        // The board (a dependency of `on`) is not drawn on the canvas.
        { type: "exists", object: "gm_board", exists: true },
        { type: "exists", object: "die", exists: true },
        cellNode("die", "total", [cellNode("die2", "value")]),
        cellNode(null, "secret"),
        { type: "exists", object: null },
        { type: "index" },
      ]),
    );
    await flush();
    expect(highlight(ui)).toEqual(["die", "die2"]);
  });

  test("clearing the hover clears the highlight", async () => {
    const { ui, calls } = setup();
    ui.setHoveredCell({ object: "goblin", cell: "hit" });
    calls[0]?.resolve(explained("goblin", "hit", [cellNode("die", "total")]));
    await flush();
    expect(highlight(ui)).toEqual(["die"]);
    ui.setHoveredCell(null);
    expect(highlight(ui)).toEqual([]);
  });

  test("a key already answered is a cache hit: no second request", async () => {
    const { ui, calls } = setup();
    ui.setHoveredCell({ object: "goblin", cell: "hit" });
    calls[0]?.resolve(explained("goblin", "hit", [cellNode("die", "total")]));
    await flush();
    ui.setHoveredCell({ object: "goblin", cell: "ac" });
    expect(calls).toHaveLength(2);
    calls[1]?.resolve(explained("goblin", "ac", []));
    await flush();
    expect(highlight(ui)).toEqual([]);
    ui.setHoveredCell({ object: "goblin", cell: "hit" });
    expect(calls).toHaveLength(2);
    expect(highlight(ui)).toEqual(["die"]);
    ui.setHoveredCell({ object: "goblin", cell: "ac" });
    expect(calls).toHaveLength(2);
  });

  test("unrelated store changes do not resend a pending request", async () => {
    const { ui, calls } = setup();
    ui.setHoveredCell({ object: "goblin", cell: "hit" });
    ui.setCamera({ x: 3, y: 4, zoom: 2 });
    ui.select(["goblin"]);
    expect(calls).toHaveLength(1);
  });

  test("an advanced revision misses the cache and asks again", async () => {
    const { ui, calls, set } = setup();
    ui.setHoveredCell({ object: "goblin", cell: "hit" });
    calls[0]?.resolve(explained("goblin", "hit", [cellNode("die", "total")]));
    await flush();
    set({ revision: 6 });
    expect(calls).toHaveLength(2);
    // The same viewer and target: the old highlight stays until the new answer.
    expect(highlight(ui)).toEqual(["die"]);
    calls[1]?.resolve(explained("goblin", "hit", [cellNode("die3", "total")]));
    await flush();
    expect(highlight(ui)).toEqual(["die3"]);
  });

  test("a late response after the hover moved is dropped", async () => {
    const { ui, calls } = setup();
    ui.setHoveredCell({ object: "goblin", cell: "hit" });
    ui.setHoveredCell({ object: "goblin", cell: "ac" });
    expect(highlight(ui)).toEqual([]);
    calls[0]?.resolve(explained("goblin", "hit", [cellNode("die", "total")]));
    await flush();
    expect(highlight(ui)).toEqual([]);
    calls[1]?.resolve(explained("goblin", "ac", [cellNode("shield", "bonus")]));
    await flush();
    expect(highlight(ui)).toEqual(["shield"]);
  });

  test("a response arriving after the hover left leaves no highlight", async () => {
    const { ui, calls } = setup();
    ui.setHoveredCell({ object: "goblin", cell: "hit" });
    ui.setHoveredCell(null);
    calls[0]?.resolve(explained("goblin", "hit", [cellNode("die", "total")]));
    await flush();
    expect(highlight(ui)).toEqual([]);
  });

  test("a late response after the revision advanced is dropped", async () => {
    const { ui, calls, set } = setup();
    ui.setHoveredCell({ object: "goblin", cell: "hit" });
    set({ revision: 6 });
    calls[0]?.resolve(explained("goblin", "hit", [cellNode("old", "total")]));
    await flush();
    expect(highlight(ui)).toEqual([]);
    calls[1]?.resolve(explained("goblin", "hit", [cellNode("new", "total")]));
    await flush();
    expect(highlight(ui)).toEqual(["new"]);
  });

  test("a late response after the board switched is dropped", async () => {
    const { ui, calls, set } = setup();
    ui.setHoveredCell({ object: "goblin", cell: "hit" });
    set({ activeBoard: "crypt" });
    calls[0]?.resolve(explained("goblin", "hit", [cellNode("old", "total")]));
    await flush();
    expect(highlight(ui)).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  test("a failed request highlights nothing and is not retried for the same key", async () => {
    const { ui, calls, set } = setup();
    ui.setHoveredCell({ object: "goblin", cell: "gone" });
    calls[0]?.reject(new ProtocolFailure("not_found", "not found"));
    await flush();
    expect(highlight(ui)).toEqual([]);
    ui.setCamera({ x: 1, y: 1, zoom: 1 });
    set({ viewVersion: 9 });
    expect(calls).toHaveLength(1);
    set({ revision: 6 });
    expect(calls).toHaveLength(2);
  });
});

describe("viewer switch", () => {
  test("at an unchanged revision, a hovered cell is explained again for the new viewer", async () => {
    const { ui, calls, set } = setup();
    ui.setHoveredCell({ object: "goblin", cell: "hit" });
    calls[0]?.resolve(
      explained("goblin", "hit", [cellNode("die", "total"), cellNode("trap", "z")]),
    );
    await flush();
    expect(highlight(ui)).toEqual(["die", "trap"]);
    set({ viewer: ALDRIC });
    // Nothing of the GM's answer is shown to Aldric while his is pending.
    expect(highlight(ui)).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.params).toEqual({
      object: "goblin",
      cell: "hit",
      depth: 1,
      viewer: { type: "character", id: "aldric" },
    });
    calls[1]?.resolve(explained("goblin", "hit", [cellNode("die", "total"), cellNode(null, "z")]));
    await flush();
    expect(highlight(ui)).toEqual(["die"]);
    // Back to the GM at the same revision: the GM's cached answer.
    set({ viewer: GM });
    expect(calls).toHaveLength(2);
    expect(highlight(ui)).toEqual(["die", "trap"]);
  });

  test("a GM answer arriving after the switch to Aldric is dropped", async () => {
    const { ui, calls, set } = setup();
    ui.setHoveredCell({ object: "goblin", cell: "hit" });
    set({ viewer: ALDRIC });
    calls[0]?.resolve(explained("goblin", "hit", [cellNode("trap", "z")]));
    await flush();
    expect(highlight(ui)).toEqual([]);
  });

  test("at an unchanged revision, a hovered zone asks zones again for the new viewer", async () => {
    const { ui, calls, set } = setup();
    ui.setHoveredZone("room");
    calls[0]?.resolve(zonesResult({ room: ["aldric", "trap"] }));
    await flush();
    expect(highlight(ui)).toEqual(["aldric", "trap"]);
    set({ viewer: ALDRIC });
    expect(highlight(ui)).toEqual([]);
    expect(calls[1]?.method).toBe("zones");
    expect(calls[1]?.params).toEqual({
      board: "gm_board",
      viewer: { type: "character", id: "aldric" },
    });
    calls[1]?.resolve(zonesResult({ room: ["aldric"] }));
    await flush();
    expect(highlight(ui)).toEqual(["aldric"]);
  });
});

describe("hovered zone", () => {
  test("asks zones for the active board and highlights that zone's contents", async () => {
    const { ui, calls } = setup();
    ui.setHoveredZone("room");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("zones");
    expect(calls[0]?.params).toEqual({ board: "gm_board", viewer: { type: "gm" } });
    calls[0]?.resolve(zonesResult({ hall: ["x"], room: ["aldric", "goblin"] }));
    await flush();
    expect(highlight(ui)).toEqual(["aldric", "goblin"]);
  });

  test("another zone on the same board at the same revision is a cache hit", async () => {
    const { ui, calls } = setup();
    ui.setHoveredZone("room");
    calls[0]?.resolve(zonesResult({ hall: ["x"], room: ["aldric"] }));
    await flush();
    ui.setHoveredZone("hall");
    expect(calls).toHaveLength(1);
    expect(highlight(ui)).toEqual(["x"]);
    ui.setHoveredZone("room");
    expect(calls).toHaveLength(1);
    expect(highlight(ui)).toEqual(["aldric"]);
  });

  test("a zone missing from the result (not visible) highlights nothing", async () => {
    const { ui, calls } = setup();
    ui.setHoveredZone("vault");
    calls[0]?.resolve(zonesResult({ room: ["aldric"] }));
    await flush();
    expect(highlight(ui)).toEqual([]);
  });

  test("with no active board, a hovered zone highlights nothing and asks nothing", async () => {
    const { ui, calls, set } = setup();
    set({ activeBoard: null });
    ui.setHoveredZone("room");
    expect(calls).toHaveLength(0);
    expect(highlight(ui)).toEqual([]);
  });
});

describe("precedence", () => {
  test("a hovered zone wins over a hovered cell, which returns when the zone hover ends", async () => {
    const { ui, calls } = setup();
    ui.setHoveredCell({ object: "goblin", cell: "hit" });
    calls[0]?.resolve(explained("goblin", "hit", [cellNode("die", "total")]));
    await flush();
    expect(highlight(ui)).toEqual(["die"]);
    ui.setHoveredZone("room");
    expect(highlight(ui)).toEqual([]);
    expect(calls[1]?.method).toBe("zones");
    calls[1]?.resolve(zonesResult({ room: ["aldric"] }));
    await flush();
    expect(highlight(ui)).toEqual(["aldric"]);
    ui.setHoveredZone(null);
    expect(calls).toHaveLength(2);
    expect(highlight(ui)).toEqual(["die"]);
    ui.setHoveredCell(null);
    expect(highlight(ui)).toEqual([]);
  });

  test("a cell answer arriving while a zone is hovered is not shown", async () => {
    const { ui, calls } = setup();
    ui.setHoveredCell({ object: "goblin", cell: "hit" });
    ui.setHoveredZone("room");
    calls[0]?.resolve(explained("goblin", "hit", [cellNode("die", "total")]));
    await flush();
    expect(highlight(ui)).toEqual([]);
    calls[1]?.resolve(zonesResult({ room: ["aldric"] }));
    await flush();
    expect(highlight(ui)).toEqual(["aldric"]);
  });
});

describe("disposer", () => {
  test("clears the highlight, drops pending responses and stops watching", async () => {
    const { ui, calls, stop, listeners } = setup();
    ui.setHoveredCell({ object: "goblin", cell: "hit" });
    calls[0]?.resolve(explained("goblin", "hit", [cellNode("die", "total")]));
    await flush();
    ui.setHoveredCell({ object: "goblin", cell: "ac" });
    stop();
    expect(highlight(ui)).toEqual([]);
    expect(listeners.size).toBe(0);
    calls[1]?.resolve(explained("goblin", "ac", [cellNode("shield", "bonus")]));
    await flush();
    expect(highlight(ui)).toEqual([]);
    ui.setHoveredCell({ object: "goblin", cell: "hit" });
    expect(calls).toHaveLength(2);
    expect(highlight(ui)).toEqual([]);
  });
});
