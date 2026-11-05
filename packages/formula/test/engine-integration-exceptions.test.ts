import { createEngine, type EvalHost } from "@vtt/formula";
import type { Bounds, CellContent, ObjectId } from "@vtt/schema";
import { list, num, ref } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { doc } from "./support/engine-doc";
import type { MemoryHost } from "./support/memory-host";

/** A host that throws while `failOn` names the cell being read, or on any query. */
class ThrowingHost implements EvalHost {
  failOn: string | null = null;
  failQueries = false;
  constructor(readonly inner: MemoryHost) {}
  exists(id: ObjectId): boolean {
    return this.inner.exists(id);
  }
  cell(id: ObjectId, name: string): CellContent | undefined {
    if (this.failOn === `${id}.${name}`) throw new Error(`host failure reading ${id}.${name}`);
    return this.inner.cell(id, name);
  }
  objectsNamed(name: string): ObjectId[] {
    return this.inner.objectsNamed(name);
  }
  allObjects(): ObjectId[] {
    return this.inner.allObjects();
  }
  objectsOnBoard(board: ObjectId, near: Bounds): ObjectId[] {
    if (this.failQueries) throw new Error("host failure in objectsOnBoard");
    return this.inner.objectsOnBoard(board, near);
  }
}

function chain() {
  const inner = doc({
    a: { cells: { x: "=b.y + 1", b: ref("b"), wide: "=x + b.y + b.c.z" } },
    b: { cells: { y: "=c.z * 2", c: ref("c") } },
    c: { cells: { z: 5, w: "=z" } },
  });
  return { inner, host: new ThrowingHost(inner) };
}

describe("host exceptions", () => {
  test("propagate out of value; the engine stays usable and the next read is correct", () => {
    const { inner, host } = chain();
    const engine = createEngine(host);
    host.failOn = "c.z";
    expect(() => engine.value("a", "x")).toThrow("host failure reading c.z");
    expect(() => engine.value("a", "wide")).toThrow("host failure reading c.z");
    host.failOn = null;
    expect(engine.value("a", "x")).toEqual(num(11));
    expect(engine.value("a", "wide")).toEqual(num(26));
    // Warm, then fail mid-recompute after a change.
    engine.invalidate(inner.set("c", "z", num(6)));
    host.failOn = "c.z";
    expect(() => engine.value("a", "wide")).toThrow();
    host.failOn = null;
    const before = engine.stats().evaluations;
    expect(engine.value("a", "wide")).toEqual(num(31));
    // a.wide, a.x and b.y were left dirty by the failure and recompute once each.
    expect(engine.stats().evaluations - before).toBe(3);
    expect(engine.value("a", "x")).toEqual(num(13));
    expect(engine.stats().evaluations - before).toBe(3);
    // Invalidation still reaches every dependent.
    engine.invalidate(inner.set("c", "z", num(1)));
    expect(engine.value("a", "wide")).toEqual(num(6));
  });

  test("a failure while reading the formula cell itself", () => {
    const { host } = chain();
    const engine = createEngine(host);
    host.failOn = "b.y";
    expect(() => engine.value("a", "x")).toThrow();
    host.failOn = null;
    expect(engine.value("a", "x")).toEqual(num(11));
  });

  test("propagate out of evaluate; the engine stays usable", () => {
    const { host } = chain();
    const engine = createEngine(host);
    host.failOn = "c.z";
    expect(() => engine.evaluate("x + 1", { thisId: "a" })).toThrow();
    host.failOn = null;
    expect(engine.evaluate("x + 1", { thisId: "a" })).toEqual(num(12));
    expect(engine.value("c", "w")).toEqual(num(5));
  });

  test("a failing spatial query", () => {
    const inner = doc({ t: {} });
    inner.createObject("zone", {
      is_zone: true,
      shape: { type: "rect", width: 2, height: 2 },
      cells: {},
      placement: { board: "table", position: [0, 0] },
    });
    inner.replaceContent("zone", "inside", { type: "formula", source: "contents(this)" });
    const host = new ThrowingHost(inner);
    const engine = createEngine(host);
    host.failQueries = true;
    expect(() => engine.value("zone", "inside")).toThrow("objectsOnBoard");
    host.failQueries = false;
    expect(engine.value("zone", "inside")).toEqual(list([ref("t")]));
  });
});
