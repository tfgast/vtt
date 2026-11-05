/**
 * The viewers picker (vtt-3l6.11; DESIGN.md §4.4): checkboxes for `all`,
 * `gm`, `owner` and each character, plus "Default (object's visibility)",
 * which reports `null` (per-cell visibility cleared). Controlled: it shows
 * `value` and reports the next set through `onChange`, in a canonical order
 * (the words, then the listed characters, then any other refs of `value`,
 * which are kept and shown by id). A viewer set is never empty, so the only
 * checked entry cannot be unchecked. Used for per-cell visibility and for the
 * literal value of `visible_to`.
 */
import type { InputRefValue, InputViewers, WireViewers } from "@vtt/protocol";
import type { ObjectId } from "@vtt/schema";
import type { CSSProperties } from "react";

/** A character offered by the picker. */
export interface ViewerCharacter {
  readonly id: ObjectId;
  readonly label: string;
}

export interface ViewersPickerProps {
  /** The current set; null is the default (no per-cell entry). */
  value: WireViewers | InputViewers | null;
  onChange(next: InputViewers | null): void;
  /** The directory's characters (never templates), in display order. */
  characters: readonly ViewerCharacter[];
  /** The group's accessible name (legend). Default "Viewers". */
  label?: string;
  /** Offer "Default (object's visibility)". Default true. */
  allowDefault?: boolean;
  disabled?: boolean;
}

type Word = "all" | "gm" | "owner";
const WORDS: readonly Word[] = ["all", "gm", "owner"];

export const DEFAULT_VIEWERS_LABEL = "Default (object's visibility)";

const FIELDSET_STYLE: CSSProperties = {
  border: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexWrap: "wrap",
  gap: "0 0.75em",
};
const LEGEND_STYLE: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
};

interface Entries {
  words: Set<Word>;
  refs: Set<ObjectId>;
}

function entriesOf(value: WireViewers | InputViewers | null): Entries {
  const words = new Set<Word>();
  const refs = new Set<ObjectId>();
  for (const entry of value?.viewers ?? []) {
    if (typeof entry === "string") words.add(entry);
    else if (entry.type === "ref") refs.add(entry.object);
    // Redacted entries never reach a GM; they cannot be written back.
  }
  return { words, refs };
}

export function ViewersPicker({
  value,
  onChange,
  characters,
  label = "Viewers",
  allowDefault = true,
  disabled = false,
}: ViewersPickerProps) {
  const current = entriesOf(value);
  const listed = new Set(characters.map((c) => c.id));
  const others = [...current.refs].filter((id) => !listed.has(id));
  const refOrder: ObjectId[] = [...characters.map((c) => c.id), ...others];
  const count = current.words.size + current.refs.size;

  const emit = (next: Entries) => {
    const viewers: InputViewers["viewers"] = WORDS.filter((w) => next.words.has(w));
    for (const id of refOrder) {
      if (next.refs.has(id)) viewers.push({ type: "ref", object: id } satisfies InputRefValue);
    }
    if (viewers.length > 0) onChange({ type: "viewers", viewers });
  };

  const toggleWord = (word: Word) => {
    const words = new Set(current.words);
    if (words.has(word)) words.delete(word);
    else words.add(word);
    emit({ words, refs: current.refs });
  };

  const toggleRef = (id: ObjectId) => {
    const refs = new Set(current.refs);
    if (refs.has(id)) refs.delete(id);
    else refs.add(id);
    emit({ words: current.words, refs });
  };

  // The only checked entry cannot be unchecked.
  const locked = (checked: boolean) => disabled || (checked && count === 1);

  const box = (key: string, text: string, checked: boolean, toggle: () => void) => (
    <label key={key}>
      <input type="checkbox" checked={checked} disabled={locked(checked)} onChange={toggle} />{" "}
      {text}
    </label>
  );

  return (
    <fieldset style={FIELDSET_STYLE}>
      <legend style={LEGEND_STYLE}>{label}</legend>
      {WORDS.map((word) => box(`w:${word}`, word, current.words.has(word), () => toggleWord(word)))}
      {characters.map((c) =>
        box(`c:${c.id}`, c.label, current.refs.has(c.id), () => toggleRef(c.id)),
      )}
      {others.map((id) => box(`r:${id}`, id, true, () => toggleRef(id)))}
      {allowDefault && (
        <label>
          <input
            type="checkbox"
            checked={value === null}
            disabled={disabled || value === null}
            onChange={() => onChange(null)}
          />{" "}
          {DEFAULT_VIEWERS_LABEL}
        </label>
      )}
    </fieldset>
  );
}
