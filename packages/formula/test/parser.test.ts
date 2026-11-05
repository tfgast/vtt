import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Expr,
  MAX_AST_DEPTH,
  MAX_AST_NODES,
  parse,
  parseExpressionPrefix,
  printAst,
} from "@vtt/formula";
import { describe, expect, test } from "vitest";

function ast(source: string): Expr {
  const result = parse(source);
  if (!result.ok) throw new Error(`${source}: ${result.message} at ${result.offset}`);
  return result.ast;
}

function tree(source: string): string {
  return printAst(ast(source));
}

function failure(source: string): { message: string; offset: number } {
  const result = parse(source);
  if (result.ok) throw new Error(`expected ${source} to fail, got ${printAst(result.ast)}`);
  expect(Object.keys(result).sort()).toEqual(["message", "offset", "ok"]);
  return result;
}

describe("FORMULAS.md §10 formulas", () => {
  // Every formula, `when`, and expression-shaped step in §10, with its tree.
  // Calls print as (call f args...), methods as (.where target arg) and
  // (.sort target arg [desc]), dot-access as (. target name).
  test.each([
    ["max_hp - damage_taken", "(- max_hp damage_taken)"],
    ["value + modifier", "(+ value modifier)"],
    ["roll(1d20)", "(call roll (dice 1d20))"],
    ["owner.attack_bonus", "(. owner attack_bonus)"],
    [
      'any(on(this).where(tag has "d20").total >= ac)',
      '(call any (>= (. (.where (call on this) (has tag "d20")) total) ac))',
    ],
    [
      'sum(contents(this).where(tag has "die").value)',
      '(call sum (. (.where (call contents this) (has tag "die")) value))',
    ],
    [
      'sum(contents.where(tag has "die").value)',
      '(call sum (. (.where contents (has tag "die")) value))',
    ],
    [
      'base_speed / if(len(zones_containing(this).where(tag has "difficult")) > 0, 2, 1)',
      '(/ base_speed (call if (> (call len (.where (call zones_containing this) (has tag "difficult"))) 0) 2 1))',
    ],
    ["attacker.attack_bonus", "(. attacker attack_bonus)"],
    ["roll + bonus", "(+ roll bonus)"],
    ["roll != empty and total >= target.ac", "(and (!= roll empty) (>= total (. target ac)))"],
    ["target != empty and roll = empty", "(and (!= target empty) (= roll empty))"],
    ["hit and dmg = empty", "(and hit (= dmg empty))"],
    ["roll(attacker.damage_dice)", "(call roll (. attacker damage_dice))"],
    ["hit and dmg != empty and not applied", "(and (and hit (!= dmg empty)) (not applied))"],
    ["add(target.damage_taken, dmg)", "(call add (. target damage_taken) dmg)"],
    ["set(applied, true)", "(call set applied true)"],
    ["caster.spell_dc", "(. caster spell_dc)"],
    [
      'contents(zone).where(tag has "creature")',
      '(.where (call contents zone) (has tag "creature"))',
    ],
    ['contents.where(tag has "save_row")', '(.where contents (has tag "save_row"))'],
    ["not locked", "(not locked)"],
    [
      "each(targets, spawn(save_row, this, {target: it, owner: it.owner}))",
      "(call each targets (call spawn save_row this (record (target it) (owner (. it owner)))))",
    ],
    ["set(locked, true)", "(call set locked true)"],
    ["locked and damage = empty", "(and locked (= damage empty))"],
    ["roll(8d6)", "(call roll (dice 8d6))"],
    [
      "locked and damage != empty and all(rows.save_roll != empty) and not applied",
      "(and (and (and locked (!= damage empty)) (call all (!= (. rows save_roll) empty))) (not applied))",
    ],
    [
      "each(rows, add(it.target.damage_taken, it.damage_dealt))",
      "(call each rows (call add (. (. it target) damage_taken) (. it damage_dealt)))",
    ],
    ["remove(zone)", "(call remove zone)"],
    ["remove(this)", "(call remove this)"],
    ["container", "container"],
    ["target.dex_save", "(. target dex_save)"],
    ["save_roll + save_bonus >= card.dc", "(>= (+ save_roll save_bonus) (. card dc))"],
    [
      "if(passed, floor(card.damage / 2), card.damage)",
      "(call if passed (call floor (/ (. card damage) 2)) (. card damage))",
    ],
    ["save_roll = empty", "(= save_roll empty)"],
    ["set(dc, caster.spell_dc)", "(call set dc (. caster spell_dc))"],
    ["set(save_bonus, target.dex_save)", "(call set save_bonus (. target dex_save))"],
    ["len(deck.contents) > 0", "(> (call len (. deck contents)) 0)"],
    [
      "move(first(deck.contents), owner.hand)",
      "(call move (call first (. deck contents)) (. owner hand))",
    ],
    ["shuffle(this)", "(call shuffle this)"],
    [
      'if(len(contents(this).where(tag has "pc")) > 0, all, gm)',
      '(call if (> (call len (.where (call contents this) (has tag "pc"))) 0) all gm)',
    ],
  ])("%s", (source, expected) => {
    expect(tree(source)).toBe(expected);
  });

  test("an action step parses its expression prefix and stops at ->", () => {
    const source = "roll(1d20) -> value";
    const result = parseExpressionPrefix(source, 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(printAst(result.ast)).toBe("(call roll (dice 1d20))");
    expect(result.end).toBe(10);
    expect(source.slice(result.end).trimStart().startsWith("->")).toBe(true);
  });

  test("-> is rejected by the whole-input parser", () => {
    expect(failure("roll(1d20) -> value").offset).toBe(11);
  });
});

describe("other doc examples", () => {
  test.each([
    ["nickname or name", "(or nickname name)"],
    ["if(bonus = empty, 0, bonus)", "(call if (= bonus empty) 0 bonus)"],
    ["weapon.dice + 1d6 + 2", "(+ (+ (. weapon dice) (dice 1d6)) 2)"],
    ["on(this).total >= ac", "(>= (. (call on this) total) ac)"],
    ['"3" + 1', '(+ "3" 1)'],
    ["[1, 2, 3]", "(list 1 2 3)"],
    ['["die", "d6"]', '(list "die" "d6")'],
    ["[]", "(list)"],
    ["{}", "(record)"],
    ["`Max HP` - 1", "(- `Max HP` 1)"],
    ['obj("Aldric")', '(call obj "Aldric")'],
    ["round(x, 2) + 3.5", "(+ (call round x 2) 3.5)"],
    ["f()", "(call f)"],
    ["all", "all"],
    ["gm", "gm"],
    ["all(xs)", "(call all xs)"],
    ["all (xs)", "(call all xs)"],
    ["len (xs)", "(call len xs)"],
    ["true or false", "(or true false)"],
    ["this.it_cell", "(. this it_cell)"],
    ["x.`Max HP`", "(. x `Max HP`)"],
    ["a.where", "(. a where)"],
    ['"a \\"b\\" \\\\"', '"a \\"b\\" \\\\"'],
  ])("%s", (source, expected) => {
    expect(tree(source)).toBe(expected);
  });
});

describe("precedence and associativity", () => {
  test.each([
    ["not a = b", "(= (not a) b)"],
    ["-x.y", "(neg (. x y))"],
    ["a & b has c", "(has (& a b) c)"],
    ["1 + 2 * 3", "(+ 1 (* 2 3))"],
    ["a or b and c", "(or a (and b c))"],
    ["a and b or c", "(or (and a b) c)"],
    ["(1 + 2) * 3", "(* (+ 1 2) 3)"],
    ["1 - 2 - 3", "(- (- 1 2) 3)"],
    ["8 / 4 / 2", "(/ (/ 8 4) 2)"],
    ["a % b * c", "(* (% a b) c)"],
    ["a & b & c", "(& (& a b) c)"],
    ["a + b & c", "(& (+ a b) c)"],
    ["xs has a = b", "(= (has xs a) b)"],
    ["a = b and c", "(and (= a b) c)"],
    ["- -x", "(neg (neg x))"],
    ["not not a", "(not (not a))"],
    ["-2 * 3", "(* (neg 2) 3)"],
    ["a = not b", "(= a (not b))"],
    ["2d6+3", "(+ (dice 2d6) 3)"],
    ["f(x).y.where(z).sort(w)", "(.sort (.where (. (call f x) y) z) w)"],
  ])("%s is %s", (source, expected) => {
    expect(tree(source)).toBe(expected);
  });

  test.each(["=", "!=", "<", "<=", ">", ">="])("comparisons do not chain (%s)", (op) => {
    const node = ast(`a < b ${op} c`);
    expect(node).toMatchObject({ kind: "Binary", op, chained: true });
    expect(node.kind === "Binary" && node.left).toMatchObject({ kind: "Binary", op: "<" });
    expect(node.kind === "Binary" && "chained" in node.left).toBe(false);
  });

  test("a < b < c parses with chained: true", () => {
    expect(ast("a < b < c")).toMatchObject({
      kind: "Binary",
      op: "<",
      chained: true,
      left: { kind: "Binary", op: "<" },
      right: { kind: "Name", name: "c" },
    });
    expect(tree("a < b < c")).toBe("(< (< a b) c :chained)");
  });

  test("a parenthesized comparison is not chained", () => {
    expect(ast("(a = b) = c")).not.toHaveProperty("chained");
    expect(ast("a = (b = c)")).not.toHaveProperty("chained");
    expect(ast("a = b")).not.toHaveProperty("chained");
  });
});

describe("AST shape", () => {
  test("node kinds and offsets", () => {
    expect(ast("12")).toEqual({ kind: "Number", value: 12, start: 0, end: 2 });
    expect(ast('"hi"')).toEqual({ kind: "Text", value: "hi", start: 0, end: 4 });
    expect(ast("true")).toEqual({ kind: "Boolean", value: true, start: 0, end: 4 });
    expect(ast("empty")).toEqual({ kind: "Empty", start: 0, end: 5 });
    expect(ast("1d20kh1")).toEqual({ kind: "Dice", raw: "1d20kh1", start: 0, end: 7 });
    expect(ast("gm")).toEqual({ kind: "Viewer", which: "gm", start: 0, end: 2 });
    expect(ast("all")).toEqual({ kind: "Viewer", which: "all", start: 0, end: 3 });
    expect(ast("this")).toEqual({ kind: "This", start: 0, end: 4 });
    expect(ast("it")).toEqual({ kind: "It", start: 0, end: 2 });
    expect(ast("`d6`")).toEqual({ kind: "Name", name: "d6", start: 0, end: 4 });
    expect(ast("owner")).toEqual({ kind: "Name", name: "owner", start: 0, end: 5 });
    expect(ast("-x")).toEqual({
      kind: "Unary",
      op: "-",
      operand: { kind: "Name", name: "x", start: 1, end: 2 },
      start: 0,
      end: 2,
    });
    expect(ast("a.b")).toEqual({
      kind: "Dot",
      target: { kind: "Name", name: "a", start: 0, end: 1 },
      name: "b",
      start: 0,
      end: 3,
    });
    expect(ast("f(1)")).toEqual({
      kind: "Call",
      name: "f",
      args: [{ kind: "Number", value: 1, start: 2, end: 3 }],
      start: 0,
      end: 4,
    });
    expect(ast("[1]")).toEqual({
      kind: "List",
      items: [{ kind: "Number", value: 1, start: 1, end: 2 }],
      start: 0,
      end: 3,
    });
  });

  test("record {target: it, owner: it.owner}", () => {
    expect(ast("{target: it, owner: it.owner}")).toEqual({
      kind: "Record",
      fields: [
        ["target", { kind: "It", start: 9, end: 11 }],
        [
          "owner",
          {
            kind: "Dot",
            target: { kind: "It", start: 20, end: 22 },
            name: "owner",
            start: 20,
            end: 28,
          },
        ],
      ],
      start: 0,
      end: 29,
    });
  });

  test("a parenthesized expression's span covers its parentheses", () => {
    expect(ast("( a + b ) * c")).toMatchObject({
      start: 0,
      end: 13,
      left: { kind: "Binary", start: 0, end: 9 },
    });
  });

  test("x.sort(y, desc) sets desc; a cell named desc is a name elsewhere", () => {
    expect(ast("x.sort(y, desc)")).toMatchObject({
      kind: "Method",
      name: "sort",
      args: [{ kind: "Name", name: "y" }],
      desc: true,
    });
    expect(ast("x.sort(desc)")).toMatchObject({
      kind: "Method",
      name: "sort",
      args: [{ kind: "Name", name: "desc" }],
      desc: false,
    });
    expect(ast("x.where(desc > 1)")).toMatchObject({ kind: "Method", name: "where", desc: false });
    expect(tree("x.sort(y, desc)")).toBe("(.sort x y desc)");
    expect(tree("desc + 1")).toBe("(+ desc 1)");
    expect(tree("x.desc")).toBe("(. x desc)");
    expect(tree("f(y, desc)")).toBe("(call f y desc)");
  });

  test("a backtick name is never a call", () => {
    expect(failure("`f`(1)").offset).toBe(3);
  });
});

describe("syntax errors", () => {
  test.each([
    ["2x", 1],
    ['"a\\q"', 2],
    ['"abc', 0],
    ["(1,", 2],
    ["a.b(1)", 2],
    ["[1,]", 3],
    ["x.sort(y, up)", 10],
    ["{a: 1, a: 2}", 7],
    ["", 0],
    ["1 +", 3],
    [")", 0],
    ["a b", 2],
    ["x.where()", 8],
    ["x.where(a, b)", 9],
    ["x.sort()", 7],
    ["x.sort(a, desc, b)", 14],
    ["x.sort(a, `desc`)", 10],
    ["x.sort(a, desc + 1)", 15],
    ["a.1", 2],
    ["a.not", 2],
    ["gm(1)", 2],
    ["this(1)", 4],
    ["f(1)(2)", 4],
    ["{a 1}", 3],
    ["a and", 5],
    ["has", 0],
    ["1d6 ! 3", 4],
    [`[1, ${"9".repeat(400)}]`, 4],
    [`1.${"5".repeat(400)} + ${"7".repeat(400)}`, 405],
  ])("%s fails at offset %i", (source, offset) => {
    const result = failure(source);
    expect(result.offset).toBe(offset);
    expect(result.message).toBeTypeOf("string");
    expect(result.message.length).toBeGreaterThan(0);
  });
});

test("a non-finite numeric literal inside a list fails with a message naming it", () => {
  const big = "1".repeat(400);
  const result = failure(`[1, [2, ${big}]]`);
  expect(result.offset).toBe(8);
  expect(result.message).toContain(big);
});

describe("limits", () => {
  const nestedParens = (n: number) => `${"(".repeat(n)}1${")".repeat(n)}`;
  const plusChain = (levels: number) =>
    Array(levels + 1)
      .fill("1")
      .join("+");

  test("the limits are 256 levels and 10,000 nodes", () => {
    expect(MAX_AST_DEPTH).toBe(256);
    expect(MAX_AST_NODES).toBe(10_000);
  });

  test("256 nested parentheses parse and 257 fail", () => {
    expect(parse(nestedParens(256)).ok).toBe(true);
    expect(failure(nestedParens(257)).message).toMatch(/depth.*256/);
  });

  test("a 1+1+… chain 256 levels deep parses; 257 levels fails with the depth message", () => {
    expect(parse(plusChain(256)).ok).toBe(true);
    expect(failure(plusChain(257)).message).toMatch(/depth.*256/);
  });

  test("a 300-level a.b.c… chain fails", () => {
    const source = ["a", ...Array(300).fill("b")].join(".");
    expect(failure(source).message).toMatch(/depth.*256/);
  });

  test("other nesting counts toward depth", () => {
    expect(parse(`${"-".repeat(256)}x`).ok).toBe(true);
    expect(failure(`${"-".repeat(257)}x`).message).toMatch(/depth/);
    expect(parse(`${"[".repeat(256)}${"]".repeat(256)}`).ok).toBe(true);
    expect(failure(`${"[".repeat(257)}1${"]".repeat(257)}`).message).toMatch(/depth/);
    expect(failure(`${"f(".repeat(257)}1${")".repeat(257)}`).message).toMatch(/depth/);
    expect(failure(`${"{a: ".repeat(257)}1${"}".repeat(257)}`).message).toMatch(/depth/);
    // Right-nested chains recurse; they fail without overflowing the stack.
    expect(failure(`${"1+(".repeat(5000)}1${")".repeat(5000)}`).message).toMatch(/depth/);
  });

  test("a flat list literal with more than 10,000 nodes fails with the node-count message", () => {
    // [1, …] with 9,999 items is 10,000 nodes; one more item exceeds the limit.
    expect(parse(`[${Array(9_999).fill("1").join(",")}]`).ok).toBe(true);
    expect(failure(`[${Array(10_000).fill("1").join(",")}]`).message).toMatch(/nodes.*10000/);
  });

  test("a 100,000-term 1+1+… source returns a failure, never a stack exception", () => {
    const source = Array(100_000).fill("1").join("+");
    expect(() => parse(source)).not.toThrow();
    expect(parse(source).ok).toBe(false);
  });

  test("the limits apply to parseExpressionPrefix too", () => {
    const deep = parseExpressionPrefix(`${plusChain(257)} -> x`, 0);
    expect(deep.ok).toBe(false);
    if (!deep.ok) expect(deep.message).toMatch(/depth/);
    const wide = parseExpressionPrefix(`[${Array(10_000).fill("1").join(",")}] -> x`, 0);
    expect(wide.ok).toBe(false);
    if (!wide.ok) expect(wide.message).toMatch(/nodes/);
  });
});

describe("parseExpressionPrefix", () => {
  test("starts at an offset and stops at the first token that cannot continue", () => {
    const source = "xx a + b c";
    const result = parseExpressionPrefix(source, 3);
    expect(result).toMatchObject({ ok: true, end: 8 });
    if (result.ok) expect(printAst(result.ast)).toBe("(+ a b)");
  });

  test("offsets are absolute in the source", () => {
    const result = parseExpressionPrefix("set(a, 1) -> b", 0);
    expect(result).toMatchObject({ ok: true, end: 9, ast: { start: 0, end: 9 } });
    const inner = parseExpressionPrefix("ab  cd.ef", 4);
    expect(inner).toMatchObject({ ok: true, end: 9, ast: { kind: "Dot", start: 4, end: 9 } });
  });

  test("stops before a token the lexer cannot read", () => {
    expect(parseExpressionPrefix("a + b !", 0)).toMatchObject({ ok: true, end: 5 });
  });

  test("an expression that cannot start, or is cut short, is a failure", () => {
    expect(parseExpressionPrefix("-> x", 0)).toMatchObject({ ok: false, offset: 0 });
    expect(parseExpressionPrefix("a + -> x", 0)).toMatchObject({ ok: false, offset: 4 });
    expect(parseExpressionPrefix("f(a -> x", 0)).toMatchObject({ ok: false, offset: 4 });
  });
});

const scenarioRoot = join(import.meta.dirname, "..", "..", "fixtures", "scenarios");
const scenarioFiles = (await readdir(scenarioRoot)).filter((f) => f.endsWith(".json")).sort();

describe("fixture scenarios", () => {
  const root = scenarioRoot;
  const files = scenarioFiles;

  /** Every formula cell source and every action `when` in a scenario. */
  function sources(node: unknown, inActions = false, out: string[] = []): string[] {
    if (Array.isArray(node)) {
      for (const item of node) sources(item, inActions, out);
    } else if (node !== null && typeof node === "object") {
      const record = node as Record<string, unknown>;
      if (record.type === "formula" && typeof record.source === "string") out.push(record.source);
      if (inActions && typeof record.when === "string") out.push(record.when);
      for (const [key, value] of Object.entries(record)) sources(value, key === "actions", out);
    }
    return out;
  }

  test("there are scenarios with formulas and whens to parse", async () => {
    expect(files.length).toBeGreaterThan(0);
    const all = await Promise.all(
      files.map(async (f) => sources(JSON.parse(await readFile(join(root, f), "utf8")))),
    );
    const flat = all.flat();
    expect(flat).toContain("roll != empty and total >= target.ac");
    expect(flat).toContain("target != empty and roll = empty");
  });

  test.each(files)("%s: every formula and when parses", async (file) => {
    const scenario: unknown = JSON.parse(await readFile(join(root, file), "utf8"));
    for (const source of sources(scenario)) {
      const result = parse(source);
      expect(result.ok ? "ok" : `${result.message} at ${result.offset}`, source).toBe("ok");
    }
  });
});
