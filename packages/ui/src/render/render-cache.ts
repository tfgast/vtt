/**
 * The per-item offscreen bitmap cache (DESIGN.md §7 Platform; M6-D37,
 * vtt-qf5.10). The Canvas2D renderer draws a cacheable item's body (its
 * shape or marker, face-down glyph and `drawItem` hook, the face) once into
 * an offscreen surface, with the frame's own camera at the frame's device
 * scale, and blits that surface 1:1 on later frames. An entry is redrawn
 * when its key changes: the key parts the renderer's `cacheKey` gives,
 * compared by reference, else structurally (`sameContent`) (by default the
 * draw item; for faces the item, its drawing and its frame transform), the
 * exact device scale (so `min_size` visibility, the persistent-text floor
 * and every fixed screen size are decided at the zoom hit testing uses: a
 * pan reuses the bitmap, a zoom redraws it), or the state of any image the
 * drawing asked for. The surface holds the item's cull box in its frame,
 * grown by the renderer's `cacheBounds` (a face's unclipped ink). Selection, hover, handles,
 * the face focus ring, labels and the hidden badge are never in a bitmap:
 * the renderer draws them live. Entries are evicted least recently used past
 * `maxBytes` (4 bytes per surface pixel).
 */
import type { Bounds, ObjectId } from "@vtt/schema";
import type { ImageCache } from "./image-cache";
import type { Ctx2D } from "./renderer";

/** An offscreen drawing surface: its 2D context and what `drawImage` takes to blit it. */
export interface RenderSurface {
  readonly ctx: Ctx2D;
  readonly image: CanvasImageSource;
}

/** Makes a `width` × `height` device-pixel surface, or null when none can be made. */
export type CreateSurface = (width: number, height: number) => RenderSurface | null;

export interface RenderCacheOptions {
  /**
   * The surface factory. Default: `OffscreenCanvas` when present, else a
   * detached `canvas` element, and only when the main context is a native
   * `CanvasRenderingContext2D`; over any other context (a test's
   * `RecordingContext`) there is no default and every item is drawn live.
   */
  createSurface?: CreateSurface;
  /** The cache's size cap in bytes (4 per surface pixel); default `RENDER_CACHE_MAX_BYTES`. */
  maxBytes?: number;
  /** An item whose surface would be wider or taller than this many device px is drawn live. */
  maxSidePx?: number;
}

export const RENDER_CACHE_MAX_BYTES = 256 * 1024 * 1024;
export const RENDER_CACHE_MAX_SIDE_PX = 4096;
/** Device-pixel margin around an item's raster box in its surface (strokes centred on the edge). */
export const RENDER_CACHE_PAD_PX = 2;

/** The default surface factory over `main`, or null when `main` is not a native context. */
export function defaultCreateSurface(main: Ctx2D): CreateSurface | null {
  if (typeof CanvasRenderingContext2D === "undefined") return null;
  if (!(main instanceof CanvasRenderingContext2D)) return null;
  if (typeof OffscreenCanvas !== "undefined") {
    return (width, height) => {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d");
      return ctx === null ? null : { ctx: ctx as unknown as Ctx2D, image: canvas };
    };
  }
  const doc = main.canvas.ownerDocument;
  return (width, height) => {
    const canvas = doc.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    return ctx === null ? null : { ctx, image: canvas };
  };
}

/** Draws an item's cached body into a surface context, with `images`. */
export type PaintBody = (ctx: Ctx2D, images: ImageCache) => void;

/** Where an item is and what its surface must hold. */
export interface CachePlacement {
  /** The item's board cull box. */
  cull: Bounds;
  anchor: readonly [number, number];
  /** Degrees clockwise. */
  rotation: number;
  /** More to hold, in the item's frame (origin at the anchor, rotated); null for nothing. */
  extra: Bounds | null;
}

type ImageResult = ReturnType<ImageCache["get"]>;

interface Entry {
  parts: readonly unknown[];
  /** Device px per board unit the bitmap was drawn at. */
  scale: number;
  dpr: number;
  surface: RenderSurface;
  width: number;
  height: number;
  /** The surface's top-left corner, in device px at `scale`, in the item's frame. */
  ox: number;
  oy: number;
  images: [string, ImageResult][];
  bytes: number;
}

/**
 * Structural equality over JSON-like values (plain objects, arrays,
 * primitives; `Object.is` for leaves), early-exiting: the cache's content
 * comparison when a key part is not the same reference as last frame.
 */
export function sameContent(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameContent(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  let n = 0;
  for (const k in ra) {
    if (!Object.hasOwn(ra, k)) continue;
    n++;
    if (!Object.hasOwn(rb, k) || !sameContent(ra[k], rb[k])) return false;
  }
  for (const k in rb) if (Object.hasOwn(rb, k)) n--;
  return n === 0;
}

export class RenderCache {
  readonly #create: CreateSurface;
  readonly #maxBytes: number;
  readonly #maxSide: number;
  /** In least-recently-used order. */
  readonly #entries = new Map<ObjectId, Entry>();
  #bytes = 0;

  constructor(create: CreateSurface, options: RenderCacheOptions = {}) {
    this.#create = create;
    this.#maxBytes = options.maxBytes ?? RENDER_CACHE_MAX_BYTES;
    this.#maxSide = options.maxSidePx ?? RENDER_CACHE_MAX_SIDE_PX;
  }

  stats(): { entries: number; bytes: number } {
    return { entries: this.#entries.size, bytes: this.#bytes };
  }

  clear(): void {
    this.#entries.clear();
    this.#bytes = 0;
  }

  /**
   * Blits `id`'s bitmap into `ctx` (whose current frame is the item's: origin
   * at its anchor, rotated), drawing it first with `paint` when the key
   * `parts`, the device scale or an image it used changed. Returns false,
   * drawing nothing, when the item is too large for a surface or none can be
   * made; the caller then draws it live.
   */
  draw(
    ctx: Ctx2D,
    id: ObjectId,
    parts: readonly unknown[],
    place: CachePlacement,
    deviceScale: number,
    dpr: number,
    images: ImageCache,
    paint: PaintBody,
  ): boolean {
    if (!(deviceScale > 0) || !Number.isFinite(deviceScale)) return false;
    const old = this.#entries.get(id);
    let entry =
      old !== undefined && this.#valid(old, parts, deviceScale, dpr, images) ? old : undefined;
    if (entry === undefined) {
      if (old !== undefined) this.#drop(id, old);
      entry = this.#rasterize(parts, place, deviceScale, dpr, images, paint, old);
      if (entry === undefined) return false;
      this.#store(id, entry);
    } else {
      this.#entries.delete(id);
      this.#entries.set(id, entry);
    }
    const b = entry.scale;
    ctx.drawImage(
      entry.surface.image,
      entry.ox / b,
      entry.oy / b,
      entry.width / b,
      entry.height / b,
    );
    return true;
  }

  #valid(
    entry: Entry,
    parts: readonly unknown[],
    scale: number,
    dpr: number,
    images: ImageCache,
  ): boolean {
    if (entry.scale !== scale || entry.dpr !== dpr) return false;
    if (entry.parts.length !== parts.length) return false;
    for (let i = 0; i < parts.length; i++) {
      if (!sameContent(parts[i], entry.parts[i])) return false;
    }
    for (const [path, result] of entry.images) if (images.get(path) !== result) return false;
    // Same content: keep the newer references for the next frame's fast path.
    entry.parts = parts;
    return true;
  }

  #rasterize(
    parts: readonly unknown[],
    place: CachePlacement,
    scale: number,
    dpr: number,
    images: ImageCache,
    paint: PaintBody,
    old: Entry | undefined,
  ): Entry | undefined {
    let local = localBox(place.cull, place.anchor, place.rotation);
    if (place.extra !== null) {
      const e = place.extra;
      local = {
        minX: Math.min(local.minX, e.minX),
        minY: Math.min(local.minY, e.minY),
        maxX: Math.max(local.maxX, e.maxX),
        maxY: Math.max(local.maxY, e.maxY),
      };
    }
    if (![local.minX, local.minY, local.maxX, local.maxY].every(Number.isFinite)) return undefined;
    const pad = RENDER_CACHE_PAD_PX * dpr;
    const ox = Math.floor(local.minX * scale - pad);
    const oy = Math.floor(local.minY * scale - pad);
    const width = Math.ceil(local.maxX * scale + pad) - ox;
    const height = Math.ceil(local.maxY * scale + pad) - oy;
    if (!(width > 0 && height > 0)) return undefined;
    if (width > this.#maxSide || height > this.#maxSide) return undefined;
    const bytes = width * height * 4;
    if (bytes > this.#maxBytes) return undefined;
    const surface =
      old !== undefined && old.width === width && old.height === height
        ? old.surface
        : this.#create(width, height);
    if (surface === null) return undefined;
    const sctx = surface.ctx;
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.clearRect(0, 0, width, height);
    sctx.setTransform(scale, 0, 0, scale, -ox, -oy);
    const used: [string, ImageResult][] = [];
    const recorder = Object.create(images) as ImageCache;
    recorder.get = (path: string) => {
      const result = images.get(path);
      used.push([path, result]);
      return result;
    };
    paint(sctx, recorder);
    return {
      parts,
      scale,
      dpr,
      surface,
      width,
      height,
      ox,
      oy,
      images: used,
      bytes,
    };
  }

  #store(id: ObjectId, entry: Entry): void {
    this.#entries.set(id, entry);
    this.#bytes += entry.bytes;
    for (const [oldest, e] of this.#entries) {
      if (this.#bytes <= this.#maxBytes || oldest === id) break;
      this.#drop(oldest, e);
    }
  }

  #drop(id: ObjectId, entry: Entry): void {
    this.#entries.delete(id);
    this.#bytes -= entry.bytes;
  }
}

/** The box, in an item's frame (origin at `anchor`, rotated by `rotation`°), holding board box `b`. */
function localBox(b: Bounds, anchor: readonly [number, number], rotation: number): Bounds {
  const t = (-rotation * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [x, y] of [
    [b.minX, b.minY],
    [b.maxX, b.minY],
    [b.maxX, b.maxY],
    [b.minX, b.maxY],
  ] as const) {
    const dx = x - anchor[0];
    const dy = y - anchor[1];
    const lx = dx * cos - dy * sin;
    const ly = dx * sin + dy * cos;
    minX = Math.min(minX, lx);
    minY = Math.min(minY, ly);
    maxX = Math.max(maxX, lx);
    maxY = Math.max(maxY, ly);
  }
  return { minX, minY, maxX, maxY };
}
