/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CLOSE_CODES,
  DEFAULT_PORT,
  GroupViewSchema,
  LIMITS,
  METHODS,
  type MethodName,
  ObjectViewSchema,
  type Params,
  PROTOCOL_VERSION,
  type Result,
  type SubscribeParams,
  TransactParamsSchema,
  type TransactResult,
  WIRE_OP_TYPES,
  WireOpSchema,
} from "@vtt/protocol";
import { describe, expect, expectTypeOf, test } from "vitest";
import { z } from "zod";

const SRC = join(import.meta.dirname, "..", "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

/** The `type` constants of a union's options, wherever zod put them. */
function optionTypeConsts(schema: Record<string, unknown>): string[] {
  const options = (schema.oneOf ?? schema.anyOf) as Record<string, unknown>[] | undefined;
  if (!options) throw new Error("not a union");
  return options.map((o) => {
    const props = o.properties as Record<string, { const?: string }>;
    const c = props.type?.const;
    if (typeof c !== "string") throw new Error("option without a type constant");
    return c;
  });
}

const OPS = [
  "set_value",
  "set_formula",
  "clear_override",
  "delete_cell",
  "rename_cell",
  "set_cell_visibility",
  "set_tag",
  "set_shape",
  "set_template_flag",
  "set_character_flag",
  "set_actions",
  "reorder",
  "add_board",
  "rename_board",
  "remove_board",
  "create_object",
  "spawn",
  "move",
  "remove",
];

const METHOD_KINDS: Record<string, string> = {
  transact: "write",
  undo: "write",
  invoke: "write",
  save: "write",
  list_objects: "query",
  get_objects: "query",
  evaluate: "query",
  zones: "query",
  at_position: "query",
  changes_since: "query",
  log: "query",
  document: "query",
  explain_cell: "explain",
  explain_group: "explain",
  explain_action: "explain",
  subscribe: "subscribe",
  unsubscribe: "subscribe",
};

describe("JSON Schema export", () => {
  test("WireOp exports and lists the 19 op type constants", () => {
    const json = z.toJSONSchema(WireOpSchema) as Record<string, unknown>;
    expect(optionTypeConsts(json).sort()).toEqual([...OPS].sort());
  });

  test("the complete transact params schema exports", () => {
    const json = z.toJSONSchema(TransactParamsSchema);
    const text = JSON.stringify(json);
    // Init cells, spawn cells and viewers are all in there.
    expect(text).toContain('"init"');
    expect(text).toContain('"viewers"');
    expect(text).toContain('"owned"');
  });

  test("every method's params schema exports", () => {
    for (const [name, entry] of Object.entries(METHODS)) {
      expect(() => z.toJSONSchema(entry.params), name).not.toThrow();
      expect(() => z.toJSONSchema(entry.params, { io: "input" }), name).not.toThrow();
    }
  });

  test("loose views export in output mode", () => {
    for (const schema of [ObjectViewSchema, GroupViewSchema]) {
      expect(() => z.toJSONSchema(schema)).not.toThrow();
    }
  });

  test("no z.custom, transform or preprocess appears in the sources", () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/z\.custom/);
      expect(text, file).not.toMatch(/\.transform\(|z\.preprocess|\.overwrite\(/);
      expect(text, file).not.toMatch(/from "node:/);
    }
  });
});

describe("tables and constants", () => {
  test("METHODS has exactly the 17 methods with their kinds", () => {
    expect(Object.keys(METHODS).sort()).toEqual(Object.keys(METHOD_KINDS).sort());
    for (const [name, entry] of Object.entries(METHODS)) {
      expect(entry.kind, name).toBe(METHOD_KINDS[name]);
    }
  });

  test("WIRE_OP_TYPES has exactly the 19 ops", () => {
    expect(WIRE_OP_TYPES).toHaveLength(19);
    expect([...WIRE_OP_TYPES].sort()).toEqual([...OPS].sort());
  });

  test("LIMITS equals PROTOCOL.md §10", () => {
    expect(LIMITS).toEqual({
      max_message_bytes: 1048576,
      max_ops: 1000,
      max_page: 200,
      max_ids: 200,
      max_subscriptions: 16,
      max_explain_depth: 4,
      max_explain_nodes: 200,
      max_source_length: 10000,
      max_groups: 500,
      max_log_window: 200,
      max_txn_ids_per_client: 1000,
      max_requests_per_second: 200,
      max_buffered_bytes: 67108864,
    });
    expect(Object.keys(LIMITS)).toHaveLength(13);
  });

  test("version, port and close codes", () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(DEFAULT_PORT).toBe(4747);
    expect(CLOSE_CODES).toEqual({
      protocol: 4400,
      unauthorized: 4401,
      hello_timeout: 4408,
      slow_consumer: 4429,
      shutdown: 1001,
    });
  });
});

describe("types", () => {
  test("Result<M> and Params<M> follow the METHODS table", () => {
    expectTypeOf<Result<"transact">>().toEqualTypeOf<TransactResult>();
    expectTypeOf<Params<"subscribe">>().toEqualTypeOf<SubscribeParams>();
    expectTypeOf<Result<"undo">>().toEqualTypeOf<TransactResult>();
    expectTypeOf<"transact">().toExtend<MethodName>();
    expectTypeOf<TransactResult>().toHaveProperty("status");
  });
});
