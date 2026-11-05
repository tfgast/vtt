/**
 * The toolbar (vtt-3l6.17; DESIGN.md §7 Platform, §8.1): the registered
 * tools (vtt-3l6.22's `ToolRegistry`), the fog toggle of the zone tools, the
 * view-as menu (vtt-3l6.10), Undo and Save (vtt-3l6.21).
 *
 * Fog is one preference shared by the three zone tools: toggling it sets the
 * active zone tool's typed options through `UiStore.setTool`, and activating
 * a zone tool (button or key) passes it along, so the zone tools never
 * disagree.
 */
import { type CSSProperties, useState } from "react";
import type { ToolRegistry } from "../interaction/registry";
import type { ToolId } from "../interaction/tool";
import { ViewAsMenu } from "../nav/ViewAsMenu";
import { useTableSession, useUi, useUiStore } from "../session/hooks";
import { save, undo } from "../session/writes";
import type { UiStore } from "../state/ui-state";
import { TOOL_KEYS } from "./keybindings";

/** The zone tools, whose options carry `fog`. */
export const ZONE_TOOL_IDS = ["zone-rect", "zone-circle", "zone-polygon"] as const;
type ZoneToolId = (typeof ZONE_TOOL_IDS)[number];

export function isZoneTool(id: ToolId): id is ZoneToolId {
  return (ZONE_TOOL_IDS as readonly ToolId[]).includes(id);
}

/** The toolbar's label of each tool. */
export const TOOL_LABELS: Readonly<Partial<Record<ToolId, string>>> = {
  select: "Select",
  token: "Token",
  card: "Card",
  note: "Note",
  "zone-rect": "Rectangle zone",
  "zone-circle": "Circle zone",
  "zone-polygon": "Polygon zone",
  image: "Image",
};

const fogPreference = new WeakMap<UiStore, boolean>();

/** The zone tools' fog preference of `ui`: the active zone tool's, else the last one set. */
export function zoneFog(ui: UiStore): boolean {
  const tool = ui.getState().tool;
  if (isZoneTool(tool.id)) return (tool.options as { fog: boolean }).fog;
  return fogPreference.get(ui) ?? false;
}

/** Sets the zone tools' fog; the active zone tool's options change at once. */
export function setZoneFog(ui: UiStore, fog: boolean): void {
  fogPreference.set(ui, fog);
  const tool = ui.getState().tool;
  if (isZoneTool(tool.id)) ui.setTool(tool.id, { fog });
}

/** Activates tool `id`; a zone tool gets the zone tools' fog. */
export function activateTool(ui: UiStore, id: ToolId): void {
  if (isZoneTool(id)) {
    const fog = zoneFog(ui);
    fogPreference.set(ui, fog);
    ui.setTool(id, { fog });
  } else {
    ui.setTool(id);
  }
}

const shortcutOf = (id: ToolId): string | undefined =>
  Object.entries(TOOL_KEYS)
    .find(([, tool]) => tool === id)?.[0]
    ?.toUpperCase();

const BAR_STYLE: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "0.5em",
  padding: "4px 6px",
};
const GROUP_STYLE: CSSProperties = { display: "flex", gap: "2px", alignItems: "center" };

export interface ToolbarProps {
  registry: ToolRegistry;
}

export function Toolbar({ registry }: ToolbarProps) {
  const session = useTableSession();
  const ui = useUiStore();
  const tool = useUi((s) => s.tool);
  // Re-render when the preference changes while no zone tool is active.
  const [, setTick] = useState(0);
  const fog = isZoneTool(tool.id) ? (tool.options as { fog: boolean }).fog : zoneFog(ui);

  return (
    <header style={BAR_STYLE}>
      <div role="toolbar" aria-label="Tools" style={GROUP_STYLE}>
        {registry.list().map((t) => {
          const label = TOOL_LABELS[t.id] ?? t.id;
          const key = shortcutOf(t.id);
          return (
            <button
              key={t.id}
              type="button"
              aria-pressed={tool.id === t.id}
              title={key === undefined ? label : `${label} (${key})`}
              onClick={() => activateTool(ui, t.id)}
            >
              {label}
            </button>
          );
        })}
        <label title="Zones drawn with fog are opaque and visible to the GM only">
          <input
            type="checkbox"
            checked={fog}
            onChange={(e) => {
              setZoneFog(ui, e.currentTarget.checked);
              setTick((n) => n + 1);
            }}
          />
          Fog
        </label>
      </div>
      <ViewAsMenu />
      <div style={GROUP_STYLE}>
        <button type="button" title="Undo (Ctrl+Z)" onClick={() => void undo(session)}>
          Undo
        </button>
        <button type="button" title="Save (Ctrl+S)" onClick={() => void save(session)}>
          Save
        </button>
      </div>
    </header>
  );
}
