/** Object ids (FIXTURES.md §2; the fixtures NameSchema pattern). */
export type ObjectId = string;

/** Letters, digits, and underscores, starting with a letter. */
export const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Whether `s` is syntactically an id. Reserved ids are not checked here. */
export function isIdSyntax(s: string): boolean {
  return ID_PATTERN.test(s);
}

/** Board ids share the one id namespace with objects (DESIGN.md §4.1). */
export type BoardId = string;

/** Words of the viewer encoding; never board or object ids (FIXTURES.md §1). */
export const RESERVED_IDS = ["gm", "all", "owner"] as const;

/** Whether `s` may name a board or an object: id syntax, and not reserved. */
export function isValidId(s: string): boolean {
  return ID_PATTERN.test(s) && !(RESERVED_IDS as readonly string[]).includes(s);
}
