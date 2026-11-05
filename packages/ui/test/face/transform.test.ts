// @vitest-environment node
import {
  type Affine,
  aabb,
  apply,
  compose,
  IDENTITY,
  invert,
  itemTransform,
  rectToRect,
  rotate,
  scale,
  screenHeight,
  translate,
} from "@vtt/ui";
import { describe, expect, test } from "vitest";

const close = (a: readonly number[], b: readonly number[]) => {
  expect(a.length).toBe(b.length);
  a.forEach((x, i) => {
    expect(x).toBeCloseTo(b[i] as number, 9);
  });
};

describe("affine basics", () => {
  test("identity, translate, scale", () => {
    expect(apply(IDENTITY, [3, 4])).toEqual([3, 4]);
    expect(apply(translate(1, -2), [3, 4])).toEqual([4, 2]);
    expect(apply(scale(2), [3, 4])).toEqual([6, 8]);
  });

  test("rotate is clockwise on screen (y down) and exact at quarter turns", () => {
    expect(apply(rotate(90), [1, 0])).toEqual([0, 1]);
    expect(apply(rotate(180), [1, 0])).toEqual([-1, 0]);
    expect(apply(rotate(-90), [1, 0])).toEqual([0, -1]);
    close(apply(rotate(45), [1, 0]), [Math.SQRT1_2, Math.SQRT1_2]);
  });

  test("compose applies the inner transform first", () => {
    const m = compose(translate(10, 0), scale(2));
    expect(apply(m, [1, 1])).toEqual([12, 2]);
    const n = compose(scale(2), translate(10, 0));
    expect(apply(n, [1, 1])).toEqual([22, 2]);
  });

  test("compose takes any number of transforms, outermost first", () => {
    const m = compose(translate(1, 1), rotate(90), scale(3));
    expect(apply(m, [1, 0])).toEqual([1, 4]);
    expect(compose()).toEqual(IDENTITY);
  });

  test("invert undoes a transform", () => {
    const m: Affine = compose(translate(7, 3), rotate(30), scale(0.25));
    const p = apply(m, [2, -5]);
    close(apply(invert(m), p), [2, -5]);
    close(compose(m, invert(m)), IDENTITY);
  });

  test("invert of a singular transform throws", () => {
    expect(() => invert(scale(0))).toThrow();
  });
});

describe("rectToRect", () => {
  test("uniform scale (the smaller fit), top-left aligned", () => {
    // 6 × 0.6 into 5.4 × 0.6: width limits, scale 0.9.
    const m = rectToRect([0, 0, 6, 0.6], [0.6, 1.2, 5.4, 0.6]);
    close(apply(m, [0, 0]), [0.6, 1.2]);
    close(apply(m, [6, 0.6]), [0.6 + 5.4, 1.2 + 0.54]);
    // 2 × 4 into 10 × 2: height limits, scale 0.5.
    const n = rectToRect([-1, -2, 2, 4], [0, 0, 10, 2]);
    close(apply(n, [-1, -2]), [0, 0]);
    close(apply(n, [1, 2]), [1, 2]);
  });
});

describe("aabb", () => {
  test("of a rect under rotation and translation", () => {
    const b = aabb([-1, -0.5, 2, 1], compose(translate(5, 5), rotate(90)));
    close([b.minX, b.minY, b.maxX, b.maxY], [4.5, 4, 5.5, 6]);
  });
});

describe("screenHeight", () => {
  test("the rect's height in CSS px after the transform and the camera", () => {
    // PX_PER_UNIT 64: a 0.5-unit rect at zoom 1 is 32 px.
    expect(screenHeight([0, 0, 1, 0.5], IDENTITY, { x: 0, y: 0, zoom: 1 })).toBeCloseTo(32);
    expect(screenHeight([0, 0, 1, 0.5], scale(0.5), { x: 0, y: 0, zoom: 2 })).toBeCloseTo(32);
  });

  test("is unchanged by rotation", () => {
    const camera = { x: 0, y: 0, zoom: 1 };
    expect(screenHeight([0, 0, 3, 0.5], rotate(90), camera)).toBeCloseTo(32);
    expect(screenHeight([0, 0, 3, 0.5], rotate(37), camera)).toBeCloseTo(32);
  });
});

describe("itemTransform", () => {
  test("maps the object's frame to the board: anchor then rotation", () => {
    const m = itemTransform({ anchor: [10, 20], rotation: 90 });
    expect(apply(m, [0, 0])).toEqual([10, 20]);
    expect(apply(m, [1, 0])).toEqual([10, 21]);
  });
});
