/**
 * Choosing an image for a cell (vtt-nb8.7; DESIGN.md §4.6 Appearance cells,
 * M6-D4; §7 Undo and writes in the UI; PROTOCOL.md §1 `POST /assets`; M6
 * plan Q7): the inspector's `image` row uploads a file with vtt-3l6.16's
 * `uploadAsset`, then writes the returned path into the cell as text in one
 * `set_value`, through vtt-3l6.21's write path, with the revision captured
 * at the click.
 *
 * The upload completes before the write is sent. Nothing here is tied to a
 * component, so a row that unmounts (or a selection that changes) meanwhile
 * still sends the write, with the captured revision: a conflicting write
 * committed since the click makes it `stale_write`, shown as any stale write
 * is. An upload error writes nothing and is a notice.
 *
 * Credentials: `bindCellUpload` sets a session's upload options (token, HTTP
 * origin, fetch); unbound, the token is the page's session bootstrap
 * (PROTOCOL.md §2) and the origin `location.origin`, which is the authority
 * that served the page.
 */
import type { ObjectId } from "@vtt/schema";
import type { WriteOutcome } from "../interaction/contracts";
import { readBootstrap } from "../session/bootstrap";
import type { TableSession } from "../session/table-session";
import { createWritePort, sessionNotices } from "../session/writes";
import { AssetUploadError, uploadAsset } from "./upload";

/** How a session's cell uploads reach `POST /assets`. */
export interface CellUploadOptions {
  /** The session token; default: the page's session bootstrap. */
  token?: string;
  /** The authority's HTTP origin; default `location.origin`. */
  base?: string;
  /** Default: the global `fetch`. */
  fetch?: typeof fetch;
}

const bindings = new WeakMap<TableSession, CellUploadOptions>();

/** Sets `session`'s upload options; returns a remover that restores the defaults. */
export function bindCellUpload(session: TableSession, options: CellUploadOptions): () => void {
  bindings.set(session, options);
  return () => {
    if (bindings.get(session) === options) bindings.delete(session);
  };
}

export interface UploadIntoCellParams {
  file: File;
  object: ObjectId;
  cell: string;
  /** The revision at the click that started the upload. */
  baseRevision: number;
  session: TableSession;
}

/**
 * Uploads `file`, then sends one `set_value {object, cell, value: {type:
 * "text", value: path}}` with `baseRevision`, labelled "Set image of
 * <name>". Resolves with the write's outcome, or null when the upload failed
 * (a notice was pushed and nothing was written). A refusal of the write is
 * a notice from the write path.
 */
export async function uploadIntoCell(params: UploadIntoCellParams): Promise<WriteOutcome | null> {
  const { file, object, cell, baseRevision, session } = params;
  const notices = sessionNotices(session);
  const name = session.refLabel(session.getSnapshot().viewer, object);
  const options = bindings.get(session) ?? {};
  const token = options.token ?? bootstrapToken();
  if (token === null) {
    notices.push({
      level: "error",
      text: `Could not upload an image for ${name}: this page has no session token.`,
    });
    return null;
  }
  let path: string;
  try {
    ({ path } = await uploadAsset(file, {
      token,
      ...(options.base === undefined ? {} : { base: options.base }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    }));
  } catch (e) {
    notices.push({
      level: "error",
      text: `Could not upload an image for ${name}: ${uploadProblem(e)}`,
    });
    return null;
  }
  return createWritePort(session).write(
    [{ type: "set_value", object, cell, value: { type: "text", value: path } }],
    { baseRevision, label: `Set image of ${name}` },
  );
}

function bootstrapToken(): string | null {
  if (typeof document === "undefined") return null;
  return readBootstrap(document)?.token ?? null;
}

/** An upload failure as notice text: the reason for the statuses PROTOCOL.md §1 names. */
function uploadProblem(e: unknown): string {
  if (!(e instanceof AssetUploadError)) return String(e);
  switch (e.status) {
    case 401:
      return "the authority did not accept this page's token (reload the page).";
    case 409:
      return "this table is not saved to a file, so it cannot store images.";
    case 413:
      return "the file is larger than 50 MiB.";
    case 415:
      return "only PNG, JPEG, WebP and GIF images can be used.";
    default:
      return e.message.endsWith(".") ? e.message : `${e.message}.`;
  }
}
