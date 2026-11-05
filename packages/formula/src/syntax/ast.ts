// The formula AST (FORMULAS.md §2–§6). Every node carries `start` and `end`
// source offsets (end is one past the last character). A parenthesized
// expression has no node of its own; its node's span is widened to cover the
// parentheses.

interface Span {
  readonly start: number;
  readonly end: number;
}

export interface NumberNode extends Span {
  readonly kind: "Number";
  readonly value: number;
}

export interface TextNode extends Span {
  readonly kind: "Text";
  readonly value: string;
}

export interface BooleanNode extends Span {
  readonly kind: "Boolean";
  readonly value: boolean;
}

export interface EmptyNode extends Span {
  readonly kind: "Empty";
}

/** A dice literal. `raw` is the source text, unvalidated (the dice module checks it). */
export interface DiceNode extends Span {
  readonly kind: "Dice";
  readonly raw: string;
}

/** The bare viewer literals `all` and `gm`. `owner` is an ordinary name, never a viewer. */
export interface ViewerNode extends Span {
  readonly kind: "Viewer";
  readonly which: "all" | "gm";
}

export interface ThisNode extends Span {
  readonly kind: "This";
}

export interface ItNode extends Span {
  readonly kind: "It";
}

/** A bare identifier or a backtick name: a cell on the current object. */
export interface NameNode extends Span {
  readonly kind: "Name";
  readonly name: string;
}

export interface ListNode extends Span {
  readonly kind: "List";
  readonly items: readonly Expr[];
}

/** `{name: expr, ...}`. Field names are unique and in source order. */
export interface RecordNode extends Span {
  readonly kind: "Record";
  readonly fields: readonly (readonly [string, Expr])[];
}

export type UnaryOp = "-" | "not";

export interface UnaryNode extends Span {
  readonly kind: "Unary";
  readonly op: UnaryOp;
  readonly operand: Expr;
}

export type ComparisonOp = "=" | "!=" | "<" | "<=" | ">" | ">=";

export type BinaryOp = "or" | "and" | ComparisonOp | "has" | "&" | "+" | "-" | "*" | "/" | "%";

export interface BinaryNode extends Span {
  readonly kind: "Binary";
  readonly op: BinaryOp;
  readonly left: Expr;
  readonly right: Expr;
  /**
   * Present (and true) only on a comparison whose unparenthesized left or
   * right operand is itself a comparison: `a < b < c`. The evaluator returns
   * #TYPE for it (§4). `(a = b) = c` is not chained.
   */
  readonly chained?: true;
}

/** `target.name`: dot-access through a reference. */
export interface DotNode extends Span {
  readonly kind: "Dot";
  readonly target: Expr;
  readonly name: string;
}

/**
 * `name(args)`. The callee is a bare identifier (or the keyword `all`), never
 * a backtick name. Not resolved and not arity-checked by the parser.
 */
export interface CallNode extends Span {
  readonly kind: "Call";
  readonly name: string;
  readonly args: readonly Expr[];
}

/**
 * `target.where(expr)` (exactly one arg) or `target.sort(expr)` /
 * `target.sort(expr, desc)` (one arg; `desc` is a flag, not an argument).
 */
export interface MethodNode extends Span {
  readonly kind: "Method";
  readonly target: Expr;
  readonly name: "where" | "sort";
  readonly args: readonly Expr[];
  readonly desc: boolean;
}

export type Expr =
  | NumberNode
  | TextNode
  | BooleanNode
  | EmptyNode
  | DiceNode
  | ViewerNode
  | ThisNode
  | ItNode
  | NameNode
  | ListNode
  | RecordNode
  | UnaryNode
  | BinaryNode
  | DotNode
  | CallNode
  | MethodNode;

export type ExprKind = Expr["kind"];

const COMPARISONS: ReadonlySet<string> = new Set(["=", "!=", "<", "<=", ">", ">="]);

export function isComparisonOp(op: string): op is ComparisonOp {
  return COMPARISONS.has(op);
}
