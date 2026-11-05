// @vitest-environment node
import { createFaceStateStore } from "@vtt/ui";
import { describe, expect, test, vi } from "vitest";

describe("FaceStateStore: expansion", () => {
  test("defaults follow the entries mode", () => {
    const s = createFaceStateStore();
    expect(s.isExpanded("a", "collapsed")).toBe(false);
    expect(s.isExpanded("a", "full")).toBe(true);
  });

  test("toggle flips from the default of either mode", () => {
    const s = createFaceStateStore();
    s.toggle("a");
    expect(s.isExpanded("a", "collapsed")).toBe(true);
    expect(s.isExpanded("a", "full")).toBe(false);
    s.toggle("a");
    expect(s.isExpanded("a", "collapsed")).toBe(false);
    expect(s.isExpanded("a", "full")).toBe(true);
  });

  test("expand and collapse are explicit; toggle flips them", () => {
    const s = createFaceStateStore();
    s.expand("a");
    expect(s.isExpanded("a", "collapsed")).toBe(true);
    expect(s.isExpanded("a", "full")).toBe(true);
    s.toggle("a");
    expect(s.isExpanded("a", "collapsed")).toBe(false);
    expect(s.isExpanded("a", "full")).toBe(false);
    s.collapse("b");
    expect(s.isExpanded("b", "full")).toBe(false);
    s.toggle("b");
    expect(s.isExpanded("b", "collapsed")).toBe(true);
  });
});

describe("FaceStateStore: scrolling", () => {
  test("offsets are per (object, element) and start at 0", () => {
    const s = createFaceStateStore();
    expect(s.scrollOffset("binder", 1)).toBe(0);
    s.setScroll("binder", 1, 2);
    expect(s.scrollOffset("binder", 1)).toBe(2);
    expect(s.scrollOffset("binder", 2)).toBe(0);
    expect(s.scrollOffset("other", 1)).toBe(0);
  });

  test("scrollBy adds, never below 0, and clamps to an optional maximum", () => {
    const s = createFaceStateStore();
    expect(s.scrollBy("b", 0, 0.5)).toBe(0.5);
    expect(s.scrollBy("b", 0, -2)).toBe(0);
    expect(s.scrollBy("b", 0, 5, 1.2)).toBe(1.2);
    expect(s.scrollOffset("b", 0)).toBe(1.2);
  });

  test("scrollBy starts from the stored offset clamped to the maximum", () => {
    const s = createFaceStateStore();
    s.setScroll("b", 0, 10);
    expect(s.scrollBy("b", 0, -0.5, 1.2)).toBeCloseTo(0.7);
  });

  test("setScroll clamps to [0, max]", () => {
    const s = createFaceStateStore();
    expect(s.setScroll("b", 0, -1)).toBe(0);
    expect(s.setScroll("b", 0, 9, 3)).toBe(3);
    expect(s.setScroll("b", 0, Number.NaN)).toBe(0);
  });
});

describe("FaceStateStore: subscribe", () => {
  test("listeners hear changes only, and can unsubscribe", () => {
    const s = createFaceStateStore();
    const fn = vi.fn();
    const off = s.subscribe(fn);
    s.toggle("a");
    s.expand("a");
    s.expand("a"); // already expanded
    s.setScroll("b", 0, 1);
    s.setScroll("b", 0, 1); // unchanged
    s.scrollBy("b", 0, -5);
    expect(fn).toHaveBeenCalledTimes(4);
    off();
    s.collapse("a");
    expect(fn).toHaveBeenCalledTimes(4);
  });
});
