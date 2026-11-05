import { LIMITS } from "@vtt/protocol";
import type { Snapshot } from "@vtt/schema";
import { afterEach, expect, test } from "vitest";
import { at, named, obj } from "../store/helpers";
import { cleanup, memoryHost, RawClient, serve } from "./helpers";

afterEach(cleanup);

function bigTable(n: number): Snapshot {
  const objects = Array.from({ length: n }, (_, i) =>
    obj(`token_${i}`, {
      board: "map",
      cells: { name: named(`Token number ${i}`), position: at(i % 100, Math.floor(i / 100)) },
    }),
  );
  return {
    revision: 0,
    next_seq: 1,
    boards: [{ id: "map", name: "Map" }],
    objects: Object.fromEntries(objects.map((o) => [o.id, o])),
    retired_ids: [],
  };
}

test("a subscription to `all` on a 3,000-object table is one response over 1 MiB", async () => {
  const { server } = await serve({ host: memoryHost(bigTable(3000)) });
  const raw = await RawClient.open(server);
  raw.request("all", "subscribe", { scope: { type: "all" } });
  const response = await raw.response("all", 20000);
  expect(response.ok).toBe(true);
  expect(response.result.objects).toHaveLength(3000);
  const index = raw.indexOf((f) => f.id === "all");
  expect(raw.sizes[index]).toBeGreaterThan(LIMITS.max_message_bytes);
  raw.request("after", "list_objects", { limit: 1 });
  expect(await raw.response("after")).toMatchObject({ ok: true });
  expect(raw.closeInfo).toBeNull();
}, 30000);
