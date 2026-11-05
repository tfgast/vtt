import { ImageCache } from "@vtt/ui";
import { describe, expect, test, vi } from "vitest";

function cache(onLoad = vi.fn()) {
  const created: HTMLImageElement[] = [];
  const images = new ImageCache({
    resolve: (path) => `/table/assets/${path}`,
    onLoad,
    createImage: () => {
      const img = document.createElement("img");
      created.push(img);
      return img;
    },
  });
  return { images, created, onLoad };
}

describe("ImageCache", () => {
  test("loads each URL once and returns the image once loaded", () => {
    const { images, created, onLoad } = cache();
    expect(images.get("a.png")).toBeNull();
    expect(images.get("a.png")).toBeNull();
    expect(created).toHaveLength(1);
    expect(created[0]?.src).toContain("/table/assets/a.png");
    created[0]?.dispatchEvent(new Event("load"));
    expect(onLoad).toHaveBeenCalledTimes(1);
    expect(images.get("a.png")).toBe(created[0]);
    expect(created).toHaveLength(1);
  });

  test("two paths resolving to one URL share an image", () => {
    const created: HTMLImageElement[] = [];
    const images = new ImageCache({
      resolve: () => "/same.png",
      createImage: () => {
        const img = document.createElement("img");
        created.push(img);
        return img;
      },
    });
    images.get("a");
    images.get("b");
    expect(created).toHaveLength(1);
  });

  test("a failed load reports error and requests a redraw", () => {
    const { images, created, onLoad } = cache();
    images.get("bad.png");
    created[0]?.dispatchEvent(new Event("error"));
    expect(images.get("bad.png")).toBe("error");
    expect(onLoad).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(1);
  });

  test("the default factory creates an HTMLImageElement", () => {
    const images = new ImageCache({ resolve: (p) => p });
    expect(images.get("x.png")).toBeNull();
  });
});
