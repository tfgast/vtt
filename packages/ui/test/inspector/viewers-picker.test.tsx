/**
 * `ViewersPicker` (vtt-3l6.11; DESIGN.md §4.4): checkboxes for `all`, `gm`,
 * `owner` and each character, plus "Default (object's visibility)". A
 * controlled component: it reports the next viewer set and never an empty one.
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { InputViewers } from "@vtt/protocol";
import { ViewersPicker } from "@vtt/ui";
import { afterEach, expect, test, vi } from "vitest";

afterEach(cleanup);

const CHARACTERS = [
  { id: "aldric", label: "Aldric" },
  { id: "bryn", label: "Bryn" },
];

const box = (name: string) => screen.getByRole("checkbox", { name }) as HTMLInputElement;

test("shows the value as checked boxes and adds a character", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn<(next: InputViewers | null) => void>();
  render(
    <ViewersPicker
      value={{ type: "viewers", viewers: ["gm"] }}
      onChange={onChange}
      characters={CHARACTERS}
      label="Visibility of hp"
    />,
  );
  expect(screen.getByRole("group", { name: "Visibility of hp" })).toBeDefined();
  expect(box("all").checked).toBe(false);
  expect(box("gm").checked).toBe(true);
  expect(box("owner").checked).toBe(false);
  expect(box("Aldric").checked).toBe(false);
  expect(box("Bryn").checked).toBe(false);
  expect(box("Default (object's visibility)").checked).toBe(false);
  await user.click(box("Aldric"));
  expect(onChange).toHaveBeenLastCalledWith({
    type: "viewers",
    viewers: ["gm", { type: "ref", object: "aldric" }],
  });
});

test("the only checked entry cannot be unchecked: a viewer set is never empty", () => {
  render(
    <ViewersPicker
      value={{ type: "viewers", viewers: ["gm"] }}
      onChange={() => undefined}
      characters={CHARACTERS}
    />,
  );
  expect(box("gm").disabled).toBe(true);
  expect(box("all").disabled).toBe(false);
});

test("unchecking one of several entries removes it, in canonical order", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn<(next: InputViewers | null) => void>();
  render(
    <ViewersPicker
      value={{ type: "viewers", viewers: [{ type: "ref", object: "bryn" }, "all", "gm"] }}
      onChange={onChange}
      characters={CHARACTERS}
    />,
  );
  await user.click(box("all"));
  expect(onChange).toHaveBeenLastCalledWith({
    type: "viewers",
    viewers: ["gm", { type: "ref", object: "bryn" }],
  });
});

test("Default clears to null, and a null value shows Default checked", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn<(next: InputViewers | null) => void>();
  const { rerender } = render(
    <ViewersPicker
      value={{ type: "viewers", viewers: ["owner"] }}
      onChange={onChange}
      characters={CHARACTERS}
    />,
  );
  await user.click(box("Default (object's visibility)"));
  expect(onChange).toHaveBeenLastCalledWith(null);

  rerender(<ViewersPicker value={null} onChange={onChange} characters={CHARACTERS} />);
  expect(box("Default (object's visibility)").checked).toBe(true);
  expect(box("Default (object's visibility)").disabled).toBe(true);
  expect(box("gm").checked).toBe(false);
  await user.click(box("gm"));
  expect(onChange).toHaveBeenLastCalledWith({ type: "viewers", viewers: ["gm"] });
});

test("without allowDefault there is no Default entry", () => {
  render(
    <ViewersPicker
      value={{ type: "viewers", viewers: ["all"] }}
      onChange={() => undefined}
      characters={CHARACTERS}
      allowDefault={false}
    />,
  );
  expect(screen.queryByRole("checkbox", { name: "Default (object's visibility)" })).toBeNull();
});

test("a ref that is not a listed character is kept and shown by id", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn<(next: InputViewers | null) => void>();
  render(
    <ViewersPicker
      value={{ type: "viewers", viewers: [{ type: "ref", object: "zed" }] }}
      onChange={onChange}
      characters={CHARACTERS}
    />,
  );
  expect(box("zed").checked).toBe(true);
  await user.click(box("gm"));
  expect(onChange).toHaveBeenLastCalledWith({
    type: "viewers",
    viewers: ["gm", { type: "ref", object: "zed" }],
  });
});

test("disabled disables every entry", () => {
  render(
    <ViewersPicker
      value={{ type: "viewers", viewers: ["all", "gm"] }}
      onChange={() => undefined}
      characters={CHARACTERS}
      disabled
    />,
  );
  for (const checkbox of screen.getAllByRole("checkbox")) {
    expect((checkbox as HTMLInputElement).disabled).toBe(true);
  }
});
