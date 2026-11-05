import { type BinaryOp, type Expr, isComparisonOp } from "./ast";
import { type LexError, lexToken } from "./lexer";
import type { Token } from "./tokens";

// Pratt parser for the formula language (FORMULAS.md §2–§6).
//
// Precedence, loosest to tightest: or; and; comparisons = != < <= > >=; has;
// &; + -; * / %; prefix - and not; postfix (call f(...), dot .name, method
// .where(...)/.sort(...)). Binary operators are left-associative. Comparisons
// parse left-associatively, but a comparison whose unparenthesized operand is
// itself a comparison is flagged `chained: true` (§4); the evaluator returns
// #TYPE for it.
//
// Limits (FORMULAS.md §2.3). Depth counts nesting levels: a leaf (a literal,
// name, `this`, an empty list) is at depth 0, and every construct that wraps
// children adds one level above its deepest child. That includes each binary
// node in a left-associative chain, each postfix dot, call or method, each
// pair of parentheses (which create no node but still count), each unary
// operator, list and record. So 256 nested parentheses around a literal are
// depth 256 and parse; 257 do not. A 1+1+… chain "N levels deep" has N binary
// nodes (N+1 terms). The node limit counts every AST node.
//
// The parser checks depth two ways so it never overflows the JS stack: each
// node's depth is computed bottom-up as it is built (this catches the
// iteratively built left-associative and postfix chains), and every recursive
// descent into a child (operand, argument, item, parenthesized expression)
// increments a nesting counter that is checked against the same limit. The
// counter never exceeds the true depth, so both checks agree on what fails.

export const MAX_AST_DEPTH = 256;
export const MAX_AST_NODES = 10_000;

export interface ParseFailure {
  readonly ok: false;
  readonly message: string;
  readonly offset: number;
}

export type ParseResult = { readonly ok: true; readonly ast: Expr } | ParseFailure;

export type PrefixParseResult =
  | { readonly ok: true; readonly ast: Expr; readonly end: number }
  | ParseFailure;

/**
 * Parse a whole formula. The entire input must be one expression. A failure
 * carries a message and a source offset, never a partial AST.
 */
export function parse(source: string): ParseResult {
  return run(source, 0, (parser) => {
    const ast = parser.expression(0);
    const next = parser.peek();
    if (next.kind === "error") throw new SyntaxFailure(next.message, next.offset);
    if (next.kind !== "eof") parser.unexpected(next);
    return { ok: true, ast };
  });
}

/**
 * Parse the longest expression starting at `start`, stopping at the first
 * token that cannot continue it (for action step syntax, which follows an
 * expression with `->`). `end` is the offset just past the last token
 * consumed. Offsets in the AST are absolute in `source`. Limits apply.
 */
export function parseExpressionPrefix(source: string, start: number): PrefixParseResult {
  return run(source, start, (parser) => {
    const ast = parser.expression(0);
    return { ok: true, ast, end: parser.lastEnd };
  });
}

function run<T>(source: string, start: number, body: (parser: Parser) => T): T | ParseFailure {
  try {
    return body(new Parser(source, start));
  } catch (error) {
    if (error instanceof SyntaxFailure) {
      return { ok: false, message: error.message, offset: error.offset };
    }
    throw error;
  }
}

class SyntaxFailure {
  constructor(
    readonly message: string,
    readonly offset: number,
  ) {}
}

const BINARY_POWER: Readonly<Record<BinaryOp, number>> = {
  or: 1,
  and: 2,
  "=": 3,
  "!=": 3,
  "<": 3,
  "<=": 3,
  ">": 3,
  ">=": 3,
  has: 4,
  "&": 5,
  "+": 6,
  "-": 6,
  "*": 7,
  "/": 7,
  "%": 7,
};

/** Binding power of prefix operands: only postfix operators bind tighter. */
const PREFIX_POWER = 8;

type Lookahead = Token | LexError;

function binaryOp(token: Lookahead): BinaryOp | undefined {
  if (token.kind !== "punct" && token.kind !== "keyword") return undefined;
  return Object.hasOwn(BINARY_POWER, token.value) ? (token.value as BinaryOp) : undefined;
}

function isPunct(token: Lookahead, value: string): boolean {
  return token.kind === "punct" && token.value === value;
}

function describe(token: Token): string {
  switch (token.kind) {
    case "eof":
      return "end of input";
    case "text":
      return "text";
    case "name":
      return `\`${token.value}\``;
    default:
      return `'${token.value}'`;
  }
}

/** Mutable while parsing; exposed as the readonly {@link Expr}. */
type Draft<T> = { -readonly [K in keyof T]: T[K] };

class Parser {
  /** Offset just past the last consumed token. */
  lastEnd: number;
  private next: Lookahead;
  private nodeCount = 0;
  private nesting = 0;
  private readonly depth = new Map<Expr, number>();
  private readonly parenthesized = new Set<Expr>();

  constructor(
    private readonly source: string,
    start: number,
  ) {
    this.lastEnd = start;
    this.next = lexToken(source, start);
  }

  peek(): Lookahead {
    return this.next;
  }

  /** The next token; a lex error where a token is required is a failure. */
  private token(): Token {
    const next = this.next;
    if (next.kind === "error") throw new SyntaxFailure(next.message, next.offset);
    return next;
  }

  private advance(): Token {
    const token = this.token();
    this.lastEnd = token.end;
    this.next = lexToken(this.source, token.end);
    return token;
  }

  private expect(value: string, message = `expected '${value}'`): Token {
    const token = this.token();
    if (!isPunct(token, value)) {
      throw new SyntaxFailure(`${message}, found ${describe(token)}`, token.start);
    }
    return this.advance();
  }

  unexpected(token: Token): never {
    throw new SyntaxFailure(`unexpected ${describe(token)}`, token.start);
  }

  private depthFailure(offset: number): never {
    throw new SyntaxFailure(
      `expression exceeds the maximum depth of ${MAX_AST_DEPTH} nesting levels`,
      offset,
    );
  }

  /** Parse a child one nesting level down. */
  private nested(minPower: number): Expr {
    this.nesting += 1;
    if (this.nesting > MAX_AST_DEPTH) this.depthFailure(this.token().start);
    const expr = this.expression(minPower);
    this.nesting -= 1;
    return expr;
  }

  /** Register a new node: count it and record its depth, enforcing both limits. */
  private make<T extends Expr>(node: T, children: readonly Expr[], offset: number): T {
    this.nodeCount += 1;
    if (this.nodeCount > MAX_AST_NODES) {
      throw new SyntaxFailure(
        `too many nodes: an expression is limited to ${MAX_AST_NODES}`,
        offset,
      );
    }
    let depth = 0;
    for (const child of children) depth = Math.max(depth, (this.depth.get(child) ?? 0) + 1);
    if (depth > MAX_AST_DEPTH) this.depthFailure(offset);
    this.depth.set(node, depth);
    return node;
  }

  expression(minPower: number): Expr {
    let left = this.prefix();
    for (;;) {
      const token = this.next;
      if (isPunct(token, ".")) {
        left = this.postfix(left);
        continue;
      }
      const op = binaryOp(token);
      if (op === undefined || BINARY_POWER[op] <= minPower) return left;
      this.advance();
      const right = this.nested(BINARY_POWER[op]);
      left = this.binary(op, left, right, token.kind === "error" ? 0 : token.start);
    }
  }

  private binary(op: BinaryOp, left: Expr, right: Expr, offset: number): Expr {
    const isBareComparison = (e: Expr) =>
      e.kind === "Binary" && isComparisonOp(e.op) && !this.parenthesized.has(e);
    const chained = isComparisonOp(op) && (isBareComparison(left) || isBareComparison(right));
    const node: Expr = {
      kind: "Binary",
      op,
      left,
      right,
      ...(chained ? { chained: true as const } : {}),
      start: left.start,
      end: right.end,
    };
    return this.make(node, [left, right], offset);
  }

  private prefix(): Expr {
    const token = this.token();
    const { start, end } = token;
    switch (token.kind) {
      case "number":
        this.advance();
        return this.make({ kind: "Number", value: Number(token.value), start, end }, [], start);
      case "text":
        this.advance();
        return this.make({ kind: "Text", value: token.value, start, end }, [], start);
      case "dice":
        this.advance();
        return this.make({ kind: "Dice", raw: token.value, start, end }, [], start);
      case "name":
        this.advance();
        return this.make({ kind: "Name", name: token.value, start, end }, [], start);
      case "ident":
        this.advance();
        if (isPunct(this.next, "(")) return this.call(token);
        return this.make({ kind: "Name", name: token.value, start, end }, [], start);
      case "keyword":
        return this.keyword(token);
      case "punct":
        switch (token.value) {
          case "-":
            return this.unary("-", token);
          case "(":
            return this.paren(token);
          case "[":
            return this.list(token);
          case "{":
            return this.record(token);
        }
        return this.unexpected(token);
      case "eof":
        return this.unexpected(token);
    }
  }

  private keyword(token: Token): Expr {
    const { start, end } = token;
    switch (token.value) {
      case "true":
      case "false":
        this.advance();
        return this.make({ kind: "Boolean", value: token.value === "true", start, end }, [], start);
      case "empty":
        this.advance();
        return this.make({ kind: "Empty", start, end }, [], start);
      case "this":
        this.advance();
        return this.make({ kind: "This", start, end }, [], start);
      case "it":
        this.advance();
        return this.make({ kind: "It", start, end }, [], start);
      case "gm":
        this.advance();
        return this.make({ kind: "Viewer", which: "gm", start, end }, [], start);
      case "all":
        // Bare `all` is the viewer literal; `all(` is the aggregate call.
        this.advance();
        if (isPunct(this.next, "(")) return this.call(token);
        return this.make({ kind: "Viewer", which: "all", start, end }, [], start);
      case "not":
        return this.unary("not", token);
    }
    return this.unexpected(token);
  }

  private unary(op: "-" | "not", token: Token): Expr {
    this.advance();
    const operand = this.nested(PREFIX_POWER);
    return this.make(
      { kind: "Unary", op, operand, start: token.start, end: operand.end },
      [operand],
      token.start,
    );
  }

  private paren(open: Token): Expr {
    this.advance();
    const inner = this.nested(0);
    const close = this.expect(")");
    // Parentheses make no node; widen the inner node's span and count the level.
    const node: Draft<Expr> = { ...inner, start: open.start, end: close.end };
    const depth = (this.depth.get(inner) ?? 0) + 1;
    if (depth > MAX_AST_DEPTH) this.depthFailure(open.start);
    this.depth.set(node, depth);
    this.parenthesized.add(node);
    return node;
  }

  /** Comma-separated expressions up to `close`; no trailing comma. */
  private items(close: string): Expr[] {
    const items: Expr[] = [];
    if (isPunct(this.next, close)) {
      this.advance();
      return items;
    }
    for (;;) {
      items.push(this.nested(0));
      const token = this.token();
      if (isPunct(token, close)) {
        this.advance();
        return items;
      }
      this.expect(",", `expected ',' or '${close}'`);
    }
  }

  private call(name: Token): Expr {
    this.advance(); // (
    const args = this.items(")");
    return this.make(
      { kind: "Call", name: name.value, args, start: name.start, end: this.lastEnd },
      args,
      name.start,
    );
  }

  private list(open: Token): Expr {
    this.advance();
    const items = this.items("]");
    return this.make(
      { kind: "List", items, start: open.start, end: this.lastEnd },
      items,
      open.start,
    );
  }

  private record(open: Token): Expr {
    this.advance();
    const fields: [string, Expr][] = [];
    const seen = new Set<string>();
    if (isPunct(this.next, "}")) {
      this.advance();
    } else {
      for (;;) {
        const name = this.token();
        if (name.kind !== "ident" && name.kind !== "name") {
          throw new SyntaxFailure(`expected a field name, found ${describe(name)}`, name.start);
        }
        if (seen.has(name.value)) {
          throw new SyntaxFailure(`duplicate field '${name.value}' in record`, name.start);
        }
        seen.add(name.value);
        this.advance();
        this.expect(":");
        fields.push([name.value, this.nested(0)]);
        if (isPunct(this.token(), "}")) {
          this.advance();
          break;
        }
        this.expect(",", "expected ',' or '}'");
      }
    }
    return this.make(
      { kind: "Record", fields, start: open.start, end: this.lastEnd },
      fields.map(([, value]) => value),
      open.start,
    );
  }

  private postfix(target: Expr): Expr {
    const dot = this.advance();
    const name = this.token();
    if (name.kind !== "ident" && name.kind !== "name") {
      throw new SyntaxFailure(
        `expected a cell name after '.', found ${describe(name)}`,
        name.start,
      );
    }
    this.advance();
    if (name.kind === "ident" && isPunct(this.next, "(")) {
      if (name.value === "where" || name.value === "sort") return this.method(target, name.value);
      throw new SyntaxFailure(
        `'.${name.value}(' is not a method; only .where(...) and .sort(...) take arguments`,
        name.start,
      );
    }
    return this.make(
      { kind: "Dot", target, name: name.value, start: target.start, end: name.end },
      [target],
      dot.start,
    );
  }

  private method(target: Expr, name: "where" | "sort"): Expr {
    const open = this.advance();
    if (isPunct(this.next, ")")) {
      throw new SyntaxFailure(`.${name} needs an argument`, this.token().start);
    }
    const arg = this.nested(0);
    let desc = false;
    if (name === "sort" && isPunct(this.next, ",")) {
      this.advance();
      const flag = this.token();
      if (flag.kind !== "ident" || flag.value !== "desc") {
        throw new SyntaxFailure(
          `the second argument of .sort must be desc, found ${describe(flag)}`,
          flag.start,
        );
      }
      this.advance();
      desc = true;
      this.expect(")", ".sort takes at most an expression and desc: expected ')'");
    } else {
      const message =
        name === "where"
          ? ".where takes exactly one argument: expected ')'"
          : "expected ',' or ')'";
      this.expect(")", message);
    }
    return this.make(
      { kind: "Method", target, name, args: [arg], desc, start: target.start, end: this.lastEnd },
      [target, arg],
      open.start,
    );
  }
}
