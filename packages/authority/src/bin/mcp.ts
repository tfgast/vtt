#!/usr/bin/env -S node --import tsx
/**
 * `vtt-mcp`: the MCP stdio process (DESIGN.md §5.2, §7 Platform; PROTOCOL.md
 * §2, §11; D1, M3-D5, M3-D17). It attaches to the running authority as a
 * protocol client with `client.kind: "agent"` and serves the MCP tools over
 * stdin/stdout.
 *
 *   vtt-mcp [--url u] [--token=t] [--name n]
 *
 * Credentials: `--url`/`--token`, else `VTT_URL`/`VTT_TOKEN` (explicit: never
 * refreshed, a 4401 is terminal `unauthorized`), else the session file
 * (discovery: re-read before every reconnect attempt, `wrong_table` when it
 * names another table). Without explicit credentials discovery is selected
 * even when the session file is missing; the process waits for it.
 *
 * Startup order (§11): (1) the `ProtocolClient`, not connected; (2) the MCP
 * server over the stdio transport; (3) once the MCP client has initialized
 * (its name is then known for `agent_name`), `enableRecovery`, which makes
 * the first connection with backoff and does not require it to succeed.
 * Until the first `welcome` every tool answers `disconnected`.
 *
 * Exit codes: 1 for a usage error (an unknown flag, a positional argument,
 * an empty or over-long `--name`) or malformed or incomplete explicit
 * credentials, with a one-line message; 0 when stdin closes. Nothing else
 * exits: an unreachable authority, `wrong_table` and `unauthorized` are
 * reported by the tools while the process keeps serving MCP. Logs go to
 * stderr only; stdout carries the MCP stream.
 */
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { type ClientState, enableRecovery, ProtocolClient } from "@vtt/protocol";
import { createMcpServer, readSessionFile, sessionCredentials, subscriptionTools } from "../index";

const USAGE = "usage: vtt-mcp [--url u] [--token=t] [--name n]";

const OPTIONS = {
  url: { type: "string" },
  token: { type: "string" },
  name: { type: "string" },
} as const;

/** `hello.agent_name` is 1–100 characters (PROTOCOL.md §2). */
const MAX_AGENT_NAME = 100;

type Credentials = { mode: "explicit"; url: string; token: string } | { mode: "discovery" };

interface McpArgs {
  credentials: Credentials;
  name: string | undefined;
}

class UsageError extends Error {}

/** An explicit pair: both present, the URL `ws://` or `wss://`, the token non-empty. */
function explicit(
  url: string | undefined,
  token: string | undefined,
  names: { url: string; token: string },
): Credentials {
  if (url === undefined) throw new UsageError(`${names.token} is given without ${names.url}`);
  if (token === undefined) throw new UsageError(`${names.url} is given without ${names.token}`);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UsageError(`${names.url} is not a URL: ${JSON.stringify(url)}`);
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new UsageError(`${names.url} must be a ws:// or wss:// URL, got ${JSON.stringify(url)}`);
  }
  if (token === "") throw new UsageError(`${names.token} must not be empty`);
  return { mode: "explicit", url, token };
}

function parse(argv: string[], env: NodeJS.ProcessEnv): McpArgs {
  let values: { url?: string; token?: string; name?: string };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: OPTIONS,
      allowPositionals: false,
      strict: true,
    }));
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  if (values.name !== undefined && (values.name === "" || values.name.length > MAX_AGENT_NAME)) {
    throw new UsageError(`--name must be 1 to ${MAX_AGENT_NAME} characters`);
  }
  let credentials: Credentials;
  if (values.url !== undefined || values.token !== undefined) {
    credentials = explicit(values.url, values.token, { url: "--url", token: "--token" });
  } else {
    // A defined variable, even an empty one, is an explicit credential.
    const url = env.VTT_URL;
    const token = env.VTT_TOKEN;
    credentials =
      url === undefined && token === undefined
        ? { mode: "discovery" }
        : explicit(url, token, { url: "VTT_URL", token: "VTT_TOKEN" });
  }
  return { credentials, name: values.name };
}

const log = (message: string): void => {
  process.stderr.write(`vtt-mcp: ${message}\n`);
};

/** Line breaks become spaces, so a diagnostic stays on one stderr line. */
const oneLine = (text: string): string => text.replace(/[\r\n]+/g, " ");

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Exits once stdout and stderr have flushed (pipes may be asynchronous). */
async function exit(code: number): Promise<never> {
  await Promise.all(
    [process.stdout, process.stderr].map(
      (stream) =>
        new Promise<void>((resolve) => {
          if (stream.destroyed || !stream.writable) resolve();
          else stream.write("", () => resolve());
        }),
    ),
  );
  process.exit(code);
}

/** The MCP client's `clientInfo.name` as an `agent_name`: undefined when empty, else at most 100 characters. */
function agentNameOf(name: string | undefined): string | undefined {
  if (name === undefined || name.trim() === "") return undefined;
  if (name.length <= MAX_AGENT_NAME) return name;
  // Cut by UTF-16 units, as the length limit counts, without splitting a surrogate pair.
  const cut = name.slice(0, MAX_AGENT_NAME);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

async function main(argv: string[]): Promise<void> {
  let args: McpArgs;
  try {
    args = parse(argv, process.env);
  } catch (err) {
    log(`${oneLine(describe(err))}; ${USAGE}`);
    await exit(1);
    return;
  }
  const { credentials } = args;
  const discovery = credentials.mode === "discovery";

  // (1) The protocol client, not connected. Discovery: one read of the
  // session file, or empty credentials until it appears (recovery re-reads it
  // before every attempt).
  const initial =
    credentials.mode === "explicit"
      ? { url: credentials.url, token: credentials.token }
      : (() => {
          const info = readSessionFile();
          return info === null ? { url: "", token: "" } : { url: info.url, token: info.token };
        })();
  let mcpClientName: () => string | undefined = () => undefined;
  const client = new ProtocolClient({
    url: initial.url,
    token: initial.token,
    client: { name: "vtt-mcp", kind: "agent" },
    agent_name: () => args.name ?? mcpClientName() ?? "agent",
    onWarning: (message) => log(`warning: ${message}`),
  });

  // (2) The MCP server on stdio.
  const server = createMcpServer({ client, extensions: [subscriptionTools()] });
  mcpClientName = () => agentNameOf(server.server.getClientVersion()?.name);

  let stopRecovery: (() => void) | null = null;
  let closing = false;

  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    stopRecovery?.();
    client.close();
    await exit(0);
  };

  // (3) Once the MCP client has initialized: the authority connection, with
  // recovery from the start.
  server.server.oninitialized = () => {
    if (stopRecovery !== null || closing) return;
    log(discovery ? "connecting through the session file" : `connecting to ${initial.url}`);
    stopRecovery = enableRecovery(client, discovery ? { credentials: sessionCredentials() } : {});
  };
  // stdin reached end-of-file (the transport closes itself) or the server was closed.
  server.server.onclose = () => {
    void shutdown();
  };
  server.server.onerror = (err) => log(`MCP: ${describe(err)}`);

  let last = "";
  client.on("state", (state: ClientState) => {
    const error = client.connectionError();
    const key = `${state}/${error?.code ?? ""}/${error?.recovering ?? ""}`;
    if (key === last || closing) return;
    last = key;
    if (error === null) {
      if (state === "open") {
        log(`connected to ${client.table?.path ?? client.table?.name} (session ${client.session})`);
      }
      return;
    }
    if (error.code === "disconnected" && !error.recovering && state === "reconnecting") {
      log(`disconnected: ${error.message}; reconnecting`);
    } else if (error.code !== "disconnected") {
      log(`${error.code}: ${error.message}; the tools report it until vtt-mcp is restarted`);
    }
  });

  await server.connect(new StdioServerTransport());
}

void main(process.argv.slice(2)).catch((err: unknown) => {
  log(`unexpected failure: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
