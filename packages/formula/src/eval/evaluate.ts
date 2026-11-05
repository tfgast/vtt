/**
 * The AST evaluator (FORMULAS.md §2–§5): literals, names and scope,
 * dot-access, operators, short-circuit logic, and function and method
 * dispatch through a registry.
 *
 * Recursion follows the AST only, so its depth is bounded by the parser's
 * depth limit (MAX_AST_DEPTH, 256) times a few frames per level, far below
 * the JS stack. Cell reads go through `env.read`, which never recurses into
 * this evaluator (the engine resolves dependencies iteratively).
 */
import {
  bool,
  dice,
  EMPTY,
  type ErrorValue,
  err,
  list,
  num,
  type Result,
  ref,
  type Value,
} from "@vtt/schema";
import { isDiceError, parseDice, renderDice } from "../dice/index";
import { CORE_FUNCTIONS } from "../functions/core";
import { LIBRARY_FUNCTIONS } from "../functions/library";
import { QUERY_FUNCTIONS } from "../functions/queries";
import {
  type CallContext,
  createRegistry,
  type EagerFunctionDef,
  type FunctionDef,
  METHOD_NAMES,
  type Registry,
} from "../functions/registry";
import type { EvalEnv } from "../host";
import type { CallNode, DotNode, Expr, MethodNode } from "../syntax/ast";
import { collectList, withOrigin } from "./errors";
import { binary, unary } from "./operators";
import { type Scope, scopeOrigin } from "./scope";
import { truthy } from "./values";

/** Core functions plus whatever the library and queries register. */
export const defaultRegistry: Registry = createRegistry([
  ...CORE_FUNCTIONS,
  ...LIBRARY_FUNCTIONS,
  ...QUERY_FUNCTIONS,
]);

/**
 * Evaluates `ast` in `scope` over `env`. Never throws for a language error:
 * errors are results. A new error gets `scope.cell` (on `scope.thisId`) as
 * its origin; an error that already has an origin keeps it.
 */
export function evaluate(
  ast: Expr,
  scope: Scope,
  env: EvalEnv,
  registry: Registry = defaultRegistry,
): Result {
  return new Evaluator(env, registry).run(ast, scope);
}

const typeError = (message: string): ErrorValue => err("#TYPE", message);
const nameError = (message: string): ErrorValue => err("#NAME", message);

class Evaluator {
  constructor(
    private readonly env: EvalEnv,
    private readonly registry: Registry,
  ) {}

  run(ast: Expr, scope: Scope): Result {
    const result = this.node(ast, scope);
    if (result.type !== "error") return result;
    const origin = scopeOrigin(scope);
    return origin === undefined ? result : withOrigin(result, origin);
  }

  private node(ast: Expr, scope: Scope): Result {
    switch (ast.kind) {
      case "Number":
        return num(ast.value);
      case "Text":
        return { type: "text", value: ast.value };
      case "Boolean":
        return bool(ast.value);
      case "Empty":
        return EMPTY;
      case "Dice": {
        const parsed = parseDice(ast.raw);
        if (isDiceError(parsed)) return typeError(parsed.error);
        return dice(renderDice(parsed));
      }
      case "Viewer":
        return { type: "viewers", viewers: [ast.which] };
      case "Record":
        return typeError("a record is only a spawn argument, not a formula value");
      case "List":
        return this.list(ast.items, scope);
      case "This":
        return ref(scope.thisId);
      case "It":
        return scope.it ?? nameError("`it` is only bound inside where, sort, and objects");
      case "Name":
        return this.name(ast.name, scope);
      case "Unary": {
        const operand = this.run(ast.operand, scope);
        if (operand.type === "error") return operand;
        if (ast.op === "not") return bool(!truthy(operand));
        return unary(ast.op, operand);
      }
      case "Binary": {
        const left = this.run(ast.left, scope);
        if (ast.op === "and" || ast.op === "or") {
          if (left.type === "error") return left;
          const decided = ast.op === "and" ? !truthy(left) : truthy(left);
          return decided ? left : this.run(ast.right, scope);
        }
        const right = this.run(ast.right, scope);
        return binary(ast.op, left, right, { chained: ast.chained === true });
      }
      case "Dot":
        return this.dot(ast, scope);
      case "Call":
        return this.call(ast, scope);
      case "Method":
        return this.method(ast, scope);
    }
  }

  /** Items left to right; the first error wins (no short circuit needed: it is pure). */
  private list(items: readonly Expr[], scope: Scope): Result {
    const results: Result[] = [];
    for (const item of items) {
      const r = this.run(item, scope);
      if (r.type === "error") return r;
      results.push(r);
    }
    return collectList(results);
  }

  private name(name: string, scope: Scope): Result {
    if (!scope.itBindsNames) {
      return this.env.read(scope.thisId, name) ?? nameError(`no cell ${name} on this object`);
    }
    const item = scope.it;
    if (item?.type !== "ref") {
      return typeError(`bare name ${name} needs a reference item, got ${item?.type ?? "nothing"}`);
    }
    return this.cellOf(item.object, name);
  }

  /** A cell of a referenced object: `#REF` if deleted, `#NAME` if absent. */
  private cellOf(id: string, name: string): Result {
    if (!this.env.exists(id)) return err("#REF", `reference to deleted object ${id}`);
    return this.env.read(id, name) ?? nameError(`no cell ${name} on ${id}`);
  }

  private dot(ast: DotNode, scope: Scope): Result {
    const target = this.run(ast.target, scope);
    if (target.type === "error") return target;
    return this.access(target, ast.name);
  }

  /** Dot-access on a value; a list maps over its items and flattens one level. */
  private access(target: Value, name: string): Result {
    switch (target.type) {
      case "ref":
        return this.cellOf(target.object, name);
      case "empty":
        return EMPTY;
      case "roll":
        switch (name) {
          case "total":
            return num(target.total);
          case "dice":
            return list(target.dice.map(num));
          case "dropped":
            return list(target.dropped.map(num));
          case "expr":
            return dice(target.expr);
          default:
            return nameError(`a roll result has no ${name}`);
        }
      case "list": {
        const out: Value[] = [];
        for (const item of target.items) {
          const r = this.access(item, name);
          if (r.type === "error") return r;
          // A loop, not push(...items): a cell list can be arbitrarily long.
          if (r.type === "list") for (const x of r.items) out.push(x);
          else out.push(r);
        }
        return list(out);
      }
      default:
        return typeError(`cannot read .${name} of ${target.type}`);
    }
  }

  private context(scope: Scope): CallContext {
    return {
      scope,
      env: this.env,
      evaluate: (ast, inner) => this.run(ast, inner ?? scope),
    };
  }

  private arityError(def: FunctionDef, count: number): ErrorValue | undefined {
    if (count >= def.minArgs && count <= def.maxArgs) return undefined;
    const expected =
      def.minArgs === def.maxArgs ? `${def.minArgs}` : `${def.minArgs} to ${def.maxArgs}`;
    return typeError(`${def.name} takes ${expected} arguments, got ${count}`);
  }

  private call(ast: CallNode, scope: Scope): Result {
    const def = METHOD_NAMES.has(ast.name) ? undefined : this.registry.get(ast.name);
    if (def === undefined) return nameError(`unknown function ${ast.name}`);
    const arity = this.arityError(def, ast.args.length);
    if (arity) return arity;
    if (def.kind === "lazy") {
      return def.impl(ast.args, { ...this.context(scope), desc: false });
    }
    const args = ast.args.map((a) => this.run(a, scope));
    return this.applyEager(def, args, scope);
  }

  private method(ast: MethodNode, scope: Scope): Result {
    const def = this.registry.get(ast.name);
    if (def === undefined || def.kind !== "lazy") return nameError(`unknown method ${ast.name}`);
    const arity = this.arityError(def, ast.args.length);
    if (arity) return arity;
    return def.impl(ast.args, { ...this.context(scope), target: ast.target, desc: ast.desc });
  }

  private applyEager(def: EagerFunctionDef, args: Result[], scope: Scope): Result {
    if (!def.acceptsErrors) {
      for (const a of args) if (a.type === "error") return a;
    }
    const ctx = this.context(scope);
    if (def.broadcast === "none") return def.impl(args, ctx);
    return broadcastCall(args, (scalars) => def.impl(scalars, ctx));
  }
}

/**
 * Applies `f` elementwise when any argument is a list: list arguments pair
 * up by index (equal lengths, else `#TYPE`), scalars repeat, nested lists
 * recurse. The result list is built with `collectList`.
 */
function broadcastCall(args: readonly Result[], f: (args: readonly Result[]) => Result): Result {
  let length: number | undefined;
  for (const a of args) {
    if (a.type !== "list") continue;
    if (length === undefined) length = a.items.length;
    else if (a.items.length !== length) {
      return typeError(`list lengths differ: ${length} and ${a.items.length}`);
    }
  }
  if (length === undefined) return f(args);
  const results: Result[] = [];
  for (let i = 0; i < length; i++) {
    const r = broadcastCall(
      args.map((a) => (a.type === "list" ? (a.items[i] as Value) : a)),
      f,
    );
    if (r.type === "error") return r;
    results.push(r);
  }
  return collectList(results);
}
