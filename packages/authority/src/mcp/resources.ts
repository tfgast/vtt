/// <reference types="node" />
/**
 * The static MCP resources (PROTOCOL.md §11; DESIGN.md §5.3: the agent gets
 * the language spec in its context): the three docs, read from the
 * repository at read time, and the JSON Schema of `WireOp`. The
 * subscription resource is vtt-5su.15's.
 */
import { readFile } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/server";
import { WireOpSchema } from "@vtt/protocol";
import { z } from "zod";

export interface StaticResource {
  readonly uri: string;
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly mimeType: string;
  /** The resource's text, produced at read time. */
  read(): Promise<string>;
}

const doc = (url: URL) => () => readFile(url, "utf8");

/** The JSON Schema of `WireOp` (19 kinds), as `transact` accepts ops. */
export function wireOpJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(WireOpSchema, { io: "input" }) as Record<string, unknown>;
}

/** The four static resources of PROTOCOL.md §11. */
export const RESOURCES: readonly StaticResource[] = Object.freeze([
  Object.freeze({
    uri: "vtt://docs/formulas",
    name: "formulas",
    title: "Formula and Action Language",
    description:
      "docs/FORMULAS.md: the formula and action language every formula, `when` guard and action step follows.",
    mimeType: "text/markdown",
    read: doc(new URL("../../../../docs/FORMULAS.md", import.meta.url)),
  }),
  Object.freeze({
    uri: "vtt://docs/design",
    name: "design",
    title: "Design Document",
    description: "docs/DESIGN.md: the object, cell, zone and visibility model of the table.",
    mimeType: "text/markdown",
    read: doc(new URL("../../../../docs/DESIGN.md", import.meta.url)),
  }),
  Object.freeze({
    uri: "vtt://docs/protocol",
    name: "protocol",
    title: "Protocol",
    description: "docs/PROTOCOL.md: the wire protocol the tools map onto (methods, ops, results).",
    mimeType: "text/markdown",
    read: doc(new URL("../../../../docs/PROTOCOL.md", import.meta.url)),
  }),
  Object.freeze({
    uri: "vtt://schema/ops",
    name: "ops-schema",
    title: "WireOp JSON Schema",
    description: "The JSON Schema of the 19 op kinds a transact batch holds.",
    mimeType: "application/json",
    read: async () => JSON.stringify(wireOpJsonSchema(), null, 2),
  }),
]);

/**
 * Registers the static resources. They are not gated: they never touch the
 * authority, so they read the same while the client is disconnected.
 */
export function registerResources(server: McpServer): void {
  for (const resource of RESOURCES) {
    server.registerResource(
      resource.name,
      resource.uri,
      { title: resource.title, description: resource.description, mimeType: resource.mimeType },
      async (uri) => ({
        contents: [{ uri: uri.href, mimeType: resource.mimeType, text: await resource.read() }],
      }),
    );
  }
}
