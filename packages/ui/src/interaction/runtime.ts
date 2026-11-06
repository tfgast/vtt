/**
 * The interaction runtime (DESIGN.md §7 Platform and Undo, §5.2; M4 plan
 * Q10, review r2 findings 3, 4, 8, 12, r3 findings 1, 2; M5 plan Q1 A2,
 * review r1 finding 10): executes vtt-3l6.22's effects against real ports.
 *
 * It keeps one `MachineState`. Each event becomes a `ReducerInput` snapshot
 * (from `RuntimeInputs` and the `UiStore`), goes through `reduce`, and the
 * effects run in order. The active tool follows `UiStore.tool` both ways:
 * `set_tool` effects and continuations go through the machine's `setTool`
 * and the store; a `UiStore.setTool` from elsewhere (the toolbar) is applied
 * to the machine.
 *
 * Lifecycle (review r3 finding 1):
 * - `RuntimeInputs.onChange` runs `syncInput`, which cancels the active tool
 *   on a board or viewer change; Escape and a tool switch cancel it too. A
 *   cancel ends unfinished gestures only; started writes and uploads still
 *   settle back to the tool that started them (the machine's `pending`).
 * - An interaction is cancelled when its tool is cancelled after the
 *   interaction started, in execution order: a `set_tool` later in the same
 *   effect list cancels a write earlier in it. A data-drop handler's
 *   interaction belongs, for cancellation, to the tool active at the drop. The continuations of a committed write run, in
 *   order, only when its interaction was not cancelled and its stamp's board
 *   and viewer are still the active ones. Otherwise none run: the write still
 *   applied to `stamp.board`, and a non-committed outcome is already a notice
 *   from the write port (vtt-3l6.21).
 * - Previews with `hold` stay until `whenRevision` of the committed revision
 *   resolves; any other outcome, and a cancel of the holding tool, clears
 *   them at once. Newer previews replace held ones and are never cleared by
 *   an older write.
 *
 * Data drops: every `data_drop` is offered to `dataDropHandlers` in order
 * before the active tool; the first non-null result's effects run (stamped
 * as the handler stamped them; nothing settles back to a tool, but they are
 * cancelled like the active tool's own)
 * and the event goes no further.
 */
import type { Viewer } from "@vtt/protocol";
import type { Bounds, ObjectId } from "@vtt/schema";
import type { UiStore } from "../state/ui-state";
import type {
  CommittedWrite,
  InteractionStamp,
  Previews,
  RuntimeInputs,
  ToolContext,
  WriteOutcome,
} from "./contracts";
import { type Continuation, createdIdAt, type Effect, settlingInteraction } from "./effects";
import type { InteractionEvent, SettledOutcome } from "./events";
import { initMachine, type MachineState, reduce, setTool, syncInput } from "./machine";
import type { ToolOverlay } from "./overlays";
import type { ToolRegistry } from "./registry";
import type { ReducerInput, SetToolRequest, ToolId } from "./tool";

/** What `EditorPort.open` receives: `open_editor` without its type. */
export interface EditorOpenRequest {
  stamp: InteractionStamp;
  object: ObjectId;
  cell?: string;
  /** A board-space rectangle to position the editor over instead of the object's bounds (M5 Q1 A5). */
  rect?: Bounds;
}

/** The in-place editor as the runtime drives it (implemented by vtt-3l6.13). */
export interface EditorPort {
  open(request: EditorOpenRequest): void;
  close(): void;
}

/** A `data_drop` event. */
export type DataDropEvent = Extract<InteractionEvent, { type: "data_drop" }>;

/**
 * Offered every `data_drop` before the active tool: effects to execute
 * (writes stamped at the drop) and stop the event, or null to pass it on.
 */
export type DataDropHandler = (event: DataDropEvent, input: ReducerInput) => Effect[] | null;

/** An `extension` effect. */
export type ExtensionEffect = Extract<Effect, { type: "extension" }>;

/** The ports an extension effect handler may use. */
export interface ExtensionContext {
  toolContext: ToolContext;
  ui: UiStore;
  editor: EditorPort;
}

/**
 * Runs an `extension` effect. For a stamped effect the result (a promise's
 * value, else undefined) settles back to the tool as `extension`.
 */
export type ExtensionEffectHandler = (
  effect: ExtensionEffect,
  ctx: ExtensionContext,
  // biome-ignore lint/suspicious/noConfusingVoidType: a handler with no result returns nothing (vtt-3l6.23's signature)
) => Promise<unknown> | void;

/** Runs an `extension` continuation with the id created by its `opIndex` (else null). */
export type ExtensionContinuationHandler = (id: ObjectId | null, payload: unknown) => void;

/** Named extensions (M5 Q1 A2); an unknown name pushes a warning notice and does nothing else. */
export interface RuntimeExtensions {
  effects?: Record<string, ExtensionEffectHandler>;
  continuations?: Record<string, ExtensionContinuationHandler>;
}

export interface InteractionRuntimeOptions {
  registry: ToolRegistry;
  inputs: RuntimeInputs;
  toolContext: ToolContext;
  ui: UiStore;
  editor: EditorPort;
  /** Resolves once the client has seen `revision` (vtt-3l6.4's `session.whenRevision`). */
  whenRevision: (revision: number) => Promise<void>;
  extensions?: RuntimeExtensions;
  dataDropHandlers?: readonly DataDropHandler[];
}

/** What the runtime shows: the tool overlays and the previews for `buildScene`. */
export interface InteractionView {
  readonly overlays: ToolOverlay[];
  readonly previews: Previews;
}

export interface InteractionRuntime {
  /** Reduces one event and executes its effects (`BoardCanvas`'s `onEvent`). */
  dispatch(event: InteractionEvent): void;
  /**
   * Executes effects built outside the machine (the inspector's Run,
   * vtt-1xv.19) as a data-drop handler's are: stamped as their builder
   * stamped them, cancelled with the active tool, and nothing settles back
   * to a tool. Does nothing after `dispose`.
   */
  execute(effects: readonly Effect[]): void;
  /** The current view; the same object until it changes. */
  getView(): InteractionView;
  /** Adds a listener called after every view change; returns its remover. */
  subscribe(listener: () => void): () => void;
  /** The machine state (the active tool, every tool's state, pending interactions). */
  machine(): MachineState;
  /** Stops following the inputs and the store; later results are dropped. */
  dispose(): void;
}

const EMPTY_PREVIEWS: Previews = new Map();

/** Stamped effects of one interaction the runtime is waiting on. */
interface Started {
  /** The key in `started` and `cancelled` (handler ids are kept apart from the machine's). */
  key: string;
  /** The tool whose cancel cancels it: the emitting tool, or the tool active at a data drop. */
  tool: ToolId;
  /** Whether results settle back to `tool` (false for a data-drop handler's effects). */
  routed: boolean;
  outstanding: number;
}

/** Previews held for a stamp's write. */
interface Hold {
  key: string;
  tool: ToolId;
}

type Origin = "machine" | "handler";

/** The `started` key of an interaction id from `origin`. */
const keyOf = (interactionId: string, origin: Origin): string =>
  origin === "machine" ? `m:${interactionId}` : `h:${interactionId}`;

/** `record[name]` when it is the record's own property (never an inherited one like `toString`). */
function own<T>(record: Record<string, T> | undefined, name: string): T | undefined {
  return record !== undefined && Object.hasOwn(record, name) ? record[name] : undefined;
}

function sameViewer(a: Viewer, b: Viewer): boolean {
  if (a.type === "gm" || b.type === "gm") return a.type === b.type;
  return a.id === b.id;
}

function sameOptions(a: object, b: object): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return (
    ka.length === kb.length &&
    ka.every((k) => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k])
  );
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** An Escape press the machine turns into `cancel(state, "escape")`. */
function isEscapeDown(event: InteractionEvent): boolean {
  return event.type === "key_down" && !event.inTextField && event.key === "Escape";
}

export function createInteractionRuntime(options: InteractionRuntimeOptions): InteractionRuntime {
  const { registry, inputs, toolContext, ui, editor, whenRevision } = options;
  const extensions = options.extensions ?? {};
  const dataDropHandlers = options.dataDropHandlers ?? [];

  const initialTool = ui.getState().tool;
  let state: MachineState = initMachine(registry, {
    ...({ tool: initialTool.id, options: initialTool.options } as SetToolRequest),
    board: inputs.activeBoard(),
    viewer: inputs.viewer(),
  });

  let view: InteractionView = { overlays: [], previews: EMPTY_PREVIEWS };
  let hold: Hold | null = null;
  const listeners = new Set<() => void>();
  const started = new Map<string, Started>();
  /** Interactions whose tool was cancelled after they started (kept: an upload's write reuses its id). */
  const cancelled = new Set<string>();
  let disposed = false;

  // -------------------------------------------------------------------------
  // View

  const setView = (patch: Partial<InteractionView>) => {
    view = { ...view, ...patch };
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A throwing listener must not break the runtime.
      }
    }
  };

  const setPreviews = (previews: Previews, next: Hold | null) => {
    hold = next;
    if (view.previews !== previews) setView({ previews });
  };

  const releaseHold = (h: Hold) => {
    if (hold === h) setPreviews(EMPTY_PREVIEWS, null);
  };

  // -------------------------------------------------------------------------
  // Snapshots and cancellation

  const snapshot = (): ReducerInput => {
    const { camera, selection, snap } = ui.getState();
    return {
      scene: inputs.scene(),
      viewport: inputs.viewport(),
      activeBoard: inputs.activeBoard(),
      viewer: inputs.viewer(),
      revision: inputs.revision(),
      camera,
      selection: [...selection],
      views: (id) => inputs.views(id),
      ...(inputs.directory === undefined
        ? {}
        : { directory: (id: ObjectId) => inputs.directory?.(id) ?? null }),
      snap,
    };
  };

  /** Records that `tool` is being cancelled: its earlier interactions and held previews end. */
  const markCancelled = (tool: ToolId) => {
    for (const [id, s] of started) {
      if (s.tool === tool) cancelled.add(id);
    }
    if (hold !== null && hold.tool === tool) setPreviews(EMPTY_PREVIEWS, null);
  };

  /** Runs `syncInput` against the current inputs; cancels on a board or viewer change. */
  const sync = (input: Pick<ReducerInput, "activeBoard" | "viewer">) => {
    const out = syncInput(state, input, registry);
    if (out.state === state) return;
    markCancelled(state.tool);
    state = out.state;
    run(out.effects, "machine");
  };

  /** Activates a tool on the machine (cancelling the active one when it changes). */
  const applyTool = (request: SetToolRequest) => {
    if (registry.get(request.tool) === undefined) {
      toolContext.notify("error", `The tool "${request.tool}" is not available.`);
      return;
    }
    if (request.tool !== state.tool) markCancelled(state.tool);
    const out = setTool(state, request, registry);
    state = out.state;
    run(out.effects, "machine");
  };

  /** A `set_tool` effect or continuation: the machine, then the store. */
  const requestTool = (request: SetToolRequest) => {
    applyTool(request);
    if (registry.get(request.tool) !== undefined)
      ui.setTool(request.tool, request.options as never);
  };

  /** Follows `UiStore.tool` changes made elsewhere. */
  const followUi = () => {
    if (disposed) return;
    const tool = ui.getState().tool;
    const current = state.tools[tool.id];
    if (
      tool.id === state.tool &&
      current !== undefined &&
      sameOptions(current.options, tool.options)
    ) {
      return;
    }
    applyTool({ tool: tool.id, options: tool.options } as SetToolRequest);
  };

  // -------------------------------------------------------------------------
  // Dispatch

  const dispatch = (event: InteractionEvent) => {
    if (disposed) return;
    const input = snapshot();
    sync(input);
    if (event.type === "data_drop") {
      for (const handler of dataDropHandlers) {
        const effects = handler(event, input);
        if (effects !== null) {
          run(effects, "handler");
          return;
        }
      }
    }
    if (isEscapeDown(event)) markCancelled(state.tool);
    const out = reduce(state, event, input, registry);
    state = out.state;
    run(out.effects, "machine");
  };

  /** Dispatches an async result back to the tool that started it (machine-owned interactions only). */
  const settle = (s: Started, interactionId: string, outcome: SettledOutcome) => {
    if (disposed || !s.routed) return;
    try {
      dispatch({ type: "settled", interactionId, outcome });
    } catch (e) {
      toolContext.notify("error", `The interaction failed: ${messageOf(e)}`);
    }
  };

  /** Ends one outstanding effect of `interactionId`. */
  const finish = (s: Started) => {
    s.outstanding--;
    if (s.outstanding <= 0 && started.get(s.key) === s) started.delete(s.key);
  };

  /** Whether the continuations of `s`'s interaction, stamped `stamp`, may run now. */
  const live = (s: Started, stamp: InteractionStamp): boolean =>
    !disposed &&
    !cancelled.has(s.key) &&
    stamp.board === inputs.activeBoard() &&
    sameViewer(stamp.viewer, inputs.viewer());

  const runContinuations = (continuations: readonly Continuation[], result: CommittedWrite) => {
    for (const c of continuations) {
      switch (c.type) {
        case "select_created": {
          const id = createdIdAt(result, c.opIndex);
          if (id !== null) ui.select([id]);
          break;
        }
        case "select":
          ui.select(c.ids);
          break;
        case "set_tool": {
          const { type: _type, ...request } = c;
          requestTool(request as SetToolRequest);
          break;
        }
        case "extension": {
          const handler = own(extensions.continuations, c.name);
          if (handler === undefined) {
            toolContext.notify("warning", `Unknown extension "${c.name}".`);
            break;
          }
          handler(c.opIndex === undefined ? null : createdIdAt(result, c.opIndex), c.payload);
          break;
        }
      }
    }
  };

  // -------------------------------------------------------------------------
  // Effects

  /** The tool whose cancel cancels an interaction: the machine's record, else the active tool. */
  const ownerOf = (interactionId: string, origin: Origin): ToolId =>
    origin === "machine" ? (state.pending[interactionId]?.tool ?? state.tool) : state.tool;

  const track = (effect: Effect, origin: Origin): Started | null => {
    const interactionId = settlingInteraction(effect);
    if (interactionId === null) return null;
    const key = keyOf(interactionId, origin);
    let s = started.get(key);
    if (s === undefined) {
      s = {
        key,
        tool: ownerOf(interactionId, origin),
        routed: origin === "machine",
        outstanding: 0,
      };
      started.set(key, s);
    }
    s.outstanding++;
    return s;
  };

  const write = async (effect: Extract<Effect, { type: "write" }>, s: Started) => {
    const { stamp } = effect;
    let result: WriteOutcome;
    try {
      result = await toolContext.write.write(effect.ops, {
        baseRevision: stamp.baseRevision,
        label: effect.label,
      });
    } catch (e) {
      const message = messageOf(e);
      toolContext.notify("error", `"${effect.label}" was not applied: ${message}`);
      result = { status: "failed", error: { code: "internal", message } };
    }
    finish(s);
    const allowed = result.status === "committed" && live(s, stamp);
    // Previews held for this stamp, unless newer previews replaced them meanwhile.
    const h = hold !== null && hold.key === s.key ? hold : null;
    if (h !== null) {
      if (result.status === "committed") {
        whenRevision(result.revision).then(
          () => releaseHold(h),
          () => releaseHold(h),
        );
      } else {
        releaseHold(h);
      }
    }
    settle(s, stamp.interactionId, { type: "write", result });
    if (allowed && result.status === "committed") runContinuations(effect.continuations, result);
  };

  const pickFile = async (effect: Extract<Effect, { type: "pick_file" }>, s: Started) => {
    let file: File | null;
    try {
      file = await toolContext.pickFile(effect.accept);
    } catch {
      file = null;
    }
    finish(s);
    settle(s, effect.stamp.interactionId, { type: "file_picked", file });
  };

  const upload = async (effect: Extract<Effect, { type: "upload" }>, s: Started) => {
    let outcome: SettledOutcome;
    try {
      const asset = await toolContext.upload(effect.file);
      outcome = { type: "uploaded", path: asset.path, width: asset.width, height: asset.height };
    } catch (e) {
      outcome = { type: "upload_failed", message: messageOf(e) };
    }
    finish(s);
    settle(s, effect.stamp.interactionId, outcome);
  };

  const extension = async (effect: ExtensionEffect, s: Started | null) => {
    const handler = own(extensions.effects, effect.name);
    if (handler === undefined) {
      if (s !== null && effect.stamp !== undefined) finish(s);
      toolContext.notify("warning", `Unknown extension "${effect.name}".`);
      return;
    }
    let result: unknown;
    try {
      result = await handler(effect, { toolContext, ui, editor });
    } catch (e) {
      toolContext.notify("error", `The extension "${effect.name}" failed: ${messageOf(e)}`);
      result = undefined;
    }
    if (s === null || effect.stamp === undefined) return;
    finish(s);
    settle(s, effect.stamp.interactionId, { type: "extension", name: effect.name, result });
  };

  /** Fires an async effect; its own failures are already handled. */
  const background = (p: Promise<void>) => {
    p.catch((e: unknown) => toolContext.notify("error", `The interaction failed: ${messageOf(e)}`));
  };

  function run(effects: readonly Effect[], origin: Origin): void {
    for (const effect of effects) {
      if (disposed) return;
      const s = track(effect, origin);
      switch (effect.type) {
        case "write":
          if (s !== null) background(write(effect, s));
          break;
        case "pick_file":
          if (s !== null) background(pickFile(effect, s));
          break;
        case "upload":
          if (s !== null) background(upload(effect, s));
          break;
        case "extension":
          background(extension(effect, s));
          break;
        case "previews":
          setPreviews(
            effect.previews,
            effect.hold === undefined
              ? null
              : {
                  key: keyOf(effect.hold.stamp.interactionId, origin),
                  tool: ownerOf(effect.hold.stamp.interactionId, origin),
                },
          );
          break;
        case "overlays":
          setView({ overlays: [...effect.overlays] });
          break;
        case "select":
          ui.select(effect.ids);
          break;
        case "camera":
          toolContext.camera.set(effect.camera);
          break;
        case "hover":
          ui.setHover(effect.id);
          ui.setHoveredZone(effect.zone);
          break;
        case "alt_hover":
          ui.setAltHover(effect.id);
          break;
        case "notice":
          toolContext.notify(effect.level, effect.text);
          break;
        case "set_tool": {
          const { type: _type, ...request } = effect;
          requestTool(request as SetToolRequest);
          break;
        }
        case "open_editor": {
          const { type: _type, ...request } = effect;
          editor.open(request);
          break;
        }
        case "close_editor":
          editor.close();
          break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Wiring

  const offInputs = inputs.onChange(() => {
    if (disposed) return;
    sync({ activeBoard: inputs.activeBoard(), viewer: inputs.viewer() });
  });
  const offUi = ui.subscribe(followUi);

  return {
    dispatch,
    execute(effects) {
      if (disposed) return;
      run(effects, "handler");
    },
    getView: () => view,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    machine: () => state,
    dispose() {
      if (disposed) return;
      disposed = true;
      offInputs();
      offUi();
      listeners.clear();
    },
  };
}
