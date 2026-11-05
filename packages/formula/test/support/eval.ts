/**
 * Parses and evaluates a formula over a FakeEnv, for the evaluator tests.
 * A parse failure throws: these tests are about evaluation, not syntax.
 */
import { evaluate, parse, type Registry, type Scope } from "@vtt/formula";
import type { Result } from "@vtt/schema";
import { type FakeCells, FakeEnv } from "./fake-env";

export interface RunOptions {
  /** Defaults to `{ thisId: "self" }`. */
  scope?: Scope;
  /** Defaults to the package's default registry. */
  registry?: Registry;
}

export function parseOrThrow(source: string) {
  const parsed = parse(source);
  if (!parsed.ok) throw new Error(`parse failed: ${parsed.message} at ${parsed.offset}`);
  return parsed.ast;
}

/** Evaluates `source` with `self` as `this` over `cells` (or an env). */
export function run(
  source: string,
  cells: FakeCells | FakeEnv = {},
  options: RunOptions = {},
): Result {
  const env = cells instanceof FakeEnv ? cells : new FakeEnv({ self: {}, ...cells });
  const scope = options.scope ?? { thisId: "self" };
  const ast = parseOrThrow(source);
  return options.registry === undefined
    ? evaluate(ast, scope, env)
    : evaluate(ast, scope, env, options.registry);
}
