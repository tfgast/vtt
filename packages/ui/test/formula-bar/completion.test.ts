// @vitest-environment node
/**
 * Formula completion, the pure part (vtt-qf5.16; DESIGN.md §4.6 The formula
 * bar; FORMULAS.md §3, §3.2, §6): bare prefixes, function prefixes, dot
 * access through reference cells as the viewer's views show them, literal
 * mode, and the caret inside the text. The bar's keyboard and pointer
 * handling runs in formula-bar.test.tsx.
 */
import type { CellView, ObjectView } from "@vtt/protocol";
import {
  applyCompletion,
  COMPLETION_FUNCTION_NAMES,
  type CompletionContext,
  cellNameSource,
  MAX_SUGGESTIONS,
  suggestCompletions,
} from "@vtt/ui";
import { describe, expect, test } from "vitest";

const lit = (value: CellView["value"]): CellView => ({ kind: "literal", value });
const num = (value: number) => lit({ type: "number", value });
const ref = (object: string) => lit({ type: "ref", object });

function view(id: string, cells: Record<string, CellView>): ObjectView {
  return { id, is_template: false, is_character: false, cells, actions: [] };
}

/** The goblin (edited, `hp`), its target `orc` (a view without the hidden `secret`), and `wolf`. */
const VIEWS: Record<string, ObjectView> = {
  goblin: view("goblin", {
    name: lit({ type: "text", value: "Goblin" }),
    hp: num(5),
    max_hp: num(12),
    Max_Mana: num(3),
    mood: num(0),
    target: ref("orc"),
    "My Target": ref("orc"),
    level: num(2),
    "Max HP": num(1),
    d6: num(4),
  }),
  orc: view("orc", {
    name: lit({ type: "text", value: "Orc" }),
    ac: num(13),
    armor: num(1),
    pet: ref("wolf"),
    "Best Pet": ref("wolf"),
  }),
  wolf: view("wolf", { bite: num(4) }),
};

/** A fixed function list, so a growing library does not move these expectations. */
const FUNCTIONS = ["floor", "max", "min", "sum"];

const ctx = (over: Partial<CompletionContext> = {}): CompletionContext => ({
  object: "goblin",
  cell: "hp",
  objectView: (id) => VIEWS[id] ?? null,
  functions: FUNCTIONS,
  ...over,
});

/** Suggestions for `text` with the caret at `|` (or at the end). */
function labels(marked: string, over: Partial<CompletionContext> = {}): string[] | null {
  const caret = marked.includes("|") ? marked.indexOf("|") : marked.length;
  const text = marked.replace("|", "");
  return suggestCompletions(text, caret, ctx(over))?.items.map((i) => i.label) ?? null;
}

describe("formula completion", () => {
  test("a bare prefix suggests the object's cells, case-insensitively, not the edited cell", () => {
    expect(labels("=ma")).toEqual(["Max HP", "max_hp", "Max_Mana", "max"]);
    expect(labels("=MO")).toEqual(["mood"]);
    expect(labels("=h")).toBeNull(); // hp is the edited cell
    expect(labels("=h", { cell: "mood" })).toEqual(["hp"]);
  });

  test("a function prefix suggests the callable functions, never the methods", () => {
    expect(labels("=1 + flo")).toEqual(["floor"]);
    expect(labels("=1 + flo", { functions: undefined })).toEqual(["floor"]);
    expect(labels("=wh", { functions: undefined })).toBeNull();
    expect(COMPLETION_FUNCTION_NAMES).toContain("sum");
    expect(COMPLETION_FUNCTION_NAMES).toContain("objects");
    expect(COMPLETION_FUNCTION_NAMES).not.toContain("where");
    expect(COMPLETION_FUNCTION_NAMES).not.toContain("sort");
    expect([...COMPLETION_FUNCTION_NAMES]).toEqual([...COMPLETION_FUNCTION_NAMES].sort());
  });

  test("after `target.`, the target's cells as the view shows them", () => {
    expect(labels("=target.")).toEqual(["ac", "armor", "Best Pet", "id", "name", "pet"]);
    expect(labels("=target.a")).toEqual(["ac", "armor"]);
    expect(labels("=target.secret")).toBeNull();
    expect(labels("=target.pet.")).toEqual(["bite", "id"]);
    expect(labels("=this.ma")).toEqual(["Max HP", "max_hp", "Max_Mana"]);
    expect(labels("=this.h")).toBeNull();
  });

  test("backtick names are followed as reference steps, head or intermediate", () => {
    expect(labels("=`My Target`.a")).toEqual(["ac", "armor"]);
    expect(labels("=target.`Best Pet`.")).toEqual(["bite", "id"]);
    expect(labels("=`My Target`.`Best Pet`.b")).toEqual(["bite"]);
    expect(labels("=`Max HP`.")).toBeNull();
  });

  test("a dot on something that is not a reference cell suggests nothing", () => {
    expect(labels("=level.")).toBeNull();
    expect(labels("=nothing.")).toBeNull();
    expect(labels("=(target).")).toBeNull();
    expect(labels("=it.")).toBeNull();
    expect(labels("=target. ")).toBeNull();
  });

  test("nothing in literal mode, in `name`, in text, or with an empty prefix", () => {
    expect(labels("ma")).toBeNull();
    expect(labels("=ma", { cell: "name" })).toBeNull();
    expect(labels('="ma')).toBeNull();
    expect(labels('="ma"')).toBeNull();
    expect(labels("=")).toBeNull();
    expect(labels("=1 + ")).toBeNull();
    expect(labels("=2d6")).toBeNull();
    expect(labels("=max_hp")).toBeNull(); // only itself matches
  });

  test("the caret in the middle of the text completes the identifier under it", () => {
    const text = "=mo + 1";
    const completion = suggestCompletions(text, 3, ctx());
    expect(completion?.items.map((i) => i.label)).toEqual(["mood"]);
    expect(completion?.prefix).toBe("mo");
    expect(labels("=m|o + 1")).toEqual([
      "Max HP",
      "max_hp",
      "Max_Mana",
      "mood",
      "My Target",
      "max",
      "min",
    ]);
    expect(labels("=mo + |1")).toBeNull();
    expect(labels("=target.a| + mood")).toEqual(["ac", "armor"]);
  });

  test("accepting replaces the identifier and puts the caret after the insert", () => {
    const text = "=m + 1";
    const completion = suggestCompletions(text, 2, ctx());
    if (completion === null) throw new Error("no completion");
    const mood = completion.items.find((i) => i.label === "mood");
    if (mood === undefined) throw new Error("no mood");
    expect(applyCompletion(text, completion, mood)).toEqual({ text: "=mood + 1", caret: 5 });

    const mid = suggestCompletions("=moxx", 3, ctx());
    if (mid === null) throw new Error("no completion");
    expect(applyCompletion("=moxx", mid, mid.items[0] as never)).toEqual({
      text: "=mood",
      caret: 5,
    });

    const fn = suggestCompletions("=flo", 4, ctx());
    if (fn === null) throw new Error("no completion");
    expect(applyCompletion("=flo", fn, fn.items[0] as never)).toEqual({
      text: "=floor(",
      caret: 7,
    });
    const spaced = suggestCompletions("=flo (1)", 4, ctx());
    if (spaced === null) throw new Error("no completion");
    expect(applyCompletion("=flo (1)", spaced, spaced.items[0] as never)).toEqual({
      text: "=floor (1)",
      caret: 6,
    });
    const called = suggestCompletions("=flo(x)", 4, ctx());
    if (called === null) throw new Error("no completion");
    expect(applyCompletion("=flo(x)", called, called.items[0] as never)).toEqual({
      text: "=floor(x)",
      caret: 6,
    });

    const dot = suggestCompletions("=target.", 8, ctx());
    if (dot === null) throw new Error("no completion");
    expect(applyCompletion("=target.", dot, dot.items[0] as never)).toEqual({
      text: "=target.ac",
      caret: 10,
    });
  });

  test("names that are not plain identifiers are inserted in backticks", () => {
    expect(cellNameSource("max_hp")).toBe("max_hp");
    expect(cellNameSource("Max HP")).toBe("`Max HP`");
    expect(cellNameSource("d6")).toBe("`d6`");
    expect(cellNameSource("this")).toBe("`this`");
    const completion = suggestCompletions("=Max", 4, ctx());
    expect(completion?.items[0]).toEqual({ label: "Max HP", kind: "cell", insert: "`Max HP`" });
  });

  test("at most MAX_SUGGESTIONS, cells before functions", () => {
    const cells: Record<string, CellView> = {};
    for (let i = 0; i < 12; i++) cells[`s${i}`] = num(i);
    const many: Record<string, ObjectView> = {
      ...VIEWS,
      goblin: view("goblin", { ...cells, hp: num(1) }),
    };
    const items = suggestCompletions("=s", 2, ctx({ objectView: (id) => many[id] ?? null }))?.items;
    expect(items).toHaveLength(MAX_SUGGESTIONS);
    expect(items?.every((i) => i.kind === "cell")).toBe(true);
  });
});
