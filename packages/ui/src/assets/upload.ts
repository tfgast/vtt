/**
 * Uploading table images from the browser (PROTOCOL.md §1, `POST /assets`
 * and `GET /assets/<path>`; DESIGN.md §7, Revisions and assets; M4-D3).
 * The returned path is what an object's `image` cell holds (DESIGN.md §4.6,
 * Appearance cells); `assetUrl` turns it into the URL the authority serves
 * it at.
 */

export interface UploadAssetOptions {
  /** The session token (from the session bootstrap, PROTOCOL.md §2). */
  token: string;
  /** The authority's HTTP origin; default `location.origin`. */
  base?: string;
  /** The slug to name the file by; default: the authority uses the file name's stem. */
  slug?: string;
  /** Default: the global `fetch`. */
  fetch?: typeof fetch;
}

/** An upload the authority refused (`status` 401, 409, 413, 415, …) or answered unexpectedly. */
export class AssetUploadError extends Error {
  /** The HTTP status; 0 when the request itself failed. */
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "AssetUploadError";
    this.status = status;
  }
}

/**
 * POSTs `file` to `<base>/assets` with the bearer token, `X-Filename` (the
 * file's name, URL-encoded; empty for a nameless Blob) and `X-Slug` when
 * given; resolves with the stored path, relative to the table file. Rejects
 * with AssetUploadError for a non-201 answer or a malformed body. The bytes
 * are sent as an ArrayBuffer, which every fetch implementation accepts.
 */
export async function uploadAsset(
  file: Blob,
  options: UploadAssetOptions,
): Promise<{ path: string }> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const base = (options.base ?? globalThis.location.origin).replace(/\/+$/, "");
  const name = (file as Partial<File>).name;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.token}`,
    "Content-Type": file.type === "" ? "application/octet-stream" : file.type,
    "X-Filename": encodeURIComponent(typeof name === "string" ? name : ""),
  };
  if (options.slug !== undefined) headers["X-Slug"] = encodeURIComponent(options.slug);
  let res: Response;
  try {
    res = await doFetch(`${base}/assets`, {
      method: "POST",
      headers,
      body: await file.arrayBuffer(),
    });
  } catch (err) {
    throw new AssetUploadError(0, `the upload failed: ${String(err)}`);
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: reported below.
  }
  if (res.status !== 201) {
    const reason =
      typeof body === "object" &&
      body !== null &&
      typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : text.trim();
    throw new AssetUploadError(res.status, `the upload was refused (${res.status}): ${reason}`);
  }
  const path =
    typeof body === "object" && body !== null ? (body as { path?: unknown }).path : undefined;
  if (typeof path !== "string" || path === "") {
    throw new AssetUploadError(res.status, "the upload's answer has no path");
  }
  return { path };
}

/** The URL path the authority serves the asset `path` at: `/assets/` plus its segments, URI-encoded. */
export function assetUrl(path: string): string {
  return `/assets/${path.split("/").map(encodeURIComponent).join("/")}`;
}
