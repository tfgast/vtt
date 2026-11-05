/**
 * The app's keybindings (vtt-3l6.17; DESIGN.md §7 Undo, §8.1): Ctrl/Cmd+Z
 * undoes the GM's own latest group and Ctrl/Cmd+S saves (its default
 * prevented), both through vtt-3l6.21's `undo` and `save`; the tool keys
 * activate tools (M5, vtt-1xv.23: D ink, W text, L layout). Nothing fires while focus is in a text field, where the
 * keys keep their text-editing meaning. The select tool's own keys (Delete,
 * arrows, F, `[`, `]`, Escape) reach it through `BoardCanvas`, not here.
 */
import type { ToolId } from "../interaction/tool";
import type { TableSession } from "../session/table-session";
import { save, undo } from "../session/writes";
import type { UiStore } from "../state/ui-state";
import { activateTool } from "./Toolbar";

/** Tool keys (lower case; Shift is ignored). */
export const TOOL_KEYS: Readonly<Record<string, ToolId>> = {
  v: "select",
  t: "token",
  c: "card",
  n: "note",
  r: "zone-rect",
  o: "zone-circle",
  p: "zone-polygon",
  i: "image",
  d: "ink",
  w: "text",
  l: "layout",
};

export type KeyCommand = { type: "undo" } | { type: "save" } | { type: "tool"; tool: ToolId };

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
  tool(id: ToolId): void;
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

/** The command of a key press, or null (also for every key in a text field). */
export function keyCommand(e: KeyLike): KeyCommand | null {
  if (isTextField(e.target)) return null;
  const k = e.key.toLowerCase();
  if (e.ctrlKey || e.metaKey) {
    if (e.altKey || e.shiftKey) return null;
    if (k === "z") return { type: "undo" };
    if (k === "s") return { type: "save" };
    return null;
  }
  if (e.altKey) return null;
  const tool = Object.hasOwn(TOOL_KEYS, k) ? TOOL_KEYS[k] : undefined;
  return tool === undefined ? null : { type: "tool", tool };
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
    } else {
      actions.tool(command.tool);
    }
  };
  target.addEventListener("keydown", onKeyDown);
  return () => target.removeEventListener("keydown", onKeyDown);
}

/** The app's actions: `undo(session)`, `save(session)` and `activateTool(ui, id)`. */
export function appKeyActions(session: TableSession, ui: UiStore): KeyActions {
  return {
    undo: () => void undo(session),
    save: () => void save(session),
    tool: (id) => activateTool(ui, id),
  };
}
