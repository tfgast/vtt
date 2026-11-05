/**
 * `sessionCredentials()` (vtt-5su.17; PROTOCOL.md §2, Discovery): the
 * discovery reader `vtt-mcp` hands to `enableRecovery`.
 */
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionCredentials, sessionFilePath, writeSessionFile } from "@vtt/authority";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

let dir: string;
let saved: string | undefined;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "vtt-discovery-")));
  saved = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(dir, "config");
});

afterEach(async () => {
  if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = saved;
  await rm(dir, { recursive: true, force: true });
});

const INFO = {
  url: "ws://127.0.0.1:4747/ws",
  token: "tok-1",
  pid: 4242,
  table_path: "/tables/crypt.table.json",
  table_id: "8d6f2c1e-4b0a-4c55-9f3e-0a1b2c3d4e5f",
};

describe("sessionCredentials", () => {
  test("returns null while the session file is missing", async () => {
    const read = sessionCredentials();
    expect(await read()).toBeNull();
  });

  test("returns the file's url, token, table_path and table_id (not its pid)", async () => {
    writeSessionFile(INFO);
    const read = sessionCredentials();
    expect(await read()).toEqual({
      url: INFO.url,
      token: INFO.token,
      table_path: INFO.table_path,
      table_id: INFO.table_id,
    });
  });

  test("re-reads the file on every call", async () => {
    const read = sessionCredentials();
    expect(await read()).toBeNull();
    writeSessionFile(INFO);
    expect((await read())?.token).toBe("tok-1");
    writeSessionFile({ ...INFO, token: "tok-2", url: "ws://127.0.0.1:4848/ws" });
    expect(await read()).toMatchObject({ token: "tok-2", url: "ws://127.0.0.1:4848/ws" });
  });

  test("returns null for an invalid file", async () => {
    writeSessionFile(INFO);
    await writeFile(sessionFilePath(), "{not json");
    expect(await sessionCredentials()()).toBeNull();
    await writeFile(sessionFilePath(), JSON.stringify({ ...INFO, token: 7 }));
    expect(await sessionCredentials()()).toBeNull();
  });

  test("reads an explicit path when given one", async () => {
    const path = join(dir, "elsewhere", "session.json");
    writeSessionFile({ ...INFO, token: "tok-path" }, path);
    expect((await sessionCredentials(path)())?.token).toBe("tok-path");
    expect(await sessionCredentials()()).toBeNull();
  });
});
