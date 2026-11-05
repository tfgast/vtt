/**
 * Dice sources (FORMULAS.md §2.2, §8.3: `roll` and `shuffle` are the only
 * randomness; FIXTURES.md §5: the dice script; DESIGN.md §7: dice
 * consumption is transactional).
 *
 * A `DiceSource` hands out roll results and permutations, and can be marked
 * and reset so a transaction that is refused or aborts consumes nothing:
 * `transactWithDice` marks the source before the transaction and resets it
 * on either pre-commit failure, never after the commit point.
 *
 * - `RandomDiceSource(seed)`: a seeded PRNG (splitmix32, below) whose whole
 *   state is one 32-bit integer, so a mark is a copy of the state.
 * - `ScriptedDiceSource(entries)`: hands out FIXTURES §5 entries in order;
 *   running out, a kind mismatch, or an `expr` not equal by normalized
 *   expression is a `ScenarioError` (the fixture is wrong).
 */
import {
  type DiceExpr,
  normalizeDice,
  type RandomSource,
  renderDice,
  rollDice,
} from "@vtt/formula";
import type { Actor, ObjectId, RollValue } from "@vtt/schema";
import type { TransactResult } from "../store/document-store";
import { reorder, rollWrite } from "../store/edits";
import type { Transaction, TransactionMeta } from "../store/transaction";
import type { Table } from "./table";

/**
 * A scenario's own fault (FIXTURES.md §5): the dice script ran out, or its
 * next entry is of the wrong kind or for different dice. Distinct from an
 * engine failure and from a rejection; never caught as a refusal.
 */
export class ScenarioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioError";
  }
}

/** The randomness actions consume (FORMULAS §8.3 `roll`, `shuffle`). */
export interface DiceSource {
  /** A roll result for `dice` (a dice value's expression). */
  roll(dice: string | DiceExpr): RollValue;
  /**
   * A permutation `order` of `0..n-1`; a shuffle sets
   * `new[i] = old[order[i]]` (FIXTURES §5).
   */
  permutation(n: number): number[];
  /** A token for the source's current state. */
  mark(): number;
  /** Restores the state `mark` returned: later draws are as if none happened since. */
  reset(mark: number): void;
}

// ------------------------------------------------------------------ random

/**
 * A seeded source. The generator is splitmix32: a 32-bit Weyl sequence
 * (state += 0x9e3779b9, the golden-ratio increment) passed through the
 * MurmurHash3 32-bit finalizer. The finalizer is a bijection, so each output
 * appears exactly once per period of 2^32. The whole state is the counter,
 * so `mark()` returns it and `reset` restores it exactly, whatever ranges
 * are requested afterwards. Not cryptographic.
 *
 * Integers in a range are unbiased: a 32-bit draw is rejected when it falls
 * in the incomplete last block of the range, then reduced modulo the range.
 * Rolls go through `rollDice`; permutations are Fisher–Yates.
 */
export class RandomDiceSource implements DiceSource {
  #state: number;

  constructor(seed: number) {
    if (!Number.isFinite(seed)) throw new RangeError(`seed must be a finite number: ${seed}`);
    this.#state = Math.trunc(seed) >>> 0;
  }

  /** The next 32-bit output, as an unsigned integer. */
  #next(): number {
    this.#state = (this.#state + 0x9e3779b9) >>> 0;
    let z = this.#state;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  }

  /** An integer in `min..max`, both inclusive, uniformly; the span is at most 2^32. */
  #int(min: number, max: number): number {
    const span = max - min + 1;
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || span < 1 || span > 2 ** 32) {
      throw new RangeError(`no uniform integer in ${min}..${max}`);
    }
    const limit = 2 ** 32 - (2 ** 32 % span);
    for (;;) {
      const u = this.#next();
      if (u < limit) return min + (u % span);
    }
  }

  roll(dice: string | DiceExpr): RollValue {
    const rng: RandomSource = { int: (min, max) => this.#int(min, max) };
    return rollDice(dice, rng);
  }

  permutation(n: number): number[] {
    if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`not a length: ${n}`);
    const order = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = this.#int(0, i);
      [order[i], order[j]] = [order[j] as number, order[i] as number];
    }
    return order;
  }

  mark(): number {
    return this.#state;
  }

  reset(mark: number): void {
    this.#state = mark >>> 0;
  }
}

// ---------------------------------------------------------------- scripted

/** One dice script entry (FIXTURES.md §5). */
export type ScriptedDiceEntry = RollValue | { type: "permutation"; order: number[] };

/** Hands out a FIXTURES §5 dice script in order. */
export class ScriptedDiceSource implements DiceSource {
  readonly #entries: readonly ScriptedDiceEntry[];
  #position = 0;

  constructor(entries: readonly ScriptedDiceEntry[]) {
    this.#entries = structuredClone(entries) as ScriptedDiceEntry[];
  }

  /** Entries not yet handed out. */
  remaining(): number {
    return this.#entries.length - this.#position;
  }

  #take(kind: ScriptedDiceEntry["type"], what: string): ScriptedDiceEntry {
    const entry = this.#entries[this.#position];
    if (entry === undefined) {
      throw new ScenarioError(`dice script exhausted: ${what} needs entry ${this.#position}`);
    }
    if (entry.type !== kind) {
      throw new ScenarioError(
        `dice script entry ${this.#position} is a ${entry.type}, but ${what} needs a ${kind}`,
      );
    }
    return entry;
  }

  /**
   * The next entry, which must be a roll whose `expr` equals `dice` by
   * normalized expression (FORMULAS §2.2); returned as given (a copy). A
   * `dice` that does not parse is the caller's error (RangeError); an entry
   * `expr` that does not parse is a ScenarioError.
   */
  roll(dice: string | DiceExpr): RollValue {
    const wanted = typeof dice === "string" ? normalizeDice(dice) : renderDice(dice);
    const entry = this.#take("roll", `roll(${wanted})`) as RollValue;
    let scripted: string;
    try {
      scripted = normalizeDice(entry.expr);
    } catch {
      throw new ScenarioError(
        `dice script entry ${this.#position}: "${entry.expr}" is not a dice expression`,
      );
    }
    if (scripted !== wanted) {
      throw new ScenarioError(
        `dice script entry ${this.#position} rolls ${scripted}, but the step rolls ${wanted}`,
      );
    }
    this.#position++;
    return structuredClone(entry);
  }

  /** The next entry, which must be a permutation of `0..n-1`. */
  permutation(n: number): number[] {
    const entry = this.#take("permutation", `a shuffle of ${n}`) as { order: number[] };
    const order = entry.order;
    const seen = new Set(order);
    const valid =
      order.length === n &&
      seen.size === n &&
      order.every((i) => Number.isInteger(i) && i >= 0 && i < n);
    if (!valid) {
      throw new ScenarioError(
        `dice script entry ${this.#position} [${order.join(", ")}] is not a permutation of ${n}`,
      );
    }
    this.#position++;
    return [...order];
  }

  mark(): number {
    return this.#position;
  }

  reset(mark: number): void {
    if (!Number.isInteger(mark) || mark < 0 || mark > this.#entries.length) {
      throw new RangeError(`not a mark of this script: ${mark}`);
    }
    this.#position = mark;
  }
}

// -------------------------------------------------------------- with steps

/** Rolls `dice` from `source` and writes the roll into `obj`.`cell` (`rollWrite`). */
export function rollInto(
  tx: Transaction,
  source: DiceSource,
  obj: ObjectId,
  cell: string,
  dice: string | DiceExpr,
): RollValue {
  const roll = source.roll(dice);
  rollWrite(tx, obj, cell, roll);
  return roll;
}

/**
 * Draws a permutation of `container`'s current length from `source` and
 * reorders its contents by it (`reorder`). An empty container still draws
 * (a scripted shuffle of length 0 consumes its entry).
 */
export function shuffleWith(tx: Transaction, source: DiceSource, container: ObjectId): number[] {
  const order = source.permutation(tx.doc.contentsOf(container).length);
  reorder(tx, container, order);
  return order;
}

/**
 * `table.store.transact` with transactional dice: marks `source`, and resets
 * it if the transaction fails before the commit point. A `Rejected` returns
 * the rejection; any other error (a `ScenarioError` included) propagates
 * unchanged. After the commit point the source is never reset, even when a
 * public listener throws. So a refused or aborted transaction consumes no
 * randomness and no script entries.
 */
export function transactWithDice(
  table: Pick<Table, "store">,
  actor: Actor,
  meta: TransactionMeta,
  source: DiceSource,
  fn: (tx: Transaction) => void,
): TransactResult {
  const mark = source.mark();
  return table.store.transact(actor, meta, fn, { onAbort: () => source.reset(mark) });
}
