/**
 * Board tabs (vtt-3l6.10; DESIGN.md §4.3 Boards, §4.6, §8.1; PROTOCOL.md §5
 * `add_board`, `rename_board`, `remove_board`, `move`, §8 `boards`; M4-D7;
 * review r1 findings 1, 5, 11).
 *
 * - One tab per board in `session.boards` order (name, else id); a click
 *   activates it; "+" asks for a name and adds a board whose id is chosen
 *   here (`boardIdFor`), trying the next suffix after a reserved-id refusal
 *   at most `BOARD_ID_RETRIES` times; a double-click renames; the context
 *   menu removes (a refusal, such as a non-empty board, is the write port's
 *   notice) and moves the selection to that board.
 * - Each tab carries `data-board-tab`, the board id, so a canvas drag
 *   released over it is a drop on that board (board-tab-drop.ts, vtt-qf5.35).
 * - "Move selection to board…": one write with a `move` per selected object directly on the
 *   active board, to the target board at its current position; then the
 *   target board is activated with the moved objects selected.
 * - `NoBoards`: the zero-board empty state for the canvas area.
 *
 * Every command captures `baseRevision` when its interaction begins (the
 * click on "+", the double-click, the menu item) and sends it unchanged
 * through vtt-3l6.21's write port.
 */
import type { BoardView, WireOp, WireResult } from "@vtt/protocol";
import type { BoardId, ObjectId } from "@vtt/schema";
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { WritePort } from "../interaction/contracts";
import { useSession, useTableSession, useUi, useUiStore } from "../session/hooks";
import type { TableSession } from "../session/table-session";
import { createWritePort, sessionNotices } from "../session/writes";
import type { UiStore } from "../state/ui-state";
import { describeRejection } from "../values/rejections";
import { BOARD_ID_RETRIES, boardIdFor, isReservedIdRejection } from "./board-ids";

// ---------------------------------------------------------------------------
// Commands

/** What the board commands need. */
export interface BoardCommandContext {
  session: TableSession;
  ui: UiStore;
  write: WritePort;
}

/** A board's tab label: its name, else its id. */
export function boardLabel(board: BoardView): string {
  return board.name !== undefined && board.name !== "" ? board.name : board.id;
}

function labelOf(session: TableSession, id: BoardId): string {
  const board = session.getSnapshot().boards.find((b) => b.id === id);
  return board === undefined ? id : boardLabel(board);
}

/** Waits for the session to see `revision` (never rejects). */
async function caughtUp(session: TableSession, revision: number): Promise<boolean> {
  try {
    await session.whenRevision(revision);
    return true;
  } catch {
    return false;
  }
}

/**
 * Adds a board named `name` with an id chosen by `boardIdFor` among the
 * known boards and objects (one id namespace), and activates it. After an
 * `invalid` reserved-id refusal (a retired id, or one taken meanwhile) the
 * next suffix is tried with the same `baseRevision`, at most
 * `BOARD_ID_RETRIES` times; the retried refusal's notice is withdrawn.
 * Resolves to the new board's id, or null when not added.
 */
export async function addBoardNamed(
  ctx: BoardCommandContext,
  name: string,
  baseRevision: number,
): Promise<BoardId | null> {
  const { session, ui, write } = ctx;
  const notices = sessionNotices(session);
  const tried: string[] = [];
  for (let attempt = 0; attempt <= BOARD_ID_RETRIES; attempt++) {
    const known = [
      ...session.getSnapshot().boards.map((b) => b.id),
      ...session.directory().keys(),
      ...tried,
    ];
    const id = boardIdFor(name, known);
    tried.push(id);
    const before = new Set(notices.list());
    const outcome = await write.write([{ type: "add_board", id, name }], {
      baseRevision,
      label: `Add board ${name}`,
    });
    if (outcome.status === "committed") {
      if (await caughtUp(session, outcome.revision)) await ui.setActiveBoard(id);
      return id;
    }
    if (
      outcome.status !== "rejected" ||
      !isReservedIdRejection(outcome.rejection) ||
      attempt === BOARD_ID_RETRIES
    ) {
      return null;
    }
    const viewer = session.getSnapshot().viewer;
    const text = describeRejection(outcome.rejection, (ref) => session.refLabel(viewer, ref));
    for (const notice of notices.list()) {
      if (!before.has(notice) && notice.text === text) notices.dismiss(notice.id);
    }
  }
  return null;
}

/** Renames `board`; resolves to whether the rename committed. */
export async function renameBoard(
  ctx: BoardCommandContext,
  board: BoardId,
  name: string,
  baseRevision: number,
): Promise<boolean> {
  const from = labelOf(ctx.session, board);
  const outcome = await ctx.write.write([{ type: "rename_board", id: board, name }], {
    baseRevision,
    label: `Rename board ${from} to ${name}`,
  });
  return outcome.status === "committed";
}

/**
 * Removes `board` (refused while an object is directly on it). Switching
 * away from a removed active board is the session's (vtt-3l6.4).
 */
export async function removeBoard(
  ctx: BoardCommandContext,
  board: BoardId,
  baseRevision: number,
): Promise<boolean> {
  const outcome = await ctx.write.write([{ type: "remove_board", id: board }], {
    baseRevision,
    label: `Remove board ${labelOf(ctx.session, board)}`,
  });
  return outcome.status === "committed";
}

/** A selected object directly on the active board, and its position there. */
export interface MovableObject {
  readonly id: ObjectId;
  readonly position: [number, number];
}

function anchorOf(v: WireResult | undefined): [number, number] | null {
  if (v?.type !== "list" || v.items.length !== 2) return null;
  const [x, y] = v.items;
  if (x?.type !== "number" || y?.type !== "number") return null;
  if (!Number.isFinite(x.value) || !Number.isFinite(y.value)) return null;
  return [x.value, y.value];
}

/**
 * The ids of `selection` that are directly on the active board (in its
 * board view, on that board, in no container, with a position), in
 * selection order, with their positions.
 */
export function movableSelection(
  session: Pick<TableSession, "getSnapshot" | "boardView">,
  selection: readonly ObjectId[],
): MovableObject[] {
  const active = session.getSnapshot().activeBoard;
  const view = session.boardView();
  if (active === null || view === null || view.board !== active) return [];
  const movable: MovableObject[] = [];
  for (const id of selection) {
    const cells = view.objects.get(id)?.cells;
    if (cells === undefined) continue;
    const board = cells.board?.value;
    if (board?.type !== "ref" || board.object !== active) continue;
    const container = cells.container?.value;
    if (container !== undefined && container.type !== "empty") continue;
    const position = anchorOf(cells.position?.value);
    if (position !== null) movable.push({ id, position });
  }
  return movable;
}

/** Whether "Move selection to `target`" applies: something to move, and not to the active board. */
export function canMoveSelectionTo(
  session: Pick<TableSession, "getSnapshot" | "boardView">,
  selection: readonly ObjectId[],
  target: BoardId,
): boolean {
  return (
    target !== session.getSnapshot().activeBoard && movableSelection(session, selection).length > 0
  );
}

/**
 * "Move selection to board…": one write with a `move` per selected object
 * directly on the active board, to `target` at its current position
 * (label "Move N objects to <board>"); once committed, activates `target`
 * and selects the moved objects. Resolves to whether it committed.
 */
export async function moveSelectionToBoard(
  ctx: BoardCommandContext,
  target: BoardId,
  baseRevision: number,
): Promise<boolean> {
  const { session, ui, write } = ctx;
  if (target === session.getSnapshot().activeBoard) return false;
  const movable = movableSelection(session, ui.getState().selection);
  if (movable.length === 0) return false;
  const ops: WireOp[] = movable.map(({ id, position }) => ({
    type: "move",
    object: id,
    to: { type: "board", board: target, position: [position[0], position[1]] },
  }));
  const n = movable.length;
  const label = `Move ${n} object${n === 1 ? "" : "s"} to ${labelOf(session, target)}`;
  const outcome = await write.write(ops, { baseRevision, label });
  if (outcome.status !== "committed") return false;
  if (await caughtUp(session, outcome.revision)) {
    await ui.setActiveBoard(target);
    ui.select(movable.map((m) => m.id));
  }
  return true;
}

// ---------------------------------------------------------------------------
// Components

/** The session's write port, unless one is given. */
function useWrite(write: WritePort | undefined): BoardCommandContext {
  const session = useTableSession();
  const ui = useUiStore();
  return useMemo(
    () => ({ session, ui, write: write ?? createWritePort(session) }),
    [session, ui, write],
  );
}

/** Closes on Escape and on a pointer press outside `ref`. */
function useDismiss(open: boolean, ref: { current: HTMLElement | null }, close: () => void) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
    };
    const onPointer = (e: PointerEvent) => {
      if (ref.current !== null && !ref.current.contains(e.target as Node)) closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open, ref]);
}

interface NameInputProps {
  label: string;
  initial: string;
  onCommit(name: string): void;
  onCancel(): void;
}

/** A one-line name input: Enter commits a non-blank changed name; Escape or leaving cancels. */
function NameInput({ label, initial, onCommit, onCancel }: NameInputProps) {
  const done = useRef(false);
  const finish = (fn: () => void) => {
    if (done.current) return;
    done.current = true;
    fn();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const name = e.currentTarget.value.trim();
      finish(() => (name === "" || name === initial ? onCancel() : onCommit(name)));
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      finish(onCancel);
    }
  };
  return (
    <input
      type="text"
      aria-label={label}
      defaultValue={initial}
      // biome-ignore lint/a11y/noAutofocus: the input appears in answer to the user's click
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={onKeyDown}
      onBlur={() => finish(onCancel)}
    />
  );
}

/** "+" / "Add board": asks for a name, then `addBoardNamed` with the revision of the click. */
function AddBoard({
  ctx,
  children,
  buttonLabel,
}: {
  ctx: BoardCommandContext;
  children: ReactNode;
  buttonLabel: string;
}) {
  const [base, setBase] = useState<number | null>(null);
  if (base !== null) {
    return (
      <NameInput
        label="Board name"
        initial=""
        onCancel={() => setBase(null)}
        onCommit={(name) => {
          setBase(null);
          void addBoardNamed(ctx, name, base);
        }}
      />
    );
  }
  return (
    <button
      type="button"
      aria-label={buttonLabel}
      title={buttonLabel}
      onClick={() => setBase(ctx.session.getSnapshot().revision)}
    >
      {children}
    </button>
  );
}

export interface BoardTabsProps {
  /** Default: the session's `createWritePort`. */
  write?: WritePort;
}

interface TabMenu {
  board: BoardId;
  x: number;
  y: number;
}

/** The board tab bar. */
export function BoardTabs({ write }: BoardTabsProps) {
  const ctx = useWrite(write);
  const { session } = ctx;
  const boards = useSession((s) => s.boards);
  const active = useSession((s) => s.activeBoard);
  useSession((s) => s.viewVersion);
  const selection = useUi((s) => s.selection);
  const [renaming, setRenaming] = useState<{ board: BoardId; base: number } | null>(null);
  const [tabMenu, setTabMenu] = useState<TabMenu | null>(null);
  const [moveMenu, setMoveMenu] = useState(false);
  const tabMenuRef = useRef<HTMLDivElement | null>(null);
  const moveMenuRef = useRef<HTMLDivElement | null>(null);
  useDismiss(tabMenu !== null, tabMenuRef, () => setTabMenu(null));
  useDismiss(moveMenu, moveMenuRef, () => setMoveMenu(false));

  const movable = movableSelection(session, selection).length > 0;
  const revision = () => session.getSnapshot().revision;
  const move = (target: BoardId) => {
    void moveSelectionToBoard(ctx, target, revision());
  };
  const menuBoard = tabMenu && boards.find((b) => b.id === tabMenu.board);

  return (
    <nav aria-label="Boards" className="vtt-board-tabs">
      <div role="tablist" aria-label="Boards">
        {boards.map((board) =>
          renaming?.board === board.id ? (
            <NameInput
              key={board.id}
              label="Rename board"
              initial={boardLabel(board)}
              onCancel={() => setRenaming(null)}
              onCommit={(name) => {
                setRenaming(null);
                void renameBoard(ctx, board.id, name, renaming.base);
              }}
            />
          ) : (
            <button
              key={board.id}
              type="button"
              role="tab"
              aria-selected={board.id === active}
              data-board-tab={board.id}
              onClick={() => {
                if (board.id !== session.getSnapshot().activeBoard)
                  void ctx.ui.setActiveBoard(board.id);
              }}
              onDoubleClick={() => setRenaming({ board: board.id, base: revision() })}
              onContextMenu={(e) => {
                e.preventDefault();
                setMoveMenu(false);
                setTabMenu({ board: board.id, x: e.clientX, y: e.clientY });
              }}
            >
              {boardLabel(board)}
            </button>
          ),
        )}
      </div>
      <AddBoard ctx={ctx} buttonLabel="New board">
        +
      </AddBoard>
      <span className="vtt-move-selection">
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={moveMenu}
          disabled={!movable}
          onClick={() => {
            setTabMenu(null);
            setMoveMenu((open) => !open);
          }}
        >
          Move selection to board…
        </button>
        {moveMenu && movable && (
          <div ref={moveMenuRef} role="menu" aria-label="Move selection to board">
            {boards.map((board) => (
              <button
                key={board.id}
                type="button"
                role="menuitem"
                disabled={board.id === active}
                onClick={() => {
                  setMoveMenu(false);
                  move(board.id);
                }}
              >
                {boardLabel(board)}
              </button>
            ))}
          </div>
        )}
      </span>
      {tabMenu !== null && menuBoard && (
        <div
          ref={tabMenuRef}
          role="menu"
          aria-label={`Board ${boardLabel(menuBoard)}`}
          style={{ position: "fixed", left: tabMenu.x, top: tabMenu.y }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setTabMenu(null);
              setRenaming({ board: menuBoard.id, base: revision() });
            }}
          >
            Rename
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setTabMenu(null);
              void removeBoard(ctx, menuBoard.id, revision());
            }}
          >
            Remove board
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!movable || menuBoard.id === active}
            onClick={() => {
              setTabMenu(null);
              move(menuBoard.id);
            }}
          >
            Move selection to {boardLabel(menuBoard)}
          </button>
        </div>
      )}
    </nav>
  );
}

export interface NoBoardsProps {
  /** Default: the session's `createWritePort`. */
  write?: WritePort;
}

/**
 * The canvas area's empty state with zero boards (review r1 finding 11):
 * "No boards" and "Add board" (the same flow as "+"). Renders nothing
 * otherwise.
 */
export function NoBoards({ write }: NoBoardsProps) {
  const ctx = useWrite(write);
  const empty = useSession((s) => s.ready && s.activeBoard === null && s.boards.length === 0);
  if (!empty) return null;
  return (
    <section aria-label="No boards" className="vtt-no-boards">
      <p>No boards</p>
      <AddBoard ctx={ctx} buttonLabel="Add board">
        Add board
      </AddBoard>
    </section>
  );
}
