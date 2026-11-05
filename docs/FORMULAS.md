# Formula and Action Language

Companion to [DESIGN.md](DESIGN.md). This document specifies the language that
lives in cells and in actions. It should be complete and small: an agent with
this file in context, and nothing else, should write correct formulas and
actions. Completeness wins over brevity when they conflict.

Status: design draft. The fixtures in section 10 are the acceptance tests for
the language.

---

## 1. Goals and constraints

- Readable by a GM who knows spreadsheets. No statements, no blocks, one
  expression per cell.
- **Pure and deterministic.** A formula never writes, never rolls, never reads
  the clock, never depends on who is looking. The same document revision
  always produces the same values. Randomness and writes live only in actions.
- Errors are values displayed in the cell, never crashes.
- One way to say each thing.

## 2. Values

| Type | Literal | Notes |
|---|---|---|
| number | `12`, `3.5`, `-2` | One numeric type. |
| text | `"goblin"` | Double quotes; `\"` and `\\` escapes. |
| boolean | `true`, `false` | |
| empty | `empty` | A blank cell. See 2.1. |
| list | `[1, 2, 3]`, `["die", "d6"]` | Ordered. Tags, contents, query results are lists. |
| reference | none | Points at an object. Obtained from reference cells (`target`, `owner`) or queries (`contents(...)`). A reference to a deleted object evaluates to `#REF`. |
| dice | `2d6+3`, `1d20kh1`, `4d6dl1`, `1d6!`, `2d20kl1` | A dice *expression*, not a roll. See 2.2. |
| roll result | none | Produced by the `roll` action step. See 2.2. |
| ink | none | Freehand strokes. Opaque to formulas; only `ink = empty` is meaningful. |
| viewers | `all`, `gm`, `owner`, a character reference, or a list of these | The value type of `visible_to`. |
| record | `{target: it, modifier: 2}` | A set of named values. Used only as the initial-cells argument to `spawn`. Not storable in a cell. |
| error | `#CYCLE`, `#NAME`, `#TYPE`, `#REF`, `#DIV0`, `#LIMIT` | See 2.3. |

### 2.1 Empty, truthiness, and coercion

- A cell that exists but has no value is `empty`. A name that is not a cell on
  the object is `#NAME`. Typos surface; blanks do not.
- `empty` in arithmetic is `0`; in text concatenation is `""`; in a condition
  is `false`.
- **Truthiness.** `false`, `empty`, `0`, `""`, and `[]` are false. Everything
  else, including any reference and any non-empty list, is true. Errors are
  neither; a condition on an error yields that error.
- `and` and `or` short-circuit and return one of their operands, so
  `nickname or name` is a default. To test a legitimate zero against empty,
  compare explicitly: `if(bonus = empty, 0, bonus)`.
- No implicit number-from-text coercion. `"3" + 1` is `#TYPE`. Use
  `number("3")`.
- `empty = empty` is true. `empty = 0` is false. A blank is not a zero; it only
  *acts* like one in arithmetic.

### 2.2 Dice and roll results

A **dice value** is an expression in standard dice notation. V1 subset:

- `NdS` with integer N ≥ 1 and S ≥ 2, or `dS` meaning `1dS`; `dF` for Fudge
  dice.
- Modifiers on a term: `khN`, `klN`, `dhN`, `dlN` (keep/drop highest/lowest),
  `!` (explode on maximum, at most 100 times per die), `r<N`, `r>N`,
  `r=N` (reroll once on the condition).
- Terms combined with `+` and `-`, and with integers.

Arithmetic between dice values, or dice and numbers, produces dice values:
`weapon.dice + 1d6 + 2`. Multiplication and division are not defined on dice.

A **roll result** is what an action's `roll` step writes. It acts as a number
(its total) in arithmetic and comparison, and exposes:

- `.total` the number
- `.dice` the list of individual kept die results, in roll order
- `.dropped` the list of dropped results
- `.expr` the dice value that was rolled

Dice functions: `max_roll(dice)`, `min_roll(dice)`, `faces(dice)` (number of
dice in the expression, counting kept and dropped), `sides(dice)` (a list of
the sizes of each die, so a mixed pool is a list, not an error).

### 2.3 Errors

| Error | When |
|---|---|
| `#NAME` | A bare name or dot-access names a cell the object does not have, or an unknown function. |
| `#REF` | Following a reference to a deleted object, or `obj()` finding nothing or more than one match. |
| `#TYPE` | An operator or function received a value it does not accept. |
| `#DIV0` | Division by zero. |
| `#CYCLE` | This cell is in a dependency cycle. See 7. |
| `#LIMIT` | Evaluation exceeded its budget. See 7. |

Errors propagate through any expression that uses them, except `iserror(x)`
and `if(iserror(x), fallback, x)`. The inspector shows the message and the
cell where the error originated.

## 3. Names, scope, and references

- A **bare name** is a cell on the current object: `max_hp` means
  `this.max_hp`.
- `this` is the object the formula lives on. Inside `where`, `sort`, and
  `each`, `this` still means the enclosing object, and the item is `it`.
  Inside a nested `where`, the inner `it` shadows the outer; name the outer
  explicitly by binding it in a cell if both are needed.
- **Dot-access** follows a reference: `target.ac`, `owner.attack_bonus`.
- Cell names are `snake_case` identifiers: letters, digits, underscores, not
  starting with a digit. A cell's display label may be anything. A name that
  is not a valid identifier is written in backticks: `` `Max HP` ``.
- `obj("Aldric")` looks an object up by exact name and is `#REF` unless
  exactly one matches. `obj(id)` looks up by id. Both exist for the GM and
  agents; templates should use reference cells instead.

### 3.1 Structural cells every object has

Readable like any other cell. Those marked *protected* cannot be set by a
formula or an override, only by the engine through moves and spawns, because
they carry the invariants of the table.

| Cell | Type | Notes |
|---|---|---|
| `id` | text | *Protected.* Stable, never reused. |
| `name` | text | |
| `tag` | list of text | |
| `visible_to` | viewers | Own visibility; effective visibility is composed (DESIGN.md 4.4). |
| `owner` | reference or empty | A character. |
| `template` | reference or empty | The template this was spawned from. |
| `contents` | list of references | *Protected as to membership.* The objects this one owns. Changed only by `move`, `spawn`, `remove`, `shuffle`. |
| `container` | reference or empty | *Protected, derived.* The object whose `contents` holds this one. |
| `board` | reference or empty | *Protected.* Empty when inside a container. |
| `position`, `rotation`, `z` | number pairs / numbers | Empty when inside a container. May hold formulas (a token that follows another); a cycle through geometry yields `#CYCLE` like any other. |
| `face_up` | boolean | |
| `shape` | shape | For zones: the region. For others: the outline. |
| `opaque` | boolean | Zones only. See DESIGN.md 4.4. |

## 4. Operators and precedence

| Kind | Operators | Notes |
|---|---|---|
| arithmetic | `+ - * / %` | `/` is real division; `floor(a / 2)` for integer halving. `%` is remainder. |
| comparison | `= != < <= > >=` | `=` is equality. Nothing in a formula assigns. |
| logic | `and`, `or`, `not` | Words. Short-circuit. Return an operand. |
| membership | `has` | `list has item`. Equality per item. |
| text | `&` | Concatenation, converting numbers and booleans to text. |

Precedence, tightest first: unary `-` and `not`; `* / %`; `+ -`; `&`;
`has`; comparisons; `and`; `or`. Comparisons do not chain: `a < b < c` is
`#TYPE`.

**Equality.** Numbers and text compare by value; references by identity; dice
by normalized expression; roll results by total; lists elementwise and in
order. Ordering (`<` and friends) is defined for numbers, text (code point
order), and roll results, and is `#TYPE` for anything else.

**Broadcasting.** Arithmetic, `&`, comparison, and scalar functions applied
to a list with a scalar apply elementwise and yield a list:
`on(this).total >= ac` is a list of booleans. Two lists of the same length
combine elementwise under arithmetic and `&`; different lengths are `#TYPE`.
The exceptions, which never broadcast: `has` (its left operand is the whole
list), `and`, `or`, `not` (they use truthiness of the whole value), and `=`
or `!=` when **both** sides are lists (ordered whole-list equality).
Dot-access on a list of references yields a list; nesting flattens one level
each time, and a list result is always flat (a cell holding a list
contributes its items, not a sublist). Aggregates (`sum`, `any`, …) consume a
list and return a scalar.

## 5. Conditionals, filtering, ordering

- `if(cond, a, b)` is the only conditional. Only the chosen branch is
  evaluated, and only its dependencies are recorded.
- `list.where(expr)` keeps items for which `expr` is true, with the item's
  cells as bare names and the item as `it`. There is no other filter form.
- `list.sort(expr)` and `list.sort(expr, desc)` order by the expression;
  ties keep the input order. Query results (`contents`, `objects`, `on`) are
  returned in a deterministic order: by `z` then by `id`.

## 6. Functions

Lowercase. All pure.

**Aggregates**, over a list, ignoring `empty` items:

| Function | Empty-list result |
|---|---|
| `sum` | `0` |
| `count` | `0` (items that are not empty) |
| `len` | `0` (all items) |
| `min`, `max`, `avg` | `empty` |
| `any` | `false` (true if any item is truthy) |
| `all` | `true` |
| `first`, `last` | `empty` |

**Numbers:** `round(x, places=0)`, `floor`, `ceil`, `abs`, `clamp(x, lo, hi)`,
`number(text)`

**Text:** `text(x)`, `upper`, `lower`, `join(list, sep)`, `len(text)`

**Errors:** `iserror(x)`

**Spatial and structural:**

| Function | Meaning |
|---|---|
| `contents(zone)` | Objects on the same board whose anchor lies inside the zone's region, excluding the zone. A point on the boundary is inside. Rotation of the zone and of the object are respected. Objects inside containers are not on a board and never appear. |
| `zones_containing(obj)` | Zones on the object's board whose region contains its anchor. |
| `on(obj)` | Objects whose footprint overlaps `obj` and that are above it in `z`, nearest first. Inferred from geometry, not stored. |
| `distance(a, b)` | Between anchors, in the board's unit (a board cell, `unit`, grid squares by default). `#TYPE` across boards. |
| `objects(expr)` | Every object on the table where `expr` is true, with the candidate as `it`. Budgeted (see 7). |
| `obj(name_or_id)` | See 3. |

**Dice:** see 2.2.

## 7. Evaluation model

- **Revision-consistent.** Every evaluation runs against one document
  revision. An action commits a new revision; formulas recompute after the
  commit, never in the middle.
- **Dynamic dependencies.** Dependencies are recorded as evaluation touches
  cells, not parsed statically. `if` records only the branch it took. When the
  cell is re-evaluated, its dependency set is replaced.
- **Query dependencies.** `contents`, `zones_containing`, `on`, and `objects`
  depend on a spatial or tag index, not on the current result set. The index
  is invalidated by changes to any object's `position`, `rotation`, `shape`,
  `z`, `board`, `tag`, `container`, and by creation and deletion. A die that
  enters a tray therefore recomputes the tray's sum even though it was not a
  dependency before.
- **Viewer-independent.** Queries and formulas see the whole document. What a
  viewer may *see* is applied afterwards, to presentation. `contents()` never
  filters by visibility.
- **Whole-document.** An object that the renderer has not loaded still exists
  for evaluation. Unloaded is never absent.
- **Cycles.** A cell that depends on itself, through any chain including
  geometry and queries, evaluates to `#CYCLE`, as does every cell in the
  cycle. Cells that merely depend on the cycle receive the propagated error.
  When an edit breaks the cycle, every affected cell recomputes.
- **Budgets.** Each formula has a bounded number of cells it may touch per
  evaluation (default in the tens of thousands). Exceeding it yields `#LIMIT`
  for that cell only. `objects()` over a very large table is the usual cause.

## 8. Actions

An action belongs to an object and has a name, an optional **precondition**,
and a **list of steps**. Actions are the only place anything is written or
rolled.

```
Apply:
  when:  hit and dmg != empty and not applied
  steps: add(target.damage_taken, dmg)
         set(applied, true)
```

### 8.1 Contract

- **Atomic.** Steps run in order. Each step sees the writes of the steps
  before it. If any step errors, nothing is applied and the error is shown.
- **Precondition.** `when` is a formula evaluated before the first step. If
  false or an error, the action does not run and the button reports why.
  Show-when on a button (DESIGN.md 4.6) hides the button; `when` is the guard.
- **Snapshot iteration.** `each` evaluates its list once, before running.
- **Reads inside an action.** A cell this action has written reads as
  written, including a formula cell that an earlier step overrode. Any other
  cell reads as of the start of the action; formulas are not re-evaluated
  between steps. A formula cell on an object spawned by this action reads as
  `empty` until the action commits. If a step needs a value derived from an
  earlier write, compute it inline or use a second action.
- **Undo** reverses the whole action.
- **Logged** as one entry: the action, its object, who invoked it, and each
  step as a sentence with the resolved values (the dice rolled, the id
  spawned).

### 8.2 Cell paths and destinations

Step arguments come in three syntactic kinds:

- a **value expression**, anything from sections 2 to 6;
- a **cell path**, a bare name or dot-access ending in a cell name, naming
  *where* to write: `damage_taken`, `target.damage_taken`, `it.save_roll`;
- a **destination**, one of: a reference to a container (goes into its
  `contents`, at the end), `board(ref, position)` (onto a board at a point),
  `beside(ref)` (onto the same board next to an object), `table` (the GM's
  current board at the viewport center; UI-only convenience, not for
  templates).

Writing to a cell that holds a formula creates an override, exactly as a hand
edit would. Writing to a protected cell is an error.

### 8.3 Steps

| Step | Meaning |
|---|---|
| `set(path, expr)` | Write a value. |
| `add(path, expr)` | Numeric increment. `#TYPE` if either side is not a number or empty. |
| `append(path, expr)` | Push onto a list cell. |
| `roll(dice_expr) -> path` | Roll a dice value, write the roll result. The only source of randomness. |
| `move(ref, destination)` | Remove the object from its container or board and place it at the destination, atomically. Moving onto a board ends ownership. Refused if it would create a containment cycle. |
| `spawn(template, destination, {cell: expr, ...})` | Copy the template subgraph (the template and its `contents`, transitively), remap internal references, keep external ones, set the given cells, set `template`, place at the destination. |
| `remove(ref)` | Delete the object and its `contents`, recursively. References to it elsewhere become `#REF`. |
| `shuffle(ref)` | Randomly reorder the object's `contents`. |
| `each(list, step)` | Run one step per item of the snapshotted list, with the item as `it`. One level only; `each` inside `each` is not allowed. |

There are no conditional steps. A step either always runs or the whole action
is guarded by `when`. A procedure that needs "do X only if Y" is two actions
with two preconditions, or a value-level `if` inside a `set`. If that proves
too limiting in practice the fix is a new step kind, not a script.

## 9. Visibility of inputs

A formula may reference cells the viewer is not allowed to see. The formula
still computes and the viewer sees the result. Dependency tracing names the
hidden cell without showing its value, and does not highlight an object the
viewer cannot see. The author of a formula decides what it publishes; in v1
only the GM and the agent author formulas. See DESIGN.md 4.2 and 4.4.

## 10. Fixtures

Acceptance tests for the language. Each must be expressible, must evaluate as
described, and must read cleanly to someone who did not write it. Notation:
`cell = formula` for formula cells, `cell: value` for literals, `[Button]` for
an action with its `when` and steps.

**Hit points**
```
max_hp: 27
damage_taken: 0
hp = max_hp - damage_taken
```
Overriding `hp` by hand freezes it until the override is cleared; the inspector
marks it.

**A die with a modifier**
```
sides: 20
modifier: empty
value: empty
total = value + modifier

[Roll]  roll(1d20) -> value
```
A character's attack die is this template with `modifier = owner.attack_bonus`
as a formula and `owner` set at spawn. A GM's loose die has `modifier` empty,
so `total` equals `value`. A goblin's die is owned by the goblin.

**A goblin that shows HIT when a die on it beats its AC**
```
ac: 13            (cell visible_to: gm)
hit = any(on(this).where(tag has "d20").total >= ac)
```
`on(this).where(...).total` is a list of numbers; `>= ac` broadcasts to a list
of booleans; `any` reduces it. The viewer sees `hit`, not `ac`.

**A dice tray that totals itself**
```
tray_total = sum(contents(this).where(tag has "die").value)
```
For a cup container instead of a zone: `sum(contents.where(tag has "die").value)`.

**Difficult terrain**
```
speed = base_speed / if(len(zones_containing(this).where(tag has "difficult")) > 0, 2, 1)
```

**An Attack card**
```
attacker: (set at spawn to the binder's owner)
target: empty
roll: empty
dmg: empty
applied: false
bonus  = attacker.attack_bonus
total  = roll + bonus
hit    = roll != empty and total >= target.ac

[Roll]         when: target != empty and roll = empty
               roll(1d20) -> roll
[Roll damage]  when: hit and dmg = empty
               roll(attacker.damage_dice) -> dmg
[Apply]        when: hit and dmg != empty and not applied
               add(target.damage_taken, dmg)
               set(applied, true)
```
Show-when on the face hides Roll once `roll` is set and hides Apply once
`applied`; the `when` guards are what make a second Apply impossible.

**A Fireball card with a circle zone**
```
Card (template owns the zone in its contents; in play the zone is dragged out
onto the board, and `zone` keeps pointing at it):
  caster: (set at spawn)
  zone: (non-owning reference to the zone object)
  dc = caster.spell_dc
  damage: empty
  locked: false
  applied: false
  targets = contents(zone).where(tag has "creature")        live, before lock
  rows    = contents.where(tag has "save_row")

  [Lock targets]  when: not locked
                  each(targets, spawn(save_row, this, {target: it, owner: it.owner}))
                  set(locked, true)
  [Roll damage]   when: locked and damage = empty
                  roll(8d6) -> damage
  [Apply all]     when: locked and damage != empty and all(rows.save_roll != empty) and not applied
                  each(rows, add(it.target.damage_taken, it.damage_dealt))
                  set(applied, true)
  [Discard]       remove(zone)
                  remove(this)

Save row template (tag: save_row):
  target: (set at spawn)
  save_roll: empty
  card = container
  save_bonus   = target.dex_save
  passed       = save_roll + save_bonus >= card.dc
  damage_dealt = if(passed, floor(card.damage / 2), card.damage)

  [Roll save]   when: save_roll = empty
                roll(1d20) -> save_roll
```
Spawning the Fireball card copies the card and its zone, and the card's `zone`
reference is remapped to the new zone. Dragging the zone onto the map moves it
out of the card's `contents`, so Discard removes it explicitly before removing
the card and its rows. After Apply all, the log holds what was applied; the
rows' `damage_dealt` is live and would drift if `dc` or a target's save bonus
changed later. A template that cares freezes them at lock time with
`set(dc, caster.spell_dc)` and `set(save_bonus, target.dex_save)` on each row.

**Drawing a card**
```
[Draw]  when: len(deck.contents) > 0
        move(first(deck.contents), owner.hand)
```

**Shuffling**
```
[Shuffle]  shuffle(this)
```

**Re-hiding a room when the party leaves (phase 1 vision, optional)**
```
opaque: true
visible_to = if(len(contents(this).where(tag has "pc")) > 0, all, gm)
```
Such a room is revealed by a PC token entering it. Setting `visible_to` by
hand would create an override and stop the formula; the inspector says so.

## 11. Open questions

- **Units.** `distance` in board units is fine for grids. Hex and gridless
  boards may want feet. Probably a per-board `unit` cell and a `ft()` helper.
- **Dice dialect beyond the v1 subset.** Compound explosions, success
  counting, and other dialect features wait for a need.
- **Text formatting** of numbers on faces (signs, decimals). A face element
  setting, not a language feature.
- **Outer-scope access in nested `where`.** Binding to a cell is the
  workaround; a named binding form may be warranted later.
