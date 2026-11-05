// @vitest-environment node
/**
 * `openBrowser` (vtt-nb8.4; PROTOCOL.md §2 "Opening a browser (M6-D5)";
 * DESIGN.md §7 Platform): the command chosen from `$BROWSER` and the
 * platform, the spawn options, and every failure reported as `ok: false`
 * without throwing. An injected `spawn` keeps any real browser closed; one
 * test spawns a real missing executable for the `ENOENT` path.
 */
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { browserCommand, openBrowser, type SpawnLike } from "@vtt/authority";
import { describe, expect, test } from "vitest";

const URL_ = "http://127.0.0.1:4747/";

interface Call {
  command: string;
  args: readonly string[];
  options: SpawnOptions;
  child: FakeChild;
}

class FakeChild extends EventEmitter {
  unrefed = false;
  unref(): void {
    this.unrefed = true;
  }
}

/** A fake `spawn` recording each call; `behave` drives the fake child after the call. */
function fakeSpawn(behave: (child: FakeChild) => void = () => undefined): {
  spawn: SpawnLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  const spawn: SpawnLike = (command, args, options) => {
    const child = new FakeChild();
    calls.push({ command, args, options, child });
    behave(child);
    return child as unknown as ChildProcess;
  };
  return { spawn, calls };
}

const exitsWith = (code: number) => (child: FakeChild) => {
  setTimeout(() => child.emit("exit", code, null), 5);
};

describe("browserCommand", () => {
  test("$BROWSER when non-empty, else open on darwin, else xdg-open; win32 has none", () => {
    expect(browserCommand({ BROWSER: "/usr/bin/firefox" }, "linux")).toBe("/usr/bin/firefox");
    expect(browserCommand({ BROWSER: "/usr/bin/firefox" }, "darwin")).toBe("/usr/bin/firefox");
    expect(browserCommand({ BROWSER: "" }, "darwin")).toBe("open");
    expect(browserCommand({}, "darwin")).toBe("open");
    expect(browserCommand({}, "linux")).toBe("xdg-open");
    expect(browserCommand({}, "freebsd")).toBe("xdg-open");
    expect(browserCommand({}, "win32")).toBeNull();
    expect(browserCommand({ BROWSER: "chrome.exe" }, "win32")).toBeNull();
  });
});

describe("openBrowser", () => {
  test("$BROWSER is spawned with the URL as its only argument, detached, no shell, stdio ignored, unref'd", async () => {
    const { spawn, calls } = fakeSpawn(exitsWith(0));
    const result = await openBrowser(URL_, {
      env: { BROWSER: "/opt/my browser" },
      platform: "linux",
      spawn,
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    const call = calls[0] as Call;
    expect(call.command).toBe("/opt/my browser");
    expect(call.args).toEqual([URL_]);
    expect(call.options.detached).toBe(true);
    expect(call.options.stdio).toBe("ignore");
    expect(call.options.shell).toBeFalsy();
    expect(call.child.unrefed).toBe(true);
  });

  test("darwin without $BROWSER runs open <url>", async () => {
    const { spawn, calls } = fakeSpawn(exitsWith(0));
    expect(await openBrowser(URL_, { env: {}, platform: "darwin", spawn })).toEqual({ ok: true });
    expect(calls.map((c) => [c.command, ...c.args])).toEqual([["open", URL_]]);
  });

  test("linux with an empty $BROWSER runs xdg-open <url>", async () => {
    const { spawn, calls } = fakeSpawn(exitsWith(0));
    expect(await openBrowser(URL_, { env: { BROWSER: "" }, platform: "linux", spawn })).toEqual({
      ok: true,
    });
    expect(calls.map((c) => [c.command, ...c.args])).toEqual([["xdg-open", URL_]]);
  });

  test("a browser still running after the wait counts as opened", async () => {
    const { spawn } = fakeSpawn();
    const result = await openBrowser(URL_, {
      env: {},
      platform: "linux",
      spawn,
      timeoutMs: 20,
    });
    expect(result).toEqual({ ok: true });
  });

  test("a spawn error (ENOENT) is ok: false with its message", async () => {
    const { spawn } = fakeSpawn((child) => {
      setTimeout(() => {
        const err = Object.assign(new Error("spawn xdg-open ENOENT"), { code: "ENOENT" });
        child.emit("error", err);
      }, 5);
    });
    const result = await openBrowser(URL_, { env: {}, platform: "linux", spawn });
    expect(result).toEqual({ ok: false, message: "spawn xdg-open ENOENT" });
  });

  test("a real missing executable is ok: false (ENOENT)", async () => {
    const result = await openBrowser(URL_, {
      env: { BROWSER: "/nonexistent/vtt-browser" },
      platform: process.platform === "win32" ? "linux" : process.platform,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/ENOENT/);
  });

  test("a non-zero exit within the wait is ok: false naming the code", async () => {
    const { spawn } = fakeSpawn(exitsWith(3));
    const result = await openBrowser(URL_, { env: {}, platform: "darwin", spawn });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/open exited with code 3/);
  });

  test("death by a signal within the wait is ok: false", async () => {
    const { spawn } = fakeSpawn((child) => {
      setTimeout(() => child.emit("exit", null, "SIGKILL"), 5);
    });
    const result = await openBrowser(URL_, { env: {}, platform: "linux", spawn });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/SIGKILL/);
  });

  test("win32 is ok: false with unsupported platform, spawning nothing", async () => {
    const { spawn, calls } = fakeSpawn(exitsWith(0));
    const result = await openBrowser(URL_, { env: {}, platform: "win32", spawn });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/unsupported platform/);
    expect(calls).toHaveLength(0);
  });

  test("never throws: a spawn that throws synchronously is ok: false", async () => {
    const spawn: SpawnLike = () => {
      throw new TypeError("bad argument");
    };
    await expect(openBrowser(URL_, { env: {}, platform: "linux", spawn })).resolves.toEqual({
      ok: false,
      message: "bad argument",
    });
  });
});
