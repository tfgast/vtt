/**
 * The app's keybindings (vtt-3l6.17; DESIGN.md §7 Undo, §8.1): Ctrl/Cmd+Z
 * undoes the GM's own latest group and Ctrl/Cmd+S saves (its default
 * prevented), both through vtt-3l6.21's `undo` and `save`; the tool keys
 * activate tools (M5, vtt-1xv.23: D ink, W text, L layout); `?` (Shift+/)
 * toggles the keyboard and gesture help (vtt-nb8.8); `+` (or `=`) and `-`
 * zoom in and out about the viewport centre (M6-D11), so zoom stays on the
 * keyboard now that a plain wheel pans. `KEY_BINDINGS` is the
 * one table: `keyCommand` dispatches from it and the help lists it, so the
 * two cannot drift. Nothing fires while focus is in a text field, where the
 * keys keep their text-editing meaning. The select tool's own keys (Delete,
 * arrows, F, `[`, `]`, Escape) reach it through `BoardCanvas`, not here.
 */
import type { Viewport } from "../interaction/contracts";
import type { ToolId } from "../interaction/tool";
import { type Camera, zoomAt } from "../scene/camera";
import type { TableSession } from "../session/table-session";
import { save, undo } from "../session/writes";
import type { UiStore } from "../state/ui-state";
import { activateTool } from "./Toolbar";

export type KeyCommand =
  | { type: "undo" }
  | { type: "save" }
  | { type: "help" }
  | { type: "zoom"; direction: ZoomDirection }
  | { type: "tool"; tool: ToolId };

export type ZoomDirection = "in" | "out";

/** The zoom factor of one zoom key press. */
export const KEY_ZOOM_FACTOR = 1.25;

/** The camera after one zoom key press: `KEY_ZOOM_FACTOR` about the viewport centre, clamped. */
export function zoomStep(camera: Camera, viewport: Viewport, direction: ZoomDirection): Camera {
  const factor = direction === "in" ? KEY_ZOOM_FACTOR : 1 / KEY_ZOOM_FACTOR;
  return zoomAt(camera, [viewport.width / 2, viewport.height / 2], factor, viewport);
}

const zoomBinding = (key: string, direction: ZoomDirection, label: string): KeyBinding => ({
  keys: key,
  label,
  key,
  mod: false,
  command: { type: "zoom", direction },
});

/** One keybinding: what the help shows (`keys`, `label`) and what dispatch matches. */
export interface KeyBinding {
  /** The keys as the help shows them, e.g. "V", "Ctrl/Cmd+Z", "?". */
  readonly keys: string;
  /** What the binding does, as the help shows it. */
  readonly label: string;
  /** The matched `KeyboardEvent.key`, lower case. */
  readonly key: string;
  /** Whether Ctrl or Cmd is held (without Alt or Shift); else no Ctrl, Cmd or Alt, Shift ignored. */
  readonly mod: boolean;
  readonly command: KeyCommand;
}

const toolBinding = (key: string, tool: ToolId, label: string): KeyBinding => ({
  keys: key.toUpperCase(),
  label,
  key,
  mod: false,
  command: { type: "tool", tool },
});

/** The app's keybindings, in the help's order: the table `keyCommand` dispatches from. */
export const KEY_BINDINGS: readonly KeyBinding[] = [
  toolBinding("v", "select", "Select tool"),
  toolBinding("t", "token", "Token tool"),
  toolBinding("c", "card", "Card tool"),
  toolBinding("n", "note", "Note tool"),
  toolBinding("r", "zone-rect", "Rectangle zone tool"),
  toolBinding("o", "zone-circle", "Circle zone tool"),
  toolBinding("p", "zone-polygon", "Polygon zone tool"),
  toolBinding("i", "image", "Image tool"),
  toolBinding("d", "ink", "Ink tool"),
  toolBinding("w", "text", "Text tool"),
  toolBinding("l", "layout", "Layout tool"),
  { keys: "Ctrl/Cmd+Z", label: "Undo", key: "z", mod: true, command: { type: "undo" } },
  { keys: "Ctrl/Cmd+S", label: "Save", key: "s", mod: true, command: { type: "save" } },
  zoomBinding("+", "in", "Zoom in"),
  zoomBinding("=", "in", "Zoom in (the + key without Shift)"),
  zoomBinding("-", "out", "Zoom out"),
  {
    keys: "?",
    label: "Show or hide this help",
    key: "?",
    mod: false,
    command: { type: "help" },
  },
];

/** Tool keys (lower case; Shift is ignored), read from `KEY_BINDINGS`. */
export const TOOL_KEYS: Readonly<Record<string, ToolId>> = Object.fromEntries(
  KEY_BINDINGS.flatMap((b) => (b.command.type === "tool" ? [[b.key, b.command.tool]] : [])),
);

/** The help's keys of the binding of `command` (e.g. "Ctrl/Cmd+Z"), or undefined. */
export function keysOf(type: KeyCommand["type"], tool?: ToolId): string | undefined {
  return KEY_BINDINGS.find(
    (b) => b.command.type === type && (b.command.type !== "tool" || b.command.tool === tool),
  )?.keys;
}

/** The fields of a `KeyboardEvent` a command is read from. */
export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  target: EventTarget | null;
}

/** What the commands do. */
export interface KeyActions {
  undo(): void;
  save(): void;
  help(): void;
  tool(id: ToolId): void;
  /** Zooms the camera; a binder without it leaves the zoom keys alone. */
  zoom?(direction: ZoomDirection): void;
}

/** `<input>` types that take typed text. */
const TEXT_INPUT_TYPES = new Set([
  "",
  "text",
  "search",
  "url",
  "tel",
  "email",
  "password",
  "number",
  "date",
  "datetime-local",
  "month",
  "time",
  "week",
]);

/** Whether `target` is a text field: a text-taking input, a textarea, or inside contenteditable. */
export function isTextField(target: EventTarget | null): boolean {
  if (typeof Element === "undefined" || !(target instanceof Element)) return false;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) {
    return TEXT_INPUT_TYPES.has((target.getAttribute("type") ?? "").toLowerCase());
  }
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return target.closest('[contenteditable]:not([contenteditable="false"])') !== null;
}

/** The command of a key press, from `KEY_BINDINGS`, or null (also for every key in a text field). */
export function keyCommand(e: KeyLike): KeyCommand | null {
  if (isTextField(e.target)) return null;
  const k = e.key.toLowerCase();
  const mod = e.ctrlKey || e.metaKey;
  if (mod ? e.altKey || e.shiftKey : e.altKey) return null;
  return KEY_BINDINGS.find((b) => b.mod === mod && b.key === k)?.command ?? null;
}

/** Listens for key presses on `target`; returns the remover. */
export function bindKeybindings(
  target: Pick<EventTarget, "addEventListener" | "removeEventListener">,
  actions: KeyActions,
): () => void {
  const onKeyDown = (event: Event) => {
    const e = event as KeyboardEvent;
    if (e.defaultPrevented) return;
    const command = keyCommand(e);
    if (command === null) return;
    if (command.type === "undo") {
      e.preventDefault();
      actions.undo();
    } else if (command.type === "save") {
      e.preventDefault();
      actions.save();
    } else if (command.type === "help") {
      e.preventDefault();
      actions.help();
    } else if (command.type === "zoom") {
      if (actions.zoom === undefined) return;
      e.preventDefault();
      actions.zoom(command.direction);
    } else {
      actions.tool(command.tool);
    }
  };
  target.addEventListener("keydown", onKeyDown);
  return () => target.removeEventListener("keydown", onKeyDown);
}

/**
 * The app's actions: `undo(session)`, `save(session)`, `toggleHelp()`,
 * `activateTool(ui, id)` and `zoomStep` on the store's camera.
 */
export function appKeyActions(
  session: TableSession,
  ui: UiStore,
  toggleHelp: () => void,
): KeyActions {
  return {
    undo: () => void undo(session),
    save: () => void save(session),
    help: toggleHelp,
    tool: (id) => activateTool(ui, id),
    zoom: (direction) => {
      const { camera, viewport } = ui.getState();
      ui.setCamera(zoomStep(camera, viewport, direction));
    },
  };
}
