/**
 * The in-place editor (vtt-3l6.13; DESIGN.md §4.6 Edit in place, Default
 * rendering until faces, Typing into a cell, Appearance cells (covers), View
 * as in the UI; §7 Platform: "In-place editing is a DOM overlay positioned
 * over the cell"; §5.2 and M4-D7; review r1 findings 1, 4, r2 finding 5, r3
 * findings 4, 8; M5 plan Q1 A5).
 *
 * Rendered in `BoardCanvas`'s overlay; opened through the `EditorPort` of
 * `createInPlaceEditorPort(ui)` (editor-port.ts). On `open` for object O the
 * target cell is `cell` if given, else `text` when O has a `text` cell, else
 * `name`. It opens only
 *
 * - as the GM (never in view-as), for the viewer and active board of the
 *   request's stamp;
 * - when `cellCapabilities` allows a literal in the target cell;
 * - when its screen rectangle (the request's `rect`, else O's bounds, in
 *   board space, transformed exactly) intersects no cover of the current
 *   scene. The field has a CSS minimum size and may extend past a tiny
 *   rectangle; positioning and the cover test use the rectangle itself.
 *
 * A formula target that is not overridden focuses the formula bar instead
 * (`requestFormulaBarFocus`). The editor writes literals or overrides,
 * prefilled with `valueToInputText`, except that a cell whose value is the
 * empty text opens blank rather than as `""` (vtt-qf5.43, `isBlankText`); a
 * value with no input text opens an empty replace-value input with its
 * reason; `=…` writes a formula (not in
 * `name`, whose input is always text). A `textarea` for `text` (Shift+Enter
 * is a newline), else an `input`. Enter and blur commit with the stamp's
 * `baseRevision` (unchanged input writes nothing, except over a formula cell
 * without an override, where any literal is an override: M4-D6); Escape
 * cancels. A blur from the window losing focus (alt-tab, switching to another
 * app; `document.hasFocus()` false at blur) commits nothing: the editor stays
 * open with its draft, and focus coming back to the field resumes it; if the
 * window comes back with focus elsewhere, the editor closes without writing
 * (vtt-qf5.59, as the formula bar's vtt-nb8.21).
 *
 * It closes without committing when a cover comes over its rectangle, when
 * the viewer changes, when the active board is no longer `stamp.board`, when
 * the object is gone, or on `EditorPort.close`.
 */
import type { CellView, ObjectView, Viewer, WireResult } from "@vtt/protocol";
import { type Bounds, type Footprint, footprintsOverlap, type Point } from "@vtt/schema";
import {
  type CSSProperties,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { type Camera, toBoard, toScreen } from "../scene/camera";
import type { Scene } from "../scene/scene";
import type { TableSession } from "../session/table-session";
import { createWritePort } from "../session/writes";
import type { UiStore } from "../state/ui-state";
import {
  cellCapabilities,
  isUnchangedInput,
  parseCellInput,
  valueToInputText,
} from "../values/input";
import { cellInputToOps } from "../values/ops";
import {
  endInPlaceEdit,
  type InPlaceEditRequest,
  inPlaceEditRequest,
  requestFormulaBarFocus,
  subscribeInPlaceEdit,
} from "./editor-port";

/**
 * The field's CSS minimum width: a usability floor for the field only. The
 * editor's rectangle (its position and the cover test) is always the exact
 * transformed target; a field at its minimum may extend past it.
 */
export const MIN_EDITOR_WIDTH_PX = 80;
/** The field's CSS minimum height (see `MIN_EDITOR_WIDTH_PX`). */
export const MIN_EDITOR_HEIGHT_PX = 24;

export interface InPlaceEditorProps {
  session: TableSession;
  ui: UiStore;
  camera: Camera;
  scene: Scene;
}

/** A screen rectangle in CSS pixels. */
interface ScreenRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** An open editor. */
interface Draft {
  readonly request: InPlaceEditRequest;
  readonly cell: string;
  readonly initial: string;
  /**
   * The field opened blank over a cell holding the empty text (`isBlankText`): `initial`
   * stays `""`, the literal, and committing a blank field writes nothing.
   */
  readonly blank?: true;
  /** Why the value has no input text (the replace-value input). */
  readonly reason?: string;
  readonly text: string;
  readonly error?: string;
}

const EMPTY: WireResult = { type: "empty" };

function sameViewer(a: Viewer, b: Viewer): boolean {
  if (a.type === "gm" || b.type === "gm") return a.type === b.type;
  return a.id === b.id;
}

/** The target cell of `request` on `view`. */
function targetCell(request: InPlaceEditRequest, view: ObjectView): string {
  if (request.cell !== undefined) return request.cell;
  return Object.hasOwn(view.cells, "text") ? "text" : "name";
}

/**
 * Whether the editor opens blank instead of prefilled with `""`: the cell's
 * value is the empty text, held as a literal (in any cell) or as the override
 * of a formula. (A formula without an override never opens here: it focuses
 * the formula bar.) A blank field would read back as `empty` under the input
 * grammar, so a blank commit is "unchanged", never a write (vtt-qf5.43).
 */
function isBlankText(view: CellView | undefined): boolean {
  if (view === undefined || view.value.type !== "text" || view.value.value !== "") return false;
  return view.kind === "literal" || (view.kind === "formula" && view.overridden === true);
}

/**
 * The editor's screen rectangle: `rect` (board space), else the object's
 * bounds in `scene`, transformed by `camera`, exactly; null when the object
 * is not drawn and no `rect` is given.
 */
function screenRect(
  request: InPlaceEditRequest,
  scene: Scene,
  camera: Camera,
  viewport: { width: number; height: number },
): ScreenRect | null {
  const bounds: Bounds | undefined =
    request.rect ?? scene.items.find((item) => item.id === request.object)?.bounds;
  if (bounds === undefined) return null;
  const [x0, y0] = toScreen(camera, [bounds.minX, bounds.minY], viewport);
  const [x1, y1] = toScreen(camera, [bounds.maxX, bounds.maxY], viewport);
  return { left: x0, top: y0, width: x1 - x0, height: y1 - y0 };
}

/** Whether screen rectangle `r` intersects any cover of `scene` (positive-area overlap). */
function coveredRect(
  r: ScreenRect,
  scene: Scene,
  camera: Camera,
  viewport: { width: number; height: number },
): boolean {
  if (scene.covers.length === 0) return false;
  const [minX, minY] = toBoard(camera, [r.left, r.top], viewport);
  const [maxX, maxY] = toBoard(camera, [r.left + r.width, r.top + r.height], viewport);
  const center: Point = [(minX + maxX) / 2, (minY + maxY) / 2];
  // A rectangle without area (a shapeless object's point bounds) is tested by its
  // corners and center, boundary inclusive; a rect footprint without area overlaps nothing.
  const footprints: Footprint[] =
    maxX - minX > 0 && maxY - minY > 0
      ? [
          {
            shape: { type: "rect", width: maxX - minX, height: maxY - minY },
            anchor: center,
            rotation: 0,
          },
        ]
      : [center, [minX, minY], [maxX, maxY]].map((anchor) => ({
          shape: null,
          anchor: anchor as Point,
          rotation: 0,
        }));
  return scene.covers.some(
    (c) =>
      c.wholeBoard ||
      footprints.some((f) =>
        footprintsOverlap(f, { shape: c.shape, anchor: c.anchor, rotation: c.rotation }),
      ),
  );
}

const FRAME_STYLE: CSSProperties = { position: "absolute", boxSizing: "border-box" };
const FIELD_STYLE: CSSProperties = {
  width: "100%",
  height: "100%",
  boxSizing: "border-box",
  margin: 0,
  font: "inherit",
  resize: "none",
  minWidth: MIN_EDITOR_WIDTH_PX,
  minHeight: MIN_EDITOR_HEIGHT_PX,
};
const NOTE_STYLE: CSSProperties = {
  position: "absolute",
  top: "100%",
  left: 0,
  marginTop: 2,
  padding: "1px 4px",
  fontSize: "0.85em",
  whiteSpace: "nowrap",
  background: "Canvas",
  color: "CanvasText",
  border: "1px solid GrayText",
};
const ERROR_STYLE: CSSProperties = { ...NOTE_STYLE, color: "#b3261e" };

export function InPlaceEditor({ session, ui, camera, scene }: InPlaceEditorProps) {
  const request = useSyncExternalStore(
    useCallback((fn: () => void) => subscribeInPlaceEdit(ui, fn), [ui]),
    () => inPlaceEditRequest(ui),
  );
  const snapshot = useSyncExternalStore(
    useCallback((fn: () => void) => session.subscribe(fn), [session]),
    () => session.getSnapshot(),
  );
  const viewport = useSyncExternalStore(
    useCallback((fn: () => void) => ui.subscribe(fn), [ui]),
    () => ui.getState().viewport,
  );
  const port = useMemo(() => createWritePort(session), [session]);
  const [draftState, setDraft] = useState<Draft | null>(null);
  const fieldRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  /** Whether the editor shown by the last render is open; blur commits only then. */
  const liveRef = useRef<Draft | null>(null);
  /** Whether the open draft was kept over the window losing focus (vtt-qf5.59). */
  const keptOverWindowBlur = useRef(false);

  // -- opening

  // biome-ignore lint/correctness/useExhaustiveDependencies: decided once per request
  useEffect(() => {
    if (request === null) {
      setDraft(null);
      return;
    }
    const refuse = () => {
      setDraft(null);
      endInPlaceEdit(ui, request.seq);
    };
    const current = session.getSnapshot();
    const { stamp } = request;
    if (
      current.viewer.type !== "gm" ||
      !sameViewer(stamp.viewer, current.viewer) ||
      current.activeBoard !== stamp.board
    ) {
      refuse();
      return;
    }
    const view = session.objectView(request.object);
    if (view === null) {
      refuse();
      return;
    }
    const cell = targetCell(request, view);
    const cellView = view.cells[cell];
    if (!cellCapabilities(cell, cellView).literal) {
      refuse();
      return;
    }
    if (cellView?.kind === "formula" && cellView.overridden !== true) {
      refuse();
      requestFormulaBarFocus(ui, { object: request.object, cell });
      return;
    }
    const rect = screenRect(request, scene, camera, ui.getState().viewport);
    if (rect === null || coveredRect(rect, scene, camera, ui.getState().viewport)) {
      refuse();
      return;
    }
    const input = valueToInputText(cellView?.value ?? EMPTY, cell);
    setDraft(
      isBlankText(cellView) && input.kind === "literal"
        ? { request, cell, initial: input.text, text: "", blank: true }
        : input.kind === "literal"
          ? { request, cell, initial: input.text, text: input.text }
          : { request, cell, initial: "", reason: input.reason, text: "" },
    );
  }, [request]);

  // -- staying open

  const draft = draftState !== null && draftState.request === request ? draftState : null;
  const rect = draft === null ? null : screenRect(draft.request, scene, camera, viewport);
  const blocked =
    draft === null ||
    rect === null ||
    snapshot.viewer.type !== "gm" ||
    !sameViewer(draft.request.stamp.viewer, snapshot.viewer) ||
    snapshot.activeBoard !== draft.request.stamp.board ||
    session.objectView(draft.request.object) === null ||
    coveredRect(rect, scene, camera, viewport);
  const shown = blocked ? null : draft;
  liveRef.current = shown;

  const close = useCallback(
    (closing: Draft) => {
      liveRef.current = null;
      setDraft((d) => (d === closing ? null : d));
      endInPlaceEdit(ui, closing.request.seq);
    },
    [ui],
  );

  // Closes, without committing, an editor that may no longer be shown.
  useEffect(() => {
    if (draft !== null && blocked) close(draft);
  }, [draft, blocked, close]);

  // Focus on open, caret at the end.
  const openedSeq = shown?.request.seq;
  useLayoutEffect(() => {
    keptOverWindowBlur.current = false;
    const field = fieldRef.current;
    if (openedSeq === undefined || field === null) return;
    field.focus({ preventScroll: true });
    field.setSelectionRange(field.value.length, field.value.length);
  }, [openedSeq]);

  // The window came back: a kept draft whose field did not get focus back closes, unwritten.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onWindowFocus = () => {
      clearTimeout(timer);
      // After this task, so the field's own focus (restored by the browser) has fired.
      timer = setTimeout(() => {
        if (!keptOverWindowBlur.current) return;
        keptOverWindowBlur.current = false;
        const live = liveRef.current;
        if (live !== null && document.activeElement !== fieldRef.current) close(live);
      }, 0);
    };
    window.addEventListener("focus", onWindowFocus);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", onWindowFocus);
    };
  }, [close]);

  // -- committing

  const commit = (current: Draft) => {
    const { cell, request: open } = current;
    const cellView = session.objectView(open.object)?.cells[cell];
    // A formula cell without an override (one that stopped being overridden
    // while the editor was open) takes any literal as an override (M4-D6),
    // even the shown value: the inspector's rule (vtt-1xv.29, vtt-qf5.47).
    const followsFormula = cellView?.kind === "formula" && cellView.overridden !== true;
    // A blank field opened over the empty text writes nothing (vtt-qf5.43).
    const noChange =
      (current.blank === true && current.text === "") ||
      (current.reason === undefined
        ? !followsFormula && isUnchangedInput(current.initial, current.text, cell)
        : current.text === "");
    if (noChange) {
      close(current);
      return;
    }
    const parsed = parseCellInput(current.text, { cell });
    if (!parsed.ok) {
      setDraft({ ...current, error: parsed.message });
      return;
    }
    if (parsed.content.type === "formula" && !cellCapabilities(cell, cellView).formula) {
      setDraft({ ...current, error: `${cell} cannot hold a formula.` });
      return;
    }
    const name = session.refLabel(snapshot.viewer, open.object);
    const label =
      parsed.content.type === "formula" ? `Set formula of ${name}.${cell}` : `Set ${name}.${cell}`;
    close(current);
    void port.write(cellInputToOps(open.object, cell, parsed.content, cellView), {
      baseRevision: open.stamp.baseRevision,
      label,
    });
  };

  if (shown === null || rect === null) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      commit(shown);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close(shown);
    }
  };
  const fieldProps = {
    "aria-label": `Edit ${shown.cell}`,
    style: FIELD_STYLE,
    value: shown.text,
    spellCheck: false,
    onKeyDown,
    onChange: (e: { target: { value: string } }) => {
      const { error: _error, ...rest } = shown;
      setDraft({ ...rest, text: e.target.value });
    },
    onFocus: () => {
      keptOverWindowBlur.current = false;
    },
    onBlur: () => {
      // Only the editor that is open now commits (not one being removed).
      if (liveRef.current !== shown) return;
      // The window losing focus blurs the field too: keep the draft for when it returns.
      if (!document.hasFocus()) keptOverWindowBlur.current = true;
      else commit(shown);
    },
  };

  return (
    <div
      data-part="in-place-editor"
      style={{
        ...FRAME_STYLE,
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      }}
    >
      {shown.cell === "text" ? (
        <textarea ref={fieldRef} {...fieldProps} />
      ) : (
        <input ref={fieldRef} {...fieldProps} />
      )}
      {shown.reason !== undefined && shown.error === undefined && (
        <span data-part="editor-reason" style={NOTE_STYLE}>
          {shown.reason}: type a value to replace it
        </span>
      )}
      {shown.error !== undefined && (
        <span role="alert" style={ERROR_STYLE}>
          {shown.error}
        </span>
      )}
    </div>
  );
}
