import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  readSessionFile,
  removeSessionFile,
  type SessionInfo,
  sessionFilePath,
  writeSessionFile,
} from "@vtt/authority";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

let config: string;

const info = (over: Partial<SessionInfo> = {}): SessionInfo => ({
  url: "ws://127.0.0.1:4747/ws",
  token: "tok",
  pid: 12345,
  table_path: "/tmp/a.table.json",
  table_id: "0b3c5f1e-7a2d-4c1b-9e8f-1a2b3c4d5e6f",
  ...over,
});

beforeEach(() => {
  config = mkdtempSync(join(tmpdir(), "vtt-session-"));
  vi.stubEnv("XDG_CONFIG_HOME", config);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(config, { recursive: true, force: true });
});

describe("sessionFilePath", () => {
  test("is $XDG_CONFIG_HOME/vtt/session.json", () => {
    expect(sessionFilePath()).toBe(join(config, "vtt", "session.json"));
  });

  test("defaults to ~/.config/vtt/session.json when XDG_CONFIG_HOME is unset or empty", () => {
    vi.stubEnv("XDG_CONFIG_HOME", undefined);
    expect(sessionFilePath()).toBe(join(homedir(), ".config", "vtt", "session.json"));
    vi.stubEnv("XDG_CONFIG_HOME", "");
    expect(sessionFilePath()).toBe(join(homedir(), ".config", "vtt", "session.json"));
  });

  test("ignores a relative XDG_CONFIG_HOME (XDG Base Directory spec)", () => {
    vi.stubEnv("XDG_CONFIG_HOME", "relative/dir");
    expect(sessionFilePath()).toBe(join(homedir(), ".config", "vtt", "session.json"));
  });
});

describe("writeSessionFile", () => {
  test("creates the directory 0700 and the file 0600 holding the five fields", () => {
    writeSessionFile(info());
    const dir = join(config, "vtt");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(sessionFilePath()).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(sessionFilePath(), "utf8"))).toEqual(info());
  });

  test("replaces an existing file and tightens an existing directory to 0700", () => {
    mkdirSync(join(config, "vtt"), { mode: 0o755 });
    writeSessionFile(info({ token: "first" }));
    writeSessionFile(info({ token: "second", pid: 99 }));
    expect(statSync(join(config, "vtt")).mode & 0o777).toBe(0o700);
    expect(statSync(sessionFilePath()).mode & 0o777).toBe(0o600);
    expect(readSessionFile()).toEqual(info({ token: "second", pid: 99 }));
  });

  test("leaves no temp file behind", () => {
    writeSessionFile(info());
    expect(readdirSync(join(config, "vtt"))).toEqual(["session.json"]);
  });
});

describe("readSessionFile", () => {
  test("returns what was written", () => {
    writeSessionFile(info());
    expect(readSessionFile()).toEqual(info());
  });

  test("returns null for a missing file", () => {
    expect(readSessionFile()).toBeNull();
  });

  test("returns null for a corrupt or incomplete file", () => {
    mkdirSync(join(config, "vtt"), { recursive: true });
    for (const text of [
      "",
      "{not json",
      "[]",
      "null",
      JSON.stringify({ ...info(), pid: "12" }),
      JSON.stringify({ ...info(), pid: 0 }),
      JSON.stringify({ url: "ws://x", token: "t", pid: 1, table_path: "/a" }),
      JSON.stringify({ ...info(), table_id: 7 }),
    ]) {
      writeFileSync(sessionFilePath(), text);
      expect(readSessionFile(), text).toBeNull();
    }
  });

  test("ignores unknown keys (additive extension)", () => {
    mkdirSync(join(config, "vtt"), { recursive: true });
    writeFileSync(sessionFilePath(), JSON.stringify({ ...info(), extra: true }));
    expect(readSessionFile()).toEqual(info());
  });
});

describe("removeSessionFile", () => {
  test("removes the file when its pid matches", () => {
    writeSessionFile(info({ pid: 42 }));
    expect(removeSessionFile(42)).toBe(true);
    expect(readSessionFile()).toBeNull();
  });

  test("leaves a file written by another pid", () => {
    writeSessionFile(info({ pid: 42 }));
    expect(removeSessionFile(43)).toBe(false);
    expect(readSessionFile()).toEqual(info({ pid: 42 }));
  });

  test("is a no-op for a missing or corrupt file", () => {
    expect(removeSessionFile(42)).toBe(false);
    mkdirSync(join(config, "vtt"), { recursive: true });
    writeFileSync(sessionFilePath(), "{corrupt");
    expect(removeSessionFile(42)).toBe(false);
    expect(readFileSync(sessionFilePath(), "utf8")).toBe("{corrupt");
  });
});
