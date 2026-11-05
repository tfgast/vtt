import type { ActionDef } from "@vtt/schema";
import type { Expr } from "../syntax/ast";
import { lexToken } from "../syntax/lexer";
import { MAX_AST_NODES, type ParseResult, parse, parseExpressionPrefix } from "../syntax/parser";
import type { Token } from "../syntax/tokens";

// The step-level grammar of action steps (FORMULAS.md §8.2–§8.4, M5-D2):
//
//   step  := name "(" args ")" [ "->" path ]      -- "->" only after roll, required there
//   set(path, expr)   add(path, expr)   append(path, expr)   roll(expr) -> path
//   move(expr, dest)  spawn(expr, dest [, record])  remove(expr)  shuffle(expr)
//   each(expr, step)                               -- the inner step is never each
//   path  := a bare name | an expression ending in ".name"   (`this` when bare)
//   dest  := table | board(expr, expr) | beside(expr) | expr (a container)
//
// A recursive-descent parser over the formula lexer. Every `expr` is parsed
// with `parseExpressionPrefix`, which stops at `,`, `)` or `->`; `->` is step
// syntax and never reaches the expression parser as an operator. Step names
// and `table`, `board`, `beside` are contextual, never reserved: they are
// recognised only where a step name or a destination begins (`board(` and
// `beside(` by the following `(`, `table` by a following `,` or `)`), and are
// ordinary names everywhere else.
//
// Limits (FORMULAS §3.2) apply to the whole step source: the expression
// parser enforces depth and node count per argument, and this parser sums the
// nodes of every argument and refuses past MAX_AST_NODES. A step adds no
// nesting level of its own, so the step's depth is its deepest argument's.

/** A cell path: a cell of `this` (`object: null`, from a bare name) or `object.cell`. */
export interface PathNode {
  readonly object: Expr | null;
  readonly cell: string;
}

/** Where `move` and `spawn` place an object (FORMULAS §8.2). */
export type DestinationNode =
  | { readonly type: "table" }
  | { readonly type: "board"; readonly board: Expr; readonly position: Expr }
  | { readonly type: "beside"; readonly object: Expr }
  | { readonly type: "container"; readonly container: Expr };

/** A step that may appear inside `each`. */
export type InnerStep =
  | { readonly kind: "set" | "add" | "append"; readonly path: PathNode; readonly value: Expr }
  | { readonly kind: "roll"; readonly dice: Expr; readonly path: PathNode }
  | { readonly kind: "move"; readonly object: Expr; readonly to: DestinationNode }
  | {
      readonly kind: "spawn";
      readonly template: Expr;
      readonly to: DestinationNode;
      readonly cells: readonly { readonly name: string; readonly value: Expr }[];
    }
  | { readonly kind: "remove" | "shuffle"; readonly object: Expr };

/** One parsed action step (FORMULAS §8.3). The step of an `each` is never an `each`. */
export type Step =
  | InnerStep
  | { readonly kind: "each"; readonly list: Expr; readonly step: InnerStep };

export type StepKind = Step["kind"];

/** The step names, in FORMULAS §8.3 order. */
export const STEP_KINDS: readonly StepKind[] = [
  "set",
  "add",
  "append",
  "roll",
  "move",
  "spawn",
  "remove",
  "shuffle",
  "each",
];

export interface StepParseError {
  readonly ok: false;
  readonly message: string;
  /** Offset in the step source where the problem starts. */
  readonly offset: number;
}

export type StepParseResult = { readonly ok: true; readonly step: Step } | StepParseError;

/** The parse results of an action's `when` (if it has one) and of each of its steps. */
export interface ActionParse {
  readonly when?: ParseResult;
  readonly steps: StepParseResult[];
}

/**
 * Parse one step source string. A failure carries a message and a source
 * offset (shown as `#SYNTAX`), never a partial step.
 */
export function parseStep(source: string): StepParseResult {
  try {
    const parser = new StepParser(source);
    const step = parser.step(false);
    const next = parser.peek();
    if (next.kind !== "eof") fail(`unexpected ${describe(next)} after the step`, next.start);
    return { ok: true, step };
  } catch (error) {
    if (error instanceof StepFailure) {
      return { ok: false, message: error.message, offset: error.offset };
    }
    throw error;
  }
}

/**
 * Parse an action definition's `when` (with the expression parser) and every
 * step, for explanation and editing. `when` is present exactly when the
 * definition has one. Takes an {@link ActionDef}, readonly or not.
 */
export function parseAction(
  def: Readonly<Omit<ActionDef, "steps">> & { readonly steps: readonly string[] },
): ActionParse {
  const steps = def.steps.map(parseStep);
  return def.when === undefined ? { steps } : { when: parse(def.when), steps };
}

class StepFailure {
  constructor(
    readonly message: string,
    readonly offset: number,
  ) {}
}

function fail(message: string, offset: number): never {
  throw new StepFailure(message, offset);
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

function isPunct(token: Token, value: string): boolean {
  return token.kind === "punct" && token.value === value;
}

function isStepKind(name: string): name is StepKind {
  return (STEP_KINDS as readonly string[]).includes(name);
}

/** An argument list's arity, for messages: `set takes 2 arguments: set(path, value)`. */
interface Signature {
  readonly name: string;
  readonly arity: string;
  readonly form: string;
}

function signature(name: string, arity: string, form: string): Signature {
  return { name, arity, form };
}

const SIGNATURES: Readonly<Record<StepKind | "board" | "beside", Signature>> = {
  set: signature("set", "2 arguments", "set(path, value)"),
  add: signature("add", "2 arguments", "add(path, value)"),
  append: signature("append", "2 arguments", "append(path, value)"),
  roll: signature("roll", "1 argument", "roll(dice) -> path"),
  move: signature("move", "2 arguments", "move(object, destination)"),
  spawn: signature("spawn", "2 or 3 arguments", "spawn(template, destination, {cell: value, ...})"),
  remove: signature("remove", "1 argument", "remove(object)"),
  shuffle: signature("shuffle", "1 argument", "shuffle(object)"),
  each: signature("each", "2 arguments", "each(list, step)"),
  board: signature("board", "2 arguments", "board(board, position)"),
  beside: signature("beside", "1 argument", "beside(object)"),
};

function arityMessage(sig: Signature): string {
  return `${sig.name} takes ${sig.arity}: ${sig.form}`;
}

function children(node: Expr): readonly Expr[] {
  switch (node.kind) {
    case "List":
      return node.items;
    case "Record":
      return node.fields.map(([, value]) => value);
    case "Unary":
      return [node.operand];
    case "Binary":
      return [node.left, node.right];
    case "Dot":
      return [node.target];
    case "Call":
      return node.args;
    case "Method":
      return [node.target, ...node.args];
    default:
      return [];
  }
}

class StepParser {
  /** Offset just past the last consumed token or expression. */
  private pos = 0;
  /** AST nodes of every argument parsed so far. */
  private nodes = 0;

  constructor(private readonly source: string) {}

  /** The next token; a lex error is a failure. */
  peek(): Token {
    return this.lexAt(this.pos);
  }

  private lexAt(pos: number): Token {
    const token = lexToken(this.source, pos);
    if (token.kind === "error") fail(token.message, token.offset);
    return token;
  }

  private advance(): Token {
    const token = this.peek();
    this.pos = token.end;
    return token;
  }

  /** Is the token after `token` the punctuation `value`? A lex error there is not. */
  private followedBy(token: Token, value: string): boolean {
    const next = lexToken(this.source, token.end);
    return next.kind === "punct" && next.value === value;
  }

  step(insideEach: boolean): Step {
    const name = this.peek();
    if (name.kind !== "ident") {
      fail(`expected a step name (${STEP_KINDS.join(", ")}), found ${describe(name)}`, name.start);
    }
    const kind = name.value;
    if (!isStepKind(kind)) {
      fail(`unknown step '${kind}': expected one of ${STEP_KINDS.join(", ")}`, name.start);
    }
    if (insideEach && kind === "each") {
      fail("each cannot contain each: each runs one step per item, one level only", name.start);
    }
    this.advance();
    const open = this.peek();
    if (!isPunct(open, "("))
      fail(`expected '(' after ${kind}, found ${describe(open)}`, open.start);
    this.advance();

    const sig = SIGNATURES[kind];
    const step = this.body(kind, sig);

    if (step.kind === "roll") return step;
    const arrow = this.peek();
    if (isPunct(arrow, "->"))
      fail(`'->' follows only roll; ${kind} takes no '-> path'`, arrow.start);
    return step;
  }

  private body(kind: StepKind, sig: Signature): Step {
    switch (kind) {
      case "set":
      case "add":
      case "append": {
        const path = this.path();
        this.comma(sig);
        const value = this.expression();
        this.close(sig);
        return { kind, path, value };
      }
      case "roll": {
        const dice = this.expression();
        this.close(sig);
        const arrow = this.peek();
        if (!isPunct(arrow, "->")) {
          fail(
            `roll needs '-> path' naming the cell to write, found ${describe(arrow)}`,
            arrow.start,
          );
        }
        this.advance();
        return { kind, dice, path: this.path() };
      }
      case "move": {
        const object = this.expression();
        this.comma(sig);
        const to = this.destination();
        this.close(sig);
        return { kind, object, to };
      }
      case "spawn": {
        const template = this.expression();
        this.comma(sig);
        const to = this.destination();
        let cells: { name: string; value: Expr }[] = [];
        if (isPunct(this.peek(), ",")) {
          this.advance();
          cells = this.record();
        }
        this.close(sig);
        return { kind, template, to, cells };
      }
      case "remove":
      case "shuffle": {
        const object = this.expression();
        this.close(sig);
        return { kind, object };
      }
      case "each": {
        const list = this.expression();
        this.comma(sig);
        const step = this.step(true) as InnerStep;
        this.close(sig);
        return { kind, list, step };
      }
    }
  }

  /** One expression in prefix mode, counted toward the whole-source node limit. */
  private expression(): Expr {
    const result = parseExpressionPrefix(this.source, this.pos);
    if (!result.ok) fail(result.message, result.offset);
    this.count(result.ast);
    this.pos = result.end;
    return result.ast;
  }

  /** Count `node`'s subtree in post-order, failing at the node that exceeds the limit. */
  private count(node: Expr): void {
    for (const child of children(node)) this.count(child);
    this.nodes += 1;
    if (this.nodes > MAX_AST_NODES) {
      fail(
        `too many nodes: a step's expressions are limited to ${MAX_AST_NODES} nodes in all`,
        node.start,
      );
    }
  }

  /** A bare name (a cell of `this`) or an expression ending in `.name`, unparenthesized. */
  private path(): PathNode {
    const node = this.expression();
    const parenthesized = this.source[node.end - 1] === ")";
    if (!parenthesized && node.kind === "Name") return { object: null, cell: node.name };
    if (!parenthesized && node.kind === "Dot") return { object: node.target, cell: node.name };
    return fail("expected a cell path: a cell name or an expression ending in '.name'", node.start);
  }

  private destination(): DestinationNode {
    const token = this.peek();
    if (token.kind === "ident") {
      if (token.value === "table" && (this.followedBy(token, ",") || this.followedBy(token, ")"))) {
        this.advance();
        return { type: "table" };
      }
      if (token.value === "board" && this.followedBy(token, "(")) {
        this.advance();
        this.advance();
        const board = this.expression();
        this.comma(SIGNATURES.board);
        const position = this.expression();
        this.close(SIGNATURES.board);
        return { type: "board", board, position };
      }
      if (token.value === "beside" && this.followedBy(token, "(")) {
        this.advance();
        this.advance();
        const object = this.expression();
        this.close(SIGNATURES.beside);
        return { type: "beside", object };
      }
    }
    return { type: "container", container: this.expression() };
  }

  /** spawn's third argument: a record literal `{name: expr, ...}`. */
  private record(): { name: string; value: Expr }[] {
    const node = this.expression();
    if (node.kind !== "Record" || this.source[node.start] !== "{") {
      fail("the third argument of spawn must be a record {cell: value, ...}", node.start);
    }
    return node.fields.map(([name, value]) => ({ name, value }));
  }

  /** The `,` between arguments; `)` there means too few arguments. */
  private comma(sig: Signature): void {
    const token = this.peek();
    if (isPunct(token, ",")) {
      this.advance();
      return;
    }
    if (isPunct(token, ")")) fail(`too few arguments: ${arityMessage(sig)}`, token.start);
    fail(`expected ',' in ${sig.name}(...), found ${describe(token)}`, token.start);
  }

  /** The closing `)`; `,` there means too many arguments. */
  private close(sig: Signature): void {
    const token = this.peek();
    if (isPunct(token, ")")) {
      this.advance();
      return;
    }
    if (isPunct(token, ",")) fail(`too many arguments: ${arityMessage(sig)}`, token.start);
    fail(`expected ')' to close ${sig.name}(...), found ${describe(token)}`, token.start);
  }
}
