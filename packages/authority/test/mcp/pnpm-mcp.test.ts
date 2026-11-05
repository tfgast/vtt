/**
 * `pnpm mcp` (vtt-nb8.16; M6-D5, M6-D6; PROTOCOL.md §11): the root script
 * an agent host launches as `pnpm --silent --dir <repo> mcp`. Spawned through
 * the SDK's stdio client transport against a real in-process authority, it
 * initializes, lists the tools and sends `MCP_INSTRUCTIONS`.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { MCP_INSTRUCTIONS } from "@vtt/authority";
import { afterEach, expect, test } from "vitest";
import { cleanup, serve } from "../server/helpers";

const REPO = fileURLToPath(new URL("../../../..", import.meta.url));

let client: Client | undefined;

afterEach(async () => {
  await client?.close().catch(() => undefined);
  client = undefined;
  await cleanup();
});

test("the root mcp script runs vtt-mcp", async () => {
  const pkg = JSON.parse(await readFile(join(REPO, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  expect(pkg.scripts.mcp).toBe("node --import tsx packages/authority/src/bin/mcp.ts");
});

test("pnpm --silent mcp serves MCP over stdio with the instructions", async () => {
  const { server } = await serve();
  let stderr = "";
  const transport = new StdioClientTransport({
    command: "pnpm",
    args: ["--silent", "mcp", "--url", server.url, "--token", server.token],
    cwd: REPO,
    env: getDefaultEnvironment(),
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });
  client = new Client({ name: "pnpm-mcp-test", version: "1.0.0" });
  try {
    await client.connect(transport);
  } catch (err) {
    throw new Error(`initialize failed: ${(err as Error).message}\nstderr:\n${stderr}`, {
      cause: err,
    });
  }
  const names = (await client.listTools()).tools.map((t) => t.name);
  expect(names).toContain("transact");
  expect(names).toContain("invoke");
  expect(client.getInstructions()).toBe(MCP_INSTRUCTIONS);
}, 60_000);
