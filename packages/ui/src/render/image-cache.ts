/**
 * The image decode cache (DESIGN.md §7 Platform; M4-D15): each asset URL is
 * loaded once as an `HTMLImageElement` and kept. The per-item bitmap cache
 * (`render-cache.ts`, M6-D37) redraws a bitmap once an image it drew settles.
 */

export interface ImageCacheOptions {
  /** An asset path (the `image` cell) to the URL to load (vtt-3l6.16's `assetUrl`). */
  resolve: (path: string) => string;
  /** Called after an image finishes loading or fails, to request a redraw. */
  onLoad?: () => void;
  /** Creates the element to load into; defaults to `new Image()`. */
  createImage?: () => HTMLImageElement;
}

type Entry =
  | { state: "loading"; image: HTMLImageElement }
  | { state: "loaded"; image: HTMLImageElement }
  | { state: "error" };

export class ImageCache {
  readonly #options: ImageCacheOptions;
  readonly #entries = new Map<string, Entry>();

  constructor(options: ImageCacheOptions) {
    this.#options = options;
  }

  /** The image for `path` once loaded, `null` while loading, `"error"` after a failure. */
  get(path: string): HTMLImageElement | null | "error" {
    const url = this.#options.resolve(path);
    let entry = this.#entries.get(url);
    if (entry === undefined) entry = this.#load(url);
    if (entry.state === "loaded") return entry.image;
    return entry.state === "error" ? "error" : null;
  }

  #load(url: string): Entry {
    const image = this.#options.createImage?.() ?? new Image();
    const entry: Entry = { state: "loading", image };
    this.#entries.set(url, entry);
    const settle = (next: Entry) => {
      if (this.#entries.get(url) !== entry) return;
      this.#entries.set(url, next);
      this.#options.onLoad?.();
    };
    image.addEventListener("load", () => settle({ state: "loaded", image }), { once: true });
    image.addEventListener("error", () => settle({ state: "error" }), { once: true });
    image.src = url;
    return entry;
  }
}
