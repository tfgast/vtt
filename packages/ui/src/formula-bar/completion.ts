/**
 * Formula completion (vtt-qf5.16; DESIGN.md §4.6 The formula bar; FORMULAS.md
 * §3 names and dot-access, §3.2 syntax, §6 functions). Pure: what to suggest
 * for the text of a formula input and its caret, and what accepting a
 * suggestion makes of the text.
 *
 * Completion applies only to a formula (text starting with `=`, in any cell
 * but `name`, whose input is always text: `parseCellInput`). The formula's
 * own lexer finds the token under the caret, so text, backtick names, dice
 * and numbers are never completed:
 *
 * - **A bare name**: an identifier (or a keyword being typed) ending at or
 *   containing the caret, not after a `.`, with a non-empty prefix before
 *   the caret. Suggests the edited object's cells (but the edited cell) and
 *   the callable functions (`defaultRegistry` without the methods `where`
 *   and `sort`).
 * - **After a dot**: `head.a.b.` (any step may be a backtick name) followed by the caret or by an identifier
 *   containing it (an empty prefix suggests every name). `head` is `this`
 *   (the edited object) or a cell of the edited object; each step must be a
 *   cell whose value, as the viewer's view shows it, is a reference. The
 *   last object's cells, as its view shows them (readable cells only), are
 *   suggested. A chain that does not resolve suggests nothing.
 *
 * Matching is a case-insensitive prefix match; cells come before functions,
 * each sorted case-insensitively, at most `MAX_SUGGESTIONS`. A suggestion
 * equal to the whole identifier under the caret is left out. Accepting
 * replaces that whole identifier; a cell name that is not a plain identifier
 * (or reads as a keyword or dice) is inserted in backticks, and a function
 * as `name(` unless a `(` already follows (after any whitespace).
 */
import { defaultRegistry, lexToken, METHOD_NAMES, skipWhitespace, type Token } from "@vtt/formula";
import type { ObjectView } from "@vtt/protocol";
import type { ObjectId } from "@vtt/schema";

/** The most suggestions shown at once. */
export const MAX_SUGGESTIONS = 8;

/** The callable function names, sorted (methods are reached only after a dot on a list). */
export const COMPLETION_FUNCTION_NAMES: readonly string[] = defaultRegistry
  .names()
  .filter((name) => !METHOD_NAMES.has(name))
  .sort();

export interface CompletionContext {
  /** The object whose cell is being edited. */
  readonly object: ObjectId;
  /** The cell being edited (never suggested on its own object). */
  readonly cell: string;
  /** The viewer's view of an object, or null when the viewer has none. */
  objectView(id: ObjectId): ObjectView | null;
  /** The function names to offer; defaults to `COMPLETION_FUNCTION_NAMES`. */
  readonly functions?: readonly string[];
}

export interface CompletionItem {
  /** What the list shows: the cell or function name. */
  readonly label: string;
  readonly kind: "cell" | "function";
  /** The text accepting it puts in place of the identifier. */
  readonly insert: string;
}

export interface Completion {
  /** The replaced range of the input text (the identifier under the caret, or the caret). */
  readonly from: number;
  readonly to: number;
  /** The identifier's text before the caret, matched against the names. */
  readonly prefix: string;
  /** Non-empty, at most `MAX_SUGGESTIONS`. */
  readonly items: readonly CompletionItem[];
}

/** Every token of `source` that starts before `caret`, or null when lexing fails there. */
function tokensBefore(source: string, caret: number): Token[] | null {
  const tokens: Token[] = [];
  let pos = 0;
  for (;;) {
    const token = lexToken(source, pos);
    if (token.kind === "error") return token.offset < caret ? null : tokens;
    if (token.kind === "eof" || token.start >= caret) return tokens;
    tokens.push(token);
    pos = token.end;
  }
}

const isWord = (token: Token | undefined): token is Token =>
  token !== undefined && (token.kind === "ident" || token.kind === "keyword");
const isDot = (token: Token | undefined) => token?.kind === "punct" && token.value === ".";
/** A step of a reference chain: an identifier, a backtick name, or a keyword (only `this` resolves). */
const isStep = (token: Token | undefined): token is Token =>
  token !== undefined &&
  (token.kind === "ident" || token.kind === "keyword" || token.kind === "name");

/** The cell names of `view`, with the readable structural `id`. */
function cellNames(view: ObjectView): string[] {
  const names = Object.keys(view.cells);
  if (!Object.hasOwn(view.cells, "id")) names.push("id");
  return names;
}

/** The object `chain` (a `this` or cell head, then cells) leads to, or null. */
function resolveChain(chain: readonly Token[], ctx: CompletionContext): ObjectView | null {
  let view = ctx.objectView(ctx.object);
  for (const [i, token] of chain.entries()) {
    if (view === null) return null;
    if (i === 0 && token.kind === "keyword" && token.value === "this") continue;
    if (token.kind === "keyword") return null;
    const value = Object.hasOwn(view.cells, token.value)
      ? view.cells[token.value]?.value
      : undefined;
    if (value?.type !== "ref") return null;
    view = ctx.objectView(value.object);
  }
  return view;
}

/** How `name` is written in a formula: bare when it lexes as exactly one identifier. */
export function cellNameSource(name: string): string {
  const token = lexToken(name, 0);
  return token.kind === "ident" && token.start === 0 && token.end === name.length
    ? name
    : `\`${name}\``;
}

const byName = (a: string, b: string) => {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  return la < lb ? -1 : la > lb ? 1 : a < b ? -1 : a > b ? 1 : 0;
};

/**
 * What to suggest for `text` with the caret at `caret`, or null (not a
 * formula, nothing under the caret to complete, or no name matches).
 */
export function suggestCompletions(
  text: string,
  caret: number,
  ctx: CompletionContext,
): Completion | null {
  if (ctx.cell === "name" || !text.startsWith("=") || caret < 1 || caret > text.length) {
    return null;
  }
  const source = text.slice(1);
  const at = caret - 1;
  const tokens = tokensBefore(source, at);
  if (tokens === null) return null;

  // The identifier under the caret (touching it from the left), if any.
  const last = tokens.at(-1);
  const word = isWord(last) && last.end >= at ? last : undefined;
  const before = word === undefined ? tokens : tokens.slice(0, -1);
  // With no identifier, the caret must sit right after a dot.
  if (word === undefined && !(isDot(last) && last?.end === at)) return null;
  const prefix = word === undefined ? "" : source.slice(word.start, at);
  const from = word === undefined ? at : word.start;
  const to = word === undefined ? at : word.end;
  const whole = word?.value ?? "";

  let cells: string[];
  let functions: readonly string[] = [];
  let own: boolean;
  if (isDot(before.at(-1))) {
    // `head.a.b.` + prefix: walk the chain back from the dot.
    const chain: Token[] = [];
    let i = before.length - 1;
    while (isDot(before[i]) && isStep(before[i - 1])) {
      chain.unshift(before[i - 1] as Token);
      i -= 2;
    }
    if (chain.length === 0 || isDot(before[i])) return null;
    const view = resolveChain(chain, ctx);
    if (view === null) return null;
    cells = cellNames(view);
    own = view.id === ctx.object;
  } else {
    if (prefix === "") return null;
    const view = ctx.objectView(ctx.object);
    cells = view === null ? [] : cellNames(view);
    functions = ctx.functions ?? COMPLETION_FUNCTION_NAMES;
    own = true;
  }

  const lower = prefix.toLowerCase();
  const matches = (name: string) => name.toLowerCase().startsWith(lower) && name !== whole;
  const after = source[skipWhitespace(source, to)];
  const items: CompletionItem[] = [
    ...cells
      .filter((name) => matches(name) && !(own && name === ctx.cell))
      .sort(byName)
      .map((name): CompletionItem => ({ label: name, kind: "cell", insert: cellNameSource(name) })),
    ...functions
      .filter(matches)
      .sort(byName)
      .map(
        (name): CompletionItem => ({
          label: name,
          kind: "function",
          insert: after === "(" ? name : `${name}(`,
        }),
      ),
  ].slice(0, MAX_SUGGESTIONS);
  if (items.length === 0) return null;
  return { from: from + 1, to: to + 1, prefix, items };
}

/** `text` with `item` accepted: the completion's range replaced, and the caret after the insert. */
export function applyCompletion(
  text: string,
  completion: Completion,
  item: CompletionItem,
): { text: string; caret: number } {
  return {
    text: text.slice(0, completion.from) + item.insert + text.slice(completion.to),
    caret: completion.from + item.insert.length,
  };
}
