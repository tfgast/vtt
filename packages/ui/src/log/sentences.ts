/**
 * Log sentences (vtt-1xv.20; DESIGN.md §4.8 the log panel, M5-D21;
 * PROTOCOL.md §7.6 group views). Pure: a group view becomes one header and
 * one sentence per effect, with object names as captured at commit
 * (`names`) and "an object" when a name is absent (not captured, or not
 * readable by the viewer). Values are formatted with `formatValue` in
 * compact mode. `allocate` and `retire` effects have no sentence. A move
 * onto a board folds the same object's `position` write of the group into
 * its sentence ("Moved Goblin onto Crypt at (3, 4)"). An `add` step's write
 * (a cell effect with `added`) reads "Added 14 to G1.damage_taken (now 20)",
 * or "Subtracted 3 from … (now 17)" for a negative amount (M6-D22).
 */
import type {
  CellStateView,
  EffectView,
  GroupView,
  LocationView,
  Viewer,
  WireResult,
  WireValue,
  WireViewers,
} from "@vtt/protocol";
import type { Actor, BoardId, ObjectId } from "@vtt/schema";
import { formatValue, type RefLabel } from "../values/format";

/** One effect as a sentence, linked to the object it touched (null: none, e.g. a board). */
export interface LogSentence {
  readonly text: string;
  readonly object: ObjectId | null;
}

export interface GroupDescription {
  readonly index: number;
  /** "GM", the agent's name ("Agent" without one), or the character's captured name or id. */
  readonly actor: string;
  readonly actorType: Actor["type"];
  /** The label, or the kind when the label is null (a reduced character group view). */
  readonly title: string;
  /** `<actor>: <title>`. */
  readonly header: string;
  readonly kind: GroupView["kind"];
  readonly undone: boolean;
  readonly sentences: readonly LogSentence[];
}

export interface DescribeOptions {
  /** A board's display name; defaults to the board id. */
  boardName?: (board: BoardId) => string;
}

const AN_OBJECT = "an object";

/** The display name of the group's actor (PROTOCOL.md §3). */
export function actorName(actor: Actor, names: Readonly<Record<ObjectId, string>>): string {
  switch (actor.type) {
    case "gm":
      return "GM";
    case "agent":
      return actor.name !== undefined && actor.name !== "" ? actor.name : "Agent";
    case "character":
      return names[actor.id] ?? actor.id;
  }
}

/** A header and one sentence per effect for `group` as `viewer` sees it. */
export function describeGroup(
  group: GroupView,
  viewer: Viewer,
  options: DescribeOptions = {},
): GroupDescription {
  const actor = actorName(group.actor, group.names);
  const title = group.label ?? group.kind;
  return {
    index: group.index,
    actor,
    actorType: group.actor.type,
    title,
    header: `${actor}: ${title}`,
    kind: group.kind,
    undone: group.undone,
    sentences: sentencesOf(group, viewer, options),
  };
}

/** The text a filter matches: the header, the label and the captured names. */
export function groupSearchText(group: GroupView): string {
  return [
    actorName(group.actor, group.names),
    group.label ?? group.kind,
    ...Object.values(group.names),
  ]
    .join("\n")
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Sentences

interface Context {
  readonly names: Readonly<Record<ObjectId, string>>;
  readonly refLabel: RefLabel;
  readonly boardName: (board: BoardId) => string;
}

function sentencesOf(group: GroupView, viewer: Viewer, options: DescribeOptions): LogSentence[] {
  const effects = group.effects ?? [];
  const names = group.names;
  const ctx: Context = {
    names,
    // A ref to an object with no captured name: its id for the GM, never an id for a character.
    refLabel: (id) => names[id] ?? (viewer.type === "gm" ? null : AN_OBJECT),
    boardName: options.boardName ?? ((board) => board),
  };
  // Positions written alongside a move onto a board, folded into the move's sentence.
  const placed = new Set<ObjectId>();
  for (const e of effects) {
    if (e.type === "place" && e.after.type === "board") placed.add(e.object);
  }
  const positions = new Map<ObjectId, CellStateView | null>();
  for (const e of effects) {
    if (e.type === "cell" && e.cell === "position" && placed.has(e.object)) {
      positions.set(e.object, e.after);
    }
  }
  const out: LogSentence[] = [];
  for (const e of effects) {
    if (e.type === "cell" && e.cell === "position" && placed.has(e.object)) continue;
    const sentence = sentenceOf(e, ctx, positions);
    if (sentence !== null) out.push(sentence);
  }
  return out;
}

const objectName = (ctx: Context, id: ObjectId) => ctx.names[id] ?? AN_OBJECT;

/** A value in compact form; `empty` reads "empty" rather than nothing. */
function value(v: WireResult, ctx: Context): string {
  if (v.type === "empty") return "empty";
  return formatValue(v, { mode: "compact", refLabel: ctx.refLabel }).text;
}

/** A cell's stored state, for "(was …)". */
function state(s: CellStateView, ctx: Context): string {
  if (s.kind === "literal") return value(s.value, ctx);
  const formula = s.source === undefined ? "a formula" : `the formula "${s.source}"`;
  return s.override === undefined ? formula : `${value(s.override, ctx)}, overriding ${formula}`;
}

const was = (before: CellStateView | null, ctx: Context) =>
  before === null ? "" : ` (was ${state(before, ctx)})`;

function sentenceOf(
  e: EffectView,
  ctx: Context,
  positions: ReadonlyMap<ObjectId, CellStateView | null>,
): LogSentence | null {
  switch (e.type) {
    case "cell":
      return { text: cellSentence(e, ctx), object: e.object };
    case "cell_visibility": {
      const where = `${objectName(ctx, e.object)}.${e.cell}`;
      return {
        text:
          e.after === null
            ? `Reset the visibility of ${where}`
            : `Made ${where} visible to ${viewers(e.after, ctx)}`,
        object: e.object,
      };
    }
    case "field":
      return { text: fieldSentence(e, ctx), object: e.object };
    case "place": {
      const name = objectName(ctx, e.object);
      if (e.after.type === "board") {
        const position = positions.get(e.object);
        return {
          text: `Moved ${name} onto ${ctx.boardName(e.after.board)}${at(position ?? null)}`,
          object: e.object,
        };
      }
      return { text: `Moved ${name} into ${container(e.after.container, ctx)}`, object: e.object };
    }
    case "create":
    case "remove": {
      const verb = e.type === "create" ? "Created" : "Removed";
      const preposition =
        e.location.type === "board" ? (e.type === "create" ? "on" : "from") : "in";
      return {
        text: `${verb} ${list(
          e.objects.map((o) => objectName(ctx, o.id)),
        )} ${preposition} ${location(e.location, ctx)}`,
        object: e.objects[0]?.id ?? null,
      };
    }
    case "reorder":
      return {
        text: `Reordered the contents of ${objectName(ctx, e.container)}`,
        object: e.container,
      };
    case "board": {
      const name = (b: { id: BoardId; name?: string | undefined }) =>
        b.name !== undefined && b.name !== "" ? b.name : b.id;
      if (e.before === null && e.after !== null) {
        return { text: `Added the board ${name(e.after)}`, object: null };
      }
      if (e.after === null && e.before !== null) {
        return { text: `Removed the board ${name(e.before)}`, object: null };
      }
      if (e.before !== null && e.after !== null) {
        return { text: `Renamed the board ${name(e.before)} to ${name(e.after)}`, object: null };
      }
      return null;
    }
    case "allocate":
    case "retire":
      return null;
  }
}

function cellSentence(e: Extract<EffectView, { type: "cell" }>, ctx: Context): string {
  const where = `${objectName(ctx, e.object)}.${e.cell}`;
  const { before, after } = e;
  if (e.cause === "roll" && after?.kind === "literal") {
    const v = after.value;
    const rolled = v.type === "roll" ? `${v.expr} → ${value(v, ctx)}` : value(v, ctx);
    return `Rolled ${rolled} into ${where}`;
  }
  if (after === null) {
    return before === null ? `Deleted ${where}` : `Deleted ${where}${was(before, ctx)}`;
  }
  // An add step's write (M6-D22): the amount added and the resulting value.
  const now = after.kind === "literal" ? after.value : after.override;
  if (e.added !== undefined && now !== undefined) {
    const amount = number(Math.abs(e.added));
    const result = `(now ${value(now, ctx)})`;
    return e.added < 0
      ? `Subtracted ${amount} from ${where} ${result}`
      : `Added ${amount} to ${where} ${result}`;
  }
  if (before?.kind === "formula" && after.kind === "formula" && before.source === after.source) {
    if (after.override !== undefined) {
      const old = before.override === undefined ? "" : ` (was ${value(before.override, ctx)})`;
      return `Overrode ${where} with ${value(after.override, ctx)}${old}`;
    }
    if (before.override !== undefined) {
      return `Cleared the override on ${where} (was ${value(before.override, ctx)})`;
    }
  }
  if (after.kind === "formula") {
    const formula = after.source === undefined ? "a formula" : `the formula "${after.source}"`;
    return `Set ${where} to ${formula}${was(before, ctx)}`;
  }
  return `Set ${where} to ${value(after.value, ctx)}${was(before, ctx)}`;
}

function fieldSentence(e: Extract<EffectView, { type: "field" }>, ctx: Context): string {
  const name = objectName(ctx, e.object);
  switch (e.field) {
    case "tag":
      return `Set the tags of ${name} to ${e.after.length === 0 ? "none" : e.after.join(", ")}`;
    case "shape":
      return e.after === null
        ? `Removed the shape of ${name}`
        : `Set the shape of ${name} to ${value({ type: "shape", shape: e.after }, ctx)}`;
    case "is_template":
      return e.after ? `Made ${name} a template` : `Made ${name} no longer a template`;
    case "is_character":
      return e.after ? `Made ${name} a character` : `Made ${name} no longer a character`;
    case "actions":
      return e.after.length === 0
        ? `Removed the actions of ${name}`
        : `Set the actions of ${name} to ${e.after.map((a) => a.name).join(", ")}`;
    case "face":
      if (e.before === null) return `Added a face to ${name}`;
      if (e.after === null) return `Removed the face of ${name}`;
      return `Changed the face of ${name}`;
  }
}

function viewers(v: WireViewers, ctx: Context): string {
  return value(v, ctx);
}

function container(id: ObjectId | null, ctx: Context): string {
  return id === null ? "a hidden container" : objectName(ctx, id);
}

function location(l: LocationView, ctx: Context): string {
  return l.type === "board" ? ctx.boardName(l.board) : container(l.container, ctx);
}

/** " at (x, y)" for a literal two-number list, else nothing. */
function at(position: CellStateView | null): string {
  if (position?.kind !== "literal") return "";
  const v: WireValue = position.value;
  if (v.type !== "list" || v.items.length !== 2) return "";
  const [x, y] = v.items;
  if (x?.type !== "number" || y?.type !== "number") return "";
  return ` at (${number(x.value)}, ${number(y.value)})`;
}

/** A number in compact form. */
const number = (k: number) =>
  formatValue({ type: "number", value: k }, { mode: "compact", refLabel: () => null }).text;

/** "A", "A and B", "A, B and C", "A, B, C and 2 more". */
function list(names: readonly string[]): string {
  if (names.length === 0) return "nothing";
  if (names.length > 3) return `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
  if (names.length === 1) return names[0] as string;
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
