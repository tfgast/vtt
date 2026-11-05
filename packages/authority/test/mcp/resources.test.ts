/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WIRE_OP_TYPES } from "@vtt/protocol";
import { afterEach, describe, expect, test } from "vitest";
import { cleanupHarnesses, startHarness } from "./support";

afterEach(async () => {
  await cleanupHarnesses();
});

const DOCS = join(import.meta.dirname, "..", "..", "..", "..", "docs");

describe("static resources (PROTOCOL.md §11)", () => {
  test("the four resources are listed", async () => {
    const h = await startHarness();
    const { resources } = await h.mcp.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual([
      "vtt://docs/design",
      "vtt://docs/formulas",
      "vtt://docs/protocol",
      "vtt://schema/ops",
    ]);
  });

  test("vtt://docs/formulas is FORMULAS.md", async () => {
    const h = await startHarness();
    const text = await h.read("vtt://docs/formulas");
    expect(text.startsWith("# Formula and Action Language")).toBe(true);
    expect(text).toBe(readFileSync(join(DOCS, "FORMULAS.md"), "utf8"));
  });

  test("vtt://docs/design and vtt://docs/protocol are DESIGN.md and PROTOCOL.md", async () => {
    const h = await startHarness();
    expect(await h.read("vtt://docs/design")).toBe(readFileSync(join(DOCS, "DESIGN.md"), "utf8"));
    expect(await h.read("vtt://docs/protocol")).toBe(
      readFileSync(join(DOCS, "PROTOCOL.md"), "utf8"),
    );
  });

  test("vtt://schema/ops is the JSON Schema of WireOp with its 19 op kinds", async () => {
    const h = await startHarness();
    const schema = JSON.parse(await h.read("vtt://schema/ops")) as Record<string, unknown>;
    const options = (schema.oneOf ?? schema.anyOf) as { properties: { type: { const: string } } }[];
    const kinds = options.map((o) => o.properties.type.const);
    expect(kinds).toHaveLength(19);
    expect([...kinds].sort()).toEqual([...WIRE_OP_TYPES].sort());
  });

  test("resources are readable while the client is disconnected", async () => {
    const h = await startHarness({ connect: false });
    expect((await h.read("vtt://docs/formulas")).length).toBeGreaterThan(0);
  });
});
