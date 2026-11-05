import { MIGRATIONS, type Migration, MigrationError, migrate, parseTable } from "@vtt/authority";
import { SCHEMA_VERSION } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { playedStore, textOf } from "./helpers";

describe("migrate", () => {
  test("MIGRATIONS is empty at version 1 and leaves a current file as is", () => {
    expect(SCHEMA_VERSION).toBe(1);
    expect(Object.keys(MIGRATIONS)).toEqual([]);
    const json = JSON.parse(textOf(playedStore()));
    expect(migrate(json)).toEqual(json);
  });

  const calls: string[] = [];
  const registry: Record<number, Migration> = {
    1: (j) => {
      calls.push("1→2");
      return { ...j, added_in_2: true };
    },
    2: (j) => {
      calls.push("2→3");
      return { ...j, seen_2: j.added_in_2 === true };
    },
  };

  test("takes a v1 file to v3 one version at a time, in order", () => {
    calls.length = 0;
    const out = migrate({ schema_version: 1, body: "x" }, registry);
    expect(calls).toEqual(["1→2", "2→3"]);
    expect(out).toEqual({ schema_version: 3, body: "x", added_in_2: true, seen_2: true });
  });

  test("starts from the file's version", () => {
    calls.length = 0;
    expect(migrate({ schema_version: 2 }, registry)).toEqual({ schema_version: 3, seen_2: false });
    expect(calls).toEqual(["2→3"]);
  });

  test("does not change its input", () => {
    const input = { schema_version: 1 };
    migrate(input, registry);
    expect(input).toEqual({ schema_version: 1 });
  });

  test("refuses a version above the registry's", () => {
    expect(() => migrate({ schema_version: 4 }, registry)).toThrow(MigrationError);
    expect(() => migrate({ schema_version: 2 })).toThrow(/newer/);
  });

  test.each([
    [null],
    [[]],
    [{}],
    [{ schema_version: 0 }],
    [{ schema_version: 1.5 }],
    [{ schema_version: "1" }],
  ])("refuses %j without a positive integer schema_version", (json) => {
    expect(() => migrate(json, registry)).toThrow(MigrationError);
  });

  test("refuses a gap in the registry", () => {
    expect(() => migrate({ schema_version: 1 }, { 2: (j) => j })).toThrow(
      /no migration from version 1/,
    );
  });
});

describe("parseTable and schema versions", () => {
  test("refuses a file newer than this code", () => {
    const json = JSON.parse(textOf(playedStore()));
    json.schema_version = SCHEMA_VERSION + 1;
    expect(() => parseTable(JSON.stringify(json))).toThrow(
      expect.objectContaining({
        name: "TableLoadError",
        problems: [expect.objectContaining({ stage: "version" })],
      }),
    );
  });
});
