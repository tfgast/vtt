# Fixture Scenarios

The acceptance fixtures of [FORMULAS.md §10](FORMULAS.md#10-fixtures), written
so a machine can run them. The formula language (M1) and the document engine
(M2) are tested against these files; reviewers read them. This document owns
the format. The schema is `packages/fixtures/src/schema.ts` (zod); the types in
`src/types.ts` are inferred from it, so the two cannot drift.

The format describes a table, a sequence of things people do to it, and what
must be true after each. It says nothing about how an engine evaluates:
there is no evaluation order, caching, or budget in it. A runner (not part of
this package) executes scenarios against an engine.

## 1. Reading a scenario

One scenario per `.json` file. Production scenarios live in
`packages/fixtures/scenarios/`; `loadScenario(path)` reads and validates one.

```json
{
  "title": "Hit points follow damage until overridden",
  "source": "Hit points",
  "description": "Optional prose.",
  "setup": { "boards": [...], "characters": [...], "objects": [...] },
  "dice": [...],
  "expect": [...],
  "steps": [{ "actor": "gm", "note": "...", "do": {...}, "expect": [...] }]
}
```

- `title` names this scenario; titles are unique across `scenarios/`.
- `source` is the §10 fixture heading exactly as written in FORMULAS.md (the
  list is exported as `FORMULAS_FIXTURES`). Several scenarios may share one
  source.
- `setup` is the table before anything happens (section 3).
- `dice` is the dice script (section 5).
- `expect` holds expectations checked after setup, before any step.
- `steps` run in order. Each has a `do` (section 6) and an `expect` list
  checked after it (section 7).

Every tagged form discriminates on a field named **`type`**, everywhere: values,
formulas, shapes, destinations, steps, expectations, rejection reasons, log
effects, dice script entries. Every object is strict: an unknown key is a
validation error, so a misspelled `"expcet"` fails rather than silently
asserting nothing. `__proto__` is rejected as a key anywhere, including as a
cell name (zod's records would otherwise drop it without a word); names like
`constructor` or `toString` are ordinary. Steps, objects and expectations take an optional `note`, a
free-text comment; transcriptions use it to quote the line of prose that
justifies an expectation.

### Names

Objects and boards have ids: letters, digits, underscores, starting with a
letter (`goblin1`, `fb_zone`). Ids are unique across boards and objects. `gm`,
`all`, and `owner` are reserved and cannot be ids or bindings, which keeps the
viewer encoding unambiguous.

Objects created during a scenario get engine-chosen ids, so scenarios name them
with **bindings**: symbolic names introduced by a `spawn` step (`as`, `owned`)
or a `bind` step. A binding is used exactly like an id from then on, in steps,
expectations, and `ref` values. A name must be introduced before it is used,
and may not be introduced twice.

### Actors and viewers

Two roles, two field names, never mixed:

- **`actor`**, on a step: who performs it. `"gm"` or the id of a character.
- **`viewer`**, on a visibility expectation: who is looking. `"gm"` or the id
  of a character.

Characters are listed in `setup.characters` (DESIGN §4.4: visibility and
ownership are keyed to characters, which are objects on the table; the GM is
a principal, not a character). V1 has one person; an actor other than the GM
stands for "the GM driving this character", which is what the log records as
the invoker.

## 2. Values

A cell holds a literal value or a formula. Every storable value of FORMULAS §2
has one tagged encoding:

| §2 type | Encoding |
|---|---|
| number | `{"type":"number","value":27}` |
| text | `{"type":"text","value":"goblin"}` |
| boolean | `{"type":"boolean","value":true}` |
| empty | `{"type":"empty"}` |
| list | `{"type":"list","items":[<value>, ...]}`; items are tagged values |
| reference | `{"type":"ref","object":"goblin1"}`; an id or a binding |
| dice | `{"type":"dice","expr":"2d6+3"}` |
| roll result | `{"type":"roll","expr":"4d6dl1","dice":[6,4,3],"dropped":[1],"total":13}` |
| viewers | `{"type":"viewers","viewers":["gm", {"type":"ref","object":"aldric"}]}` |
| ink | `{"type":"ink","strokes":[[[0,0],[1,1]], {"points":[[2,2]],"color":"#d32f2f","width":0.08}]}` |

A **formula** is a separate tagged form, never a value:
`{"type":"formula","source":"max_hp - damage_taken"}`. `{"type":"text"}` is
always a literal string, so `"a + b"` as text is just those five characters.

Notes:

- A roll result carries everything §2.2 exposes: `expr` (the dice value
  rolled, in dice notation), `dice` (kept die results in roll order),
  `dropped` (dropped results), and `total`. Die results are integers (Fudge
  dice are -1, 0, 1). The schema does not parse `expr`; whether `total` is
  consistent with it is the engine's business.
- A viewer set is one or more of `"all"`, `"gm"`, `"owner"`, or a reference to
  a character. A single viewer is a one-element set.
- Ink is opaque to formulas (§2); fixtures only need "some ink" versus
  `empty`, so strokes are lists of points, or `{points, color?, width?}`
  with a `#rrggbb` colour and a width over 0 and at most 1 (DESIGN.md
  §4.6, M6-D28).
- **Records** (§2) are not storable, so they have no encoding; they appear
  only inside spawn step source text.
- **Errors are expectations, never values.** There is no error encoding; a
  cell that should hold `#REF` is asserted with a `cell_error` expectation
  (section 7). The codes are `#CYCLE`, `#NAME`, `#TYPE`, `#REF`, `#DIV0`,
  `#LIMIT`, `#SYNTAX`.

## 3. Table setup

```json
"setup": {
  "boards": [{ "id": "table", "name": "Table" }, { "id": "gm_board" }],
  "characters": ["aldric", "goblin1"],
  "objects": [ <object>, ... ]
}
```

Each id in `characters` names a setup object. A runner sets that object's
`is_character` flag, which is what makes it a character (DESIGN §4.1).

An object:

```json
{
  "id": "goblin1",
  "note": "optional",
  "is_template": false,
  "is_zone": false,
  "tag": ["creature", "goblin"],
  "shape": { "type": "circle", "radius": 0.5 },
  "placement": { "board": "table", "position": [3, 4] },
  "contents": ["goblin_die"],
  "cells": {
    "name": { "type": "text", "value": "Goblin" },
    "ac": { "type": "number", "value": 13 },
    "hit": { "type": "formula", "source": "any(on(this).where(tag has \"d20\").total >= ac)" }
  },
  "cell_visibility": { "ac": { "type": "viewers", "viewers": ["gm"] } },
  "actions": [{ "name": "Roll", "when": "value = empty", "steps": ["roll(1d20) -> value"] }]
}
```

**Structural cells (FORMULAS §3.1)** are split by who may write them:

| Cell | In setup |
|---|---|
| `id` | the object's `id` |
| `tag` | the object's `tag` (list of text) |
| `contents` | the object's `contents`: ordered ids, owning |
| `container` | never written; derived from `contents` |
| `board`, `position` | the object's `placement` |
| `shape` | the object's `shape` |
| `is_zone` | the object's `is_zone` (see **Zones** below) |
| `name`, `visible_to`, `owner`, `template`, `face_up`, `opaque`, `rotation`, `z` | ordinary entries in `cells` |

Writing `id`, `tag`, `contents`, `container`, `board`, `position`, `shape`,
or `is_zone` in `cells` is a validation error. The cells that may appear in `cells` are
type-checked when literal: `name` text; `visible_to` viewers; `owner` a
reference or empty; `template` a reference or empty; `face_up` and `opaque`
booleans; `rotation` and `z` numbers or empty. `opaque` is valid only on an
object with `"is_zone": true` (in setup, and in spawn `cells` when the
template is known). All but `template` may instead hold a formula (a room's `visible_to` is one, §10). The format assigns no
defaults: a fixture writes every structural cell whose value it depends on,
and defaults for the rest are the engine's: the Default column of FORMULAS
§3.1.

**Containment.** `contents` is the one owning list, single-parent and acyclic
(DESIGN §4.1). The validator rejects an object listed in two `contents`, a
cycle, and contents naming an unknown object.

**Placement.** Every object is either in exactly one container or placed on a
board, never both and never neither (DESIGN §4.1). `placement` is
`{board, position}`; `position` is the object's anchor `[x, y]` in board
units, or a formula (FORMULAS §3.1: "a token that follows another"):
`{"board":"table","position":{"type":"formula","source":"leader.position"}}`.
`placement` is the only place `position` lives; it is rejected in `cells`.
Destinations and the `placement` expectation always use numeric `[x, y]`; for
a formula position the expectation asserts the evaluated coordinates.
Objects in a container have no placement. There are no stacking or
z-order fields: a stack is an ordered container, and `z` is an ordinary cell
(see the goblin fixture).

**Shape.** A region for a zone, an outline for anything else, relative to the
anchor: `{"type":"rect","width":2,"height":1}` (centred), `{"type":"circle",
"radius":4}` (centred), `{"type":"polygon","points":[[0,0],[2,0],[1,2]]}`
(three or more points; closed freehand is a polygon). Shape lives on the
object rather than in `placement` because a zone held in a card's `contents`
still has its region, and keeps it when dragged onto a board. Fixtures that
depend on footprints (`on`) or regions (`contents(zone)`, `zones_containing`)
give shapes explicitly.

**Zones.** An object is a zone when it has `"is_zone": true` (default false).
`contents(zone)` and `zones_containing(obj)` consider only `is_zone` objects
as zones; shape kind and tags never make an object a zone. An `is_zone` object's `shape` is its
region; anyone else's is its outline. A spawned copy keeps its template's
`is_zone`. The field sets the protected structural cell `is_zone` (FORMULAS
§3.1), so `is_zone` cannot appear in `cells`. A cell named `zone` is an
ordinary user cell, like the Fireball card's reference to its zone.

**References** are `ref` values in ordinary cells (`target`, `owner`,
`zone`). They are non-owning; only `contents` owns. A reference in setup must
name a setup object or board.

**Templates** are objects with `"is_template": true`, placed like anything
else (usually inside a binder). Instances are made by a `spawn` step. A
template's subtree is its `contents`, transitively.

**Per-cell visibility** (DESIGN §4.4) is `cell_visibility`: cell name to a
viewer set. The target is a cell listed in `cells` or any structural cell of
FORMULAS §3.1 (`tag`, `position`, `contents`, ...), even though those are set
through their own fields; `cell_visible` may name the same cells. Object
visibility is the
`visible_to` cell. Effective visibility is composed by the engine and asserted
with expectations; the setup states only what is stored. `cell_visibility`
maps one to one onto the canonical per-object metadata of the same name
(DESIGN §4.4): the same cell names, including absent and field-backed cells,
and the same literal viewer sets.

**Actions** (FORMULAS §8) are `{name, when?, steps}`. `when` and each step are
source text in the action language, exactly as the GM would type them. Names
are unique per object. Spawned copies carry their template's actions.

**Face** (M5). An object may carry an optional `face`: a face layout in the
encoding of DESIGN §4.6 (`{elements, collapsed?, default_action?}`; value,
editor, button and contents elements with `rect`, optional `show_when` and
`min_size`; a contents element also takes optional `entries` and the
optional boolean `when_selected`, M6-D12). It maps one to one onto the
object's `face` field and is copied verbatim on spawn, as actions are.
`show_when` is source text like `when`. An object without `face` has no
layout.

## 4. Formula source and step source

Source text (formulas, `when`, action steps) is opaque to this package. The
validator checks it is a non-empty string and nothing more; parsing belongs to
M1. A formula that fails to parse is an engine-side failure: the cell
evaluates to `#SYNTAX` (FORMULAS §2.3), which a scenario asserts as a
`cell_error`.

## 5. The dice script

```json
"dice": [
  { "type": "roll", "expr": "1d20", "dice": [14], "dropped": [], "total": 14 },
  { "type": "roll", "expr": "8d6", "dice": [3, 5, 2, 6, 4, 1, 5, 1], "dropped": [], "total": 27 },
  { "type": "permutation", "order": [2, 0, 1] }
]
```

The script is the randomness the scenario's actions will consume, in order:

- Each `roll(...)` step that runs takes the next entry, which must be a roll
  result whose `expr` equals the dice value being rolled (by normalized
  expression, FORMULAS §4). The roll result is written as given.
- Each `shuffle(...)` takes the next entry, which must be a permutation of the
  container's length. The new contents are `new[i] = old[order[i]]`: with
  contents `[a, b, c]` and order `[2, 0, 1]` the result is `[c, a, b]`.
- An action that is rejected or aborts consumes nothing; atomicity covers the
  script. Dice consumption is transactional (DESIGN §7, **Transactions**): a
  rejected action consumes no dice.
- Running out of entries, a kind or expression mismatch, or entries left over
  when the scenario ends are **scenario errors** (the fixture is wrong, as
  opposed to the engine failing an expectation). Leftover entries are an
  error for a complete run, one that executed every step; a runner that skips
  steps it does not support cannot judge them.

The script is execution input only. **It is not a replay mechanism.** Replay
(DESIGN §7) applies recorded effects and never re-rolls; the operation log
records the roll results that were written, and a scenario asserts them with
`log_includes`. The `replay` expectation (section 7, section 11) asserts that
replaying the log reproduces the table and consumes no script entries.

## 6. Steps

A step is `{actor, note?, do, expect?}`. `do` is one of:

| `do.type` | Fields | Meaning |
|---|---|---|
| `set` | `object, cell, value` | Hand-edit a literal. The cell must not hold a formula (use `override`); an absent cell is created, as the inspector would. |
| `override` | `object, cell, value` | Type a literal over a formula cell (DESIGN §4.2). The cell must hold a formula. |
| `clear_override` | `object, cell` | Remove an override; the cell follows its formula again. |
| `invoke` | `object, action` | Press an action's button. |
| `move` | `object, to` | Drag an object to a destination. |
| `spawn` | `template, to, cells?, as, owned?` | Copy a template subtree to a destination. |
| `undo` | | Undo the last group (section 8). |
| `bind` | `as, tag, where?, in?` | Name an existing object. No actor. |

`set` and `override` take literal values only. A step that is not `bind`
requires an `actor`; `bind` forbids one.

**Destinations** (`to`) are
`{"type":"board","board":"table","position":[4,2]}` or
`{"type":"container","container":"hand1","index":0}`. `index` is the object's
position in the container's contents after the move; `index` equal to the
current length appends. Moving onto a board ends containment; a move never
changes `owner` (DESIGN §4.1).

**Spawn.** `cells` sets initial cells on the new root object, literal or
formula (a character's die is spawned with
`"modifier": {"type":"formula","source":"owner.attack_bonus"}`). `as` binds
the new root. `owned` binds copies of objects in the template's subtree, keyed
by their setup id:

```json
{ "type": "spawn", "template": "fireball", "to": { "type": "container", "container": "aldric_binder", "index": 0 },
  "cells": { "caster": { "type": "ref", "object": "aldric" } },
  "as": "fb1", "owned": { "fireball_zone": "zone1" } }
```

After this, `fb1` is the new card and `zone1` its copy of the zone. The
validator checks that each `owned` key is in the template's subtree.

**Bind.** Objects created inside an action (Fireball's rows) cannot be named by
the step that made them. A `bind` step names exactly one existing object:

```json
{ "do": { "type": "bind", "as": "row_g1", "tag": "save_row",
          "where": { "cell": "target", "value": { "type": "ref", "object": "goblin1" } },
          "in": "fb1" } }
```

It selects objects whose `tag` contains `tag`, whose cell `where.cell` equals
`where.value` (FORMULAS §4 equality, on the current value) if `where` is given,
and that are directly in `in`'s contents if `in` is given. Templates are
objects and are not excluded; use `where` or `in` to rule them out. Matching
zero or more than one object is a scenario error. A bind step changes nothing,
appends no log group, and consumes no dice.

**Rejection.** Some steps are refused by the table: an action whose `when` is
false or an error, a step error inside an action, a move that would create a
containment cycle, a write to a protected cell, an undo that conflicts or has
nothing to undo. A refused step changes nothing and appends no log group. A
scenario must predict refusal with a `rejected` expectation on that step; an
unpredicted refusal fails the scenario, and so does a predicted one that does
not happen. Using a step wrongly (`override` on a literal cell, `set` on a
formula cell, `clear_override` with no override, acting on a removed object)
is a scenario error, not a rejection.

The first three misuses stay scenario errors in the format, although the
engine treats them differently: the engine's `writeValue` on a formula cell
creates an override, as a hand edit would, and clearing a missing override is
refused by the engine. A runner implements the rejection
protocol above for every step type it supports: the M2 runner for `set`,
`override`, `clear_override`, `move`, `spawn`, and `undo`; M5 adds `invoke`
with the action rejections `when_false`, `when_error`, and `step_error`
(FORMULAS §8.1). A primitive's own refusal inside an action step keeps its
reason (`protected_cell`, `containment_cycle`); a `type_error` is the reason
`step_error` with code `#TYPE`.

## 7. Expectations

Expectations are checked in order after setup (top-level `expect`) or after a
step. One discriminated union on `type`:

| `type` | Fields | Holds when |
|---|---|---|
| `cell` | `object, cell, value` | The cell's current value (literal, formula result, or override) equals `value`, as the GM sees it. Numbers compare exactly; roll results compare all fields; lists elementwise. |
| `cell_error` | `object, cell, code` | The cell evaluates to that error: one of `#CYCLE`, `#NAME`, `#TYPE`, `#REF`, `#DIV0`, `#LIMIT`, `#SYNTAX` (FORMULAS §2.3). |
| `override` | `object, cell, overridden` | The cell does (`true`) or does not (`false`) carry the override marker. |
| `action` | `object, action, enabled` | The action's `when` is true (or absent) for `enabled: true`; false or an error for `enabled: false`. |
| `rejected` | `reason` | This step was refused for this reason, and the document and log are unchanged. Step-level only; at most one per step. |
| `exists` | `object, exists` | The object exists, or has been removed. |
| `container` | `object, container, index` | The object is at that index of that container's contents. |
| `placement` | `object, board, position` | The object is on that board at that anchor: numeric `[x, y]`, the evaluated coordinates if the position is a formula. |
| `contents` | `object, contents` | The object's contents are exactly these, in order. |
| `cell_visible` | `object, cell, viewer, visible` | The viewer can (or cannot) see the cell's value. |
| `object_visible` | `object, viewer, visible` | The viewer can (or cannot) see the object. |
| `log_groups` | `count` | The log holds this many groups. |
| `log_includes` | `group, effect` | The group at that index records the effect. Step-level only. |
| `replay` | | Applying the recorded effects of every group in the log, in order, to the document as it was right after setup reproduces the current stored state, and consumes no dice-script entries and no randomness. Top level or step level. See section 11. |
| `face_element` | `object, element, list?, viewer?, shown` | `element` is the index of an element in the object's stored face list `list` (`"full"`, the default, for `elements`; `"collapsed"` for `collapsed`). `shown: true` holds when that element is present in the viewer's face view with its `show_when` true (or absent), `shown: false` when it is not (docs/PROTOCOL.md §7.2). `viewer` defaults to `gm`. |

Rejection reasons: `{"type":"when_false"}`, `{"type":"when_error","code":"#REF"}`,
`{"type":"step_error","code":"#TYPE"}` (code optional),
`{"type":"protected_cell"}`, `{"type":"containment_cycle"}`,
`{"type":"undo_conflict"}`, `{"type":"nothing_to_undo"}`.

Visibility, precisely (DESIGN §4.4):

- `cell_visible` is the composed rule: the cell's own `cell_visibility`
  (default: the object's), intersected with the object's effective
  visibility, intersected with the owner if the object is face down (except
  `name`). The GM sees everything. `cell_visible` holds only if
  `object_visible` holds for the same viewer: a cell of a covered object is
  not visible.
- `object_visible` is whether the viewer sees the object at all: its
  effective visibility (own `visible_to` intersected with its container's,
  recursively), and not drawn under the cover of an opaque zone the viewer
  cannot see. That makes opaque-zone fog observable without a separate
  expectation: a goblin marked `all` inside a hidden opaque room is not
  visible to Aldric. Cover is the rule of DESIGN §4.4: independent of `z`,
  decided by the anchor, and inherited from the outermost container.

**Placement and position.** A formula position stays in `placement` in the
format (section 3). Canonically, `position` is a cell, present exactly when
the object is on a board (FORMULAS §3.1); a runner converts between the two.

Removal. `remove` deletes recursively; a scenario asserts each object it
cares about with its own `exists: false`, which is also how it shows the
recursion (Fireball's Discard asserts the zone, the card, and both rows).
Any other expectation on a removed object is a scenario error.

Log effects for `log_includes`:

```json
{ "type": "write", "object": "goblin1", "cell": "damage_taken", "value": { "type": "number", "value": 13 } }
{ "type": "roll", "object": "fb1", "cell": "damage", "value": { "type": "roll", "expr": "8d6", "dice": [3,5,2,6,4,1,5,1], "dropped": [], "total": 27 } }
```

A `write` matches a resolved cell write in the group: the value written (for
`add`, the resulting sum, not the increment; for `override`, the overriding
value). A `roll` matches a roll the group recorded and the cell it was written
to. "Includes" means the group records at least this effect; other effects may
be present.

## 8. The log and undo

The format models the operation log (DESIGN §7) only as far as fixtures
need it:

- Every step that is neither rejected nor `bind` appends **exactly one
  group**. An `invoke` is one group for the whole action; `set`, `override`,
  `clear_override`, `move`, and `spawn` are one group each; `undo` is one
  group, because undo is itself an operation.
- `undo` reverses the most recent group that is neither an undo nor already
  undone. It does not delete that group, and there is no redo. An undo whose
  target's cells were touched by a later surviving operation is refused with
  `undo_conflict`; an undo with nothing left to reverse is refused with
  `nothing_to_undo`.
- A later *surviving* operation is a group that conflicts with the target in
  the sense of DESIGN §7 (**Undo**): it is not an undo group, it is not
  undone, and it shares a touched key with the target.
- The engine also undoes the latest group of a given actor and the group at
  an explicit index (DESIGN §7), but the `undo` step always means the default:
  the most recent group that is neither an undo nor already undone.

M2 confirms these rules as the engine's (DESIGN §7): one group per step that
is neither rejected nor `bind`, undo adds its own group, undo reverses the
most recent non-undo, non-undone group, and there is no redo.
- `log_includes.group` indexes groups from the start, 0-based; a negative
  index counts from the end (`-1` is the latest). Fireball needs an absolute
  index to show that an earlier Apply group is unchanged after a later edit.

The hit points scenario (`scenarios/hit-points.json`) ends with five groups:
set, override, set, clear_override, undo.

## 9. The §10 fixtures

One section per fixture, in FORMULAS.md order. Each says which constructs the
fixture uses and where the subtleties are. "Scenario: (pending)" is replaced
with a link by the transcription bead named.

### Hit points

`max_hp` and `damage_taken` are literals, `hp` a formula. A `set` on
`damage_taken` moves `hp`; an `override` on `hp` freezes it and the `override`
expectation shows the inspector's marker; a further `set` on `damage_taken` is
asserted *not* to change `hp`; `clear_override` restores tracking. An `undo`
of the clear brings the override back.

Scenario: [`hit-points.json`](../packages/fixtures/scenarios/hit-points.json)

### A die with a modifier

A `d20` template (`sides`, `modifier: empty`, `value: empty`,
`total = value + modifier`, action `Roll`) inside a binder. Three variants,
each a `spawn`:

- The GM's loose die: no initial cells; `total` is `0` before the roll
  (`empty` acts as zero in arithmetic, §2.1) and equals `value`'s total after.
- A character's die: `"cells": {"owner": {"type":"ref","object":"aldric"},
  "modifier": {"type":"formula","source":"owner.attack_bonus"}}`. Initial cells
  may be formulas, which is how "this template with `modifier =
  owner.attack_bonus` as a formula" is said without a second template. A later
  `set` of Aldric's `attack_bonus` moves `total` without a reroll.
- A goblin's die: `"owner": {"type":"ref","object":"goblin1"}`. `owner` points
  at a character (DESIGN §4.4), so the goblin is listed in
  `setup.characters`.

Each roll is a script entry `{"type":"roll","expr":"1d20",...}`; the
`log_includes` roll effect asserts it was recorded.

Scenario: [`die-with-modifier.json`](../packages/fixtures/scenarios/die-with-modifier.json)

### A goblin that shows HIT when a die on it beats its AC

```json
{ "id": "goblin1", "tag": ["creature"], "shape": { "type": "circle", "radius": 0.5 },
  "placement": { "board": "table", "position": [5, 5] },
  "cells": { "ac": { "type": "number", "value": 13 }, "z": { "type": "number", "value": 0 },
             "hit": { "type": "formula", "source": "any(on(this).where(tag has \"d20\").total >= ac)" } },
  "cell_visibility": { "ac": { "type": "viewers", "viewers": ["gm"] } } }
```

`on(this)` needs footprints and z-order: the goblin and die have `shape`s, the
die is moved to a `position` whose footprint overlaps the goblin's, and its
`z` cell is set above the goblin's. `z` is an ordinary §3.1 cell, not a
placement field; the fixture sets it with a `set` step after the `move`
rather than relying on the landing rule of FORMULAS §3.1, which puts a moved
object on top. `hit` is `false` with no die on the goblin and with
a die beside it, `true` after a scripted roll of 15 on a die on top.

The visibility subtlety is asserted directly:

```json
{ "type": "cell_visible", "object": "goblin1", "cell": "ac", "viewer": "aldric", "visible": false },
{ "type": "cell_visible", "object": "goblin1", "cell": "hit", "viewer": "aldric", "visible": true }
```

Scenario: [`goblin-hit.json`](../packages/fixtures/scenarios/goblin-hit.json)

### A dice tray that totals itself

Zone variant: a `tray` with `"is_zone": true` and a `rect` shape on the board and
`tray_total = sum(contents(this).where(tag has "die").value)`. Dice are
`move`d to board positions inside and outside the rectangle (a point on the
boundary is inside, §6); `tray_total` follows. A non-die object inside does not
count. Container variant: a `cup` with
`tray_total = sum(contents.where(tag has "die").value)`; dice are `move`d into
it with a container destination, and the `contents` expectation asserts order.
A die moved out of the cup onto the board leaves the cup's sum and, if it lands
in the zone tray, enters that one: the zone/container distinction (DESIGN §4.3)
is visible in one scenario. Die values are roll results from the script; the
sums are numbers.

Scenario: [`dice-tray.json`](../packages/fixtures/scenarios/dice-tray.json)

### Difficult terrain

An `is_zone` object tagged `difficult` with a shape; a token with `base_speed: 30` and the
`speed` formula. `move` the token into the zone (`speed` 15) and out (30).
Nothing new is needed; `rotation` of the zone, if a variant wants it, is an
ordinary cell.

Scenario: [`difficult-terrain.json`](../packages/fixtures/scenarios/difficult-terrain.json)

### An Attack card

The card template sits in Aldric's binder. "Set at spawn to the binder's
owner" is a `spawn` with `"cells": {"attacker": {"type":"ref","object":"aldric"}}`:
the format records the resulting literal, not the UI's inference of it.
`target` is set with a `set` of a `ref` value. Each guard is checked with
`action` expectations before and after each step (Roll disabled while
`target` is empty, Roll damage disabled until `hit`, and so on). `Roll damage`
rolls `attacker.damage_dice`; its script entry's `expr` is that dice value
(e.g. `"1d8+3"`, `"dice":[5]`, `"total":8`). After Apply, a second Apply is
shown disabled and an attempted invocation is refused:

```json
{ "actor": "aldric", "do": { "type": "invoke", "object": "attack1", "action": "Apply" },
  "expect": [ { "type": "rejected", "reason": { "type": "when_false" } },
              { "type": "cell", "object": "goblin1", "cell": "damage_taken", "value": { "type": "number", "value": 8 } } ] }
```

`undo` of Apply restores `target.damage_taken` and `applied`. `hit` is visible
to Aldric while the goblin's `ac` is not (`cell_visible`). The guards are
what make a second Apply impossible.

The face (M5) is part of the scenario: the `attack_card` template carries the
Attack card face of DESIGN §4.6, which `attack1` copies on spawn:

```json
{"elements": [
  {"type": "value", "cell": "name", "rect": [-1.2, -1.7, 2.4, 0.4], "style": {"size": "large"}},
  {"type": "editor", "cell": "target", "rect": [-1.2, -1.2, 2.4, 0.4], "style": {"caption": true}},
  {"type": "value", "cell": "total", "rect": [-1.2, -0.7, 1.1, 0.5], "style": {"caption": true}},
  {"type": "value", "cell": "hit", "rect": [0.1, -0.7, 1.1, 0.5], "style": {"caption": true}},
  {"type": "value", "cell": "dmg", "rect": [-1.2, -0.1, 2.4, 0.4], "style": {"caption": true}},
  {"type": "button", "action": "Roll", "rect": [-1.2, 0.5, 1.1, 0.45], "show_when": "roll = empty"},
  {"type": "button", "action": "Roll damage", "rect": [0.1, 0.5, 1.1, 0.45], "show_when": "hit and dmg = empty"},
  {"type": "button", "action": "Apply", "rect": [-1.2, 1.1, 2.4, 0.45], "show_when": "not applied"}],
 "default_action": "Roll"}
```

Its show-when is asserted with `face_element` expectations before and after
Roll and Apply: the Roll button (element 5) is shown until `roll` is set, and
the Apply button (element 7) is shown until `applied`. Show-when only hides;
the refused second Apply is still the guard's `when_false`.

Scenario: [`scenarios/attack-card.json`](../packages/fixtures/scenarios/attack-card.json)

### A Fireball card with a circle zone

The densest fixture. Setup:

- The card template `fireball` in Aldric's binder, with
  `"contents": ["fireball_zone"]`, and cells `caster: empty`,
  `zone: {"type":"ref","object":"fireball_zone"}`, `dc`, `damage`, `locked`,
  `applied`, `targets`, `rows`, the four actions, and a
  `save_row: {"type":"ref","object":"save_row_t"}` cell. The prose calls
  `spawn(save_row, this, ...)` but does not list that cell; `save_row` must be
  a reference to the row template.
- The zone template `fireball_zone`: `"is_zone": true`, a `circle` shape, no placement (it is in
  the card's contents).
- The row template `save_row_t` (tag `save_row`) **outside** the card's
  subtree, for example beside it in the binder. If it were inside, it would be
  copied with the card and match the card's own `rows` query.
- Creature tokens with `dex_save` and `damage_taken`, some inside where the
  zone will land and one outside.

Construct by construct:

1. `spawn` with `owned` binds the new card and its new zone. The remapping is
   asserted: `{"type":"cell","object":"fb1","cell":"zone","value":{"type":"ref","object":"zone1"}}`.
   The external `save_row` reference is asserted unchanged (still
   `save_row_t`).
2. `move` of `zone1` onto the board: a `contents` expectation shows `fb1`'s
   contents no longer hold it; `placement` shows where it is. `targets` is
   asserted as a list: `{"type":"list","items":[{"type":"ref","object":"goblin1"},{"type":"ref","object":"goblin2"}]}`
   (order by z then id, §5).
3. `invoke` Lock targets spawns rows inside the action. They are named with
   `bind` steps (`tag: "save_row"`, `where` on `target`, `in: "fb1"`), then
   `owner` and `target` on each are asserted. Moving the zone afterwards
   changes `targets` but not the rows.
4. Roll damage (script `8d6`), Apply all disabled until every row has a save,
   two Roll save invocations with scripted 1d20s (one pass, one fail), each by
   the row owner's character or the GM as `actor`.
5. Apply all: `damage_taken` per target, and the group's writes asserted by
   absolute index. With the sequence spawn, move zone, Lock targets, nudge
   zone, Roll damage, two Roll saves, Apply all (bind steps append nothing),
   the Apply group is index 7.
6. Drift: a later `set` of a target's `dex_save` changes that row's live
   `damage_dealt`, while the Apply group is asserted unchanged. A failed
   save's `damage_dealt` is the stored roll result itself, since `if` returns
   its chosen branch unchanged and a roll result acts as its total only in
   arithmetic and comparison (§2.2); the halved value is a number because
   `floor` is arithmetic, and the applied `damage_taken` is a number because
   `add` is:

```json
{ "actor": "gm", "do": { "type": "set", "object": "goblin1", "cell": "dex_save", "value": { "type": "number", "value": -5 } },
  "expect": [
    { "type": "cell", "object": "row_g1", "cell": "damage_dealt",
      "value": { "type": "roll", "expr": "8d6", "dice": [3,5,2,6,4,1,5,1], "dropped": [], "total": 27 } },
    { "type": "log_includes", "group": 7, "effect": { "type": "write", "object": "goblin1", "cell": "damage_taken", "value": { "type": "number", "value": 13 } } } ] }
```

7. Discard: `exists: false` for `zone1`, `fb1`, `row_g1`, `row_g2`. The zone
   is removed explicitly by `remove(zone)` because it left the card's
   contents; the rows go recursively with the card.

The frozen variant ("set(dc, caster.spell_dc) and set(save_bonus,
target.dex_save)") is a second template whose Lock targets has those extra
steps; in it the same drift step leaves `damage_dealt` unchanged. No new
construct is needed.

Scenario: [`scenarios/fireball.json`](../packages/fixtures/scenarios/fireball.json)

### Drawing a card

A `deck` container with two cards, a `hand` container with
`visible_to: {"type":"viewers","viewers":[{"type":"ref","object":"aldric"}]}`,
and the Draw action on an object whose cells include `deck` (a reference to
the deck) and `owner` (Aldric, who has `hand`, a reference to his hand). Two
Draws, each asserted with `contents` on deck and hand and `container` on the
card. The cards are `visible_to: all` but inside the hand: `object_visible`
is true for Aldric and false for another character, and moving a card back out
restores `all` (§4.4 composition). The third Draw: `action` disabled, then an
invocation `rejected` with `when_false`.

Scenario: [`scenarios/drawing-a-card.json`](../packages/fixtures/scenarios/drawing-a-card.json)

### Shuffling

A container with known contents and a Shuffle action `shuffle(this)`. The
script holds `{"type":"permutation","order":[2,0,1]}`; the `contents`
expectation asserts the exact resulting order (`[c, a, b]` from `[a, b, c]`).
`undo` restores the original order.

Scenario: [`scenarios/shuffling.json`](../packages/fixtures/scenarios/shuffling.json)

### Re-hiding a room when the party leaves (phase 1 vision, optional)

A room with `"is_zone": true`, a `rect` shape, and cells `opaque: true` and
`visible_to = if(len(contents(this).where(tag has "pc")) > 0, all, gm)` as a
formula. A goblin marked `all` stands inside.

- Before entry: `object_visible` of the room and of the goblin are false for
  Aldric (the goblin is under the opaque cover), true for the GM.
- `move` Aldric's token (tag `pc`) into the room: both visible to Aldric.
- `move` him out: hidden again.
- The manual write: an `override` of `visible_to` with
  `{"type":"viewers","viewers":["all"]}`, asserted with `override: true`; moving
  the PC out no longer re-hides the room. That is "Setting `visible_to` by hand
  would create an override and stop the formula; the inspector says so."

Scenario: [`re-hiding-room.json`](../packages/fixtures/scenarios/re-hiding-room.json)

## 10. For transcription beads

- Put each scenario in `packages/fixtures/scenarios/` as a `.json` file, one
  scenario per file. `test/scenarios.test.ts` validates every file there; it
  only validates, so do not edit it.
- Assert your own titles in your own test file (`test/titles-cells.test.ts`,
  `test/titles-cards.test.ts`, `test/titles-fireball.test.ts`), loading the
  scenarios you own and checking their titles. Three beads run concurrently;
  none of them should touch another's test file or `scenarios.test.ts`.
- `source` is the heading exactly as `FORMULAS_FIXTURES` spells it.
- Quote the prose behind each expectation in its `note`.
- Replace "Scenario: (pending, ...)" in your sections above with a relative
  link to the file. Edit only your sections.
- The format is fixed. If a behaviour cannot be expressed, stop and report it
  against vtt-1me.8; do not extend the schema.
- vtt-1me.9 deletes `test/samples/`; the samples block in `format.test.ts`
  discovers the directory and needs no edit.

## 11. Additive extensions

Replay expectations (M2) and face layout and show-when (M5) extend this format
by adding variants and optional fields; existing scenarios stay valid.

Recorded extensions:

- **`#SYNTAX` error code** (M1). `ErrorCodeSchema` accepts `#SYNTAX` for
  `cell_error`, `when_error`, and `step_error`: the source does not parse
  (FORMULAS §2.3). Additive; no scenario changed.
- **`replay` expectation** (M2). `{"type":"replay","note":"optional"}`, at
  top level or in a step. It holds when applying, to the document as it was
  right after setup, the recorded effects of every group currently in the
  log, in order, yields a document whose stored state equals the current one,
  and doing so consumes no dice-script entries and no randomness. Stored state
  is the canonical snapshot: cells as stored (literal, formula source,
  override), per-cell visibility, placement, contents order, structural
  fields, `retired_ids`, and `next_seq`. It never includes computed formula
  results, and never the revision (DESIGN §7, **Replay and rewind**). The
  schema is `ReplayExpectationSchema` in the `ExpectationSchema` union.
  Additive; existing variants are unchanged. Every scenario asserts it in its
  last step, and Fireball also asserts it after its first step, the spawn.
- **Setup `face`** (M5, M5-D15). Setup objects take an optional `face`, the
  face layout encoding of DESIGN §4.6 (section 3). Additive; objects without
  it are unchanged.
- **`face_element` expectation** (M5, M5-D15). `{"type":"face_element",
  "object", "element", "list"?, "viewer"?, "shown"}` (section 7): `element`
  is the index in the stored list (`list` `"full"` by default, or
  `"collapsed"`), and `shown` means present in that viewer's face view with
  `show_when` true. Unknown keys are rejected as for every variant. The
  Attack card scenario carries its face and asserts its show-when (section
  9). Additive; existing variants are unchanged.
