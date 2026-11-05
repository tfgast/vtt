/**
 * Wire schemas for `create_object.id_base` and `set_value.replace`
 * (vtt-3l6.19; PROTOCOL.md §5 M4-D12, M4-D17, §12).
 */
import {
  type Destination,
  parseClientMessage,
  TransactParamsSchema,
  type WireOp,
  WireOpSchema,
} from "@vtt/protocol";
import { describe, expect, test } from "vitest";
import { z } from "zod";

const board: Destination = { type: "board", board: "map", position: [1, 2] };

const accepts = (op: unknown) => expect(WireOpSchema.parse(op)).toEqual(op);
const refuses = (op: unknown) => expect(WireOpSchema.safeParse(op).success).toBe(false);

describe("create_object.id_base", () => {
  test("round-trips, alone, with as, and through a transact request", () => {
    accepts({ type: "create_object", id_base: "zone", to: board });
    accepts({ type: "create_object", id_base: "token", as: "$t", to: board, init: {} });
    accepts({ type: "create_object", to: board });
    const message = {
      type: "request",
      id: "r1",
      method: "transact",
      params: { base_revision: 3, ops: [{ type: "create_object", id_base: "zone", to: board }] },
    };
    expect(parseClientMessage(JSON.stringify(message))).toEqual({ ok: true, message });
  });

  test("id and id_base together, or an id_base without id syntax, are the authority's to reject", () => {
    // PROTOCOL.md §5: both are rejected `invalid` by the command, not `bad_request`.
    accepts({ type: "create_object", id: "fog", id_base: "zone", to: board });
    accepts({ type: "create_object", id_base: "1zone", to: board });
  });

  test("id_base is a string", () => {
    refuses({ type: "create_object", id_base: 3, to: board });
    refuses({ type: "create_object", id_base: null, to: board });
  });

  test("the type carries id_base", () => {
    const op: WireOp = { type: "create_object", id_base: "card", to: board };
    expect(op.type).toBe("create_object");
  });
});

describe("set_value.replace", () => {
  const base = {
    type: "set_value",
    object: "goblin",
    cell: "hp",
    value: { type: "number", value: 9 },
  };

  test("replace: true round-trips; without it as before", () => {
    accepts({ ...base, replace: true });
    accepts(base);
    const params = { base_revision: 0, ops: [{ ...base, replace: true }] };
    expect(TransactParamsSchema.parse(params)).toEqual(params);
  });

  test("replace is only ever true", () => {
    refuses({ ...base, replace: false });
    refuses({ ...base, replace: "yes" });
    refuses({ ...base, replace: null });
  });

  test("the type carries replace", () => {
    const op: WireOp = { ...(base as WireOp & { type: "set_value" }), replace: true };
    expect(op.type).toBe("set_value");
  });
});

test("both fields export to JSON Schema", () => {
  const text = JSON.stringify(z.toJSONSchema(WireOpSchema));
  expect(text).toContain('"id_base"');
  expect(text).toContain('"replace"');
});
