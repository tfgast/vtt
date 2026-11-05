// @vitest-environment node
/**
 * Log sentences (vtt-1xv.20; DESIGN.md §4.8; PROTOCOL.md §7.6): one header
 * per group and one sentence per effect, every `EffectView` variant, names
 * as captured at commit, "an object" when a name is absent, a character
 * group with `label: null` titled by its kind.
 */
import type { CellStateView, EffectView, GroupView } from "@vtt/protocol";
import { describeGroup, type GroupDescription } from "@vtt/ui";
import { describe, expect, test } from "vitest";

const GM = { type: "gm" } as const;
const ALDRIC = { type: "character", id: "aldric" } as const;

const lit = (value: unknown): CellStateView => ({ kind: "literal", value }) as CellStateView;
const n = (value: number): CellStateView => ({ kind: "literal", value: { type: "number", value } });
const f = (source?: string, override?: number): CellStateView => ({
  kind: "formula",
  ...(source === undefined ? {} : { source }),
  ...(override === undefined ? {} : { override: { type: "number", value: override } }),
});

function group(effects: EffectView[], extra: Partial<GroupView> = {}): GroupView {
  return {
    index: 7,
    revision: 8,
    actor: { type: "gm" },
    kind: "edit",
    label: "Edit",
    base_revision: 7,
    undone: false,
    names: { goblin: "Goblin", card: "Attack", aldric: "Aldric", binder: "Binder" },
    effects,
    ...extra,
  };
}

const sentences = (d: GroupDescription) => d.sentences.map((s) => s.text);
const one = (effect: EffectView, extra: Partial<GroupView> = {}) =>
  sentences(describeGroup(group([effect], extra), GM, { boardName: (id) => `Board ${id}` }));

describe("headers", () => {
  test("the GM, the label, not undone", () => {
    const d = describeGroup(group([], { kind: "action", label: "Apply" }), GM);
    expect(d).toMatchObject({
      index: 7,
      actor: "GM",
      title: "Apply",
      header: "GM: Apply",
      kind: "action",
      undone: false,
    });
  });

  test("an agent by its name, or 'Agent'", () => {
    expect(describeGroup(group([], { actor: { type: "agent", name: "Sage" } }), GM).actor).toBe(
      "Sage",
    );
    expect(describeGroup(group([], { actor: { type: "agent" } }), GM).actor).toBe("Agent");
  });

  test("a character by its names entry, else its id", () => {
    expect(describeGroup(group([], { actor: { type: "character", id: "aldric" } }), GM).actor).toBe(
      "Aldric",
    );
    expect(describeGroup(group([], { actor: { type: "character", id: "bryn" } }), GM).actor).toBe(
      "bryn",
    );
  });

  test("a character group view with label null shows its kind, and missing names read 'an object'", () => {
    const d = describeGroup(
      group(
        [
          {
            type: "cell",
            object: "goblin",
            cell: "hp",
            before: lit({ type: "redacted" }),
            after: lit({ type: "redacted" }),
            cause: "edit",
          },
        ],
        { label: null, kind: "action", names: {} },
      ),
      ALDRIC,
    );
    expect(d.title).toBe("action");
    expect(d.header).toBe("GM: action");
    expect(sentences(d)).toEqual(["Set an object.hp to hidden (was hidden)"]);
    expect(d.sentences[0]?.object).toBe("goblin");
  });

  test("undone is carried", () => {
    expect(describeGroup(group([], { undone: true }), GM).undone).toBe(true);
  });

  test("a group without effects has no sentences", () => {
    const { effects: _, ...bare } = group([]);
    expect(describeGroup(bare, GM).sentences).toEqual([]);
  });
});

describe("cell effects", () => {
  const cell = (
    before: CellStateView | null,
    after: CellStateView | null,
    cause: "edit" | "roll" = "edit",
  ): EffectView => ({ type: "cell", object: "goblin", cell: "damage_taken", before, after, cause });

  test("a literal write", () => {
    expect(one(cell(n(0), n(8)))).toEqual(["Set Goblin.damage_taken to 8 (was 0)"]);
  });

  test("a new cell", () => {
    expect(one(cell(null, n(3)))).toEqual(["Set Goblin.damage_taken to 3"]);
  });

  test("an empty value reads empty", () => {
    expect(one(cell(n(3), lit({ type: "empty" })))).toEqual([
      "Set Goblin.damage_taken to empty (was 3)",
    ]);
  });

  test("a roll", () => {
    const roll = lit({ type: "roll", expr: "1d20", dice: [14], dropped: [], total: 14 });
    expect(
      one({ type: "cell", object: "card", cell: "roll", before: null, after: roll, cause: "roll" }),
    ).toEqual(["Rolled 1d20 → 14 into Attack.roll"]);
  });

  test("a redacted roll", () => {
    expect(
      one({
        type: "cell",
        object: "card",
        cell: "roll",
        before: null,
        after: lit({ type: "redacted" }),
        cause: "roll",
      }),
    ).toEqual(["Rolled hidden into Attack.roll"]);
  });

  test("a formula", () => {
    expect(one(cell(n(1), f("max_hp - 3")))).toEqual([
      'Set Goblin.damage_taken to the formula "max_hp - 3" (was 1)',
    ]);
  });

  test("a formula without source (a character's view)", () => {
    expect(one(cell(null, f()))).toEqual(["Set Goblin.damage_taken to a formula"]);
  });

  test("an override", () => {
    expect(one(cell(f("x"), f("x", 5)))).toEqual(["Overrode Goblin.damage_taken with 5"]);
    expect(one(cell(f("x", 4), f("x", 5)))).toEqual([
      "Overrode Goblin.damage_taken with 5 (was 4)",
    ]);
  });

  test("clearing an override", () => {
    expect(one(cell(f("x", 4), f("x")))).toEqual([
      "Cleared the override on Goblin.damage_taken (was 4)",
    ]);
  });

  test("a delete", () => {
    expect(one(cell(n(2), null))).toEqual(["Deleted Goblin.damage_taken (was 2)"]);
    expect(one(cell(f("x", 2), null))).toEqual([
      'Deleted Goblin.damage_taken (was 2, overriding the formula "x")',
    ]);
  });

  test("a ref value uses the captured name", () => {
    expect(
      one({
        type: "cell",
        object: "card",
        cell: "target",
        before: lit({ type: "empty" }),
        after: lit({ type: "ref", object: "goblin" }),
        cause: "edit",
      }),
    ).toEqual(["Set Attack.target to Goblin (was empty)"]);
  });

  test("a cell visibility change", () => {
    expect(
      one({
        type: "cell_visibility",
        object: "goblin",
        cell: "ac",
        before: null,
        after: { type: "viewers", viewers: ["gm"] },
      }),
    ).toEqual(["Made Goblin.ac visible to gm"]);
    expect(
      one({
        type: "cell_visibility",
        object: "goblin",
        cell: "ac",
        before: { type: "viewers", viewers: ["gm"] },
        after: null,
      }),
    ).toEqual(["Reset the visibility of Goblin.ac"]);
  });
});

describe("field effects", () => {
  test("tags", () => {
    expect(
      one({ type: "field", object: "goblin", field: "tag", before: [], after: ["monster", "npc"] }),
    ).toEqual(["Set the tags of Goblin to monster, npc"]);
    expect(
      one({ type: "field", object: "goblin", field: "tag", before: ["npc"], after: [] }),
    ).toEqual(["Set the tags of Goblin to none"]);
  });

  test("shape", () => {
    expect(
      one({
        type: "field",
        object: "goblin",
        field: "shape",
        before: null,
        after: { type: "rect", width: 2, height: 3 },
      }),
    ).toEqual(["Set the shape of Goblin to rect 2×3"]);
    expect(
      one({
        type: "field",
        object: "goblin",
        field: "shape",
        before: { type: "circle", radius: 1 },
        after: null,
      }),
    ).toEqual(["Removed the shape of Goblin"]);
  });

  test("flags", () => {
    expect(
      one({ type: "field", object: "card", field: "is_template", before: false, after: true }),
    ).toEqual(["Made Attack a template"]);
    expect(
      one({ type: "field", object: "card", field: "is_template", before: true, after: false }),
    ).toEqual(["Made Attack no longer a template"]);
    expect(
      one({ type: "field", object: "aldric", field: "is_character", before: false, after: true }),
    ).toEqual(["Made Aldric a character"]);
    expect(
      one({ type: "field", object: "aldric", field: "is_character", before: true, after: false }),
    ).toEqual(["Made Aldric no longer a character"]);
  });

  test("actions", () => {
    expect(
      one({
        type: "field",
        object: "card",
        field: "actions",
        before: [],
        after: [{ name: "Roll" }, { name: "Apply" }],
      }),
    ).toEqual(["Set the actions of Attack to Roll, Apply"]);
    expect(
      one({
        type: "field",
        object: "card",
        field: "actions",
        before: [{ name: "Roll" }],
        after: [],
      }),
    ).toEqual(["Removed the actions of Attack"]);
  });

  test("face", () => {
    const face = { elements: [] };
    expect(
      one({ type: "field", object: "card", field: "face", before: null, after: face }),
    ).toEqual(["Added a face to Attack"]);
    expect(
      one({ type: "field", object: "card", field: "face", before: face, after: null }),
    ).toEqual(["Removed the face of Attack"]);
    expect(
      one({ type: "field", object: "card", field: "face", before: face, after: face }),
    ).toEqual(["Changed the face of Attack"]);
  });
});

describe("placement and structure", () => {
  test("a move onto a board folds in the position", () => {
    const d = describeGroup(
      group([
        {
          type: "place",
          object: "goblin",
          before: { type: "container", container: "binder", index: 0 },
          after: { type: "board", board: "map" },
        },
        {
          type: "cell",
          object: "goblin",
          cell: "position",
          before: null,
          after: lit({
            type: "list",
            items: [
              { type: "number", value: 3 },
              { type: "number", value: 4.5 },
            ],
          }),
          cause: "edit",
        },
      ]),
      GM,
      { boardName: (id) => (id === "map" ? "Crypt" : id) },
    );
    expect(sentences(d)).toEqual(["Moved Goblin onto Crypt at (3, 4.5)"]);
    expect(d.sentences[0]?.object).toBe("goblin");
  });

  test("a move onto a board without a position write; board names default to the id", () => {
    const d = describeGroup(
      group([
        {
          type: "place",
          object: "goblin",
          before: { type: "board", board: "a" },
          after: { type: "board", board: "map" },
        },
      ]),
      GM,
    );
    expect(sentences(d)).toEqual(["Moved Goblin onto map"]);
  });

  test("a move into a container, a hidden container", () => {
    expect(
      one({
        type: "place",
        object: "card",
        before: { type: "board", board: "map" },
        after: { type: "container", container: "binder", index: 2 },
      }),
    ).toEqual(["Moved Attack into Binder"]);
    expect(
      one({
        type: "place",
        object: "card",
        before: { type: "board", board: "map" },
        after: { type: "container", container: null, index: 0 },
      }),
    ).toEqual(["Moved Attack into a hidden container"]);
  });

  const snap = (id: string) => ({
    id,
    is_template: false,
    is_zone: false,
    is_character: false,
    cells: {},
    actions: [],
  });

  test("create and remove", () => {
    expect(
      one({ type: "create", location: { type: "board", board: "map" }, objects: [snap("goblin")] }),
    ).toEqual(["Created Goblin on Board map"]);
    expect(
      one({
        type: "create",
        location: { type: "container", container: "binder", index: 0 },
        objects: [snap("card"), snap("x1"), snap("x2"), snap("x3")],
      }),
    ).toEqual(["Created Attack, an object, an object and 1 more in Binder"]);
    expect(
      one({ type: "remove", location: { type: "board", board: "map" }, objects: [snap("goblin")] }),
    ).toEqual(["Removed Goblin from Board map"]);
  });

  test("reorder", () => {
    expect(
      one({ type: "reorder", container: "binder", before: ["a", "b"], after: ["b", "a"] }),
    ).toEqual(["Reordered the contents of Binder"]);
  });

  test("boards", () => {
    expect(one({ type: "board", before: null, after: { id: "map", name: "Crypt" } })).toEqual([
      "Added the board Crypt",
    ]);
    expect(one({ type: "board", before: { id: "map" }, after: null })).toEqual([
      "Removed the board map",
    ]);
    expect(
      one({
        type: "board",
        before: { id: "map", name: "Crypt" },
        after: { id: "map", name: "Tomb" },
      }),
    ).toEqual(["Renamed the board Crypt to Tomb"]);
  });

  test("allocate and retire have no sentence", () => {
    expect(one({ type: "allocate", ids: ["a"], seq_before: 1, seq_after: 2 })).toEqual([]);
    expect(one({ type: "retire", ids: ["a"] })).toEqual([]);
  });
});
