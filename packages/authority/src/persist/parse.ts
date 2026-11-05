/**
 * Loading (DESIGN.md §7, Persistence; The file; History invariants). Pure:
 * text in, store out. Whether assets exist is checked only when loading
 * from a path.
 */
import {
  SCHEMA_VERSION,
  type Snapshot,
  type TableFile,
  TableFileSchema,
  validateSnapshot,
} from "@vtt/schema";
import { DocumentStore } from "../store/document-store";
import { History, validateHistory } from "../store/history";
import { snapshotHash } from "./canonical";
import { MigrationError, migrate } from "./migrate";

/** One reason a file does not load. */
export interface LoadProblem {
  /** The step that found it. */
  stage: "json" | "version" | "schema" | "snapshot" | "history";
  /** Where in the file. */
  path: (string | number)[];
  /** A document ViolationKind or a HistoryViolation type, when there is one. */
  kind?: string;
  message: string;
}

/** A file that does not load, with every problem found. */
export class TableLoadError extends Error {
  readonly problems: LoadProblem[];

  constructor(problems: LoadProblem[]) {
    super(`cannot load the table: ${problems.map((p) => p.message).join("; ")}`);
    this.name = "TableLoadError";
    this.problems = problems;
  }
}

/** Something a load noticed that does not stop it. */
export type LoadWarning =
  /** `snapshot_hash` did not match: the snapshot wins, the log is record only. */
  | { type: "edited_externally"; message: string }
  /** The file was migrated from an older schema version. */
  | { type: "migrated"; from: number; to: number; message: string };

export interface ParsedTable {
  store: DocumentStore;
  /** The snapshot did not match `snapshot_hash`: the file was edited by hand. */
  editedExternally: boolean;
  warnings: LoadWarning[];
}

const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Loads a file's text: JSON parse → `migrate` to SCHEMA_VERSION →
 * `TableFileSchema` → `validateSnapshot` → hash check → `validateHistory`
 * → a DocumentStore with the snapshot and the history restored. Throws
 * TableLoadError listing every problem found: a JSON or version failure
 * stops at once, schema issues are listed together, and snapshot and
 * history violations are listed together.
 *
 * A hash mismatch is a hand edit: the snapshot is used as is (its revision
 * continues from the last retained group's, unchanged with an empty log),
 * the retained groups are kept as record, and the undo barrier is raised
 * to the next absolute index, so no earlier group can be undone and later
 * ones can.
 */
export function parseTable(text: string): ParsedTable {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new TableLoadError([{ stage: "json", path: [], message: `not JSON: ${describe(err)}` }]);
  }

  const warnings: LoadWarning[] = [];
  let migrated: unknown;
  try {
    migrated = migrate(json);
  } catch (err) {
    if (!(err instanceof MigrationError)) throw err;
    throw new TableLoadError([
      { stage: "version", path: ["schema_version"], message: err.message },
    ]);
  }
  const from = (json as { schema_version: number }).schema_version;
  if (from !== SCHEMA_VERSION) {
    warnings.push({
      type: "migrated",
      from,
      to: SCHEMA_VERSION,
      message: `migrated from schema version ${from} to ${SCHEMA_VERSION}`,
    });
  }

  const parsed = TableFileSchema.safeParse(migrated);
  if (!parsed.success) {
    throw new TableLoadError(
      parsed.error.issues.map((issue) => {
        const path = issue.path.map((p) => (typeof p === "symbol" ? String(p) : p));
        return {
          stage: "schema",
          path,
          message: path.length > 0 ? `${path.join(".")}: ${issue.message}` : issue.message,
        };
      }),
    );
  }
  const file: TableFile = parsed.data;
  const snapshot: Snapshot = file.snapshot;

  const problems: LoadProblem[] = validateSnapshot(snapshot).map((v) => ({
    stage: "snapshot",
    path: ["snapshot", ...v.path],
    kind: v.kind,
    message: v.message,
  }));

  const editedExternally = snapshotHash(snapshot) !== file.snapshot_hash;
  const last = file.log.groups.at(-1);
  if (editedExternally && last !== undefined) snapshot.revision = last.revision;
  const options = { editedExternally };
  for (const v of validateHistory(file.log, snapshot.revision, options)) {
    problems.push({ stage: "history", path: ["log"], kind: v.type, message: v.message });
  }
  if (problems.length > 0) throw new TableLoadError(problems);

  if (editedExternally) {
    warnings.push({
      type: "edited_externally",
      message:
        "the snapshot does not match snapshot_hash: it was edited by hand, so it is used as is and earlier groups cannot be undone",
    });
  }
  const history = new History();
  history.restore(file.log, snapshot.revision, options);
  return { store: DocumentStore.fromSnapshot(snapshot, history), editedExternally, warnings };
}
