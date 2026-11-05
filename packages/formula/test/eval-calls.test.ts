import {
  type CallContext,
  CORE_FUNCTIONS,
  coreRegistry,
  createRegistry,
  defaultRegistry,
  type EagerFunctionDef,
  type Expr,
  type FunctionDef,
  type LazyContext,
} from "@vtt/formula";
import { bool, EMPTY, err, list, num, type Result, ref, text } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { run } from "./support/eval";

/** An eager scalar function that doubles a number. */
const twice: FunctionDef = {
  name: "twice",
  minArgs: 1,
  maxArgs: 1,
  kind: "eager",
  broadcast: "scalar",
  impl: ([x]) => (x?.type === "number" ? num(x.value * 2) : err("#TYPE", "twice")),
};

/** An eager scalar function of two arguments, the second optional. */
const sub: FunctionDef = {
  name: "sub",
  minArgs: 1,
  maxArgs: 2,
  kind: "eager",
  broadcast: "scalar",
  impl: ([a, b]) => {
    const x = a?.type === "number" ? a.value : Number.NaN;
    const y = b === undefined ? 0 : b.type === "number" ? b.value : Number.NaN;
    return Number.isNaN(x - y) ? err("#TYPE", "sub") : num(x - y);
  },
};

/** An eager non-broadcasting function that records the arguments it saw. */
function recorder(seen: Result[][]): EagerFunctionDef {
  return {
    name: "seen",
    minArgs: 0,
    maxArgs: 3,
    kind: "eager",
    broadcast: "none",
    impl: (args) => {
      seen.push([...args]);
      return num(args.length);
    },
  };
}

const registry = createRegistry([...CORE_FUNCTIONS, twice, sub]);

describe("function calls", () => {
  test("an unknown function is #NAME", () => {
    expect(run("no_such_function_zz(1)")).toMatchObject({ code: "#NAME" });
    expect(run("no_such_function_zz()")).toMatchObject({ code: "#NAME" });
  });

  test("an unknown function does not evaluate its arguments", () => {
    expect(run("no_such_function_zz(1 / 0)")).toMatchObject({ code: "#NAME" });
  });

  test("an arity mismatch is #TYPE, before arguments are evaluated", () => {
    expect(run("twice(1, 2)", {}, { registry })).toMatchObject({ code: "#TYPE" });
    expect(run("twice()", {}, { registry })).toMatchObject({ code: "#TYPE" });
    expect(run("twice(1 / 0, 2)", {}, { registry })).toMatchObject({ code: "#TYPE" });
    expect(run("sub(5)", {}, { registry })).toEqual(num(5));
    expect(run("sub(5, 2)", {}, { registry })).toEqual(num(3));
  });

  test("eager arguments are evaluated left to right and error-checked before impl", () => {
    const seen: Result[][] = [];
    const reg = createRegistry([recorder(seen)]);
    expect(run("seen(missing, 1 / 0)", {}, { registry: reg })).toMatchObject({ code: "#NAME" });
    expect(run("seen(1, 1 / 0, missing)", {}, { registry: reg })).toMatchObject({
      code: "#DIV0",
    });
    expect(seen).toEqual([]);
    expect(run('seen(1, "a", [2])', {}, { registry: reg })).toEqual(num(3));
    expect(seen).toEqual([[num(1), text("a"), list([num(2)])]]);
  });

  test("a non-broadcasting function receives lists whole", () => {
    const seen: Result[][] = [];
    const reg = createRegistry([recorder(seen)]);
    run("seen([1, 2], 3)", {}, { registry: reg });
    expect(seen).toEqual([[list([num(1), num(2)]), num(3)]]);
  });

  test("acceptsErrors passes errors to impl", () => {
    const seen: Result[][] = [];
    const reg = createRegistry([{ ...recorder(seen), acceptsErrors: true }]);
    expect(run("seen(missing, 1)", {}, { registry: reg })).toEqual(num(2));
    expect(seen[0]?.[0]).toMatchObject({ type: "error", code: "#NAME" });
  });

  describe("broadcast: scalar", () => {
    test("maps over a list argument", () => {
      expect(run("twice([1, 2, 3])", {}, { registry })).toEqual(list([num(2), num(4), num(6)]));
    });

    test("a scalar argument repeats against a list", () => {
      expect(run("sub([5, 6], 1)", {}, { registry })).toEqual(list([num(4), num(5)]));
      expect(run("sub(10, [1, 2])", {}, { registry })).toEqual(list([num(9), num(8)]));
    });

    test("several list arguments pair up by index", () => {
      expect(run("sub([5, 6], [1, 2])", {}, { registry })).toEqual(list([num(4), num(4)]));
    });

    test("list arguments of different lengths are #TYPE", () => {
      expect(run("sub([5, 6], [1])", {}, { registry })).toMatchObject({ code: "#TYPE" });
    });

    test("an empty list maps to an empty list", () => {
      expect(run("twice([])", {}, { registry })).toEqual(list([]));
    });

    test("nested lists broadcast recursively", () => {
      expect(run("twice([1, [2]])", {}, { registry })).toEqual(list([num(2), list([num(4)])]));
    });

    test("the first item error wins", () => {
      expect(run('twice([1, "a", true])', {}, { registry })).toMatchObject({ code: "#TYPE" });
    });

    test("empty is a scalar, not a list", () => {
      expect(run("sub(empty)", {}, { registry })).toMatchObject({ code: "#TYPE" });
    });
  });

  test("impl receives the call's scope and env", () => {
    let ctx: CallContext | undefined;
    const probe: FunctionDef = {
      name: "probe",
      minArgs: 0,
      maxArgs: 0,
      kind: "eager",
      broadcast: "none",
      impl: (_args, c) => {
        ctx = c;
        return EMPTY;
      },
    };
    const scope = { thisId: "self", cell: "hp" };
    run("probe()", { self: { hp: num(1) } }, { scope, registry: createRegistry([probe]) });
    expect(ctx?.scope).toEqual(scope);
    expect(ctx?.env.read("self", "hp")).toEqual(num(1));
  });

  describe("lazy functions", () => {
    test("receive ASTs and an evaluation callback", () => {
      let received: readonly Expr[] = [];
      const second: FunctionDef = {
        name: "second",
        minArgs: 2,
        maxArgs: 2,
        kind: "lazy",
        broadcast: "none",
        impl: (args, ctx) => {
          received = args;
          return ctx.evaluate(args[1] as Expr);
        },
      };
      const reg = createRegistry([second]);
      expect(run("second(1 / 0, 2 + 3)", {}, { registry: reg })).toEqual(num(5));
      expect(received.map((a) => a.kind)).toEqual(["Binary", "Binary"]);
    });

    test("can evaluate in a new scope with it bound", () => {
      const withIt: FunctionDef = {
        name: "with_it",
        minArgs: 2,
        maxArgs: 2,
        kind: "lazy",
        broadcast: "none",
        impl: ([item, body], ctx) => {
          const it = ctx.evaluate(item as Expr);
          if (it.type === "error") return it;
          return ctx.evaluate(body as Expr, { ...ctx.scope, it, itBindsNames: true });
        },
      };
      const reg = createRegistry([withIt]);
      const cells = { self: { x: num(1), g: ref("goblin") }, goblin: { x: num(2) } };
      expect(run("with_it(g, x + this.x)", cells, { registry: reg })).toEqual(num(3));
      expect(run("with_it(5, it * 2)", cells, { registry: reg })).toEqual(num(10));
    });

    test("an arity mismatch is #TYPE", () => {
      const lazy: FunctionDef = {
        name: "lazy",
        minArgs: 1,
        maxArgs: 1,
        kind: "lazy",
        broadcast: "none",
        impl: () => EMPTY,
      };
      expect(run("lazy()", {}, { registry: createRegistry([lazy]) })).toMatchObject({
        code: "#TYPE",
      });
    });
  });
});

describe("methods", () => {
  test("x.where(...) is #NAME with the core-only registry", () => {
    const cells = { self: { xs: list([num(1), num(2)]) } };
    expect(run("xs.where(it > 1)", cells, { registry: coreRegistry() })).toMatchObject({
      code: "#NAME",
    });
    expect(run("xs.sort(it)", cells, { registry: coreRegistry() })).toMatchObject({
      code: "#NAME",
    });
    expect(run("xs.sort(it, desc)", cells, { registry: coreRegistry() })).toMatchObject({
      code: "#NAME",
    });
  });

  test("dispatch to the registry entry with the target, args, and desc", () => {
    const calls: { args: readonly Expr[]; target?: Expr; desc: boolean }[] = [];
    const record = (name: "where" | "sort"): FunctionDef => ({
      name,
      minArgs: 1,
      maxArgs: 1,
      kind: "lazy",
      broadcast: "none",
      impl: (args, ctx: LazyContext) => {
        calls.push({ args, target: ctx.target, desc: ctx.desc });
        return ctx.target === undefined ? EMPTY : ctx.evaluate(ctx.target);
      },
    });
    const reg = createRegistry([record("where"), record("sort")]);
    const cells = { self: { xs: list([num(1)]) } };
    expect(run("xs.where(it > 1)", cells, { registry: reg })).toEqual(list([num(1)]));
    expect(run("xs.sort(it, desc)", cells, { registry: reg })).toEqual(list([num(1)]));
    expect(run("xs.sort(it)", cells, { registry: reg })).toEqual(list([num(1)]));
    expect(calls.map((c) => [c.args.length, c.target?.kind, c.desc])).toEqual([
      [1, "Name", false],
      [1, "Name", true],
      [1, "Name", false],
    ]);
  });

  test("where and sort are not callable as functions", () => {
    const where: FunctionDef = {
      name: "where",
      minArgs: 1,
      maxArgs: 1,
      kind: "lazy",
      broadcast: "none",
      impl: () => bool(true),
    };
    const reg = createRegistry([where]);
    expect(run("where(1)", {}, { registry: reg })).toMatchObject({ code: "#NAME" });
  });
});

describe("registries", () => {
  test("coreRegistry holds exactly if and iserror", () => {
    expect(CORE_FUNCTIONS.map((d) => d.name).sort()).toEqual(["if", "iserror"]);
    const core = coreRegistry();
    expect(core.get("if")?.kind).toBe("lazy");
    expect(core.get("iserror")).toMatchObject({ kind: "eager", acceptsErrors: true });
    expect(core.get("sum")).toBeUndefined();
  });

  test("the default registry includes the core functions", () => {
    expect(defaultRegistry.get("if")).toBe(coreRegistry().get("if"));
    expect(defaultRegistry.get("iserror")).toBeDefined();
    expect(defaultRegistry.get("no_such_function_zz")).toBeUndefined();
  });

  test("a duplicate name is rejected", () => {
    expect(() => createRegistry([twice, twice])).toThrow(/twice/);
  });

  test("a method entry must be lazy", () => {
    expect(() => createRegistry([{ ...twice, name: "where" }])).toThrow(/where/);
  });

  test("an inconsistent arity is rejected", () => {
    expect(() => createRegistry([{ ...twice, minArgs: 2, maxArgs: 1 }])).toThrow(/twice/);
  });
});
