/**
 * `ObjectView.absent_cell_visibility` (vtt-3l6.19; PROTOCOL.md §7.2 M4-D12;
 * DESIGN.md §4.4): GM views carry the per-cell visibility entries of cells
 * not in the view's `cells`; character views never do.
 */
import {
  deleteCell,
  SubscriptionHub,
  setCellVisibility,
  Table,
  type Transaction,
  ViewBuilder,
  type Viewer,
  writeValue,
} from "@vtt/authority";
import { type CommitEvent, CommitEventSchema, ObjectViewSchema } from "@vtt/protocol";
import { type Actor, num, text, type ViewersValue } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { c, placed, snapshot } from "../engine/helpers";

const GM: Viewer = { type: "gm" };
const ALDRIC: Viewer = { type: "character", id: "aldric" };
const GM_ACTOR: Actor = { type: "gm" };
const gmOnly: ViewersValue = { type: "viewers", viewers: ["gm"] };
const all: ViewersValue = { type: "viewers", viewers: ["all"] };

/**
 * `aldric` (a character) and `chest` with `name` and an entry for its absent
 * cell `secret` (gm only) and for its stored `name` (all).
 */
function fixture(): Table {
  return Table.fromSnapshot(
    snapshot([
      placed("aldric", 0, 0, { is_character: true, cells: { name: c(text("Aldric")) } }),
      placed("chest", 5, 0, {
        cells: { name: c(text("Chest")) },
        cell_visibility: { secret: gmOnly, name: all },
      }),
    ]),
  );
}

function commit(table: Table, fn: (tx: Transaction) => void): void {
  const r = table.store.transact(GM_ACTOR, { kind: "edit", label: "edit" }, fn);
  if (!r.ok) throw new Error(JSON.stringify(r.rejection));
}

const gmView = (table: Table) => new ViewBuilder(table, GM).objectView("chest", "all");

describe("absent_cell_visibility", () => {
  test("a GM view carries entries for absent cells only", () => {
    const table = fixture();
    const view = gmView(table);
    expect(view?.absent_cell_visibility).toEqual({ secret: gmOnly });
    expect(view?.cells.name?.visibility).toEqual(all);
    expect(ObjectViewSchema.parse(view)).toEqual(view);
  });

  test("absent when the object has no entry for an absent cell", () => {
    const table = fixture();
    const view = new ViewBuilder(table, GM).objectView("aldric", "all");
    expect(view).not.toBeNull();
    expect(view !== null && "absent_cell_visibility" in view).toBe(false);
  });

  test("lost when the entry is cleared", () => {
    const table = fixture();
    commit(table, (tx) => setCellVisibility(tx, "chest", "secret", null));
    const view = gmView(table);
    expect(view !== null && "absent_cell_visibility" in view).toBe(false);
  });

  test("once the cell exists the entry is the cell's visibility; deleted, it is absent again", () => {
    const table = fixture();
    commit(table, (tx) => writeValue(tx, "chest", "secret", num(42)));
    let view = gmView(table);
    expect(view !== null && "absent_cell_visibility" in view).toBe(false);
    expect(view?.cells.secret?.visibility).toEqual(gmOnly);
    commit(table, (tx) => deleteCell(tx, "chest", "secret"));
    view = gmView(table);
    expect(view?.absent_cell_visibility).toEqual({ secret: gmOnly });
  });

  test("a restricted GM view carries the entries of every name not in its cells", () => {
    const table = fixture();
    const structural = new ViewBuilder(table, GM).objectView("chest", "structural");
    expect(structural?.absent_cell_visibility).toEqual({ secret: gmOnly });
    const named = new ViewBuilder(table, GM).objectView("chest", ["position"]);
    expect(named?.absent_cell_visibility).toEqual({ secret: gmOnly, name: all });
  });

  test("a character view never carries it", () => {
    const table = fixture();
    commit(table, (tx) => setCellVisibility(tx, "chest", "other", all));
    const view = new ViewBuilder(table, ALDRIC).objectView("chest", "all");
    expect(view).not.toBeNull();
    expect(view !== null && "absent_cell_visibility" in view).toBe(false);
  });

  test("a GM subscription delta carries the field change; a character's has none", () => {
    const table = fixture();
    const hub = new SubscriptionHub(table);
    const events: [string, CommitEvent][] = [];
    hub.onCommitEvent((conn, event) => {
      CommitEventSchema.parse(event);
      events.push([conn, event]);
    });
    const gmSub = hub.subscribe("gm", { scope: { type: "all" } });
    const aldricSub = hub.subscribe("aldric", { scope: { type: "all" }, viewer: ALDRIC });
    expect(gmSub.objects.find((o) => o.id === "chest")?.absent_cell_visibility).toEqual({
      secret: gmOnly,
    });

    commit(table, (tx) => setCellVisibility(tx, "chest", "loot", all));
    const gmDelta = events
      .find(([conn]) => conn === "gm")?.[1]
      .deltas.find((d) => d.subscription === gmSub.subscription);
    const chest = gmDelta?.objects.find((o) => o.id === "chest");
    expect(chest?.absent_cell_visibility).toEqual({ secret: gmOnly, loot: all });
    const aldricEvent = events.find(([conn]) => conn === "aldric")?.[1];
    for (const d of aldricEvent?.deltas ?? []) {
      expect(d.subscription).toBe(aldricSub.subscription);
      for (const o of d.objects) expect("absent_cell_visibility" in o).toBe(false);
    }

    events.length = 0;
    commit(table, (tx) => {
      setCellVisibility(tx, "chest", "secret", null);
      setCellVisibility(tx, "chest", "loot", null);
    });
    const cleared = events
      .find(([conn]) => conn === "gm")?.[1]
      .deltas.find((d) => d.subscription === gmSub.subscription)
      ?.objects.find((o) => o.id === "chest");
    expect(cleared).toBeDefined();
    expect(cleared !== undefined && "absent_cell_visibility" in cleared).toBe(false);
  });
});
