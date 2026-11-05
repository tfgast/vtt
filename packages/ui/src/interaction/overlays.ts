/**
 * Tool overlays (DESIGN.md §4.4, §4.6; M4-D16; review r1 findings 2 and 4):
 * what a tool draws besides the scene. Object-related kinds are drawn before
 * covers (a cover hides them); chrome kinds carry nothing about the table and
 * are the only things drawn after covers (vtt-3l6.6). All geometry is in
 * board units; sizes that are fixed on screen (handle squares, line widths)
 * are the renderer's.
 */
import type { Bounds, ObjectId, Point, Shape } from "@vtt/schema";

export const OBJECT_OVERLAY_KINDS = [
  "drag_ghost",
  "handles",
  "creation_preview",
  "polygon_draft",
] as const;
export const CHROME_OVERLAY_KINDS = ["marquee", "crosshair"] as const;

export type ObjectOverlayKind = (typeof OBJECT_OVERLAY_KINDS)[number];
export type ChromeOverlayKind = (typeof CHROME_OVERLAY_KINDS)[number];

/** One handle mark; `from` draws a stem from that point (the rotate handle's). */
export interface HandleMark {
  key: string;
  role: "resize" | "radius" | "vertex" | "rotate";
  at: Point;
  from?: Point;
}

/** Drawn before covers. */
export type ObjectToolOverlay =
  /** Where the dragged objects would land; `shape: null` is a shapeless marker. */
  | {
      kind: "drag_ghost";
      items: { id: ObjectId; anchor: Point; rotation: number; shape: Shape | null }[];
    }
  /** The handles of one object (vtt-3l6.9; M5 layout mode). */
  | { kind: "handles"; object: ObjectId; handles: HandleMark[] }
  /** The object or zone a creation tool would create (unrotated). */
  | { kind: "creation_preview"; anchor: Point; shape: Shape; zone: boolean }
  /**
   * An open polyline of world points with a rubber band to `cursor` (null:
   * none); `closing` marks that the next click closes it on the first point.
   */
  | { kind: "polygon_draft"; points: Point[]; cursor: Point | null; closing: boolean };

/** Viewer-independent chrome, drawn after covers. */
export type ChromeToolOverlay =
  | { kind: "marquee"; rect: Bounds }
  | { kind: "crosshair"; at: Point };

export type ToolOverlay = ObjectToolOverlay | ChromeToolOverlay;

const CHROME: ReadonlySet<string> = new Set(CHROME_OVERLAY_KINDS);

export function isChromeOverlay(overlay: ToolOverlay): overlay is ChromeToolOverlay {
  return CHROME.has(overlay.kind);
}

export function isObjectOverlay(overlay: ToolOverlay): overlay is ObjectToolOverlay {
  return !CHROME.has(overlay.kind);
}

/** The overlays split into the two drawing passes, each in the given order. */
export function splitOverlays(overlays: readonly ToolOverlay[]): {
  object: ObjectToolOverlay[];
  chrome: ChromeToolOverlay[];
} {
  const object: ObjectToolOverlay[] = [];
  const chrome: ChromeToolOverlay[] = [];
  for (const o of overlays) {
    if (isChromeOverlay(o)) chrome.push(o);
    else object.push(o);
  }
  return { object, chrome };
}
