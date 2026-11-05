/**
 * The cell input grammar shared by the formula bar, the inspector and the
 * in-place editor (DESIGN.md §4.6 **Typing into a cell**, M4-D6; FORMULAS.md
 * §2, §3.1, §3.2), its inverse for prefilling editors, and the capability
 * matrix every editor consults before offering editing. Pure.
 */
import { type Expr, isDiceError, parse, parseDice, renderDice } from "@vtt/formula";
import type {
  CellView,
  InputCellContent,
  InputRefValue,
  InputValue,
  InputViewers,
  WireResult,
  WireValue,
} from "@vtt/protocol";
import { isValidId } from "@vtt/schema";

// ---------------------------------------------------------------------------
// Parsing input

export type CellInputResult =
  | { ok: true; content: InputCellContent }
  | { ok: false; message: string };

/**
 * Parses what was typed into cell `cell`, in this order:
 *
 * 1. `name`: the text verbatim, even with a leading `=`.
 * 2. A leading `=`: a formula of the rest, which must parse.
 * 3. `visible_to`: `all`, `gm`, `owner`, `@id`, comma-separated, as viewers.
 * 4. The empty string is `empty`; `@id` (a valid, unreserved id) is a ref.
 * 5. A leading `[`: the list grammar (items are scalar literals, `@id` or
 *    nested lists); input that fails it is text.
 * 6. A literal-only formula: a number with optional prefix minus, quoted
 *    text, `true`/`false`, `empty`, or a valid dice expression (normalized).
 * 7. Anything else: the text verbatim.
 */
export function parseCellInput(text: string, opts: { cell: string }): CellInputResult {
  if (opts.cell === "name") return accept({ type: "text", value: text });
  if (text.startsWith("=")) {
    const source = text.slice(1);
    const parsed = parse(source);
    if (!parsed.ok) return { ok: false, message: parsed.message };
    return { ok: true, content: { type: "formula", source } };
  }
  if (opts.cell === "visible_to") {
    const viewers = parseViewers(text);
    if (viewers) return accept(viewers);
  }
  if (text === "") return accept({ type: "empty" });
  const atRef = parseAtRef(text.trim());
  if (atRef) return accept(atRef);
  if (text.trimStart().startsWith("[")) {
    return accept(parseList(text) ?? { type: "text", value: text });
  }
  return accept(parseScalarLiteral(text) ?? { type: "text", value: text });
}

function accept(content: InputCellContent): CellInputResult {
  return { ok: true, content };
}

function parseAtRef(s: string): InputRefValue | null {
  if (!s.startsWith("@")) return null;
  const id = s.slice(1);
  return isValidId(id) ? { type: "ref", object: id } : null;
}

function parseViewers(text: string): InputViewers | null {
  const viewers: InputViewers["viewers"] = [];
  for (const part of text.split(",")) {
    const entry = part.trim();
    if (entry === "all" || entry === "gm" || entry === "owner") {
      viewers.push(entry);
      continue;
    }
    const atRef = parseAtRef(entry);
    if (!atRef) return null;
    viewers.push(atRef);
  }
  return { type: "viewers", viewers };
}

/** Step 6: the value of `s` when it is a literal-only formula, else null. */
function parseScalarLiteral(s: string): InputValue | null {
  const parsed = parse(s);
  if (!parsed.ok) return null;
  const ast = parsed.ast;
  // A parenthesized node has its span widened over the parentheses; literal
  // syntax has none (dice notation rejects them itself).
  const wrapped = (node: Expr) => s[node.start] === "(";
  if (wrapped(ast)) return null;
  switch (ast.kind) {
    case "Number":
      return { type: "number", value: ast.value };
    case "Unary":
      if (ast.op === "-" && ast.operand.kind === "Number" && !wrapped(ast.operand)) {
        return { type: "number", value: -ast.operand.value };
      }
      return diceLiteral(s, ast);
    case "Text":
      return { type: "text", value: ast.value };
    case "Boolean":
      return { type: "boolean", value: ast.value };
    case "Empty":
      return { type: "empty" };
    default:
      return diceLiteral(s, ast);
  }
}

/** Dice terms and integers combined with `+`/`-`, valid per FORMULAS §2.2. */
function diceLiteral(s: string, ast: Expr): InputValue | null {
  let hasDice = false;
  const shapeOk = (node: Expr, leftmost: boolean): boolean => {
    switch (node.kind) {
      case "Dice":
        hasDice = true;
        return true;
      case "Number":
        return Number.isInteger(node.value);
      case "Unary":
        return leftmost && node.op === "-" && shapeOk(node.operand, false);
      case "Binary":
        return (
          (node.op === "+" || node.op === "-") &&
          shapeOk(node.left, leftmost) &&
          shapeOk(node.right, false)
        );
      default:
        return false;
    }
  };
  if (!shapeOk(ast, true) || !hasDice) return null;
  const dice = parseDice(s);
  if (isDiceError(dice)) return null;
  return { type: "dice", expr: renderDice(dice) };
}

/** Step 5: the whole input as one list, or null if it breaks the grammar. */
function parseList(text: string): InputValue | null {
  const reader = new ListReader(text);
  const value = reader.list();
  if (value === null) return null;
  reader.skipWhitespace();
  return reader.done() ? value : null;
}

const WS = /[ \t\n\r]/;

class ListReader {
  private pos = 0;

  constructor(private readonly src: string) {}

  done(): boolean {
    return this.pos >= this.src.length;
  }

  skipWhitespace(): void {
    while (this.pos < this.src.length && WS.test(this.src[this.pos] as string)) this.pos++;
  }

  list(): InputValue | null {
    this.skipWhitespace();
    if (this.src[this.pos] !== "[") return null;
    this.pos++;
    const items: InputValue[] = [];
    this.skipWhitespace();
    if (this.src[this.pos] === "]") {
      this.pos++;
      return { type: "list", items };
    }
    for (;;) {
      const item = this.item();
      if (item === null) return null;
      items.push(item);
      this.skipWhitespace();
      const ch = this.src[this.pos];
      this.pos++;
      if (ch === "]") return { type: "list", items };
      if (ch !== ",") return null;
    }
  }

  private item(): InputValue | null {
    this.skipWhitespace();
    const ch = this.src[this.pos];
    if (ch === "[") return this.list();
    if (ch === '"') return this.quoted();
    const start = this.pos;
    while (this.pos < this.src.length && !',]["'.includes(this.src[this.pos] as string)) {
      this.pos++;
    }
    const raw = this.src.slice(start, this.pos).trim();
    if (raw === "") return null;
    return parseAtRef(raw) ?? parseScalarLiteral(raw);
  }

  /** Quoted text with FORMULAS §3.2 escapes (`\"` and `\\` only). */
  private quoted(): InputValue | null {
    this.pos++;
    let value = "";
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos] as string;
      this.pos++;
      if (ch === '"') return { type: "text", value };
      if (ch === "\\") {
        const next = this.src[this.pos];
        if (next !== '"' && next !== "\\") return null;
        value += next;
        this.pos++;
      } else {
        value += ch;
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Formatting values back to input

export type ValueInputText =
  | { kind: "literal"; text: string }
  | { kind: "unsupported"; reason: string };

export type InputText = { kind: "formula"; source: string } | ValueInputText;

/**
 * What an editor of the formula source starts from: the source of a formula
 * cell when the view carries it (GM views), else the value's input text.
 * A pure formatter; whether the cell may be edited is `cellCapabilities`.
 */
export function toInputText(cell: CellView, cellName: string): InputText {
  if (cell.kind === "formula" && cell.source !== undefined) {
    return { kind: "formula", source: cell.source };
  }
  return valueToInputText(cell.value, cellName);
}

class Unsupported extends Error {}

/**
 * The input text that `parseCellInput(text, {cell: cellName})` reads back as
 * `value`, or `unsupported` with a reason when no input text does. An empty
 * `name` is `""`, which reads back as the text `""` (`name` input is always
 * text).
 */
export function valueToInputText(value: WireResult, cellName: string): ValueInputText {
  try {
    const text = literalText(value, cellName);
    if (cellName === "name" && value.type === "empty") return { kind: "literal", text };
    const back = parseCellInput(text, { cell: cellName });
    if (!back.ok || !contentEquals(back.content, value)) {
      return unsupported(`${describeKind(value)} cannot be typed into ${cellName}`);
    }
    return { kind: "literal", text };
  } catch (e) {
    if (e instanceof Unsupported) return unsupported(e.message);
    throw e;
  }
}

function unsupported(reason: string): ValueInputText {
  return { kind: "unsupported", reason };
}

function literalText(value: WireResult, cellName: string): string {
  if (cellName === "name") {
    if (value.type === "text") return value.value;
    if (value.type === "empty") return "";
    throw new Unsupported(`a name holding ${describeKind(value)} cannot be typed`);
  }
  if (cellName === "visible_to" && value.type === "viewers") {
    return value.viewers
      .map((entry) => {
        if (typeof entry === "string") return entry;
        if (entry.type === "redacted") throw new Unsupported("some viewers are hidden");
        return `@${entry.object}`;
      })
      .join(", ");
  }
  if (value.type === "text") {
    const back = parseCellInput(value.value, { cell: cellName });
    const bare = back.ok && back.content.type === "text" && back.content.value === value.value;
    return bare ? value.value : quote(value.value);
  }
  return itemText(value);
}

/** A value in literal syntax as it appears inside a list (text always quoted). */
function itemText(value: WireResult): string {
  switch (value.type) {
    case "number":
      return numberText(value.value);
    case "text":
      return quote(value.value);
    case "boolean":
      return String(value.value);
    case "empty":
      return "empty";
    case "dice": {
      const dice = parseDice(value.expr);
      if (isDiceError(dice)) throw new Unsupported(`invalid dice ${value.expr}`);
      return renderDice(dice);
    }
    case "ref":
      return `@${value.object}`;
    case "list":
      return `[${value.items.map(itemText).join(", ")}]`;
    default:
      throw new Unsupported(`${describeKind(value)} cannot be typed`);
  }
}

function describeKind(value: WireResult): string {
  switch (value.type) {
    case "roll":
      return "a roll result";
    case "error":
      return `an error (${value.code})`;
    case "shape":
      return "a shape";
    case "ink":
      return "ink";
    case "viewers":
      return "a viewers value";
    case "redacted":
      return "a hidden value";
    case "list":
      return "this list";
    case "empty":
      return "empty";
    case "ref":
      return "a reference";
    default:
      return `a ${value.type}`;
  }
}

function quote(s: string): string {
  return `"${s.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/** Digits, never exponent notation; the shortest decimal that reads back as `n`. */
function numberText(n: number): string {
  if (!Number.isFinite(n)) throw new Unsupported("a non-finite number cannot be typed");
  if (Number.isInteger(n)) return BigInt(n).toString();
  const text = expandExponent(String(n));
  if (Number(text) !== n) throw new Unsupported(`${n} has no exact decimal form`);
  return text;
}

/** `1.5e-7` → `0.00000015`, `1.5e+22` → `15000000000000000000000`. */
function expandExponent(s: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
  if (!match) return s;
  const [, sign, intPart = "", fracPart = "", expText = "0"] = match;
  const digits = intPart + fracPart;
  const point = intPart.length + Number(expText);
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return sign + digits + "0".repeat(point - digits.length);
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

function contentEquals(a: InputCellContent, b: InputCellContent | WireResult): boolean {
  if (a.type === "formula" || b.type === "formula") {
    return a.type === "formula" && b.type === "formula" && a.source.trim() === b.source.trim();
  }
  return valueEquals(a, b);
}

type AnyValue = InputValue | WireValue | WireResult;

function valueEquals(a: AnyValue, b: AnyValue): boolean {
  switch (a.type) {
    case "number":
      return b.type === "number" && a.value === b.value;
    case "text":
      return b.type === "text" && a.value === b.value;
    case "boolean":
      return b.type === "boolean" && a.value === b.value;
    case "empty":
      return b.type === "empty";
    case "dice":
      return b.type === "dice" && sameDice(a.expr, b.expr);
    case "ref":
      return b.type === "ref" && a.object === b.object;
    case "list":
      return (
        b.type === "list" &&
        a.items.length === b.items.length &&
        a.items.every((item, i) => valueEquals(item, b.items[i] as AnyValue))
      );
    case "viewers":
      return (
        b.type === "viewers" &&
        a.viewers.length === b.viewers.length &&
        a.viewers.every((entry, i) => {
          const other = b.viewers[i];
          if (typeof entry === "string" || typeof other === "string") return entry === other;
          return other !== undefined && valueEquals(entry, other);
        })
      );
    default:
      // Rolls, ink, shapes, errors and redacted values are never typed.
      return false;
  }
}

function sameDice(a: string, b: string): boolean {
  const da = parseDice(a);
  const db = parseDice(b);
  if (isDiceError(da) || isDiceError(db)) return a === b;
  return renderDice(da) === renderDice(db);
}

// ---------------------------------------------------------------------------
// Unchanged input

/**
 * Whether committing `after` over `before` in `cellName` would write the same
 * content: both are parsed for that cell and compared structurally (formulas
 * by source without surrounding whitespace, text exactly, values by value).
 * Editors write nothing when it is true.
 */
export function isUnchangedInput(before: string, after: string, cellName: string): boolean {
  if (before === after) return true;
  const a = parseCellInput(before, { cell: cellName });
  const b = parseCellInput(after, { cell: cellName });
  if (!a.ok || !b.ok) return false;
  return contentEquals(a.content, b.content);
}

// ---------------------------------------------------------------------------
// Capabilities

/** The dedicated control that edits a cell instead of (or besides) text input. */
export type CellControl = "shape" | "tag" | "contents" | "placement" | "flags";

export interface CellCapabilities {
  /** A literal (or an override, on a formula cell) may be typed. */
  literal: boolean;
  /** A formula may be typed (`=`). */
  formula: boolean;
  /** "Replace formula with value" is offered: formula allowed and the cell holds one. */
  replace: boolean;
  control?: CellControl;
}

const CONTROL_ONLY: Readonly<Record<string, CellControl | null>> = {
  id: null,
  template: null,
  is_zone: null,
  tag: "tag",
  contents: "contents",
  shape: "shape",
  board: "placement",
  container: "placement",
  is_template: "flags",
  is_character: "flags",
};

const PLACEMENT_VALUES: ReadonlySet<string> = new Set(["position", "rotation", "z"]);

/**
 * What editing `cellName` allows (DESIGN.md §4.6; FORMULAS.md §3.1). With
 * `readOnly` (character views) nothing is editable.
 */
export function cellCapabilities(
  cellName: string,
  view: CellView | undefined,
  opts?: { readOnly?: boolean },
): CellCapabilities {
  if (opts?.readOnly) return { literal: false, formula: false, replace: false };
  if (Object.hasOwn(CONTROL_ONLY, cellName)) {
    const control = CONTROL_ONLY[cellName];
    const caps: CellCapabilities = { literal: false, formula: false, replace: false };
    if (control) caps.control = control;
    return caps;
  }
  if (cellName === "name") return { literal: true, formula: false, replace: false };
  const caps: CellCapabilities = {
    literal: true,
    formula: true,
    replace: view?.kind === "formula",
  };
  if (PLACEMENT_VALUES.has(cellName)) caps.control = "placement";
  return caps;
}
