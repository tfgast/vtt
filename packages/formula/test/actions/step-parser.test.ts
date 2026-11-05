import {
  type DestinationNode,
  MAX_AST_DEPTH,
  MAX_AST_NODES,
  type PathNode,
  parseAction,
  parseStep,
  printAst,
  type Step,
} from "@vtt/formula";
import { describe, expect, test } from "vitest";
import { loadScenarios } from "../support/scenarios";

// Steps print as s-expressions over printAst: a path is (path cell) for a
// cell of `this` or (path <object> cell); destinations are table,
// (board b p), (beside r) and (container c); spawn's record is
// (cells (name value)...); roll prints its path after "->".

/** A cell name as printAst prints a name: backticked unless a plain identifier. */
function printName(name: string): string {
  return printAst({ kind: "Name", name, start: 0, end: 0 });
}

function printPath(path: PathNode): string {
  const cell = printName(path.cell);
  return path.object === null ? `(path ${cell})` : `(path ${printAst(path.object)} ${cell})`;
}

function printDestination(to: DestinationNode): string {
  switch (to.type) {
    case "table":
      return "table";
    case "board":
      return `(board ${printAst(to.board)} ${printAst(to.position)})`;
    case "beside":
      return `(beside ${printAst(to.object)})`;
    case "container":
      return `(container ${printAst(to.container)})`;
  }
}

function printStep(step: Step): string {
  switch (step.kind) {
    case "set":
    case "add":
    case "append":
      return `(${step.kind} ${printPath(step.path)} ${printAst(step.value)})`;
    case "roll":
      return `(roll ${printAst(step.dice)} -> ${printPath(step.path)})`;
    case "move":
      return `(move ${printAst(step.object)} ${printDestination(step.to)})`;
    case "spawn": {
      const cells = step.cells.map((c) => ` (${printName(c.name)} ${printAst(c.value)})`).join("");
      return `(spawn ${printAst(step.template)} ${printDestination(step.to)} (cells${cells}))`;
    }
    case "remove":
    case "shuffle":
      return `(${step.kind} ${printAst(step.object)})`;
    case "each":
      return `(each ${printAst(step.list)} ${printStep(step.step)})`;
  }
}

function step(source: string): Step {
  const result = parseStep(source);
  if (!result.ok) throw new Error(`${source}: ${result.message} at ${result.offset}`);
  expect(Object.keys(result).sort()).toEqual(["ok", "step"]);
  return result.step;
}

function failure(source: string): { message: string; offset: number } {
  const result = parseStep(source);
  if (result.ok) throw new Error(`expected ${source} to fail, got ${printStep(result.step)}`);
  expect(Object.keys(result).sort()).toEqual(["message", "offset", "ok"]);
  return result;
}

/** A list literal of `items` ones: `items + 1` AST nodes. */
function list(items: number): string {
  return `[${Array.from({ length: items }, () => "1").join(", ")}]`;
}

describe("FORMULAS.md §10 action steps", () => {
  test.each([
    // A die with a modifier: Roll
    ["roll(1d20) -> value", "(roll (dice 1d20) -> (path value))"],
    // An Attack card
    ["roll(1d20) -> roll", "(roll (dice 1d20) -> (path roll))"],
    ["roll(attacker.damage_dice) -> dmg", "(roll (. attacker damage_dice) -> (path dmg))"],
    ["add(target.damage_taken, dmg)", "(add (path target damage_taken) dmg)"],
    ["set(applied, true)", "(set (path applied) true)"],
    // A Fireball card with a circle zone
    [
      "each(targets, spawn(save_row, this, {target: it, owner: it.owner}))",
      "(each targets (spawn save_row (container this) (cells (target it) (owner (. it owner)))))",
    ],
    ["set(locked, true)", "(set (path locked) true)"],
    ["roll(8d6) -> damage", "(roll (dice 8d6) -> (path damage))"],
    [
      "each(rows, add(it.target.damage_taken, it.damage_dealt))",
      "(each rows (add (path (. it target) damage_taken) (. it damage_dealt)))",
    ],
    ["remove(zone)", "(remove zone)"],
    ["remove(this)", "(remove this)"],
    ["roll(1d20) -> save_roll", "(roll (dice 1d20) -> (path save_roll))"],
    // The frozen variant
    ["set(dc, caster.spell_dc)", "(set (path dc) (. caster spell_dc))"],
    ["set(save_bonus, target.dex_save)", "(set (path save_bonus) (. target dex_save))"],
    // Drawing a card
    [
      "move(first(deck.contents), owner.hand)",
      "(move (call first (. deck contents)) (container (. owner hand)))",
    ],
    // Shuffling
    ["shuffle(this)", "(shuffle this)"],
  ])("%s", (source, expected) => {
    expect(printStep(step(source))).toBe(expected);
  });

  test("every action step and when in the fixture scenarios parses", async () => {
    let steps = 0;
    for (const scenario of await loadScenarios()) {
      for (const object of scenario.setup.objects) {
        for (const action of object.actions ?? []) {
          const parsed = parseAction(action);
          if (action.when !== undefined) expect(parsed.when?.ok, action.when).toBe(true);
          else expect("when" in parsed).toBe(false);
          parsed.steps.forEach((result, i) => {
            expect(result.ok, action.steps[i]).toBe(true);
          });
          steps += parsed.steps.length;
        }
      }
    }
    expect(steps).toBeGreaterThanOrEqual(15);
  });
});

describe("step kinds and arguments", () => {
  test.each([
    ["append(log, 3)", "(append (path log) 3)"],
    ["set(`Max HP`, 3)", "(set (path `Max HP`) 3)"],
    ["set(this.hp, hp - 1)", "(set (path this hp) (- hp 1))"],
    ['set(obj("g").`Max HP`, 1)', '(set (path (call obj "g") `Max HP`) 1)'],
    ["set((a).b, 1)", "(set (path a b) 1)"],
    ["set(a, if(b, 1, 2))", "(set (path a) (call if b 1 2))"],
    ["set(a, {x: 1})", "(set (path a) (record (x 1)))"],
    ["  set ( a ,\n 1 )  ", "(set (path a) 1)"],
    ["roll(1d20) -> it.save_roll", "(roll (dice 1d20) -> (path it save_roll))"],
    ["roll(2d6+3)->total", "(roll (+ (dice 2d6) 3) -> (path total))"],
    ["move(x, table)", "(move x table)"],
    ["move(x, this.table)", "(move x (container (. this table)))"],
    ["move(x, beside(this))", "(move x (beside this))"],
    ["move(x, beside (y.z))", "(move x (beside (. y z)))"],
    ["spawn(t, board(gm_board, [1, 2]))", "(spawn t (board gm_board (list 1 2)) (cells))"],
    ["spawn(t, table, {})", "(spawn t table (cells))"],
    ["spawn(t, beside(this), {`a b`: 1})", "(spawn t (beside this) (cells (`a b` 1)))"],
    ["move(x, board)", "(move x (container board))"],
    ["move(x, beside)", "(move x (container beside))"],
    ["move(x, table.y)", "(move x (container (. table y)))"],
    ["move(x, table + 1)", "(move x (container (+ table 1)))"],
    ["shuffle(deck)", "(shuffle deck)"],
    [
      "each(targets, roll(1d20) -> it.save_roll)",
      "(each targets (roll (dice 1d20) -> (path it save_roll)))",
    ],
    ["each(xs, move(it, table))", "(each xs (move it table))"],
    ["each(xs, remove(it))", "(each xs (remove it))"],
  ])("%s", (source, expected) => {
    expect(printStep(step(source))).toBe(expected);
  });

  test("step words are contextual: cells named table, set, board are values", () => {
    expect(printStep(step("set(set, table)"))).toBe("(set (path set) table)");
    expect(printStep(step("add(board, set + 1)"))).toBe("(add (path board) (+ set 1))");
    expect(printStep(step("set(table, board)"))).toBe("(set (path table) board)");
    expect(printStep(step("move(table, beside)"))).toBe("(move table (container beside))");
    expect(printStep(step("each(each, set(roll, move))"))).toBe(
      "(each each (set (path roll) move))",
    );
    expect(printStep(step("remove(spawn.x)"))).toBe("(remove (. spawn x))");
  });

  test("path nodes", () => {
    const set = step("set(hp, 1)");
    expect(set).toMatchObject({ kind: "set", path: { object: null, cell: "hp" } });
    const dot = step("add(target.hp, 1)");
    expect(dot).toMatchObject({
      kind: "add",
      path: { object: { kind: "Name", name: "target", start: 4, end: 10 }, cell: "hp" },
    });
  });

  test("expression spans are absolute in the step source", () => {
    const s = step("roll(attacker.damage_dice) -> dmg");
    if (s.kind !== "roll") throw new Error("expected roll");
    expect(s.dice).toMatchObject({ kind: "Dot", start: 5, end: 25 });
  });

  test("the result is exactly the documented shape", () => {
    expect(step("spawn(t, table)")).toEqual({
      kind: "spawn",
      template: { kind: "Name", name: "t", start: 6, end: 7 },
      to: { type: "table" },
      cells: [],
    });
    expect(step("move(x, beside(y))")).toEqual({
      kind: "move",
      object: { kind: "Name", name: "x", start: 5, end: 6 },
      to: { type: "beside", object: { kind: "Name", name: "y", start: 15, end: 16 } },
    });
  });
});

describe("refusals", () => {
  test.each([
    // [source, offset, message fragment]
    ["roll(1d20)", 10, "->"],
    ["set(1, 2)", 4, "path"],
    ["set(a)", 5, "set takes 2 arguments"],
    ["each(l, each(m, remove(it)))", 8, "each"],
    ["foo(a)", 0, "unknown step 'foo'"],
    ["set(a, 1) extra", 10, "unexpected 'extra'"],
    ["spawn(t, this, 3)", 15, "record"],
    ["spawn(t, this, {a: 1, a: 2})", 22, "duplicate field 'a'"],
    ["set(a, (1", 9, "expected ')'"],
    ["", 0, "step name"],
    ["   ", 3, "step name"],
    ["1 + 2", 0, "step name"],
    ["this(a)", 0, "step name"],
    ["`set`(a, 1)", 0, "step name"],
    ["set + 1", 4, "expected '('"],
    ["set", 3, "expected '('"],
    ["set(a, 1, 2)", 8, "set takes 2 arguments"],
    ["remove(a, b)", 8, "remove takes 1 argument"],
    ["shuffle()", 8, "unexpected ')'"],
    ["move(x)", 6, "move takes 2 arguments"],
    ["spawn(t)", 7, "spawn takes 2 or 3 arguments"],
    ["spawn(t, this, {a: 1}, 2)", 21, "spawn takes 2 or 3 arguments"],
    ["each(xs)", 7, "each takes 2 arguments"],
    ["each(xs, 3)", 9, "step name"],
    ["each(xs, foo(it))", 9, "unknown step 'foo'"],
    ["each(xs, set(a, 1) -> b)", 19, "->"],
    ["set(a, 1) -> b", 10, "->"],
    ["roll(1d20) -> 3", 14, "path"],
    ["roll(1d20) -> a b", 16, "unexpected 'b'"],
    ["roll(1d20) ->", 13, "unexpected end of input"],
    ["roll(1d20, 2) -> a", 9, "roll takes 1 argument"],
    ["set(a.where(x), 1)", 4, "path"],
    ["set(f(a), 1)", 4, "path"],
    ["set((a), 1)", 4, "path"],
    ["set((a.b), 1)", 4, "path"],
    ["set(this, 1)", 4, "path"],
    ["set(it, 1)", 4, "path"],
    ["set(a b, 1)", 6, "expected ','"],
    ["set(a, 1 2)", 9, "expected ')'"],
    ["set(a, b->c)", 8, "expected ')'"],
    ["set(a, 1 -> b)", 9, "expected ')'"],
    ["move(x, board(a))", 15, "board takes 2 arguments"],
    ["move(x, board(a, b, c))", 18, "board takes 2 arguments"],
    ["move(x, beside(a, b))", 16, "beside takes 1 argument"],
    ["move(x, board(a, b).c)", 19, "expected ')'"],
    ["move(x, table y)", 14, "expected ')'"],
    ["spawn(t, this, ({a: 1}))", 15, "record"],
    ["spawn(t, this, {a: 1}.a)", 15, "record"],
    ["set(a, 1) $", 10, "unexpected character"],
    ['set(a, "x)', 7, "unterminated text"],
    ["set(a, 2x)", 8, "a number cannot be followed"],
    ["set(a, 1))", 9, "unexpected ')'"],
    ["each(xs, each(ys, set(a, 1)))", 9, "each"],
  ])("%j fails at %i", (source, offset, fragment) => {
    const result = failure(source);
    expect(result.offset).toBe(offset);
    expect(result.message).toContain(fragment);
  });
});

describe("expression limits apply to the whole step source (FORMULAS §3.2, §8.4)", () => {
  const half = MAX_AST_NODES / 2; // 5,000

  test("arguments that together exceed the node limit are refused", () => {
    // Each list alone is 5,001 nodes, under the limit; together 10,002.
    const source = `move(${list(half)}, ${list(half)})`;
    expect(parseStep(`move(x, ${list(half)})`).ok).toBe(true);
    const result = failure(source);
    expect(result.message).toContain(`${MAX_AST_NODES}`);
    expect(result.offset).toBeGreaterThan(source.indexOf(", [") + 1);
  });

  test("the inner step of each counts toward the same limit", () => {
    // 5,001 + 1 (the path) + 5,000 = 10,002 nodes.
    const source = `each(${list(half)}, set(a, ${list(half - 1)}))`;
    expect(parseStep(`each(xs, set(a, ${list(half - 1)}))`).ok).toBe(true);
    expect(failure(source).message).toContain(`${MAX_AST_NODES}`);
  });

  test("exactly the limit parses", () => {
    // The path, the outer list, and two lists of 4,999 nodes: 10,000 nodes.
    expect(parseStep(`set(a, [${list(half - 2)}, ${list(half - 2)}])`).ok).toBe(true);
    // One more node fails, although the value alone (10,000 nodes) is within the limit.
    expect(parseStep(`set(a, [${list(half - 2)}, ${list(half - 1)}])`).ok).toBe(false);
  });

  test("a single argument over the limit reports the expression parser's failure", () => {
    const result = failure(`set(a, ${list(MAX_AST_NODES)})`);
    expect(result.message).toContain(`${MAX_AST_NODES}`);
  });

  test("depth is the deepest argument's depth", () => {
    const deep = (n: number) => `${"(".repeat(n)}1${")".repeat(n)}`;
    expect(parseStep(`move(${deep(MAX_AST_DEPTH)}, ${deep(MAX_AST_DEPTH)})`).ok).toBe(true);
    const result = failure(`each(xs, set(a, ${deep(MAX_AST_DEPTH + 1)}))`);
    expect(result.message).toContain(`${MAX_AST_DEPTH}`);
  });
});

describe("parseAction", () => {
  test("parses when with the expression parser and every step", () => {
    const parsed = parseAction({
      name: "Apply",
      when: "hit and dmg != empty and not applied",
      steps: ["add(target.damage_taken, dmg)", "set(applied, true)", "set(a)"],
    });
    expect(parsed.when?.ok).toBe(true);
    expect(parsed.steps.map((s) => s.ok)).toEqual([true, true, false]);
    expect(parsed.steps[2]).toMatchObject({ ok: false, offset: 5 });
  });

  test("an unparsable when is reported with its offset", () => {
    const parsed = parseAction({ name: "A", when: "a and", steps: ["remove(this)"] });
    expect(parsed.when).toMatchObject({ ok: false, offset: 5 });
  });

  test("no when means no when key", () => {
    const parsed = parseAction({ name: "Shuffle", steps: ["shuffle(this)"] });
    expect(Object.keys(parsed)).toEqual(["steps"]);
    expect(parsed.steps).toHaveLength(1);
  });

  test("a when that is a step is not an expression", () => {
    const parsed = parseAction({ name: "A", when: "roll(1d20) -> x", steps: ["remove(this)"] });
    expect(parsed.when).toMatchObject({ ok: false, offset: 11 });
  });
});
