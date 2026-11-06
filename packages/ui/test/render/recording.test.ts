// @vitest-environment node
import { type Ctx2D, RecordingContext } from "@vtt/ui";
import { describe, expect, test } from "vitest";

describe("RecordingContext", () => {
  test("a native 2D context is a Ctx2D", () => {
    const asCtx = (native: CanvasRenderingContext2D): Ctx2D => native;
    expect(typeof asCtx).toBe("function");
  });

  test("records calls with the current transform", () => {
    const ctx = new RecordingContext();
    ctx.setTransform(2, 0, 0, 2, 10, 20);
    ctx.translate(5, 5);
    ctx.fillRect(0, 0, 1, 1);
    const call = ctx.calls.at(-1);
    expect(call?.name).toBe("fillRect");
    expect(call?.args).toEqual([0, 0, 1, 1]);
    expect(call?.transform).toEqual([2, 0, 0, 2, 20, 30]);
    expect(call?.extent).toEqual({ minX: 20, minY: 30, maxX: 22, maxY: 32 });
  });

  test("save and restore bracket the transform, clip and styles", () => {
    const ctx = new RecordingContext();
    ctx.fillStyle = "red";
    ctx.save();
    ctx.fillStyle = "blue";
    ctx.translate(3, 4);
    ctx.beginPath();
    ctx.rect(0, 0, 10, 10);
    ctx.clip();
    expect(ctx.clipBounds).toEqual({ minX: 3, minY: 4, maxX: 13, maxY: 14 });
    ctx.restore();
    expect(ctx.fillStyle).toBe("red");
    expect(ctx.clipBounds).toBeNull();
    expect(ctx.getTransform()).toEqual([1, 0, 0, 1, 0, 0]);
  });

  test("fill extents are the path's device box cut by the clip", () => {
    const ctx = new RecordingContext();
    ctx.beginPath();
    ctx.rect(0, 0, 10, 10);
    ctx.clip();
    ctx.beginPath();
    ctx.arc(10, 10, 5, 0, Math.PI * 2);
    ctx.fill();
    expect(ctx.calls.at(-1)?.extent).toEqual({ minX: 5, minY: 5, maxX: 10, maxY: 10 });
    expect(ctx.calls.at(-1)?.clip).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 10 });
    ctx.beginPath();
    ctx.rect(20, 20, 5, 5);
    ctx.fill();
    expect(ctx.calls.at(-1)?.extent).toBeNull();
  });

  test("paint calls carry the style in effect", () => {
    const ctx = new RecordingContext();
    ctx.strokeStyle = "#123";
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 2]);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(10, 0);
    ctx.stroke();
    const call = ctx.paints.at(-1);
    expect(call?.style).toMatchObject({ strokeStyle: "#123", lineWidth: 2, lineDash: [4, 2] });
    expect(call?.extent).toEqual({ minX: -1, minY: -1, maxX: 11, maxY: 1 });
  });

  test("lineJoin and lineCap are recorded in the style and restored by restore", () => {
    const ctx = new RecordingContext();
    expect(ctx.lineJoin).toBe("miter");
    expect(ctx.lineCap).toBe("butt");
    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(10, 0);
    ctx.stroke();
    expect(ctx.paints.at(-1)?.style).toMatchObject({ lineJoin: "round", lineCap: "round" });
    ctx.restore();
    expect(ctx.lineJoin).toBe("miter");
    expect(ctx.lineCap).toBe("butt");
    ctx.stroke();
    expect(ctx.paints.at(-1)?.style).toMatchObject({ lineJoin: "miter", lineCap: "butt" });
  });

  test("transform multiplies onto the current transform and is recorded as one call", () => {
    const ctx = new RecordingContext();
    ctx.setTransform(2, 0, 0, 2, 10, 20);
    ctx.transform(0, 1, -1, 0, 3, 4);
    expect(ctx.getTransform()).toEqual([0, 2, -2, 0, 16, 28]);
    expect(ctx.calls.at(-1)).toMatchObject({ name: "transform", args: [0, 1, -1, 0, 3, 4] });
    expect(ctx.calls.at(-1)?.transform).toEqual([0, 2, -2, 0, 16, 28]);
  });

  test("roundRect adds its box to the path and is recorded with its radii", () => {
    const ctx = new RecordingContext();
    ctx.translate(5, 5);
    ctx.beginPath();
    ctx.roundRect(0, 0, 10, 4, 2);
    ctx.fill();
    expect(ctx.calls.find((c) => c.name === "roundRect")?.args).toEqual([0, 0, 10, 4, 2]);
    const fill = ctx.paints.at(-1);
    expect(fill?.path).toEqual(["roundRect"]);
    expect(fill?.extent).toEqual({ minX: 5, minY: 5, maxX: 15, maxY: 9 });
  });

  test("measureText is deterministic", () => {
    const ctx = new RecordingContext();
    ctx.font = "10px sans-serif";
    expect(ctx.measureText("abcd").width).toBe(24);
  });
});
