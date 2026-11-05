// @vitest-environment node
/**
 * The binder policy's pure parts (vtt-1xv.17; DESIGN.md §4.7; M5 plan Q1
 * A1/A2, Q15, review r2 finding 9): the `expand_created` continuation's
 * board and viewer check, the working-copy write, the working-copy match
 * and the edit-template state. The gestures run end to end in
 * binder-integration.test.tsx.
 */
import type { ObjectView, Viewer } from "@vtt/protocol";
import type { BoardId, ObjectId } from "@vtt/schema";
import {
  binderPolicy,
  createFaceStateStore,
  EXPAND_CREATED_EXTENSION,
  editTemplateText,
  expandCreatedHandler,
  type FaceHit,
  type InteractionStamp,
  type ReducerInput,
  type RuntimeInputs,
  type Scene,
  type UiStore,
  workingCopies,
  workingCopyWrite,
} from "@vtt/ui";
import { describe, expect, test } from "vitest";

const GM: Viewer = { type: "gm" };
const ALDRIC: Viewer = { type: "character", id: "aldric" };
const EMPTY_SCENE: Scene = { items: [], covers: [], objectOverlays: [], skipped: [] };

/** A `UiStore` holding only a selection. */
function fakeUi(): UiStore {
  let state = { selection: [] as ObjectId[] };
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    select(ids: readonly ObjectId[]) {
      state = { ...state, selection: [...ids] };
      for (const fn of [...listeners]) fn();
    },
  } as unknown as UiStore;
}

/** Live inputs with a settable board, viewer and views. */
function fakeInputs(views: Record<ObjectId, ObjectView> = {}) {
  let board: BoardId | null = "gm_board";
  let viewer: Viewer = GM;
  const listeners = new Set<() => void>();
  const inputs: RuntimeInputs = {
    views: (id) => views[id] ?? null,
    scene: () => EMPTY_SCENE,
    viewport: () => ({ width: 800, height: 600, dpr: 1 }),
    activeBoard: () => board,
    viewer: () => viewer,
    revision: () => 1,
    onChange(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
  const changed = () => {
    for (const fn of [...listeners]) fn();
  };
  return {
    inputs,
    views,
    setBoard(b: BoardId | null) {
      board = b;
      changed();
    },
    setViewer(v: Viewer) {
      viewer = v;
      changed();
    },
    changed,
  };
}

const ref = (object: string) => ({ type: "ref" as const, object });
const text = (value: string) => ({ type: "text" as const, value });

function view(id: string, cells: Record<string, unknown>, template = false): ObjectView {
  const out: Record<string, { value: unknown }> = {};
  for (const [k, v] of Object.entries(cells)) out[k] = { value: v };
  return {
    id,
    is_template: template,
    is_character: false,
    cells: out,
    actions: [],
  } as unknown as ObjectView;
}

const PAYLOAD = { board: "gm_board", viewer: GM, path: [{ container: "bnd", element: 0 }] };

describe("expandCreatedHandler", () => {
  test("on the stamp's board and viewer it selects and expands the copy", () => {
    const faceState = createFaceStateStore();
    const ui = fakeUi();
    const { inputs } = fakeInputs();
    expandCreatedHandler(faceState, ui, inputs)("copy", PAYLOAD);
    expect(ui.getState().selection).toEqual(["copy"]);
    expect(faceState.isExpanded("copy", "collapsed")).toBe(true);
  });

  test("after a board switch it does nothing", () => {
    const faceState = createFaceStateStore();
    const ui = fakeUi();
    const f = fakeInputs();
    f.setBoard("crypt");
    expandCreatedHandler(faceState, ui, f.inputs)("copy", PAYLOAD);
    expect(ui.getState().selection).toEqual([]);
    expect(faceState.isExpanded("copy", "collapsed")).toBe(false);
  });

  test("after a viewer switch it does nothing", () => {
    const faceState = createFaceStateStore();
    const ui = fakeUi();
    const f = fakeInputs();
    f.setViewer(ALDRIC);
    expandCreatedHandler(faceState, ui, f.inputs)("copy", PAYLOAD);
    expect(ui.getState().selection).toEqual([]);
    expect(faceState.isExpanded("copy", "collapsed")).toBe(false);
  });

  test("a character viewer must be the same character", () => {
    const faceState = createFaceStateStore();
    const ui = fakeUi();
    const f = fakeInputs();
    f.setViewer({ type: "character", id: "bryn" });
    expandCreatedHandler(faceState, ui, f.inputs)("copy", { ...PAYLOAD, viewer: ALDRIC });
    expect(ui.getState().selection).toEqual([]);
    f.setViewer(ALDRIC);
    expandCreatedHandler(faceState, ui, f.inputs)("copy", { ...PAYLOAD, viewer: ALDRIC });
    expect(ui.getState().selection).toEqual(["copy"]);
  });

  test("without a created id or with a malformed payload it does nothing", () => {
    const faceState = createFaceStateStore();
    const ui = fakeUi();
    const { inputs } = fakeInputs();
    const handler = expandCreatedHandler(faceState, ui, inputs);
    handler(null, PAYLOAD);
    handler("copy", { board: "gm_board" });
    handler("copy", undefined);
    expect(ui.getState().selection).toEqual([]);
    expect(faceState.isExpanded("copy", "collapsed")).toBe(false);
  });
});

describe("workingCopyWrite", () => {
  test("one spawn after the template with the single expand_created continuation stamped with the click's board and viewer", () => {
    const stamp: InteractionStamp = {
      interactionId: "i1",
      board: "gm_board",
      viewer: ALDRIC,
      baseRevision: 7,
    };
    const path = [{ container: "bnd", element: 0 }];
    expect(workingCopyWrite(stamp, "tpl", "Attack", "bnd", 3, path)).toEqual({
      type: "write",
      stamp,
      ops: [
        { type: "spawn", template: "tpl", to: { type: "container", container: "bnd", index: 3 } },
      ],
      label: "Working copy of Attack",
      continuations: [
        {
          type: "extension",
          name: EXPAND_CREATED_EXTENSION,
          opIndex: 0,
          payload: { board: "gm_board", viewer: ALDRIC, path },
        },
      ],
    });
    expect(EXPAND_CREATED_EXTENSION).toBe("expand_created");
  });
});

describe("workingCopies", () => {
  test("the non-template entries of the container whose template refers to it, in contents order", () => {
    const views: Record<string, ObjectView> = {
      bnd: view("bnd", {
        contents: {
          type: "list",
          items: [
            ref("tpl"),
            ref("c2"),
            ref("other"),
            ref("given"),
            { type: "redacted" },
            ref("c1"),
          ],
        },
      }),
      tpl: view("tpl", { name: text("Attack") }, true),
      c1: view("c1", { template: ref("tpl") }),
      c2: view("c2", { template: ref("tpl") }),
      other: view("other", { template: ref("elsewhere") }),
      // A given template copied from `tpl` is a template, not a working copy.
      given: view("given", { template: ref("tpl") }, true),
    };
    expect(workingCopies((id) => views[id] ?? null, "bnd", "tpl")).toEqual(["c2", "c1"]);
  });
});

describe("edit-template state", () => {
  const gearHit = (id: string): FaceHit => ({
    object: id,
    path: [],
    toLocal: [1, 0, 0, 1, 0, 0],
    rect: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
    target: { type: "gear", id },
  });
  const ctx = (input: Partial<ReducerInput>) => ({
    input: input as ReducerInput,
    stamp: { interactionId: "i", board: "gm_board", viewer: GM, baseRevision: 1 },
    faceState: createFaceStateStore(),
  });

  test("a gear on a template selects it and marks it edited until the selection changes", () => {
    const f = fakeInputs({ tpl: view("tpl", { name: text("Attack") }, true) });
    const ui = fakeUi();
    const policy = binderPolicy({ faceState: createFaceStateStore(), ui, inputs: f.inputs });
    const seen: (string | null)[] = [];
    policy.subscribe(() => seen.push(policy.editing()));
    const effects = policy.onGear?.(gearHit("tpl"), ctx({ views: f.inputs.views }));
    expect(effects).toEqual([{ type: "select", ids: ["tpl"] }]);
    expect(policy.editing()).toBe("tpl");
    ui.select(["tpl"]);
    expect(policy.editing()).toBe("tpl");
    ui.select(["goblin"]);
    expect(policy.editing()).toBeNull();
    expect(seen).toEqual(["tpl", null]);
    policy.dispose();
  });

  test("the edited template disappearing ends it", () => {
    const f = fakeInputs({ tpl: view("tpl", {}, true) });
    const ui = fakeUi();
    const policy = binderPolicy({ faceState: createFaceStateStore(), ui, inputs: f.inputs });
    policy.onGear?.(gearHit("tpl"), ctx({ views: f.inputs.views }));
    ui.select(["tpl"]);
    delete f.views.tpl;
    f.changed();
    expect(policy.editing()).toBeNull();
    policy.dispose();
  });

  test("a gear on a non-template is left to the default (nothing)", () => {
    const f = fakeInputs({ card: view("card", {}) });
    const policy = binderPolicy({
      faceState: createFaceStateStore(),
      ui: fakeUi(),
      inputs: f.inputs,
    });
    expect(policy.onGear?.(gearHit("card"), ctx({ views: f.inputs.views }))).toBeNull();
    expect(policy.editing()).toBeNull();
    policy.dispose();
  });

  test("templates are not played (the default canInvoke)", () => {
    const f = fakeInputs();
    const policy = binderPolicy({
      faceState: createFaceStateStore(),
      ui: fakeUi(),
      inputs: f.inputs,
    });
    expect(policy.canInvoke(view("tpl", {}, true)).ok).toBe(false);
    expect(policy.canInvoke(view("card", {})).ok).toBe(true);
    policy.dispose();
  });

  test("the banner text", () => {
    expect(editTemplateText("Attack")).toBe(
      "Editing template Attack: changes apply to copies made from now on",
    );
  });
});
