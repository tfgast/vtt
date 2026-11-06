// @vitest-environment node
/**
 * The shipped prepped first-session table opens at §8.4 step 7's state
 * (vtt-qf5.34; DESIGN.md §8.4, repeat playtests; M6-D29). A copy of the
 * table, under another name, with its assets directory beside it, is opened
 * as `vtt-serve` (and so `pnpm start`) opens a table: `TableHost.open`,
 * served by `startServer` with the asset routes. A GM protocol client then
 * finds what prep (`runPrep`) leaves: the GM and Crypt boards, the four
 * characters and the note on the GM board, the GM binder, map, six covered
 * rooms and nine goblins on Crypt, room 4 hatched, the Fireball card in
 * Aldric's binder, and both images served.
 */
import { cp, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssetHttpHandler, type RunningServer, startServer, TableHost } from "@vtt/authority";
import {
  CRYPT_MAP,
  exampleAssetPath,
  examplesDir,
  GOBLIN_IMAGE,
  PREPPED_TABLE,
  preppedTablePath,
} from "@vtt/fixtures";
import { type ObjectView, ProtocolClient } from "@vtt/protocol";
import { afterEach, expect, test } from "vitest";
import { NodeWebSocket } from "../support/authority";

const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});

const value = (v: ObjectView, cell: string) => v.cells[cell]?.value;
const text = (v: ObjectView, cell: string): unknown =>
  (value(v, cell) as { value?: unknown } | undefined)?.value;
const refs = (v: ObjectView, cell: string): string[] => {
  const l = value(v, cell) as { type?: string; items?: { object?: string }[] } | undefined;
  return l?.type === "list" ? (l.items ?? []).flatMap((i) => (i.object ? [i.object] : [])) : [];
};
const tags = (v: ObjectView): string[] => {
  const l = value(v, "tag") as { items?: { value?: unknown }[] } | undefined;
  return (l?.items ?? []).flatMap((i) => (typeof i.value === "string" ? [i.value] : []));
};

test("a copy of the shipped prepped table opens at step 7's state", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "vtt-prepped-")));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "my-playtest.table.json");
  await cp(preppedTablePath(), file);
  await cp(join(examplesDir(), PREPPED_TABLE.assetsDir), join(dir, PREPPED_TABLE.assetsDir), {
    recursive: true,
  });

  const host = await TableHost.open(file, { autosave: false });
  cleanups.push(() => host.close());
  expect(host.warnings).toEqual([]);
  const server: RunningServer = await startServer({
    host,
    port: 0,
    http: [createAssetHttpHandler({ host })],
  });
  cleanups.push(() => server.close());
  const gm = new ProtocolClient({
    url: server.url,
    token: server.token,
    client: { name: "prepped-table", kind: "test" },
    WebSocket: NodeWebSocket,
    onWarning: () => undefined,
  });
  cleanups.push(() => gm.close());
  await gm.connect();

  const { snapshot } = await gm.request("document", {});
  expect(snapshot.boards.map((b) => b.name)).toEqual(["GM", "Crypt"]);
  const crypt = snapshot.boards.find((b) => b.name === "Crypt")?.id as string;
  const on = async (board: string) =>
    (await gm.request("list_objects", { filter: { board }, cells: "all", limit: 100 })).objects;
  const named = (views: ObjectView[], name: string) => {
    const found = views.filter((v) => text(v, "name") === name);
    expect(found, name).toHaveLength(1);
    return found[0] as ObjectView;
  };

  // The GM board: the four characters and the inked note.
  const gmBoard = await on("gm_board");
  expect(gmBoard.map((v) => text(v, "name")).sort()).toEqual([
    "Aldric",
    "Brenna",
    "Corin",
    "Dara",
    "Note",
  ]);
  const note = named(gmBoard, "Note");
  expect((value(note, "ink") as { strokes: unknown[] }).strokes).toHaveLength(3);
  const aldric = named(gmBoard, "Aldric");
  expect(aldric.is_character).toBe(true);

  // Crypt: the GM binder, the map, six covered rooms, the goblin template and G1–G8.
  const cryptObjects = await on(crypt);
  const names = cryptObjects.map((v) => text(v, "name"));
  expect(names).toEqual(
    expect.arrayContaining([
      "GM binder",
      "crypt-map",
      "Goblin",
      ...CRYPT_MAP.rooms.map((r) => `Room ${r.n}`),
      ...Array.from({ length: 8 }, (_, i) => `G${i + 1}`),
    ]),
  );
  expect(cryptObjects).toHaveLength(17);
  const binder = named(cryptObjects, "GM binder");
  expect(refs(binder, "contents")).toContain("tpl_d20");
  for (const room of CRYPT_MAP.rooms) {
    const zone = named(cryptObjects, `Room ${room.n}`);
    expect(value(zone, "opaque")).toEqual({ type: "boolean", value: true });
    expect(value(zone, "visible_to")).toEqual({ type: "viewers", viewers: ["gm"] });
  }
  const room4 = named(cryptObjects, "Room 4");
  expect(tags(room4)).toEqual(["difficult"]);
  expect(text(room4, "pattern")).toBe("hatch");
  const goblin = named(cryptObjects, "Goblin");
  expect(goblin.is_template).toBe(true);
  const { zones } = await gm.request("zones", { board: crypt });
  const contentsOf = (n: number) =>
    zones.find((z) => z.id === named(cryptObjects, `Room ${n}`).id)?.contents ?? [];
  const goblinsIn = (n: number) =>
    contentsOf(n)
      .map((id) => text(cryptObjects.find((v) => v.id === id) as ObjectView, "name"))
      .sort();
  expect(goblinsIn(3)).toEqual(["G1", "G2", "G3", "G4"]);
  expect(goblinsIn(5)).toEqual(["G5", "G6", "G7", "G8"]);

  // Both images are served from the copy's assets directory.
  const served = async (v: ObjectView, fixture: string) => {
    const path = text(v, "image") as string;
    expect(path.startsWith(`${PREPPED_TABLE.assetsDir}/`)).toBe(true);
    const response = await fetch(new URL(`/assets/${path}`, server.url.replace(/^ws/, "http")));
    expect(response.status).toBe(200);
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.equals(Buffer.from(await readFile(exampleAssetPath(fixture))))).toBe(true);
  };
  await served(goblin, GOBLIN_IMAGE.file);
  for (const g of cryptObjects.filter((v) => /^G\d$/.test(String(text(v, "name"))))) {
    expect(text(g, "image")).toBe(text(goblin, "image"));
  }
  await served(named(cryptObjects, "crypt-map"), CRYPT_MAP.file);

  // Step 5's result: the Fireball card in Aldric's binder, its DC corrected to 15.
  const { objects } = await gm.request("get_objects", { ids: refs(aldric, "contents") });
  const aldricBinder = objects.find((o) => tags(o).includes("binder")) as ObjectView;
  const cards = await gm.request("get_objects", {
    ids: refs(aldricBinder, "contents"),
    cells: "all",
  });
  const fireball = cards.objects.find((o) => text(o, "name") === "Fireball");
  expect(fireball?.is_template).toBe(true);
  expect(value(fireball as ObjectView, "dc")).toEqual({ type: "number", value: 15 });
});
