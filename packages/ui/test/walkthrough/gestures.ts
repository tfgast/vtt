/**
 * The walkthrough's UI gestures (vtt-nb8.18; M6 plan decisions Q2, Q13;
 * DESIGN.md §4.6 Gestures and On the canvas, §4.7; review r2 findings 2,
 * 3): `createGestures(ctx)` implements contract.ts's `Gestures` with
 * nothing but the `DriverContext`. Canvas gestures are pointer, wheel and
 * keyboard events on the app's canvas in client pixels (`ctx.toScreen`);
 * chrome gestures (board tabs, View as, "Move selection to board…", the
 * inspector, the Log tab) are Testing Library and user-event on `ctx.root`.
 *
 * Targets on faces are located on the face scene the app draws (its board
 * view, viewer and `ctx.faceState`) and every press is checked first with
 * `faceHitAt` (drops with `dropTargetAt`), so a gesture never lands on
 * something other than what it names.
 *
 * - `bringIntoView` (every gesture calls it on its targets first): chooses
 *   a zoom (1 when it fits, else the power of two nearest 1, else any zoom
 *   of the feasible interval nearest 1) at which every enclosing
 *   contents element and the target itself are at least their `min_size`
 *   and the target fits on screen, wheels each enclosing contents element
 *   (innermost first, over its chevron column) until the target is
 *   unclipped, then centres the camera on it (`ctx.setCamera`). It never
 *   expands an entry: a target inside a collapsed entry is not drawn, and
 *   it throws naming the target, as it does when the target is covered,
 *   not on the active board, or cannot be shown whole.
 * - A drag between two targets uses one camera showing both when one zoom
 *   satisfies both; otherwise it pans between the press and the drop (the
 *   camera is moved mid-drag, as a GM panning with the drag held would).
 *   Points are exact when they are dyadic (camera centres sit on a 1/64
 *   grid and zooms are powers of two whenever one fits).
 * - `elementShown` answers "drawn on screen now": present (show_when), at
 *   its min_size under the current camera with every list around it, its
 *   centre unclipped by those lists, on screen and not under a cover. Bring
 *   the element into view first when the camera may not show it.
 * - Gestures that write wait for the authority's revision to move (the GM
 *   assertion client sees every commit) and for the app's session to catch
 *   up; a gesture whose write is refused times out naming the notices.
 * - The Log tab: `logGroups` reads it and throws while it is closed;
 *   `logLoadOlder` opens it when closed (waiting for the newest group) and
 *   presses "Load older" when offered; `logFilterActor` chooses an Actor
 *   filter option and waits for its search. Inspector gestures switch to the
 *   Inspector tab and reopen the Log tab afterwards when it was open; every
 *   gesture that commits waits for the open Log tab to show the newest
 *   group, so `logGroups` is current after any awaited gesture.
 */
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Viewer } from "@vtt/protocol";
import type { Bounds, ObjectId, Rect } from "@vtt/schema";
import {
  type Affine,
  aabb,
  apply,
  buildFaceScene,
  type Camera,
  CONTENTS_ROW_RATIO,
  COVER_FILL,
  type ContentsPrimitive,
  compose,
  contentsRect,
  type DropTarget,
  dropTargetAt,
  entryTransform,
  FACE_WHEEL_PX_PER_UNIT,
  type FaceDrawing,
  type FaceEntry,
  type FaceHit,
  type FacePrimitive,
  type FaceScene,
  faceHitAt,
  hitsAt,
  IDENTITY,
  invert,
  isCovered,
  MAX_ZOOM,
  MIN_ZOOM,
  PX_PER_UNIT,
  pathContents,
  screenHeight,
  sessionNotices,
} from "@vtt/ui";
import { until } from "../support/authority";
import type {
  CreateGestures,
  DriverContext,
  EntryDropTarget,
  Gestures,
  LogGroupShown,
  Point,
  ViewTarget,
} from "./contract";

/** Pixels kept free at the viewport's edges when a camera is chosen. */
const EDGE_PX = 24;
/** How long a gesture's write may take to commit. */
const COMMIT_MS = 10_000;
/** How long chrome (a tab, a menu, the log) may take to answer. */
const CHROME_MS = 10_000;
/** The smallest on-screen size of a board object pressed on its body. */
const BODY_MIN_PX = 16;
/** Camera centres sit on this grid (board units), so dyadic points land exactly. */
const CENTRE_GRID = 64;
/** The zooms a camera is chosen from, all powers of two. */
const ZOOMS = [8, 4, 2, 1, 0.5, 0.25, 0.125, 1 / 16, 1 / 32] as const;
/** Screen pixels a drag moves before it leaves its press (past every drag threshold). */
const DRAG_START_PX = 12;

type Element = { cell: string } | { action: string };

/** Lets pending renders, effects and socket messages settle. */
const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

const centre = (r: Rect): Point => [r[0] + r[2] / 2, r[1] + r[3] / 2];
const snap = (x: number) => Math.round(x * CENTRE_GRID) / CENTRE_GRID;
const describeElement = (e: Element) => ("cell" in e ? `cell ${e.cell}` : `button ${e.action}`);

function inRect(p: Point, r: Rect, eps = 1e-6): boolean {
  return (
    p[0] >= r[0] - eps &&
    p[0] <= r[0] + r[2] + eps &&
    p[1] >= r[1] - eps &&
    p[1] <= r[1] + r[3] + eps
  );
}

const describeHit = (hit: FaceHit | null): string =>
  hit === null ? "nothing" : `${hit.object} ${JSON.stringify(hit.target)}`;

// ---------------------------------------------------------------------------
// Locating things on the face scene

/** A contents list a drawing sits in: its container, element and the container's frame → board. */
interface Clip {
  container: ObjectId;
  element: number;
  list: ContentsPrimitive;
  toBoard: Affine;
}

interface Located {
  id: ObjectId;
  /** Its drawing as shown: full on the board or expanded, collapsed in a row. */
  drawing: FaceDrawing | null;
  /** Its drawing's frame → board. */
  toBoard: Affine;
  /** The lists around it, outermost first (empty on the board). */
  clips: Clip[];
  /** Its row, when it is contained. */
  entry: { clip: Clip; entry: FaceEntry } | null;
}

/** Where `id` is drawn on `scene`: a board item, or an entry of a (nested) contents list. */
function locate(scene: FaceScene, id: ObjectId): Located | null {
  const search = (
    drawing: FaceDrawing,
    owner: ObjectId,
    toBoard: Affine,
    clips: Clip[],
  ): Located | null => {
    for (const prim of drawing.primitives) {
      if (prim.kind !== "contents") continue;
      const clip: Clip = { container: owner, element: prim.element, list: prim, toBoard };
      for (const entry of prim.entries) {
        if (entry.id === null) continue;
        const childToBoard = compose(toBoard, entryTransform(prim, entry));
        const inner = [...clips, clip];
        if (entry.id === id) {
          return {
            id,
            drawing: entry.drawing,
            toBoard: childToBoard,
            clips: inner,
            entry: { clip, entry },
          };
        }
        if (entry.drawing !== null) {
          const found = search(entry.drawing, entry.id, childToBoard, inner);
          if (found !== null) return found;
        }
      }
    }
    return null;
  };
  for (const item of scene.items) {
    const toBoard = scene.transforms.get(item.id);
    if (toBoard === undefined) continue;
    const drawing = scene.faces.get(item.id) ?? null;
    if (item.id === id) return { id, drawing, toBoard, clips: [], entry: null };
    if (drawing !== null) {
      const found = search(drawing, item.id, toBoard, []);
      if (found !== null) return found;
    }
  }
  return null;
}

/** The primitive of `drawing` showing `element`: an editor before a value for a cell. */
function primitiveOf(drawing: FaceDrawing | null, element: Element): FacePrimitive | undefined {
  const prims = drawing?.primitives ?? [];
  if ("action" in element) {
    return prims.find((p) => p.kind === "button" && p.action === element.action);
  }
  return (
    prims.find((p) => p.kind === "editor" && p.cell === element.cell) ??
    prims.find(
      (p) =>
        (p.kind === "text" || p.kind === "image" || p.kind === "ink") &&
        p.target.type === "value" &&
        p.target.cell === element.cell,
    )
  );
}

/** A primitive (or a pseudo one) that must be drawn: at least `minSize` px high. */
interface Show {
  rect: Rect;
  toBoard: Affine;
  minSize: number;
}

/**
 * What a gesture brings into view and presses: a rect in a frame, the lists
 * around it, what must be drawn at its size, and which hits count as it.
 */
interface Spot {
  what: string;
  rect: Rect;
  toBoard: Affine;
  clips: Clip[];
  shows: Show[];
  accept(hit: FaceHit | null, p: Point, scene: FaceScene, camera: Camera): boolean;
}

/** What a spot is resolved from (re-resolved after every scroll). */
type Aim =
  | { kind: "board"; id: ObjectId; use: "body" | "press" | "under" }
  | { kind: "entry"; container: ObjectId; entry: ObjectId; part: "row" | "chevron" | "gear" }
  | { kind: "element"; object: ObjectId; element: Element }
  | { kind: "contents"; object: ObjectId }
  | { kind: "board-gear"; id: ObjectId };

const listShows = (clips: readonly Clip[]): Show[] =>
  clips.map((c) => ({ rect: c.list.rect, toBoard: c.toBoard, minSize: c.list.minSize }));

function aimName(aim: Aim): string {
  switch (aim.kind) {
    case "board":
      return aim.id;
    case "entry":
      return `${aim.container}'s entry ${aim.entry}${aim.part === "row" ? "" : ` (${aim.part})`}`;
    case "element":
      return `${aim.object}'s ${describeElement(aim.element)}`;
    case "contents":
      return `${aim.object}'s contents list`;
    case "board-gear":
      return `${aim.id}'s gear`;
  }
}

function resolveSpot(scene: FaceScene, aim: Aim): Spot {
  const what = aimName(aim);
  switch (aim.kind) {
    case "board":
    case "board-gear": {
      const item = scene.items.find((i) => i.id === aim.id);
      if (item === undefined) {
        throw new Error(`bringIntoView: ${what} is not drawn on the active board`);
      }
      if (aim.kind === "board-gear") {
        const drawing = scene.faces.get(aim.id) ?? null;
        const gear = drawing?.primitives.find((p) => p.kind === "gear");
        const toBoard = scene.transforms.get(aim.id) ?? IDENTITY;
        if (gear === undefined) throw new Error(`bringIntoView: ${what} is not drawn`);
        return {
          what,
          rect: gear.rect,
          toBoard,
          clips: [],
          shows: [{ rect: gear.rect, toBoard, minSize: gear.minSize }],
          accept: (hit) => hit?.target.type === "gear" && hit.target.id === aim.id,
        };
      }
      const b = item.bounds;
      const rect: Rect = [b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY];
      const side = Math.min(rect[2], rect[3]);
      return {
        what,
        rect,
        toBoard: IDENTITY,
        clips: [],
        shows:
          side > 0 ? [{ rect: [0, 0, side, side], toBoard: IDENTITY, minSize: BODY_MIN_PX }] : [],
        accept: (hit, p, s, cam) => {
          if (aim.use === "under") {
            // Anywhere in the hit list, under a plain body (so the press reaches the select tool).
            if (!hitsAt(s, p, cam).includes(aim.id)) return false;
            return hit === null || (hit.path.length === 0 && hit.target.type === "body");
          }
          if (hit?.object !== aim.id || hit.path.length > 0) return false;
          if (hitsAt(s, p, cam)[0] !== aim.id) return false;
          if (aim.use === "body") return hit.target.type === "body";
          return hit.target.type === "body" || hit.target.type === "value";
        },
      };
    }
    case "entry": {
      const l = locate(scene, aim.entry);
      if (l?.entry == null) {
        throw new Error(
          `bringIntoView: ${what} is not drawn (is ${aim.container} on the active board, with every entry around it expanded, and selected when its list shows only when selected?)`,
        );
      }
      const { clip, entry } = l.entry;
      if (clip.container !== aim.container) {
        throw new Error(
          `bringIntoView: ${aim.entry} is drawn in ${clip.container}, not ${aim.container}`,
        );
      }
      const list = clip.list;
      const id = aim.entry;
      if (aim.part === "chevron" || aim.part === "gear") {
        const r = aim.part === "chevron" ? entry.chevron : entry.gear;
        if (r === undefined)
          throw new Error(`bringIntoView: ${what}: ${id} is not a template entry`);
        const part = aim.part;
        return {
          what,
          rect: contentsRect(list, r),
          toBoard: clip.toBoard,
          clips: l.clips,
          shows: listShows(l.clips),
          accept: (hit) => hit?.target.type === part && hit.target.id === id,
        };
      }
      // The row's top strip (an expanded row is its drawing, which may be tall).
      const rowH = list.rect[2] * CONTENTS_ROW_RATIO;
      const r: Rect = [entry.row[0], entry.row[1], entry.row[2], Math.min(entry.row[3], rowH)];
      return {
        what,
        rect: contentsRect(list, r),
        toBoard: clip.toBoard,
        clips: l.clips,
        shows: listShows(l.clips),
        accept: (hit) =>
          (hit?.target.type === "entry" && hit.target.id === id) ||
          (hit?.target.type === "body" && hit.object === id && hit.path.length > 0),
      };
    }
    case "element": {
      const l = locate(scene, aim.object);
      if (l === null) {
        throw new Error(`bringIntoView: ${what}: ${aim.object} is not drawn on the active board`);
      }
      const prim = primitiveOf(l.drawing, aim.element);
      if (prim === undefined) {
        const collapsed = l.entry !== null && !l.entry.entry.expanded;
        throw new Error(
          `bringIntoView: ${what} is not drawn${collapsed ? ` (${aim.object} is a collapsed entry of ${l.entry?.clip.container}: expand it first)` : ""}`,
        );
      }
      const element = aim.element;
      return {
        what,
        rect: prim.rect,
        toBoard: l.toBoard,
        clips: l.clips,
        shows: [
          ...listShows(l.clips),
          { rect: prim.rect, toBoard: l.toBoard, minSize: prim.minSize },
        ],
        accept: (hit) => {
          if (hit?.object !== aim.object) return false;
          const t = hit.target;
          if ("action" in element) return t.type === "button" && t.action === element.action;
          return (t.type === "editor" || t.type === "value") && t.cell === element.cell;
        },
      };
    }
    case "contents": {
      const l = locate(scene, aim.object);
      if (l === null) {
        throw new Error(`bringIntoView: ${what}: ${aim.object} is not drawn on the active board`);
      }
      const list = l.drawing?.primitives.find((p): p is ContentsPrimitive => p.kind === "contents");
      if (list === undefined) {
        const collapsed = l.entry !== null && !l.entry.entry.expanded;
        throw new Error(
          `bringIntoView: ${what} is not drawn${collapsed ? ` (${aim.object} is collapsed: expand it first)` : ` (if its list shows only when selected, select ${aim.object} first)`}`,
        );
      }
      const object = aim.object;
      return {
        what,
        rect: list.rect,
        toBoard: l.toBoard,
        clips: l.clips,
        shows: [
          ...listShows(l.clips),
          { rect: list.rect, toBoard: l.toBoard, minSize: list.minSize },
        ],
        accept: (_hit, p, s, cam) => {
          const drop = dropTargetAt(s, p, cam, []);
          return drop.kind === "contents" && drop.container === object;
        },
      };
    }
  }
}

/** The spot's board-space box. */
const boundsOf = (spot: Spot): Bounds => aabb(spot.rect, spot.toBoard);

/** Whether every corner of the spot is inside clip `c`'s list rect. */
function insideClip(spot: Spot, c: Clip): boolean {
  const [x, y, w, h] = spot.rect;
  const toClip = compose(invert(c.toBoard), spot.toBoard);
  const corners: Point[] = [
    [x, y],
    [x + w, y],
    [x, y + h],
    [x + w, y + h],
  ];
  return corners.every((q) => inRect(apply(toClip, q), c.list.rect));
}

const pointInClip = (c: Clip, p: Point): boolean =>
  inRect(apply(invert(c.toBoard), p), c.list.rect, 0);

/** The smallest zoom at which every one of `shows` is drawn. */
function minZoom(shows: readonly Show[]): number {
  let z = MIN_ZOOM;
  for (const s of shows) {
    const at1 = screenHeight(s.rect, s.toBoard, { x: 0, y: 0, zoom: 1 });
    if (at1 > 0 && s.minSize > 0) z = Math.max(z, (s.minSize / at1) * (1 + 1e-9));
  }
  return z;
}

/** The largest zoom at which `b` fits in the viewport (with margins). */
function fitZoom(b: Bounds, viewport: { width: number; height: number }): number {
  const w = (b.maxX - b.minX) * PX_PER_UNIT;
  const h = (b.maxY - b.minY) * PX_PER_UNIT;
  const zw = w > 0 ? (viewport.width - 2 * EDGE_PX) / w : Number.POSITIVE_INFINITY;
  const zh = h > 0 ? (viewport.height - 2 * EDGE_PX) / h : Number.POSITIVE_INFINITY;
  return Math.min(zw, zh, MAX_ZOOM);
}

/**
 * A zoom in `[lo, hi]`: 1 when it fits, else the power of two nearest 1, else
 * (no power of two inside) the zoom of the interval nearest 1; null when empty.
 */
export function pickZoom(lo: number, hi: number): number | null {
  if (lo <= 1 && 1 <= hi) return 1;
  const power =
    hi < 1
      ? ZOOMS.find((z) => z <= hi && z >= lo)
      : [...ZOOMS].reverse().find((z) => z >= lo && z <= hi);
  if (power !== undefined) return power;
  // No power of two in the interval: the zoom in it nearest 1.
  const a = Math.max(lo, MIN_ZOOM);
  const b = Math.min(hi, MAX_ZOOM);
  if (a > b) return null;
  return b < 1 ? b : a;
}

function union(a: Bounds, b: Bounds): Bounds {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

const pointBounds = (p: Point): Bounds => ({ minX: p[0], minY: p[1], maxX: p[0], maxY: p[1] });

/** Grid points of the spot's rect (board units), nearest its centre first. */
function candidatePoints(spot: Spot, n = 16): Point[] {
  const [x, y, w, h] = spot.rect;
  const local: Point[] = [];
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) local.push([x + (w * i) / n, y + (h * j) / n]);
  }
  const c = centre(spot.rect);
  local.sort((p, q) => Math.hypot(p[0] - c[0], p[1] - c[1]) - Math.hypot(q[0] - c[0], q[1] - c[1]));
  return local.map((p) => apply(spot.toBoard, p));
}

// ---------------------------------------------------------------------------
// Keys

interface KeyInit {
  key: string;
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

const NAMED_KEYS: Readonly<Record<string, string>> = {
  delete: "Delete",
  del: "Delete",
  backspace: "Backspace",
  escape: "Escape",
  esc: "Escape",
  enter: "Enter",
  tab: "Tab",
  space: " ",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
};

const CODES: Readonly<Record<string, string>> = {
  "[": "BracketLeft",
  "]": "BracketRight",
  "?": "Slash",
  "/": "Slash",
  " ": "Space",
};

/** "Ctrl+Z", "Shift+?", "Delete", "r": a key press's `KeyboardEvent` fields. */
export function parseKeyCombo(combo: string): KeyInit {
  const parts = combo.split("+");
  // "Ctrl++" names the plus key.
  if (combo.endsWith("++")) parts.splice(-2, 2, "+");
  const last = parts.pop();
  if (last === undefined || last === "") throw new Error(`key: no key in "${combo}"`);
  const init: KeyInit = {
    key: "",
    code: "",
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
  };
  for (const m of parts) {
    const k = m.toLowerCase();
    if (k === "ctrl" || k === "control") init.ctrlKey = true;
    else if (k === "shift") init.shiftKey = true;
    else if (k === "alt" || k === "option") init.altKey = true;
    else if (k === "meta" || k === "cmd") init.metaKey = true;
    else throw new Error(`key: unknown modifier "${m}" in "${combo}"`);
  }
  const named = NAMED_KEYS[last.toLowerCase()];
  if (named !== undefined) {
    init.key = named;
    init.code = named === " " ? "Space" : named;
  } else if (last.length === 1) {
    const letter = /[a-z]/i.test(last);
    init.key = letter ? (init.shiftKey ? last.toUpperCase() : last.toLowerCase()) : last;
    init.code = letter
      ? `Key${last.toUpperCase()}`
      : /[0-9]/.test(last)
        ? `Digit${last}`
        : (CODES[last] ?? last);
  } else {
    init.key = last;
    init.code = last;
  }
  return init;
}

// ---------------------------------------------------------------------------

/** The GM's gestures through the real UI of `ctx` (contract.ts `Gestures`). */
export const createGestures: CreateGestures = (ctx: DriverContext): Gestures => {
  const user = userEvent.setup({ delay: null });

  // -- the app

  const canvas = (): HTMLCanvasElement => {
    const c = ctx.root.querySelector("canvas");
    if (c === null) throw new Error("the app has no board canvas");
    return c;
  };
  const camera = (): Camera => ctx.ui.getState().camera;
  const viewport = () => {
    const { width, height } = ctx.ui.getState().viewport;
    return { width, height };
  };
  const viewer = (): Viewer => ctx.session.getSnapshot().viewer;

  /**
   * The face scene the app draws now (its board view, viewer, selection and
   * face state): a `when_selected` list (M6-D12) is in it only while its
   * object, or something inside it, is selected.
   */
  const faces = (): FaceScene => {
    const view = ctx.session.boardView();
    if (view === null) throw new Error("the app shows no board");
    return buildFaceScene(
      {
        views: view.objects.values(),
        covers: [...view.covers.values()],
        board: view.board,
        viewer: viewer(),
        selection: ctx.ui.getState().selection,
      },
      { faceState: ctx.faceState },
    );
  };

  const onScreen = (p: Point, margin = 2): boolean => {
    const [x, y] = ctx.toScreen(p);
    const v = viewport();
    return x >= margin && y >= margin && x <= v.width - margin && y <= v.height - margin;
  };

  const setCamera = async (center: Point, zoom: number): Promise<void> => {
    await ctx.setCamera({ center: [snap(center[0]), snap(center[1])], zoom });
  };

  // -- pointer, wheel and key events on the canvas

  interface Mods {
    alt?: boolean;
    shift?: boolean;
  }

  const pointer = (type: "down" | "move" | "up", p: Point, mods: Mods = {}): void => {
    const [clientX, clientY] = ctx.toScreen(p);
    const init = {
      pointerId: 1,
      clientX,
      clientY,
      button: type === "move" ? -1 : 0,
      buttons: type === "up" ? 0 : 1,
      altKey: mods.alt === true,
      shiftKey: mods.shift === true,
    };
    const c = canvas();
    act(() => {
      if (type === "down") fireEvent.pointerDown(c, init);
      else if (type === "move") fireEvent.pointerMove(c, init);
      else fireEvent.pointerUp(c, init);
    });
  };

  const tap = (p: Point, mods: Mods = {}): void => {
    pointer("down", p, mods);
    pointer("up", p, mods);
  };

  const doubleTap = (p: Point): void => {
    tap(p);
    tap(p);
    const [clientX, clientY] = ctx.toScreen(p);
    const c = canvas();
    act(() => {
      fireEvent.doubleClick(c, { clientX, clientY });
    });
  };

  const wheel = (p: Point, deltaY: number): void => {
    const [clientX, clientY] = ctx.toScreen(p);
    const c = canvas();
    act(() => {
      fireEvent.wheel(c, { clientX, clientY, deltaY, deltaMode: 0 });
    });
  };

  const pressKey = (combo: string): void => {
    const init = parseKeyCombo(combo);
    const c = canvas();
    act(() => {
      fireEvent.keyDown(c, init);
      fireEvent.keyUp(c, init);
    });
  };

  // -- commits

  /** The newest log group's index the current viewer sees, or null. */
  const newestIndex = async (): Promise<number | null> => {
    const log = await ctx.gm.request("log", { limit: 1, viewer: viewer() });
    return log.groups[0]?.index ?? null;
  };

  const notices = (): string[] =>
    sessionNotices(ctx.session)
      .list()
      .map((n) => n.text);

  /** Waits until the app's session has seen the authority's latest revision. */
  const caughtUp = async (): Promise<void> => {
    // A round trip on the GM client delivers every commit made before it.
    await ctx.gm.request("log", { limit: 1 });
    const revision = ctx.gm.revision;
    await act(() => ctx.session.whenRevision(revision));
    await settle(20);
    await ctx.frame();
  };

  /** Waits for a commit after `before` (the GM client's revision), then for the app and the log. */
  const committed = async (before: number, what: string): Promise<void> => {
    try {
      await until(() => ctx.gm.revision > before, what, COMMIT_MS);
    } catch {
      const shown = notices();
      throw new Error(
        `${what}: nothing was committed${shown.length > 0 ? `; notices: ${JSON.stringify(shown)}` : ""}`,
      );
    }
    await caughtUp();
    await syncLog();
  };

  // -- the inspector panel and its tabs

  const inspector = (): HTMLElement =>
    within(ctx.root).getByRole("complementary", { name: "Inspector panel" });

  const tabOf = (name: "Inspector" | "Objects" | "Log"): HTMLElement =>
    within(inspector()).getByRole("tab", { name });

  const logOpen = (): boolean => {
    const panel = ctx.root.querySelector('aside[aria-label="Inspector panel"]');
    if (panel === null) return false;
    return (
      within(panel as HTMLElement).queryByRole("tab", { name: "Log", selected: true }) !== null
    );
  };

  const selectTab = async (name: "Inspector" | "Log"): Promise<void> => {
    const tab = tabOf(name);
    if (tab.getAttribute("aria-selected") !== "true") await user.click(tab);
    await waitFor(() => {
      if (tabOf(name).getAttribute("aria-selected") !== "true") throw new Error(`${name} tab`);
    });
  };

  const logList = (): HTMLElement | null =>
    within(inspector()).queryByRole("list", { name: "Log entries" });

  const loadOlder = (): HTMLElement | null =>
    within(inspector()).queryByRole("button", { name: "Load older" });

  const logRows = (): HTMLElement[] => [
    ...(logList()?.querySelectorAll<HTMLElement>("li[data-log-index]") ?? []),
  ];

  /** With the Log tab open: waits until it shows the newest group the viewer sees. */
  const syncLog = async (): Promise<void> => {
    if (!logOpen()) return;
    const newest = await newestIndex();
    await until(
      () => {
        const list = logList();
        if (list === null) return false;
        if (newest === null) return true;
        return list.querySelector(`li[data-log-index="${newest}"]`) !== null;
      },
      "the Log tab's newest group",
      CHROME_MS,
    );
    await settle(20);
  };

  const openLog = async (): Promise<void> => {
    await selectTab("Log");
    await syncLog();
  };

  /** Runs `fn` on the Inspector tab, reopening the Log tab afterwards when it was open. */
  const onInspector = async <T>(fn: () => Promise<T>): Promise<T> => {
    const wasLog = logOpen();
    await selectTab("Inspector");
    try {
      return await fn();
    } finally {
      if (wasLog) await openLog();
    }
  };

  // -- bringing things into view

  /** Turns the wheel over clip `i`'s chevron column so the spot's centre moves to the list's middle. */
  const wheelClip = async (
    clips: readonly Clip[],
    i: number,
    target: Point,
    zoom: number,
  ): Promise<boolean> => {
    const clip = clips[i] as Clip;
    const list = clip.list;
    const q = apply(invert(clip.toBoard), target);
    const dy = q[1] - (list.rect[1] + list.rect[3] / 2);
    const column = list.rect[0] + (list.rect[2] * CONTENTS_ROW_RATIO) / 2;
    const want = `${clip.container}/${clip.element}`;
    const before = ctx.faceState.scrollOffset(clip.container, clip.element);
    for (const f of [0.5, 0.3, 0.7, 0.15, 0.85, 0.05, 0.95]) {
      const at = apply(clip.toBoard, [column, list.rect[1] + list.rect[3] * f]);
      if (!clips.slice(0, i).every((c) => pointInClip(c, at))) continue;
      await setCamera(at, zoom);
      const scrolled = wheelTargetAt(faces(), at, camera());
      if (scrolled !== want) continue;
      const exact = ctx.toBoard(ctx.toScreen(at));
      wheel(exact, dy * FACE_WHEEL_PX_PER_UNIT);
      await settle(10);
      await ctx.frame();
      return ctx.faceState.scrollOffset(clip.container, clip.element) !== before;
    }
    return false;
  };

  /** The (container, element) the wheel at `p` scrolls (face-tool's `scrollAt`), or null. */
  function wheelTargetAt(scene: FaceScene, p: Point, cam: Camera): string | null {
    const hit = faceHitAt(scene, p, cam);
    if (hit === null) return null;
    const steps = hit.path.map((s) => ({ container: s.container, element: s.element }));
    if (hit.target.type === "contents") {
      steps.push({ container: hit.target.container, element: hit.target.element });
    }
    const lists = pathContents(scene, steps);
    for (let k = lists.length - 1; k >= 0; k--) {
      const list = lists[k];
      const step = steps[k];
      if (list !== undefined && step !== undefined && list.maxOffset > 0) {
        return `${step.container}/${step.element}`;
      }
    }
    return null;
  }

  /** The zoom a spot is worked at, or a throw naming it. */
  const zoomFor = (spot: Spot): number => {
    const lo = minZoom(spot.shows);
    const hi = fitZoom(boundsOf(spot), viewport());
    const z = pickZoom(lo, hi);
    if (z === null) {
      throw new Error(
        `bringIntoView: ${spot.what} cannot be shown whole at its min_size (zoom ≥ ${lo.toFixed(4)}, ≤ ${hi.toFixed(4)})`,
      );
    }
    return z;
  };

  /** Scrolls the lists around the aim until it is unclipped; returns its spot and zoom. */
  const scrollTo = async (aim: Aim): Promise<{ spot: Spot; zoom: number }> => {
    const trail: string[] = [];
    for (let round = 0; round < 32; round++) {
      const scene = faces();
      const spot = resolveSpot(scene, aim);
      const zoom = zoomFor(spot);
      const failing = spot.clips.flatMap((c, i) => (insideClip(spot, c) ? [] : [i]));
      if (failing.length === 0) return { spot, zoom };
      const target = apply(spot.toBoard, centre(spot.rect));
      trail.push(
        failing
          .map((i) => {
            const c = spot.clips[i] as Clip;
            return `${c.container}/${c.element} offset ${c.list.offset.toFixed(3)} of ${c.list.maxOffset.toFixed(3)}`;
          })
          .join(", "),
      );
      let turned = false;
      for (const i of [...failing].reverse()) {
        if (await wheelClip(spot.clips, i, target, zoom)) {
          turned = true;
          break;
        }
      }
      if (!turned) {
        // Bring the innermost failing list into the lists around it.
        const k = failing.at(-1) as number;
        const inner = spot.clips[k] as Clip;
        const c = apply(inner.toBoard, centre(inner.list.rect));
        const outer = spot.clips.slice(0, k).findIndex((x) => !pointInClip(x, c));
        if (outer === -1 || !(await wheelClip(spot.clips, outer, c, zoom))) {
          throw new Error(
            `bringIntoView: ${spot.what} cannot be scrolled into its lists: ${trail.join("; ")}`,
          );
        }
      }
    }
    throw new Error(`bringIntoView: the wheel never revealed ${aimName(aim)}: ${trail.join("; ")}`);
  };

  /** A board point pressing the spot under the current camera, or null. */
  const pressPoint = (
    spot: Spot,
    scene: FaceScene,
    accept?: (p: Point) => boolean,
  ): Point | null => {
    const cam = camera();
    for (const p of candidatePoints(spot)) {
      if (!onScreen(p, EDGE_PX / 2)) continue;
      if (!spot.clips.every((c) => pointInClip(c, p))) continue;
      if (!spot.accept(faceHitAt(scene, p, cam), p, scene, cam)) continue;
      if (accept !== undefined && !accept(p)) continue;
      return p;
    }
    return null;
  };

  /** Brings the aim into view (scrolling, then centring the camera); returns a press point. */
  const reveal = async (aim: Aim): Promise<Point> => {
    const { zoom } = await scrollTo(aim);
    const first = resolveSpot(faces(), aim);
    const b = boundsOf(first);
    await setCamera([(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2], zoom);
    const scene = faces();
    const spot = resolveSpot(scene, aim);
    const cam = camera();
    const short = spot.shows.find((s) => screenHeight(s.rect, s.toBoard, cam) < s.minSize);
    if (short !== undefined) {
      throw new Error(`bringIntoView: ${spot.what} is below its min_size at zoom ${cam.zoom}`);
    }
    const p = pressPoint(spot, scene);
    if (p === null) {
      const mid = apply(spot.toBoard, centre(spot.rect));
      throw new Error(
        `bringIntoView: no point of ${spot.what} can be pressed (covered or under another object?); its centre hits ${describeHit(faceHitAt(scene, mid, cam))}`,
      );
    }
    return p;
  };

  /** The board, if any, `id` is drawn on: its outermost container's, from the directory. */
  const containerOf = (id: ObjectId): ObjectId | null => {
    const v = ctx.session.directory().get(id)?.cells.container?.value as
      | { type?: string; object?: string }
      | undefined;
    return v?.type === "ref" && typeof v.object === "string" ? v.object : null;
  };

  const aimOf = (target: ViewTarget, use: "body" | "press" = "press"): Aim => {
    if (typeof target === "string") {
      const container = containerOf(target);
      return container === null
        ? { kind: "board", id: target, use }
        : { kind: "entry", container, entry: target, part: "row" };
    }
    if ("element" in target)
      return { kind: "element", object: target.object, element: target.element };
    return { kind: "entry", container: target.container, entry: target.entry, part: "row" };
  };

  // -- drags

  type DropAim =
    | { kind: "point"; to: Point }
    | { kind: "editor"; object: ObjectId; cell: string }
    | { kind: "contents"; object: ObjectId };

  const dropAimOf = (to: EntryDropTarget): DropAim => {
    if (Array.isArray(to)) return { kind: "point", to: to as Point };
    const t = to as { object: ObjectId; cell?: string; contents?: true };
    if (t.cell !== undefined) return { kind: "editor", object: t.object, cell: t.cell };
    return { kind: "contents", object: t.object };
  };

  /** The editor element index of `object.cell` on `scene`, for checking a drop. */
  const editorElement = (scene: FaceScene, object: ObjectId, cell: string): number | null => {
    const l = locate(scene, object);
    const prim = l?.drawing?.primitives.find((p) => p.kind === "editor" && p.cell === cell);
    return prim?.element ?? null;
  };

  const dropMatches = (drop: DropTarget, aim: DropAim, scene: FaceScene, alt: boolean): boolean => {
    switch (aim.kind) {
      case "point":
        return alt || drop.kind === "board";
      case "editor":
        return (
          drop.kind === "editor" &&
          drop.object === aim.object &&
          drop.element === editorElement(scene, aim.object, aim.cell)
        );
      case "contents":
        return drop.kind === "contents" && drop.container === aim.object;
    }
  };

  const describeDrop = (aim: DropAim): string =>
    aim.kind === "point"
      ? `board point ${JSON.stringify(aim.to)}`
      : aim.kind === "editor"
        ? `${aim.object}'s editor ${aim.cell}`
        : `${aim.object}'s contents list`;

  /**
   * Drags what `press` aims at (a board object's body or an entry's row) to
   * `drop`. `release` maps the chosen press point to its release point for a
   * board-point drop (an object's grab offset kept). Waits for the commit.
   * A board object's drag starts from no selection; an entry drag, which
   * leaves the selection alone until the drop, keeps it, so the list it
   * starts in or drops on stays shown when that list shows only while its
   * object is selected (M6-D12): select that object first.
   */
  const dragAims = async (
    press: Aim,
    dragged: ObjectId,
    drop: DropAim,
    options: { alt?: boolean; release?: (p: Point) => Point },
  ): Promise<void> => {
    const alt = options.alt === true;
    if (press.kind !== "entry") await clearSelection();
    await reveal(press);
    let dropSpotAim: Aim | null = null;
    if (drop.kind === "editor") {
      dropSpotAim = { kind: "element", object: drop.object, element: { cell: drop.cell } };
    } else if (drop.kind === "contents") {
      dropSpotAim = { kind: "contents", object: drop.object };
    }
    if (dropSpotAim !== null) {
      await scrollTo(dropSpotAim);
      // The press must still be unclipped (both may share a list).
      const again = resolveSpot(faces(), press);
      if (!again.clips.every((c) => insideClip(again, c))) {
        throw new Error(
          `${describeDrop(drop)} and ${aimName(press)} cannot both be shown in their lists`,
        );
      }
    }

    const releaseOf = (p: Point, scene: FaceScene): Point | null => {
      const cam = camera();
      if (drop.kind === "point") {
        const r = options.release === undefined ? drop.to : options.release(p);
        if (!onScreen(r, EDGE_PX / 2)) return null;
        return dropMatches(dropTargetAt(scene, r, cam, [dragged]), drop, scene, alt) ? r : null;
      }
      const spot = resolveSpot(scene, dropSpotAim as Aim);
      for (const q of candidatePoints(spot)) {
        if (!onScreen(q, EDGE_PX / 2)) continue;
        if (!spot.clips.every((c) => pointInClip(c, q))) continue;
        if (dropMatches(dropTargetAt(scene, q, cam, [dragged]), drop, scene, alt)) return q;
      }
      return null;
    };

    // One camera showing both, when a zoom fits both.
    const pressSpot = resolveSpot(faces(), press);
    const pressZoomLo = minZoom(pressSpot.shows);
    let dropBounds: Bounds;
    let dropLo = MIN_ZOOM;
    if (drop.kind === "point") {
      const anchorGuess =
        options.release === undefined
          ? drop.to
          : options.release(apply(pressSpot.toBoard, centre(pressSpot.rect)));
      dropBounds = pointBounds(anchorGuess);
    } else {
      const spot = resolveSpot(faces(), dropSpotAim as Aim);
      dropBounds = boundsOf(spot);
      dropLo = Math.max(dropLo, minZoom(spot.shows));
    }
    const both = union(boundsOf(pressSpot), dropBounds);
    const zoom = pickZoom(Math.max(pressZoomLo, dropLo), fitZoom(both, viewport()));
    let from: Point | null = null;
    let to: Point | null = null;
    if (zoom !== null) {
      await setCamera([(both.minX + both.maxX) / 2, (both.minY + both.maxY) / 2], zoom);
      const scene = faces();
      from = pressPoint(resolveSpot(scene, press), scene, (p) => releaseOf(p, scene) !== null);
      to = from === null ? null : releaseOf(from, scene);
    }
    const mods = { alt };
    if (from !== null && to !== null) {
      const before = ctx.gm.revision;
      const [fx, fy] = ctx.toScreen(from);
      const [tx, ty] = ctx.toScreen(to);
      const len = Math.hypot(tx - fx, ty - fy) || 1;
      const step = ctx.toBoard([
        fx + ((tx - fx) / len) * DRAG_START_PX,
        fy + ((ty - fy) / len) * DRAG_START_PX,
      ]);
      pointer("down", from, mods);
      pointer("move", step, mods);
      pointer("move", to, mods);
      pointer("up", to, mods);
      await committed(before, `${aimName(press)} dragged to ${describeDrop(drop)}`);
      return;
    }

    // Two cameras: press under the press's camera, pan, drop under the drop's.
    const p = await reveal(press);
    const pressCam = camera();
    const [px, py] = ctx.toScreen(p);
    const v = viewport();
    const away: Point = ctx.toBoard([px + (px < v.width / 2 ? DRAG_START_PX : -DRAG_START_PX), py]);
    let dropCentre: Point;
    let zoomB: number;
    if (drop.kind === "point") {
      const r = options.release === undefined ? drop.to : options.release(p);
      dropCentre = r;
      zoomB = pressCam.zoom;
    } else {
      const spot = resolveSpot(faces(), dropSpotAim as Aim);
      const b = boundsOf(spot);
      dropCentre = [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
      zoomB = zoomFor(spot);
    }
    const before = ctx.gm.revision;
    pointer("down", p, mods);
    pointer("move", away, mods);
    await setCamera(dropCentre, zoomB);
    const scene = faces();
    const r = releaseOf(p, scene);
    if (r === null) {
      act(() => {
        fireEvent.pointerCancel(canvas(), { pointerId: 1 });
      });
      const at =
        drop.kind === "point"
          ? `: it resolves to ${JSON.stringify(dropTargetAt(scene, dropCentre, camera(), [dragged]))}`
          : "";
      throw new Error(`${aimName(press)}: ${describeDrop(drop)} does not take the drop${at}`);
    }
    pointer("move", r, mods);
    pointer("up", r, mods);
    await committed(before, `${aimName(press)} dragged to ${describeDrop(drop)}`);
  };

  /** Clears the selection with Escape on the canvas (the select tool, no gesture in progress). */
  const clearSelection = async (): Promise<void> => {
    if (ctx.ui.getState().selection.length === 0) return;
    if (ctx.ui.getState().tool.id !== "select") return;
    pressKey("Escape");
    await until(() => ctx.ui.getState().selection.length === 0, "the selection cleared", CHROME_MS);
  };

  /** Makes `id` the only selection with a click (its body, or its row), unless it already is. */
  const select = async (id: ObjectId): Promise<void> => {
    const sel = ctx.ui.getState().selection;
    if (sel.length === 1 && sel[0] === id) return;
    await clickTarget(id);
    await until(() => ctx.ui.getState().selection.join() === id, `${id} selected`, CHROME_MS);
  };

  /**
   * Clicks `id` with the select tool (its body, or its row). A board object
   * that is never first under the pointer (a zone under a map image: objects
   * are hit before zones, DESIGN.md §4.6) is pressed where it is in the hit
   * list, then Alt+clicked at that same point until the cycle reaches it.
   */
  const clickTarget = async (id: ObjectId): Promise<void> => {
    if (ctx.ui.getState().tool.id !== "select") pressKey("v");
    const aim = aimOf(id);
    let p: Point;
    try {
      p = await reveal(aim);
    } catch (e) {
      if (aim.kind !== "board") throw e;
      p = await reveal({ ...aim, use: "under" }).catch(() => {
        throw e;
      });
    }
    tap(p);
    await settle(20);
    await cycleTo(id, p);
  };

  const selectedIs = (id: ObjectId): boolean => ctx.ui.getState().selection.join() === id;

  /**
   * After a plain click at `p` left something else selected, Alt+clicks at
   * `p` (no movement, so within `ALT_CYCLE_RADIUS_PX`) at most once per hit
   * there until `id` is the selection. A first Alt+click selects the first
   * hit, each next one the following hit.
   */
  const cycleTo = async (id: ObjectId, p: Point): Promise<void> => {
    if (selectedIs(id)) return;
    const hits = hitsAt(faces(), p, camera());
    if (!hits.includes(id)) return;
    for (let i = 0; i < hits.length && !selectedIs(id); i++) {
      tap(p, { alt: true });
      await settle(20);
    }
    if (!selectedIs(id)) {
      throw new Error(
        `click: Alt+click cycling at ${JSON.stringify(p)} never selected ${id} (hits ${hits.join(", ")}; selection ${ctx.ui.getState().selection.join(", ") || "none"})`,
      );
    }
  };

  /** The `li` of `cell` in the inspector's cell list (the Structural group opened when needed). */
  const cellRow = async (object: ObjectId, cell: string): Promise<HTMLElement> => {
    const cells = await waitFor(() => within(inspector()).getByRole("region", { name: "Cells" }), {
      timeout: CHROME_MS,
    });
    let row = cells.querySelector<HTMLElement>(`li[data-cell="${cell}"]`);
    if (row === null) {
      const structural = within(cells).queryByRole("button", { name: "Structural" });
      if (structural?.getAttribute("aria-expanded") === "false") await user.click(structural);
      row = await waitFor(
        () => {
          const r = inspector().querySelector<HTMLElement>(
            `section[aria-label="Cells"] li[data-cell="${cell}"]`,
          );
          if (r === null) throw new Error(`no row ${object}.${cell}`);
          return r;
        },
        { timeout: CHROME_MS },
      ).catch(() => {
        throw new Error(`inspector: ${object} has no cell ${cell}`);
      });
    }
    return row;
  };

  const typeInto = async (box: HTMLElement, text: string): Promise<void> => {
    await user.clear(box);
    if (text !== "") await user.paste(text);
    await user.keyboard("{Enter}");
  };

  // -- the gestures

  const gestures: Gestures = {
    async bringIntoView(target) {
      await reveal(aimOf(target));
    },

    async addBoard(name) {
      const boards = () => ctx.session.getSnapshot().boards;
      const known = new Set(boards().map((b) => b.id));
      await user.click(within(ctx.root).getByRole("button", { name: "New board" }));
      const input = await waitFor(() =>
        within(ctx.root).getByRole("textbox", { name: "Board name" }),
      );
      await typeInto(input, name);
      await until(
        () => boards().some((b) => !known.has(b.id) && b.name === name),
        `the board ${name}`,
        COMMIT_MS,
      );
      const id = boards().find((b) => !known.has(b.id) && b.name === name)?.id;
      await until(
        () => ctx.session.getSnapshot().activeBoard === id && ctx.session.boardView()?.board === id,
        `the new board ${name} active`,
        CHROME_MS,
      );
      await caughtUp();
      await syncLog();
    },

    async showBoard(name) {
      const board = ctx.session.getSnapshot().boards.find((b) => (b.name || b.id) === name);
      if (board === undefined) throw new Error(`showBoard: no board named "${name}"`);
      if (ctx.session.getSnapshot().activeBoard !== board.id) {
        const tabs = within(ctx.root).getByRole("tablist", { name: "Boards" });
        await user.click(within(tabs).getByRole("tab", { name }));
      }
      await until(
        () =>
          ctx.session.getSnapshot().activeBoard === board.id &&
          ctx.session.boardView()?.board === board.id,
        `the board ${name}`,
        CHROME_MS,
      );
      await settle(60);
      await ctx.frame();
    },

    async viewAs(name) {
      const select = within(ctx.root).getByRole("combobox", { name: "View as" });
      const options = [...select.querySelectorAll("option")];
      const option =
        name === "GM"
          ? options.find((o) => o.value === "gm")
          : options.find((o) => o.textContent === name && !o.disabled);
      if (option === undefined) {
        throw new Error(
          `viewAs: no "${name}" in View as (${options.map((o) => o.textContent).join(", ")})`,
        );
      }
      const key = option.value;
      if (ctx.session.viewerKey() !== key) await user.selectOptions(select, option);
      await until(
        () => ctx.session.viewerKey() === key && ctx.session.boardView() !== null,
        `the view as ${name}`,
        CHROME_MS,
      );
      await settle(60);
      await ctx.frame();
      await syncLog();
    },

    async moveSelectionToBoard(name) {
      const board = ctx.session.getSnapshot().boards.find((b) => (b.name || b.id) === name);
      if (board === undefined) throw new Error(`moveSelectionToBoard: no board named "${name}"`);
      const button = within(ctx.root).getByRole("button", { name: "Move selection to board…" });
      if ((button as HTMLButtonElement).disabled) {
        throw new Error("moveSelectionToBoard: nothing movable is selected");
      }
      const before = ctx.gm.revision;
      await user.click(button);
      const menu = await waitFor(() =>
        within(ctx.root).getByRole("menu", { name: "Move selection to board" }),
      );
      await user.click(within(menu).getByRole("menuitem", { name }));
      await committed(before, `the selection moved to ${name}`);
      await until(
        () =>
          ctx.session.getSnapshot().activeBoard === board.id &&
          ctx.session.boardView()?.board === board.id,
        `the board ${name} after the move`,
        CHROME_MS,
      );
      await settle(60);
      await ctx.frame();
    },

    async drag(from, to, options = {}) {
      const both = union(pointBounds(from), pointBounds(to));
      const zoom = pickZoom(MIN_ZOOM, fitZoom(both, viewport()));
      if (zoom === null) throw new Error(`drag: no camera shows ${JSON.stringify([from, to])}`);
      await setCamera([(both.minX + both.maxX) / 2, (both.minY + both.maxY) / 2], zoom);
      const mods = { alt: options.alt === true };
      const mid: Point = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
      pointer("down", from, mods);
      pointer("move", mid, mods);
      pointer("move", to, mods);
      pointer("up", to, mods);
      await settle(60);
      await caughtUp();
      await syncLog();
    },

    async dragObject(id, to, options = {}) {
      const container = containerOf(id);
      if (container !== null) {
        await dragAims(
          { kind: "entry", container, entry: id, part: "row" },
          id,
          { kind: "point", to },
          options,
        );
        return;
      }
      const item = faces().items.find((i) => i.id === id);
      if (item === undefined) throw new Error(`dragObject: ${id} is not on the active board`);
      const delta: Point = [to[0] - item.anchor[0], to[1] - item.anchor[1]];
      await dragAims(
        { kind: "board", id, use: "press" },
        id,
        { kind: "point", to },
        {
          ...options,
          release: (p) => [p[0] + delta[0], p[1] + delta[1]],
        },
      );
    },

    async marquee(from, to) {
      if (ctx.ui.getState().tool.id !== "select") pressKey("v");
      await clearSelection();
      const both = union(pointBounds(from), pointBounds(to));
      const zoom = pickZoom(MIN_ZOOM, fitZoom(both, viewport()));
      if (zoom === null) throw new Error(`marquee: no camera shows ${JSON.stringify([from, to])}`);
      await setCamera([(both.minX + both.maxX) / 2, (both.minY + both.maxY) / 2], zoom);
      const scene = faces();
      const hit = faceHitAt(scene, from, camera());
      if (hit !== null || hitsAt(scene, from, camera()).length > 0) {
        throw new Error(
          `marquee: ${JSON.stringify(from)} is on ${describeHit(hit)}, not empty board`,
        );
      }
      const mid: Point = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
      pointer("down", from);
      pointer("move", mid);
      pointer("move", to);
      pointer("up", to);
      await settle(40);
      await ctx.frame();
    },

    async click(id) {
      await clickTarget(id);
      await caughtUp();
    },

    async doubleClick(id) {
      const container = containerOf(id);
      const aim: Aim =
        container === null
          ? { kind: "board", id, use: "body" }
          : { kind: "entry", container, entry: id, part: "row" };
      // An entry keeps the selection that shows its list (M6-D12).
      if (container === null) await clearSelection();
      const p = await reveal(aim);
      const before = ctx.gm.revision;
      doubleTap(p);
      await settle(60);
      if (ctx.gm.revision === before) {
        // A double-click that opens an editor commits nothing; give a write its time.
        await settle(200);
      }
      if (ctx.gm.revision !== before) await committed(before, `${id} double-clicked`);
      else await caughtUp();
    },

    async key(combo) {
      const before = ctx.gm.revision;
      pressKey(combo);
      await settle(80);
      await caughtUp();
      if (ctx.gm.revision !== before) await syncLog();
    },

    async drawZone(from, to, options = {}) {
      const fog = options.fog === true;
      pressKey("r");
      await until(() => ctx.ui.getState().tool.id === "zone-rect", "the rect zone tool", CHROME_MS);
      const toolbar = within(ctx.root).getByRole("toolbar", { name: "Tools" });
      const box = within(toolbar).getByRole("checkbox", { name: "Fog" }) as HTMLInputElement;
      if (box.checked !== fog) await user.click(box);
      await waitFor(() => {
        if (
          (within(toolbar).getByRole("checkbox", { name: "Fog" }) as HTMLInputElement).checked !==
          fog
        )
          throw new Error("Fog");
      });
      const both = union(pointBounds(from), pointBounds(to));
      const zoom = pickZoom(MIN_ZOOM, fitZoom(both, viewport()));
      if (zoom === null) throw new Error(`drawZone: no camera shows ${JSON.stringify([from, to])}`);
      await setCamera([(both.minX + both.maxX) / 2, (both.minY + both.maxY) / 2], zoom);
      const before = ctx.gm.revision;
      const known = new Set(ctx.session.directory().keys());
      const mid: Point = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
      pointer("down", from);
      pointer("move", mid);
      pointer("move", to);
      pointer("up", to);
      await committed(before, "the zone drawn");
      let id: ObjectId | undefined;
      await until(
        () => {
          const [sel] = ctx.ui.getState().selection;
          id = sel !== undefined && !known.has(sel) ? sel : undefined;
          return id !== undefined;
        },
        "the new zone selected",
        CHROME_MS,
      );
      return id as ObjectId;
    },

    async pressButton(object, action, options = {}) {
      const p = await reveal({ kind: "element", object, element: { action } });
      const hit = faceHitAt(faces(), p, camera());
      if (hit?.target.type !== "button") throw new Error(`pressButton: ${describeHit(hit)}`);
      if (options.expectDisabled === true) {
        if (hit.target.enabled) {
          throw new Error(`pressButton: ${object}'s ${action} is enabled, expected disabled`);
        }
        await caughtUp();
        const before = ctx.gm.revision;
        tap(p);
        await settle(150);
        await caughtUp();
        if (ctx.gm.revision !== before) {
          throw new Error(`pressButton: pressing ${object}'s disabled ${action} committed a write`);
        }
        return;
      }
      if (!hit.target.enabled) {
        throw new Error(
          `pressButton: ${object}'s ${action} is disabled${hit.target.reason === undefined ? "" : ` (${JSON.stringify(hit.target.reason)})`}`,
        );
      }
      const before = ctx.gm.revision;
      tap(p);
      await committed(before, `${object}'s ${action} pressed`);
    },

    async expandEntry(container, entry) {
      const scene = faces();
      const l = locate(scene, entry);
      if (l?.entry?.entry.expanded === true) return;
      const template = l?.entry?.entry.template === true;
      const p = await reveal({ kind: "entry", container, entry, part: "chevron" });
      const before = ctx.gm.revision;
      tap(p);
      if (template) {
        // A working copy (spawned, or the first existing one) is selected and expanded.
        await until(
          () => {
            const [sel] = ctx.ui.getState().selection;
            if (sel === undefined || sel === entry) return false;
            const t = ctx.session.directory().get(sel)?.cells.template?.value as
              | { type?: string; object?: string }
              | undefined;
            if (t?.type !== "ref" || t.object !== entry) return false;
            return locate(faces(), sel)?.entry?.entry.expanded === true;
          },
          `a working copy of ${entry} expanded`,
          COMMIT_MS,
        );
        if (ctx.gm.revision !== before) await committed(before, `${entry}'s working copy`);
        else await caughtUp();
        return;
      }
      await until(
        () => locate(faces(), entry)?.entry?.entry.expanded === true,
        `${entry} expanded`,
        CHROME_MS,
      );
      await settle(20);
      await ctx.frame();
    },

    async collapseEntry(container, entry) {
      const l = locate(faces(), entry);
      if (l?.entry != null && !l.entry.entry.expanded) return;
      const p = await reveal({ kind: "entry", container, entry, part: "chevron" });
      tap(p);
      await until(
        () => locate(faces(), entry)?.entry?.entry.expanded === false,
        `${entry} collapsed`,
        CHROME_MS,
      );
      await settle(20);
      await ctx.frame();
    },

    async gear(entry) {
      const container = containerOf(entry);
      const aim: Aim =
        container === null
          ? { kind: "board-gear", id: entry }
          : { kind: "entry", container, entry, part: "gear" };
      const p = await reveal(aim);
      tap(p);
      await until(
        () => ctx.ui.getState().selection.join() === entry,
        `${entry} selected by its gear`,
        CHROME_MS,
      );
      await waitFor(() => within(ctx.root).getByRole("status", { name: "Editing template" }), {
        timeout: CHROME_MS,
      });
      await settle(20);
    },

    async dragEntry(container, entry, to) {
      await dragAims({ kind: "entry", container, entry, part: "row" }, entry, dropAimOf(to), {});
    },

    async dropOnEditor(dragged, target, cell) {
      const container = containerOf(dragged);
      const press: Aim =
        container === null
          ? { kind: "board", id: dragged, use: "press" }
          : { kind: "entry", container, entry: dragged, part: "row" };
      await dragAims(press, dragged, { kind: "editor", object: target, cell }, {});
    },

    async editInPlace(object, cell, text) {
      const scene = faces();
      const l = locate(scene, object);
      if (l === null) throw new Error(`editInPlace: ${object} is not drawn on the active board`);
      const prim = primitiveOf(l.drawing, { cell });
      let p: Point;
      let double: boolean;
      if (prim !== undefined) {
        p = await reveal({ kind: "element", object, element: { cell } });
        double = prim.kind !== "editor";
      } else if (cell === "name" || cell === "text") {
        // No element: the default edit in place (text, else name) on a double-click.
        const container = containerOf(object);
        p = await reveal(
          container === null
            ? { kind: "board", id: object, use: "body" }
            : { kind: "entry", container, entry: object, part: "row" },
        );
        double = true;
      } else {
        throw new Error(`editInPlace: ${object} draws no element for ${cell}`);
      }
      const before = ctx.gm.revision;
      if (double) doubleTap(p);
      else tap(p);
      const box = await waitFor(
        () => {
          const editor = within(ctx.root).queryByRole("textbox", { name: `Edit ${cell}` });
          if (editor !== null) return editor;
          const focused = ctx.ui.getState().focusedCell;
          const bar = ctx.root.querySelector<HTMLElement>('[data-part="formula-bar"] textarea');
          if (focused?.object === object && focused.cell === cell && bar !== null) return bar;
          throw new Error(`no editor for ${object}.${cell}`);
        },
        { timeout: CHROME_MS },
      ).catch(() => {
        throw new Error(`editInPlace: no in-place editor opened for ${object}.${cell}`);
      });
      await typeInto(box, text);
      await committed(before, `${object}.${cell} edited in place`);
    },

    async inspectorSet(object, cell, text) {
      await select(object);
      await onInspector(async () => {
        const row = await cellRow(object, cell);
        // A cell just added opens its value editor by itself (vtt-nb8.25).
        const open = within(row).queryByRole("textbox", { name: `Value of ${cell}` });
        const shown = row.querySelector<HTMLElement>('[data-part="value"]');
        if (open === null && shown === null) {
          throw new Error(`inspectorSet: ${object}.${cell} cannot be edited`);
        }
        const before = ctx.gm.revision;
        if (open === null && shown !== null) await user.dblClick(shown);
        const box = await waitFor(() =>
          within(row).getByRole("textbox", { name: `Value of ${cell}` }),
        ).catch(() => {
          throw new Error(`inspectorSet: ${object}.${cell} opened no value editor`);
        });
        await typeInto(box, text);
        await committed(before, `${object}.${cell} set in the inspector`);
      });
    },

    async inspectorAddCell(object, cell, text) {
      await select(object);
      await onInspector(async () => {
        const cells = await waitFor(() =>
          within(inspector()).getByRole("region", { name: "Cells" }),
        );
        const input = within(cells).getByRole("textbox", { name: "New cell name" });
        const before = ctx.gm.revision;
        await user.clear(input);
        await user.paste(cell);
        await user.click(within(cells).getByRole("button", { name: "Add cell" }));
        await committed(before, `cell ${object}.${cell} added`);
      });
      if (text !== "") await gestures.inspectorSet(object, cell, text);
    },

    async inspectorCellVisibility(object, cell, viewersText) {
      const wanted = viewersText
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "");
      if (wanted.length === 0) throw new Error("inspectorCellVisibility: no viewers");
      await select(object);
      await onInspector(async () => {
        const rules = await waitFor(() =>
          within(inspector()).getByRole("region", { name: "Visibility rules" }),
        );
        const existing = rules.querySelector<HTMLElement>(`li[data-rule="${cell}"]`);
        if (existing === null) {
          const input = within(rules).getByRole("textbox", { name: "Rule cell name" });
          await user.clear(input);
          await user.paste(cell);
          const picker = within(rules).getByRole("group", { name: "New rule viewers" });
          for (const w of wanted) {
            const box = within(picker).queryByRole("checkbox", { name: w });
            if (box === null) throw new Error(`inspectorCellVisibility: no viewer "${w}"`);
            if (!(box as HTMLInputElement).checked) await user.click(box);
          }
          const before = ctx.gm.revision;
          await user.click(within(rules).getByRole("button", { name: "Add visibility rule" }));
          await committed(before, `the visibility of ${object}.${cell}`);
          return;
        }
        // An existing rule: one write per checkbox changed, additions first.
        const boxes = () => {
          const li = rules.querySelector<HTMLElement>(`li[data-rule="${cell}"]`);
          if (li === null) throw new Error(`the rule of ${cell} is gone`);
          return within(li).getAllByRole("checkbox") as HTMLInputElement[];
        };
        const nameOf = (b: HTMLInputElement) => b.closest("label")?.textContent?.trim() ?? "";
        for (const w of wanted) {
          const box = boxes().find((b) => nameOf(b) === w);
          if (box === undefined) throw new Error(`inspectorCellVisibility: no viewer "${w}"`);
          if (box.checked) continue;
          const before = ctx.gm.revision;
          await user.click(box);
          await committed(before, `${w} added to ${object}.${cell}'s viewers`);
        }
        for (const box of boxes()) {
          const n = nameOf(box);
          if (!box.checked || wanted.includes(n)) continue;
          const before = ctx.gm.revision;
          await user.click(boxes().find((b) => nameOf(b) === n) as HTMLInputElement);
          await committed(before, `${n} removed from ${object}.${cell}'s viewers`);
        }
      });
    },

    async inspectorFlags(object, flags) {
      await select(object);
      await onInspector(async () => {
        const header = await waitFor(() =>
          within(inspector()).getByRole("region", { name: "Object" }),
        );
        for (const [flag, label] of [
          ["character", "Character"],
          ["template", "Template"],
        ] as const) {
          const want = flags[flag];
          if (want === undefined) continue;
          const box = within(header).getByRole("checkbox", { name: label }) as HTMLInputElement;
          if (box.checked === want) continue;
          const before = ctx.gm.revision;
          await user.click(box);
          await committed(before, `${object} ${want ? "made" : "unmade"} a ${flag}`);
        }
      });
    },

    elementShown(object, element) {
      // Drawn on screen now: present (show_when), at its min_size with every list
      // around it, its centre unclipped by those lists, on screen and uncovered.
      const scene = faces();
      const l = locate(scene, object);
      if (l === null) return false;
      const prim = primitiveOf(l.drawing, element);
      if (prim === undefined) return false;
      const cam = camera();
      const shows = [
        ...listShows(l.clips),
        { rect: prim.rect, toBoard: l.toBoard, minSize: prim.minSize },
      ];
      if (shows.some((x) => screenHeight(x.rect, x.toBoard, cam) < x.minSize)) return false;
      const mid = apply(l.toBoard, centre(prim.rect));
      if (!l.clips.every((c) => pointInClip(c, mid))) return false;
      return onScreen(mid, 0) && !isCovered(scene, mid);
    },

    elementEnabled(object, action) {
      const l = locate(faces(), object);
      const prim = primitiveOf(l?.drawing ?? null, { action });
      if (prim?.kind === "button") return prim.enabled;
      const state = ctx.session.objectView(object)?.action_states?.find((s) => s.name === action);
      return state?.enabled ?? false;
    },

    covers() {
      // The last frame: the calls since the renderer's last clearRect.
      const calls = ctx.renderer.calls;
      let start = 0;
      for (let i = calls.length - 1; i >= 0; i--) {
        if (calls[i]?.name === "clearRect") {
          start = i;
          break;
        }
      }
      let n = 0;
      for (const call of calls.slice(start)) {
        if (
          (call.name === "fill" || call.name === "fillRect") &&
          call.style?.fillStyle === COVER_FILL
        ) {
          n++;
        }
      }
      return n;
    },

    logGroups() {
      if (!logOpen()) {
        throw new Error("logGroups: the Log tab is not open (await logLoadOlder() opens it)");
      }
      return logRows().map((li): LogGroupShown => {
        const header = li.getAttribute("aria-label") ?? "";
        const at = header.indexOf(": ");
        const items = li.querySelectorAll(":scope > ul > li");
        return {
          index: Number(li.dataset.logIndex),
          actor: at === -1 ? header : header.slice(0, at),
          label: at === -1 ? "" : header.slice(at + 2),
          undone: li.dataset.undone === "true",
          sentences: [...items].map((s) => s.textContent ?? ""),
        };
      });
    },

    async logFilterActor(option) {
      if (!logOpen()) await openLog();
      const select = within(inspector()).getByRole("combobox", {
        name: "Actor",
      }) as HTMLSelectElement;
      const found = [...select.options].find((o) => o.textContent === option);
      if (found === undefined) {
        const offered = [...select.options].map((o) => o.textContent).join(", ");
        throw new Error(`logFilterActor: no Actor option "${option}" (offered: ${offered})`);
      }
      await user.selectOptions(select, found);
      // Done when the search settled: All has no status; another actor's says how far it went.
      await until(
        () => {
          const status = within(inspector()).queryByRole("status", { name: "Log search" });
          const text = status?.textContent ?? "";
          const settled = found.value === "all" ? status === null : !text.startsWith("Searching");
          return settled && logList()?.querySelector("li[data-refreshing]") === null;
        },
        "the Actor filter's search",
        CHROME_MS,
      );
      await settle(20);
    },

    async logLoadOlder() {
      const wasOpen = logOpen();
      if (!wasOpen) await openLog();
      const more = loadOlder();
      if (more === null) {
        if (wasOpen) throw new Error("logLoadOlder: the Log tab offers nothing older");
        return;
      }
      const count = logRows().length;
      await user.click(more);
      // Done when older rows came, or the chain ended (nothing older: the button goes).
      await until(
        () =>
          (logRows().length > count || loadOlder() === null) &&
          logList()?.querySelector("li[data-refreshing]") === null,
        "older log groups",
        CHROME_MS,
      );
      await settle(20);
    },
  };
  return gestures;
};
