// Shared constructors for the value-semantics tests (not a test file itself).
import type { InkValue, RollValue, ViewerEntry, ViewersValue } from "@vtt/schema";

export function roll(total: number, expr = "1d20"): RollValue {
  return { type: "roll", expr, dice: [total], dropped: [], total };
}

export function viewers(...entries: ViewerEntry[]): ViewersValue {
  return { type: "viewers", viewers: entries };
}

export const INK: InkValue = {
  type: "ink",
  strokes: [
    [
      [0, 0],
      [1, 1],
    ],
  ],
};
