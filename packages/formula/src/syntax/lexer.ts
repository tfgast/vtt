import { isKeyword, PUNCTUATION, type Token } from "./tokens";

// Lexical rules (FORMULAS.md §2, §2.2, §3, §4):
//
// - Whitespace (space, tab, newline, carriage return) separates tokens and is
//   otherwise ignored. There are no comments.
// - Numbers: digits, or digits.digits. No exponent, no leading `.`, no
//   trailing `.`. A number immediately followed by an identifier character
//   ([A-Za-z0-9_]) is a syntax error: `2x`, `1e5`.
// - Text: double-quoted. The only escapes are `\"` and `\\`; any other
//   backslash sequence is an error. Literal newlines are allowed. Unterminated
//   text is an error reported at the opening quote.
// - Identifiers: [A-Za-z_][A-Za-z0-9_]*, case-sensitive. Backtick names
//   `...` (non-empty, no backtick inside) are always names, never keywords or
//   dice.
// - Keywords: true false empty this it all gm and or not has. `desc` and
//   `owner` are ordinary identifiers.
// - Dice literals: at a digit or `d`, try [0-9]*d([0-9]+|F) followed by any
//   number of modifiers (kh|kl|dh|dl)[0-9]+, `!`, r(<|>|=)[0-9]+, in any order.
//   It is a dice token only if the character after the match is not
//   [A-Za-z0-9_]; otherwise lexing falls back to a number or identifier
//   (`d6x` is an identifier, `2d6kh` is a number followed by an identifier
//   character, an error). A `!` immediately followed by `=` is never an
//   explode modifier: `1d6!=3` is `1d6 != 3`. The token carries the raw text;
//   the dice module validates it. A cell named `d6` or `dF` must be
//   backticked.
// - Punctuation: + - * / % & = != < <= > >= ( ) [ ] { } , . : and `->`
//   (lexed for action step syntax; the expression parser rejects it).

export interface LexError {
  readonly kind: "error";
  readonly message: string;
  readonly offset: number;
}

export type TokenizeResult =
  | { readonly ok: true; readonly tokens: Token[] }
  | { readonly ok: false; readonly message: string; readonly offset: number };

const WHITESPACE = /[ \t\n\r]*/y;
const IDENT = /[A-Za-z_][A-Za-z0-9_]*/y;
const DIGITS = /[0-9]+/y;
const DICE = /[0-9]*d(?:[0-9]+|F)(?:(?:kh|kl|dh|dl)[0-9]+|!(?!=)|r[<>=][0-9]+)*/y;

function isIdentChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_]/.test(ch);
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= "0" && ch <= "9";
}

function matchAt(re: RegExp, source: string, pos: number): string | undefined {
  re.lastIndex = pos;
  return re.exec(source)?.[0];
}

function error(message: string, offset: number): LexError {
  return { kind: "error", message, offset };
}

/** Skip whitespace from `pos` and return the offset of the next token. */
export function skipWhitespace(source: string, pos: number): number {
  return pos + (matchAt(WHITESPACE, source, pos)?.length ?? 0);
}

/**
 * Lex one token starting at `pos`, skipping leading whitespace. Returns an
 * `eof` token at the end of input, or a {@link LexError}.
 */
export function lexToken(source: string, pos: number): Token | LexError {
  const start = skipWhitespace(source, pos);
  const ch = source[start];
  if (ch === undefined) return { kind: "eof", value: "", start, end: start };

  if (isDigit(ch) || ch === "d") {
    const dice = matchAt(DICE, source, start);
    if (dice !== undefined && !isIdentChar(source[start + dice.length])) {
      return { kind: "dice", value: dice, start, end: start + dice.length };
    }
  }

  if (isDigit(ch)) return lexNumber(source, start);

  const ident = matchAt(IDENT, source, start);
  if (ident !== undefined) {
    const end = start + ident.length;
    return { kind: isKeyword(ident) ? "keyword" : "ident", value: ident, start, end };
  }

  if (ch === '"') return lexText(source, start);

  if (ch === "`") {
    const close = source.indexOf("`", start + 1);
    if (close < 0) return error("unterminated backtick name", start);
    if (close === start + 1) return error("empty backtick name", start);
    return { kind: "name", value: source.slice(start + 1, close), start, end: close + 1 };
  }

  for (const p of PUNCTUATION) {
    if (source.startsWith(p, start)) {
      return { kind: "punct", value: p, start, end: start + p.length };
    }
  }

  return error(`unexpected character ${JSON.stringify(ch)}`, start);
}

function lexNumber(source: string, start: number): Token | LexError {
  let end = start + (matchAt(DIGITS, source, start) ?? "").length;
  if (source[end] === ".") {
    const fraction = matchAt(DIGITS, source, end + 1);
    if (fraction === undefined) return error("a number cannot end with '.'", end);
    end += 1 + fraction.length;
  }
  if (isIdentChar(source[end])) {
    return error("a number cannot be followed directly by a letter or '_'", end);
  }
  return { kind: "number", value: source.slice(start, end), start, end };
}

function lexText(source: string, start: number): Token | LexError {
  let value = "";
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"') return { kind: "text", value, start, end: i + 1 };
    if (ch === "\\") {
      const next = source[i + 1];
      if (next === undefined) break;
      if (next !== '"' && next !== "\\") {
        return error('invalid escape in text: only \\" and \\\\ are allowed', i);
      }
      value += next;
      i += 2;
    } else {
      value += ch;
      i += 1;
    }
  }
  return error("unterminated text", start);
}

/** Lex a whole source. The token list ends with an `eof` token. */
export function tokenize(source: string): TokenizeResult {
  const tokens: Token[] = [];
  let pos = 0;
  for (;;) {
    const token = lexToken(source, pos);
    if (token.kind === "error") return { ok: false, message: token.message, offset: token.offset };
    tokens.push(token);
    if (token.kind === "eof") return { ok: true, tokens };
    pos = token.end;
  }
}
