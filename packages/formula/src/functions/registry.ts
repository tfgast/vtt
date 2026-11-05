/**
 * The function registry (FORMULAS.md §5, §6): how calls and methods find
 * their definitions. The evaluator does arity checks, argument evaluation,
 * error propagation, and broadcasting; a definition's `impl` sees only what
 * passed those steps.
 */
import type { Result } from "@vtt/schema";
import type { Scope } from "../eval/scope";
import type { EvalEnv } from "../host";
import type { Expr, MethodNode } from "../syntax/ast";

/** What every `impl` receives besides its arguments. */
export interface CallContext {
  /** The scope the call is evaluated in. */
  readonly scope: Scope;
  readonly env: EvalEnv;
  /**
   * Evaluates `ast` with the same env and registry, in `scope` (the call's
   * scope if omitted). Errors it returns already carry the scope's origin.
   */
  evaluate(ast: Expr, scope?: Scope): Result;
}

/** A lazy `impl`'s context: also the method target and `desc` flag. */
export interface LazyContext extends CallContext {
  /** For a method call (`xs.where(e)`), the target expression `xs`; absent for a function call. */
  readonly target?: Expr;
  /** True only for `.sort(e, desc)`. */
  readonly desc: boolean;
}

interface FunctionDefBase {
  /** The callee name, lowercase. `where` and `sort` are reachable only as methods. */
  readonly name: string;
  /** Inclusive bounds on the argument count (for a method, not counting the target). */
  readonly minArgs: number;
  readonly maxArgs: number;
  /**
   * `"scalar"`: an eager function applied elementwise when any argument is
   * a list (recursively; list arguments must have equal lengths, else
   * `#TYPE`; scalar arguments repeat). `"none"`: lists are passed whole.
   * Lazy functions must be `"none"`.
   */
  readonly broadcast: "none" | "scalar";
}

/**
 * Arguments are evaluated left to right, then (unless `acceptsErrors`) the
 * first error among them is the result, then broadcasting applies, then
 * `impl` runs. Without `acceptsErrors`, no argument is an error; with
 * broadcast `"scalar"`, no argument is a list.
 */
export interface EagerFunctionDef extends FunctionDefBase {
  readonly kind: "eager";
  /** Errors reach `impl` as arguments (`iserror`). */
  readonly acceptsErrors?: boolean;
  readonly impl: (args: readonly Result[], ctx: CallContext) => Result;
}

/**
 * `impl` receives the argument ASTs unevaluated and evaluates what it needs
 * through `ctx.evaluate` (`if`, `where`, `sort`, `objects`). For a method
 * call, `args` excludes the target, which is `ctx.target`.
 */
export interface LazyFunctionDef extends FunctionDefBase {
  readonly kind: "lazy";
  readonly broadcast: "none";
  readonly acceptsErrors?: undefined;
  readonly impl: (args: readonly Expr[], ctx: LazyContext) => Result;
}

export type FunctionDef = EagerFunctionDef | LazyFunctionDef;

/** The names that are methods (`.where`, `.sort`), never callable as functions. */
export const METHOD_NAMES: ReadonlySet<string> = new Set<MethodNode["name"]>(["where", "sort"]);

/** An immutable lookup from name to definition. */
export interface Registry {
  get(name: string): FunctionDef | undefined;
  /** Every registered name, in registration order. */
  names(): string[];
}

/**
 * A registry over `defs`. Throws on a duplicate name, an invalid arity
 * range, a lazy function that broadcasts, or a method name (`where`,
 * `sort`) registered as an eager function.
 */
export function createRegistry(defs: readonly FunctionDef[]): Registry {
  const byName = new Map<string, FunctionDef>();
  for (const def of defs) {
    const { name, minArgs, maxArgs } = def;
    if (byName.has(name)) throw new Error(`duplicate function ${name}`);
    if (
      !Number.isInteger(minArgs) ||
      !Number.isInteger(maxArgs) ||
      minArgs < 0 ||
      maxArgs < minArgs
    ) {
      throw new Error(`function ${name} has an invalid arity ${minArgs}..${maxArgs}`);
    }
    if (def.kind === "lazy" && def.broadcast !== "none") {
      throw new Error(`lazy function ${name} cannot broadcast`);
    }
    if (METHOD_NAMES.has(name) && def.kind !== "lazy") {
      throw new Error(`method ${name} must be lazy`);
    }
    byName.set(name, def);
  }
  return {
    get: (name) => byName.get(name),
    names: () => [...byName.keys()],
  };
}
