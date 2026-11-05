/**
 * Dice notation: the v1 dialect of FORMULAS.md §2.2, its validation, and the
 * normalized expression that dice equality (§4) and fixture dice-script
 * matching (FIXTURES.md §5) compare. Pure and non-random.
 */

/** One pool: `[count]d(sides|F)` with its modifiers. */
export interface DiceTerm {
  sign: 1 | -1;
  count: number;
  /** Number of sides, or `"F"` for Fudge dice (results -1, 0, 1). */
  faces: number | "F";
  reroll?: { op: "<" | ">" | "="; n: number };
  explode: boolean;
  keep?: { mode: "kh" | "kl" | "dh" | "dl"; n: number };
}

/** A parsed dice value: pools in source order plus one folded integer constant. */
export interface DiceExpr {
  terms: DiceTerm[];
  constant: number;
}

/** A dice value that does not parse or breaks a limit. The evaluator maps it to `#TYPE`. */
export interface DiceError {
  error: string;
}

export const MAX_DICE_COUNT = 1000;
export const MIN_DICE_SIDES = 2;
export const MAX_DICE_SIDES = 1_000_000;

export function isDiceError(value: DiceExpr | DiceError): value is DiceError {
  return "error" in value;
}

function isWhitespace(ch: string | undefined): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= "0" && ch <= "9";
}

class DiceSyntaxError extends Error {}

/** Parses and validates a dice expression. Never throws. */
export function parseDice(expr: string): DiceExpr | DiceError {
  try {
    return new Parser(expr).parse();
  } catch (e) {
    if (e instanceof DiceSyntaxError) return { error: e.message };
    throw e;
  }
}

class Parser {
  private pos = 0;

  constructor(private readonly src: string) {}

  parse(): DiceExpr {
    const terms: DiceTerm[] = [];
    let constant = 0;
    const addItem = (sign: 1 | -1) => {
      const item = this.item(sign);
      if (typeof item === "number") {
        constant += sign * item;
        if (!Number.isSafeInteger(constant)) this.fail("integer constant is too large");
      } else {
        terms.push(item);
      }
    };

    this.skipWhitespace();
    let sign: 1 | -1 = 1;
    if (this.peek() === "-") {
      this.pos++;
      sign = -1;
    }
    addItem(sign);
    for (;;) {
      this.skipWhitespace();
      const ch = this.peek();
      if (ch === undefined) break;
      if (ch !== "+" && ch !== "-") this.fail(`unexpected ${JSON.stringify(ch)}`);
      this.pos++;
      this.skipWhitespace();
      addItem(ch === "+" ? 1 : -1);
    }
    if (terms.length === 0) this.fail("a dice expression needs at least one pool");
    // Adding 0 turns a folded -0 into 0.
    return { terms, constant: constant + 0 };
  }

  private item(sign: 1 | -1): DiceTerm | number {
    const start = this.pos;
    const count = isDigit(this.peek()) ? this.integer() : undefined;
    if (this.peek() !== "d") {
      if (count === undefined) {
        const ch = this.peek();
        this.fail(
          ch === undefined ? "expected a pool or an integer" : `unexpected ${JSON.stringify(ch)}`,
        );
      }
      if (!Number.isSafeInteger(count))
        this.fail(`integer ${this.src.slice(start, this.pos)} is too large`);
      return count;
    }
    this.pos++;
    return this.pool(sign, count ?? 1);
  }

  private pool(sign: 1 | -1, count: number): DiceTerm {
    if (count < 1 || count > MAX_DICE_COUNT) {
      this.fail(`dice count ${count} is outside 1..${MAX_DICE_COUNT}`);
    }
    let faces: number | "F";
    if (this.peek() === "F") {
      this.pos++;
      faces = "F";
    } else if (isDigit(this.peek())) {
      faces = this.integer();
      if (faces < MIN_DICE_SIDES || faces > MAX_DICE_SIDES) {
        this.fail(`dice sides ${faces} is outside ${MIN_DICE_SIDES}..${MAX_DICE_SIDES}`);
      }
    } else {
      this.fail("expected sides or F after d");
    }

    const term: DiceTerm = { sign, count, faces, explode: false };
    for (;;) {
      const ch = this.peek();
      const next = this.src[this.pos + 1];
      if ((ch === "k" || ch === "d") && (next === "h" || next === "l")) {
        const mode = (ch + next) as "kh" | "kl" | "dh" | "dl";
        this.pos += 2;
        if (term.keep) this.fail("at most one keep/drop modifier per pool");
        const n = this.modifierInteger(mode);
        if (mode === "kh" || mode === "kl") {
          if (n < 1 || n > count) this.fail(`${mode}${n}: keep count must be within 1..${count}`);
        } else if (n < 1 || n >= count) {
          this.fail(
            count === 1
              ? `${mode}${n}: cannot drop from a single die`
              : `${mode}${n}: drop count must be within 1..${count - 1}`,
          );
        }
        term.keep = { mode, n };
      } else if (ch === "!") {
        this.pos++;
        if (faces === "F") this.fail("Fudge dice cannot explode");
        if (term.explode) this.fail("at most one explode modifier per pool");
        term.explode = true;
      } else if (ch === "r") {
        this.pos++;
        const op = this.peek();
        if (op !== "<" && op !== ">" && op !== "=") this.fail("expected <, >, or = after r");
        this.pos++;
        const n = this.modifierInteger(`r${op}`);
        if (faces === "F") this.fail("Fudge dice cannot reroll");
        if (term.reroll) this.fail("at most one reroll modifier per pool");
        if (n < 1 || n > faces) this.fail(`r${op}${n}: reroll value must be within 1..${faces}`);
        term.reroll = { op, n };
      } else {
        break;
      }
    }
    const after = this.peek();
    if (after !== undefined && after !== "+" && after !== "-" && !isWhitespace(after)) {
      this.fail(`unexpected ${JSON.stringify(after)} after a pool`);
    }
    return term;
  }

  private modifierInteger(modifier: string): number {
    if (!isDigit(this.peek())) this.fail(`expected an integer after ${modifier}`);
    return this.integer();
  }

  private integer(): number {
    const start = this.pos;
    while (isDigit(this.peek())) this.pos++;
    return Number(this.src.slice(start, this.pos));
  }

  private skipWhitespace(): void {
    while (isWhitespace(this.peek())) this.pos++;
  }

  private peek(): string | undefined {
    return this.src[this.pos];
  }

  private fail(message: string): never {
    throw new DiceSyntaxError(message);
  }
}

function renderTerm(term: DiceTerm): string {
  let out = `${term.count}d${term.faces}`;
  if (term.reroll) out += `r${term.reroll.op}${term.reroll.n}`;
  if (term.explode) out += "!";
  if (term.keep) out += `${term.keep.mode}${term.keep.n}`;
  return out;
}

/**
 * Renders a dice expression in canonical form: terms in order, explicit
 * counts, modifiers ordered reroll, explode, keep/drop, the constant as one
 * trailing signed integer (omitted when 0), no spaces. The inverse of
 * `parseDice` on canonical input.
 */
export function renderDice(expr: DiceExpr): string {
  let out = "";
  expr.terms.forEach((term, i) => {
    if (term.sign < 0) out += "-";
    else if (i > 0) out += "+";
    out += renderTerm(term);
  });
  if (expr.constant > 0) out += `+${expr.constant}`;
  else if (expr.constant < 0) out += `${expr.constant}`;
  return out;
}

/**
 * The normalized expression of a dice value (FORMULAS.md §2.2). Throws a
 * `RangeError` if `expr` does not parse; callers hold validated dice values.
 */
export function normalizeDice(expr: string): string {
  const parsed = parseDice(expr);
  if (isDiceError(parsed)) throw new RangeError(`invalid dice expression: ${parsed.error}`);
  return renderDice(parsed);
}

/** Dice equality (FORMULAS.md §4): equal normalized expressions. */
export function diceEquals(a: string, b: string): boolean {
  return normalizeDice(a) === normalizeDice(b);
}
