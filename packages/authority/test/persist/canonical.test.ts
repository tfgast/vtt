import { canonicalJson, parseTable, sha256Hex, snapshotHash } from "@vtt/authority";
import type { Snapshot } from "@vtt/schema";
import { describe, expect, test } from "vitest";
import { playedStore, scene, textOf } from "./helpers";

describe("canonicalJson", () => {
  test("is byte-stable across two serializations of one store", () => {
    const store = playedStore();
    expect(textOf(store)).toBe(textOf(store));
  });

  test("parse → serialize reproduces the text exactly", () => {
    const text = textOf(playedStore(), ["images/map.png"]);
    const { store, editedExternally } = parseTable(text);
    expect(editedExternally).toBe(false);
    expect(textOf(store, ["images/map.png"])).toBe(text);
  });

  test("two-space indent and a trailing newline", () => {
    const text = canonicalJson({ b: [1, { c: null }], a: {}, d: [] });
    expect(text).toBe(
      '{\n  "a": {},\n  "b": [\n    1,\n    {\n      "c": null\n    }\n  ],\n  "d": []\n}\n',
    );
  });

  test("orders file, snapshot and object keys by schema field order", () => {
    const text = textOf(playedStore());
    const order = (...keys: string[]) => keys.map((k) => text.indexOf(`"${k}":`));
    const ascending = (xs: number[]) => {
      for (const x of xs) expect(x).toBeGreaterThanOrEqual(0);
      expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    };
    ascending(order("format", "schema_version", "snapshot", "snapshot_hash", "log", "assets"));
    ascending(order("revision", "next_seq", "boards", "objects", "retired_ids"));
    const goblin = text.slice(text.indexOf('"goblin": {'));
    const field = (k: string) => goblin.indexOf(`"${k}":`);
    ascending(
      [
        "id",
        "is_template",
        "is_zone",
        "is_character",
        "tag",
        "shape",
        "board",
        "contents",
        "cells",
        "cell_visibility",
        "actions",
      ].map(field),
    );
    ascending(order("first_index", "groups", "undo_barrier"));
  });

  test("sorts objects, cells and cell_visibility by key, whatever the insertion order", () => {
    const a = scene();
    const b: Snapshot = {
      retired_ids: [],
      objects: Object.fromEntries(
        Object.entries(a.objects)
          .reverse()
          .map(([id, o]) => [
            id,
            {
              ...o,
              cells: Object.fromEntries(Object.entries(o.cells).reverse()),
              cell_visibility: Object.fromEntries(Object.entries(o.cell_visibility).reverse()),
            },
          ]),
      ),
      boards: a.boards,
      next_seq: a.next_seq,
      revision: a.revision,
    };
    const text = canonicalJson(a);
    expect(canonicalJson(b)).toBe(text);
    expect(snapshotHash(b)).toBe(snapshotHash(a));
    const pos = (s: string) => text.indexOf(s);
    expect(pos('"bag": {')).toBeLessThan(pos('"coin": {'));
    expect(pos('"coin": {')).toBeLessThan(pos('"goblin": {'));
    // Code-unit order, not JavaScript's integer-key-first property order.
    const coin = text.slice(pos('"coin": {'), pos('"goblin": {'));
    const inCoin = (s: string) => coin.indexOf(s);
    expect(inCoin('"10": {')).toBeGreaterThan(0);
    expect(inCoin('"10": {')).toBeLessThan(inCoin('"9": {'));
    expect(inCoin('"9": {')).toBeLessThan(inCoin('"name": {'));
    expect(inCoin('"name": {')).toBeLessThan(inCoin('"value": {'));
    expect(pos('"contents": {')).toBeLessThan(pos('"tag": {'));
  });

  test("puts a value's type first inside a snapshot", () => {
    const s = scene();
    const coin = s.objects.coin;
    if (coin === undefined) throw new Error("no coin");
    coin.cells.value = { content: { value: 1, type: "number" } as never };
    expect(canonicalJson(s)).toContain(
      `"value": {\n${" ".repeat(10)}"content": {\n${" ".repeat(12)}"type": "number",\n${" ".repeat(12)}"value": 1\n`,
    );
  });
});

describe("sha256Hex", () => {
  test.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    [
      "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    ],
    [
      "The quick brown fox jumps over the lazy dog",
      "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592",
    ],
    [
      "a".repeat(1000) as string,
      "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3",
    ],
  ])("hashes %#", (input, hex) => {
    expect(sha256Hex(input)).toBe(hex);
  });

  test("snapshotHash is sha256 of the canonical snapshot", () => {
    const s = scene();
    expect(snapshotHash(s)).toBe(`sha256:${sha256Hex(canonicalJson(s))}`);
  });
});
