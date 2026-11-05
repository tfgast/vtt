/**
 * The text tool and its `edit_created` continuation (DESIGN.md §4.6 Ink and
 * text, Edit in place; §8.1; PROTOCOL.md §5 `create_object` with `id_base`;
 * M5 plan Q1 A1/A2, Q19, M5-D20).
 *
 * `text`, a pure vtt-3l6.22 `Tool`: a click (pointer down, then up with the
 * same pointer) creates a `text_<n>` object at the press point: a
 * transparent `TEXT_BOX` rect named "Text" with an empty `text` cell, one
 * `create_object` write stamped at pointer down. Its continuations select
 * the created object, open the in-place editor on its `text` (the extension
 * continuation `edit_created`), and switch to the select tool unless Shift
 * was held at pointer down. Escape, a tool, board or viewer switch and
 * `pointer_cancel` end a press with no write.
 *
 * `editCreatedHandler` is the runtime's `edit_created` continuation
 * (registered by vtt-1xv.23): it opens the editor on the created object
 * once the session shows it, with the base revision current then (which
 * includes the creation, so the typed text does not conflict with it).
 */
import type { ObjectInit, WireOp } from "@vtt/protocol";
import type { Bounds, ObjectId, Point } from "@vtt/schema";
import type { InteractionStamp, RuntimeInputs } from "./contracts";
import type { Continuation, Effect } from "./effects";
import { PRIMARY_BUTTON } from "./machine";
import type { EditorPort, ExtensionContinuationHandler } from "./runtime";
import { captureStamp, type Tool, type ToolResult, type ToolState } from "./tool";

/** The created text object's rect, in board units. */
export const TEXT_BOX = Object.freeze({ width: 4, height: 1 });

/** The name of the extension continuation that opens the editor on a created object. */
export const EDIT_CREATED = "edit_created";

/** How long `editCreatedHandler` waits for the created object to appear in the session. */
export const EDIT_CREATED_WAIT_MS = 5000;

/**
 * The payload of an `edit_created` continuation: the creating interaction's
 * stamp, the cell to edit and, optionally, the board rect to edit over.
 */
export interface EditCreatedPayload {
  stamp: InteractionStamp;
  cell: string;
  rect?: Bounds;
}

/** A press in progress. */
export interface TextPhase {
  press: { stamp: InteractionStamp; shift: boolean; pointerId: number; at: Point } | null;
}

const text = (value: string) => ({ type: "text" as const, value });

/** The board rect of a `TEXT_BOX` centred on `at`. */
function boxAround(at: Point): Bounds {
  const w = TEXT_BOX.width / 2;
  const h = TEXT_BOX.height / 2;
  return { minX: at[0] - w, minY: at[1] - h, maxX: at[0] + w, maxY: at[1] + h };
}

/** `text`: a click creates a text object and opens the editor on it. */
export function createTextTool(): Tool<TextPhase, "text"> {
  type S = ToolState<TextPhase, "text">;
  type R = ToolResult<TextPhase, "text">;
  const idle = (state: S): R => ({ state: { ...state, phase: { press: null } }, effects: [] });
  return {
    id: "text",
    init: (options) => ({ tool: "text", options, phase: { press: null } }),
    cursor: () => "text",
    reduce(state, event, input) {
      const press = state.phase.press;
      if (event.type === "pointer_down" && event.button === PRIMARY_BUTTON && press === null) {
        const stamp = captureStamp(input);
        if (stamp === null) return { state, effects: [] };
        const at: Point = [event.board[0], event.board[1]];
        return {
          state: {
            ...state,
            phase: {
              press: { stamp, shift: event.modifiers.shift, pointerId: event.pointerId, at },
            },
          },
          effects: [],
        };
      }
      if (press === null || !("pointerId" in event) || event.pointerId !== press.pointerId) {
        return { state, effects: [] };
      }
      if (event.type === "pointer_cancel") return idle(state);
      if (event.type !== "pointer_up") return { state, effects: [] };
      const init: ObjectInit = {
        shape: { type: "rect", width: TEXT_BOX.width, height: TEXT_BOX.height },
        cells: { text: text(""), color: text("transparent"), name: text("Text") },
      };
      const op: WireOp = {
        type: "create_object",
        id_base: "text",
        to: { type: "board", board: press.stamp.board, position: press.at },
        init,
      };
      const payload: EditCreatedPayload = {
        stamp: press.stamp,
        cell: "text",
        rect: boxAround(press.at),
      };
      const continuations: Continuation[] = [
        { type: "select_created", opIndex: 0 },
        { type: "extension", name: EDIT_CREATED, opIndex: 0, payload },
      ];
      if (!press.shift) continuations.push({ type: "set_tool", tool: "select" });
      const write: Effect = {
        type: "write",
        stamp: press.stamp,
        ops: [op],
        label: "Create text",
        continuations,
      };
      return { state: { ...state, phase: { press: null } }, effects: [write] };
    },
    cancel: (state) => idle(state),
  };
}

// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isBounds(v: unknown): v is Bounds {
  return (
    isRecord(v) &&
    ["minX", "minY", "maxX", "maxY"].every((k) => typeof v[k] === "number" && Number.isFinite(v[k]))
  );
}

/** `payload` as an `EditCreatedPayload`, or null when it is not one. */
function parsePayload(payload: unknown): EditCreatedPayload | null {
  if (!isRecord(payload) || typeof payload.cell !== "string") return null;
  const stamp = payload.stamp;
  if (
    !isRecord(stamp) ||
    typeof stamp.interactionId !== "string" ||
    typeof stamp.board !== "string" ||
    !isRecord(stamp.viewer) ||
    typeof stamp.baseRevision !== "number"
  ) {
    return null;
  }
  if (payload.rect !== undefined && !isBounds(payload.rect)) return null;
  return payload as unknown as EditCreatedPayload;
}

function sameViewer(a: InteractionStamp["viewer"], b: InteractionStamp["viewer"]): boolean {
  if (a.type === "gm" || b.type === "gm") return a.type === b.type;
  return a.id === b.id;
}

export interface EditCreatedOptions {
  editor: EditorPort;
  inputs: RuntimeInputs;
  /** Default `EDIT_CREATED_WAIT_MS`. */
  waitMs?: number;
}

/**
 * The `edit_created` continuation: opens `editor` on the created object's
 * `payload.cell` (over `payload.rect` when given) with the payload's stamp
 * at the current revision. If the session does not show the object yet, it
 * waits for it through `inputs.onChange`; it gives up, opening nothing, when
 * the active board or viewer is no longer the stamp's, or after `waitMs`.
 * A null id or a malformed payload does nothing.
 */
export function editCreatedHandler(options: EditCreatedOptions): ExtensionContinuationHandler {
  const { editor, inputs } = options;
  const waitMs = options.waitMs ?? EDIT_CREATED_WAIT_MS;
  return (id: ObjectId | null, raw: unknown) => {
    const payload = parsePayload(raw);
    if (id === null || payload === null) return;
    const { stamp } = payload;
    /** True when finished (opened or given up). */
    const attempt = (): boolean => {
      if (inputs.activeBoard() !== stamp.board || !sameViewer(inputs.viewer(), stamp.viewer)) {
        return true;
      }
      if (inputs.views(id) === null) return false;
      editor.open({
        stamp: { ...stamp, baseRevision: inputs.revision() },
        object: id,
        cell: payload.cell,
        ...(payload.rect === undefined ? {} : { rect: { ...payload.rect } }),
      });
      return true;
    };
    if (attempt()) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = inputs.onChange(() => {
      if (attempt()) stop();
    });
    function stop() {
      off();
      if (timer !== undefined) clearTimeout(timer);
    }
    timer = setTimeout(stop, waitMs);
  };
}
