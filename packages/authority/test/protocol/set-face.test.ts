/**
 * The `set_face` op and `ObjectInit.face` over the protocol (vtt-1xv.7;
 * PROTOCOL.md §5, §6; M5-D7): commit, declared keys, stale writes and
 * refusals.
 */
import {
  type CommandContext,
  declaredKeys,
  executeTransact,
  executeUndo,
  ScriptedDiceSource,
  Table,
  TxnCache,
} from "@vtt/authority";
import type { TransactParams, TransactResult, WireOp } from "@vtt/protocol";
import { type Actor, type FaceLayout, text } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { c, placed, snapshot } from "../engine/helpers";

const GM: Actor = { type: "gm" };
const AGENT: Actor = { type: "agent", name: "claude" };

const badge: FaceLayout = {
  elements: [
    { type: "value", cell: "hp", rect: [-0.5, -0.5, 1, 0.4] },
    { type: "button", action: "Roll", rect: [-0.5, 0, 1, 0.4], show_when: "hp > 0" },
  ],
  default_action: "Roll",
};

const card: FaceLayout = {
  elements: [{ type: "value", cell: "name", rect: [-1, -1, 2, 0.5], style: { size: "large" } }],
};

/** Revision 5: `goblin1` and `chest` on board `table`. */
function fixture(): Table {
  const s = snapshot([
    placed("goblin1", 0, 0, { cells: { name: c(text("Goblin")) } }),
    placed("chest", 3, 0),
  ]);
  return Table.fromSnapshot({ ...s, revision: 5, next_seq: 1 });
}

function context(table: Table, over: Partial<CommandContext> = {}): CommandContext {
  return {
    table,
    actor: GM,
    kind: "ui",
    client: "ui-1",
    dice: new ScriptedDiceSource([]),
    txns: new TxnCache(),
    ...over,
  };
}

const agent = (table: Table) => context(table, { actor: AGENT, kind: "agent", client: "agent-1" });

const params = (base: number, ops: WireOp[]): TransactParams => ({ base_revision: base, ops });

type Committed = Extract<TransactResult, { status: "committed" }>;
type Refused = Extract<TransactResult, { status: "rejected" }>;

function committed(r: TransactResult): Committed {
  expect(r.status, JSON.stringify(r)).toBe("committed");
  return r as Committed;
}

function refused(r: TransactResult): Refused {
  expect(r.status, JSON.stringify(r)).toBe("rejected");
  return r as Refused;
}

const run = (table: Table, ops: WireOp[]) =>
  committed(executeTransact(context(table), params(table.store.revision, ops)));

const setFace = (object: string, face: FaceLayout | null): WireOp => ({
  type: "set_face",
  object,
  face,
});

const faceOf = (t: Table, id: string) => t.store.getObject(id)?.face;

describe("set_face", () => {
  test("a GM set_face commits one face field effect, labelled by type and target", () => {
    const t = fixture();
    const r = run(t, [setFace("goblin1", badge)]);
    expect(r).toMatchObject({ status: "committed", revision: 6, index: 0 });
    expect(faceOf(t, "goblin1")).toEqual(badge);
    const group = t.store.history.get(0);
    expect(group?.label).toBe("set_face goblin1");
    expect(group?.effects).toEqual([
      { type: "field", object: "goblin1", field: "face", before: null, after: badge },
    ]);
  });

  test("null removes the layout; undo restores it", () => {
    const t = fixture();
    run(t, [setFace("goblin1", badge)]);
    run(t, [setFace("goblin1", null)]);
    expect(t.store.getObject("goblin1") && "face" in (t.store.getObject("goblin1") ?? {})).toBe(
      false,
    );
    committed(executeUndo(context(t), { target: { type: "mine" } }));
    expect(faceOf(t, "goblin1")).toEqual(badge);
  });

  test("declares face:<object>, and nothing for a binding", () => {
    expect(declaredKeys(setFace("goblin1", badge))).toEqual(["face:goblin1"]);
    expect(declaredKeys(setFace("goblin1", null))).toEqual(["face:goblin1"]);
    expect(declaredKeys(setFace("$die", badge))).toEqual([]);
  });

  test("a stale set_face after another set_face is stale_write with key face:<object>", () => {
    const t = fixture();
    run(t, [setFace("goblin1", badge)]);
    const r = refused(executeTransact(agent(t), params(5, [setFace("goblin1", card)])));
    expect(r.op_index).toBeUndefined();
    expect(r.rejection).toEqual({
      type: "stale_write",
      base_revision: 5,
      revision: 6,
      floor: 5,
      truncated: false,
      conflicts: [
        { index: 0, revision: 6, actor: GM, label: "set_face goblin1", keys: ["face:goblin1"] },
      ],
    });
    expect(faceOf(t, "goblin1")).toEqual(badge);
  });

  test("a stale set_face on an object removed since names the removal's obj key", () => {
    const t = fixture();
    run(t, [{ type: "remove", object: "goblin1" }]);
    const r = refused(executeTransact(agent(t), params(5, [setFace("goblin1", card)])));
    expect(r.rejection).toMatchObject({
      type: "stale_write",
      conflicts: [{ index: 0, keys: ["obj:goblin1"] }],
    });
  });

  test("a stale remove after a set_face conflicts on face:<object>", () => {
    const t = fixture();
    run(t, [setFace("goblin1", badge)]);
    const r = refused(
      executeTransact(agent(t), params(5, [{ type: "remove", object: "goblin1" }])),
    );
    expect(r.rejection).toMatchObject({
      type: "stale_write",
      conflicts: [{ index: 0, keys: ["face:goblin1"] }],
    });
  });

  test("a stale set_face disjoint from the writes since commits", () => {
    const t = fixture();
    run(t, [setFace("chest", card)]);
    run(t, [
      { type: "set_value", object: "goblin1", cell: "hp", value: { type: "number", value: 3 } },
    ]);
    run(t, [{ type: "set_actions", object: "goblin1", actions: [{ name: "Roll", steps: [] }] }]);
    committed(executeTransact(agent(t), params(5, [setFace("goblin1", badge)])));
    expect(faceOf(t, "goblin1")).toEqual(badge);
  });

  test("a layout with a faceProblem is rejected invalid at its op_index", () => {
    const t = fixture();
    const tooMany = {
      elements: Array.from({ length: 201 }, () => ({
        type: "value" as const,
        cell: "hp",
        rect: [0, 0, 1, 1] as [number, number, number, number],
      })),
    };
    const twoContents: FaceLayout = {
      elements: [
        { type: "contents", rect: [0, 0, 1, 1] },
        { type: "contents", rect: [0, 1, 1, 1] },
      ],
    };
    for (const face of [tooMany, twoContents]) {
      const r = refused(
        executeTransact(
          context(t),
          params(t.store.revision, [setFace("chest", card), setFace("goblin1", face)]),
        ),
      );
      expect(r.op_index).toBe(1);
      expect(r.rejection.type).toBe("invalid");
    }
    expect(faceOf(t, "chest")).toBeUndefined();
    expect(t.store.history.groups()).toHaveLength(0);
  });

  test("an unknown object is rejected invalid", () => {
    const t = fixture();
    const r = refused(executeTransact(context(t), params(5, [setFace("nobody", badge)])));
    expect(r.op_index).toBe(0);
    expect(r.rejection.type).toBe("invalid");
  });

  test("a binding resolves to the object created earlier in the transaction", () => {
    const t = fixture();
    const r = run(t, [
      {
        type: "create_object",
        as: "$die",
        to: { type: "board", board: "table", position: [1, 1] },
      },
      setFace("$die", badge),
    ]);
    const id = r.bindings.$die ?? "";
    expect(faceOf(t, id)).toEqual(badge);
  });
});

describe("ObjectInit.face", () => {
  test("create_object stores init.face", () => {
    const t = fixture();
    run(t, [
      {
        type: "create_object",
        id: "die",
        to: { type: "board", board: "table", position: [2, 2] },
        init: { face: badge },
      },
    ]);
    expect(faceOf(t, "die")).toEqual(badge);
  });

  test("an init.face with a faceProblem is rejected invalid", () => {
    const t = fixture();
    const r = refused(
      executeTransact(
        context(t),
        params(5, [
          {
            type: "create_object",
            id: "die",
            to: { type: "board", board: "table", position: [2, 2] },
            init: { face: { elements: [{ type: "button", action: "", rect: [0, 0, 1, 1] }] } },
          },
        ]),
      ),
    );
    expect(r.op_index).toBe(0);
    expect(r.rejection.type).toBe("invalid");
    expect(t.store.getObject("die")).toBeUndefined();
  });
});
