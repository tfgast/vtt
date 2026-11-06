/**
 * Binders, working copies and edit-template (vtt-1xv.17; DESIGN.md §4.7
 * binder entries are templates, working copies, edit-template, drag out;
 * §4.1 spawn; §8.4 steps 9, 10, 12; M5 plan Q1 A1/A2, Q14, Q15, Q17, review
 * r1 finding 11, r2 findings 2, 9, r3 findings 3, 8).
 *
 * `binderPolicy({faceState, ui, inputs})` is a vtt-1xv.14 `FacePolicy` for
 * vtt-1xv.16's `withFaces`:
 *
 * - a chevron on a collapsed template entry never expands the template. The
 *   working copies are the non-template entries of the same container whose
 *   `template` cell refers to it. With one or more, the first in contents
 *   order is selected, expanded and scrolled into view in the list holding
 *   it (the last entry of the hit's `path`: `revealOffset`, the whole row
 *   when it fits, else its top); nothing is written. With none, one write
 *   `spawn {template, to: {type: "container", container, index:
 *   templateIndex + 1}}` with the click's stamp and the single continuation
 *   `{type: "extension", name: "expand_created", opIndex: 0, payload}`
 *   stamped with the click's board and viewer;
 * - a chevron on anything else: the default toggle (`withFaces`);
 * - a gear on a template (a contents entry's, or the gear drawn on a
 *   template placed directly on a board): selects it and marks it as the
 *   template being edited (`editing()`), shown by `<EditTemplateBanner>`
 *   until the selection changes (or the template is gone). Inspector edits
 *   are ordinary writes on the template.
 *
 * `expandCreatedHandler(faceState, ui, inputs)` is the runtime's
 * `expand_created` continuation (register it under
 * `EXPAND_CREATED_EXTENSION`): it selects, expands and scrolls the created
 * copy into view only while the active board and the viewer still equal the
 * payload's; otherwise it does nothing (the copy still exists). Card
 * lifetime is manual (Q17): a working copy is discarded by its own Discard
 * action or the Delete key, never by this module.
 */
import type { ObjectView, Viewer, WireOp } from "@vtt/protocol";
import type { BoardId, ObjectId } from "@vtt/schema";
import { defaultFacePolicy } from "../actions/invoke";
import type { FaceHit, FacePathEntry, FacePolicy } from "../face/face-contracts";
import { pathContents } from "../face/face-hit";
import { revealOffset } from "../face/face-model";
import { attachFaces } from "../face/face-scene";
import type { FaceStateStore } from "../face/face-state";
import type { InteractionStamp, RuntimeInputs } from "../interaction/contracts";
import { objectName } from "../interaction/drop-targets";
import type { Effect } from "../interaction/effects";
import type { ExtensionContinuationHandler } from "../interaction/runtime";
import type { ReducerInput } from "../interaction/tool";
import type { UiStore } from "../state/ui-state";

/** The runtime continuation name of a working copy's spawn (register `expandCreatedHandler` under it). */
export const EXPAND_CREATED_EXTENSION = "expand_created";

/** One step of the list path a working copy is revealed in: a contents element of a container. */
export type RevealStep = Pick<FacePathEntry, "container" | "element">;

/**
 * The payload of the `expand_created` continuation: the board and viewer of
 * the click, and the path of contents elements (board object inward) whose
 * last list holds the copy, for scrolling it into view.
 */
export interface ExpandCreatedPayload {
  board: BoardId;
  viewer: Viewer;
  path: RevealStep[];
}

export interface BinderPolicyOptions {
  /** The session's face state (the store `withFaces` and the face scene use). */
  faceState: FaceStateStore;
  ui: UiStore;
  inputs: RuntimeInputs;
}

export interface BinderPolicy extends FacePolicy {
  /** The template selected for editing with the gear, or null. */
  editing(): ObjectId | null;
  /** Adds a listener called when `editing()` changes; returns its remover. */
  subscribe(listener: () => void): () => void;
  /** Stops following the selection and the inputs. */
  dispose(): void;
}

function sameViewer(a: Viewer, b: Viewer): boolean {
  if (a.type === "gm" || b.type === "gm") return a.type === b.type;
  return a.id === b.id;
}

/**
 * The `contents` cell's entries in order, a redacted one as null, so
 * positions are those of the stored list (indices for writes).
 */
function contentsRefs(view: ObjectView | null): (ObjectId | null)[] {
  const v = view?.cells.contents?.value;
  if (v?.type !== "list") return [];
  return v.items.map((item) => (item.type === "ref" ? item.object : null));
}

/** Whether `view`'s `template` cell refers to `template`. */
function copiedFrom(view: ObjectView | null, template: ObjectId): boolean {
  const t = view?.cells.template?.value;
  return t?.type === "ref" && t.object === template;
}

/**
 * The working copies of `template` in `container`, in contents order: its
 * non-template entries whose `template` cell refers to `template`.
 */
export function workingCopies(
  views: (id: ObjectId) => ObjectView | null,
  container: ObjectId,
  template: ObjectId,
): ObjectId[] {
  return contentsRefs(views(container)).filter((id): id is ObjectId => {
    if (id === null) return false;
    const view = views(id);
    return view !== null && !view.is_template && copiedFrom(view, template);
  });
}

type RevealInputs = Pick<ReducerInput, "scene" | "views" | "viewer">;

/**
 * Scrolls the last list of `path` so `id`'s row shows (`revealOffset`);
 * false when that list or the row is not drawn (yet). Faces are resolved
 * with `id` selected, as every caller selects it, so a `when_selected` list
 * holding it is drawn (M6-D12).
 */
function reveal(
  faceState: FaceStateStore,
  input: RevealInputs,
  path: readonly RevealStep[],
  id: ObjectId,
): boolean {
  const last = path[path.length - 1];
  if (last === undefined) return false;
  const faces = attachFaces(input.scene, input.views, faceState, {
    gm: input.viewer.type === "gm",
    selection: [id],
  });
  const list = pathContents(faces, path)[path.length - 1];
  if (list === undefined || !list.entries.some((e) => e.id === id)) return false;
  faceState.setScroll(last.container, last.element, revealOffset(list, id), list.maxOffset);
  return true;
}

function revealInputs(inputs: RuntimeInputs): RevealInputs {
  return { scene: inputs.scene(), views: (id) => inputs.views(id), viewer: inputs.viewer() };
}

/**
 * Selects and expands `id` and reveals it in `path`'s last list, now when it
 * is drawn, else at the first change of the inputs that draws it (given up
 * on a board or viewer change, or once the selection is no longer `[id]`).
 */
function selectExpandReveal(
  faceState: FaceStateStore,
  ui: UiStore,
  inputs: RuntimeInputs,
  path: readonly RevealStep[],
  id: ObjectId,
): void {
  ui.select([id]);
  faceState.expand(id);
  if (reveal(faceState, revealInputs(inputs), path, id)) return;
  const board = inputs.activeBoard();
  const viewer = inputs.viewer();
  const off = inputs.onChange(() => {
    const selection = ui.getState().selection;
    if (
      inputs.activeBoard() !== board ||
      !sameViewer(inputs.viewer(), viewer) ||
      selection.length !== 1 ||
      selection[0] !== id
    ) {
      off();
      return;
    }
    if (reveal(faceState, revealInputs(inputs), path, id)) off();
  });
}

function isPayload(p: unknown): p is ExpandCreatedPayload {
  if (typeof p !== "object" || p === null) return false;
  const q = p as Partial<ExpandCreatedPayload>;
  return (
    typeof q.board === "string" &&
    typeof q.viewer === "object" &&
    q.viewer !== null &&
    Array.isArray(q.path)
  );
}

/**
 * The `expand_created` continuation: with the created copy `id`, selects,
 * expands and reveals it only when `inputs.activeBoard()` and
 * `inputs.viewer()` still equal the payload's; otherwise nothing.
 */
export function expandCreatedHandler(
  faceState: FaceStateStore,
  ui: UiStore,
  inputs: RuntimeInputs,
): ExtensionContinuationHandler {
  return (id, payload) => {
    if (id === null || !isPayload(payload)) return;
    if (inputs.activeBoard() !== payload.board) return;
    if (!sameViewer(inputs.viewer(), payload.viewer)) return;
    selectExpandReveal(faceState, ui, inputs, payload.path, id);
  };
}

/**
 * The write making a working copy of `template` right after it in
 * `container` (at `index`), revealed in `path` by `expand_created`.
 */
export function workingCopyWrite(
  stamp: InteractionStamp,
  template: ObjectId,
  templateName: string,
  container: ObjectId,
  index: number,
  path: readonly RevealStep[],
): Effect {
  const ops: WireOp[] = [{ type: "spawn", template, to: { type: "container", container, index } }];
  const payload: ExpandCreatedPayload = {
    board: stamp.board,
    viewer: stamp.viewer,
    path: path.map((p) => ({ container: p.container, element: p.element })),
  };
  return {
    type: "write",
    stamp,
    ops,
    label: `Working copy of ${templateName}`,
    continuations: [{ type: "extension", name: EXPAND_CREATED_EXTENSION, opIndex: 0, payload }],
  };
}

/** The binder policy (see the module comment). */
export function binderPolicy(options: BinderPolicyOptions): BinderPolicy {
  const { faceState, ui, inputs } = options;
  let editing: ObjectId | null = null;
  const listeners = new Set<() => void>();
  const setEditing = (id: ObjectId | null) => {
    if (editing === id) return;
    editing = id;
    for (const listener of [...listeners]) listener();
  };

  // The banner lasts until the selection changes, or the template is gone.
  const offUi = ui.subscribe(() => {
    if (editing === null) return;
    const selection = ui.getState().selection;
    if (selection.length !== 1 || selection[0] !== editing) setEditing(null);
  });
  const offInputs = inputs.onChange(() => {
    if (editing !== null && inputs.views(editing) === null) setEditing(null);
  });

  /** A chevron on a template entry: reuse the first working copy, else spawn one. */
  const onTemplateChevron = (
    hit: FaceHit,
    template: ObjectView,
    input: ReducerInput,
    stamp: InteractionStamp,
  ): Effect[] => {
    const last = hit.path[hit.path.length - 1];
    if (last === undefined) return [];
    const path: RevealStep[] = hit.path.map((p) => ({
      container: p.container,
      element: p.element,
    }));
    const [copy] = workingCopies(input.views, last.container, template.id);
    if (copy !== undefined) {
      faceState.expand(copy);
      reveal(faceState, input, path, copy);
      return [{ type: "select", ids: [copy] }];
    }
    // The index in the stored list: redacted entries keep their positions.
    const index = contentsRefs(input.views(last.container)).indexOf(template.id);
    if (index < 0) return [];
    const name = objectName(template, template.id);
    return [workingCopyWrite(stamp, template.id, name, last.container, index + 1, path)];
  };

  return {
    canInvoke: (view) => defaultFacePolicy.canInvoke(view),
    onToggle(hit, ctx) {
      if (hit.target.type !== "chevron") return null;
      const id = hit.target.id;
      const view = ctx.input.views(id);
      if (view === null || !view.is_template) return null;
      // Only a collapsed template entry makes or reuses a working copy.
      const faces = attachFaces(ctx.input.scene, ctx.input.views, faceState, {
        gm: ctx.input.viewer.type === "gm",
        selection: ctx.input.selection,
      });
      const list = pathContents(faces, hit.path)[hit.path.length - 1];
      if (list?.entries.find((e) => e.id === id)?.expanded === true) return null;
      return onTemplateChevron(hit, view, ctx.input, ctx.stamp);
    },
    onGear(hit, ctx) {
      if (hit.target.type !== "gear") return null;
      const id = hit.target.id;
      const view = ctx.input.views(id);
      if (view === null || !view.is_template) return null;
      setEditing(id);
      return [{ type: "select", ids: [id] }];
    },
    editing: () => editing,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      offUi();
      offInputs();
      listeners.clear();
    },
  };
}
