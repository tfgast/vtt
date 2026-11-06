import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireTableLock,
  canonicalTablePath,
  nodeTableFs,
  readOrCreateTableId,
  type TableFs,
  TableIdentityError,
  type TableLock,
} from "@vtt/authority";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let dir: string;
let table: string;
let idPath: string;
let lock: TableLock;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "vtt-identity-")));
  table = join(dir, "table.json");
  idPath = `${table}.table-id`;
  lock = await acquireTableLock(table);
});

afterEach(async () => {
  await lock.release();
  await rm(dir, { recursive: true, force: true });
});

const fault = (code: string): Error => Object.assign(new Error(`injected ${code}`), { code });

/** Sorted names in the temp directory other than the lock file. */
const files = async (): Promise<string[]> =>
  (await readdir(dir)).filter((name) => !name.endsWith(".lock")).sort();

describe("canonicalTablePath", () => {
  test("an existing file is its own real path", async () => {
    await writeFile(table, "{}");
    expect(canonicalTablePath(table)).toBe(table);
  });

  test("a symlink to the table and the table give the same path", async () => {
    await writeFile(table, "{}");
    const alias = join(dir, "alias.json");
    await symlink(table, alias);
    expect(canonicalTablePath(alias)).toBe(canonicalTablePath(table));
  });

  test("a missing file in an existing directory resolves the directory's symlinks", async () => {
    const real = join(dir, "real");
    await mkdir(real);
    await symlink(real, join(dir, "link"));
    expect(canonicalTablePath(join(dir, "link", "new.json"))).toBe(join(real, "new.json"));
  });

  test("the OS temp directory's own symlinks are resolved", async () => {
    const raw = await mkdtemp(join(tmpdir(), "vtt-identity-raw-"));
    try {
      expect(canonicalTablePath(join(raw, "t.json"))).toBe(join(await realpath(raw), "t.json"));
    } finally {
      await rm(raw, { recursive: true, force: true });
    }
  });

  test("a missing directory is an error naming it", () => {
    const missingDir = join(dir, "nope");
    expect(() => canonicalTablePath(join(missingDir, "t.json"))).toThrow(missingDir);
  });

  test("a dangling symlink resolves to its target, relative to the link's directory", async () => {
    const real = join(dir, "real");
    await mkdir(real);
    await symlink(join("real", "target.json"), join(dir, "alias.json"));
    expect(canonicalTablePath(join(dir, "alias.json"))).toBe(join(real, "target.json"));
  });

  test("a chain of dangling symlinks is followed to the last target", async () => {
    await symlink("b.json", join(dir, "a.json"));
    await symlink("c.json", join(dir, "b.json"));
    expect(canonicalTablePath(join(dir, "a.json"))).toBe(join(dir, "c.json"));
  });

  test("a dangling symlink in a symlinked directory resolves against the real directory", async () => {
    const real = join(dir, "real");
    await mkdir(join(real, "sub"), { recursive: true });
    await symlink(join(real, "sub"), join(dir, "linkdir"));
    await symlink(join("..", "up.json"), join(real, "sub", "alias.json"));
    expect(canonicalTablePath(join(dir, "linkdir", "alias.json"))).toBe(join(real, "up.json"));
  });

  test("a dangling symlink whose target directory is missing is an error naming both", async () => {
    const alias = join(dir, "alias.json");
    const missingDir = join(dir, "nope");
    await symlink(join(missingDir, "t.json"), alias);
    expect(() => canonicalTablePath(alias)).toThrow(missingDir);
    expect(() => canonicalTablePath(alias)).toThrow(`symlink ${alias}`);
  });

  test("a symlink loop is an error naming the path", async () => {
    const a = join(dir, "a.json");
    await symlink("b.json", a);
    await symlink("a.json", join(dir, "b.json"));
    expect(() => canonicalTablePath(a)).toThrow(`table path ${a} is a symlink loop`);
  });

  test("a symlink loop reported only by readlinkSync is caught", () => {
    const fs = {
      realpathSync: (p: string) => {
        if (p === "/x") return "/x";
        throw fault("ENOENT");
      },
      readlinkSync: (p: string) => (p === "/x/a.json" ? "b.json" : "a.json"),
    };
    expect(() => canonicalTablePath("/x/a.json", fs)).toThrow("is a symlink loop");
  });

  test("uses the injected realpathSync", () => {
    const seen: string[] = [];
    const fs = {
      realpathSync: (p: string) => {
        seen.push(p);
        if (p === "/x/t.json") throw fault("ENOENT");
        return "/real/x";
      },
    };
    expect(canonicalTablePath("/x/t.json", fs)).toBe("/real/x/t.json");
    expect(seen).toEqual(["/x/t.json", "/x"]);
  });
});

describe("readOrCreateTableId", () => {
  test("creates the file once and returns the same id later and through a symlink", async () => {
    const id = await readOrCreateTableId(table, lock);
    expect(id).toMatch(UUID);
    expect(await readFile(idPath, "utf8")).toBe(`${id}\n`);
    expect(await files()).toEqual(["table.json.table-id"]);
    expect(await readOrCreateTableId(table, lock)).toBe(id);

    await writeFile(table, "{}");
    const alias = join(dir, "alias.json");
    await symlink(table, alias);
    expect(await readOrCreateTableId(canonicalTablePath(alias), lock)).toBe(id);
  });

  test("reads an existing id written by a human", async () => {
    const id = "123e4567-e89b-12d3-a456-426614174000";
    await writeFile(idPath, `${id}\n`);
    expect(await readOrCreateTableId(table, lock)).toBe(id);
    await writeFile(idPath, id);
    expect(await readOrCreateTableId(table, lock)).toBe(id);
  });

  test("a lock for another path is rejected", async () => {
    const otherTable = join(dir, "other.json");
    const other = await acquireTableLock(otherTable);
    try {
      await expect(readOrCreateTableId(table, other)).rejects.toThrow(/lock/);
      expect(await files()).toEqual([]);
    } finally {
      await other.release();
    }
  });

  test("two concurrent calls, the first paused after its temp write, return the same id", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let paused!: () => void;
    const reachedPause = new Promise<void>((r) => {
      paused = r;
    });
    let opens = 0;
    const fs: TableFs = {
      ...nodeTableFs,
      async open(p, flags) {
        const handle = await nodeTableFs.open(p, flags);
        opens += 1;
        const first = opens === 1;
        return {
          writeFile: async (data, enc) => {
            await handle.writeFile(data, enc);
            if (first) {
              paused();
              await gate;
            }
          },
          sync: () => handle.sync(),
          close: () => handle.close(),
        };
      },
    };
    const a = readOrCreateTableId(table, lock, fs);
    let bDone = false;
    const b = readOrCreateTableId(table, lock, fs).then((id) => {
      bDone = true;
      return id;
    });
    await reachedPause;
    const temps = await files();
    expect(temps).toEqual([`table.json.table-id.tmp-${lock.nonce}`]);
    await new Promise((r) => setTimeout(r, 20));
    expect(bDone).toBe(false);
    release();
    const idA = await a;
    const idB = await b;
    expect(idB).toBe(idA);
    expect(opens).toBe(1);
    expect(await files()).toEqual(["table.json.table-id"]);
  });

  test("a failed call does not block the next one", async () => {
    const failing: TableFs = {
      ...nodeTableFs,
      rename: async () => {
        throw fault("EIO");
      },
    };
    const a = readOrCreateTableId(table, lock, failing);
    const b = readOrCreateTableId(table, lock);
    await expect(a).rejects.toMatchObject({ code: "EIO" });
    expect(await b).toMatch(UUID);
  });

  describe("a failure leaves neither an identity file nor a temp file", () => {
    test.each([
      [
        "write",
        (fs: TableFs): TableFs => ({
          ...fs,
          async open(p, flags) {
            const handle = await fs.open(p, flags);
            return {
              writeFile: async () => {
                throw fault("ENOSPC");
              },
              sync: () => handle.sync(),
              close: () => handle.close(),
            };
          },
        }),
        "ENOSPC",
      ],
      [
        "fsync",
        (fs: TableFs): TableFs => ({
          ...fs,
          async open(p, flags) {
            const handle = await fs.open(p, flags);
            return {
              writeFile: (d, e) => handle.writeFile(d, e),
              sync: async () => {
                throw fault("EIO");
              },
              close: () => handle.close(),
            };
          },
        }),
        "EIO",
      ],
      [
        "rename",
        (fs: TableFs): TableFs => ({
          ...fs,
          rename: async () => {
            throw fault("EXDEV");
          },
        }),
        "EXDEV",
      ],
    ])("the %s", async (_, wrap, code) => {
      await expect(readOrCreateTableId(table, lock, wrap(nodeTableFs))).rejects.toMatchObject({
        code,
      });
      expect(await files()).toEqual([]);
    });
  });

  test.each([
    ["empty", ""],
    ["a blank line", "\n"],
    ["not a UUID", "hello\n"],
    ["two lines", "123e4567-e89b-12d3-a456-426614174000\n123e4567-e89b-12d3-a456-426614174000\n"],
    ["padded", " 123e4567-e89b-12d3-a456-426614174000\n"],
  ])(
    "an identity file that is %s throws TableIdentityError and is left unchanged",
    async (_, content) => {
      await writeFile(idPath, content);
      let error: unknown;
      try {
        await readOrCreateTableId(table, lock);
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(TableIdentityError);
      const identityError = error as TableIdentityError;
      expect(identityError.path).toBe(idPath);
      expect(identityError.content).toBe(content);
      expect(identityError.message).toContain(idPath);
      expect(await readFile(idPath, "utf8")).toBe(content);
      expect(await files()).toEqual(["table.json.table-id"]);
    },
  );

  test("a read error other than ENOENT is rethrown and nothing is written", async () => {
    const fs: TableFs = {
      ...nodeTableFs,
      readFile: async () => {
        throw fault("EACCES");
      },
    };
    await expect(readOrCreateTableId(table, lock, fs)).rejects.toMatchObject({ code: "EACCES" });
    expect(await files()).toEqual([]);
  });
});
