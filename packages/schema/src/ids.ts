/** Object ids (FIXTURES.md §2; the fixtures NameSchema pattern). */
export type ObjectId = string;

/** Letters, digits, and underscores, starting with a letter. */
export const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Whether `s` is syntactically an id. Reserved ids are not checked here. */
export function isIdSyntax(s: string): boolean {
  return ID_PATTERN.test(s);
}
