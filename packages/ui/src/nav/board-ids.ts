/**
 * Board ids chosen in the UI (vtt-3l6.10; DESIGN.md §4.1 one id namespace
 * for boards and objects, §4.3 ids reserved for the document's lifetime;
 * PROTOCOL.md §5 `add_board`, §10 `invalid`). Pure.
 *
 * The client knows the live boards and objects but not retired ids, so an
 * `add_board` can still be refused `invalid` "… is reserved"; the caller
 * then tries the next suffix, at most `BOARD_ID_RETRIES` times.
 */
import type { ProtocolRejection } from "@vtt/protocol";
import { RESERVED_IDS } from "@vtt/schema";

/** How many further suffixes an add tries after a reserved-id refusal. */
export const BOARD_ID_RETRIES = 5;

const ID_CHAR = /[a-z0-9_]/;
const LETTER = /^[a-z]/;

/**
 * The id a board named `name` would get before suffixing: the trimmed name
 * lowercased, every non-id character (per code point) replaced by `_`, and
 * `b_` prefixed when it does not start with a letter.
 */
export function boardIdBase(name: string): string {
  const mapped = Array.from(name.trim().toLowerCase(), (c) => (ID_CHAR.test(c) ? c : "_")).join("");
  return LETTER.test(mapped) ? mapped : `b_${mapped}`;
}

/**
 * A board id for `name` that is not in `existing` and is not a word of the
 * viewer encoding (`gm`, `all`, `owner`): `boardIdBase(name)`, else with
 * `_2`, `_3` … appended.
 */
export function boardIdFor(name: string, existing: Iterable<string>): string {
  const taken = new Set<string>(existing);
  for (const word of RESERVED_IDS) taken.add(word);
  const base = boardIdBase(name);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}_${n}`;
    if (!taken.has(id)) return id;
  }
}

/** Whether `rejection` is the `invalid` refusal of an id that is reserved (live or retired). */
export function isReservedIdRejection(rejection: ProtocolRejection): boolean {
  return rejection.type === "invalid" && /\bis reserved\b/.test(rejection.message);
}
