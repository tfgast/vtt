/**
 * Face layouts (vtt-1xv.7; DESIGN.md §4.1, §4.6 "Face layouts"; PROTOCOL.md
 * §5; M5-D7): the encoding, `faceProblem`, the frames, and the `face` field
 * of objects, effects and the file.
 */
import {
  COLLAPSED_FRAME,
  defaultFaceFrame,
  type FaceElement,
  type FaceLayout,
  FaceLayoutSchema,
  faceProblem,
  MAX_FACE_ELEMENTS,
  type OpGroup,
  OpGroupSchema,
  type TableObject,
  TableObjectSchema,
} from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { obj } from "./helpers";

/** DESIGN.md §4.6, verbatim. */
const ATTACK_CARD_JSON = `{"elements": [
  {"type": "value", "cell": "name", "rect": [-1.2, -1.7, 2.4, 0.4], "style": {"size": "large"}},
  {"type": "editor", "cell": "target", "rect": [-1.2, -1.2, 2.4, 0.4], "style": {"caption": true}},
  {"type": "value", "cell": "total", "rect": [-1.2, -0.7, 1.1, 0.5], "style": {"caption": true}},
  {"type": "value", "cell": "hit", "rect": [0.1, -0.7, 1.1, 0.5], "style": {"caption": true}},
  {"type": "value", "cell": "dmg", "rect": [-1.2, -0.1, 2.4, 0.4], "style": {"caption": true}},
  {"type": "button", "action": "Roll", "rect": [-1.2, 0.5, 1.1, 0.45], "show_when": "roll = empty"},
  {"type": "button", "action": "Roll damage", "rect": [0.1, 0.5, 1.1, 0.45], "show_when": "hit and dmg = empty"},
  {"type": "button", "action": "Apply", "rect": [-1.2, 1.1, 2.4, 0.45], "show_when": "not applied"}],
 "default_action": "Roll"}`;

const attackCard = (): FaceLayout => JSON.parse(ATTACK_CARD_JSON) as FaceLayout;

const value = (cell: string): FaceElement => ({ type: "value", cell, rect: [0, 0, 1, 1] });
const button = (action: string): FaceElement => ({ type: "button", action, rect: [0, 0, 1, 1] });
const contents = (): FaceElement => ({ type: "contents", rect: [0, 0, 1, 1] });

/** Every element kind with every option. */
const full: FaceLayout = {
  elements: [
    {
      type: "value",
      cell: "hp",
      rect: [-1, -0.5, 2, 0.5],
      show_when: "hp > 0",
      min_size: 24,
      style: { size: "huge", align: "right", caption: false },
    },
    { type: "editor", cell: "notes", rect: [-1, 0, 2, 0.5], style: { align: "left" } },
    { type: "button", action: "Roll", rect: [0, 0, 1, 1], label: "Roll it", min_size: 0 },
    {
      type: "contents",
      rect: [0, 1, 2, 3],
      entries: "full",
      show_when: "true",
      when_selected: true,
    },
  ],
  collapsed: [
    { type: "value", cell: "name", rect: [0, 0, 6, 0.6] },
    { type: "contents", rect: [0, 0, 1, 0.6], entries: "collapsed" },
  ],
  default_action: "Roll",
};

const ok = (face: unknown) => {
  const parsed = FaceLayoutSchema.safeParse(face);
  return parsed.success && faceProblem(parsed.data) === undefined;
};

describe("FaceLayoutSchema", () => {
  test("accepts the Attack card face of DESIGN.md §4.6", () => {
    const face = attackCard();
    expect(FaceLayoutSchema.parse(face)).toEqual(face);
    expect(faceProblem(face)).toBeUndefined();
    expect(face.elements).toHaveLength(8);
  });

  test("accepts every element kind with every option, and an empty layout", () => {
    expect(FaceLayoutSchema.parse(full)).toEqual(full);
    expect(faceProblem(full)).toBeUndefined();
    expect(ok({ elements: [] })).toBe(true);
    expect(ok({ elements: [], collapsed: [] })).toBe(true);
  });

  const malformed: [string, unknown][] = [
    ["no elements", {}],
    ["an unknown layout key", { elements: [], shown: true }],
    ["an unknown element key", { elements: [{ ...value("hp"), shown: true }] }],
    ["an unknown element type", { elements: [{ type: "image", cell: "x", rect: [0, 0, 1, 1] }] }],
    ["a value element without a cell", { elements: [{ type: "value", rect: [0, 0, 1, 1] }] }],
    ["a button without an action", { elements: [{ type: "button", rect: [0, 0, 1, 1] }] }],
    ["a button with a cell", { elements: [{ ...button("Roll"), cell: "hp" }] }],
    ["a contents element with a style", { elements: [{ ...contents(), style: {} }] }],
    ["a value element with a label", { elements: [{ ...value("hp"), label: "HP" }] }],
    ["a rect of three numbers", { elements: [{ ...value("hp"), rect: [0, 0, 1] }] }],
    ["a rect of five numbers", { elements: [{ ...value("hp"), rect: [0, 0, 1, 1, 1] }] }],
    ["a rect holding text", { elements: [{ ...value("hp"), rect: [0, 0, "1", 1] }] }],
    ["an infinite rect", { elements: [{ ...value("hp"), rect: [0, 0, Infinity, 1] }] }],
    ["a NaN rect", { elements: [{ ...value("hp"), rect: [Number.NaN, 0, 1, 1] }] }],
    ["an unknown style size", { elements: [{ ...value("hp"), style: { size: "tiny" } }] }],
    ["an unknown style key", { elements: [{ ...value("hp"), style: { color: "red" } }] }],
    ["a non-boolean caption", { elements: [{ ...value("hp"), style: { caption: "yes" } }] }],
    ["an unknown entries value", { elements: [{ ...contents(), entries: "some" }] }],
    ["a string when_selected", { elements: [{ ...contents(), when_selected: "true" }] }],
    ["a numeric when_selected", { elements: [{ ...contents(), when_selected: 1 }] }],
    ["a null when_selected", { elements: [{ ...contents(), when_selected: null }] }],
    ["when_selected on a value element", { elements: [{ ...value("hp"), when_selected: true }] }],
    ["when_selected on a button", { elements: [{ ...button("Roll"), when_selected: true }] }],
    ["a non-string show_when", { elements: [{ ...value("hp"), show_when: true }] }],
    ["a non-number min_size", { elements: [{ ...value("hp"), min_size: "24" }] }],
    ["a non-string default_action", { elements: [], default_action: 3 }],
    ["collapsed that is not a list", { elements: [], collapsed: value("hp") }],
  ];

  test.each(malformed)("rejects %s", (_, face) => {
    expect(FaceLayoutSchema.safeParse(face).success).toBe(false);
  });
});

describe("when_selected (M6-D12)", () => {
  test("a contents element takes when_selected true or false, in either list", () => {
    for (const when_selected of [true, false]) {
      const face: FaceLayout = {
        elements: [{ ...contents(), when_selected } as FaceElement],
        collapsed: [{ ...contents(), when_selected } as FaceElement],
      };
      expect(FaceLayoutSchema.parse(face)).toEqual(face);
      expect(faceProblem(face)).toBeUndefined();
    }
  });

  test("absent is unset: the parsed element gains no when_selected", () => {
    const parsed = FaceLayoutSchema.parse({ elements: [contents()] });
    expect(Object.hasOwn(parsed.elements[0] as object, "when_selected")).toBe(false);
  });

  test("an object's stored face keeps it", () => {
    const o = obj("tok", {
      face: { elements: [{ type: "contents", rect: [-1.5, 0.9, 3, 1.2], when_selected: true }] },
    });
    expect(TableObjectSchema.parse(o).face?.elements[0]).toEqual({
      type: "contents",
      rect: [-1.5, 0.9, 3, 1.2],
      when_selected: true,
    });
  });
});

describe("faceProblem", () => {
  const many = (n: number, make: (i: number) => FaceElement = (i) => value(`c${i}`)) =>
    Array.from({ length: n }, (_, i) => make(i));

  test("MAX_FACE_ELEMENTS is 200: 200 elements pass, 201 are refused, in either list", () => {
    expect(MAX_FACE_ELEMENTS).toBe(200);
    expect(faceProblem({ elements: many(200) })).toBeUndefined();
    expect(faceProblem({ elements: [], collapsed: many(200) })).toBeUndefined();
    expect(faceProblem({ elements: many(201) })).toMatch(/200/);
    expect(faceProblem({ elements: [], collapsed: many(201) })).toMatch(/200/);
  });

  const problems: [string, FaceLayout][] = [
    ["an empty cell name", { elements: [value("")] }],
    ["a __proto__ cell name", { elements: [value("__proto__")] }],
    [
      "an empty cell name in an editor",
      { elements: [{ type: "editor", cell: "", rect: [0, 0, 1, 1] }] },
    ],
    ["an empty action name", { elements: [button("")] }],
    ["an action name of 101 characters", { elements: [button("x".repeat(101))] }],
    ["an empty default_action", { elements: [], default_action: "" }],
    ["a default_action of 101 characters", { elements: [], default_action: "y".repeat(101) }],
    ["a blank show_when", { elements: [{ ...value("hp"), show_when: " \t" }] }],
    ["an empty show_when", { elements: [{ ...button("Roll"), show_when: "" }] }],
    [
      "a show_when of 10,001 characters",
      { elements: [{ ...contents(), show_when: `${"1".repeat(10000)} ` }] },
    ],
    ["a negative min_size", { elements: [{ ...value("hp"), min_size: -1 }] }],
    ["an infinite min_size", { elements: [{ ...value("hp"), min_size: Infinity }] }],
    ["a zero rect width", { elements: [{ ...value("hp"), rect: [0, 0, 0, 1] }] }],
    ["a negative rect height", { elements: [{ ...value("hp"), rect: [0, 0, 1, -1] }] }],
    ["an infinite rect x", { elements: [{ ...value("hp"), rect: [-Infinity, 0, 1, 1] }] }],
    ["two contents elements", { elements: [contents(), value("hp"), contents()] }],
    ["two contents elements in collapsed", { elements: [], collapsed: [contents(), contents()] }],
    ["a problem in the collapsed list", { elements: [value("hp")], collapsed: [value("")] }],
  ];

  test.each(problems)("refuses %s", (_, face) => {
    expect(faceProblem(face)).toEqual(expect.any(String));
  });

  test("boundaries pass: 100-character names, a 10,000-character show_when, min_size 0", () => {
    const face: FaceLayout = {
      elements: [
        { ...button("x".repeat(100)), show_when: "1".repeat(10000), min_size: 0 },
        value("a"),
        value("hp and spaces are fine"),
      ],
      default_action: "x".repeat(100),
    };
    expect(faceProblem(face)).toBeUndefined();
  });

  test("one contents element per list: one in each list passes", () => {
    expect(faceProblem({ elements: [contents()], collapsed: [contents()] })).toBeUndefined();
  });

  test("a default_action need not name an existing action (checked live, not stored)", () => {
    expect(faceProblem({ elements: [button("Missing")], default_action: "Missing" })).toBe(
      undefined,
    );
  });
});

describe("frames", () => {
  test("COLLAPSED_FRAME is [0, 0, 6, 0.6]", () => {
    expect(COLLAPSED_FRAME).toEqual([0, 0, 6, 0.6]);
  });

  test("a shapeless object's full-face frame is [-1, -0.5, 2, 1]", () => {
    expect(defaultFaceFrame(null)).toEqual([-1, -0.5, 2, 1]);
  });

  test("the full-face frame is the shape's unrotated bounding box about the anchor", () => {
    expect(defaultFaceFrame({ type: "rect", width: 2.6, height: 4 })).toEqual([-1.3, -2, 2.6, 4]);
    expect(defaultFaceFrame({ type: "circle", radius: 0.5 })).toEqual([-0.5, -0.5, 1, 1]);
    expect(
      defaultFaceFrame({
        type: "polygon",
        points: [
          [0, 0],
          [3, 1],
          [1, 2],
        ],
      }),
    ).toEqual([0, 0, 3, 2]);
  });

  test("returns a fresh array each time", () => {
    const a = defaultFaceFrame(null);
    a[0] = 99;
    expect(defaultFaceFrame(null)).toEqual([-1, -0.5, 2, 1]);
  });
});

describe("the face field", () => {
  const card: TableObject = obj("attack_card", {
    is_template: true,
    cells: { name: { content: { type: "text", value: "Attack" } } },
    face: attackCard(),
  });

  test("an object with a face round-trips through JSON and the object schema", () => {
    expect(TableObjectSchema.parse(JSON.parse(JSON.stringify(card)))).toEqual(card);
  });

  test("an object without a face is still valid: absent means no layout", () => {
    const { face: _face, ...plain } = card;
    expect(TableObjectSchema.safeParse(plain).success).toBe(true);
  });

  test("the object schema refuses a malformed face, a faceProblem, and a null face", () => {
    expect(TableObjectSchema.safeParse({ ...card, face: { elements: [{}] } }).success).toBe(false);
    const tooMany = { elements: Array.from({ length: 201 }, (_, i) => value(`c${i}`)) };
    expect(TableObjectSchema.safeParse({ ...card, face: tooMany }).success).toBe(false);
    expect(TableObjectSchema.safeParse({ ...card, face: null }).success).toBe(false);
  });

  test("a face field effect validates, null meaning no layout", () => {
    const group: OpGroup = {
      index: 0,
      base_revision: 0,
      revision: 1,
      actor: { type: "gm" },
      kind: "edit",
      label: "set_face attack_card",
      names: { attack_card: "Attack" },
      effects: [
        { type: "field", object: "attack_card", field: "face", before: null, after: attackCard() },
        { type: "field", object: "attack_card", field: "face", before: attackCard(), after: null },
        { type: "create", objects: [card], location: { type: "board", board: "table" } },
      ],
    };
    expect(OpGroupSchema.parse(JSON.parse(JSON.stringify(group)))).toEqual(group);
    const bad = structuredClone(group) as unknown as { effects: { after: unknown }[] };
    (bad.effects[0] as { after: unknown }).after = { elements: [value("")] };
    expect(OpGroupSchema.safeParse(bad).success).toBe(false);
  });
});
