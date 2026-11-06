/**
 * A recording 2D context for renderer tests (CLAUDE.md UI testing; M4-D13):
 * implements `Ctx2D`, draws nothing, and records every call with the
 * transform and clip in effect. Painting calls also carry the style in effect
 * and their extent: the device-pixel box they paint, cut by the clip (boxes,
 * not exact coverage: an arc counts as its bounding square).
 */
import type { Bounds } from "@vtt/schema";
import type { Ctx2D } from "./renderer";

/** A 2D affine transform `[a, b, c, d, e, f]` as in `setTransform`. */
export type Matrix = [number, number, number, number, number, number];

export interface RecordedStyle {
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  lineJoin: CanvasLineJoin;
  lineCap: CanvasLineCap;
  globalAlpha: number;
  lineDash: number[];
  font: string;
}

export interface RecordedCall {
  name: string;
  args: unknown[];
  transform: Matrix;
  /** The active clip's device box, or null when nothing is clipped. */
  clip: Bounds | null;
  /** Painting calls only: the device box painted after the clip; null when clipped away entirely. */
  extent?: Bounds | null;
  /** Painting calls only. */
  style?: RecordedStyle;
  /** `fill`, `stroke` and `clip` only: the path commands since `beginPath`. */
  path?: string[];
}

/** Calls that put pixels on the canvas (`clearRect` erases and is not one). */
export const PAINT_CALLS: ReadonlySet<string> = new Set([
  "fill",
  "stroke",
  "fillRect",
  "strokeRect",
  "fillText",
  "drawImage",
]);

interface State {
  transform: Matrix;
  clip: Bounds | null;
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineJoin: CanvasLineJoin;
  lineCap: CanvasLineCap;
  globalAlpha: number;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  lineDash: number[];
}

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const round = (n: number) => Math.round(n * 1e6) / 1e6 + 0;

function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function boxOf(points: [number, number][]): Bounds | null {
  if (points.length === 0) return null;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return {
    minX: round(Math.min(...xs)),
    minY: round(Math.min(...ys)),
    maxX: round(Math.max(...xs)),
    maxY: round(Math.max(...ys)),
  };
}

function intersect(a: Bounds | null, clip: Bounds | null): Bounds | null {
  if (a === null) return null;
  if (clip === null) return a;
  const b = {
    minX: Math.max(a.minX, clip.minX),
    minY: Math.max(a.minY, clip.minY),
    maxX: Math.min(a.maxX, clip.maxX),
    maxY: Math.min(a.maxY, clip.maxY),
  };
  return b.minX < b.maxX && b.minY < b.maxY ? b : null;
}

function expand(b: Bounds | null, by: number): Bounds | null {
  if (b === null) return null;
  return {
    minX: round(b.minX - by),
    minY: round(b.minY - by),
    maxX: round(b.maxX + by),
    maxY: round(b.maxY + by),
  };
}

export class RecordingContext implements Ctx2D {
  readonly canvas: { width: number; height: number };
  readonly calls: RecordedCall[] = [];
  #state: State = {
    transform: [...IDENTITY],
    clip: null,
    fillStyle: "#000000",
    strokeStyle: "#000000",
    lineWidth: 1,
    lineJoin: "miter",
    lineCap: "butt",
    globalAlpha: 1,
    font: "10px sans-serif",
    textAlign: "start",
    textBaseline: "alphabetic",
    lineDash: [],
  };
  #stack: State[] = [];
  #path: [number, number][] = [];
  #pathOps: string[] = [];

  constructor(size: { width?: number; height?: number } = {}) {
    this.canvas = { width: size.width ?? 300, height: size.height ?? 150 };
  }

  /** The painting calls, in order. */
  get paints(): RecordedCall[] {
    return this.calls.filter((c) => PAINT_CALLS.has(c.name));
  }

  /** The current transform. */
  getTransform(): Matrix {
    return [...this.#state.transform];
  }

  /** The active clip's device box, or null. */
  get clipBounds(): Bounds | null {
    return this.#state.clip === null ? null : { ...this.#state.clip };
  }

  get fillStyle() {
    return this.#state.fillStyle;
  }
  set fillStyle(v) {
    this.#state.fillStyle = v;
  }
  get strokeStyle() {
    return this.#state.strokeStyle;
  }
  set strokeStyle(v) {
    this.#state.strokeStyle = v;
  }
  get lineWidth() {
    return this.#state.lineWidth;
  }
  set lineWidth(v) {
    this.#state.lineWidth = v;
  }
  get lineJoin() {
    return this.#state.lineJoin;
  }
  set lineJoin(v) {
    this.#state.lineJoin = v;
  }
  get lineCap() {
    return this.#state.lineCap;
  }
  set lineCap(v) {
    this.#state.lineCap = v;
  }
  get globalAlpha() {
    return this.#state.globalAlpha;
  }
  set globalAlpha(v) {
    this.#state.globalAlpha = v;
  }
  get font() {
    return this.#state.font;
  }
  set font(v) {
    this.#state.font = v;
  }
  get textAlign() {
    return this.#state.textAlign;
  }
  set textAlign(v) {
    this.#state.textAlign = v;
  }
  get textBaseline() {
    return this.#state.textBaseline;
  }
  set textBaseline(v) {
    this.#state.textBaseline = v;
  }

  #record(name: string, args: unknown[], extra: Partial<RecordedCall> = {}): void {
    this.calls.push({
      name,
      args,
      transform: [...this.#state.transform],
      clip: this.#state.clip === null ? null : { ...this.#state.clip },
      ...extra,
    });
  }

  #style(): RecordedStyle {
    const s = this.#state;
    return {
      fillStyle: String(s.fillStyle),
      strokeStyle: String(s.strokeStyle),
      lineWidth: s.lineWidth,
      lineJoin: s.lineJoin,
      lineCap: s.lineCap,
      globalAlpha: s.globalAlpha,
      lineDash: [...s.lineDash],
      font: s.font,
    };
  }

  #paint(name: string, args: unknown[], box: Bounds | null, path?: string[]): void {
    const extra: Partial<RecordedCall> = {
      extent: intersect(box, this.#state.clip),
      style: this.#style(),
    };
    if (path) extra.path = path;
    this.#record(name, args, extra);
  }

  #rectBox(x: number, y: number, w: number, h: number): Bounds | null {
    const m = this.#state.transform;
    return boxOf([apply(m, x, y), apply(m, x + w, y), apply(m, x + w, y + h), apply(m, x, y + h)]);
  }

  /** Device pixels per user unit of the current transform. */
  #scale(): number {
    const [a, b, c, d] = this.#state.transform;
    return Math.sqrt(Math.abs(a * d - b * c));
  }

  #fontPx(): number {
    const match = /(\d+(?:\.\d+)?)px/.exec(this.#state.font);
    return match ? Number(match[1]) : 10;
  }

  save(): void {
    this.#record("save", []);
    this.#stack.push({ ...this.#state, transform: [...this.#state.transform] });
  }

  restore(): void {
    this.#record("restore", []);
    const top = this.#stack.pop();
    if (top) this.#state = top;
  }

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.#state.transform = [a, b, c, d, e, f];
    this.#record("setTransform", [a, b, c, d, e, f]);
  }

  transform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    const m = this.#state.transform;
    this.#state.transform = [
      m[0] * a + m[2] * b,
      m[1] * a + m[3] * b,
      m[0] * c + m[2] * d,
      m[1] * c + m[3] * d,
      ...apply(m, e, f),
    ];
    this.#record("transform", [a, b, c, d, e, f]);
  }

  translate(x: number, y: number): void {
    const m = this.#state.transform;
    this.#state.transform = [m[0], m[1], m[2], m[3], ...apply(m, x, y)];
    this.#record("translate", [x, y]);
  }

  rotate(angle: number): void {
    const [a, b, c, d, e, f] = this.#state.transform;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    this.#state.transform = [
      a * cos + c * sin,
      b * cos + d * sin,
      c * cos - a * sin,
      d * cos - b * sin,
      e,
      f,
    ];
    this.#record("rotate", [angle]);
  }

  scale(x: number, y: number): void {
    const [a, b, c, d, e, f] = this.#state.transform;
    this.#state.transform = [a * x, b * x, c * y, d * y, e, f];
    this.#record("scale", [x, y]);
  }

  beginPath(): void {
    this.#path = [];
    this.#pathOps = [];
    this.#record("beginPath", []);
  }

  closePath(): void {
    this.#pathOps.push("closePath");
    this.#record("closePath", []);
  }

  moveTo(x: number, y: number): void {
    this.#path.push(apply(this.#state.transform, x, y));
    this.#pathOps.push("moveTo");
    this.#record("moveTo", [x, y]);
  }

  lineTo(x: number, y: number): void {
    this.#path.push(apply(this.#state.transform, x, y));
    this.#pathOps.push("lineTo");
    this.#record("lineTo", [x, y]);
  }

  rect(x: number, y: number, w: number, h: number): void {
    const m = this.#state.transform;
    this.#path.push(apply(m, x, y), apply(m, x + w, y), apply(m, x + w, y + h), apply(m, x, y + h));
    this.#pathOps.push("rect");
    this.#record("rect", [x, y, w, h]);
  }

  /** Extent is the rect's box (rounded corners lie inside it). */
  roundRect(
    x: number,
    y: number,
    w: number,
    h: number,
    radii?: number | DOMPointInit | (number | DOMPointInit)[],
  ): void {
    const m = this.#state.transform;
    this.#path.push(apply(m, x, y), apply(m, x + w, y), apply(m, x + w, y + h), apply(m, x, y + h));
    this.#pathOps.push("roundRect");
    this.#record("roundRect", radii === undefined ? [x, y, w, h] : [x, y, w, h, radii]);
  }

  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void {
    const m = this.#state.transform;
    const r = radius;
    this.#path.push(
      apply(m, x - r, y - r),
      apply(m, x + r, y - r),
      apply(m, x + r, y + r),
      apply(m, x - r, y + r),
    );
    this.#pathOps.push("arc");
    this.#record("arc", [x, y, radius, startAngle, endAngle]);
  }

  fill(): void {
    this.#paint("fill", [], boxOf(this.#path), [...this.#pathOps]);
  }

  stroke(): void {
    const half = (this.#state.lineWidth * this.#scale()) / 2;
    this.#paint("stroke", [], expand(boxOf(this.#path), half), [...this.#pathOps]);
  }

  clip(): void {
    this.#state.clip = intersect(boxOf(this.#path), this.#state.clip) ?? {
      minX: 0,
      minY: 0,
      maxX: 0,
      maxY: 0,
    };
    this.#record("clip", [], { path: [...this.#pathOps] });
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    this.#paint("fillRect", [x, y, w, h], this.#rectBox(x, y, w, h));
  }

  strokeRect(x: number, y: number, w: number, h: number): void {
    const half = (this.#state.lineWidth * this.#scale()) / 2;
    this.#paint("strokeRect", [x, y, w, h], expand(this.#rectBox(x, y, w, h), half));
  }

  clearRect(x: number, y: number, w: number, h: number): void {
    this.#record("clearRect", [x, y, w, h]);
  }

  fillText(text: string, x: number, y: number): void {
    const width = this.measureText(text).width;
    const size = this.#fontPx();
    const align = this.#state.textAlign;
    const left =
      align === "center" ? x - width / 2 : align === "right" || align === "end" ? x - width : x;
    const base = this.#state.textBaseline;
    const top =
      base === "top" || base === "hanging" ? y : base === "middle" ? y - size / 2 : y - size;
    this.#paint("fillText", [text, x, y], this.#rectBox(left, top, width, size));
  }

  /** Deterministic: 0.6 em per character. */
  measureText(text: string): { width: number } {
    return { width: Array.from(text).length * this.#fontPx() * 0.6 };
  }

  drawImage(image: CanvasImageSource, dx: number, dy: number, dw: number, dh: number): void {
    this.#paint("drawImage", [image, dx, dy, dw, dh], this.#rectBox(dx, dy, dw, dh));
  }

  setLineDash(segments: number[]): void {
    this.#state.lineDash = [...segments];
    this.#record("setLineDash", [[...segments]]);
  }
}
