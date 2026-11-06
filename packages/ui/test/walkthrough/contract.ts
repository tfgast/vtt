/**
 * The walkthrough's driver contract (vtt-nb8.17; M6 plan decisions Q2, Q13;
 * review r2 findings 2, 3): types only. `DriverContext` is what
 * `startWalkthrough` (infra.ts) hands a walkthrough test; `Gestures` is the
 * GM's UI gestures over it, implemented by vtt-nb8.18 (`createGestures` in
 * gestures.ts); `PrepResult` and `PlayAResult` are what the prep (vtt-nb8.9)
 * and play A (vtt-nb8.10) scenarios return to the later steps. The step
 * beads import these files unchanged, and their local helpers use only
 * `DriverContext` and `Gestures`.
 *
 * Points are `[x, y]` in board units on the active board, unless a member
 * says client pixels.
 */
import type { Client } from "@modelcontextprotocol/client";
import type { ScriptedDiceEntry } from "@vtt/authority";
import type { ProtocolClient } from "@vtt/protocol";
import type { BoardId, ObjectId } from "@vtt/schema";
import type { FaceStateStore, RecordingContext, TableSession, UiStore } from "@vtt/ui";

/** `[x, y]`: board units on the active board, or client pixels where stated. */
export type Point = [number, number];

/** One scripted die result (`ScriptedDiceSource`), consumed in order by every roll. */
export type DiceEntry = ScriptedDiceEntry;

/** `startWalkthrough`'s options. */
export interface WalkthroughOptions {
  /** The table's dice, in order; kept across `restart`. */
  dice: DiceEntry[];
}

/** An MCP agent connected to the table (`startAgent`). */
export interface WalkthroughAgent {
  /** An MCP client of the authority's `createMcpServer`, as `vtt-mcp` composes it. */
  mcp: Client;
  /** Closes the MCP pair and the agent's connection. Idempotent. */
  close(): Promise<void>;
}

/** The camera `setCamera` sets: its center in board units and its zoom (1 = 64 px per unit). */
export interface CameraTarget {
  center: Point;
  zoom: number;
}

/**
 * The running walkthrough: the real `<App>` in jsdom on an in-process
 * authority over a temp table file. `root`, `session`, `ui`, `faceState`,
 * `renderer` and `gm` are replaced by `restart`: read them from the context
 * each time, never keep them across a restart.
 */
export interface DriverContext {
  /** The rendered app's container, for Testing Library queries (`within(root)`). */
  readonly root: HTMLElement;
  /** The app's own table session (vtt-3l6.4). */
  readonly session: TableSession;
  /** The app's own UI store (vtt-3l6.21). */
  readonly ui: UiStore;
  /** The app's face state (expanded entries, scroll offsets), for locating face elements. */
  readonly faceState: FaceStateStore;
  /** The recording 2D context the app draws into. */
  readonly renderer: RecordingContext;
  /** A GM protocol client on the table, for assertions only: it never writes. */
  readonly gm: ProtocolClient;
  /** The table file's absolute path. */
  readonly file: string;
  /** The authority's HTTP origin (`http://127.0.0.1:<port>`); unchanged by `restart`. */
  readonly origin: string;
  /** A board point to client pixels, through the current camera. */
  toScreen(p: Point): Point;
  /** Client pixels to a board point, through the current camera. */
  toBoard(p: Point): Point;
  /** Sets the camera through the UI store; resolves after the next frame. */
  setCamera(camera: CameraTarget): Promise<void>;
  /** Resolves after the next animation frame (any scheduled draw has run). */
  frame(): Promise<void>;
  /**
   * Queues `file` for the next hidden `<input type="file">` the app opens
   * (the image tool, the inspector's Upload…). An input opened with nothing
   * queued is dismissed (its `cancel` event).
   */
  pickFile(file: File): void;
  /** POSTs `bytes` to `/assets` with the session token, as `name`. */
  upload(bytes: Uint8Array, name: string): Promise<{ path: string }>;
  /** The table file's text on disk now. */
  savedFile(): Promise<string>;
  /**
   * The one live object named `name` (templates and contained objects
   * included), on `board` (its outermost container's board) when given;
   * throws naming the matches when there is not exactly one. Reads the
   * app's GM directory, so wait for a write's revision first.
   */
  byName(name: string, board?: BoardId): ObjectId;
  /** An MCP agent named `name` (its actor `{type: "agent", name}`). */
  startAgent(name: string): Promise<WalkthroughAgent>;
  /**
   * Restarts the authority: closes open agents, closes the server and the
   * host with a final save, reopens the same file on the same port with a
   * new token, presses the unauthorized banner's Reload and remounts `<App>`;
   * resolves once connected on the board that was active before.
   */
  restart(): Promise<void>;
  /** Disposes the app, agents, sockets, server and temp files. Idempotent; call in `afterEach`. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Gestures (implemented by vtt-nb8.18)

/** What `bringIntoView` brings on screen: an object, a contents entry, or one face element. */
export type ViewTarget =
  | ObjectId
  | { container: ObjectId; entry: ObjectId }
  | { object: ObjectId; element: { cell: string } | { action: string } };

/** Where `dragEntry` drops an entry. */
export type EntryDropTarget =
  | Point
  | { object: ObjectId; cell: string }
  | { object: ObjectId; contents: true };

/** One group of the Log panel as shown. */
export interface LogGroupShown {
  index: number;
  label: string;
  actor: string;
  undone: boolean;
  sentences: string[];
}

/**
 * The GM's gestures through the real UI. Every gesture first calls
 * `bringIntoView` on its targets.
 */
export interface Gestures {
  /**
   * Pans and zooms the camera and scrolls enclosing contents elements until
   * the target is unclipped, on screen and at least its `min_size`.
   */
  bringIntoView(target: ViewTarget): Promise<void>;
  addBoard(name: string): Promise<void>;
  showBoard(name: string): Promise<void>;
  viewAs(name: string | "GM"): Promise<void>;
  moveSelectionToBoard(name: string): Promise<void>;
  drag(from: Point, to: Point, options?: { alt?: boolean }): Promise<void>;
  dragObject(id: ObjectId, to: Point, options?: { alt?: boolean }): Promise<void>;
  marquee(from: Point, to: Point): Promise<void>;
  click(id: ObjectId): Promise<void>;
  doubleClick(id: ObjectId): Promise<void>;
  key(combo: string): Promise<void>;
  /** Draws a rect zone from `from` to `to` (Fog checked when `fog`); resolves with its id. */
  drawZone(from: Point, to: Point, options?: { fog?: boolean }): Promise<ObjectId>;
  pressButton(
    object: ObjectId,
    action: string,
    options?: { expectDisabled?: boolean },
  ): Promise<void>;
  expandEntry(container: ObjectId, entry: ObjectId): Promise<void>;
  /** Collapses an expanded entry with its chevron (`expandEntry`'s inverse); no-op if collapsed. */
  collapseEntry(container: ObjectId, entry: ObjectId): Promise<void>;
  gear(entry: ObjectId): Promise<void>;
  dragEntry(container: ObjectId, entry: ObjectId, to: EntryDropTarget): Promise<void>;
  dropOnEditor(dragged: ObjectId, target: ObjectId, cell: string): Promise<void>;
  editInPlace(object: ObjectId, cell: string, text: string): Promise<void>;
  inspectorSet(object: ObjectId, cell: string, text: string): Promise<void>;
  inspectorAddCell(object: ObjectId, cell: string, text: string): Promise<void>;
  inspectorCellVisibility(object: ObjectId, cell: string, viewersText: string): Promise<void>;
  inspectorFlags(
    object: ObjectId,
    flags: { template?: boolean; character?: boolean },
  ): Promise<void>;
  elementShown(object: ObjectId, element: { cell: string } | { action: string }): boolean;
  elementEnabled(object: ObjectId, action: string): boolean;
  /** The number of covers drawn in the current view. */
  covers(): number;
  logGroups(): LogGroupShown[];
  logLoadOlder(): Promise<void>;
  /**
   * Opens the Log tab when closed and chooses `option` (its text: "All",
   * "GM", "Any agent", an agent's or character's name) in its Actor filter;
   * resolves once the filter's search of older groups has settled.
   */
  logFilterActor(option: string): Promise<void>;
}

/** gestures.ts's factory (vtt-nb8.18). */
export type CreateGestures = (ctx: DriverContext) => Gestures;

// ---------------------------------------------------------------------------
// Scenario results

/** The four characters, by name. */
export type CharacterName = "Aldric" | "Brenna" | "Corin" | "Dara";

/** A room number of the Crypt map. */
export type RoomNumber = 1 | 2 | 3 | 4 | 5 | 6;

/** What the prep scenario (§8.4 steps 1–6, vtt-nb8.9) made. */
export interface PrepResult {
  characters: Record<
    CharacterName,
    { token: ObjectId; sheet: ObjectId; binder: ObjectId; attackTemplate: ObjectId }
  >;
  gmBinder: ObjectId;
  crypt: BoardId;
  map: ObjectId;
  /** The map's top-left corner M, in board units on Crypt. */
  mapOrigin: Point;
  /** Board units per map pixel. */
  unitsPerPx: 0.01;
  /** Each room zone and its rect `[x, y, w, h]` in board units on Crypt. */
  rooms: Record<RoomNumber, { id: ObjectId; rect: [number, number, number, number] }>;
  goblinTemplate: ObjectId;
  /** G1–G8, in order. */
  goblins: ObjectId[];
  /** Each goblin's attack die, in the same order. */
  goblinDice: ObjectId[];
  fireballTemplate: ObjectId;
  note: ObjectId;
}

/** What play A (§8.4 steps 7–11, vtt-nb8.10) left for play B. */
export interface PlayAResult {
  /** In strip order. */
  initiative: { name: string; roll: number; total: number }[];
  tray: ObjectId;
  strip: ObjectId;
  trayDice: ObjectId[];
  /** Aldric's binder, on Crypt. */
  aldricBinder: ObjectId;
  /** The step-10 working copy of Aldric's Attack card. */
  attackCopy: ObjectId;
  /** G2's die, now on Aldric. */
  goblinDie: ObjectId;
  /** The current `hp` of the four characters and G1–G8, by name. */
  hp: Record<string, number>;
}
