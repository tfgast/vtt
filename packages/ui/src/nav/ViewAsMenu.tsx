/**
 * The view-as menu (vtt-3l6.10; DESIGN.md §4.1 Characters, §4.4, §4.6 View
 * as in the UI, §8.1 view-as in one window; M4-D11). "GM" plus every
 * directory object with `is_character` true and `is_template` false, sorted
 * by name then id; choosing one calls `session.setView(activeBoard, viewer)`
 * (vtt-3l6.4). While viewing as a character a banner says so, with "Back to
 * GM".
 */
import type { ObjectView, Viewer } from "@vtt/protocol";
import type { ObjectId } from "@vtt/schema";
import { useSession, useTableSession } from "../session/hooks";
import type { TableSession } from "../session/table-session";

/** A character the GM can view as. */
export interface ViewAsCharacter {
  readonly id: ObjectId;
  /** Its `name` (GM directory), else its id. */
  readonly label: string;
}

const GM: Viewer = { type: "gm" };

const nameOf = (view: ObjectView): string => {
  const name = view.cells.name?.value;
  return name?.type === "text" && name.value !== "" ? name.value : view.id;
};

/** Ids by code point (FORMULAS.md §5), names likewise, for a stable order. */
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The view-as list (DESIGN.md §4.1): every object in `directory` with
 * `is_character` true and `is_template` false, sorted by label then id.
 */
export function viewAsCharacters(directory: ReadonlyMap<ObjectId, ObjectView>): ViewAsCharacter[] {
  const characters: ViewAsCharacter[] = [];
  for (const view of directory.values()) {
    if (view.is_character && !view.is_template) {
      characters.push({ id: view.id, label: nameOf(view) });
    }
  }
  return characters.sort((a, b) => compare(a.label, b.label) || compare(a.id, b.id));
}

const keyOf = (viewer: Viewer) => (viewer.type === "gm" ? "gm" : `character:${viewer.id}`);

const viewerOf = (key: string): Viewer =>
  key.startsWith("character:") ? { type: "character", id: key.slice("character:".length) } : GM;

/** Shows the active board as `viewer` (`session.setView`). */
function viewAs(session: TableSession, viewer: Viewer): void {
  void session.setView(session.getSnapshot().activeBoard, viewer);
}

/** The banner shown while viewing as a character; nothing in the GM view. */
export function ViewAsBanner() {
  const session = useTableSession();
  const viewer = useSession((s) => s.viewer);
  useSession((s) => s.viewVersion);
  if (viewer.type === "gm") return null;
  return (
    <div role="status" className="vtt-view-as-banner">
      <span>Viewing as {session.refLabel(GM, viewer.id)} — read-only inspector</span>{" "}
      <button type="button" onClick={() => viewAs(session, GM)}>
        Back to GM
      </button>
    </div>
  );
}

export interface ViewAsMenuProps {
  /** Whether the menu renders `ViewAsBanner` after itself (default true). */
  banner?: boolean;
}

/** The view-as menu, and (by default) its banner. */
export function ViewAsMenu({ banner = true }: ViewAsMenuProps) {
  const session = useTableSession();
  const viewer = useSession((s) => s.viewer);
  useSession((s) => s.viewVersion);
  const characters = viewAsCharacters(session.directory());
  const current = keyOf(viewer);
  // A viewed object that left the list (removed, or no longer a character) stays selectable.
  const extra =
    viewer.type === "character" && !characters.some((c) => c.id === viewer.id)
      ? { id: viewer.id, label: session.refLabel(GM, viewer.id) }
      : null;
  return (
    <>
      <span className="vtt-view-as">
        <span aria-hidden="true">View as </span>
        <select
          aria-label="View as"
          value={current}
          onChange={(e) => viewAs(session, viewerOf(e.target.value))}
        >
          <option value="gm">GM</option>
          {characters.map((c) => (
            <option key={c.id} value={`character:${c.id}`}>
              {c.label}
            </option>
          ))}
          {extra && <option value={`character:${extra.id}`}>{extra.label}</option>}
        </select>
      </span>
      {banner && <ViewAsBanner />}
    </>
  );
}
