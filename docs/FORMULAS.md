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
| number | `12`, `3.5` | One numeric type, an IEEE double. `-2` is prefix minus applied to `2`. |
| text | `"goblin"` | Double quotes; `\"` and `\\` are the only escapes. Literal newlines are allowed. |
| boolean | `true`, `false` | |
| empty | `empty` | A blank cell. See 2.1. |
| list | `[1, 2, 3]`, `["die", "d6"]` | Ordered. Tags, contents, query results are lists. |
| reference | none | Points at an object. Obtained from reference cells (`target`, `owner`) or queries (`contents(...)`). A reference to a deleted object evaluates to `#REF` (2.4). |
| dice | `2d6+3`, `1d20kh1`, `4d6dl1`, `1d6!`, `2d20kl1` | A dice *expression*, not a roll. See 2.2. |
| roll result | none | Produced by the `roll` action step. See 2.2. |
| ink | none | Freehand strokes. Opaque to formulas; only `ink = empty` is meaningful. |
| shape | none | The value the structural `shape` cell reads as. Opaque to formulas: `=` and `!=` compare structurally, every other operation is `#TYPE`. Always truthy. |
| viewers | `all`, `gm`, `owner`, a character reference, or a list of these | The value type of `visible_to`. In a formula, `all` and `gm` are reserved viewer literals and `owner` is the `owner` cell (3.2). |
| record | `{target: it, modifier: 2}` | A set of named values. Used only as the initial-cells argument to `spawn`. Not storable in a cell. A duplicate field name is a syntax error. |
| error | `#CYCLE`, `#NAME`, `#TYPE`, `#REF`, `#DIV0`, `#LIMIT`, `#SYNTAX` | See 2.3. Never storable. |

An ad hoc formula evaluated on no object (an `evaluate` query without `this`) reads `this` as `#REF` ("no object in scope") and a bare cell name as `#NAME`; everything else, including literals, `obj()`, `objects()` and functions on explicit references, evaluates as usual, budgeted as any ad hoc evaluation.

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

A **dice value** is an expression in standard dice notation. V1 dialect:

- A **term** (a pool) is `NdS` with integer count 1 ≤ N ≤ 1000 and sides
  2 ≤ S ≤ 1,000,000, or `dS` meaning `1dS`; `NdF` or `dF` for Fudge dice
  (results -1, 0, 1). The `d` is lowercase only, the `F` uppercase only.
- Modifiers on a term, in any order, each kind at most once per term
  (keep/drop is one kind):
  - `khN`, `klN` keep the highest or lowest N, with 1 ≤ N ≤ count;
    `dhN`, `dlN` drop the highest or lowest N, with 1 ≤ N < count.
  - `!` explodes on maximum. Each explosion adds an extra die to the term
    (extras are separate dice, not compounded into one result); an extra that
    rolls maximum explodes again, up to 100 extras per original die.
  - `r<N`, `r>N`, `r=N` reroll once on the condition, with N within 1..S.
    The comparison is strict: `r<2` rerolls only a 1. The
    reroll replaces the die and the original goes to `.dropped`. Extras from
    an explosion are not rerolled.
  - Fudge terms take no `!` and no `r`.
- Modifiers apply in the order reroll, explode, keep/drop. Keep/drop ranks
  all of the term's dice, extras included: descending for `kh` and `dh`,
  ascending for `kl` and `dl`, ties broken by roll order. `kh` and `kl` keep
  the first N of that ranking; `dh` and `dl` drop the first N.
- Terms combined with `+` and `-`, and with integers. Integer constants, in
  notation and in dice arithmetic, must be safe integers (magnitude at most
  2^53 - 1); anything else is rejected.

**Normalized expression.** Dice equality (4) and fixture dice-script matching
(FIXTURES.md §5) compare normalized expressions: counts explicit (`d20` is
`1d20`), modifiers in the order reroll, explode, keep/drop (`1d6kh1!` is
`1d6!kh1`), integer constants folded into one trailing term (`2+1d6+1` is
`1d6+3`), no spaces. Term order is preserved, because it is the roll order of
`.dice`: `1d6+1d20` is not `1d20+1d6`. There is no semantic simplification:
`1d20kh1` is not `1d20`.

Arithmetic between dice values, or dice and numbers, produces dice values:
`weapon.dice + 1d6 + 2`. Multiplication and division are not defined on dice.

A **roll result** is what an action's `roll` step writes. It acts as its
total in arithmetic, comparison, numeric functions (`floor`, `round`,
`clamp`, `abs`), and `sum` and `avg`, which return numbers. `&` and `text()`
render it as its total. It is always truthy: a roll of total 0 was still
rolled. `min`, `max`, `if`, `first`, and `last` return the roll unchanged. It
exposes:

- `.total` the number
- `.dice` the list of individual kept die results, in roll order
- `.dropped` the list of dropped results
- `.expr` the dice value that was rolled

Dice functions: `max_roll(dice)`, `min_roll(dice)` (both ignore explosion
and rerolls), `faces(dice)` (number of dice in the expression, counting kept
and dropped), `sides(dice)` (a list of the sizes of each die, so a mixed pool
is a list, not an error; a Fudge die counts as 3).

### 2.3 Errors

| Error | When |
|---|---|
| `#NAME` | A bare name or dot-access names a cell the object does not have, or an unknown function. |
| `#REF` | Reading or following a reference to a deleted object (2.4), or `obj()` finding nothing or more than one match. |
| `#TYPE` | An operator or function received a value it does not accept. |
| `#DIV0` | Division or remainder by zero. |
| `#CYCLE` | This cell is in a dependency cycle. See 7. |
| `#LIMIT` | Evaluation exceeded its budget. See 7. |
| `#SYNTAX` | The formula source does not parse (3.2). This includes exceeding the parser's limits (AST depth 256, 10,000 AST nodes) and a numeric literal that converts to a non-finite number. |

Errors propagate through any expression that uses them, except `iserror(x)`
and `if(iserror(x), fallback, x)`. The inspector shows the message and the
cell where the error originated; that origin is preserved through
propagation.

**Lists never contain errors.** Building a list from an error item yields that
error. When several operands or items are errors, the first in evaluation
order wins: left to right, and in list order.

### 2.4 Encoding and deleted references

The language's values are the tagged encoding of FIXTURES.md §2, plus the
shape value `{type:"shape", shape}` and the error value
`{type:"error", code, message?, origin?: {object, cell}}`. Errors are never
storable: a cell holds a literal or a formula, and an error is only ever a
result. Operation records and the file reuse these types unchanged.

A reference to a deleted object read from a cell, directly or inside a list
or a viewers value, makes the whole read `#REF`. Visibility computed from such
a read fails closed (7; DESIGN.md 4.4).

## 3. Names, scope, and references

- A **bare name** is a cell on the current object: `max_hp` means
  `this.max_hp`.
- `this` is the object the formula lives on. Inside `where`, `sort`, and
  `each`, `this` still means the enclosing object, and the item is `it`.
  Inside a nested `where`, the inner `it` shadows the outer; name the outer
  explicitly by binding it in a cell if both are needed.
- **Bare names inside `where`, `sort`, and `objects`** resolve only against
  the item's cells, with no fallback to `this`; write `this.x` for the
  enclosing object. A bare name when the item is not a reference is `#TYPE`.
  `it` works for any item.
- **Dot-access** follows a reference: `target.ac`, `owner.attack_bonus`.
  Dot-access on `empty` is `empty`: a blank, not a typo. `dc = caster.spell_dc`
  with no caster is blank, so guards test emptiness explicitly
  (`target != empty`).
- Cell names are `snake_case` identifiers: letters, digits, underscores, not
  starting with a digit. A cell's display label may be anything. A name that
  is not a valid identifier is written in backticks: `` `Max HP` ``.
- `obj(x)` finds an object by id or name: an exact id match wins; otherwise
  `x` must exactly match the literal `name` of exactly one object, else
  `#REF`. The evaluating cell depends on the `name` cell of the object found
  and on the index (7). `obj` exists for the GM and agents; templates should
  use reference cells instead.
- `objects(expr)` ranges over every object in the document, including
  contained objects and templates.

### 3.1 Structural cells every object has

Readable like any other cell. Those marked *protected* cannot be set by a
formula or an override, only by the engine through moves and spawns, because
they carry the invariants of the table.

| Cell | Type | Default | Notes |
|---|---|---|---|
| `id` | text | allocated (DESIGN.md 4.1) | *Protected.* Stable, never reused. |
| `name` | text | `empty` | Literal only: a formula on `name` is refused by the store. |
| `tag` | list of text | `[]` | Literal only: a formula on `tag` is refused by the store. |
| `visible_to` | viewers | `all` | Own visibility; effective visibility is composed (DESIGN.md 4.4). An absent cell reads as `all`. |
| `owner` | reference or empty | `empty` | A character. |
| `template` | reference or empty | `empty` | The template this was spawned from. Set on every spawned copy; never a formula. |
| `contents` | list of references | `[]` | *Protected as to membership.* The objects this one owns. Changed only by `move`, `spawn`, `remove`, `shuffle`. |
| `container` | reference or empty | `empty` | *Protected, derived.* The object whose `contents` holds this one. |
| `board` | reference or empty | `empty` in a container | *Protected.* Empty when inside a container. |
| `position` | list of two numbers `[x, y]` | `empty` in a container | Present exactly when the object is on a board. Board units, x to the right, y down. May hold a formula (a token that follows another); a cycle through geometry yields `#CYCLE` like any other. |
| `rotation`, `z` | numbers | `empty` | `rotation` is degrees clockwise on screen about the anchor. Geometry and query order read an empty `rotation` or `z` as 0. Absent when inside a container. May hold formulas, like `position`. |
| `face_up` | boolean | `true` | |
| `shape` | shape | `empty` | For zones: the region. For others: the outline. Not writable by actions or cell writes: `set` on `shape` is refused. It changes only through the `setShape` edit primitive the UI and the agent use, which stores a literal shape value: `shape` is literal only, like `name` and `tag`. |
| `opaque` | boolean | `false` | Zones only. See DESIGN.md 4.4. |
| `is_zone` | boolean | `false` | *Protected.* True for zones: `shape` is then a region and spatial queries apply. |

The Default column is what an object has when it is created without that
cell. `is_template` and `is_character` are not cells: they are fields of the
object, false by default, and formulas do not read them (DESIGN.md 4.1).

**Writing structural cells.** `tag` is literal only (above); `set(tag, list)`
is allowed and writes a literal list. `shape` is written only through
`setShape`, which stores a literal; the value it reads as in a formula is the
shape value of 2.
`template` is set on every spawned copy and is never a formula. That `name`
is literal only is stated above and in 3.

**Landing on a board.** Every `move` or `spawn` onto a board, including a move
within the same board, puts the object on top: its `z` becomes 1 + the
largest literal `z` among the other objects on that board (an absent or empty
`z` counts as 0, and an overridden formula `z` counts as literal, as in the
candidate set of 6), unless the object's `z` holds a formula, which is left
alone. `position` is written as a hand edit writes it, so a formula
`position` gets an override. A move from one board to another keeps
`rotation`. Entering a container deletes `position`, `rotation`, and `z`; the
deletion is recorded, so undo restores any formulas they held. After a move
to a board, `container` is empty.

### 3.2 Syntax

A formula is one expression. Source that breaks a rule below does not parse,
and the cell is `#SYNTAX` (2.3).

- **Whitespace** (space, tab, newline, carriage return) separates tokens and
  is otherwise ignored. There are no comments.
- **Numbers** are digits, or digits `.` digits: no exponent, no leading or
  trailing `.`. A number immediately followed by a letter, digit, or `_` is a
  syntax error (`2x`, `1e5`). A numeric literal that converts to a non-finite
  number is a syntax error.
- **Text** is double-quoted. The only escapes are `\"` and `\\`; any other
  backslash sequence is a syntax error. Literal newlines are allowed.
- **Identifiers** are `[A-Za-z_][A-Za-z0-9_]*`, case-sensitive. A backtick
  name is any non-empty text without a backtick; it is always a name, never a
  keyword or dice.
- **Reserved words**: `true`, `false`, `empty`, `this`, `it`, `all`, `gm`,
  `and`, `or`, `not`, `has`. `all` and `gm` are viewer literals; `all(...)` is
  the aggregate call. `desc` is contextual: it is recognised only as
  `.sort(e, desc)` and is otherwise an ordinary name. `owner` is an ordinary
  name: in a formula it is always the `owner` cell, never the symbolic
  `"owner"` entry of a stored viewers literal.
- **Dice literals** are one term in the dialect of 2.2: an optional count,
  `d`, sides or `F`, then modifiers. A dice literal wins over a number or an
  identifier when the character after it is not a letter, digit, or `_`. So
  `d6`, `dF`, and `d20kh1` are always dice, and a cell named like dice needs
  backticks (`` `d6` ``); `d6x` is an identifier. `!` followed by `=` is never
  an explode: `1d6!=3` is `1d6 != 3`. `2d6+3` is a dice literal plus a number
  (2.2). A dice literal that lexes but breaks a limit of 2.2 (`0d6`, `1d6kh2`)
  is `#TYPE`.
- **Calls.** A call is an identifier (not a backtick name) followed by `(`,
  whitespace allowed, with comma-separated arguments: `max([a, b])`.
- **Methods.** The only methods are `.where(expr)`, with exactly one
  argument, and `.sort(expr)` or `.sort(expr, desc)`. Any other `.name(` is a
  syntax error. `.name` without a parenthesis is dot-access.
- **Lists** `[a, b]` and **records** `{name: expr, ...}`. Record field names
  are identifiers or backtick names; a duplicate field name is a syntax error.
  Lists, records, and calls take no trailing comma.
- **Precedence** is in 4.
- **Limits.** An expression's AST is at most 256 levels deep and at most
  10,000 nodes. Depth counts every nesting: each binary operator of a chain
  (`1+1+1` is two levels), each dot, call, or method of a postfix chain, each
  prefix operator, list, and record, and each pair of parentheses.

## 4. Operators and precedence

| Kind | Operators | Notes |
|---|---|---|
| arithmetic | `+ - * / %` | `/` is real division; `floor(a / 2)` for integer halving. `%` is remainder. |
| comparison | `= != < <= > >=` | `=` is equality. Nothing in a formula assigns. |
| logic | `and`, `or`, `not` | Words. Short-circuit. Return an operand. |
| membership | `has` | `list has item`. Equality per item. `has` with an `empty` left side is false. |
| text | `&` | Concatenation, converting numbers and booleans to text and roll results to their total. |

Precedence, loosest first: `or`; `and`; comparisons; `has`; `&`; `+ -`;
`* / %`; prefix `-` and `not`; postfix call, dot, and method. Binary
operators are left-associative. Prefix operators bind tighter than every
binary operator, so `not a = b` is `(not a) = b`, and postfix binds tighter
still, so `-a.b` is `-(a.b)`. Comparisons do not chain: a comparison whose
unparenthesized operand is a comparison (`a < b < c`, `a = b = c`) is
`#TYPE`; `(a < b) = true` is not chained.

**Equality.** `=` and `!=` never yield `#TYPE`, except on ink. Numbers and
text compare by value; references by identity; dice by normalized expression
(2.2); roll results by total, also against a number; lists elementwise and in
order; viewers as sets; shapes structurally. Values of different kinds are
unequal. `ink = x` is `#TYPE` unless `x` is `empty`.

**Ordering.** `<`, `<=`, `>`, `>=` are defined for numbers and roll results
(by total), and for text by Unicode code point, not UTF-16 unit. `empty` acts
as `0` against numbers and roll results and as `""` against text, and
`empty` against `empty` compares equal, so `save_roll + save_bonus >= card.dc`
works before a cell is filled. Anything else is `#TYPE`. `empty = 0` stays
false (2.1).

**Numbers.** IEEE doubles. `/` and `%` by zero are `#DIV0`; any other
non-finite result is `#TYPE`. `%` takes the sign of the dividend: `-7 % 3` is
`-1`. `round` is half away from zero: `round(-2.5)` is `-3`. `number(text)`
accepts `-?digits(.digits)?` after trimming whitespace, and is `#TYPE` for
any other text; a number passes through, a roll result gives its total, and
`empty` stays `empty`.

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
  evaluated, and only its dependencies are recorded. It returns the chosen
  branch's value unchanged: a roll stays a roll.
- `list.where(expr)` keeps items for which `expr` is true, with the item's
  cells as bare names and the item as `it` (3). There is no other filter form.
- `list.sort(expr)` and `list.sort(expr, desc)` order by the expression;
  ties keep the input order.
- **Errors are strict.** An error in a `where`, `sort`, or `objects`
  expression for any one item makes the whole result that error. A predicate
  naming a cell that some items lack is `#NAME`; filter by `tag` first.
- **Query order.** The results of `contents(zone)`, `zones_containing`, `on`,
  and `objects` are ordered by ascending `z` (`empty` is 0), then by `id` in
  code point order. The evaluator sorts, so every host agrees, and `on` comes
  out nearest first. The `contents` cell is not a query and keeps its stored
  order (`first(deck.contents)` draws the top card).
- A query sorts its candidates by `id` in code point order before reading any
  geometry or evaluating any predicate, and evaluates them in that order, so
  which error a query returns does not depend on the host.

## 6. Functions

Lowercase. All pure.

**Aggregates** take exactly one argument: a list, or any other value as a
one-item list, with `empty` as `[]`. `max(a, b)` is `#TYPE`; write
`max([a, b])`. Every aggregate except `len` skips `empty` items. `min` and
`max` return the winning item unchanged. `sum` of dice is `#TYPE`. `len` also
takes text, giving its length in code points.

| Function | Empty-list result |
|---|---|
| `sum` | `0` |
| `count` | `0` (items that are not empty) |
| `len` | `0` (all items) |
| `min`, `max`, `avg` | `empty` |
| `any` | `false` (true if any item is truthy) |
| `all` | `true` (empty items are skipped: `all([1, empty])` is true) |
| `first`, `last` | `empty` |

**Numbers:** `round(x, places=0)`, `floor`, `ceil`, `abs`, `clamp(x, lo, hi)`,
`number(x)` (4)

**Text:** `text(x)`, `upper`, `lower`, `join(list, sep)`, `len(text)`

**Errors:** `iserror(x)`

**Spatial and structural:**

| Function | Meaning |
|---|---|
| `contents(zone)` | Objects on the same board whose anchor lies inside the zone's region, excluding the zone. A point on the boundary is inside. Rotation of the zone and of the object are respected. Objects inside containers are not on a board and never appear. |
| `zones_containing(obj)` | Zones on the object's board whose region contains its anchor. |
| `on(obj)` | Objects whose footprint overlaps `obj` and that are above it in `z`, nearest first. Inferred from geometry, not stored. A shapeless object has a point footprint; a point footprint inside the other object's footprint counts as overlapping, the one exception to positive-area overlap. |
| `distance(a, b)` | Euclidean, between anchors, in raw board units. `empty` if either object is not on a board or has an invalid position. `#TYPE` across boards. Grid metrics and `unit` are open (11). |
| `objects(expr)` | Every object in the document, including contained objects and templates, where `expr` is true, with the candidate as `it`. Budgeted (see 7). |
| `obj(name_or_id)` | See 3. |

An object whose `position` is not two finite numbers is excluded from
`contents`, `zones_containing`, and `on`, but not from `objects`.

**How spatial queries are computed.** The host supplies candidates; the
evaluator computes membership, overlap, and distance with the schema
geometry. The candidate set is defined over literal geometry and does not
depend on the host: every object placed directly on the board whose literal
index bounds (the union of its footprint bounds and its anchor, expanded by
the geometry epsilon) intersect the query bounds, plus every object on the
board with any formula-valued geometry cell (`position`, `rotation`, `z`,
`shape`; a cell with an override counts as literal) regardless of bounds. The
host never evaluates formulas. The evaluator reads each candidate's geometry,
in `id` code point order, through ordinary recorded reads. An error from a
geometry read, including `#CYCLE`, becomes the query's result; a successfully
evaluated value that is not a valid position excludes the object. A spatial
index is only a way of computing that set.

**The geometry.** The schema geometry above is one pure module,
`packages/schema/src/geometry/`, shared by the evaluator, the authority's
spatial index (which computes exactly the candidate set above), and the
opaque-cover test (DESIGN.md 4.3, 4.4). (`shape` is literal only, 3.1, so the
candidate set's formula-valued `shape` case never arises.) Its rules:

- Point membership is boundary inclusive within 1e-9 board units, for every
  shape. For a circle the test is distance-based:
  `sqrt(dx² + dy²) <= r + 1e-9`.
- Two footprints overlap when their intersection has positive area; shapes
  that touch, or penetrate by at most 1e-9 (near-tangent), do not overlap. The
  point-footprint exception in the `on` row above is the only one: a point
  overlaps a shape when it is in the shape's region, boundary inclusive, and
  two points never overlap.
- Zones are never in an `on` result.
- Polygons must be simple.

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
  `z`, `board`, `tag`, `container`, `is_zone`, `name`, and by creation and
  deletion. A die that enters a tray therefore recomputes the tray's sum even
  though it was not a dependency before.
- **Propagation** is lazy pull with dirty marking. A commit marks dependents
  dirty once; nothing recomputes until it is read. The authority decides which
  cells to recompute and send. After each commit the authority recomputes
  what the changed subscribed views need (their cells, those cells'
  dependencies, and the visibility and geometry inputs of those views) and
  sends the views that changed; every other dirty cell stays dirty until read.
- **Viewer-independent.** Queries and formulas see the whole document. What a
  viewer may *see* is applied afterwards, to presentation. `contents()` never
  filters by visibility.
- **Consuming `visible_to`.** Visibility code converts the evaluated
  `visible_to` with `toViewers`: a viewers value as is, a reference to a
  character as a one-entry set, a list of references and viewer sets as their
  union. Anything that fails conversion (`empty`, an empty list, an error,
  any other kind) admits nobody; the GM sees everything regardless. So
  `visible_to = owner` and a list of character references work as 2 says.
- **Whole-document.** An object that the renderer has not loaded still exists
  for evaluation. Unloaded is never absent.
- **Cycles.** A cell that depends on itself, through any chain including
  geometry and queries, evaluates to `#CYCLE`, as does every cell in the
  cycle. Cells that merely depend on the cycle receive the propagated error.
  When an edit breaks the cycle, every affected cell recomputes.
- **Budget.** Each formula evaluation may spend 20,000 units. Each cell read,
  each existence check, each candidate a spatial query tests, and each id that
  `objects()` or `obj()` enumerates costs 1. Reading an already computed
  dependency costs 1 regardless of its own cost. Because the candidate set is
  defined over literal geometry (6), the charge is the same on every host.
  Exceeding the budget yields `#LIMIT` for that cell only. `objects()` over a
  very large table is the usual cause.
- **No depth limit.** The engine resolves dependencies iteratively, evaluates
  each dependency formula at most once per revision, and gives identical
  results across cold and warm caches and across read orders. A long chain of
  dependencies is never an error.

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
| `move(ref, destination)` | Remove the object from its container or board and place it at the destination, atomically. Moving onto a board ends containment; a move never changes `owner`. Placement follows the landing rule of 3.1. Refused if it would create a containment cycle. |
| `spawn(template, destination, {cell: expr, ...})` | Copy the template subgraph (the template and its `contents`, transitively), remap internal references, keep external ones, set the given cells, set `template`, place at the destination. Ids, flags, what is copied, remapping, and order are specified in DESIGN.md 4.1. |
| `remove(ref)` | Delete the object and its `contents`, recursively. References to it elsewhere become `#REF`. |
| `shuffle(ref)` | Randomly reorder the object's `contents`. |
| `each(list, step)` | Run one step per item of the snapshotted list, with the item as `it`. One level only; `each` inside `each` is not allowed. |

**Spawned copies** (DESIGN.md 4.1). Each copy gets an id `<original id>_<n>`
from the document counter, never a reserved id. Every copy's `template`
refers to its own original; the root copy is not a template, and descendants
keep their `is_template`. `is_zone`, `is_character`, `tag`, `shape`, actions,
and per-cell visibility are copied. A reference in a copied cell value or in
per-cell visibility that names an object in the copied subtree points at that
object's copy; other references are kept; formula source is copied verbatim.
Initial cells may be literals or formulas. A container destination appends,
so `each(targets, spawn(save_row, this, ...))` creates rows in the order of
`targets`.

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
