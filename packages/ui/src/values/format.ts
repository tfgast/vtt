/**
 * Display formatting of wire values (FORMULAS.md §2, §2.4; docs/PROTOCOL.md
 * §7.1–§7.3). Pure: no React, no session. `compact` is for the canvas and
 * tight rows; `full` is for the inspector.
 */
import type { WireResult, WireValue, WireViewers } from "@vtt/protocol";
import type { Shape } from "@vtt/schema";

export type FormatMode = "compact" | "full";

/** A display label for an object id, or null when there is none to show. */
export type RefLabel = (id: string) => string | null;

export interface FormatOptions {
  mode: FormatMode;
  refLabel: RefLabel;
}

export type FormatTone = "normal" | "muted" | "error" | "redacted";

export interface Formatted {
  text: string;
  tone: FormatTone;
}

/** Characters of text shown in compact mode, the ellipsis included. */
export const COMPACT_TEXT_LENGTH = 40;
/** List items shown in compact mode before `… +n`. */
export const COMPACT_LIST_ITEMS = 3;
/** Decimals shown in compact mode. */
export const COMPACT_DECIMALS = 4;

const ELLIPSIS = "…";
const HIDDEN = "hidden";

export function formatValue(v: WireResult, opts: FormatOptions): Formatted {
  switch (v.type) {
    case "empty":
      return { text: opts.mode === "compact" ? "" : "empty", tone: "muted" };
    case "error": {
      if (opts.mode === "compact") return { text: v.code, tone: "error" };
      let text: string = v.code;
      if (v.message) text += `: ${v.message}`;
      if (v.origin) text += ` (from ${v.origin.object}.${v.origin.cell})`;
      return { text, tone: "error" };
    }
    case "redacted":
      return { text: HIDDEN, tone: "redacted" };
    default:
      return { text: valueText(v, opts), tone: "normal" };
  }
}

/** The text of a value; `empty` inside a list or viewers reads `empty`. */
function valueText(v: WireValue, opts: FormatOptions): string {
  switch (v.type) {
    case "number":
      return formatNumber(v.value, opts.mode);
    case "text":
      return opts.mode === "compact" ? compactText(v.value) : v.value;
    case "boolean":
      return String(v.value);
    case "empty":
      return "empty";
    case "list":
      return formatList(v.items, opts);
    case "ref":
      return formatRef(v.object, opts);
    case "dice":
      return v.expr;
    case "roll": {
      const total = formatNumber(v.total, opts.mode);
      if (opts.mode === "compact") return total;
      const parts = [v.dice.join(", ")].filter((p) => p !== "");
      if (v.dropped.length > 0) parts.push(`dropped ${v.dropped.join(", ")}`);
      return parts.length > 0
        ? `${total} (${v.expr}: ${parts.join("; ")})`
        : `${total} (${v.expr})`;
    }
    case "viewers":
      return formatViewers(v, opts);
    case "ink":
      return "(ink)";
    case "shape":
      return formatShape(v.shape, opts.mode);
    case "redacted":
      return HIDDEN;
  }
}

function formatNumber(n: number, mode: FormatMode): string {
  if (mode === "full" || Number.isInteger(n) || !Number.isFinite(n)) return String(n);
  const fixed = n.toFixed(COMPACT_DECIMALS);
  if (fixed.includes("e")) return String(n);
  const trimmed = fixed.replace(/\.?0+$/, "");
  return trimmed === "-0" ? "0" : trimmed;
}

function compactText(s: string): string {
  const newline = s.search(/\r?\n|\r/);
  const firstLine = newline < 0 ? s : s.slice(0, newline);
  const chars = Array.from(firstLine);
  if (chars.length > COMPACT_TEXT_LENGTH) {
    return chars.slice(0, COMPACT_TEXT_LENGTH - 1).join("") + ELLIPSIS;
  }
  return newline < 0 ? firstLine : firstLine + ELLIPSIS;
}

function formatList(items: WireValue[], opts: FormatOptions): string {
  const capped = opts.mode === "compact" && items.length > COMPACT_LIST_ITEMS;
  const shown = capped ? items.slice(0, COMPACT_LIST_ITEMS) : items;
  const parts = shown.map((item) => valueText(item, opts));
  if (capped) parts.push(`${ELLIPSIS} +${items.length - COMPACT_LIST_ITEMS}`);
  return `[${parts.join(", ")}]`;
}

function formatRef(id: string, opts: FormatOptions): string {
  const label = opts.refLabel(id);
  if (label === null) return id;
  return opts.mode === "full" ? `${label} (${id})` : label;
}

function formatViewers(v: WireViewers, opts: FormatOptions): string {
  return v.viewers
    .map((entry) => {
      if (typeof entry === "string") return entry;
      return entry.type === "ref" ? formatRef(entry.object, opts) : HIDDEN;
    })
    .join(", ");
}

function formatShape(s: Shape, mode: FormatMode): string {
  switch (s.type) {
    case "rect":
      return `rect ${formatNumber(s.width, mode)}×${formatNumber(s.height, mode)}`;
    case "circle":
      return `circle r ${formatNumber(s.radius, mode)}`;
    case "polygon":
      return `polygon, ${s.points.length} points`;
  }
}
