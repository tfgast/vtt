import { readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readBootstrap } from "@vtt/ui";
import { afterEach, describe, expect, test } from "vitest";

/** A fresh HTML document whose `<head>` holds `head`. */
function page(head: string): Document {
  const doc = document.implementation.createHTMLDocument("vtt");
  doc.head.innerHTML = head;
  return doc;
}

describe("readBootstrap (PROTOCOL.md §2, session bootstrap)", () => {
  afterEach(() => {
    document.getElementById("vtt-session")?.remove();
  });

  test("returns the element's url and token", () => {
    // `<` is escaped as < by the authority (injectSession); JSON.parse restores it.
    const doc = page(
      '<script id="vtt-session" type="application/json">{"url": "ws://127.0.0.1:4747/ws", "token": "a\\u003cb"}</script>',
    );
    expect(readBootstrap(doc)).toEqual({ url: "ws://127.0.0.1:4747/ws", token: "a<b" });
  });

  test("returns null without the element", () => {
    expect(readBootstrap(page("<title>vtt</title>"))).toBeNull();
  });

  test("returns null for malformed or incomplete content", () => {
    const element = (json: string) =>
      page(`<script id="vtt-session" type="application/json">${json}</script>`);
    expect(readBootstrap(element("{not json"))).toBeNull();
    expect(readBootstrap(element('{"url": "ws://127.0.0.1:1/ws"}'))).toBeNull();
    expect(readBootstrap(element('{"url": 1, "token": "t"}'))).toBeNull();
    expect(readBootstrap(element('{"url": "ws://127.0.0.1:1/ws", "token": ""}'))).toBeNull();
    expect(readBootstrap(element('["ws://127.0.0.1:1/ws", "t"]'))).toBeNull();
  });

  test("ignores an element of another type", () => {
    const doc = page(
      '<script id="vtt-session" type="text/plain">{"url": "ws://127.0.0.1:1/ws", "token": "t"}</script>',
    );
    expect(readBootstrap(doc)).toBeNull();
  });

  test("reads the global document by default", () => {
    expect(readBootstrap()).toBeNull();
    const script = document.createElement("script");
    script.id = "vtt-session";
    script.type = "application/json";
    script.textContent = JSON.stringify({ url: "ws://127.0.0.1:9/ws", token: "tok" });
    document.head.append(script);
    expect(readBootstrap()).toEqual({ url: "ws://127.0.0.1:9/ws", token: "tok" });
  });
});

describe("import boundary", () => {
  const srcDir = fileURLToPath(new URL("../../src", import.meta.url));

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      return /\.(ts|tsx)$/.test(name) ? [path] : [];
    });
  }

  test("no file under packages/ui/src imports @vtt/authority or a node: module (or a bare Node built-in)", () => {
    const files = sources(srcDir);
    expect(files.length).toBeGreaterThan(0);
    const specifier = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(specifier)) {
        const target = match[1] ?? "";
        if (target === "@vtt/authority" || target.startsWith("@vtt/authority/")) {
          offenders.push(`${file}: ${target}`);
        }
        // `node:` modules, and Node built-ins imported without the prefix.
        if (target.startsWith("node:") || builtinModules.includes(target.split("/")[0] ?? "")) {
          offenders.push(`${file}: ${target}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
