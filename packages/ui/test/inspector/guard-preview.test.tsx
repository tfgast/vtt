/**
 * The action editor's guard preview (vtt-qf5.31; DESIGN.md §4.5 "the
 * inspector shows an action's steps and precondition"; M5 plan section 5):
 * while the editor is open, the typed `when` is evaluated ad hoc on the
 * object (GM `evaluate` with `this`, debounced, keyed by revision and text)
 * and its value is shown beside the field.
 *
 * The first part drives `ActionEditor` with a fake `evaluate` whose answers
 * the test resolves by hand; the second runs `ActionsList` against a real
 * in-process authority.
 */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WireOp, WireResult } from "@vtt/protocol";
import type { ObjectId } from "@vtt/schema";
import {
  type ActionDraft,
  ActionEditor,
  ActionsList,
  createUiStore,
  type GuardPreview,
  TableProvider,
  type TableSession,
  useSession,
} from "@vtt/ui";
import { useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { startAuthority, until, whenReady } from "../support/authority";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

const bool = (value: boolean): WireResult => ({ type: "boolean", value });

// ---------------------------------------------------------------------------
// ActionEditor with a fake evaluate

interface Call {
  source: string;
  object: ObjectId;
  resolve(value: WireResult): void;
  reject(error: unknown): void;
}

function fakeEvaluate() {
  const calls: Call[] = [];
  const evaluate = vi.fn(
    (source: string, object: ObjectId) =>
      new Promise<WireResult>((resolve, reject) => {
        calls.push({ source, object, resolve, reject });
      }),
  );
  return { calls, evaluate };
}

const DELAY = 20;

function Editor(props: { preview: Omit<GuardPreview, "delayMs"> | undefined; when?: string }) {
  const [draft, setDraft] = useState<ActionDraft>({
    name: "Heal",
    when: props.when ?? "",
    steps: ["add(hp, 1)"],
  });
  return (
    <ActionEditor
      draft={draft}
      onChange={setDraft}
      original="Heal"
      names={["Heal"]}
      onSave={() => undefined}
      onCancel={() => undefined}
      {...(props.preview === undefined ? {} : { preview: { ...props.preview, delayMs: DELAY } })}
    />
  );
}

const whenField = () => screen.getByRole("textbox", { name: "Condition (when)" });
const shown = () => screen.queryByRole("status", { name: "Condition value" });
const settle = () => new Promise((r) => setTimeout(r, DELAY * 3));

describe("ActionEditor guard preview", () => {
  test("typing hp < 5 asks once after the debounce and shows the value", async () => {
    const { calls, evaluate } = fakeEvaluate();
    const user = userEvent.setup();
    render(<Editor preview={{ object: "goblin", revision: 4, evaluate, refLabel: () => null }} />);
    await user.type(whenField(), "hp < 5");
    await waitFor(() => expect(calls).toHaveLength(1));
    await settle();
    expect(calls.map((c) => [c.source, c.object])).toEqual([["hp < 5", "goblin"]]);
    expect(shown()).toBeNull();
    await act(async () => calls[0]?.resolve(bool(true)));
    expect(shown()?.textContent).toBe("true");
  });

  test("a new revision asks again and updates the value", async () => {
    const { calls, evaluate } = fakeEvaluate();
    const preview = { object: "goblin", revision: 4, evaluate, refLabel: () => null };
    const { rerender } = render(<Editor preview={preview} when="hp < 5" />);
    await waitFor(() => expect(calls).toHaveLength(1));
    await act(async () => calls[0]?.resolve(bool(true)));
    expect(shown()?.textContent).toBe("true");
    rerender(<Editor preview={{ ...preview, revision: 5 }} when="hp < 5" />);
    await waitFor(() => expect(calls).toHaveLength(2));
    // The old value stays until the new answer (same text).
    expect(shown()?.textContent).toBe("true");
    await act(async () => calls[1]?.resolve(bool(false)));
    expect(shown()?.textContent).toBe("false");
  });

  test("a stale response resolving after a later one is dropped", async () => {
    const { calls, evaluate } = fakeEvaluate();
    const user = userEvent.setup();
    render(<Editor preview={{ object: "goblin", revision: 4, evaluate, refLabel: () => null }} />);
    await user.type(whenField(), "hp < 5");
    await waitFor(() => expect(calls).toHaveLength(1));
    await user.type(whenField(), "0");
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]?.source).toBe("hp < 50");
    await act(async () => calls[1]?.resolve(bool(false)));
    expect(shown()?.textContent).toBe("false");
    await act(async () => calls[0]?.resolve(bool(true)));
    expect(shown()?.textContent).toBe("false");
  });

  for (const late of ["success", "rejection"] as const) {
    test(`A → B → A: a late ${late} of the first request does not touch the latest value`, async () => {
      const { calls, evaluate } = fakeEvaluate();
      const user = userEvent.setup();
      render(
        <Editor preview={{ object: "goblin", revision: 4, evaluate, refLabel: () => null }} />,
      );
      await user.type(whenField(), "hp < 5");
      await waitFor(() => expect(calls).toHaveLength(1));
      await user.type(whenField(), "0");
      await waitFor(() => expect(calls).toHaveLength(2));
      await user.type(whenField(), "{Backspace}");
      await waitFor(() => expect(calls).toHaveLength(3));
      expect(calls.map((c) => c.source)).toEqual(["hp < 5", "hp < 50", "hp < 5"]);
      await act(async () => calls[2]?.resolve(bool(true)));
      expect(shown()?.textContent).toBe("true");
      await act(async () =>
        late === "success" ? calls[0]?.resolve(bool(false)) : calls[0]?.reject(new Error("late")),
      );
      expect(shown()?.textContent).toBe("true");
      await act(async () => calls[1]?.resolve(bool(false)));
      expect(shown()?.textContent).toBe("true");
    });
  }

  test("a stale response of an older revision is dropped", async () => {
    const { calls, evaluate } = fakeEvaluate();
    const preview = { object: "goblin", revision: 4, evaluate, refLabel: () => null };
    const { rerender } = render(<Editor preview={preview} when="hp < 5" />);
    await waitFor(() => expect(calls).toHaveLength(1));
    rerender(<Editor preview={{ ...preview, revision: 5 }} when="hp < 5" />);
    await waitFor(() => expect(calls).toHaveLength(2));
    await act(async () => calls[1]?.resolve(bool(false)));
    await act(async () => calls[0]?.resolve(bool(true)));
    expect(shown()?.textContent).toBe("false");
  });

  test("a value for other text is not shown while the new text is pending", async () => {
    const { calls, evaluate } = fakeEvaluate();
    const user = userEvent.setup();
    render(<Editor preview={{ object: "goblin", revision: 4, evaluate, refLabel: () => null }} />);
    await user.type(whenField(), "hp < 5");
    await waitFor(() => expect(calls).toHaveLength(1));
    await act(async () => calls[0]?.resolve(bool(true)));
    expect(shown()?.textContent).toBe("true");
    await user.type(whenField(), "0");
    expect(shown()).toBeNull();
  });

  test("empty text shows nothing and asks nothing", async () => {
    const { calls, evaluate } = fakeEvaluate();
    const user = userEvent.setup();
    render(<Editor preview={{ object: "goblin", revision: 4, evaluate, refLabel: () => null }} />);
    await settle();
    expect(calls).toHaveLength(0);
    await user.type(whenField(), "hp < 5");
    await waitFor(() => expect(calls).toHaveLength(1));
    await act(async () => calls[0]?.resolve(bool(true)));
    expect(shown()?.textContent).toBe("true");
    await user.clear(whenField());
    expect(shown()).toBeNull();
    await settle();
    expect(calls).toHaveLength(1);
  });

  test("a when that does not parse asks nothing", async () => {
    const { calls, evaluate } = fakeEvaluate();
    const user = userEvent.setup();
    render(<Editor preview={{ object: "goblin", revision: 4, evaluate, refLabel: () => null }} />);
    await user.type(whenField(), "hp <");
    await settle();
    expect(calls).toHaveLength(0);
    expect(shown()).toBeNull();
  });

  test("an error value is shown with its code and error tone", async () => {
    const { calls, evaluate } = fakeEvaluate();
    render(
      <Editor
        preview={{ object: "goblin", revision: 4, evaluate, refLabel: () => null }}
        when="nope < 5"
      />,
    );
    await waitFor(() => expect(calls).toHaveLength(1));
    await act(async () =>
      calls[0]?.resolve({ type: "error", code: "#NAME", message: "no cell nope" }),
    );
    expect(shown()?.textContent).toBe("#NAME: no cell nope");
    expect(shown()?.getAttribute("data-tone")).toBe("error");
  });

  test("a failed request (no evaluate for this viewer) shows nothing", async () => {
    const { calls, evaluate } = fakeEvaluate();
    render(
      <Editor
        preview={{ object: "goblin", revision: 4, evaluate, refLabel: () => null }}
        when="hp < 5"
      />,
    );
    await waitFor(() => expect(calls).toHaveLength(1));
    await act(async () => calls[0]?.reject(new Error("forbidden")));
    expect(shown()).toBeNull();
  });

  test("without a preview nothing is shown", async () => {
    render(<Editor preview={undefined} when="hp < 5" />);
    await settle();
    expect(shown()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ActionsList against a real authority

const BOARD = "gm_board";
const SEED: WireOp[] = [
  {
    type: "create_object",
    id: "goblin",
    to: { type: "board", board: BOARD, position: [0, 0] },
    init: {
      shape: { type: "circle", radius: 0.5 },
      cells: {
        name: { type: "text", value: "Goblin" },
        visible_to: { type: "viewers", viewers: ["all"] },
        hp: { type: "number", value: 3 },
      },
      actions: [{ name: "Heal", steps: ["add(hp, 1)"] }],
    },
  },
];

function Harness({ session, object }: { session: TableSession; object: ObjectId }) {
  useSession((s) => s.viewVersion);
  const viewer = useSession((s) => s.viewer);
  const view = session.objectView(object);
  if (view === null) return <p>not in view</p>;
  return <ActionsList view={view} gm={viewer.type === "gm"} />;
}

describe("ActionsList guard preview", () => {
  test("typing hp < 5 shows its current value and updates after a commit", async () => {
    const authority = await startAuthority();
    cleanups.push(() => authority.cleanup());
    const gm = await authority.client("seed");
    const seeded = await gm.transact(SEED, { label: "Seed" });
    expect(seeded.status).toBe("committed");
    const session = authority.session();
    await whenReady(session);
    await until(() => session.objectView("goblin") !== null, "the goblin's view");
    const request = vi.spyOn(session.client, "request");
    const ui = createUiStore({ session });
    render(
      <TableProvider session={session} ui={ui}>
        <Harness session={session} object="goblin" />
      </TableProvider>,
    );
    const user = userEvent.setup();
    const section = screen.getByRole("region", { name: "Actions" });
    await user.click(within(section).getByRole("button", { name: "Edit Heal" }));
    const editor = within(section).getByRole("group", { name: "Edit Heal" });
    await user.type(within(editor).getByRole("textbox", { name: "Condition (when)" }), "hp < 5");
    const value = () => within(editor).queryByRole("status", { name: "Condition value" });
    await waitFor(() => expect(value()?.textContent).toBe("true"));
    expect(request.mock.calls.filter(([m]) => m === "evaluate").map(([, p]) => p)).toEqual([
      { source: "hp < 5", this: "goblin" },
    ]);

    const set = await gm.transact(
      [{ type: "set_value", object: "goblin", cell: "hp", value: { type: "number", value: 7 } }],
      { label: "Hurt" },
    );
    expect(set.status).toBe("committed");
    await waitFor(() => expect(value()?.textContent).toBe("false"));
  });
});
