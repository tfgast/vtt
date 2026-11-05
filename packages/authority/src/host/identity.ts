/**
 * The canonical table path and the table identity file (PROTOCOL.md §2,
 * Canonical path; Table identity; decision D25).
 */
/// <reference types="node" />
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { nodeTableFs, type TableFs, type TableLock } from "./lock";

const codeOf = (err: unknown): unknown =>
  typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;

/**
 * The canonical table path: `realpath(path)` when the file exists; otherwise
 * `realpath(dirname(path))` joined with `basename(path)`. A missing directory
 * throws an error naming it. Lock and identity paths are derived from this,
 * so symlink aliases of one table share them.
 */
export function canonicalTablePath(
  path: string,
  fs: Pick<TableFs, "realpathSync"> = nodeTableFs,
): string {
  try {
    return fs.realpathSync(path);
  } catch (err) {
    if (codeOf(err) !== "ENOENT") throw err;
  }
  const dir = dirname(path);
  let realDir: string;
  try {
    realDir = fs.realpathSync(dir);
  } catch (err) {
    throw new Error(`table directory ${dir} cannot be resolved: ${(err as Error).message}`, {
      cause: err,
    });
  }
  return join(realDir, basename(path));
}

/** The table identity file is empty or malformed; a human fixes or deletes it. */
export class TableIdentityError extends Error {
  readonly path: string;
  readonly content: string;

  constructor(path: string, content: string) {
    super(
      `table identity file ${path} is ${content === "" ? "empty" : "malformed"}; fix or delete it`,
    );
    this.name = "TableIdentityError";
    this.path = path;
    this.content = content;
  }
}

/** One UUID line: the UUID, optionally followed by one newline. */
const ID_LINE =
  /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\n?$/;

/** The tail of the per-path queue of identity calls in this process. */
const queues = new Map<string, Promise<unknown>>();

/**
 * Reads `<canonicalPath>.table-id`, or creates it with a random UUID when
 * missing (temp file `<canonical>.table-id.tmp-<lock nonce>`, fsync, rename;
 * the temp file is removed on failure). Requires the table lock: `lock.path`
 * must be `<canonicalPath>.lock`. Calls for one path are serialized in
 * process. An empty or malformed file throws `TableIdentityError` and is
 * never rewritten.
 */
export function readOrCreateTableId(
  canonicalPath: string,
  lock: TableLock,
  fs: TableFs = nodeTableFs,
): Promise<string> {
  if (lock.path !== `${canonicalPath}.lock`) {
    return Promise.reject(
      new Error(
        `readOrCreateTableId requires the table lock ${canonicalPath}.lock; got ${lock.path}`,
      ),
    );
  }
  const previous = queues.get(canonicalPath) ?? Promise.resolve();
  const run = () => readOrCreate(canonicalPath, lock.nonce, fs);
  const result = previous.then(run, run);
  const tail = result.catch(() => undefined);
  queues.set(canonicalPath, tail);
  void tail.then(() => {
    if (queues.get(canonicalPath) === tail) queues.delete(canonicalPath);
  });
  return result;
}

async function readOrCreate(canonicalPath: string, nonce: string, fs: TableFs): Promise<string> {
  const idPath = `${canonicalPath}.table-id`;
  try {
    const content = await fs.readFile(idPath, "utf8");
    const match = ID_LINE.exec(content);
    if (!match?.[1]) throw new TableIdentityError(idPath, content);
    return match[1];
  } catch (err) {
    if (codeOf(err) !== "ENOENT") throw err;
  }

  const id = randomUUID();
  const temp = `${idPath}.tmp-${nonce}`;
  let created = false;
  try {
    const handle = await fs.open(temp, "wx");
    created = true;
    let failed = false;
    let failure: unknown;
    try {
      await handle.writeFile(`${id}\n`, "utf8");
      await handle.sync();
    } catch (err) {
      failed = true;
      failure = err;
    }
    try {
      await handle.close();
    } catch (err) {
      if (!failed) {
        failed = true;
        failure = err;
      }
    }
    if (failed) throw failure;
    await fs.rename(temp, idPath);
  } catch (err) {
    if (created) await fs.unlink(temp).catch(() => undefined);
    throw err;
  }
  return id;
}
