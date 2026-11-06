/**
 * The canonical table path and the table identity file (PROTOCOL.md §2,
 * Canonical path; Table identity; decision D25).
 */
/// <reference types="node" />
import { randomUUID } from "node:crypto";
import { readlinkSync } from "node:fs";
import { basename, dirname, join, parse, sep } from "node:path";
import { nodeTableFs, type TableFs, type TableLock } from "./lock";

const codeOf = (err: unknown): unknown =>
  typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;

/** The filesystem calls `canonicalTablePath` makes. */
export type CanonicalPathFs = Pick<TableFs, "realpathSync"> & {
  /** Reads a symlink's target; when absent, no path is treated as a dangling symlink. */
  readlinkSync?(path: string): string;
};

const nodeCanonicalPathFs: CanonicalPathFs = {
  realpathSync: nodeTableFs.realpathSync,
  readlinkSync: (path) => readlinkSync(path, "utf8"),
};

/** Bound on dangling symlink hops, matching the usual kernel limit. */
const MAX_SYMLINK_HOPS = 40;

/**
 * The canonical table path: `realpath(path)` when the file exists; otherwise
 * `realpath(dirname(path))` joined with `basename(path)`. A dangling symlink
 * is followed first (its target resolved against the link's real directory,
 * hop by hop), so a new table is created at the link's target. A missing
 * directory or a symlink loop throws an error naming it. Lock and identity
 * paths are derived from this, so symlink aliases of one table share them.
 */
export function canonicalTablePath(
  path: string,
  fs: CanonicalPathFs = nodeCanonicalPathFs,
): string {
  const loop = (cause?: unknown) =>
    new Error(`table path ${path} is a symlink loop`, cause === undefined ? {} : { cause });
  let current = path;
  for (let hops = 0; ; hops++) {
    try {
      return fs.realpathSync(current);
    } catch (err) {
      if (codeOf(err) === "ELOOP") throw loop(err);
      if (codeOf(err) !== "ENOENT") throw err;
    }
    const target = readLink(fs, current);
    if (target === null) break;
    if (hops >= MAX_SYMLINK_HOPS) throw loop();
    current = resolveTarget(fs, path, current, target, loop);
  }
  const dir = dirname(current);
  let realDir: string;
  try {
    realDir = fs.realpathSync(dir);
  } catch (err) {
    const via = current === path ? "" : ` (target of symlink ${path})`;
    throw new Error(`table directory ${dir}${via} cannot be resolved: ${(err as Error).message}`, {
      cause: err,
    });
  }
  return join(realDir, basename(current));
}

/**
 * The path a symlink at `link` with target `target` names, resolved through
 * the filesystem: segment by segment from the link's real directory (or the
 * root), each existing prefix replaced by its realpath so directory links are
 * followed before a later `..`. The last segment may be missing; a missing
 * earlier segment throws an error naming it.
 */
function resolveTarget(
  fs: CanonicalPathFs,
  path: string,
  link: string,
  target: string,
  loop: (cause?: unknown) => Error,
): string {
  const root = parse(target).root;
  let current = root === "" ? fs.realpathSync(dirname(link)) : root;
  const segments = target
    .slice(root.length)
    .split(sep)
    .filter((s) => s !== "" && s !== ".");
  for (const [i, segment] of segments.entries()) {
    if (segment === "..") {
      // `current` is a realpath, so a lexical parent is its real parent.
      current = dirname(current);
      continue;
    }
    const next = join(current, segment);
    try {
      current = fs.realpathSync(next);
    } catch (err) {
      if (codeOf(err) === "ELOOP") throw loop(err);
      if (codeOf(err) !== "ENOENT") throw err;
      if (i === segments.length - 1) return next;
      throw new Error(
        `table directory ${next} (target of symlink ${path}) cannot be resolved: ${(err as Error).message}`,
        { cause: err },
      );
    }
  }
  return current;
}

/** The symlink target at `path`, or null when `path` is missing or not a symlink. */
function readLink(fs: CanonicalPathFs, path: string): string | null {
  if (fs.readlinkSync === undefined) return null;
  try {
    return fs.readlinkSync(path);
  } catch (err) {
    const code = codeOf(err);
    if (code === "EINVAL" || code === "ENOENT" || code === "ENOTDIR") return null;
    throw err;
  }
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
