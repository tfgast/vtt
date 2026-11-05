/**
 * Opening the served page in a browser (PROTOCOL.md §2 "Opening a browser
 * (M6-D5)"; DESIGN.md §7 Platform). `$BROWSER`, when non-empty, names an
 * executable called with the URL as its only argument (no shell); else the
 * opener is `open` on macOS and `xdg-open` elsewhere. Windows is out of
 * scope. The opener is spawned detached with its stdio ignored and unref'd,
 * so it never holds the server's event loop or terminal.
 */
/// <reference types="node" />
import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from "node:child_process";

/** `child_process.spawn`'s shape as `openBrowser` uses it (injectable for tests). */
export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface OpenBrowserOptions {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** Default: `child_process.spawn`. */
  spawn?: SpawnLike;
  /** How long a non-zero exit still counts as a failure (default 2000 ms). */
  timeoutMs?: number;
}

export type OpenBrowserResult = { ok: true } | { ok: false; message: string };

/** The default wait for an opener's failure. */
export const OPEN_BROWSER_TIMEOUT_MS = 2000;

/** The opener for `env` and `platform`, or null on an unsupported platform (`win32`). */
export function browserCommand(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  if (platform === "win32") return null;
  const browser = env.BROWSER;
  if (browser !== undefined && browser !== "") return browser;
  return platform === "darwin" ? "open" : "xdg-open";
}

/**
 * Opens `url`. Resolves `ok: false` on a spawn error (e.g. `ENOENT`), a
 * non-zero exit or death by a signal within the wait, or an unsupported
 * platform; `ok: true` on a zero exit or when the opener is still running at
 * the end of the wait (a browser run directly). Never throws or rejects.
 */
export function openBrowser(url: string, options: OpenBrowserOptions): Promise<OpenBrowserResult> {
  const command = browserCommand(options.env, options.platform);
  if (command === null) {
    return Promise.resolve({ ok: false, message: `unsupported platform ${options.platform}` });
  }
  const spawn = options.spawn ?? nodeSpawn;
  const timeoutMs = options.timeoutMs ?? OPEN_BROWSER_TIMEOUT_MS;
  return new Promise<OpenBrowserResult>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const settle = (result: OpenBrowserResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let child: ChildProcess;
    try {
      child = spawn(command, [url], { detached: true, stdio: "ignore", shell: false });
    } catch (err) {
      settle({ ok: false, message: err instanceof Error ? err.message : String(err) });
      return;
    }
    child.on("error", (err: Error) => settle({ ok: false, message: err.message }));
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (code === 0) settle({ ok: true });
      else if (code !== null) settle({ ok: false, message: `${command} exited with code ${code}` });
      else settle({ ok: false, message: `${command} was killed by ${signal ?? "a signal"}` });
    });
    try {
      child.unref();
    } catch {
      // A child without unref (a test double) is still fine.
    }
    timer = setTimeout(() => settle({ ok: true }), timeoutMs);
  });
}
