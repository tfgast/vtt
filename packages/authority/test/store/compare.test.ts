import { diffStoredState, storedStateEqual } from "@vtt/authority";
import type { Snapshot } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { lit, must, table } from "./helpers";

const variant = (f: (s: Snapshot) => void): Snapshot => {
  const s = table();
  f(s);
  return s;
};

describe("storedStateEqual", () => {
  test("equal snapshots are equal, whatever the key order", () => {
    const reordered = variant((s) => {
      s.objects = Object.fromEntries(Object.entries(s.objects).reverse());
      const goblin = must(s.objects.goblin);
      goblin.cells = Object.fromEntries(Object.entries(goblin.cells).reverse());
    });
    expect(storedStateEqual(table(), reordered)).toBe(true);
    expect(diffStoredState(table(), reordered)).toEqual([]);
  });

  test("ignores revision by default, and not when asked", () => {
    const later = variant((s) => {
      s.revision = 9;
    });
    expect(storedStateEqual(table(), later)).toBe(true);
    expect(storedStateEqual(table(), later, { ignoreRevision: false })).toBe(false);
  });

  test("compares identity unless asked to ignore it", () => {
    const seq = variant((s) => {
      s.next_seq = 8;
    });
    const retired = variant((s) => {
      s.retired_ids.push("gone");
    });
    expect(storedStateEqual(table(), seq)).toBe(false);
    expect(storedStateEqual(table(), retired)).toBe(false);
    expect(storedStateEqual(table(), seq, { ignoreIdentity: true })).toBe(true);
    expect(storedStateEqual(table(), retired, { ignoreIdentity: true })).toBe(true);
  });

  test("sees cells, order of contents and boards", () => {
    expect(
      storedStateEqual(
        table(),
        variant((s) => {
          must(s.objects.goblin).cells.hp = lit(6);
        }),
      ),
    ).toBe(false);
    expect(
      storedStateEqual(
        table(),
        variant((s) => {
          must(s.objects.bag).contents.reverse();
        }),
      ),
    ).toBe(false);
    expect(
      storedStateEqual(
        table(),
        variant((s) => {
          s.boards.reverse();
        }),
      ),
    ).toBe(false);
  });
});

describe("diffStoredState", () => {
  test("names each difference by path", () => {
    const other = variant((s) => {
      must(s.objects.goblin).cells.hp = lit(6);
      delete must(s.objects.gem).cells.value;
      s.revision = 4;
    });
    const diff = diffStoredState(table(), other);
    expect(diff).toHaveLength(2);
    expect(diff[0]).toContain("objects.gem.cells.value");
    expect(diff[1]).toContain("objects.goblin.cells.hp");
    expect(diffStoredState(table(), other, { ignoreRevision: false })).toHaveLength(3);
  });
});
