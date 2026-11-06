import {
  FILE_FORMAT,
  isAbsoluteAssetPath,
  num,
  SCHEMA_VERSION,
  type TableFile,
  TableFileSchema,
} from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { fireballSnapshot, lit } from "./helpers";

const HASH = `sha256:${"0123456789abcdef".repeat(4)}`;

function file(): TableFile {
  return {
    format: FILE_FORMAT,
    schema_version: SCHEMA_VERSION,
    snapshot: { ...fireballSnapshot(), revision: 8 },
    snapshot_hash: HASH,
    log: {
      first_index: 5,
      groups: [
        {
          index: 5,
          base_revision: 7,
          revision: 8,
          actor: { type: "gm" },
          kind: "edit",
          label: "Set damage taken",
          names: { goblin1: "Goblin 1" },
          effects: [
            {
              type: "cell",
              object: "goblin1",
              cell: "damage_taken",
              before: lit(num(0)),
              after: lit(num(14)),
              cause: "edit",
            },
          ],
        },
      ],
      undo_barrier: 5,
    },
    assets: ["maps/dungeon.png", "tokens/goblin.webp"],
  };
}

/** A JSON copy with `edit` applied. */
function edited(edit: (f: Record<string, unknown>) => void): unknown {
  const f = JSON.parse(JSON.stringify(file()));
  edit(f);
  return f;
}

describe("file constants", () => {
  test("format and schema version", () => {
    expect(FILE_FORMAT).toBe("a-table-of-dumb-objects");
    expect(SCHEMA_VERSION).toBe(1);
  });
});

describe("TableFileSchema", () => {
  test("round-trips a hand-written file", () => {
    const f = file();
    expect(TableFileSchema.parse(JSON.parse(JSON.stringify(f)))).toEqual(f);
  });

  test("round-trips an empty log", () => {
    const f: TableFile = { ...file(), log: { first_index: 0, groups: [], undo_barrier: 0 } };
    expect(TableFileSchema.parse(JSON.parse(JSON.stringify(f)))).toEqual(f);
  });

  test("rejects a missing schema_version", () => {
    expect(TableFileSchema.safeParse(edited((f) => delete f.schema_version)).success).toBe(false);
  });

  test("rejects a schema_version that is not a positive integer", () => {
    for (const v of [0, 1.5, "1"]) {
      expect(TableFileSchema.safeParse(edited((f) => (f.schema_version = v))).success).toBe(false);
    }
  });

  test("rejects a format other than the constant, or none", () => {
    expect(TableFileSchema.safeParse(edited((f) => (f.format = "vtt"))).success).toBe(false);
    expect(TableFileSchema.safeParse(edited((f) => delete f.format)).success).toBe(false);
  });

  test("rejects unknown keys at the top, in the log and in the snapshot", () => {
    expect(TableFileSchema.safeParse(edited((f) => (f.saved_at = "now"))).success).toBe(false);
    expect(
      TableFileSchema.safeParse(
        edited((f) => {
          (f.log as Record<string, unknown>).last_index = 5;
        }),
      ).success,
    ).toBe(false);
    expect(
      TableFileSchema.safeParse(
        edited((f) => {
          (f.snapshot as Record<string, unknown>).version = 1;
        }),
      ).success,
    ).toBe(false);
  });

  test("snapshot_hash is sha256: and 64 lowercase hex digits", () => {
    for (const h of ["0123", `sha1:${"ab".repeat(20)}`, `sha256:${"AB".repeat(32)}`]) {
      expect(TableFileSchema.safeParse(edited((f) => (f.snapshot_hash = h))).success).toBe(false);
    }
  });

  test("asset paths are relative", () => {
    for (const p of ["/maps/dungeon.png", "C:\\maps\\dungeon.png", "c:/maps", "\\\\host\\x", ""]) {
      expect(TableFileSchema.safeParse(edited((f) => (f.assets = [p]))).success).toBe(false);
    }
    expect(TableFileSchema.safeParse(edited((f) => (f.assets = ["../shared/a.png"]))).success).toBe(
      true,
    );
  });

  test("log indices are non-negative integers", () => {
    expect(
      TableFileSchema.safeParse(
        edited((f) => {
          (f.log as Record<string, unknown>).undo_barrier = -1;
        }),
      ).success,
    ).toBe(false);
  });
});

describe("isAbsoluteAssetPath", () => {
  test.each([
    ["/x", true],
    ["\\x", true],
    ["C:x", true],
    ["c:/x", true],
    ["x/y", false],
    ["./x", false],
    ["", false],
  ])("%j is absolute: %s", (path, expected) => {
    expect(isAbsoluteAssetPath(path)).toBe(expected);
  });
});
