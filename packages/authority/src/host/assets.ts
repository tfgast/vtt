/**
 * Importing image assets (DESIGN.md §7, Revisions and assets; PROTOCOL.md §1,
 * `POST /assets`; M4-D2): the bytes are checked by their magic bytes (PNG,
 * JPEG, WebP, GIF; never SVG, which can carry script) and size, stored as
 * `<table basename>.assets/<slug>-<hash8>.<ext>` beside the table file
 * (temp file + rename), and added to the host's asset list so the next save
 * lists them. The path returned and listed is relative to the table's
 * directory, with `/` separators. Garbage collection is not done (v1).
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { TableHost } from "./table-host";

/** The largest accepted asset, in bytes: 50 MiB (PROTOCOL.md §1). */
export const MAX_ASSET_BYTES = 50 * 1024 * 1024;

/** An accepted image type: the stored extension and its content type. */
export interface AssetType {
  readonly ext: "png" | "jpg" | "webp" | "gif";
  readonly contentType: string;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, prefix: readonly number[], at = 0): boolean {
  if (bytes.length < at + prefix.length) return false;
  return prefix.every((b, i) => bytes[at + i] === b);
}

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

/**
 * The image type `bytes` start with, by magic bytes, or null: PNG (the
 * 8-byte signature), JPEG (`FF D8 FF`), GIF (`GIF87a`/`GIF89a`), WebP
 * (`RIFF` ???? `WEBP`). Anything else, SVG and empty input included, is null.
 */
export function assetTypeOf(bytes: Uint8Array): AssetType | null {
  if (startsWith(bytes, PNG_SIGNATURE)) return { ext: "png", contentType: "image/png" };
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { ext: "jpg", contentType: "image/jpeg" };
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) {
    return { ext: "gif", contentType: "image/gif" };
  }
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) {
    return { ext: "webp", contentType: "image/webp" };
  }
  return null;
}

/** The slug length limit (PROTOCOL.md §1). */
const MAX_SLUG = 40;

/**
 * `raw` as a slug (PROTOCOL.md §1): lowercased, every character outside
 * `[a-z0-9_-]` replaced by `-`, at most 40 characters; `image` when empty.
 */
export function assetSlug(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]/gu, "-")
    .slice(0, MAX_SLUG);
  return slug === "" ? "image" : slug;
}

/** The stem of `filename`'s last path component (`/` or `\`): without its last extension, unless it starts with the only dot. */
function fileStem(filename: string): string {
  const name = filename.split(/[/\\]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

export type AssetImportErrorCode = "in_memory" | "too_large" | "unsupported_type";

/** Why an import was refused; the HTTP handler maps `code` to 409, 413 or 415. */
export class AssetImportError extends Error {
  readonly code: AssetImportErrorCode;

  constructor(code: AssetImportErrorCode, message: string) {
    super(message);
    this.name = "AssetImportError";
    this.code = code;
  }
}

export interface ImportAssetInput {
  /** The file's bytes. */
  bytes: Uint8Array;
  /** The original file name; its stem is the slug when `slug` is absent. */
  filename: string;
  /** The slug, before normalization; default: the file name's stem. */
  slug?: string;
}

/** The size check alone, for callers that know the length before reading the bytes. */
export function assertAssetSize(length: number): void {
  if (length > MAX_ASSET_BYTES) {
    throw new AssetImportError(
      "too_large",
      `the asset is ${length} bytes; at most ${MAX_ASSET_BYTES} are accepted`,
    );
  }
}

/**
 * Imports an image into the table's assets directory and lists it: refuses
 * an in-memory host (`in_memory`), more than MAX_ASSET_BYTES (`too_large`)
 * and bytes that are not PNG, JPEG, WebP or GIF (`unsupported_type`); then
 * writes `<dir>/<table basename>.assets/<slug>-<hash8>.<ext>` through a temp
 * file and a rename (creating the directory), unless that file already holds
 * exactly these bytes, and calls `host.addAsset` with the relative path.
 */
export async function importAsset(
  host: TableHost,
  input: ImportAssetInput,
): Promise<{ path: string }> {
  const tablePath = host.path;
  if (tablePath === null) {
    throw new AssetImportError(
      "in_memory",
      "an in-memory table has no directory to store assets in",
    );
  }
  const bytes = input.bytes;
  assertAssetSize(bytes.length);
  const type = assetTypeOf(bytes);
  if (type === null) {
    throw new AssetImportError(
      "unsupported_type",
      "only PNG, JPEG, WebP and GIF images are accepted (recognised by their magic bytes)",
    );
  }
  const slug = assetSlug(input.slug ?? fileStem(input.filename));
  const hash8 = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
  const dirName = `${basename(tablePath)}.assets`;
  const fileName = `${slug}-${hash8}.${type.ext}`;
  const assetsDir = join(dirname(tablePath), dirName);
  const target = join(assetsDir, fileName);

  if (!(await holds(target, bytes))) {
    await mkdir(assetsDir, { recursive: true });
    await writeAtomically(assetsDir, target, bytes);
  }
  const path = `${dirName}/${fileName}`;
  host.addAsset(path);
  return { path };
}

/** Whether `file` exists and holds exactly `bytes`. */
async function holds(file: string, bytes: Uint8Array): Promise<boolean> {
  try {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).equals(
      await readFile(file),
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR") return false;
    throw err;
  }
}

/** Writes `bytes` to a temp file in `dir`, syncs it, and renames it over `target`. */
async function writeAtomically(dir: string, target: string, bytes: Uint8Array): Promise<void> {
  const temp = join(dir, `.${basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    const handle = await open(temp, "wx");
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, target);
  } catch (err) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw err;
  }
}
