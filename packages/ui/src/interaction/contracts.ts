/**
 * The ports and snapshots the interaction layer is built on (DESIGN.md §7
 * Platform and Undo; docs/PROTOCOL.md §4, §6; M4 plan review r2 findings 3
 * and 8, r3 finding 2). Defined here, implemented elsewhere: `WritePort`,
 * `CameraPort`, `ToolContext` and `RuntimeInputs` by vtt-3l6.21 (with
 * `pickFile` and `upload` supplied by vtt-3l6.17); consumed by the runtime
 * (vtt-3l6.23) and the tools. Types and pure functions only.
 */
import type { ObjectView, ProtocolError, ProtocolRejection, Viewer, WireOp } from "@vtt/protocol";
import type { BoardId, ObjectId } from "@vtt/schema";
import type { Camera } from "../scene/camera";
import type { Scene, ScenePreviews } from "../scene/scene";

/** A committed write: `TransactResult`'s committed record (PROTOCOL.md §4). */
export interface CommittedWrite {
  status: "committed";
  revision: number;
  index: number;
  /** One record per created object, by the `op_index` of the op that created it. */
  created: { op_index: number; id: ObjectId }[];
  /** One record per `spawn`: the copy of the template (`root`) and every copied id. */
  copies: { op_index: number; root: ObjectId; copies: Record<ObjectId, ObjectId> }[];
  bindings: Record<string, ObjectId>;
}

/**
 * How a write ended. `committed` and `rejected` are the authority's
 * `TransactResult` as it stands (a `TransactResult` is a `WriteOutcome`);
 * `uncertain` is a write sent but not settled (PROTOCOL.md §6: a timeout, a
 * lost socket, `retry_unknown`), with the reason in words; `failed` is any
 * other protocol error. Nothing is retried or rebased (M4-D7).
 */
export type WriteOutcome =
  | CommittedWrite
  | { status: "rejected"; rejection: ProtocolRejection; op_index?: number }
  | { status: "uncertain"; reason: string }
  | { status: "failed"; error: ProtocolError };

/**
 * `baseRevision` is the revision the interaction began on and is sent
 * unchanged as `base_revision` (M4-D7; review r1 finding 1).
 */
export interface WriteOptions {
  baseRevision: number;
  label?: string;
}

/** Writes ops as one transaction (implemented by vtt-3l6.21's `createWritePort`). */
export interface WritePort {
  write(ops: WireOp[], opts: WriteOptions): Promise<WriteOutcome>;
}

/** The camera, whose state lives in vtt-3l6.21's `UiStore`. */
export interface CameraPort {
  get(): Camera;
  set(camera: Camera): void;
}

/** Notice levels (vtt-3l6.21's `NoticeStore` owns stickiness and expiry). */
export type NoticeLevel = "info" | "success" | "warning" | "error";

/** An uploaded image asset: its table-relative path and its pixel size. */
export interface UploadedAsset {
  path: string;
  width: number;
  height: number;
}

/** The ports the runtime executes effects against (vtt-3l6.21's `createToolContext`). */
export interface ToolContext {
  activeBoard(): BoardId | null;
  viewer(): Viewer;
  revision(): number;
  camera: CameraPort;
  write: WritePort;
  notify(level: NoticeLevel, text: string): void;
  /** Resolves null when the dialog is dismissed. */
  pickFile(accept: string): Promise<File | null>;
  upload(file: File): Promise<UploadedAsset>;
}

/** The board canvas's size in CSS pixels, and the device pixel ratio. */
export interface Viewport {
  width: number;
  height: number;
  dpr: number;
}

/**
 * Live reads the runtime builds each `ReducerInput` from (vtt-3l6.21's
 * `createRuntimeInputs`). `onChange` fires on any change of board, viewer,
 * revision or viewport and returns an unsubscribe function.
 */
export interface RuntimeInputs {
  views(id: ObjectId): ObjectView | null;
  scene(): Scene;
  viewport(): Viewport;
  activeBoard(): BoardId | null;
  viewer(): Viewer;
  revision(): number;
  onChange(fn: () => void): () => void;
}

/** Geometry overrides during a gesture: vtt-3l6.5's `ScenePreviews`, passed to `buildScene`. */
export type Previews = ScenePreviews;

/**
 * Captured by a tool when an interaction starts (pointer down, key press,
 * file drop, click): its writes go to `board` with `baseRevision`, and its
 * async results are routed back by `interactionId` (review r2 finding 8).
 */
export interface InteractionStamp {
  interactionId: string;
  board: BoardId;
  viewer: Viewer;
  baseRevision: number;
}
