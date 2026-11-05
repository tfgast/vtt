/**
 * The app's keybindings (vtt-3l6.17): Ctrl/Cmd+Z undo, Ctrl/Cmd+S save
 * (default prevented), the tool keys, and nothing while focus is in a text
 * field.
 */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { bindKeybindings, isTextField, type KeyActions, keyCommand, TOOL_KEYS } from "@vtt/ui";
import { afterEach, describe, expect, test, vi } from "vitest";

afterEach(cleanup);

const key = (
  k: string,
  mods: Partial<Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey", boolean>> = {},
) => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  target: null,
  ...mods,
});

describe("keyCommand", () => {
  test("Ctrl+Z and Cmd+Z undo; Ctrl+S and Cmd+S save", () => {
    expect(keyCommand(key("z", { ctrlKey: true }))).toEqual({ type: "undo" });
    expect(keyCommand(key("Z", { metaKey: true }))).toEqual({ type: "undo" });
    expect(keyCommand(key("s", { ctrlKey: true }))).toEqual({ type: "save" });
    expect(keyCommand(key("s", { metaKey: true }))).toEqual({ type: "save" });
  });

  test("the tool keys", () => {
    expect(TOOL_KEYS).toEqual({
      v: "select",
      t: "token",
      c: "card",
      n: "note",
      r: "zone-rect",
      o: "zone-circle",
      p: "zone-polygon",
      i: "image",
    });
    for (const [k, tool] of Object.entries(TOOL_KEYS)) {
      expect(keyCommand(key(k))).toEqual({ type: "tool", tool });
      expect(keyCommand(key(k.toUpperCase(), { shiftKey: true }))).toEqual({ type: "tool", tool });
    }
  });

  test("other keys and modified tool keys are not commands", () => {
    expect(keyCommand(key("x"))).toBeNull();
    expect(keyCommand(key("z"))).toBeNull();
    expect(keyCommand(key("v", { ctrlKey: true }))).toBeNull();
    expect(keyCommand(key("t", { altKey: true }))).toBeNull();
    expect(keyCommand(key("z", { ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(keyCommand(key("z", { ctrlKey: true, altKey: true }))).toBeNull();
  });
});

describe("text fields", () => {
  test("inputs that take text, textareas and contenteditable are text fields; checkboxes are not", () => {
    const { container } = render(
      <div>
        <input aria-label="text" />
        <input aria-label="number" type="number" />
        <input aria-label="check" type="checkbox" />
        <textarea aria-label="area" />
        <div contentEditable suppressContentEditableWarning>
          <span>inside</span>
        </div>
        <button type="button">button</button>
      </div>,
    );
    const q = (s: string) => container.querySelector(s);
    expect(isTextField(q('[aria-label="text"]'))).toBe(true);
    expect(isTextField(q('[aria-label="number"]'))).toBe(true);
    expect(isTextField(q("textarea"))).toBe(true);
    expect(isTextField(q("span"))).toBe(true);
    expect(isTextField(q('[aria-label="check"]'))).toBe(false);
    expect(isTextField(q("button"))).toBe(false);
    expect(isTextField(null)).toBe(false);
  });
});

describe("bindKeybindings", () => {
  function setup() {
    const actions: KeyActions = { undo: vi.fn(), save: vi.fn(), tool: vi.fn() };
    const off = bindKeybindings(window, actions);
    const { container } = render(
      <div>
        <input aria-label="field" />
        <button type="button">b</button>
      </div>,
    );
    const field = container.querySelector("input") as HTMLInputElement;
    const button = container.querySelector("button") as HTMLButtonElement;
    return { actions, off, field, button };
  }

  test("dispatches commands; Ctrl+S's default is prevented", () => {
    const { actions, off, button } = setup();
    expect(fireEvent.keyDown(button, { key: "z", ctrlKey: true })).toBe(false);
    expect(actions.undo).toHaveBeenCalledTimes(1);
    expect(fireEvent.keyDown(document.body, { key: "s", metaKey: true })).toBe(false);
    expect(actions.save).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document.body, { key: "r" });
    expect(actions.tool).toHaveBeenCalledWith("zone-rect");
    off();
    fireEvent.keyDown(document.body, { key: "s", ctrlKey: true });
    expect(actions.save).toHaveBeenCalledTimes(1);
  });

  test("nothing fires while focus is in a text field", () => {
    const { actions, off, field } = setup();
    field.focus();
    expect(fireEvent.keyDown(field, { key: "z", ctrlKey: true })).toBe(true);
    expect(fireEvent.keyDown(field, { key: "s", ctrlKey: true })).toBe(true);
    fireEvent.keyDown(field, { key: "t" });
    expect(actions.undo).not.toHaveBeenCalled();
    expect(actions.save).not.toHaveBeenCalled();
    expect(actions.tool).not.toHaveBeenCalled();
    off();
  });
});
