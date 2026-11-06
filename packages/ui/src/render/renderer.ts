/**
 * The renderer interface (DESIGN.md §7 Platform): the scene is drawn behind a
 * small interface so the Canvas2D implementation can be swapped (PixiJS is the
 * known upgrade). Objects are never DOM nodes.
 */
import type { Viewport } from "../interaction/contracts";
import type { ToolOverlay } from "../interaction/overlays";
import type { Camera } from "../scene/camera";
import type { Scene } from "../scene/scene";

/**
 * Draws one frame: scene items, object-related overlays (the scene's and the
 * object kinds of `toolOverlays`), covers, then chrome overlays only
 * (DESIGN.md §4.6; M4-D16). `viewport` is in CSS pixels with the device pixel
 * ratio. Generic in the scene so a hook can take an extended scene (M5).
 */
export interface Renderer<S extends Scene = Scene> {
  render(scene: S, toolOverlays: readonly ToolOverlay[], camera: Camera, viewport: Viewport): void;
  dispose(): void;
}

/**
 * The subset of `CanvasRenderingContext2D` the renderer uses. A native
 * context is a `Ctx2D`; `RecordingContext` implements it for tests. `canvas`
 * is resized by the renderer to the viewport times the device pixel ratio.
 */
export interface Ctx2D {
  readonly canvas: { width: number; height: number };
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineJoin: CanvasLineJoin;
  lineCap: CanvasLineCap;
  globalAlpha: number;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  save(): void;
  restore(): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  transform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  translate(x: number, y: number): void;
  rotate(angle: number): void;
  scale(x: number, y: number): void;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  roundRect(
    x: number,
    y: number,
    w: number,
    h: number,
    radii?: number | DOMPointInit | (number | DOMPointInit)[],
  ): void;
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void;
  fill(): void;
  stroke(): void;
  clip(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
  drawImage(image: CanvasImageSource, dx: number, dy: number, dw: number, dh: number): void;
  setLineDash(segments: number[]): void;
}
