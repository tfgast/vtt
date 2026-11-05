/**
 * Support for the §10 acceptance suite (test/acceptance): a scenario file
 * plus a MemoryHost-backed table on which its formulas and `when` guards are
 * evaluated in the states the scenario's steps reach (FIXTURES.md §9).
 *
 * Nothing here executes actions. States that need an action (a roll, a
 * spawn, Apply's writes) are built by the test: literal roll results from
 * the dice script written with `set`, spawned copies created from the
 * template in the setup, placements reached with `MemoryHost.move`.
 *
 * Every source comes from the scenario file, never retyped, and the table
 * records which formula and `when` sources it evaluated, so `coverageTest`
 * can fail listing any the file never evaluated.
 */
import {
  type CellContent as FixtureContent,
  loadScenario,
  type Scenario,
  type Step,
} from "@vtt/fixtures";
import { createEngine, type Engine, parse } from "@vtt/formula";
import {
  bool,
  type CellContent,
  isError,
  type ObjectId,
  type Result,
  ref,
  type Value,
} from "@vtt/schema";
import { expect, test } from "vitest";
import { fromFixtureContent, fromFixtureValue } from "./fixture-values";
import { type CreateInit, type CreatePlacement, type Destination, MemoryHost } from "./memory-host";
import { SCENARIOS_DIR } from "./scenarios";

/** A formula or `when` source in a scenario, and where it sits. */
export interface SourceSite {
  where: string;
  source: string;
}

/**
 * Every formula and `when` source of a scenario: setup cells, formula
 * positions, setup actions' guards, and formula cells given at spawn.
 */
export function scenarioSources(s: Scenario): SourceSite[] {
  const out: SourceSite[] = [];
  const content = (where: string, c: FixtureContent) => {
    if (c.type === "formula") out.push({ where, source: c.source });
  };
  for (const o of s.setup.objects) {
    for (const [cell, c] of Object.entries(o.cells ?? {})) content(`${o.id}.${cell}`, c);
    const p = o.placement?.position;
    if (p !== undefined && !Array.isArray(p)) content(`${o.id}.position`, p);
    for (const a of o.actions ?? []) {
      if (a.when !== undefined) out.push({ where: `${o.id}[${a.name}] when`, source: a.when });
    }
  }
  s.steps.forEach((step, i) => {
    const d = step.do;
    if (d.type !== "spawn") return;
    for (const [cell, c] of Object.entries(d.cells ?? {})) content(`steps[${i}] spawn ${cell}`, c);
  });
  return out;
}

/** A number, empty (0), or roll result (its total), as arithmetic sees it (§2.1, §2.2). */
export function totalOf(r: Result): number {
  if (r.type === "number") return r.value;
  if (r.type === "empty") return 0;
  if (r.type === "roll") return r.total;
  throw new Error(`not a number: ${JSON.stringify(r)}`);
}

type StepRef = number | "setup";

/** Load `scenarios/<file>.json` for an acceptance file. */
export async function acceptance(file: string): Promise<Acceptance> {
  return new Acceptance(file, await loadScenario(`${SCENARIOS_DIR}${file}.json`));
}

export class Acceptance {
  /** Sources evaluated by any table of this file. */
  readonly evaluated = new Set<string>();

  constructor(
    readonly file: string,
    readonly scenario: Scenario,
  ) {}

  get title(): string {
    return this.scenario.title;
  }

  /** The label a test quotes: the scenario title and the step index. */
  at(step: StepRef): string {
    return step === "setup" ? `"${this.title}" setup` : `"${this.title}" step ${step}`;
  }

  step(i: number): Step {
    const s = this.scenario.steps[i];
    if (s === undefined) throw new Error(`${this.file}: no step ${i}`);
    return s;
  }

  /** The setup object `id`. */
  object(id: ObjectId) {
    const o = this.scenario.setup.objects.find((x) => x.id === id);
    if (o === undefined) throw new Error(`${this.file}: no setup object ${id}`);
    return o;
  }

  /** The `when` source of action `name` on setup object `id`. */
  when(id: ObjectId, name: string): string | undefined {
    const a = (this.object(id).actions ?? []).find((x) => x.name === name);
    if (a === undefined) throw new Error(`${this.file}: ${id} has no action ${name}`);
    return a.when;
  }

  /**
   * The source text of each argument of the call that is step `index` of
   * action `name` on `id` (e.g. `move(first(deck.contents), owner.hand)`),
   * sliced from the step source by the parser's spans.
   */
  stepArgs(id: ObjectId, name: string, index: number): string[] {
    const a = (this.object(id).actions ?? []).find((x) => x.name === name);
    const source = a?.steps[index];
    if (source === undefined) throw new Error(`${this.file}: ${id}[${name}] has no step ${index}`);
    const parsed = parse(source);
    if (!parsed.ok || parsed.ast.kind !== "Call") throw new Error(`not a call: ${source}`);
    return parsed.ast.args.map((arg) => source.slice(arg.start, arg.end));
  }

  /** Dice script entry `i`, which must be a roll result, as a value. */
  roll(i: number): Value {
    const d = this.scenario.dice[i];
    if (d?.type !== "roll") throw new Error(`${this.file}: dice[${i}] is not a roll`);
    return fromFixtureValue(d);
  }

  expectations(step: StepRef) {
    return (step === "setup" ? this.scenario.expect : this.step(step).expect) ?? [];
  }

  /** The value a `cell` expectation of the step asserts. */
  expectedCell(step: StepRef, object: ObjectId, cell: string): Value {
    for (const e of this.expectations(step)) {
      if (e.type === "cell" && e.object === object && e.cell === cell) {
        return fromFixtureValue(e.value);
      }
    }
    throw new Error(`${this.at(step)} has no cell expectation on ${object}.${cell}`);
  }

  /** A fresh table: the post-setup document and an engine over it. */
  table(): Table {
    return new Table(this);
  }

  /** Sources of the scenario that no table of this file has evaluated. */
  unevaluated(): SourceSite[] {
    return scenarioSources(this.scenario).filter((s) => !this.evaluated.has(s.source));
  }

  /**
   * Register the file's coverage gate. Call it last in the file: tests run
   * in declaration order, so it runs after every other test.
   */
  coverageTest(): void {
    test(`"${this.title}": every formula and when source is evaluated`, () => {
      expect(this.unevaluated()).toEqual([]);
    });
  }
}

export class Table {
  readonly host: MemoryHost;
  readonly engine: Engine;
  /** Spawned copy to the setup object its actions come from. */
  private readonly origin = new Map<ObjectId, ObjectId>();

  constructor(private readonly acc: Acceptance) {
    this.host = MemoryHost.fromSetup(acc.scenario.setup);
    this.engine = createEngine(this.host);
  }

  /** The cell's value, recording its source if it holds a formula without override. */
  value(object: ObjectId, cell: string): Result {
    const content = this.host.cell(object, cell);
    if (content?.type === "formula") this.acc.evaluated.add(content.source);
    return this.engine.value(object, cell);
  }

  /** Evaluate a source on `thisId` (engine.evaluate), recording it. */
  evaluate(source: string, thisId: ObjectId): Result {
    this.acc.evaluated.add(source);
    return this.engine.evaluate(source, { thisId });
  }

  /**
   * Whether action `name` of `object` is enabled (FIXTURES §7 `action`):
   * its `when` (from the setup object it was spawned from, if a copy)
   * evaluated on `object`. An absent `when` is true.
   */
  guard(object: ObjectId, name: string): Result {
    const when = this.acc.when(this.origin.get(object) ?? object, name);
    return when === undefined ? bool(true) : this.evaluate(when, object);
  }

  set(object: ObjectId, cell: string, value: Value): void {
    this.engine.invalidate(this.host.set(object, cell, value));
  }

  move(object: ObjectId, dest: Destination): void {
    this.engine.invalidate(this.host.move(object, dest));
  }

  create(id: ObjectId, init: CreateInit): void {
    this.engine.invalidate(this.host.createObject(id, init));
  }

  /** Apply step `i`, which must be a `set`, `override`, `clear_override`, or `move`. */
  do(i: number): void {
    const d = this.acc.step(i).do;
    switch (d.type) {
      case "set":
        this.set(d.object, d.cell, fromFixtureValue(d.value));
        return;
      case "override":
        this.engine.invalidate(this.host.override(d.object, d.cell, fromFixtureValue(d.value)));
        return;
      case "clear_override":
        this.engine.invalidate(this.host.clearOverride(d.object, d.cell));
        return;
      case "move":
        this.move(d.object, d.to);
        return;
      default:
        throw new Error(`${this.acc.at(i)} is a ${d.type} step; build its state by hand`);
    }
  }

  /**
   * A copy of setup object `template` as `id`: its tag, shape, `is_zone`,
   * and cells, then `template` and the given cells. Inside-subtree copies
   * are the caller's (see `spawnStep`).
   */
  spawn(
    template: ObjectId,
    id: ObjectId,
    placement: CreatePlacement,
    cells: Record<string, CellContent> = {},
    remap: ReadonlyMap<ObjectId, ObjectId> = new Map(),
  ): void {
    const t = this.acc.object(template);
    const copied: Record<string, CellContent> = {};
    for (const [name, c] of Object.entries(t.cells ?? {})) {
      const content = fromFixtureContent(c);
      copied[name] =
        content.type === "ref" && remap.has(content.object)
          ? ref(remap.get(content.object) as ObjectId)
          : content;
    }
    this.create(id, {
      ...(t.tag === undefined ? {} : { tag: t.tag }),
      ...(t.shape === undefined ? {} : { shape: t.shape }),
      ...(t.is_zone === undefined ? {} : { is_zone: t.is_zone }),
      placement,
      cells: { ...copied, template: ref(template), ...cells },
    });
    this.origin.set(id, template);
  }

  /**
   * The state after spawn step `i` (FORMULAS §8.3): the template's subtree
   * copied, the root at the step's destination with the step's cells, each
   * subtree object as its `owned` binding (or `<as>_<id>`), and references
   * into the subtree remapped to the copies.
   */
  spawnStep(i: number): void {
    const d = this.acc.step(i).do;
    if (d.type !== "spawn") throw new Error(`${this.acc.at(i)} is not a spawn`);
    const remap = new Map<ObjectId, ObjectId>([[d.template, d.as]]);
    const subtree: ObjectId[] = [];
    const walk = (id: ObjectId) => {
      for (const c of this.acc.object(id).contents ?? []) {
        remap.set(c, d.owned?.[c] ?? `${d.as}_${c}`);
        subtree.push(c);
        walk(c);
      }
    };
    walk(d.template);
    const placement: CreatePlacement =
      d.to.type === "board"
        ? { board: d.to.board, position: d.to.position }
        : { container: d.to.container, index: d.to.index };
    const cells = Object.fromEntries(
      Object.entries(d.cells ?? {}).map(([name, c]) => [name, fromFixtureContent(c)]),
    );
    this.spawn(d.template, d.as, placement, cells, remap);
    for (const c of subtree) {
      const parent = this.acc.scenario.setup.objects.find((o) => o.contents?.includes(c));
      const container = remap.get(parent?.id ?? "") as ObjectId;
      this.spawn(c, remap.get(c) as ObjectId, { container }, {}, remap);
    }
  }

  /**
   * Check the step's expectations that this suite can judge: every `cell`
   * and `cell_error` on a cell holding a formula without override, and
   * every `action`. `required` lists keys (`object.cell`, `object[Action]`)
   * that must be among those checked, so a test names what it mirrors.
   */
  checkStep(step: StepRef, required: readonly string[] = []): void {
    const checked: string[] = [];
    const label = this.acc.at(step);
    for (const e of this.acc.expectations(step)) {
      if (e.type === "cell" || e.type === "cell_error") {
        if (!this.host.exists(e.object)) continue;
        if (this.host.cell(e.object, e.cell)?.type !== "formula") continue;
        const key = `${e.object}.${e.cell}`;
        const actual = this.value(e.object, e.cell);
        if (e.type === "cell") {
          expect(actual, `${label}: ${key}`).toEqual(fromFixtureValue(e.value));
        } else {
          expect(isError(actual) ? actual.code : actual, `${label}: ${key}`).toBe(e.code);
        }
        checked.push(key);
      } else if (e.type === "action") {
        const key = `${e.object}[${e.action}]`;
        const actual = this.guard(e.object, e.action);
        const enabled = !isError(actual) && actual.type === "boolean" && actual.value;
        expect(enabled, `${label}: ${key} = ${JSON.stringify(actual)}`).toBe(e.enabled);
        if (!e.enabled) {
          // A false guard must be the boolean false, not an error, unless the
          // scenario says otherwise; an error would hide a broken formula.
          expect(actual, `${label}: ${key}`).toEqual(bool(false));
        }
        checked.push(key);
      }
    }
    for (const k of required) expect(checked, `${label} checks ${k}`).toContain(k);
  }
}
