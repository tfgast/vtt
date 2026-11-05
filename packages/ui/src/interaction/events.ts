/**
 * The input events tools reduce (DESIGN.md §7 Platform; M4 plan review r1
 * finding 2; M5 plan Q1 A1). `BoardCanvas` (vtt-3l6.6) converts DOM events
 * into these; the runtime (vtt-3l6.23) dispatches `settled` when an async
 * effect ends. `screen` is CSS pixels from the canvas's top-left corner;
 * `board` is the same point in board units under the camera at the time.
 */
import type { Point } from "@vtt/schema";
import type { WriteOutcome } from "./contracts";

export interface Modifiers {
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
}

/**
 * Fields of every pointer event. `button` is the DOM `PointerEvent.button`
 * of the change (0 primary, 1 middle, 2 secondary; -1 on a move), `buttons`
 * the DOM bitmask of the buttons held.
 */
export interface PointerFields {
  pointerId: number;
  screen: Point;
  board: Point;
  button: number;
  buttons: number;
  modifiers: Modifiers;
}

export type PointerEventType = "pointer_down" | "pointer_move" | "pointer_up" | "pointer_cancel";

type Tagged<T extends string, F> = { [K in "type" | keyof F]: K extends keyof F ? F[K] : T };

export type PointerInteractionEvent = {
  [T in PointerEventType]: Tagged<T, PointerFields>;
}[PointerEventType];

/**
 * `key` and `code` are the DOM `KeyboardEvent` fields; `inTextField` is true
 * when the event's target is an input, a textarea or contenteditable (such
 * events are dropped by the machine).
 */
export interface KeyFields {
  key: string;
  code: string;
  modifiers: Modifiers;
  inTextField: boolean;
}

/** The result of an async effect, dispatched as `settled` with its stamp's `interactionId`. */
export type SettledOutcome =
  | { type: "write"; result: WriteOutcome }
  | { type: "file_picked"; file: File | null }
  | { type: "uploaded"; path: string; width: number; height: number }
  | { type: "upload_failed"; message: string }
  /** An `extension` effect's handler result (M5 Q1 A1/A2). */
  | { type: "extension"; name: string; result: unknown };

export type InteractionEvent =
  | PointerInteractionEvent
  | { type: "double_click"; screen: Point; board: Point; modifiers: Modifiers }
  /** Deltas in CSS pixels (line and page deltas are converted by `BoardCanvas`). */
  | {
      type: "wheel";
      screen: Point;
      board: Point;
      deltaX: number;
      deltaY: number;
      modifiers: Modifiers;
    }
  | Tagged<"key_down", KeyFields>
  | Tagged<"key_up", KeyFields>
  | { type: "file_drop"; files: File[]; screen: Point; board: Point }
  /** A drop carrying an `application/x-vtt-*` type: the first such type and its data (M5 Q1 A1). */
  | { type: "data_drop"; mime: string; data: string; screen: Point; board: Point }
  | { type: "settled"; interactionId: string; outcome: SettledOutcome };
