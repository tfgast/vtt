/**
 * Number formatting on faces (FORMULAS.md §11; DESIGN.md §4.6 "Face
 * layouts"): a value or editor element's `style.format` rewrites the shown
 * text of a number value. It is presentation only: the cell's value, the
 * formula language and the in-place editor (which opens on the value) are
 * unchanged.
 */
import type { FaceNumberFormat } from "@vtt/schema";

/** Past this magnitude a scaled value carries no fraction; `toFixed` is exact enough. */
const EXACT = 2 ** 52;

/** `n` rounded to `places` decimals, half away from zero (as `round` in FORMULAS.md §4). */
function roundHalfAway(n: number, places: number): number {
  const scale = 10 ** places;
  const scaled = Math.abs(n) * scale;
  if (!Number.isFinite(scaled) || scaled >= EXACT) return n;
  return (Math.sign(n) * Math.round(scaled)) / scale;
}

/**
 * The face text of the number `n` under `format`, given `compact`, its text
 * without one. `decimals` writes exactly that many places, rounded half away
 * from zero (`2.5` at 2 is `2.50`, `-0.004` at 2 is `0.00`); without it the
 * compact text stands. `sign: "always"` prefixes `+` when the written number
 * is positive; zero (including a value that rounds to zero) and negatives
 * are unchanged. A non-finite number is left as `compact`.
 */
export function formatFaceNumber(
  n: number,
  compact: string,
  format: FaceNumberFormat | undefined,
): string {
  if (format === undefined || !Number.isFinite(n)) return compact;
  let text = compact;
  if (format.decimals !== undefined) {
    const rounded = roundHalfAway(n, format.decimals);
    // `toFixed` writes -0 as "0", so a negative that rounds to zero has no sign.
    text = rounded === 0 ? (0).toFixed(format.decimals) : rounded.toFixed(format.decimals);
  }
  if (format.sign === "always" && Number(text) > 0) text = `+${text}`;
  return text;
}
