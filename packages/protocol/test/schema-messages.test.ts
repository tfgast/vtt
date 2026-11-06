import {
  type CommitEvent,
  type Cover,
  type EffectView,
  type GroupView,
  GroupViewSchema,
  type Hello,
  LIMITS,
  type MethodName,
  type ObjectSnapshotView,
  type ObjectView,
  ObjectViewSchema,
  PROTOCOL_ERROR_CODES,
  ProtocolFailure,
  type ProtocolRejection,
  parseClientMessage,
  parseResult,
  parseServerMessage,
  TransactParamsSchema,
  UndoParamsSchema,
  type Welcome,
  type WireOp,
  WireOpSchema,
  WireValueSchema,
} from "@vtt/protocol";
import { describe, expect, test } from "vitest";

// ---------------------------------------------------------------------------
// Helpers

/** A client message survives `parseClientMessage` unchanged. */
function clientRoundTrip(message: unknown): void {
  const parsed = parseClientMessage(JSON.stringify(message));
  expect(parsed).toEqual({ ok: true, message });
}

/** A server message survives `parseServerMessage` unchanged, with no warnings. */
function serverRoundTrip(message: unknown): void {
  const parsed = parseServerMessage(JSON.stringify(message));
  expect(parsed).toEqual({ ok: true, message, warnings: [] });
}

function request(method: string, params: unknown, id = "r1") {
  return { type: "request", id, method, params };
}

function response(result: unknown, id = "r1") {
  return { type: "response", id, ok: true, result };
}

/** A result survives both stages: envelope parsing, then `parseResult`. */
function resultRoundTrip(method: MethodName, result: unknown): void {
  const env = parseServerMessage(JSON.stringify(response(result)));
  if (env.ok !== true) throw new Error(`envelope failed: ${JSON.stringify(env)}`);
  expect(env.warnings).toEqual([]);
  const message = env.message;
  if (message.type !== "response" || !message.ok) throw new Error("not a success response");
  expect(parseResult(method, message.result)).toEqual({ ok: true, value: result, warnings: [] });
}

/** Runs both stages and returns the `parseResult` outcome. */
function twoStage(method: MethodName, text: string) {
  const env = parseServerMessage(text);
  if (env.ok !== true) throw new Error(`envelope failed: ${JSON.stringify(env)}`);
  const message = env.message;
  if (message.type !== "response" || !message.ok) throw new Error("not a success response");
  return { envelope: env, result: parseResult(method, message.result) };
}

function expectClientError(text: string, code = "bad_request"): void {
  const parsed = parseClientMessage(text);
  expect(parsed.ok).toBe(false);
  if (parsed.ok) return;
  expect(parsed.error.code).toBe(code);
  expect(typeof parsed.error.message).toBe("string");
}

function expectProtocolResultError(method: MethodName, result: unknown): void {
  const parsed = parseResult(method, result);
  expect(parsed.ok).toBe(false);
  if (parsed.ok) return;
  expect(parsed.error.code).toBe("internal");
  expect(parsed.error.details).toEqual({ type: "protocol", method });
}

// ---------------------------------------------------------------------------
// Examples

const num = (value: number) => ({ type: "number", value }) as const;
const text = (value: string) => ({ type: "text", value }) as const;
const ref = (object: string) => ({ type: "ref", object }) as const;
const REDACTED = { type: "redacted" } as const;

const goblinView: ObjectView = {
  id: "goblin1",
  is_template: false,
  is_character: false,
  cells: {
    name: { value: text("Goblin"), kind: "literal" },
    hp: {
      value: num(7),
      kind: "formula",
      source: "max_hp - damage",
      overridden: false,
      visibility: { type: "viewers", viewers: ["gm", ref("aldric")] },
    },
    board: { value: ref("map"), kind: "structural" },
    alive: { value: { type: "boolean", value: true }, kind: "literal" },
    notes: { value: { type: "empty" }, kind: "literal" },
    attack: { value: { type: "dice", expr: "1d20+4" }, kind: "literal" },
    last_roll: {
      value: { type: "roll", expr: "1d20+4", dice: [17], dropped: [], total: 21 },
      kind: "formula",
      source: "roll(attack)",
      overridden: true,
    },
    sketch: {
      value: {
        type: "ink",
        strokes: [
          [
            [0, 0],
            [1, 1],
          ],
        ],
      },
      kind: "literal",
    },
    shape: {
      value: { type: "shape", shape: { type: "circle", radius: 0.5 } },
      kind: "structural",
    },
    broken: {
      value: {
        type: "error",
        code: "#REF",
        message: "gone",
        origin: { object: "goblin1", cell: "x" },
      },
      kind: "formula",
      source: "x.y",
      overridden: false,
    },
    allies: { value: { type: "list", items: [ref("goblin2"), text("x")] }, kind: "literal" },
  },
  actions: [{ name: "attack", when: "hp > 0", steps: ["set damage = 1"] }],
};

/** A character view: nested redaction in lists of lists and in viewers entries. */
const handView: ObjectView = {
  id: "hand",
  is_template: false,
  is_character: false,
  cells: {
    contents: {
      value: {
        type: "list",
        items: [{ type: "list", items: [REDACTED, ref("card1")] }, REDACTED],
      },
      kind: "structural",
    },
    visible_to: {
      value: { type: "viewers", viewers: ["owner", REDACTED] },
      kind: "literal",
    },
    total: { value: { type: "error", code: "#TYPE" }, kind: "formula", overridden: false },
  },
  actions: [{ name: "draw" }],
};

const covers: Cover[] = [
  {
    key: "c1",
    board: "map",
    region: { position: [3, 4], rotation: 0, shape: { type: "rect", width: 2, height: 3 } },
  },
  { key: "c2", board: "map", region: { whole_board: true } },
];

const snapshotView: ObjectSnapshotView = {
  id: "goblin2",
  is_template: false,
  is_zone: false,
  is_character: false,
  tag: ["monster"],
  shape: {
    type: "polygon",
    points: [
      [0, 0],
      [1, 0],
      [0, 1],
    ],
  },
  contents: ["dagger", null],
  cells: {
    name: { kind: "literal", value: text("Goblin 2") },
    hp: { kind: "formula", source: "max_hp", override: num(3) },
    secret: { kind: "formula" },
  },
  cell_visibility: { hp: { type: "viewers", viewers: ["gm"] } },
  actions: [{ name: "flee", steps: ["move this to cave"] }],
};

const allEffects: EffectView[] = [
  {
    type: "cell",
    object: "goblin1",
    cell: "hp",
    before: null,
    after: { kind: "literal", value: num(7) },
    cause: "edit",
  },
  {
    type: "cell",
    object: "goblin1",
    cell: "last_roll",
    before: { kind: "formula", source: "roll(attack)" },
    after: {
      kind: "formula",
      source: "roll(attack)",
      override: { type: "roll", expr: "1d20", dice: [4], dropped: [], total: 4 },
    },
    cause: "roll",
  },
  {
    type: "cell_visibility",
    object: "goblin1",
    cell: "hp",
    before: null,
    after: { type: "viewers", viewers: ["gm"] },
  },
  { type: "field", object: "goblin1", field: "tag", before: [], after: ["monster"] },
  {
    type: "field",
    object: "goblin1",
    field: "shape",
    before: null,
    after: { type: "rect", width: 1, height: 1 },
  },
  { type: "field", object: "goblin1", field: "is_template", before: false, after: true },
  { type: "field", object: "goblin1", field: "is_character", before: true, after: false },
  {
    type: "field",
    object: "goblin1",
    field: "actions",
    before: [],
    after: [{ name: "attack", when: "hp > 0", steps: ["set damage = 1"] }],
  },
  {
    type: "place",
    object: "goblin1",
    before: { type: "board", board: "map" },
    after: { type: "container", container: "cave", index: 0 },
  },
  { type: "create", location: { type: "board", board: "map" }, objects: [snapshotView] },
  {
    type: "remove",
    location: { type: "container", container: null, index: 2 },
    objects: [snapshotView],
  },
  { type: "reorder", container: "deck", before: ["a", "b", null], after: [null, "b", "a"] },
  { type: "board", before: null, after: { id: "cave_board", name: "Cave" } },
  { type: "allocate", ids: ["goblin3"], seq_before: 3, seq_after: 4 },
  { type: "retire", ids: ["goblin0"] },
];

const gmGroup: GroupView = {
  index: 12,
  revision: 13,
  actor: { type: "gm" },
  kind: "edit",
  label: "15 edits",
  base_revision: 12,
  undone: false,
  names: { goblin1: "Goblin" },
  effects: allEffects,
};

const actionGroup: GroupView = {
  index: 13,
  revision: 14,
  actor: { type: "character", id: "aldric" },
  kind: "action",
  label: "attack",
  base_revision: 13,
  origin: { object: "goblin1", action: "attack" },
  undone: true,
  names: {},
};

const undoGroup: GroupView = {
  index: 14,
  revision: 15,
  actor: { type: "agent", name: "claude" },
  kind: "undo",
  label: "undo attack",
  base_revision: 14,
  undoes: 13,
  undone: false,
  names: {},
  effects: [],
};

/** A character group view: label null, redacted refs, a create snapshot. */
const characterGroup: GroupView = {
  index: 15,
  revision: 16,
  actor: { type: "gm" },
  kind: "edit",
  label: null,
  base_revision: 15,
  undone: false,
  names: { hand: "Hand" },
  effects: [
    {
      type: "create",
      location: { type: "container", container: null, index: 0 },
      objects: [
        {
          id: "card1",
          is_template: false,
          is_zone: false,
          is_character: false,
          contents: [null],
          cells: { name: { kind: "literal", value: text("Ace") } },
          actions: [{ name: "play" }],
        },
      ],
    },
    {
      type: "cell",
      object: "hand",
      cell: "held",
      before: { kind: "literal", value: { type: "list", items: [REDACTED] } },
      after: {
        kind: "literal",
        value: { type: "list", items: [{ type: "list", items: [REDACTED, ref("card1")] }] },
      },
      cause: "edit",
    },
  ],
};

const welcome: Welcome = {
  type: "welcome",
  protocol: 1,
  session: "s-1",
  actor: { type: "gm" },
  revision: 16,
  boards: [{ id: "map", name: "Map" }, { id: "gm_board" }],
  table: {
    name: "game.json",
    path: "/tables/game.json",
    id: "2c1f6a6e-1d1b-4d55-8d55-8b7b9c3c1a10",
  },
  limits: { ...LIMITS },
};

const hello: Hello = {
  type: "hello",
  protocol: 1,
  token: "tok",
  client: { name: "Claude", kind: "agent", instance: "a1_b-2" },
  agent_name: "claude",
};

const allOps: WireOp[] = [
  { type: "set_value", object: "goblin1", cell: "hp", value: num(7) },
  { type: "set_formula", object: "$card", cell: "hp", source: "max_hp - damage" },
  { type: "clear_override", object: "goblin1", cell: "hp" },
  { type: "delete_cell", object: "goblin1", cell: "notes" },
  { type: "rename_cell", object: "goblin1", from: "hp", to: "health" },
  {
    type: "set_cell_visibility",
    object: "goblin1",
    cell: "hp",
    viewers: { type: "viewers", viewers: ["gm", "owner", ref("$card")] },
  },
  { type: "set_cell_visibility", object: "goblin1", cell: "hp", viewers: null },
  { type: "set_tag", object: "goblin1", tags: ["monster", "small"] },
  { type: "set_shape", object: "goblin1", shape: { type: "circle", radius: 0.5 } },
  { type: "set_shape", object: "goblin1", shape: null },
  { type: "set_template_flag", object: "goblin1", value: true },
  { type: "set_character_flag", object: "aldric", value: true },
  {
    type: "set_actions",
    object: "goblin1",
    actions: [
      { name: "attack", when: "hp > 0", steps: ["set damage = 1"] },
      { name: "x", steps: [] },
    ],
  },
  { type: "reorder", container: "deck", permutation: [2, 0, 1] },
  { type: "add_board", id: "cave", name: "Cave" },
  { type: "add_board", id: "cave2" },
  { type: "rename_board", id: "cave", name: "The Cave" },
  { type: "remove_board", id: "cave2" },
  {
    type: "create_object",
    id: "fb_aldric",
    as: "$card",
    to: { type: "board", board: "map", position: [1, 2] },
    init: {
      is_template: false,
      is_zone: false,
      is_character: false,
      tag: ["spell"],
      shape: { type: "rect", width: 2, height: 3 },
      cells: {
        name: text("Fireball"),
        damage: { type: "formula", source: "roll(8d6)" },
        dice: { type: "dice", expr: "8d6" },
        roll: { type: "roll", expr: "1d6", dice: [3], dropped: [], total: 3 },
        ink: { type: "ink", strokes: [[[0, 0]]] },
        outline: {
          type: "shape",
          shape: {
            type: "polygon",
            points: [
              [0, 0],
              [1, 0],
              [0, 1],
            ],
          },
        },
        flag: { type: "boolean", value: false },
        blank: { type: "empty" },
        links: { type: "list", items: [ref("$card"), { type: "list", items: [ref("goblin1")] }] },
        seen_by: { type: "viewers", viewers: ["all"] },
      },
      cell_visibility: { damage: { type: "viewers", viewers: ["gm", ref("$card")] } },
      actions: [{ name: "cast", steps: ["set damage = roll(8d6)"] }],
    },
  },
  { type: "create_object", as: "$zone", to: { type: "container", container: "$card" } },
  { type: "create_object", to: { type: "container", container: "deck", index: 0 } },
  {
    type: "spawn",
    template: "goblin_tpl",
    to: { type: "board", board: "map", position: [5, 5] },
    cells: { hp: num(4), name: { type: "formula", source: '"Goblin " & id' } },
    as: "$g",
    owned: { goblin_tpl_dagger: "$dagger" },
  },
  { type: "spawn", template: "goblin_tpl", to: { type: "container", container: "$g", index: 1 } },
  { type: "move", object: "goblin1", to: { type: "container", container: "cave", index: 3 } },
  { type: "remove", object: "goblin1" },
];

const OP_KINDS = new Set(allOps.map((op) => op.type));

/** Every method's params, keyed by method. */
const paramsExamples: Record<MethodName, unknown[]> = {
  transact: [
    {
      base_revision: 16,
      ops: allOps,
      label: "set up",
      txn_id: "t-1",
      retry: true,
      actor: { type: "character", id: "aldric" },
    },
    { base_revision: 0, ops: [{ type: "remove", object: "x" }] },
  ],
  undo: [
    { target: { type: "latest" } },
    { target: { type: "mine" }, expect_index: 3, label: "oops" },
    { target: { type: "actor", actor: { type: "agent", name: "claude" } } },
    { target: { type: "group", index: 4 } },
  ],
  invoke: [{ object: "goblin1", action: "attack", base_revision: 3 }],
  save: [{}],
  list_objects: [
    {},
    {
      viewer: { type: "character", id: "aldric" },
      filter: {
        board: "map",
        container: "deck",
        tag: "monster",
        name: "Goblin",
        is_template: false,
        is_zone: true,
        is_character: false,
      },
      cells: ["hp", "name"],
      cursor: "goblin1",
      limit: LIMITS.max_page,
    },
    { cells: "all" },
    { cells: "structural" },
  ],
  get_objects: [{ ids: ["goblin1", "hand"], viewer: { type: "gm" }, cells: "all" }],
  evaluate: [{ source: "1 + 2", this: "goblin1" }, { source: "sum(1,2)" }],
  zones: [{ board: "map", viewer: { type: "character", id: "aldric" } }],
  at_position: [{ board: "map", position: [1.5, -2], viewer: { type: "gm" } }],
  changes_since: [{ revision: 3, viewer: { type: "gm" }, limit: 100 }],
  log: [{ before: 10, limit: 50, viewer: { type: "gm" }, effects: true }, {}],
  document: [{}],
  explain_cell: [{ object: "goblin1", cell: "hp", viewer: { type: "gm" }, depth: 4 }],
  explain_group: [{ index: 12, viewer: { type: "character", id: "aldric" } }],
  explain_action: [{ object: "goblin1", action: "attack", viewer: { type: "gm" } }],
  subscribe: [
    { scope: { type: "board", board: "map" }, viewer: { type: "gm" }, cells: "all" },
    { scope: { type: "objects", ids: ["goblin1"], subtree: true }, cells: "structural" },
    { scope: { type: "all" } },
    { scope: { type: "log" }, viewer: { type: "character", id: "aldric" } },
  ],
  unsubscribe: [{ subscription: "sub-1" }],
};

const rejections: ProtocolRejection[] = [
  { type: "protected_cell", object: "goblin1", cell: "id" },
  { type: "containment_cycle", object: "bag", container: "bag" },
  { type: "undo_conflict", target: 3, conflicting: [4, 5], message: "later edits" },
  { type: "nothing_to_undo" },
  { type: "type_error", object: "goblin1", cell: "position", expected: "list of two numbers" },
  { type: "invalid", message: "txn_id reused with different params" },
  {
    type: "stale_write",
    base_revision: 5,
    revision: 6,
    floor: 0,
    truncated: false,
    conflicts: [
      { index: 5, revision: 6, actor: { type: "gm" }, label: "hp", keys: ["cell:goblin1/hp"] },
    ],
  },
  { type: "stale_write", base_revision: 1, revision: 9, floor: 4, truncated: true, conflicts: [] },
  { type: "undo_target_changed", expected: 4, actual: null },
  { type: "undo_target_changed", expected: 4, actual: 5 },
];

/** Every method's results. */
const resultExamples: Record<MethodName, unknown[]> = {
  transact: [
    {
      status: "committed",
      revision: 17,
      index: 16,
      created: [{ op_index: 18, id: "fb_aldric" }],
      copies: [{ op_index: 21, root: "goblin7", copies: { goblin_tpl: "goblin7" } }],
      bindings: { $card: "fb_aldric", $g: "goblin7" },
    },
    ...rejections.map((rejection) => ({ status: "rejected", rejection })),
    { status: "rejected", rejection: rejections[0], op_index: 2 },
  ],
  undo: [
    { status: "committed", revision: 18, index: 17, created: [], copies: [], bindings: {} },
    { status: "rejected", rejection: { type: "nothing_to_undo" } },
  ],
  invoke: [
    { status: "committed", revision: 18, index: 17, created: ["fb_aldric", "goblin7"] },
    { status: "committed", revision: 18, index: 17, created: [] },
    { status: "rejected", rejection: { type: "when_false", object: "goblin1", action: "attack" } },
    {
      status: "rejected",
      rejection: {
        type: "when_error",
        object: "goblin1",
        action: "attack",
        code: "#REF",
        message: "no cell ac",
      },
    },
    {
      status: "rejected",
      rejection: {
        type: "step_error",
        object: "goblin1",
        action: "attack",
        step: 1,
        code: "#SYNTAX",
        message: "unparsable step",
      },
    },
    {
      status: "rejected",
      rejection: { type: "protected_cell", object: "goblin1", cell: "id" },
      step: 0,
    },
    { status: "rejected", rejection: { type: "invalid", message: "no action attack" } },
    { status: "rejected", rejection: rejections[6] },
  ],
  save: [
    { status: "saved", revision: 17 },
    { status: "saved_not_durable", revision: 17, message: "fsync failed" },
    { status: "failed", revision: 17, message: "disk full" },
  ],
  list_objects: [
    { revision: 17, objects: [goblinView], next_cursor: "goblin1" },
    { revision: 17, objects: [], next_cursor: null },
  ],
  get_objects: [{ revision: 17, objects: [goblinView, handView], missing: ["ghost"] }],
  evaluate: [
    { revision: 17, value: num(3) },
    { revision: 17, value: { type: "error", code: "#DIV0" } },
  ],
  zones: [
    {
      revision: 17,
      zones: [
        { id: "cave", contents: ["goblin1"], view: goblinView },
        { id: "pit", contents: [], error: "#CYCLE", view: handView },
      ],
    },
  ],
  at_position: [{ revision: 17, objects: ["goblin1"], zones: ["cave"] }],
  changes_since: [
    {
      revision: 17,
      floor: 0,
      groups: [gmGroup, actionGroup, undoGroup, characterGroup],
      truncated: false,
      more: true,
      next_revision: 16,
    },
  ],
  log: [{ first_index: 0, next_index: 16, undo_barrier: 0, groups: [undoGroup, actionGroup] }],
  document: [
    {
      snapshot: {
        revision: 1,
        next_seq: 1,
        boards: [{ id: "gm_board", name: "GM" }],
        objects: {},
        retired_ids: [],
      },
      log: {
        first_index: 0,
        groups: [
          {
            index: 0,
            base_revision: 0,
            revision: 1,
            actor: { type: "gm" },
            kind: "edit",
            label: "add_board gm_board",
            names: {},
            effects: [{ type: "board", before: null, after: { id: "gm_board", name: "GM" } }],
          },
        ],
        undo_barrier: 0,
      },
    },
  ],
  explain_cell: [
    {
      revision: 17,
      object: "goblin1",
      cell: "hp",
      view: { value: num(7), kind: "formula", source: "max_hp - damage", overridden: false },
      content: { type: "formula", source: "max_hp - damage", overridden: false, parses: true },
      dependencies: [
        {
          type: "cell",
          object: "goblin1",
          cell: "max_hp",
          value: num(10),
          dependencies: [{ type: "index" }],
        },
        { type: "cell", object: "goblin1", cell: "secret", hidden: true },
        { type: "cell", object: null, cell: "damage" },
        { type: "exists", object: "goblin9", exists: false },
        { type: "exists", object: null },
      ],
      truncated: false,
      error_chain: [{ object: null, cell: null, code: "#REF" }],
      last_write: {
        index: 12,
        revision: 13,
        actor: { type: "gm" },
        kind: "edit",
        label: null,
        cause: "roll",
      },
    },
    {
      revision: 17,
      object: "goblin1",
      cell: "name",
      view: { value: text("Goblin"), kind: "literal" },
      content: { type: "literal" },
      dependencies: [],
      truncated: true,
    },
    {
      revision: 17,
      object: "goblin1",
      cell: "board",
      view: { value: ref("map"), kind: "structural" },
      content: { type: "structural" },
      dependencies: [],
      truncated: false,
    },
    {
      revision: 17,
      object: "goblin1",
      cell: "bad",
      view: { value: { type: "error", code: "#SYNTAX" }, kind: "formula" },
      content: { type: "formula", overridden: false, parses: false, syntax_error: "unexpected )" },
      dependencies: [],
      truncated: false,
    },
  ],
  explain_group: [
    {
      group: actionGroup,
      action: {
        object: "goblin1",
        name: "attack",
        when: "hp > 0",
        steps: ["set damage = 1"],
        current: true,
      },
    },
    { group: characterGroup },
  ],
  explain_action: [
    {
      object: "goblin1",
      action: "attack",
      enabled: false,
      reason: "when_false",
      guard: { source: "hp > 0", value: { type: "boolean", value: false } },
      steps: ["set damage = 1"],
    },
    {
      object: "goblin1",
      action: "attack",
      enabled: false,
      reason: "when_error",
      guard: { value: { type: "error", code: "#NAME" } },
    },
    { object: "goblin1", action: "wave", enabled: true },
  ],
  subscribe: [
    { subscription: "sub-1", revision: 17, objects: [goblinView, handView], covers },
    { subscription: "sub-2", revision: 17, objects: [], covers: [], groups: [characterGroup] },
  ],
  unsubscribe: [{}],
};

const commitEvent: CommitEvent = {
  type: "event",
  event: "commit",
  revision: 16,
  group: { index: 15, revision: 16, actor: { type: "gm" }, kind: "edit", label: "deal" },
  boards: [{ id: "map", name: "Map" }],
  deltas: [
    {
      subscription: "sub-1",
      objects: [handView],
      removed: ["card9"],
      covers: { upsert: [covers[0] as Cover], removed: ["c2"] },
    },
    {
      subscription: "sub-2",
      objects: [],
      removed: [],
      groups_upserted: [characterGroup, gmGroup],
      groups_removed: [3],
    },
  ],
};

// ---------------------------------------------------------------------------
// Round trips

describe("client messages round-trip", () => {
  test("hello, with and without agent_name", () => {
    clientRoundTrip(hello);
    clientRoundTrip({
      type: "hello",
      protocol: 1,
      token: "t",
      client: { name: "UI", kind: "ui", instance: "x" },
    });
    clientRoundTrip({
      type: "hello",
      protocol: 1,
      token: "t",
      client: { name: "T", kind: "test", instance: "y" },
    });
  });

  for (const [method, examples] of Object.entries(paramsExamples)) {
    test(`request ${method}`, () => {
      for (const params of examples) clientRoundTrip(request(method, params));
    });
  }

  test("a transact with every one of the 19 op kinds, and retry: true", () => {
    expect(OP_KINDS.size).toBe(19);
    for (const op of allOps) clientRoundTrip(request("transact", { base_revision: 1, ops: [op] }));
  });

  test("a transact with exactly max_ops ops", () => {
    const ops = Array.from({ length: LIMITS.max_ops }, () => ({ type: "remove", object: "x" }));
    clientRoundTrip(request("transact", { base_revision: 1, ops }));
  });
});

describe("server messages round-trip", () => {
  test("welcome with table.id, and an in-memory welcome", () => {
    serverRoundTrip(welcome);
    serverRoundTrip({
      ...welcome,
      actor: { type: "agent", name: "claude" },
      table: { name: "mem", path: null, id: null },
    });
  });

  test("goodbye", () => {
    serverRoundTrip({ type: "goodbye", reason: "shutdown" });
  });

  test("commit event with every EffectView variant, covers and a log delta", () => {
    serverRoundTrip(commitEvent);
    serverRoundTrip({ ...commitEvent, deltas: [] });
    const { boards: _boards, ...noBoards } = commitEvent;
    serverRoundTrip(noBoards);
  });

  test("save events", () => {
    serverRoundTrip({ type: "event", event: "save", status: "saved", revision: 3 });
    serverRoundTrip({
      type: "event",
      event: "save",
      status: "saved_not_durable",
      revision: 3,
      message: "m",
    });
    serverRoundTrip({ type: "event", event: "save", status: "failed", revision: 3, message: "m" });
  });

  for (const [method, examples] of Object.entries(resultExamples)) {
    test(`result of ${method}`, () => {
      for (const result of examples) resultRoundTrip(method as MethodName, result);
    });
  }

  test("every ProtocolRejection, as a transact result", () => {
    const seen = new Set(rejections.map((r) => r.type));
    expect(seen.size).toBe(8);
  });

  test("every one of the 14 error codes, as an error response", () => {
    expect(PROTOCOL_ERROR_CODES).toHaveLength(14);
    expect(PROTOCOL_ERROR_CODES).toContain("wrong_table");
    expect(PROTOCOL_ERROR_CODES).toContain("retry_unknown");
    for (const code of PROTOCOL_ERROR_CODES) {
      serverRoundTrip({ type: "response", id: "r1", ok: false, error: { code, message: code } });
    }
    serverRoundTrip({
      type: "response",
      id: null,
      ok: false,
      error: { code: "bad_request", message: "unreadable", details: { at: ["id"] } },
    });
  });

  test("invoke: a request, and an error response for a refused request", () => {
    clientRoundTrip(request("invoke", { object: "goblin1", action: "attack", base_revision: 1 }));
    serverRoundTrip({
      type: "response",
      id: "r1",
      ok: false,
      error: { code: "bad_request", message: "an agent may not pass actor" },
    });
  });

  test("every EffectView variant is exercised", () => {
    const variants = new Set(
      allEffects.map((e) => (e.type === "field" ? `field:${e.field}` : e.type)),
    );
    expect([...variants].sort()).toEqual(
      [
        "allocate",
        "board",
        "cell",
        "cell_visibility",
        "create",
        "field:actions",
        "field:is_character",
        "field:is_template",
        "field:shape",
        "field:tag",
        "place",
        "remove",
        "reorder",
        "retire",
      ].sort(),
    );
  });
});

describe("nested redaction through the real parsers", () => {
  test("a get_objects response with a list of lists containing redacted", () => {
    resultRoundTrip("get_objects", { revision: 1, objects: [handView], missing: [] });
  });

  test("a viewers value with a redacted entry, in a view and in an effect", () => {
    resultRoundTrip("list_objects", { revision: 1, objects: [handView], next_cursor: null });
    const group: GroupView = {
      ...characterGroup,
      effects: [
        {
          type: "cell",
          object: "hand",
          cell: "visible_to",
          before: null,
          after: { kind: "literal", value: { type: "viewers", viewers: [REDACTED, "gm"] } },
          cause: "edit",
        },
      ],
    };
    resultRoundTrip("explain_group", { group });
  });

  test("a commit event whose group view has a create snapshot and a redacted cell effect", () => {
    serverRoundTrip({
      ...commitEvent,
      deltas: [{ subscription: "s", objects: [], removed: [], groups_upserted: [characterGroup] }],
    });
  });
});

// ---------------------------------------------------------------------------
// Strict client parsing

describe("parseClientMessage is strict", () => {
  test("rejects an unknown key at the message level", () => {
    expectClientError(JSON.stringify({ ...hello, extra: 1 }));
    expectClientError(JSON.stringify({ ...request("save", {}), extra: 1 }));
  });

  test("rejects an unknown key at the params level", () => {
    expectClientError(JSON.stringify(request("get_objects", { ids: ["a"], extra: 1 })));
  });

  test("rejects an unknown key at the op level", () => {
    const op = { type: "remove", object: "x", extra: 1 };
    expectClientError(JSON.stringify(request("transact", { base_revision: 0, ops: [op] })));
  });

  test("rejects an unknown key at the input-value level", () => {
    const op = { type: "set_value", object: "x", cell: "hp", value: { ...num(1), extra: 1 } };
    expectClientError(JSON.stringify(request("transact", { base_revision: 0, ops: [op] })));
  });

  test("rejects a __proto__ key in cells", () => {
    const textMsg = `{"type":"request","id":"r1","method":"transact","params":{"base_revision":0,"ops":[{"type":"create_object","to":{"type":"board","board":"map","position":[0,0]},"init":{"cells":{"__proto__":{"type":"number","value":1}}}}]}}`;
    expectClientError(textMsg);
  });

  test("rejects a request with an unknown method, reporting the id", () => {
    const parsed = parseClientMessage(JSON.stringify(request("frobnicate", {}, "r7")));
    expect(parsed).toMatchObject({ ok: false, error: { code: "unknown_method" }, id: "r7" });
  });

  test("reports a null id when the request id cannot be read", () => {
    const parsed = parseClientMessage(JSON.stringify({ type: "request", method: "save" }));
    expect(parsed).toMatchObject({ ok: false, error: { code: "bad_request" }, id: null });
    const good = parseClientMessage(JSON.stringify(request("save", { x: 1 }, "r8")));
    expect(good).toMatchObject({ ok: false, error: { code: "bad_request" }, id: "r8" });
  });

  test("rejects redacted and error values inside an op value", () => {
    for (const value of [
      REDACTED,
      { type: "list", items: [REDACTED] },
      { type: "viewers", viewers: [REDACTED] },
      { type: "error", code: "#REF" },
    ]) {
      const op = { type: "set_value", object: "x", cell: "hp", value };
      expectClientError(JSON.stringify(request("transact", { base_revision: 0, ops: [op] })));
    }
  });

  test("rejects a transact with zero ops and with max_ops + 1 ops", () => {
    expectClientError(JSON.stringify(request("transact", { base_revision: 0, ops: [] })));
    const ops = Array.from({ length: LIMITS.max_ops + 1 }, () => ({ type: "remove", object: "x" }));
    expectClientError(JSON.stringify(request("transact", { base_revision: 0, ops })));
  });

  test("rejects retry without txn_id", () => {
    const ops = [{ type: "remove", object: "x" }];
    expectClientError(JSON.stringify(request("transact", { base_revision: 0, ops, retry: true })));
  });

  test("rejects an undo label over 200 characters and accepts one of 200", () => {
    const target = { type: "latest" };
    expectClientError(JSON.stringify(request("undo", { target, label: "x".repeat(201) })));
    expect(UndoParamsSchema.safeParse({ target, label: "x".repeat(201) }).success).toBe(false);
    expect(UndoParamsSchema.safeParse({ target, label: "x".repeat(200) }).success).toBe(true);
  });

  test("rejects a list_objects with limit above max_page", () => {
    expectClientError(JSON.stringify(request("list_objects", { limit: LIMITS.max_page + 1 })));
  });

  test("rejects a hello without client.instance", () => {
    expectClientError(JSON.stringify({ ...hello, client: { name: "Claude", kind: "agent" } }));
  });

  test("reports protocol_version for a hello with another protocol", () => {
    expectClientError(JSON.stringify({ ...hello, protocol: 2 }), "protocol_version");
  });

  test("returns an error, not a throw, for invalid JSON and non-objects", () => {
    expectClientError("{not json");
    expectClientError("42");
    expectClientError("null");
    expectClientError(JSON.stringify({ type: "welcome" }));
  });
});

// ---------------------------------------------------------------------------
// Forward-compatible server parsing

describe("parseServerMessage is forward-compatible", () => {
  test("strips an unknown key at the envelope level", () => {
    const parsed = parseServerMessage(JSON.stringify({ ...welcome, future: 1 }));
    expect(parsed).toEqual({ ok: true, message: welcome, warnings: [] });
  });

  test("strips unknown keys at message, event, view, effect and value levels of events", () => {
    const viewWithExtras = {
      ...handView,
      future_view: 1,
      cells: {
        ...handView.cells,
        visible_to: {
          value: { type: "viewers", viewers: ["owner", { ...REDACTED, future_value: 1 }] },
          kind: "literal",
          future_cell: 1,
        },
      },
    };
    const groupWithExtras = {
      ...characterGroup,
      future_group: 1,
      effects: (characterGroup.effects ?? []).map((e) => ({ ...e, future_effect: 1 })),
    };
    const event = {
      ...commitEvent,
      future_event: 1,
      group: { ...commitEvent.group, future_header: 1 },
      deltas: [
        {
          subscription: "sub-1",
          objects: [viewWithExtras],
          removed: [],
          future_delta: 1,
          groups_upserted: [groupWithExtras],
        },
      ],
    };
    const parsed = parseServerMessage(JSON.stringify(event));
    expect(parsed).toEqual({
      ok: true,
      message: {
        ...commitEvent,
        deltas: [
          {
            subscription: "sub-1",
            objects: [handView],
            removed: [],
            groups_upserted: [characterGroup],
          },
        ],
      },
      warnings: [],
    });
    expect(JSON.stringify(parsed)).not.toContain("future_");
  });

  test("leaves a response's result untouched", () => {
    const result = { revision: 1, objects: [{ ...goblinView, future: 1 }], missing: [], extra: 2 };
    const parsed = parseServerMessage(JSON.stringify({ ...response(result), future: 1 }));
    expect(parsed).toEqual({ ok: true, message: response(result), warnings: [] });
  });

  test("the two-stage pipeline strips unknown keys in envelope, views and effects", () => {
    const getText = JSON.stringify({
      ...response({
        revision: 1,
        objects: [{ ...goblinView, future: 1 }],
        missing: [],
        extra: 2,
      }),
      future: 1,
    });
    const get = twoStage("get_objects", getText);
    expect(get.envelope.message).toEqual(
      response({ revision: 1, objects: [{ ...goblinView, future: 1 }], missing: [], extra: 2 }),
    );
    expect(get.result).toEqual({
      ok: true,
      value: { revision: 1, objects: [goblinView], missing: [] },
      warnings: [],
    });

    const changes = {
      revision: 17,
      floor: 0,
      groups: [{ ...gmGroup, effects: allEffects.map((e) => ({ ...e, future: 1 })) }],
      truncated: false,
      more: false,
      next_revision: 13,
    };
    const ch = twoStage("changes_since", JSON.stringify({ ...response(changes), future: 1 }));
    expect(ch.result).toEqual({
      ok: true,
      value: { ...changes, groups: [gmGroup] },
      warnings: [],
    });
  });

  test("an unknown EffectView variant in a result is dropped and reported by parseResult", () => {
    const changes = {
      revision: 17,
      floor: 0,
      groups: [
        {
          ...undoGroup,
          effects: [
            { type: "teleport", object: "goblin1" },
            { type: "field", object: "goblin1", field: "colour", before: 1, after: 2 },
            allEffects[0],
          ],
        },
      ],
      truncated: false,
      more: false,
      next_revision: 15,
    };
    const { envelope, result } = twoStage("changes_since", JSON.stringify(response(changes)));
    expect(envelope.warnings).toEqual([]);
    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    expect(result.value).toEqual({
      ...changes,
      groups: [{ ...undoGroup, effects: [allEffects[0]] }],
    });
    expect(result.warnings).toHaveLength(2);
  });

  test("returns ignored for an unknown message type and an unknown event kind", () => {
    const t = parseServerMessage(JSON.stringify({ type: "telemetry", x: 1 }));
    expect(t.ok).toBe("ignored");
    const e = parseServerMessage(JSON.stringify({ type: "event", event: "chat", text: "hi" }));
    expect(e.ok).toBe("ignored");
    if (e.ok === "ignored") expect(typeof e.reason).toBe("string");
  });

  test("drops an unknown EffectView variant in an event with a warning", () => {
    const event = {
      ...commitEvent,
      deltas: [
        {
          subscription: "s",
          objects: [],
          removed: [],
          groups_upserted: [{ ...undoGroup, effects: [{ type: "teleport" }, allEffects[1]] }],
        },
      ],
    };
    const parsed = parseServerMessage(JSON.stringify(event));
    expect(parsed.ok).toBe(true);
    if (parsed.ok !== true) return;
    expect(parsed.message).toEqual({
      ...commitEvent,
      deltas: [
        {
          subscription: "s",
          objects: [],
          removed: [],
          groups_upserted: [{ ...undoGroup, effects: [allEffects[1]] }],
        },
      ],
    });
    expect(parsed.warnings).toHaveLength(1);
  });

  test("returns an error for a known envelope with a missing required field", () => {
    const { session: _s, ...noSession } = welcome;
    for (const msg of [
      noSession,
      { type: "goodbye" },
      { type: "response", ok: true, result: {} },
      { type: "response", id: "r1", ok: true },
      { type: "response", id: "r1", ok: false },
      { type: "event", event: "commit", revision: 1, deltas: [] },
      { type: "event", event: "save", revision: 1 },
    ]) {
      const parsed = parseServerMessage(JSON.stringify(msg));
      expect(parsed.ok, JSON.stringify(msg)).toBe(false);
      if (parsed.ok === false) expect(parsed.error.code).toBe("internal");
    }
  });

  test("returns an error, not a throw, for invalid JSON, non-objects and __proto__", () => {
    expect(parseServerMessage("{nope").ok).toBe(false);
    expect(parseServerMessage("[]").ok).toBe(false);
    expect(parseServerMessage('{"type":"goodbye","reason":"x","__proto__":{"a":1}}').ok).toBe(
      false,
    );
  });

  test("rejects an unknown error code in an error response", () => {
    const parsed = parseServerMessage(
      JSON.stringify({
        type: "response",
        id: "r",
        ok: false,
        error: { code: "nope", message: "" },
      }),
    );
    expect(parsed.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseResult

describe("parseResult", () => {
  test("rejects a malformed result", () => {
    expectProtocolResultError("get_objects", { revision: 1, objects: [] });
  });

  test("rejects a result valid for a different method", () => {
    expectProtocolResultError("get_objects", {});
    expectProtocolResultError("list_objects", resultExamples.subscribe[0]);
  });

  test("accepts {} as the result of unsubscribe", () => {
    expect(parseResult("unsubscribe", {})).toEqual({ ok: true, value: {}, warnings: [] });
  });

  test("rejects a $name ref inside a view's value", () => {
    const view = { ...goblinView, cells: { link: { value: ref("$card"), kind: "literal" } } };
    expectProtocolResultError("get_objects", { revision: 1, objects: [view], missing: [] });
  });

  test("rejects a __proto__ key in a view's cells", () => {
    const parsed = JSON.parse(
      `{"revision":1,"objects":[{"id":"a","is_template":false,"is_character":false,"cells":{"__proto__":{"value":{"type":"empty"},"kind":"literal"}},"actions":[]}],"missing":[]}`,
    );
    expectProtocolResultError("get_objects", parsed);
  });

  test("rejects an unknown method without throwing", () => {
    const parsed = parseResult("frobnicate" as MethodName, {});
    expect(parsed.ok).toBe(false);
  });

  test("never throws, even for undefined", () => {
    expect(() => parseResult("get_objects", undefined)).not.toThrow();
    expectProtocolResultError("get_objects", undefined);
  });
});

describe("ProtocolFailure", () => {
  test("carries a ProtocolError", () => {
    const f = new ProtocolFailure("not_found", "not found");
    expect(f).toBeInstanceOf(Error);
    expect(f.error).toEqual({ code: "not_found", message: "not found" });
    expect(f.message).toBe("not found");
    const g = new ProtocolFailure("bad_request", "bad", { at: "ops" });
    expect(g.error).toEqual({ code: "bad_request", message: "bad", details: { at: "ops" } });
  });
});

// ---------------------------------------------------------------------------
// Review regressions: the schemas themselves reject `__proto__`; ids are real ids

describe("exported schemas reject __proto__ directly", () => {
  const protoCellsOp = JSON.parse(
    `{"type":"create_object","to":{"type":"board","board":"map","position":[0,0]},"init":{"cells":{"__proto__":{"type":"number","value":1}}}}`,
  );
  const protoOwnedOp = JSON.parse(
    `{"type":"spawn","template":"t","to":{"type":"board","board":"map","position":[0,0]},"owned":{"__proto__":"$x"}}`,
  );

  test("an op", () => {
    expect(WireOpSchema.safeParse(protoCellsOp).success).toBe(false);
    expect(WireOpSchema.safeParse(protoOwnedOp).success).toBe(false);
    const good = allOps.find((op) => op.type === "create_object" && op.init?.cells);
    expect(WireOpSchema.parse(good)).toEqual(good);
  });

  test("transact params", () => {
    for (const op of [protoCellsOp, protoOwnedOp]) {
      expect(TransactParamsSchema.safeParse({ base_revision: 0, ops: [op] }).success).toBe(false);
    }
    expect(TransactParamsSchema.parse({ base_revision: 1, ops: allOps })).toEqual({
      base_revision: 1,
      ops: allOps,
    });
  });

  test("a loose view, value and group view", () => {
    const protoCells = JSON.parse(
      `{"id":"a","is_template":false,"is_character":false,"cells":{"__proto__":{"value":{"type":"empty"},"kind":"literal"}},"actions":[]}`,
    );
    expect(ObjectViewSchema.safeParse(protoCells).success).toBe(false);
    const protoTop = JSON.parse(
      `{"id":"a","is_template":false,"is_character":false,"cells":{},"actions":[],"__proto__":{"x":1}}`,
    );
    expect(ObjectViewSchema.safeParse(protoTop).success).toBe(false);
    const protoValue = JSON.parse(`{"type":"list","items":[{"type":"empty","__proto__":{}}]}`);
    expect(WireValueSchema.safeParse(protoValue).success).toBe(false);
    const protoNames = JSON.parse(
      `{"index":1,"revision":2,"actor":{"type":"gm"},"kind":"edit","label":"x","base_revision":1,"undone":false,"names":{"__proto__":"x"}}`,
    );
    expect(GroupViewSchema.safeParse(protoNames).success).toBe(false);
    // Loose schemas still strip ordinary unknown keys.
    expect(ObjectViewSchema.parse({ ...goblinView, future: 1 })).toEqual(goblinView);
  });
});

describe("ids in views and results are real ids, never bindings", () => {
  test("through parseResult", () => {
    expectProtocolResultError("get_objects", {
      revision: 1,
      objects: [{ ...goblinView, id: "$card" }],
      missing: [],
    });
    expectProtocolResultError("get_objects", { revision: 1, objects: [], missing: ["$card"] });
    expectProtocolResultError("at_position", { revision: 1, objects: ["$a"], zones: [] });
    expectProtocolResultError("changes_since", {
      revision: 17,
      floor: 0,
      groups: [{ ...undoGroup, effects: [{ ...allEffects[0], object: "$card" }] }],
      truncated: false,
      more: false,
      next_revision: 15,
    });
    const committed = resultExamples.transact[0] as Record<string, unknown>;
    expectProtocolResultError("transact", { ...committed, bindings: { $card: "$card" } });
    expectProtocolResultError("transact", { ...committed, bindings: { card: "fb_aldric" } });
    expectProtocolResultError("transact", {
      ...committed,
      created: [{ op_index: 0, id: "$card" }],
    });
  });

  test("through a commit event", () => {
    const delta = { subscription: "s", objects: [], removed: [] };
    for (const bad of [
      { ...delta, removed: ["$card"] },
      { ...delta, objects: [{ ...handView, id: "$hand" }] },
      { ...delta, groups_upserted: [{ ...undoGroup, names: { $card: "Card" } }] },
      { ...delta, covers: { upsert: [{ ...covers[1], board: "$map" }], removed: [] } },
    ]) {
      const parsed = parseServerMessage(JSON.stringify({ ...commitEvent, deltas: [bad] }));
      expect(parsed.ok, JSON.stringify(bad)).toBe(false);
    }
  });
});
