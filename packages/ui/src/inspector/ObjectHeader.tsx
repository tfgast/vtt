/**
 * The inspector's object header (vtt-3l6.12; DESIGN.md §4.1 flags and tags;
 * PROTOCOL.md §5 `set_template_flag`, `set_character_flag`, `set_tag`, §6):
 * the name and id (with a copy button); the `is_template` and
 * `is_character` toggles; `is_zone`, read-only; on a zone the Fog checkbox;
 * the tags as chips with add and remove; and the shape control. Each command
 * carries the revision captured at the click. Read-only (view-as) shows the
 * same without edits.
 *
 * Fog (vtt-nb8.27; DESIGN.md §4.4, §4.6 The inspector, §8.4 step 3) shows the
 * evaluated state (`viewFog`). Checking writes the zone tools' `FOG_CELLS`
 * (`opaque` true, `visible_to` gm), unchecking `opaque` false and
 * `visible_to` all, each as one group of plain `set_value`s: on a formula
 * cell that is an override and the formula stays underneath. Its visible
 * text is "Fog"; its accessible name is "Zone fog", distinct from the zone
 * tools' toolbar Fog option.
 */
import type { ObjectView, WireOp } from "@vtt/protocol";
import type { ObjectId } from "@vtt/schema";
import { type CSSProperties, type FormEvent, useEffect, useRef, useState } from "react";
import { FOG_CELLS } from "../interaction/create-tools";
import type { TableSession } from "../session/table-session";
import { inspectorRefLabel, useInspectorWrites } from "./CellRow";
import { ShapeControl } from "./ShapeControl";

export interface ObjectHeaderProps {
  object: ObjectId;
  /** The current viewer's view of `object`. */
  view: ObjectView;
  session: TableSession;
  /** View-as: nothing editable. */
  readOnly?: boolean;
}

/** The view's `name` when it is non-empty text, else null. */
export function viewName(view: ObjectView): string | null {
  const v = view.cells.name?.value;
  return v?.type === "text" && v.value !== "" ? v.value : null;
}

/** The view's tags (text items of `tag`), in order. */
export function viewTags(view: ObjectView): string[] {
  const v = view.cells.tag?.value;
  if (v?.type !== "list") return [];
  const tags: string[] = [];
  for (const item of v.items) if (item.type === "text") tags.push(item.value);
  return tags;
}

/** Whether the view's `is_zone` is true. */
export function viewIsZone(view: ObjectView): boolean {
  const v = view.cells.is_zone?.value;
  return v?.type === "boolean" && v.value;
}

/** A zone's fog state, as the Fog checkbox shows it. */
export type FogState = "on" | "off" | "mixed";

/**
 * The view's evaluated fog state: "on" when `opaque` is true and
 * `visible_to` is exactly `gm`; "off" when `opaque` is false or empty
 * (absent reads as its default, false); "mixed" otherwise.
 */
export function viewFog(view: ObjectView): FogState {
  const opaque = view.cells.opaque?.value ?? { type: "empty" };
  if (opaque.type === "empty" || (opaque.type === "boolean" && !opaque.value)) return "off";
  const v = view.cells.visible_to?.value;
  const gmOnly = v?.type === "viewers" && v.viewers.length === 1 && v.viewers[0] === "gm";
  return opaque.type === "boolean" && gmOnly ? "on" : "mixed";
}

/** The writes that turn fog on (the zone tools' `FOG_CELLS`) or off on `object`. */
function fogOps(object: ObjectId, on: boolean): WireOp[] {
  if (!on) {
    return [
      { type: "set_value", object, cell: "opaque", value: { type: "boolean", value: false } },
      {
        type: "set_value",
        object,
        cell: "visible_to",
        value: { type: "viewers", viewers: ["all"] },
      },
    ];
  }
  return Object.entries(FOG_CELLS).flatMap(([cell, value]): WireOp[] =>
    value.type === "formula" ? [] : [{ type: "set_value", object, cell, value }],
  );
}

const ROW_STYLE: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "0.5em",
};
const CHIP_STYLE: CSSProperties = {
  listStyle: "none",
  display: "inline-flex",
  alignItems: "center",
  gap: "0.2em",
  padding: "0 0.4em",
  borderRadius: "0.8em",
  background: "rgba(127, 127, 127, 0.2)",
};
const CHIP_BUTTON_STYLE: CSSProperties = {
  background: "none",
  border: "none",
  padding: 0,
  cursor: "pointer",
  font: "inherit",
};

export function ObjectHeader({ object, view, session, readOnly = false }: ObjectHeaderProps) {
  const port = useInspectorWrites(session);
  const [tag, setTag] = useState("");
  const name = viewName(view);
  const tags = viewTags(view);
  const label = () => inspectorRefLabel(session)(object) ?? object;

  const setFlag = (flag: "template" | "character", value: boolean) => {
    const baseRevision = session.getSnapshot().revision;
    const what = flag === "template" ? "template" : "character";
    void port.write(
      [
        flag === "template"
          ? { type: "set_template_flag", object, value }
          : { type: "set_character_flag", object, value },
      ],
      { baseRevision, label: `${value ? "Make" : "Unmake"} ${label()} a ${what}` },
    );
  };

  const fog = viewIsZone(view) ? viewFog(view) : null;
  const fogBox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (fogBox.current !== null) fogBox.current.indeterminate = fog === "mixed";
  });
  const setFog = (on: boolean) => {
    const baseRevision = session.getSnapshot().revision;
    void port.write(fogOps(object, on), {
      baseRevision,
      label: `Fog ${on ? "on" : "off"} ${label()}`,
    });
  };

  const writeTags = (next: string[], text: string, baseRevision: number) => {
    void port.write([{ type: "set_tag", object, tags: next }], { baseRevision, label: text });
  };

  const addTag = (event: FormEvent) => {
    event.preventDefault();
    const baseRevision = session.getSnapshot().revision;
    const added = tag.trim();
    setTag("");
    if (added === "" || tags.includes(added)) return;
    writeTags([...tags, added], `Tag ${label()} ${added}`, baseRevision);
  };

  const removeTag = (removed: string) => {
    const baseRevision = session.getSnapshot().revision;
    writeTags(
      tags.filter((t) => t !== removed),
      `Untag ${label()} ${removed}`,
      baseRevision,
    );
  };

  const copyId = () => {
    void navigator.clipboard?.writeText(object).catch(() => undefined);
  };

  return (
    <section aria-label="Object">
      <h3 style={{ margin: 0 }}>{name ?? object}</h3>
      <div style={ROW_STYLE}>
        <code>{object}</code>
        <button type="button" aria-label="Copy id" title="Copy id" onClick={copyId}>
          Copy
        </button>
      </div>
      <div style={ROW_STYLE}>
        <label>
          <input
            type="checkbox"
            checked={view.is_template}
            disabled={readOnly}
            onChange={(e) => setFlag("template", e.target.checked)}
          />{" "}
          Template
        </label>
        <label>
          <input
            type="checkbox"
            checked={view.is_character}
            disabled={readOnly}
            onChange={(e) => setFlag("character", e.target.checked)}
          />{" "}
          Character
        </label>
        <label>
          <input type="checkbox" checked={viewIsZone(view)} disabled readOnly /> Zone
        </label>
        {fog !== null && (
          <label>
            <input
              ref={fogBox}
              type="checkbox"
              aria-label="Zone fog"
              checked={fog === "on"}
              disabled={readOnly}
              onChange={(e) => setFog(e.target.checked)}
            />{" "}
            Fog
          </label>
        )}
      </div>
      <div style={ROW_STYLE}>
        <ul aria-label="Tags" style={{ ...ROW_STYLE, margin: 0, padding: 0 }}>
          {tags.map((t) => (
            <li key={t} data-tag={t} style={CHIP_STYLE}>
              {t}
              {!readOnly && (
                <button
                  type="button"
                  aria-label={`Remove tag ${t}`}
                  title={`Remove tag ${t}`}
                  style={CHIP_BUTTON_STYLE}
                  onClick={() => removeTag(t)}
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
        {!readOnly && (
          <form onSubmit={addTag}>
            <input
              aria-label="New tag"
              placeholder="Add tag"
              size={10}
              value={tag}
              onChange={(e) => setTag(e.target.value)}
            />
          </form>
        )}
      </div>
      <ShapeControl object={object} view={view} session={session} readOnly={readOnly} />
    </section>
  );
}
