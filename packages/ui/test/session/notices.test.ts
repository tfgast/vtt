// @vitest-environment node
/**
 * The notice store (vtt-3l6.21; review r3 finding 14): one stickiness and
 * expiry policy. `info` and `success` expire after 6 s; `warning`, `error`
 * and every `stale` or `uncertain` notice stay until dismissed.
 */
import type { Timers } from "@vtt/protocol";
import { createNoticeStore, isStickyNotice, NOTICE_EXPIRY_MS } from "@vtt/ui";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/** A manual clock implementing `Timers`. */
function manualClock() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: Timers & { advance(ms: number): void; pending(): number } = {
    setTimeout(fn, ms) {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    advance(ms) {
      now += ms;
      for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now && timers.has(id)) {
          timers.delete(id);
          t.fn();
        }
      }
    },
    pending: () => timers.size,
  };
  return clock;
}

describe("with fake timers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("the expiry is 6 s", () => {
    expect(NOTICE_EXPIRY_MS).toBe(6000);
  });

  test.each(["info", "success"] as const)("%s notices expire after 6 s", (level) => {
    const store = createNoticeStore();
    const id = store.push({ level, text: "Done" });
    expect(store.list()).toEqual([{ id, level, text: "Done" }]);
    vi.advanceTimersByTime(5999);
    expect(store.list()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(store.list()).toEqual([]);
  });

  test.each(["warning", "error"] as const)("%s notices stay until dismissed", (level) => {
    const store = createNoticeStore();
    const id = store.push({ level, text: "Careful" });
    vi.advanceTimersByTime(10 * 60_000);
    expect(store.list().map((n) => n.id)).toEqual([id]);
    store.dismiss(id);
    expect(store.list()).toEqual([]);
  });

  test.each([
    ["info", "stale"],
    ["success", "uncertain"],
    ["warning", "stale"],
    ["error", "uncertain"],
  ] as const)("a %s notice of kind %s is sticky", (level, kind) => {
    const store = createNoticeStore();
    const id = store.push({ level, kind, text: "May or may not" });
    vi.advanceTimersByTime(60_000);
    expect(store.list()).toEqual([{ id, level, kind, text: "May or may not" }]);
  });

  test("dismissing an expiring notice early removes it and cancels its timer", () => {
    const store = createNoticeStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const id = store.push({ level: "info", text: "Hello" });
    expect(listener).toHaveBeenCalledTimes(1);
    store.dismiss(id);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(NOTICE_EXPIRY_MS);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("with an injected clock", () => {
  test("info expires on the injected clock only", () => {
    const clock = manualClock();
    const store = createNoticeStore({ timers: clock });
    store.push({ level: "info", text: "a" });
    store.push({ level: "error", text: "b" });
    expect(clock.pending()).toBe(1);
    clock.advance(NOTICE_EXPIRY_MS);
    expect(store.list().map((n) => n.text)).toEqual(["b"]);
  });

  test("listeners hear pushes, expiries and dismissals; list is stable between changes", () => {
    const clock = manualClock();
    const store = createNoticeStore({ timers: clock });
    const listener = vi.fn();
    const off = store.subscribe(listener);
    const before = store.list();
    expect(store.list()).toBe(before);
    const a = store.push({ level: "success", text: "Saved" });
    const b = store.push({ level: "warning", text: "Hmm" });
    expect(listener).toHaveBeenCalledTimes(2);
    const two = store.list();
    expect(store.list()).toBe(two);
    expect(two.map((n) => n.id)).toEqual([a, b]);
    expect(a).not.toBe(b);
    clock.advance(NOTICE_EXPIRY_MS);
    expect(listener).toHaveBeenCalledTimes(3);
    store.dismiss("no-such-id");
    expect(listener).toHaveBeenCalledTimes(3);
    off();
    store.dismiss(b);
    expect(listener).toHaveBeenCalledTimes(3);
    expect(store.list()).toEqual([]);
  });

  test("a throwing listener does not stop the others", () => {
    const store = createNoticeStore({ timers: manualClock() });
    const second = vi.fn();
    store.subscribe(() => {
      throw new Error("boom");
    });
    store.subscribe(second);
    store.push({ level: "error", text: "x" });
    expect(second).toHaveBeenCalledTimes(1);
  });
});

test("isStickyNotice is the one policy", () => {
  expect(isStickyNotice({ level: "info" })).toBe(false);
  expect(isStickyNotice({ level: "success" })).toBe(false);
  expect(isStickyNotice({ level: "warning" })).toBe(true);
  expect(isStickyNotice({ level: "error" })).toBe(true);
  expect(isStickyNotice({ level: "info", kind: "stale" })).toBe(true);
  expect(isStickyNotice({ level: "success", kind: "uncertain" })).toBe(true);
});
