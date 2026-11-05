import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { FORMULAS_FIXTURES, loadScenario, parseScenario, ScenarioSchema } from "@vtt/fixtures";
import { describe, expect, test } from "vitest";

const samples = join(import.meta.dirname, "samples");
// The samples are test-only and are deleted once production scenarios exist
// (vtt-1me.9); the samples block then validates nothing and needs no edit.
const sampleFiles = await readdir(samples).catch(() => [] as string[]);

/** A small valid scenario; each malformed case below breaks exactly one thing. */
function base(): Record<string, unknown> & {
  setup: { boards: unknown[]; characters: string[]; objects: Record<string, unknown>[] };
  dice: unknown[];
  steps: Record<string, unknown>[];
  expect?: unknown[];
} {
  return {
    title: "base",
    source: "Hit points",
    setup: {
      boards: [{ id: "table" }],
      characters: ["aldric"],
      objects: [
        {
          id: "aldric",
          placement: { board: "table", position: [0, 0] },
          cells: {
            max_hp: { type: "number", value: 27 },
            damage_taken: { type: "number", value: 0 },
            hp: { type: "formula", source: "max_hp - damage_taken" },
          },
          actions: [{ name: "Hurt", steps: ["add(damage_taken, 1)"] }],
        },
        {
          id: "bag",
          placement: { board: "table", position: [1, 0] },
          contents: ["card_t"],
        },
        {
          id: "card_t",
          is_template: true,
          contents: ["inner_t"],
          cells: { inner: { type: "ref", object: "inner_t" } },
          actions: [{ name: "Use", steps: ["set(used, true)"] }],
        },
        { id: "inner_t", cells: {} },
      ],
    },
    dice: [],
    steps: [
      {
        actor: "gm",
        do: { type: "invoke", object: "aldric", action: "Hurt" },
        expect: [
          { type: "cell", object: "aldric", cell: "hp", value: { type: "number", value: 26 } },
        ],
      },
    ],
  };
}

/** The messages a scenario is rejected with, or [] if it is valid. */
function issues(data: unknown): string[] {
  const result = ScenarioSchema.safeParse(data);
  return result.success ? [] : result.error.issues.map((i) => i.message);
}

function rejects(mutate: (s: ReturnType<typeof base>) => void, message: RegExp | string): void {
  const s = base();
  mutate(s);
  const found = issues(s);
  expect(found.length, "expected the validator to reject").toBeGreaterThan(0);
  expect(found.join("\n")).toMatch(message);
}

describe("samples", () => {
  test.each(sampleFiles.filter((f) => f.endsWith(".json")))("%s validates", async (file) => {
    const scenario = await loadScenario(join(samples, file));
    expect(FORMULAS_FIXTURES).toContain(scenario.source);
    expect(scenario.steps.length).toBeGreaterThan(0);
  });

  test("the base scenario used below is valid", () => {
    expect(issues(base())).toEqual([]);
  });

  test("loadScenario names the file and every issue", async () => {
    await expect(loadScenario(join(import.meta.dirname, "missing.json"))).rejects.toThrow();
    expect(() => parseScenario({ title: "x" }, "x.json")).toThrow(
      /x\.json is not a valid scenario/,
    );
  });
});

describe("values", () => {
  const setCell = (s: ReturnType<typeof base>, value: unknown) => {
    (s.setup.objects[0] as { cells: Record<string, unknown> }).cells.extra = value;
  };

  test("every storable value kind is accepted", () => {
    const s = base();
    const values = [
      { type: "number", value: -2.5 },
      { type: "text", value: "goblin" },
      { type: "boolean", value: false },
      { type: "empty" },
      {
        type: "list",
        items: [
          { type: "number", value: 1 },
          { type: "list", items: [] },
        ],
      },
      { type: "ref", object: "bag" },
      { type: "dice", expr: "4d6dl1" },
      { type: "roll", expr: "4d6dl1", dice: [6, 4, 3], dropped: [1], total: 13 },
      { type: "viewers", viewers: ["gm", { type: "ref", object: "aldric" }] },
      {
        type: "ink",
        strokes: [
          [
            [0, 0],
            [1, 1],
          ],
        ],
      },
    ];
    values.forEach((v, i) => {
      (s.setup.objects[0] as { cells: Record<string, unknown> }).cells[`v${i}`] = v;
    });
    expect(issues(s)).toEqual([]);
  });

  test("an untagged literal is rejected", () => rejects((s) => setCell(s, 3), /./));
  test("an error is not a storable value", () =>
    rejects((s) => setCell(s, { type: "error", code: "#REF" }), /./));
  test("text cannot carry formula source", () =>
    rejects((s) => setCell(s, { type: "text", source: "a + b" }), /./));
  test("a roll result must list its dropped dice", () =>
    rejects((s) => setCell(s, { type: "roll", expr: "1d20", dice: [3], total: 3 }), /./));
  test("die results are integers", () =>
    rejects(
      (s) => setCell(s, { type: "roll", expr: "1d20", dice: [3.5], dropped: [], total: 3.5 }),
      /./,
    ));
  test("a list item must itself be tagged", () =>
    rejects((s) => setCell(s, { type: "list", items: [1] }), /./));
  test("a reference must resolve", () =>
    rejects((s) => setCell(s, { type: "ref", object: "nobody" }), /unknown object "nobody"/));
  test("a viewer reference must be a character", () =>
    rejects(
      (s) => setCell(s, { type: "viewers", viewers: [{ type: "ref", object: "bag" }] }),
      /"bag" is not a character/,
    ));
  test("an empty viewer set is rejected", () =>
    rejects((s) => setCell(s, { type: "viewers", viewers: [] }), /./));
  test("unknown keys are rejected", () =>
    rejects((s) => setCell(s, { type: "number", value: 1, units: "hp" }), /./));
});

describe("table setup", () => {
  test("duplicate ids", () =>
    rejects((s) => {
      s.setup.objects.push({ id: "aldric", placement: { board: "table", position: [0, 0] } });
    }, /duplicate id "aldric"/));
  test("an object id may not reuse a board id", () =>
    rejects((s) => {
      s.setup.objects.push({ id: "table", placement: { board: "table", position: [0, 0] } });
    }, /duplicate id "table"/));
  test("reserved names", () =>
    rejects((s) => {
      s.setup.objects.push({ id: "gm", placement: { board: "table", position: [0, 0] } });
    }, /reserved/));
  test("container is derived and cannot be written", () =>
    rejects((s) => {
      (s.setup.objects[2] as { cells: Record<string, unknown> }).cells.container = {
        type: "ref",
        object: "bag",
      };
    }, /structural/));
  test("contents is not a cell", () =>
    rejects((s) => {
      (s.setup.objects[0] as { cells: Record<string, unknown> }).cells.contents = {
        type: "list",
        items: [],
      };
    }, /structural/));
  test("both in a container and on a board", () =>
    rejects((s) => {
      s.setup.objects[2] = {
        ...s.setup.objects[2],
        placement: { board: "table", position: [0, 0] },
      };
    }, /in a container and on a board/));
  test("neither in a container nor on a board", () =>
    rejects((s) => {
      s.setup.objects.push({ id: "floating" });
    }, /neither in a container nor placed/));
  test("an object in two containers", () =>
    rejects((s) => {
      s.setup.objects[0] = { ...s.setup.objects[0], contents: ["card_t"] };
    }, /already in the contents/));
  test("containment cycle", () =>
    rejects((s) => {
      s.setup.objects.push({ id: "x", contents: ["y"] }, { id: "y", contents: ["x"] });
    }, /containment cycle/));
  test("placement on an unknown board", () =>
    rejects((s) => {
      s.setup.objects[0] = {
        ...s.setup.objects[0],
        placement: { board: "nowhere", position: [0, 0] },
      };
    }, /unknown board "nowhere"/));
  test("structural cell with the wrong type", () =>
    rejects((s) => {
      (s.setup.objects[0] as { cells: Record<string, unknown> }).cells.visible_to = {
        type: "text",
        value: "gm",
      };
    }, /"visible_to" cannot hold a text/));
  test("cell visibility on an unknown cell", () =>
    rejects((s) => {
      s.setup.objects[0] = {
        ...s.setup.objects[0],
        cell_visibility: { ac: { type: "viewers", viewers: ["gm"] } },
      };
    }, /unknown cell "ac"/));
  test("duplicate action names", () =>
    rejects((s) => {
      s.setup.objects[0] = {
        ...s.setup.objects[0],
        actions: [
          { name: "Roll", steps: ["roll(1d20) -> value"] },
          { name: "Roll", steps: ["roll(1d6) -> value"] },
        ],
      };
    }, /duplicate action "Roll"/));
  test("an action needs at least one step", () =>
    rejects((s) => {
      s.setup.objects[0] = { ...s.setup.objects[0], actions: [{ name: "Noop", steps: [] }] };
    }, /./));
  test("a character must be an object", () =>
    rejects((s) => {
      s.setup.characters.push("bob");
    }, /character "bob" is not an object/));
  test("a polygon needs three points", () =>
    rejects((s) => {
      s.setup.objects[0] = {
        ...s.setup.objects[0],
        shape: {
          type: "polygon",
          points: [
            [0, 0],
            [1, 0],
          ],
        },
      };
    }, /./));
});

describe("zones", () => {
  test("is_zone with opaque is accepted", () => {
    const s = base();
    s.setup.objects.push({
      id: "room",
      is_zone: true,
      shape: { type: "rect", width: 4, height: 3 },
      placement: { board: "table", position: [5, 5] },
      cells: { opaque: { type: "boolean", value: true } },
    });
    expect(issues(s)).toEqual([]);
  });
  test("opaque on an object that is not a zone", () =>
    rejects((s) => {
      s.setup.objects.push({
        id: "rug",
        placement: { board: "table", position: [5, 5] },
        cells: { opaque: { type: "boolean", value: true } },
      });
    }, /"opaque" is for zones only/));
  test("is_zone is structural and rejected inside cells", () =>
    rejects((s) => {
      (s.setup.objects[0] as { cells: Record<string, unknown> }).cells.is_zone = {
        type: "boolean",
        value: true,
      };
    }, /structural/));
  test("a cell named zone is ordinary (Fireball's reference to its zone)", () => {
    const s = base();
    (s.setup.objects[2] as { cells: Record<string, unknown> }).cells.zone = {
      type: "ref",
      object: "inner_t",
    };
    expect(issues(s)).toEqual([]);
  });
  test("opaque at spawn of a template that is not a zone", () =>
    rejects((s) => {
      s.steps.push({
        actor: "gm",
        do: {
          type: "spawn",
          template: "card_t",
          to: { type: "board", board: "table", position: [0, 0] },
          cells: { opaque: { type: "boolean", value: true } },
          as: "c",
        },
      });
    }, /"opaque" is for zones only/));
});

describe("positions", () => {
  test("a placement position may be a formula", () => {
    const s = base();
    s.setup.objects.push({
      id: "follower",
      placement: {
        board: "table",
        position: { type: "formula", source: 'obj("aldric").position' },
      },
    });
    expect(issues(s)).toEqual([]);
  });
  test("a placement position is a pair or a formula, nothing else", () =>
    rejects((s) => {
      s.setup.objects.push({
        id: "follower",
        placement: { board: "table", position: { type: "text", value: "near" } },
      });
    }, /./));
  test("position stays out of cells", () =>
    rejects((s) => {
      (s.setup.objects[0] as { cells: Record<string, unknown> }).cells.position = {
        type: "formula",
        source: "[0, 0]",
      };
    }, /structural/));
  test("the placement expectation asserts numeric coordinates", () =>
    rejects((s) => {
      (s.steps[0] as { expect: unknown[] }).expect.push({
        type: "placement",
        object: "aldric",
        board: "table",
        position: { type: "formula", source: "[0, 0]" },
      });
    }, /./));
});

describe("structural cell visibility", () => {
  test("structural cells may carry their own visibility", () => {
    const s = base();
    s.setup.objects[1] = {
      ...s.setup.objects[1],
      cell_visibility: {
        tag: { type: "viewers", viewers: ["gm"] },
        position: { type: "viewers", viewers: ["gm"] },
        contents: { type: "viewers", viewers: [{ type: "ref", object: "aldric" }] },
      },
    };
    (s.steps[0] as { expect: unknown[] }).expect.push(
      { type: "cell_visible", object: "bag", cell: "contents", viewer: "aldric", visible: true },
      { type: "cell_visible", object: "bag", cell: "tag", viewer: "aldric", visible: false },
    );
    expect(issues(s)).toEqual([]);
  });
});

describe("prototype-named keys", () => {
  const protoNames = ["constructor", "toString", "hasOwnProperty"];

  test("__proto__ as a cell name is rejected rather than silently dropped", () => {
    const parsed = JSON.parse(
      JSON.stringify(base()).replace(
        '"max_hp":',
        '"__proto__":{"type":"number","value":1},"max_hp":',
      ),
    );
    expect(issues(parsed).join("\n")).toMatch(/"__proto__" is not allowed/);
  });

  test("__proto__ as a cell_visibility or owned key is rejected", () => {
    const s = base();
    s.setup.objects[0] = { ...s.setup.objects[0], cell_visibility: {} };
    const text = JSON.stringify(s).replace(
      '"cell_visibility":{}',
      '"cell_visibility":{"__proto__":{"type":"viewers","viewers":["gm"]}}',
    );
    expect(issues(JSON.parse(text)).join("\n")).toMatch(/"__proto__" is not allowed/);
  });

  test.each(protoNames)("cell name %s validates without crashing", (name) => {
    const s = base();
    const parsed = JSON.parse(
      JSON.stringify(s).replace('"max_hp":', `"${name}":{"type":"number","value":1},"max_hp":`),
    );
    expect(() => issues(parsed)).not.toThrow();
    expect(issues(parsed)).toEqual([]);
  });

  test.each(protoNames)("cell_visibility on unknown cell %s is rejected, not crashed", (name) => {
    const s = base();
    const parsed = JSON.parse(
      JSON.stringify({
        ...s,
        setup: {
          ...s.setup,
          objects: [{ ...s.setup.objects[0], cell_visibility: {} }, ...s.setup.objects.slice(1)],
        },
      }).replace(
        '"cell_visibility":{}',
        `"cell_visibility":{"${name}":{"type":"viewers","viewers":["gm"]}}`,
      ),
    );
    expect(issues(parsed).join("\n")).toMatch(/unknown cell/);
  });

  test.each(["constructor", "toString", "hasOwnProperty"])("object id %s", (id) => {
    const s = base();
    s.setup.objects.push({ id, placement: { board: "table", position: [0, 0] } });
    s.steps.push({
      actor: "gm",
      do: { type: "set", object: id, cell: "x", value: { type: "number", value: 1 } },
    });
    expect(issues(s)).toEqual([]);
    s.steps.push({ actor: "gm", do: { type: "invoke", object: id, action: "Fly" } });
    expect(issues(s).join("\n")).toMatch(/no action "Fly"/);
  });

  test("an unbound prototype name is unknown", () =>
    rejects((s) => {
      s.steps.push({ actor: "gm", do: { type: "undo" }, expect: [] });
      s.steps.push({
        actor: "gm",
        do: { type: "invoke", object: "constructor", action: "Use" },
      });
    }, /unknown object or binding "constructor"/));

  test.each(["constructor", "toString", "valueOf"])("binding name %s", (name) => {
    const s = base();
    s.steps.push({
      actor: "gm",
      do: {
        type: "spawn",
        template: "card_t",
        to: { type: "board", board: "table", position: [0, 0] },
        as: name,
        owned: { inner_t: `${name}_inner` },
      },
    });
    s.steps.push({ actor: "gm", do: { type: "invoke", object: name, action: "Use" } });
    s.steps.push({ do: { type: "bind", as: `${name}2`, tag: "x" } });
    expect(issues(s)).toEqual([]);
  });

  test("owned keyed by a prototype name is rejected, not crashed", () => {
    const s = base();
    const step = {
      actor: "gm",
      do: {
        type: "spawn",
        template: "card_t",
        to: { type: "board", board: "table", position: [0, 0] },
        as: "c1",
        owned: {},
      },
    };
    const parsed = JSON.parse(
      JSON.stringify({ ...s, steps: [...s.steps, step] }).replace(
        '"owned":{}',
        '"owned":{"constructor":"c2","toString":"c3"}',
      ),
    );
    expect(issues(parsed).join("\n")).toMatch(/"constructor" is not in the contents/);
  });
});

describe("dice script", () => {
  test("a permutation must be one", () =>
    rejects((s) => {
      s.dice.push({ type: "permutation", order: [0, 0, 2] });
    }, /permutation of 0..n-1/));
  test("bare numbers are not roll results", () =>
    rejects((s) => {
      s.dice.push(14);
    }, /./));
});

describe("steps", () => {
  const step = (s: ReturnType<typeof base>, st: Record<string, unknown>) => {
    s.steps.push(st);
  };

  test("an actor is required", () =>
    rejects((s) => step(s, { do: { type: "undo" } }), /actor is required/));
  test("the actor is the gm or a character", () =>
    rejects((s) => step(s, { actor: "bag", do: { type: "undo" } }), /actor must be "gm"/));
  test("invoking an unknown action", () =>
    rejects(
      (s) => step(s, { actor: "gm", do: { type: "invoke", object: "aldric", action: "Fly" } }),
      /no action "Fly"/,
    ));
  test("a name used before it is bound", () =>
    rejects(
      (s) => step(s, { actor: "gm", do: { type: "invoke", object: "card1", action: "Use" } }),
      /unknown object or binding "card1"/,
    ));
  test("spawning a non-template", () =>
    rejects(
      (s) =>
        step(s, {
          actor: "gm",
          do: {
            type: "spawn",
            template: "aldric",
            to: { type: "board", board: "table", position: [0, 0] },
            as: "a2",
          },
        }),
      /not a template/,
    ));
  test("spawn bindings are usable afterwards; owned ids must be in the template", () => {
    const s = base();
    step(s, {
      actor: "gm",
      do: {
        type: "spawn",
        template: "card_t",
        to: { type: "container", container: "bag", index: 1 },
        as: "card1",
        owned: { inner_t: "inner1" },
      },
      expect: [
        { type: "cell", object: "card1", cell: "inner", value: { type: "ref", object: "inner1" } },
      ],
    });
    step(s, { actor: "gm", do: { type: "invoke", object: "card1", action: "Use" } });
    expect(issues(s)).toEqual([]);
    (s.steps[1] as { do: { owned: Record<string, string> } }).do.owned = { aldric: "x" };
    expect(issues(s).join("\n")).toMatch(/"aldric" is not in the contents of "card_t"/);
  });
  test("a binding may not shadow an id", () =>
    rejects(
      (s) =>
        step(s, {
          actor: "gm",
          do: {
            type: "spawn",
            template: "card_t",
            to: { type: "board", board: "table", position: [0, 0] },
            as: "bag",
          },
        }),
      /already bound/,
    ));
  test("protected cells cannot be set at spawn", () =>
    rejects(
      (s) =>
        step(s, {
          actor: "gm",
          do: {
            type: "spawn",
            template: "card_t",
            to: { type: "board", board: "table", position: [0, 0] },
            cells: { board: { type: "ref", object: "table" } },
            as: "c",
          },
        }),
      /structural/,
    ));
  test("a bind step has no actor", () =>
    rejects(
      (s) => step(s, { actor: "gm", do: { type: "bind", as: "r", tag: "save_row" } }),
      /bind step has no actor/,
    ));
  test("a bind step makes a name for later steps", () => {
    const s = base();
    step(s, {
      do: {
        type: "bind",
        as: "row",
        tag: "save_row",
        where: { cell: "target", value: { type: "ref", object: "aldric" } },
        in: "bag",
      },
    });
    step(s, {
      actor: "gm",
      do: { type: "set", object: "row", cell: "x", value: { type: "empty" } },
    });
    expect(issues(s)).toEqual([]);
  });
  test("move into an unknown container", () =>
    rejects(
      (s) =>
        step(s, {
          actor: "gm",
          do: {
            type: "move",
            object: "aldric",
            to: { type: "container", container: "box", index: 0 },
          },
        }),
      /unknown object or binding "box"/,
    ));
  test("a negative container index", () =>
    rejects(
      (s) =>
        step(s, {
          actor: "gm",
          do: {
            type: "move",
            object: "aldric",
            to: { type: "container", container: "bag", index: -1 },
          },
        }),
      /./,
    ));
  test("an unknown step type", () =>
    rejects((s) => step(s, { actor: "gm", do: { type: "teleport", object: "aldric" } }), /./));
  test("override takes a literal, not a formula", () =>
    rejects(
      (s) =>
        step(s, {
          actor: "gm",
          do: {
            type: "override",
            object: "aldric",
            cell: "hp",
            value: { type: "formula", source: "1" },
          },
        }),
      /./,
    ));
});

describe("expectations", () => {
  const expectAfter = (s: ReturnType<typeof base>, e: unknown) => {
    (s.steps[0] as { expect: unknown[] }).expect.push(e);
  };

  test("rejected cannot be a top-level expectation", () =>
    rejects((s) => {
      s.expect = [{ type: "rejected", reason: { type: "when_false" } }];
    }, /only meaningful in a step/));
  test("log_includes cannot be a top-level expectation", () =>
    rejects((s) => {
      s.expect = [
        {
          type: "log_includes",
          group: 0,
          effect: { type: "write", object: "aldric", cell: "hp", value: { type: "empty" } },
        },
      ];
    }, /needs a step/));
  test("one rejection per step", () =>
    rejects((s) => {
      expectAfter(s, { type: "rejected", reason: { type: "when_false" } });
      expectAfter(s, { type: "rejected", reason: { type: "when_false" } });
    }, /rejected only once/));
  test("unknown error codes", () =>
    rejects(
      (s) => expectAfter(s, { type: "cell_error", object: "aldric", cell: "hp", code: "#OOPS" }),
      /./,
    ));
  test("the viewer is the gm or a character", () =>
    rejects(
      (s) =>
        expectAfter(s, { type: "object_visible", object: "aldric", viewer: "bag", visible: true }),
      /viewer must be "gm"/,
    ));
  test("visibility expectations say viewer, not actor", () =>
    rejects(
      (s) =>
        expectAfter(s, { type: "object_visible", object: "aldric", actor: "gm", visible: true }),
      /./,
    ));
  test("a roll effect carries a roll result", () =>
    rejects(
      (s) =>
        expectAfter(s, {
          type: "log_includes",
          group: -1,
          effect: {
            type: "roll",
            object: "aldric",
            cell: "hp",
            value: { type: "number", value: 3 },
          },
        }),
      /./,
    ));
  test("contents names must resolve", () =>
    rejects(
      (s) => expectAfter(s, { type: "contents", object: "bag", contents: ["card_t", "ghost"] }),
      /unknown object or binding "ghost"/,
    ));
  test("action expectations name a real action", () =>
    rejects(
      (s) => expectAfter(s, { type: "action", object: "aldric", action: "Fly", enabled: false }),
      /no action "Fly"/,
    ));
  test("every expectation may carry a note quoting the prose", () => {
    const s = base();
    (s.steps[0] as { expect: Record<string, unknown>[] }).expect[0] = {
      ...(s.steps[0] as { expect: Record<string, unknown>[] }).expect[0],
      note: "hp = max_hp - damage_taken",
    };
    expect(issues(s)).toEqual([]);
  });
  test("an unknown expectation type", () =>
    rejects((s) => expectAfter(s, { type: "vibes", object: "aldric" }), /./));
});
