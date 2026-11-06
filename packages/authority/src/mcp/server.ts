/**
 * The in-process MCP server (DESIGN.md §5.2; PROTOCOL.md §11; M3-D17):
 * `createMcpServer` builds an SDK `McpServer` over a `ProtocolClient` with
 * the 16 request tools, the static resources and the `instructions`
 * (`MCP_INSTRUCTIONS`, M6-D6), then runs each extension (vtt-5su.15 adds the
 * subscription tools and resource this way; M4 adds `import_asset`; the
 * composed `vtt-mcp` process has 20 tools). It does not connect the client
 * or a transport: the caller connects a transport (stdio in `vtt-mcp`,
 * vtt-5su.17; an in-memory pair in tests) and drives the client's
 * connection.
 */
import { McpServer } from "@modelcontextprotocol/server";
import type { ProtocolClient } from "@vtt/protocol";
import { MCP_INSTRUCTIONS } from "./instructions";
import { registerResources } from "./resources";
import { registerTools } from "./tools";

export {
  RESOURCES,
  registerResources,
  type StaticResource,
  wireOpJsonSchema,
} from "./resources";
export {
  AtPositionInputSchema,
  ChangesSinceInputSchema,
  CollectAssetsInputSchema,
  EvaluateInputSchema,
  ExplainActionInputSchema,
  ExplainCellInputSchema,
  ExplainGroupInputSchema,
  GetObjectsInputSchema,
  ListObjectsInputSchema,
  LogInputSchema,
  registerTools,
  SaveInputSchema,
  TableInfoInputSchema,
  TOOLS,
  type ToolName,
  type ToolSpec,
  TRANSACT_RETRY_MS,
  TransactInputSchema,
  UndoInputSchema,
  ZonesInputSchema,
} from "./tools";

/** Adds tools or resources to the server; called once, after the built-in ones, before any transport connects. */
export type McpExtension = (server: McpServer, client: ProtocolClient) => void;

export interface CreateMcpServerOptions {
  client: ProtocolClient;
  /** The MCP server name; default "vtt". */
  name?: string;
  extensions?: readonly McpExtension[];
}

/** The MCP server's version, reported in `serverInfo`. */
export const MCP_SERVER_VERSION = "1.0.0";

/**
 * Builds the MCP server: the 16 request tools, the static resources and
 * `MCP_INSTRUCTIONS`, then `extensions` in order.
 */
export function createMcpServer(options: CreateMcpServerOptions): McpServer {
  const { client, name = "vtt", extensions = [] } = options;
  const server = new McpServer(
    { name, version: MCP_SERVER_VERSION },
    { capabilities: { tools: {}, resources: {} }, instructions: MCP_INSTRUCTIONS },
  );
  registerTools(server, client);
  registerResources(server);
  for (const extend of extensions) extend(server, client);
  return server;
}
