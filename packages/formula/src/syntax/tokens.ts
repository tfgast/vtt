/** Token kinds produced by the lexer (FORMULAS.md §2–§4). */
export type TokenKind =
  /** `12`, `3.5`. `value` is the source text. */
  | "number"
  /** `"goblin"`. `value` is the decoded text, escapes resolved. */
  | "text"
  /** A bare identifier that is not a keyword. `value` is the identifier. */
  | "ident"
  /** A backtick name. `value` is the text between the backticks. */
  | "name"
  /** One of {@link KEYWORDS}. `value` is the keyword. */
  | "keyword"
  /** A dice literal. `value` is the raw source text, validated by the dice module. */
  | "dice"
  /** One of {@link PUNCTUATION}. `value` is the punctuation. */
  | "punct"
  /** End of input. `value` is empty; `start` and `end` are the source length. */
  | "eof";

export interface Token {
  readonly kind: TokenKind;
  readonly value: string;
  /** Offset of the first character. */
  readonly start: number;
  /** Offset one past the last character. */
  readonly end: number;
}

export const KEYWORDS = [
  "true",
  "false",
  "empty",
  "this",
  "it",
  "all",
  "gm",
  "and",
  "or",
  "not",
  "has",
] as const;

export type Keyword = (typeof KEYWORDS)[number];

/** Longest first, so the lexer can match greedily. */
export const PUNCTUATION = [
  "!=",
  "<=",
  ">=",
  "->",
  "+",
  "-",
  "*",
  "/",
  "%",
  "&",
  "=",
  "<",
  ">",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  ",",
  ".",
  ":",
] as const;

export type Punctuation = (typeof PUNCTUATION)[number];

const keywordSet: ReadonlySet<string> = new Set(KEYWORDS);

export function isKeyword(word: string): word is Keyword {
  return keywordSet.has(word);
}
