/** The tool registry: one tool per id (M4 plan review r1 finding 2). */
import type { Tool, ToolId } from "./tool";

export class ToolRegistry {
  readonly #tools = new Map<ToolId, Tool>();

  /** Registers `tool` under its id; a second tool with the same id throws. */
  register<TPhase, K extends ToolId>(tool: Tool<TPhase, K>): void {
    if (this.#tools.has(tool.id)) throw new Error(`tool "${tool.id}" is already registered`);
    this.#tools.set(tool.id, tool);
  }

  get<K extends ToolId>(id: K): Tool<unknown, K> | undefined {
    return this.#tools.get(id) as Tool<unknown, K> | undefined;
  }

  /** The registered tools, in registration order. */
  list(): Tool[] {
    return [...this.#tools.values()];
  }
}
