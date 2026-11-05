import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DocumentStore,
  type FileHandleLike,
  InvalidAssetPathError,
  loadTable,
  nodeFs,
  type PersistFs,
  saveTable,
  TableLoadError,
  writeValue,
} from "@vtt/authority";
import { num } from "@vtt/schema";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { fileOf, gm, playedStore, scene, setHp, textOf } from "./helpers";

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vtt-io-"));
  path = join(dir, "table.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const fault = (code: string): Error => Object.assign(new Error(`injected ${code}`), { code });

/** nodeFs with the temp file's handle (the first `open` for writing) patched. */
function withTempHandle(patch: Partial<FileHandleLike>): PersistFs {
  return {
    ...nodeFs,
    async open(p, flags) {
      const handle = await nodeFs.open(p, flags);
      if (flags === "r") return handle;
      return {
        writeFile: patch.writeFile ?? ((data, enc) => handle.writeFile(data, enc)),
        sync: patch.sync ?? (() => handle.sync()),
        close: () => handle.close(),
      };
    },
  };
}

/** nodeFs whose directory fsync fails with `err`. */
function withDirSync(err: Error): PersistFs {
  return {
    ...nodeFs,
    async open(p, flags) {
      const handle = await nodeFs.open(p, flags);
      if (flags !== "r") return handle;
      return {
        writeFile: (data, enc) => handle.writeFile(data, enc),
        sync: async () => {
          throw err;
        },
        close: () => handle.close(),
      };
    },
  };
}

describe("saveTable", () => {
  test("writes the canonical text and leaves no temp file", async () => {
    const store = playedStore();
    expect(await saveTable(path, store, ["map.png"])).toEqual({ ok: true });
    expect(await readFile(path, "utf8")).toBe(textOf(store, ["map.png"]));
    expect(await readdir(dir)).toEqual(["table.json"]);
  });

  test("save → load → save is byte-identical", async () => {
    const store = playedStore();
    expect(await saveTable(path, store, [])).toEqual({ ok: true });
    const first = await readFile(path, "utf8");
    const loaded = await loadTable(path);
    expect(await saveTable(path, loaded.store, loaded.assets)).toEqual({ ok: true });
    expect(await readFile(path, "utf8")).toBe(first);
  });

  test("replaces an existing file", async () => {
    const store = playedStore();
    await writeFile(path, "old contents");
    expect(await saveTable(path, store, [])).toEqual({ ok: true });
    expect(await readFile(path, "utf8")).toBe(textOf(store));
  });

  describe("a failure before the replacement leaves the original byte-identical", () => {
    async function expectBeforeReplace(fs: PersistFs, code: string): Promise<void> {
      const original = playedStore();
      expect(await saveTable(path, original, [])).toEqual({ ok: true });
      const bytes = await readFile(path);
      const store = playedStore();
      setHp(store, 1);
      const result = await saveTable(path, store, [], fs);
      expect(result).toMatchObject({ ok: false, stage: "before_replace" });
      if (result.ok) throw new Error("unreachable");
      expect((result.error as { code?: string }).code).toBe(code);
      expect(await readFile(path)).toEqual(bytes);
      expect(await readdir(dir)).toEqual(["table.json"]);
    }

    test("the temp write", async () => {
      const fs = withTempHandle({
        writeFile: async () => {
          throw fault("ENOSPC");
        },
      });
      await expectBeforeReplace(fs, "ENOSPC");
    });

    test("a partial temp write", async () => {
      const fs: PersistFs = {
        ...nodeFs,
        async open(p, flags) {
          const handle = await nodeFs.open(p, flags);
          if (flags === "r") return handle;
          return {
            writeFile: async (data, enc) => {
              await handle.writeFile(data.slice(0, 10), enc);
              throw fault("ENOSPC");
            },
            sync: () => handle.sync(),
            close: () => handle.close(),
          };
        },
      };
      await expectBeforeReplace(fs, "ENOSPC");
    });

    test("the temp fsync", async () => {
      const fs = withTempHandle({
        sync: async () => {
          throw fault("EIO");
        },
      });
      await expectBeforeReplace(fs, "EIO");
    });

    test("the rename", async () => {
      const fs: PersistFs = {
        ...nodeFs,
        rename: async () => {
          throw fault("EXDEV");
        },
      };
      await expectBeforeReplace(fs, "EXDEV");
    });

    test("opening the temp file", async () => {
      const fs: PersistFs = {
        ...nodeFs,
        open: async (p, flags) => {
          if (flags !== "r") throw fault("EACCES");
          return nodeFs.open(p, flags);
        },
      };
      await expectBeforeReplace(fs, "EACCES");
    });

    test("with no original file, no file is left at all", async () => {
      const fs = withTempHandle({
        sync: async () => {
          throw fault("EIO");
        },
      });
      const result = await saveTable(path, playedStore(), [], fs);
      expect(result).toMatchObject({ ok: false, stage: "before_replace" });
      expect(await readdir(dir)).toEqual([]);
    });
  });

  test("a directory fsync failure leaves the new file in place and intact", async () => {
    await writeFile(path, "old contents");
    const store = playedStore();
    const result = await saveTable(path, store, [], withDirSync(fault("EIO")));
    expect(result).toMatchObject({ ok: false, stage: "after_replace" });
    if (result.ok) throw new Error("unreachable");
    expect((result.error as { code?: string }).code).toBe("EIO");
    expect(await readFile(path, "utf8")).toBe(textOf(store));
    expect(await readdir(dir)).toEqual(["table.json"]);
    const loaded = await loadTable(path);
    expect(loaded.store.toSnapshot()).toEqual(store.toSnapshot());
  });

  test.each(["EISDIR", "EPERM"])("a directory fsync refused with %s is ignored", async (code) => {
    const store = playedStore();
    expect(await saveTable(path, store, [], withDirSync(fault(code)))).toEqual({ ok: true });
    expect(await readFile(path, "utf8")).toBe(textOf(store));
  });

  test("captures the state at the call: a same-tick mutation does not reach the file", async () => {
    const store = playedStore();
    const before = store.toSnapshot();
    const log = store.history.toLog();
    const saving = saveTable(path, store, []);
    const result = store.transact(gm, { kind: "edit", label: "later" }, (tx) =>
      writeValue(tx, "goblin", "hp", num(1)),
    );
    expect(result.ok).toBe(true);
    expect(await saving).toEqual({ ok: true });
    const loaded = await loadTable(path);
    expect(loaded.store.toSnapshot()).toEqual(before);
    expect(loaded.store.history.toLog()).toEqual(log);
  });

  test("an invalid asset path rejects and writes nothing", async () => {
    await expect(saveTable(path, playedStore(), ["/abs/map.png"])).rejects.toThrow(
      InvalidAssetPathError,
    );
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("loadTable", () => {
  test("loads a saved table with its assets and no warnings when they exist", async () => {
    await mkdir(join(dir, "images"));
    await writeFile(join(dir, "images", "map.png"), "png");
    const store = playedStore();
    await saveTable(path, store, ["images/map.png"]);
    const loaded = await loadTable(path);
    expect(loaded.store.toSnapshot()).toEqual(store.toSnapshot());
    expect(loaded.store.history.toLog()).toEqual(store.history.toLog());
    expect(loaded.assets).toEqual(["images/map.png"]);
    expect(loaded.editedExternally).toBe(false);
    expect(loaded.warnings).toEqual([]);
  });

  test("warns about a missing asset and loads the document anyway", async () => {
    await writeFile(join(dir, "present.png"), "png");
    const store = playedStore();
    await saveTable(path, store, ["present.png", "tokens/goblin.webp"]);
    const loaded = await loadTable(path);
    expect(loaded.store.toSnapshot()).toEqual(store.toSnapshot());
    expect(loaded.warnings).toEqual([
      {
        type: "missing_asset",
        path: "tokens/goblin.webp",
        message: expect.stringContaining("tokens/goblin.webp"),
      },
    ]);
  });

  test("resolves asset paths against the file's directory, not the working directory", async () => {
    const sub = join(dir, "campaign");
    await mkdir(sub);
    await writeFile(join(sub, "map.png"), "png");
    const file = join(sub, "table.json");
    await saveTable(file, DocumentStore.fromSnapshot(scene()), ["map.png"]);
    expect((await loadTable(file)).warnings).toEqual([]);
  });

  test("checks assets through the injected fs", async () => {
    await saveTable(path, DocumentStore.fromSnapshot(scene()), ["virtual.png"]);
    const seen: string[] = [];
    const fs: PersistFs = {
      ...nodeFs,
      stat: async (p) => {
        seen.push(p);
      },
    };
    expect((await loadTable(path, fs)).warnings).toEqual([]);
    expect(seen).toEqual([join(dir, "virtual.png")]);
  });

  test("passes the parse warnings through", async () => {
    const snapshot = scene();
    await writeFile(path, fileOf(snapshot, undefined, `sha256:${"0".repeat(64)}`));
    const loaded = await loadTable(path);
    expect(loaded.editedExternally).toBe(true);
    expect(loaded.warnings.map((w) => w.type)).toEqual(["edited_externally"]);
  });

  test("a file that does not parse throws TableLoadError", async () => {
    await writeFile(path, "{ not json");
    await expect(loadTable(path)).rejects.toThrow(TableLoadError);
  });

  test("a missing file rejects with the read error", async () => {
    await expect(loadTable(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
