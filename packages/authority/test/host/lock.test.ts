import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireTableLock,
  canonicalTablePath,
  type FileHandleLike,
  type LockInfo,
  nodeTableFs,
  removeTableLock,
  type TableFs,
  type TableLock,
  TableLockedError,
} from "@vtt/authority";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

let dir: string;
let table: string;
let lockPath: string;
const held: TableLock[] = [];

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "vtt-lock-")));
  table = join(dir, "table.json");
  lockPath = `${table}.lock`;
});

afterEach(async () => {
  for (const lock of held.splice(0)) await lock.release();
  await rm(dir, { recursive: true, force: true });
});

async function acquire(path: string, opts?: Parameters<typeof acquireTableLock>[1]) {
  const lock = await acquireTableLock(path, opts);
  held.push(lock);
  return lock;
}

const fault = (code: string): Error => Object.assign(new Error(`injected ${code}`), { code });

async function lockedError(promise: Promise<unknown>): Promise<TableLockedError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(TableLockedError);
    return err as TableLockedError;
  }
  throw new Error("expected TableLockedError");
}

const readLock = async (): Promise<LockInfo> => JSON.parse(await readFile(lockPath, "utf8"));

/** The pid of a node child that has already exited. */
async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  await new Promise((resolve) => child.on("exit", resolve));
  if (pid === undefined) throw new Error("no pid");
  return pid;
}

/** nodeTableFs with the lock handle (the `"wx"` open) patched. */
function withHandle(patch: Partial<FileHandleLike>): TableFs {
  return {
    ...nodeTableFs,
    async open(p, flags) {
      const handle = await nodeTableFs.open(p, flags);
      return {
        writeFile: patch.writeFile ?? ((data, enc) => handle.writeFile(data, enc)),
        sync: patch.sync ?? (() => handle.sync()),
        close: patch.close
          ? async () => {
              await handle.close();
              await patch.close?.();
            }
          : () => handle.close(),
      };
    },
  };
}

describe("acquireTableLock", () => {
  test("a free lock writes {pid, nonce, host, started}", async () => {
    const before = Date.now();
    const lock = await acquire(table);
    expect(lock.path).toBe(lockPath);
    const info = await readLock();
    expect(Object.keys(info).sort()).toEqual(["host", "nonce", "pid", "started"]);
    expect(info.pid).toBe(process.pid);
    expect(info.nonce).toBe(lock.nonce);
    expect(info.nonce.length).toBeGreaterThanOrEqual(16);
    expect(info.host).toBe(hostname());
    expect(new Date(info.started).toISOString()).toBe(info.started);
    expect(Date.parse(info.started)).toBeGreaterThanOrEqual(before - 1000);
  });

  test("each lock gets a fresh nonce", async () => {
    const a = await acquireTableLock(table);
    await a.release();
    const b = await acquire(table);
    expect(b.nonce).not.toBe(a.nonce);
  });

  test("a held lock refuses a second acquirer with the recorded info, stale: false", async () => {
    const lock = await acquire(table);
    const err = await lockedError(acquireTableLock(table));
    expect(err.stale).toBe(false);
    expect(err.info).toEqual({
      pid: process.pid,
      nonce: lock.nonce,
      host: hostname(),
      started: (await readLock()).started,
    });
    expect(err.message).toContain(lockPath);
  });

  test("two in-process acquirers started together: one lock, one non-stale refusal", async () => {
    const results = await Promise.allSettled([acquireTableLock(table), acquireTableLock(table)]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    held.push((won[0] as PromiseFulfilledResult<TableLock>).value);
    const reason = (lost[0] as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(TableLockedError);
    expect((reason as TableLockedError).stale).toBe(false);
  });

  test("two child processes started together: one lock, one non-stale refusal", async () => {
    const lockModule = fileURLToPath(new URL("../../src/host/lock.ts", import.meta.url));
    const script = `
      const { acquireTableLock } = await import(${JSON.stringify(lockModule)});
      let lock = null;
      let buf = "";
      process.stdout.write("ready\\n");
      process.stdin.on("data", async (chunk) => {
        buf += chunk;
        if (buf.includes("go\\n") && !buf.includes("done")) {
          buf += "done";
          try {
            lock = await acquireTableLock(${JSON.stringify(table)});
            process.stdout.write(JSON.stringify({ ok: true }) + "\\n");
          } catch (err) {
            process.stdout.write(JSON.stringify({ ok: false, name: err.name, stale: err.stale, info: err.info }) + "\\n");
          }
        }
      });
      process.stdin.on("end", async () => {
        if (lock) await lock.release();
        process.exit(0);
      });
    `;
    const children = [0, 1].map(() => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
        stdio: ["pipe", "pipe", "inherit"],
      });
      const lines: string[] = [];
      let pending = "";
      const waiters: (() => void)[] = [];
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        pending += chunk;
        let i = pending.indexOf("\n");
        while (i >= 0) {
          lines.push(pending.slice(0, i));
          pending = pending.slice(i + 1);
          i = pending.indexOf("\n");
        }
        for (const w of waiters.splice(0)) w();
      });
      const exited = new Promise((resolve) => child.on("exit", resolve));
      const line = async (n: number): Promise<string> => {
        while (lines.length <= n) await new Promise<void>((r) => waiters.push(r));
        return lines[n] as string;
      };
      return { child, line, exited };
    });
    for (const c of children) expect(await c.line(0)).toBe("ready");
    for (const c of children) c.child.stdin.write("go\n");
    const results = await Promise.all(children.map(async (c) => JSON.parse(await c.line(1))));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const lost = results.filter((r) => !r.ok);
    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatchObject({ name: "TableLockedError", stale: false });
    // The loser may read the winner's file before its content is written: then info is null.
    if (lost[0].info !== null) expect(lost[0].info.host).toBe(hostname());
    for (const c of children) c.child.stdin.end();
    await Promise.all(children.map((c) => c.exited));
    expect(await readdir(dir)).toEqual([]);
  }, 20_000);

  test("a lock held by an exited process on this host refuses with stale: true and the info", async () => {
    const info: LockInfo = {
      pid: await exitedPid(),
      nonce: "dead-nonce",
      host: hostname(),
      started: "2026-01-01T00:00:00.000Z",
    };
    await writeFile(lockPath, JSON.stringify(info));
    const err = await lockedError(acquireTableLock(table));
    expect(err.stale).toBe(true);
    expect(err.info).toEqual(info);
    // Never taken over.
    expect(await readLock()).toEqual(info);

    expect(await removeTableLock(table)).toEqual(info);
    expect(await readdir(dir)).toEqual([]);
    const lock = await acquire(table);
    expect((await readLock()).nonce).toBe(lock.nonce);
  });

  test("isAlive is injectable and decides staleness on this host", async () => {
    const info: LockInfo = { pid: 4242, nonce: "n", host: "here", started: "s" };
    await writeFile(lockPath, JSON.stringify(info));
    const seen: number[] = [];
    const dead = await lockedError(
      acquireTableLock(table, {
        hostname: "here",
        isAlive: (pid) => {
          seen.push(pid);
          return false;
        },
      }),
    );
    expect(dead.stale).toBe(true);
    expect(seen).toEqual([4242]);
    const alive = await lockedError(
      acquireTableLock(table, { hostname: "here", isAlive: () => true }),
    );
    expect(alive.stale).toBe(false);
  });

  test("a lock from another host refuses with stale: false", async () => {
    const info: LockInfo = {
      pid: await exitedPid(),
      nonce: "n",
      host: `${hostname()}-elsewhere`,
      started: "2026-01-01T00:00:00.000Z",
    };
    await writeFile(lockPath, JSON.stringify(info));
    const err = await lockedError(acquireTableLock(table, { isAlive: () => false }));
    expect(err.stale).toBe(false);
    expect(err.info).toEqual(info);
  });

  test.each([
    ["not JSON", "{oops"],
    ["empty", ""],
    ["missing fields", JSON.stringify({ pid: 1 })],
    ["wrong types", JSON.stringify({ pid: "1", nonce: "n", host: "h", started: "s" })],
    ["a non-integer pid", JSON.stringify({ pid: 1.5, nonce: "n", host: "h", started: "s" })],
    ["an array", "[]"],
  ])("a malformed lock file (%s) refuses with info: null, stale: false", async (_, content) => {
    await writeFile(lockPath, content);
    const err = await lockedError(acquireTableLock(table, { isAlive: () => false }));
    expect(err.info).toBeNull();
    expect(err.stale).toBe(false);
    expect(await readFile(lockPath, "utf8")).toBe(content);
  });

  test("an unreadable lock refuses with info: null, stale: false", async () => {
    await writeFile(lockPath, "x");
    const fs: TableFs = {
      ...nodeTableFs,
      readFile: async () => {
        throw fault("EACCES");
      },
    };
    const err = await lockedError(acquireTableLock(table, { fs }));
    expect(err.info).toBeNull();
    expect(err.stale).toBe(false);
  });

  test("an open error other than EEXIST is rethrown as is", async () => {
    const missing = join(dir, "no-such-dir", "table.json");
    await expect(acquireTableLock(missing)).rejects.toMatchObject({ code: "ENOENT" });
  });

  describe("a failure after the exclusive create rethrows and leaves no lock file", () => {
    test("the write", async () => {
      const fs = withHandle({
        writeFile: async () => {
          throw fault("ENOSPC");
        },
      });
      await expect(acquireTableLock(table, { fs })).rejects.toMatchObject({ code: "ENOSPC" });
      expect(await readdir(dir)).toEqual([]);
      await acquire(table);
    });

    test("a partial write", async () => {
      const fs: TableFs = {
        ...nodeTableFs,
        async open(p, flags) {
          const handle = await nodeTableFs.open(p, flags);
          return {
            writeFile: async (data, enc) => {
              await handle.writeFile(data.slice(0, 5), enc);
              throw fault("ENOSPC");
            },
            sync: () => handle.sync(),
            close: () => handle.close(),
          };
        },
      };
      await expect(acquireTableLock(table, { fs })).rejects.toMatchObject({ code: "ENOSPC" });
      expect(await readdir(dir)).toEqual([]);
    });

    test("the fsync", async () => {
      const fs = withHandle({
        sync: async () => {
          throw fault("EIO");
        },
      });
      await expect(acquireTableLock(table, { fs })).rejects.toMatchObject({ code: "EIO" });
      expect(await readdir(dir)).toEqual([]);
    });

    test("the close", async () => {
      const fs = withHandle({
        close: async () => {
          throw fault("EIO");
        },
      });
      await expect(acquireTableLock(table, { fs })).rejects.toMatchObject({ code: "EIO" });
      expect(await readdir(dir)).toEqual([]);
    });

    test("the write fails and the read-back is unreadable: still unlinked, original error", async () => {
      const fs: TableFs = {
        ...withHandle({
          writeFile: async () => {
            throw fault("ENOSPC");
          },
        }),
        readFile: async () => {
          throw fault("EACCES");
        },
      };
      await expect(acquireTableLock(table, { fs })).rejects.toMatchObject({ code: "ENOSPC" });
      expect(await readdir(dir)).toEqual([]);
    });

    test("a lock holding another nonce by the time of cleanup is left alone", async () => {
      const other: LockInfo = { pid: 1, nonce: "someone-else", host: "h", started: "s" };
      const fs = withHandle({
        sync: async () => {
          // Simulates a manual removal and another acquirer between create and cleanup.
          await rm(lockPath);
          await writeFile(lockPath, JSON.stringify(other));
          throw fault("EIO");
        },
      });
      await expect(acquireTableLock(table, { fs })).rejects.toMatchObject({ code: "EIO" });
      expect(await readLock()).toEqual(other);
    });
  });
});

describe("TableLock.release", () => {
  test("removes its own lock; a second release is harmless", async () => {
    const lock = await acquireTableLock(table);
    await lock.release();
    expect(await readdir(dir)).toEqual([]);
    await lock.release();
    await acquire(table);
  });

  test("concurrent releases are harmless", async () => {
    const lock = await acquireTableLock(table);
    await Promise.all([lock.release(), lock.release()]);
    expect(await readdir(dir)).toEqual([]);
  });

  test("a missing lock file is not an error", async () => {
    const lock = await acquireTableLock(table);
    await rm(lockPath);
    await expect(lock.release()).resolves.toBeUndefined();
  });

  test("does not unlink a new owner's lock after removal and re-acquire", async () => {
    const first = await acquireTableLock(table);
    expect(await removeTableLock(table)).toMatchObject({ nonce: first.nonce });
    const second = await acquire(table);
    await first.release();
    await first.release();
    expect((await readLock()).nonce).toBe(second.nonce);
    await expect(acquireTableLock(table)).rejects.toBeInstanceOf(TableLockedError);
  });

  test("an unreadable lock is reported, left in place, and a later release may retry", async () => {
    let failRead = true;
    const fs: TableFs = {
      ...nodeTableFs,
      readFile: async (p, enc) => {
        if (failRead) throw fault("EACCES");
        return nodeTableFs.readFile(p, enc);
      },
    };
    const lock = await acquireTableLock(table, { fs });
    await expect(lock.release()).rejects.toMatchObject({ code: "EACCES" });
    expect(await readdir(dir)).toEqual(["table.json.lock"]);
    failRead = false;
    await lock.release();
    expect(await readdir(dir)).toEqual([]);
  });

  test("leaves a lock file it cannot parse", async () => {
    const lock = await acquireTableLock(table);
    await writeFile(lockPath, "garbage");
    await lock.release();
    expect(await readFile(lockPath, "utf8")).toBe("garbage");
  });
});

describe("removeTableLock", () => {
  test("returns null when there is no lock", async () => {
    expect(await removeTableLock(table)).toBeNull();
  });

  test("removes a live lock unconditionally and returns its info", async () => {
    const lock = await acquireTableLock(table);
    const info = await readLock();
    expect(await removeTableLock(table)).toEqual(info);
    expect(info.nonce).toBe(lock.nonce);
    expect(await readdir(dir)).toEqual([]);
  });

  test("removes a malformed lock and returns null", async () => {
    await writeFile(lockPath, "{oops");
    expect(await removeTableLock(table)).toBeNull();
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("symlinked tables share one lock", () => {
  test("acquiring through a symlink while the real path is locked is refused", async () => {
    await writeFile(table, "{}");
    const alias = join(dir, "alias.json");
    await symlink(table, alias);
    expect(canonicalTablePath(alias)).toBe(table);
    await acquire(canonicalTablePath(table));
    const err = await lockedError(acquireTableLock(canonicalTablePath(alias)));
    expect(err.stale).toBe(false);
  });
});
