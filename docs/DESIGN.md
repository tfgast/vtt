# Design Document: A Table of Dumb Objects

> **Thesis:** a shared table of dumb objects that can be made smart, rather than smart objects that can't be made dumb.

This document captures the vision for the project. It is meant to be read before
making design decisions during development, and to be updated when a decision
changes. It is not an implementation plan. See the Decision Log at the end for
what has been settled and the Open Questions for what has not. The formula and
action language is specified separately in [FORMULAS.md](FORMULAS.md).

---

## 1. The problem

Current virtual tabletops (Foundry, Roll20, and their peers) are built around
*typed, special-purpose* objects. A die can only be rolled. A token is a
database row with a picture. A character sheet is a form over a schema. Each
thing does one job well and cannot be bent to do another.

At a physical table, everything is just *stuff*, and the people at the table
assign meaning to it. A spin-down die next to a miniature becomes an initiative
tracker. A coin becomes a marker for "this door is open." The margin of a
character sheet holds the note that doesn't fit any field. A dry-erase grid
becomes whatever map the GM needs in the next thirty seconds.

The Angry GM's article ["Two Things I Hate About Virtual Tabletops (And One
Thing I Love)"](https://theangrygm.com/two-things-i-hate-about-virtual-tabletops-and-one-thing-i-love)
names the costs of the typed approach:

- **Lack of versatility.** Virtual dice "can only be rolled like a die." Sheets
  are "just a visual representation of a database entry" with no margins.
  Improvised maps are high-friction compared to a dry-erase battlemap. Bending
  the tool requires code, which most GMs will not write.
- **Automapping and persistent map memory.** Explored areas stay visible,
  turning a dangerous unknown space into a board game. The GM cannot choose
  otherwise.

And names the one thing worth keeping that a physical table cannot do:

- **Individualized line of sight.** Each player sees only what their character
  sees. The asymmetry does emotional work ("the crushing weight of the
  darkness") without the GM saying a word.

Underneath these is a philosophy this project adopts: tools should support the
DIY, adapt-on-the-fly tradition of GMing rather than block it, and a GM should
be able to modify the tool through ordinary interaction, not programming.

## 2. Inspirations

Three software lineages, each supplying one layer:

| Lineage | What it gives us | What it gets wrong on its own |
|---|---|---|
| **Tabletop Simulator** | Physicality. Objects exist, can be grabbed, stacked, flipped, hidden in a hand, put anywhere. Nothing stops you putting a die on a token. | 3D is clumsy for most RPG play. Almost no automation. |
| **Virtual whiteboards** (Miro, tldraw, Excalidraw) | Infinite freeform canvas. Drawing, text, zero-friction "I need a thing here right now." Answers the improvised-map and margin-notes complaints. | No notion of game state. Nothing computes. |
| **Spreadsheets** | The automation model. Formulas live in visible, editable cells. Computation sits *on* the data, not in hidden code. Anyone can click a cell and see why it says what it says. | No spatial layout, no objects, no hidden information. |

And one non-software lineage: **the physical table itself.** Dice, index cards,
minis, the GM screen, the binder, the dry-erase grid. When in doubt about how
something should behave, ask how it behaves on a real table, then ask whether
the virtual medium lets us keep that behavior while removing its cost.

## 3. Principles

1. **Everything is an object, and objects are dumb by default.** A die, a
   token, a card, a sticky note, a character sheet, a map tile, a zone are all
   the same kind of thing with different defaults. Meaning is assigned by the
   people at the table, not the software.
2. **Smartness is added, visible, and removable.** Automation is expressed as
   formulas on cells and as short lists of action steps, both of which the GM
   can read, edit, and delete in the UI. There is no automation that cannot be
   inspected. Rules that should persist live in the table document, never only
   in an attached agent.
3. **Physicality over simulation.** Objects have position, stacking order,
   facing (face up / face down), containment, and ownership. They do not have
   mass, momentum, or collision. Snapping and stacking yes, tumbling no.
4. **Hidden information is a first-class concept.** Face-down, in-hand,
   GM-only, and per-character visibility are core, because asymmetry is what
   the virtual medium does better than the physical one.
5. **The GM can always override.** Any computed game value can be overwritten
   by hand. Any rule can be ignored. The software proposes; the table disposes.
   Structural invariants (identity, single-parent containment) are protected,
   because without them the table stops being a table.
6. **Agents are authors, not oracles.** An AI agent helps the GM build and
   modify the table's rules and content. It does so through the same model the
   GM sees, so its work is inspectable and editable like anyone else's.
7. **One canonical schema.** The table has one data model. The file is a
   lossless, readable, text serialization of it. The agent API is a set of
   validated queries and commands over it. The UI renders it. Nothing lives
   only in the UI, only in the file, or only in the API. A diff of a table
   should be meaningful.
8. **Design for many, build for one.** V1 is single-GM. The architecture must
   not foreclose multiplayer, very large maps, or long campaigns. Performance
   work can be deferred; the data-access contract cannot.

## 4. Core model

### 4.1 Objects

The atomic unit. An object has:

- **Identity.** A stable id, never reused (see **Identity** below).
- **Placement.** Either a position on a board (with rotation and z-order), or
  a place inside exactly one container. Never both.
- **Facing.** Face up or face down.
- **Cells.** A named set of values. Each cell holds a literal or a formula,
  and may carry an override and a per-cell visibility. Image, shape, color,
  ink, tags, visibility, and the owning `contents` list are all cells.
- **Actions.** Named lists of steps (see 4.5).
- **Face layout.** Which cells and buttons appear on the object's surface,
  where, and under what conditions. The face is data (the object field
  `face`), part of the template, and editable. See 4.6.
- **Flags.** `is_template` and `is_character`, both false by default. They
  are fields of the object, not cells (FORMULAS.md 3.1), so formulas do not
  read them. A spawned copy carries both from its original, except that the
  root copy's `is_template` is false (see **Templates and copying**).

Cell values can be numbers, text, booleans, lists, dice expressions, roll
results, **ink** (freehand strokes, so scrawl in the margin travels with the
object; an object's own ink is its cell `ink`, 4.6), and **references to
other objects**.

**Containment.** Every object has one owning cell, `contents`, which is a list
of the objects inside it. An object is inside at most one container, and the
relationship is acyclic. `container` is the derived inverse and cannot be set
directly. Moving an object removes it from its old container or board and puts
it in the new one, atomically. Removing an object removes its contents,
recursively. All other reference cells (`target`, `owner`, `attacker`) are
non-owning: they point, they do not hold, and deleting the referenced object
turns them into `#REF`. A cell can hold objects only via `contents`; a cell is
never itself an object. **Objects on a board are owned by nothing**: no
`contents` list holds them. Moving an object out of a container onto a board
ends the containment. A move never changes the `owner` cell: a card dragged
out of Aldric's hand onto the table still belongs to Aldric. An object that
deploys another onto the board (a spell card and its zone) keeps a non-owning
reference and cleans up explicitly in its Discard action.

**Removal.** Removing an object removes it and its contents, recursively, as
one subtree. References to any removed object from elsewhere are left in
place and dangle: reading one evaluates to `#REF` (FORMULAS.md 2.4). Undoing
the removal restores the whole subtree, under the same ids, so the dangling
references resolve again.

**Characters.** An object is a character when its `is_character` flag is
true. The "view as" list (4.4) offers every object with `is_character` true
and `is_template` false. Viewing as an object that is not a character shows
nothing; the GM sees everything. The `owner` cell is not validated against
the flag: it may point at any object, and visibility resolves it as 4.4 and
FORMULAS.md 7 say. Fixture runners (the M1 test host and the M2 scenario
runner) set `is_character` for the ids listed in a scenario's
`setup.characters` (FIXTURES.md 3).

**Identity.** Boards and objects share one id namespace. An id is reserved for
the document's lifetime once it is allocated, whether it named a board or an
object, and is never handed out again. The document keeps a counter,
`next_seq`, and a set, `retired_ids`; `next_seq` only increases and
`retired_ids` only grows. User undo never decreases the one or shrinks the
other:

- Creating a board allocates its id. Undoing the board's creation removes the
  board and retires its id.
- Undoing an object's creation (a spawn or a create) removes the objects and
  retires their ids.
- Undoing a removal restores the objects under their own ids. Those ids stay
  in `retired_ids`, so allocation still never hands them out.

Only historical rewind, which replays or rewinds recorded effects from a
snapshot (section 7), resets `next_seq` and `retired_ids`, because it
reconstructs a past document exactly.

An object created without an explicit id is allocated `<base>_<n>` the way
spawn allocates copies (below): `n` from `next_seq`, skipping any reserved
id. The base is the creator's `id_base` (the UI passes the kind it creates:
`token`, `card`, `note`, `zone`, `image`), else `obj` (docs/PROTOCOL.md §5).

There are no built-in object classes. "Die," "token," and "character sheet"
are *templates*: objects (often with contents) that are copied. A d20 template
is an object with a `value` cell, a `modifier` cell, a `total = value +
modifier` formula, a face that shows `total`, and a Roll action. Nothing stops
the GM from typing a value into it and using it as a counter, which is the
whole point.

**Templates and copying.** Spawning from a template copies the template and
everything in its `contents`, transitively. References among the copied
objects are remapped to the copies; references to anything outside are kept.
The copy's `template` cell points back at the original. Initial cells
(`owner`, `target`) are set at spawn time. So the character template owns a
sheet and a binder, and dragging it out produces a character with its own
sheet and binder; the Fireball card template owns a zone object in the binder,
and the card on the table gets its own copy of the zone to drag onto the map.

Spawn, precisely (also FORMULAS.md 8.3):

- **Ids.** Each copy gets a generated id `<original id>_<n>`, where `n` is
  drawn from the document counter `next_seq`, skipping any reserved id
  (**Identity** above). `goblin` spawns as `goblin_7`.
- **Template.** Every copy's `template` refers to its own original: the root
  copy to the template spawned, each descendant to the object it was copied
  from.
- **Flags.** The root copy has `is_template` false; descendants keep their
  originals' `is_template`. `is_character` is copied.
- **What is copied.** Every cell, plus `is_zone`, `tag`, `shape`, actions,
  the face layout (4.6), and per-cell visibility (4.4). Formula source and
  the face layout are copied verbatim, never rewritten (a face names cells
  and actions, not objects).
- **Remapping.** A reference inside a copied cell value (directly, in a list,
  or in a viewers value) or inside per-cell visibility that names an object in
  the copied subtree is remapped to that object's copy; any other reference is
  kept.
- **Initial cells** may be literals or formulas, and replace what was copied
  into the root copy. A `spawn` step's record gives evaluated values; a
  formula initial cell comes only through the protocol's `spawn` op
  (FORMULAS.md 8.3).
- **Order.** A container destination without an index appends, so successive
  spawns into one container within one transaction append in call order.

### 4.2 Cells and formulas

Cells behave like spreadsheet cells:

- A cell holds a literal or a formula.
- Formulas are reactive. Change an input and dependents recompute.
- Formulas reference cells on the same object by bare name (`max_hp`), on
  other objects through reference cells (`target.ac`), and on the spatial
  structure of the table (see 4.3).
- Every formula is visible and editable in the UI via a formula bar. The GM
  can click any value and see the formula that produced it.
- A computed cell can be manually overridden. The override is visible as
  such, and the cell stops following its inputs until the override is cleared.
  Overriding `hp` means later damage will not show until the override is
  cleared; the inspector says so. Replacing the formula itself with a value
  is a separate, explicit command (4.6, **Typing into a cell**), not an
  override.
- A formula may depend on cells the viewer cannot see. The viewer sees the
  result but not the input. An attack card's `hit = total >= target.ac` shows
  hit or miss without revealing AC. Whoever writes a formula is a trusted
  author deciding what it publishes. In v1 only the GM and the agent write
  formulas and actions; finer rights are a multiplayer concern (see 8.2).
- **Derived state is formulas; accumulated state is written by actions.**
  `hp = max_hp - damage_taken` is a formula. `damage_taken` is a literal that
  an Apply action adds to. Damage is history, and history cannot be a formula
  over dice that will be picked up and rolled again. HP, conditions, spell
  slots, and used reactions all follow this shape.

The language is specified in [FORMULAS.md](FORMULAS.md), including the
evaluation model: evaluation against a consistent document revision, lazy
conditionals, dynamically discovered dependencies, cycle detection with
recovery, and viewer-independent spatial queries.

### 4.3 Zones, boards, and spatial formulas

A **zone** is an object whose shape is a region: rectangle, circle, polygon, or
closed freehand. Zones may nest and overlap. Zones give the table spatial
semantics:

- `contents(zone)` returns the objects on the same board whose anchor point
  lies inside the zone's region. Anchor-point containment keeps "is it
  inside?" unambiguous even for a die half out of a box.
- `zones_containing(obj)` returns the zones whose region contains the object's
  anchor.
- Formulas compose these with filters:
  `sum(contents(this).where(tag has "die").value)` is a dice tray that totals
  itself.

Zones are the primary way rules attach to space. "Anything in difficult terrain
has half speed" is a formula on the token, not an event handler:

```
speed = base_speed / if(len(zones_containing(this).where(tag has "difficult")) > 0, 2, 1)
```

This keeps rules spreadsheet-shaped (declarative, always-true, inspectable)
rather than event-shaped (imperative, hidden, order-dependent). The "sum the
dice in this box" case is a priority and a benchmark.

**Zones and containers are different things.** A zone is geometric: membership
is computed from positions and never stored, and a zone has no effect on
visibility or ownership. A container (a stack, a hand, a binder, a tray cup)
is structural: membership is a fact in its `contents` cell, set by dragging in
or out or by an action. Objects inside a container are not on a board, have no
board position, and do not appear in any zone query. Both read the same way in
formulas, so a dice tray can be a zone (loose dice in a drawn box) or a
container (dice snapped into a cup). Spatial queries are limited to one board;
there is no cross-board geometry.

`on(obj)` returns the objects stacked directly on top of an object. Stacking
is inferred from overlap and z-order; it is not a container relationship, and
moving a token does not carry the die sitting on it. Zones are never in an
`on()` result.

**Where the geometry lives.** Exact spatial semantics live in one pure module,
`packages/schema/src/geometry/`: point membership, overlap, distance, and the
opaque-cover test (4.4) all use it. The evaluator computes membership,
overlap, and distance with it; the host only supplies the literal-geometry
candidate set that FORMULAS.md 6 defines, and never evaluates formulas. The
authority's spatial index is how the authority computes exactly that set; it
accelerates and never decides.

**Tolerance and overlap.**

- Point membership is boundary inclusive within 1e-9 board units, for every
  shape. For a circle the test is distance-based: a point is inside when
  `sqrt(dx² + dy²) <= r + 1e-9`.
- Two footprints overlap when their intersection has positive area. Shapes
  that only touch, or penetrate each other by at most 1e-9 (near-tangent), do
  not overlap.
- The one exception: a point footprint (a shapeless object) overlaps a shape
  when the point is in the shape's region, boundary inclusive. Two points
  never overlap.
- Polygons must be simple (no self-intersection).

**Boards.** A table may have several boards: the shared one, a GM board,
others as needed. Boards are navigation and organization (think tabs or named
places), not a security mechanism. Objects can be moved between boards. For
very large maps, boards also serve as named anchors to jump to. A board can be
removed only when no object is directly on it; removal never cascades. Its id
stays reserved for the document's lifetime (4.1): undo re-creates the board
under the same id, and no new board may take it.

### 4.4 Visibility and hidden information

Every object has a `visible_to` cell whose value is a set of **characters**,
or `all`, or `gm`. Visibility is stated in terms of characters, which are
objects on the table, not in terms of people connected to the software. "Who
can see this" is the in-fiction question "which characters can see this,"
which is what the GM is actually deciding. Ownership works the same way:
`owner` points at a character, and binders, dice, hands, and cards belong to
characters. The GM is not a character; the GM is the one principal in v1, sees
everything, and owns the GM binder and GM board.

An absent `visible_to` reads as the default, `all`. A present cell's
evaluated value is converted with `toViewers` (FORMULAS.md 7), so
`visible_to = owner` and a list of character references both work; a value
that fails the conversion admits nobody. The `owner` entry of a viewer set
resolves against the object that holds the viewer set.

People are a later layer: a participant controls one or more characters and
sees the union of what those characters see. Union is a deliberate policy, not
individualized secrecy between a player's own characters. V1 has exactly one
person, the GM, who can switch to **view as** any character to check what that
character would see (in the UI: 4.6, **View as in the UI**). Multiplayer
changes who may drive a character and adds a rights model; it does not change
what is on the table.

**Effective visibility** is composed, and the composition is the whole rule:

- An object's effective visibility is its own `visible_to` intersected with
  its container's effective visibility, recursively. A card marked `all`
  inside a hand marked to one character is seen only by that character. Moving
  it out of the hand restores `all`, because the card's own cell never
  changed.
- A cell may carry its own `visible_to`, defaulting to its object's. A public
  goblin can have public HP and GM-only AC. A cell is visible to a viewer only
  if its object is (including the opaque cover below); then the cell's own
  visibility and the face-down rule apply.
- A face-down object shows its back, its placement, and its `name` to anyone
  who can see the object; every other cell has its visibility intersected
  with its owner. All restrictions intersect; none replaces another. A
  face-down object owned by Aldric with a GM-only AC cell shows AC to no one
  but the GM. The GM always sees everything. In v1 every face-down object is
  drawn with a generic back (4.6, **Appearance cells**).
- Zones do not affect visibility. If a region should hide what is in it, it is
  a container with a region-shaped face, not a zone. The GM screen is such a
  container.
- Dependency tracing, the inspector, the log, and the agent's query results
  are all filtered by the same effective visibility when shown to a viewer.
  Errors fail closed: if visibility cannot be computed, the object is hidden.

**Per-cell visibility** is metadata of the object, `cell_visibility`: a map
from cell name to a viewer set, independent of cell content. An entry is valid
for any user or structural cell name, including a cell that is absent and a
field-backed one (`tag`, `contents`, `position`, …). Values are literal viewer
sets, never formulas. A cell with no entry defaults to its object's
visibility.

**Every evaluated visibility input fails closed.** For any viewer but the GM:

- a `face_up` that is an error or not a boolean is treated as face down;
- an `opaque` that is an error or not a boolean is treated as opaque;
- a zone whose geometry (`board`, `position`, `rotation`, `shape`) cannot be
  read or is invalid, and which the viewer cannot see, is treated as covering
  every object on its board.

The GM is unaffected by all three.

**Opaque zones (fog as an object).** Per-object visibility cannot hide part of
a single map image. So a zone may be **opaque**: a viewer who cannot see the
zone sees its region drawn as a solid cover over everything beneath it,
including objects they could otherwise see. A dungeon is one image with six
opaque room zones; revealing a room is setting the zone's `visible_to`. This
is fog of war without a fog system. Splitting the map into separate room
images also works and needs no special mechanism.

Cover is independent of `z`. An object is covered for a viewer when it is on
the same board as an opaque zone the viewer cannot effectively see and its
anchor lies in the zone's region (with the tolerance of 4.3). An object inside
a container is covered when its outermost container is. A zone never covers
itself. A covered object is not visible to that viewer. The renderer still
draws the cover, above every object on the board and every object-related
overlay; only viewer-independent chrome is drawn above it, and the in-place
editor never shows over it (4.6, **Appearance cells**).

**What a viewer is sent** (docs/PROTOCOL.md §7, §9). Every view, query
result, log entry, and explanation computed for a character applies the same
effective visibility:

- **Redaction.** A reference to an object the viewer cannot see (or to an id
  that is neither a live object nor a board) is replaced in place by the
  wire-only value `{type:"redacted"}`, at the top level, in lists at any
  depth, and in viewers values, so a visible hand's `contents` keeps its
  count without leaking ids. A reference to a board is never redacted, since
  boards are not a visibility boundary (4.3). An error whose origin the viewer
  cannot see keeps only its code.
- **Covers.** For each opaque zone on a board in scope that the viewer cannot
  effectively see, the view carries a cover (the zone's region, or the whole
  board when its geometry is undetermined) under a key that does not reveal
  the zone's id; the zone and the objects it covers are absent.
- **The log** is filtered by current visibility, effect by effect: what the
  viewer can see now, object names only where the viewer can read the `name`
  cell, an object that no longer exists counted as invisible, groups with
  nothing left omitted. The header is kept, but its label is shown only when
  every effect of the group other than id bookkeeping (`allocate`, `retire`)
  is visible to the viewer unreduced.
- **Explain** names hidden cells without their values and shows objects the
  viewer cannot see as unnamed (`object: null`); an explain target the viewer
  cannot see answers exactly as a nonexistent one does.

Everything else is built on these:

- **A hand** is a container visible only to its owner.
- **A binder** is a container visible to its owner.
- **The GM screen** is a container visible to `gm`.
- **Fog of war and line of sight**, when they arrive, are ways of *computing*
  `visible_to` from geometry rather than a separate system. See 6.

### 4.5 Actions

Some things are not formulas: rolling a die, drawing a card, shuffling a stack,
flipping an object, applying damage. These are **actions**: named lists of
steps attached to an object. Steps come from a fixed set (set, add, append,
roll, move, spawn, remove, shuffle, each). Actions are the only place anything
is written or rolled.

The contract:

- An action is **atomic**. Steps run in order, each seeing the writes of the
  ones before it. Any error aborts the whole action with nothing applied.
- An action may carry a **`when` precondition**. If it is false the action
  refuses to run and says why. This is what stops Apply from applying twice;
  show-when (4.6) only hides the button and is not an execution guard.
- Formulas recompute once, after the action commits.
- **One undo reverses one whole action**, including every row of an Apply
  All.
- Every action is logged as one entry with its steps as sentences, recording
  resolved values (what was rolled, what id was created), not instructions.

Actions appear on an object's face as **buttons**. The inspector shows an
action's steps and precondition and lets the GM edit them, exactly as it does
for formulas.

**Pressing buttons in the UI.** The UI never invokes an action on a template:
templates are not mutated by play (4.7), so a template's buttons (and the
inspector's Run) refuse with the reason; the agent may still invoke one. A
button press is the GM driving a character when one is known: in view-as
the invocation's actor is the viewed character; in GM view it is the
pressed object's **owning character** (M6-D15): the object itself if it is
a character; else its `owner` cell when that is a reference to a
character; else the owning character of its container, recursively; else
none, and the press is the GM's. So a working copy in Aldric's binder (its
`owner` Aldric) is pressed as Aldric from GM view, a goblin's die as that
goblin, and the GM binder's templates and loose dice stay the GM's. The log
records the actor, and what is shown stays the viewer's (the GM still sees
`ac`). Other edits remain the GM's (4.6, **View as in the UI**). Only the
UI's own presses resolve an owning character; an agent's invocations stay
the agent's (PROTOCOL §3). A disabled button (its `when` false or
an error) sends nothing and shows the reason. A press made while the
viewer's own earlier press on the same table is still unacknowledged is sent
after that acknowledgement, stamped past the earlier press when that press is
the only change since the second began, so two fast presses of Roll roll twice
and show no stale notice; a press another client's change got to first is
still stale (M6-D18, §7).

### 4.6 How cells are shown

The spreadsheet shows every cell all the time, which is why it is trustworthy
and why it is ugly. A token should look like a token. Cells therefore have two
presentations and a gradient between them.

**The face.** Each object's face layout places some of its cells on its
surface. A d20 shows `total` large in the middle. A token shows `image`, with
`name` and perhaps an `hp` badge. A character sheet is a large face laid out
like paper, with dozens of cells and an ink margin. An index card shows `title`
and `body`. The face is what you see at the table.

**Edit in place.** Click a cell's editor element on the face, or
double-click its value element, to edit it there, like a spreadsheet cell or
a sticky note (**Gestures** below). Literals change directly. Formula cells
open in the formula bar. This is the path for most of play: change HP,
scribble a note, rename something.

**Zoom as level of detail.** The canvas is infinite, so zoom gives a free
gradient between glance and scrutiny. Zoomed out, a token is a small circle
showing only its image. Zoomed in, there is room for name, HP, and conditions.
The face layout carries rules of the form "show this element above this
size": an element's `min_size`, the minimum on-screen height of its rect in
CSS px, applied by the UI. A value element without `min_size` (a badge) is
drawn at any zoom, never smaller than an 8 CSS px font (M6-D17). A character
sheet is an object you literally lean into. This avoids most modal windows.

**Face elements.** A face layout is a list of elements. V1 needs four kinds:
a cell shown as its value; a cell shown as an in-place editor; a **button**
bound to an action; and a **contents** element that renders the objects in
this object's `contents` inline, each drawn with its own face. The contents
element is one mechanism serving three needs: the rows of a multi-target card,
the entries in a binder, and the cards in a hand. Every element can carry a
**show-when** condition: a formula over the object's cells only, evaluated by
the authority and sent to each viewer as a boolean. The two presentation
inputs are not formula inputs: zoom is the element's `min_size`, applied by
the UI, and the collapsed input is the separate collapsed element list. They
are local to a viewer, are not cells, and cannot be read by game formulas.
Character views get neither the `show_when` source nor hidden elements nor
elements naming cells they cannot read. The layout stays deliberately
simple: elements at positions with sizes and show-when rules, nothing more.

**Collapsed face.** Every object can have a compact face, by default just its
`name`, used when it sits in a binder or a tight container. Expanding it shows
the full face.

**Face layouts** (the encoding; docs/PROTOCOL.md §5, FIXTURES.md §3). An
object's layout is its field `face?: FaceLayout`:

- `FaceLayout = {elements: FaceElement[]; collapsed?: FaceElement[];
  default_action?: string}`.
- `FaceElement` = `{type: "value" | "editor"; cell; rect; show_when?;
  min_size?; style?}` | `{type: "button"; action; rect; label?; show_when?;
  min_size?}` | `{type: "contents"; rect; entries?: "collapsed" | "full";
  show_when?; min_size?; when_selected?: boolean}`.
- `rect: [x, y, w, h]`, finite, `w`, `h` > 0, in board units in the
  object's unrotated local frame (origin at the anchor, y down). The
  full-face frame is the shape's bounding box (shapeless: `[-1, -0.5, 2,
  1]`); the collapsed frame is `[0, 0, 6, 0.6]`, scaled to the container
  row. A resize through the handles keeps the full face in proportion
  (M6-D14): the full list's rects are scaled by the new/old width and
  height of the shape's local bounding box, measured from its origin, in
  the same write; the collapsed list and `min_size` are unchanged.
- `style = {size?: "small" | "normal" | "large" | "huge"; align?: "left" |
  "center" | "right"; caption?: boolean}`.
- At most 200 elements per list and one `contents` element per list;
  `show_when` non-blank, at most 10,000 characters.
- `when_selected` (contents elements only, M6-D12) is a boolean; absent
  means unset. See **Only when selected** below.
- The whole layout is replaced by `set_face` (conflict key
  `face:<object>`), copied verbatim on spawn, and carried in create and
  remove snapshots; absent means no layout. There is no `schema_version`
  change.

The Attack card face:

```json
{"elements": [
  {"type": "value", "cell": "name", "rect": [-1.2, -1.7, 2.4, 0.4], "style": {"size": "large"}},
  {"type": "editor", "cell": "target", "rect": [-1.2, -1.2, 2.4, 0.4], "style": {"caption": true}},
  {"type": "value", "cell": "total", "rect": [-1.2, -0.7, 1.1, 0.5], "style": {"caption": true}},
  {"type": "value", "cell": "hit", "rect": [0.1, -0.7, 1.1, 0.5], "style": {"caption": true}},
  {"type": "value", "cell": "dmg", "rect": [-1.2, -0.1, 2.4, 0.4], "style": {"caption": true}},
  {"type": "button", "action": "Roll", "rect": [-1.2, 0.5, 1.1, 0.45], "show_when": "roll = empty"},
  {"type": "button", "action": "Roll damage", "rect": [0.1, 0.5, 1.1, 0.45], "show_when": "hit and dmg = empty"},
  {"type": "button", "action": "Apply", "rect": [-1.2, 1.1, 1.15, 0.45], "show_when": "dmg != empty"},
  {"type": "button", "action": "Discard", "rect": [0.05, 1.1, 1.15, 0.45]}],
 "default_action": "Roll"}
```

The Area save card face:

```json
{"elements": [
  {"type": "value", "cell": "name", "rect": [-1.2, -1.7, 2.4, 0.4], "style": {"size": "large"}},
  {"type": "editor", "cell": "caster", "rect": [-1.2, -1.25, 1.15, 0.35], "style": {"caption": true}},
  {"type": "value", "cell": "dc", "rect": [0.05, -1.25, 1.15, 0.35], "style": {"caption": true}},
  {"type": "value", "cell": "damage", "rect": [-1.2, -0.85, 2.4, 0.3], "style": {"caption": true}},
  {"type": "value", "cell": "targets", "rect": [-1.2, -0.5, 2.4, 0.3], "style": {"caption": true}},
  {"type": "contents", "rect": [-1.2, -0.15, 2.4, 1.1], "entries": "collapsed"},
  {"type": "button", "action": "Lock targets", "rect": [-1.2, 1.0, 1.15, 0.35], "show_when": "not locked"},
  {"type": "button", "action": "Roll damage", "rect": [0.05, 1.0, 1.15, 0.35], "show_when": "locked and damage = empty"},
  {"type": "button", "action": "Apply all", "rect": [-1.2, 1.4, 1.15, 0.3], "show_when": "damage != empty"},
  {"type": "button", "action": "Discard", "rect": [0.05, 1.4, 1.15, 0.3]}]}
```

**The inspector.** A side panel. Select an object and it lists every cell as
name and value, formulas shown as formulas with the computed result alongside,
overrides marked, and each action with its steps and precondition. Here cells
are added, removed, renamed, and given their own visibility; actions are
edited; broken references are repaired. A layout mode lets the GM drag cells
onto the face, which is how "I want HP visible on all these tokens" happens
without code.

**The formula bar.** One persistent bar, as in a spreadsheet, showing the
formula of whichever cell is focused, whether focused on the face or in the
inspector. It is where the focused cell's current formula source is shown
and edited. Formulas may also be typed anywhere a value is typed, with a
leading `=` (**Typing into a cell** below).

**Dependency tracing.** Hovering a formula highlights the objects and zones it
references on the canvas, filtered by what the viewer may see. Hovering a zone
highlights its contents. This is the spatial version of the colored outlines a
spreadsheet draws while editing a formula, and it is what makes an
agent-written formula legible to the GM.

**Who sees what.** The face and in-place editing of literals are for everyone
at the table, subject to ownership and visibility. The inspector, formulas,
and actions are GM and agent territory in v1.

**Appearance cells.** The renderer reads a few ordinary user cells by name.
They are not structural cells and have no defaults; formulas, overrides and
per-cell visibility apply to them as to any cell, so an agent hatches a zone
by setting its `pattern` cell to `"hatch"`.

| Cell | Value | Drawn as |
|---|---|---|
| `image` | text: an asset path relative to the table file, as listed in the file's `assets` (7, **Revisions and assets**) | the image, inside the object's shape |
| `color` | text: a CSS color | the fill |
| `pattern` | text: `"hatch"`; other values are ignored | `"hatch"` draws lines at 45° |
| `text` | any value | the value, shown compact inside the object |
| `name` | text (structural, FORMULAS.md 3.1) | the label below the object |

The inspector's row for a cell named `image` offers Upload…: it imports a
PNG, JPEG, WebP or GIF through `POST /assets` and writes the returned path
into the cell (one `set_value`, the revision captured at the click).

An appearance cell the viewer cannot read, or whose value is of the wrong
kind (an error, a `color` that is not text), is simply not drawn. Drawing
rules:

- A non-zone without `color` gets a neutral fill. A zone is transparent with
  a thin outline unless it has `color` or `pattern`.
- The GM sees an opaque zone with a 35 % dark fill and a dashed outline, and
  a badge on every object whose `visible_to` is not exactly `all`.
- A character sees a revealed opaque zone only through its `color` and
  `pattern`.
- Covers (4.4) are solid and drawn above every object and every
  object-related overlay (selection outlines, handles, highlights, drag
  ghosts, creation previews). Only viewer-independent chrome (the marquee
  rectangle, a cursor crosshair) is drawn above covers. The DOM in-place
  editor opens only when its screen rectangle intersects no cover of the
  current viewer, and closes without committing when a cover appears over it
  or the viewer changes.
- A shapeless object is a 10 px marker.
- A face-down object shows a generic back plus its `name` to everyone (the
  GM also sees a face-down glyph), because the face-down exemption set
  (docs/PROTOCOL.md §7.4, `FACE_DOWN_EXEMPT`) has no appearance cell.
  Per-object backs would need a cell in that set and are Later.

**Default rendering until faces.** Until face layouts arrive (M5), an object
draws its shape, `image`, `color`, `pattern`, `text` and `name` label. The
one level-of-detail rule: labels hide below 24 px on screen. Edit in place
covers `text`, or `name` when the object has no `text` cell. Dependency
tracing highlights the objects referenced by a hovered formula (from
`explain_cell`, with the current viewer) and a hovered zone's contents (from
`zones`, likewise), so both are filtered by the viewer (docs/PROTOCOL.md §9).

**Default face.** An object without a layout draws the default rendering
above plus its `ink` cell, a strip of its action buttons below its frame,
and a collapsed list of its contents below that; a template object on a
board also shows a gear (4.7).

**Only when selected** (M6-D12). A token's list below it clogs the board
and takes drops meant for the table, and neighbouring tokens' lists
overlap. A contents element with `when_selected: true` is drawn,
hit-tested and offered as a drop target only while its object, or an
object contained in it at any depth, is selected, or while a drag with Alt
held hovers the object (the Alt-drop-inside gesture, **On the canvas**
below). Otherwise, when `contents` is non-empty, the object draws a small
count badge in the element's place ("3", lower right, drawn at any zoom);
hit-testing never reaches the hidden list, and a plain drop there lands on
the board. Expanded entries in a hidden list keep their per-session
expanded state and reappear when the list does. Selecting the object (one
click) shows the list. The default layout of an object without a face sets
`when_selected: true` on its contents element, as do the stocked
`tpl_character` and `tpl_token` faces (4.7); binders, cards, hands and
sheets leave it unset. The inspector's Face section offers it as the
checkbox "Only when selected" on contents element rows. Its Create face
keeps the list: the generated layout always ends with a contents element
(`when_selected: true`, `min_size` 24) centred below its last row, placed
as the default face places its list, even while `contents` is empty
(M6-D19).

**Gestures.**

- A single click on an editor element edits that cell in place (a
  double-click there does nothing more). A double-click on an object's body,
  image or value element invokes its `default_action` when it has one and it
  is enabled (a disabled one counts as absent); otherwise a double-click on a
  value element edits that cell in place, and on the body the default edit in
  place. Each click on a button is one press; a double-click there adds
  nothing (M6-D9).
- Dropping an object on another object's editor element sets that cell to a
  reference to it (nothing moves). Dropping on a contents element inserts
  there (copy versus move is the intent fixed at drag start, M4-D8), except
  that dropping a template onto a binder's contents element gives a template
  (4.7).
- A drop resolves, in order, to an editor element under the pointer, else
  the innermost contents element under it (at the row's index, or the end),
  else the board.
- Contents elements scroll: a per-session, never-stored scroll offset per
  (object, element), changed by the wheel over the element (before any
  camera zoom), clipped to the element's rect. The wheel scrolls the
  innermost enclosing list that overflows. An entry expanded near the bottom
  is scrolled into view (the whole row when it fits, else its top aligned
  with the list's top).
- A collapsed entry shows its collapsed face (its own `collapsed` list, else
  its `name`). An expanded contained object is drawn exactly as on a board
  (its base drawing: shape, fill, image, text, label, face-down back, then
  its face), each scaled into its row.
- Clicking a row (or an expanded child's empty area) selects that contained
  object for the inspector.
- A cell dragged from the inspector onto an object adds a value element
  (layout mode).

**Ink and text.** Ink is the cell `ink` (strokes in object-local board
units, origin at the anchor, y down, unrotated), drawn with one fixed pen
(0.04 units, dark). The ink tool appends a stroke to the topmost object under
the pointer or creates an `ink_<n>` object (a transparent rect). The text
tool creates a `text_<n>` transparent rect with an empty `text` and opens
the editor.

**Typing into a cell.** The formula bar, the inspector and the in-place
editor share one input grammar:

- `name` input is always text, verbatim, even with a leading `=` (a formula
  on `name` is refused by the store, FORMULAS.md 3.1).
- In any other cell, a leading `=` makes a formula of the rest: formulas may
  be typed anywhere a value is typed. Input that does not parse is refused in
  the UI with the parser's message.
- `visible_to` also accepts `all`, `gm`, `owner` and `@id`, comma-separated,
  as a viewers value.
- Otherwise literal syntax (FORMULAS.md 3.2) is that value: numbers,
  `"quoted text"`, `true`/`false`, `empty`, dice expressions, and lists of
  literals. `@id` is a reference. Empty input is `empty`. Anything else is
  text, verbatim.
- A literal typed over a formula is an override (4.2).
- Replacing a formula with a value is an explicit inspector command. It
  writes `set_value` with `replace: true` (docs/PROTOCOL.md §5): one write
  from the formula (and any override) to the literal, also on structural
  cells such as `visible_to`.

**On the canvas.**

- Copy versus move is decided when a drag starts. Dragging exactly one
  selected template without Alt spawns a copy where it is dropped (4.7:
  dragging a template straight onto the table creates a copy there); with
  Alt it moves the template. Any other selection (several templates, or
  templates mixed with other objects) is moved, never spawned.
- For a non-template drag, Alt held at the drop onto an object (not a zone)
  puts the dragged objects into its `contents`; a plain drop places them on
  the board, where they stack (4.3).
- A click picks the first object under the pointer in hit order: objects
  other than zones, then zones, then backdrops (non-zones whose bounding box
  contains the bounding box of a zone under the pointer), each group by
  descending z, then later drawn first (M6-D10). So a token in a room is
  picked before the room, and the room before the map it lies on.
  Alt+click cycles through the objects under the pointer in the same order,
  so anything there can be selected. A double-click within 4 screen pixels
  of the cycle's point, over the same objects, acts on the cycled object
  instead of the first, so a covered zone is renamed in place;
  the cycle counts through the double-click's own two plain clicks, which
  still select the first object before the double-click selects it back
  (M6-D21).
- Objects move between boards with "Move selection to board…", not by
  dragging.
- Snap (M6-D13) is a per-session toggle, the toolbar's Snap checkbox next
  to Fog, on by default and never stored in the table. While it is on, a
  drag that moves or copies objects on the board lands the grabbed object's
  anchor on the nearest half-unit point (each axis rounded to a multiple of
  0.5), the rest of the selection keeping its offsets; an entry dragged out
  of a list onto the board (a template copy or a working copy) lands on a
  half-unit point the same way. Drops into a container, onto a contents
  list, an editor element or a binder are not snapped, and Alt at the drop
  does not change snapping. The renderer draws a faint grid of 1-unit lines
  under the objects, within the viewport, whenever a unit is at least 8 px
  on screen. Creation and handles snap too: a clicked token, card or
  note's anchor, a dragged rect zone's corners,
  a circle zone's centre and radius, polygon vertices and an image's anchor
  (its size stays the import's) land on half units, as do a resize handle's
  dragged point (a rotated rect is recomputed from it in its own frame), a
  circle's radius and a polygon vertex, never below the minimum sizes;
  rotation and the inspector are not snapped.

**View as in the UI.** View-as (4.4) switches the viewer of what is drawn,
inspected and traced. The inspector and formula bar are read-only there and
show the character's view. Canvas edits are still the GM's, except that a
button pressed in view-as invokes as the viewed character (4.5). The GM
need not view as a character to act as them: in GM view a button on an
object a character owns invokes as that character (4.5, M6-D15).

### 4.7 Procedure cards and the binder

Rules procedures (an attack, a damage roll, a saving throw against an area
effect) are **cards**: objects whose cells and buttons walk through the
procedure. An Attack card has `attacker`, `target`, `roll`, `bonus =
attacker.attack_bonus`, `total = roll + bonus`, `hit = total >= target.ac`, a
damage roll, an Apply action guarded by `when: hit and dmg != empty and not
applied` that writes damage and sets `applied`. A Fireball card comes with a zone
object (owned while in the binder, deployed onto the board in play, referenced
by the card's `zone` cell), has `dc = caster.spell_dc`, a live `targets`
formula showing who is inside the zone, and a **Lock targets** action that spawns one row object per
target into the card's `contents` and records that locking happened. Each row
is a small object with `target`, `save_roll`, a pass formula, and a damage
formula, owned by the target's owner so the right character rolls it. One
Apply All action, guarded, writes every row's damage. Rows are committed by an
action rather than derived by a formula because spawning objects is a write;
in the fiction, it is the moment the spell goes off, and nudging the zone
afterwards changes nothing. Because cards are ordinary objects, the GM or an
agent can open one in the inspector and change the rule. This is what makes
system-agnosticism real: a procedure is a template, not code.

**Procedure state** is explicit. A card knows whether it is unstarted, rolled,
applied. Actions check that state in their preconditions, and faces use it in
show-when. **The log is the record of what was applied.** A card's display is
live and may drift if its inputs change afterwards; a template that cares
freezes inputs with `set` at lock or apply time. No general freezing mechanism
is planned.

Cards live in a **binder**. Each character has one, and the GM has one. The
binder is a container, visible to its owner, whose contents show collapsed by
default, one heading per card. Binder entries are **templates**. Using a card
in the binder (expanding it and pressing Roll for a quick check) acts on a
**working copy** that sits beneath the template inside the binder until it is
discarded; the template itself is never mutated by play. The working copy can
be dragged onto the table like any card. Editing the template is a separate,
deliberate affordance: the gear (below). Dragging a template straight onto
the table creates a copy there.

This avoids the software placing cards on the shared board on its own, which
would get messy. Where a card lands is where a person dropped it. Cards on the
table are discarded by an action that moves them to a discard stack or removes
them; the log remains the record either way. Discarding a card discards its
rows, since they are its contents, and its Discard action removes its deployed
zone explicitly.

Targeting for area effects is spatial, and is the part this design does better
than a chat-driven VTT: the card's zone is dragged onto the map in view of
everyone, and its targets are `contents(zone)`. No targeting mode. A
multi-target card should be used on the table rather than in a binder, because
rows inside a character's binder are visible only to that character.

**Binders, sheets and hands on the canvas** (M5-D13, M5-D14, M5-D16–M5-D18).

- Binders, sheets and hands are canvas objects with a contents element;
  there is no DOM binder panel. A character's binder or sheet is used
  through the character's face or default contents list, or dragged out onto
  a board.
- Contents entries are expanded and collapsed per session, locally.
  Expanding a template entry spawns a working copy right after it (index +
  1) and expands and selects it, or expands an existing non-template entry
  of that container whose `template` refers to it. The template entry
  itself never expands.
- Edit-template is the gear: it selects the template for editing with an
  "Editing template" banner. There is no "save to template" in v1.
- Card lifetime is manual (Discard actions or Delete); there is no
  ephemeral flag.
- Shared templates live in the GM binder.
- A **binder** is an object whose `tag` contains `"binder"`. Dropping a
  template (an entry or a board template) onto a binder's contents element
  **gives a template**: one `transact` `[spawn {template, to: {type:
  "container", container: binder, index}, as: "$copy"}, set_template_flag
  {object: "$copy", value: true}]`, plus, when the binder's `owner` is a
  character, `set_value {object: "$copy", cell: "owner", value: <that
  character>}` in the same group (M6-D15), so the recipient holds a
  reusable template whose working copies (which copy `owner` verbatim) are
  pressed as that character (4.5) wherever they are dragged
  (copy-versus-move intent is ignored for this drop; Alt held at drag start
  moves the template instead). Every path that gives a template to a
  character's binder sets `owner` this way: the UI's drop, and the agent
  as the MCP instructions tell it. Dropping onto any other contents
  element copies an instance (4.6, **Gestures**).

**Example templates** (M5-D19). The GM binder of a new table (7, **New
tables and ownership**) is stocked with these complete records; the
implementation copies them verbatim and chooses nothing else. Notation:
`shape` (frames: a rect w × h has frame `[-w/2, -h/2, w, h]`, a circle r `[-r, -r, 2r, 2r]`); `tag`;
flags; cells (`name: literal`, `name = formula`; `""` is empty text, `empty`
the empty value, `@id` a reference); actions (`Name [when]: steps`, steps
separated by ` ; `); face elements as `kind cell|action [x, y, w, h]` with
options (`L` style size large, `H` huge, `C` caption, `m=N` min_size N px,
`sw="…"` show_when, `when_selected` on a contents element: true, M6-D12);
`default_action`. Every record not marked otherwise
is a template (`is_template: true`) with default `visible_to`. Ids never end
in `_<digits>`.

- `gm_binder` (not a template; on `gm_board` at `[0, 0]`): rect 7 × 10; tag
  binder; `name: "GM binder"`, `visible_to: [gm]` (viewers); face: `value
  name [-3.3, -4.8, 6.6, 0.6] L`, `contents [-3.3, -4.0, 6.6, 8.8]` (entries
  collapsed). Contents in this order: `tpl_character`, `tpl_attack`,
  `tpl_damage`, `tpl_area_save`, `tpl_save_row`, `tpl_token`, `tpl_zone`,
  `tpl_card`, `tpl_note`, `tpl_sheet`, `tpl_hand`, `tpl_binder`,
  `tpl_stack`, `tpl_d20` (the last is directly playable through a working
  copy, which the scrolling tests use).
- `tpl_d20`: circle r 0.5; tag die, d20; `name: "d20"`, `sides: 20`,
  `modifier: empty`, `value: empty`, `total = value + modifier`; `Roll:
  roll(1d20) -> value`; face `value total [-0.4, -0.35, 0.8, 0.5] H`,
  `button Roll [-0.4, 0.18, 0.8, 0.25] m=10`; `default_action: "Roll"`.
- `tpl_token`: circle r 0.5; tag creature; `name: "Token"`, `image: ""`,
  `ac: empty`, `max_hp: empty`, `damage_taken: 0`, `attack_bonus: empty`,
  `dex_save: empty`, `hit: false`, `hp = max_hp - damage_taken`; face
  `value image [-0.5, -0.5, 1, 1]`, `value name [-0.8, 0.55, 1.6, 0.3]
  m=8`, `value hp [0.2, -0.6, 0.5, 0.3] m=8`, `value hit [-0.7, -0.6,
  0.5, 0.3] sw="hit"` (the HIT badge, drawn at any zoom; a copy's GM
  replaces `hit` with a formula), `contents [-0.8, 0.9, 1.6, 0.8] m=24
  when_selected` (entries collapsed; shown only while selected, M6-D12).
- `tpl_zone`: rect 4 × 4, `is_zone`; `name: "Zone"`; no face.
- `tpl_card`: rect 2.5 × 3.5; `name: "Card"`, `title: ""`, `body: ""`; face
  `editor title [-1.15, -1.65, 2.3, 0.5] L`, `editor body [-1.15, -1.05,
  2.3, 2.7]`.
- `tpl_note`: rect 2 × 2; `name: "Note"`, `color: "#fff3a0"`, `text: ""`,
  `ink: empty`; face `value ink [-1, -1, 2, 2]`, `editor text [-0.9, -0.9,
  1.8, 0.6]`.
- `tpl_sheet`: rect 6 × 8; `name: "Sheet"`, `owner: empty`, `ac: empty`,
  `max_hp: empty`, `hp = max_hp - owner.damage_taken`, `attack_bonus:
  empty`, `damage_dice: 1d8`, `dex_save: empty`, `spell_dc: empty`, `notes:
  ""`, `ink: empty`; face `editor name [-2.8, -3.8, 5.6, 0.6] L sw="owner =
  empty"`, `value owner [-2.8, -3.8, 5.6, 0.6] L sw="owner != empty"` (an
  owned sheet's header shows its owner's name; the character is named on
  its token), then `C m=12` elements `editor ac [-2.8, -3.0, 2.7, 0.5]`,
  `editor max_hp [0.1, -3.0, 2.7, 0.5]`, `value hp [-2.8, -2.4, 2.7, 0.5]`, `editor attack_bonus
  [0.1, -2.4, 2.7, 0.5]`, `editor damage_dice [-2.8, -1.8, 2.7, 0.5]`,
  `editor dex_save [0.1, -1.8, 2.7, 0.5]`, `editor spell_dc [-2.8, -1.2,
  2.7, 0.5]`, then `editor notes [-2.8, -0.6, 5.6, 2.4]`, `value ink [-2.8,
  1.9, 5.6, 1.9]`.
- `tpl_stack`: rect 2.5 × 3.5; `name: "Stack"`, `count = len(contents)`;
  `Shuffle: shuffle(this)`; face `value name [-1.15, -1.65, 2.3, 0.5] L`,
  `value count [-1.15, -1.0, 2.3, 0.8] H C`, `button Shuffle [-1.15, 1.1,
  2.3, 0.5]`.
- `tpl_hand`: rect 6 × 2; tag hand; `name: "Hand"`, `owner: empty`,
  `visible_to = owner`; face `value name [-2.9, -0.95, 5.8, 0.35]`,
  `contents [-2.9, -0.55, 5.8, 1.5]` (entries collapsed).
- `tpl_binder`: rect 7 × 10; tag binder; `name: "Binder"`, `owner: empty`,
  `visible_to = owner`; face `value name [-3.3, -4.8, 6.6, 0.6] L
  sw="owner = empty"`, `value owner [-3.3, -4.8, 6.6, 0.6] L sw="owner !=
  empty"` (an owned binder's header shows its owner's name, as the sheet's
  does; its collapsed row still shows `name`), `contents [-3.3, -4.0, 6.6,
  8.8]` (entries collapsed).
- `tpl_character`: circle r 0.5; `is_character`; tag pc, creature; `name:
  "Character"`, `image: ""`, `sheet: @tpl_character_sheet`, `damage_taken:
  0`, `ac = sheet.ac`, `hp = sheet.hp`, `attack_bonus =
  sheet.attack_bonus`, `damage_dice = sheet.damage_dice`, `dex_save =
  sheet.dex_save`, `spell_dc = sheet.spell_dc`; contents
  `tpl_character_sheet`, `tpl_character_binder`; face `value image [-0.5,
  -0.5, 1, 1]`, `value name [-0.8, 0.55, 1.6, 0.3] m=8`, `value hp [0.2,
  -0.6, 0.5, 0.3] m=8`, `contents [-1.5, 0.9, 3, 1.2] m=24 when_selected`
  (entries collapsed; shown only while selected, M6-D12).
  - `tpl_character_sheet` (**not** a template): `tpl_sheet`'s record with
    `owner: @tpl_character`.
  - `tpl_character_binder` (**not** a template): `tpl_binder`'s record with
    `owner: @tpl_character`; contents `tpl_character_attack`.
  - `tpl_character_attack` (template): `tpl_attack`'s record with
    `attacker: @tpl_character`, `owner: @tpl_character`. Spawning the
    character remaps all three references to the new character.
- `tpl_attack`: rect 2.5 × 3.5; `name: "Attack"`, `owner: empty`, `attacker:
  empty`, `target: empty`, `roll: empty`, `dmg: empty`, `applied: false`,
  `bonus = attacker.attack_bonus`, `total = roll + bonus`, `hit = roll !=
  empty and total >= target.ac`; `Roll [target != empty and roll = empty]:
  roll(1d20) -> roll`; `Roll damage [hit and dmg = empty]:
  roll(attacker.damage_dice) -> dmg`; `Apply [hit and dmg != empty and not
  applied]: add(target.damage_taken, dmg) ; set(applied, true)`; `Discard:
  remove(this)`; face: the Attack card face (**Face layouts**, 4.6): its
  Apply button (`sw="dmg != empty"`) stays drawn after Apply, disabled by
  its guard, which shows the reason, and the Discard button beside it is
  always shown.
- `tpl_damage`: rect 2.5 × 3.5; `name: "Damage"`, `target: empty`,
  `dmg_dice: 1d6`, `dmg: empty`, `applied: false`; `Roll damage [target !=
  empty and dmg = empty]: roll(dmg_dice) -> dmg`; `Apply [dmg != empty and
  not applied]: add(target.damage_taken, dmg) ; set(applied, true)`;
  `Discard: remove(this)`; face `value name [-1.2, -1.7, 2.4, 0.4] L`,
  `editor target [-1.2, -1.2, 2.4, 0.4] C`, `editor dmg_dice [-1.2, -0.7,
  2.4, 0.4] C`, `value dmg [-1.2, -0.2, 2.4, 0.5] C`, `button "Roll damage"
  [-1.2, 0.5, 2.4, 0.45] sw="dmg = empty"`, `button Apply [-1.2, 1.1, 1.15,
  0.45] sw="dmg != empty"`, `button Discard [0.05, 1.1, 1.15, 0.45]`.
- `tpl_area_save`: rect 2.5 × 3.5; contents `tpl_area_save_zone`; `name:
  "Area save"`, `caster: empty`, `zone: @tpl_area_save_zone`, `save_row:
  @tpl_save_row`, `dc = caster.spell_dc`, `damage_dice: 8d6`, `damage:
  empty`, `locked: false`, `applied: false`, `targets =
  contents(zone).where(tag has "creature")`, `rows = contents.where(tag has
  "save_row")`; `Lock targets [not locked]: each(targets, spawn(save_row,
  this, {target: it, owner: it.owner or it})) ; set(locked, true)`; `Roll damage
  [locked and damage = empty]: roll(damage_dice) -> damage`; `Apply all
  [locked and damage != empty and all(rows.save_roll != empty) and not
  applied]: each(rows, add(it.target.damage_taken, it.damage_dealt)) ;
  set(applied, true)`; `Discard: remove(zone) ; remove(this)`; face `value
  name [-1.2, -1.7, 2.4, 0.4] L`, `editor caster [-1.2, -1.25, 1.15, 0.35]
  C`, `value dc [0.05, -1.25, 1.15, 0.35] C`, `value damage [-1.2, -0.85,
  2.4, 0.3] C`, `value targets [-1.2, -0.5, 2.4, 0.3] C`, `contents [-1.2,
  -0.15, 2.4, 1.1]` (entries collapsed),
  `button "Lock targets" [-1.2, 1.0, 1.15, 0.35] sw="not locked"`, `button
  "Roll damage" [0.05, 1.0, 1.15, 0.35] sw="locked and damage = empty"`,
  `button "Apply all" [-1.2, 1.4, 1.15, 0.3] sw="damage != empty"`, `button
  Discard [0.05, 1.4, 1.15, 0.3]`. **Caster initialization:** `caster` is
  `empty` in the GM binder and in every copy made from it (spawning keeps
  external references and an empty value stays empty); the GM sets it by
  dropping the caster's token on the `caster` editor (4.6, **Gestures**). Until then `dc`
  is `empty` and the save rows' Roll save is disabled by `card.caster !=
  empty` in its guard. A copy given into a character's binder keeps `caster`
  empty (no inference). **Row owner:** Lock targets sets each row's `owner`
  to its target's `owner`, or to the target itself when that is empty, so a
  GM-view Roll save on a goblin's row is the goblin's (4.5, M6-D20).
  - `tpl_area_save_zone` (**not** a template): circle r 2, `is_zone`;
    `name: "Area"`.
- `tpl_save_row` (beside `tpl_area_save` in the binder, outside its
  subtree): rect 2.5 × 0.8; tag save_row; `name: "Save"`, `owner: empty`,
  `target: empty`, `save_roll: empty`, `card = container`, `save_bonus =
  target.dex_save`, `passed = save_roll + save_bonus >= card.dc`,
  `damage_dealt = if(passed, floor(card.damage / 2), card.damage)`; `Roll
  save [save_roll = empty and card.caster != empty]: roll(1d20) ->
  save_roll`; face `value target [-1.2, -0.35, 1.0, 0.3]`, `value save_roll
  [-0.15, -0.35, 0.6, 0.3]`, `value passed [0.5, -0.35, 0.7, 0.3]`, `button
  "Roll save" [-1.2, 0.05, 2.4, 0.3] sw="save_roll = empty"`.

These are examples, not game content.

### 4.8 The log, and why there is no chat panel

A VTT chat panel does three jobs: it is a log, it is the procedure UI, and it
is a communication channel. Here:

- **Procedures happen on the table**, as cards (4.7), not in a sidebar.
- **The log is a panel rendered from the operation stream** (section 7):
  every action, in order, with its resolved steps as sentences, filterable,
  each entry linking back to the object it touched and keeping the name it had
  at the time. It is the authoritative record of the session. A discard stack
  of finished cards is an optional physical history on top of it.
- **Communication is deferred.** Plain text and whispers can be added to the
  log panel later, when there is more than one person connected.

**The log panel** (M5-D21) renders the log window's group views as one
header and one sentence per effect, with names as captured at commit. It
filters by actor, kind and text, links sentences to live objects, undoes any
group by index (`undo {type: "group"}`; Ctrl+Z stays `human` (§7)), pages
older groups with `log`, reloads loaded pages when visibility or undone
state may have changed, and is filtered by the viewer. Action definitions
are not recorded in groups (`explain_group` keeps returning the current one).
A cell write reads "Set G1.hp to 5 (was 7)"; a roll "Rolled 1d20 → 14 into
Attack.roll"; an `add` step's write "Added 14 to G1.damage_taken (now 20)",
or "Subtracted 3 from G1.damage_taken (now 17)" for a negative amount
(M6-D22). A roll result anywhere but a roll sentence reads as its total; the
inspector shows its dice.

What is given up relative to a guided chat card: a stepped reveal of one
button at a time. Show-when conditions on face elements recover most of it. A
true stepped wizard mode is not planned.

## 5. Agents

### 5.1 Role

Agents are **rules authors and table assistants**, not players and not the
rules engine. The GM says "make this zone halve the speed of anything in it and
mark it with cross-hatching," and the agent writes the formula and sets the
appearance. The GM says "set up an initiative tracker for these six tokens,"
and the agent builds the objects. Everything the agent produces is ordinary
table content the GM can read, edit, or delete.

Agents experience the world differently from humans and need their own
affordances. They do not click and drag; they query and write.

An agent may subscribe to changes and react, but any rule that should outlive
the agent's connection must be written into the table as a formula or action.
The table must behave the same with the agent disconnected.

### 5.2 Bring your own agent

V1 does not ship a built-in agent. It ships an **MCP server** (or equivalent)
that exposes the table to whatever agent the GM already uses. The surface
covers:

- **Query.** List objects (paged), read cells, resolve formulas, enumerate
  zones and their contents, ask "what is at this position," ask "what changed
  since revision N."
- **Write.** Create, move, and delete objects; set literals and formulas;
  define and invoke actions; change visibility. Writes are validated commands
  that go through the same invariants as the UI, carry the revision they were
  based on, and are rejected on conflict.
- **Explain.** Read the formula, dependency chain, and action steps behind any
  value or log entry.
- **Subscribe.** Receive change notifications.

Design rule: **anything a human can do through the UI must be expressible
through this surface**, and vice versa. If the agent cannot do it, the GM
cannot ask for help with it. Image assets are the one write outside the
protocol: asset upload is HTTP (`POST /assets`, docs/PROTOCOL.md §1), and the
UI and the MCP process (tool `import_asset`) both use it, so the rule holds
for images too (7, **Revisions and assets**).

In v1 the server is local, trusts its single connection, and acts with GM
authority. Query and write limits exist so a runaway agent cannot stall the
table.

**How it is built** (docs/PROTOCOL.md). One authority process per table
(`vtt-serve <file>`) owns the file and serves the protocol over a WebSocket.
The MCP server is a separate stdio process (`vtt-mcp`) that the agent host
launches; it attaches to the running authority as an ordinary protocol client
whose actor is `agent`, so the agent is a peer of the UI and the table
outlives agent sessions. Its tools follow the four groups above: query
(`table_info`, `list_objects`, `get_objects`, `evaluate`, `zones`,
`at_position`, `changes_since`, `log`), write (`transact`, `invoke`, which
invokes an action as a button press does, `undo`, `save`, and
`import_asset`, which uploads a local image file for an `image` cell),
explain (`explain_cell`, `explain_group`, `explain_action`), and subscribe
(`subscribe`, `poll_changes`, `unsubscribe`). At `initialize` the MCP server
sends instructions: a short orientation naming the resources, the first
queries, that reading user cells needs `cells: "all"` (`list_objects`
returns structural cells by default), the GM binder's templates, how to give
a template to a character, and the stale-write rule.

- **Stale writes.** Every `transact` (the batched write command) carries the
  revision it was based on. It is refused as `stale_write` when a group
  committed since then shares an undo conflict key (7) with the keys its ops
  declare or with the keys its effects actually touch, or when that revision
  predates retained history. Disjoint writes commit; nothing is rebased or
  re-evaluated. `undo` carries no base revision and is never stale-checked; it
  may pin its target with `expect_index`. `save` has neither.
- **Limits.** Client messages are at most 1 MiB, a batch at most 1,000 ops,
  pages at most 200 items, and a connection at most 200 requests per second;
  a connection that does not read its messages is closed. Server messages
  have no size limit. The full table is in docs/PROTOCOL.md §10.
- **View as.** Every authenticated connection has GM authority. A `viewer`
  parameter selects whose view is computed; in v1 it is a view-as selector,
  not a security boundary.

### 5.3 Consequences for the model

The canonical schema must be readable, stable, and documented. The language
must be small enough to specify completely in the agent's context. Object ids,
cell names, and tags must be human-meaningful by default. Objects created in
the UI therefore get ids from their kind (`token_12`, `zone_3`) through
`create_object`'s `id_base` (4.1, **Identity**; docs/PROTOCOL.md §5).

## 6. Vision and fog of war

Vision in existing VTTs is fiddly because it conflates two things:

- **Asymmetry**: each viewer sees something different and does not know what
  they are missing. This is what the article values.
- **Geometry**: walls, doors, light radii, cones of vision, elevation. This is
  where the fiddliness lives.

The plan is to ship asymmetry first and geometry later.

**Phase 1 (v1):** Asymmetry via the visibility primitive, opaque zones, and
GM reveal. The GM reveals rooms as players explore, exactly as at a physical
table with dungeon tiles. Because reveal is just setting `visible_to`, the GM
chooses per room whether it stays revealed or re-hides when the party leaves
(a one-line formula, see FORMULAS.md fixtures). A room with the re-hiding
formula is revealed by characters entering it, not by hand; revealing it by
hand would override the formula.

**Phase 2:** Computed visibility. Walls and lights become objects; a visibility
formula computes `visible_to` from them. This is one more way of computing the
same cell, alongside "GM said so" and "it is in my hand." Partial visibility of
a single large object beyond opaque zones is a phase 2 problem.

## 7. Document, operations, scale, and persistence

V1 has one GM and one agent as writers, but the architecture is a **document
plus an ordered stream of committed operations** from the start:

- Every change is an operation record: which action or edit, by whom, against
  which revision, with **resolved effects** (the values rolled, the ids
  created, the previous values of anything written, the subtree of anything
  removed). Replay applies effects; it never re-rolls or re-evaluates.
- Operations are grouped by action. Undo reverses one group, and is itself an
  operation. Undo after an intervening operation that touched the same cells
  is refused with an explanation.
- V1 has a single ordered authority. Multiplayer will keep an ordered
  authority (a server); this design does not promise CRDT merging.
- The file holds a fresh snapshot, taken at every save, plus the retained
  operations as history (see **The file** below). Log compaction is allowed;
  the log panel shows what is retained.

**Operation records.** A committed change is a **group**. A group holds:

- its resolved effects, in order: cell states before and after, each with a
  cause, `edit` or `roll`, and, for an `add` step's write, the number added
  (`added`, M6-D22); per-cell visibility changes; field changes
  (`tag`, `shape`, `is_template`, `is_character`, `actions`, an object's
  whole action list before and after, and `face`, its whole face layout
  before and after); placements; creation and removal of whole subtrees; reorders; board changes;
  id allocation; id retirement;
- the actor; its kind, `edit`, `action`, or `undo`; a label; its origin; and,
  for an undo, `undoes`, the index of the group it reverses;
- `base_revision`, the revision it was made against, and `revision`, the
  revision it produced;
- the names of the objects it touched and, when the actor is a character, of
  that character, captured at commit time; for a removed object, its name just
  before removal. This is how the log keeps the name an object had at the time
  (4.8) and names the character the GM drove even when the group touched only
  other objects (M5-D1).

A logged write records the resulting value: `add` logs the sum, not the
increment.

**Transactions.** Every change runs in a transaction, and one transaction is
open at a time. The commit point is the moment the new document and the
appended group are published. Internal synchronization (formula invalidation,
spatial index update) runs right after the commit point and before any public
commit notification. A listener that throws is reported separately; it never
turns a commit into an abort. Before the commit point, a refusal (`Rejected`)
becomes a rejection result, and any other error aborts the transaction and
propagates unchanged. In both cases nothing is applied and no dice-script
entries or randomness are consumed. Every commit carries a change summary: the
objects created and removed, the cells written with their before and after
states, and the objects moved with the changes derived from each move.

**Undo.** Undo reverses one group and adds its own group, of kind `undo`.
There is no redo. The group to reverse is chosen by one of four targets:

| Target | Reverses |
|---|---|
| `latest` | The most recent group that is neither an undo nor already undone. The fixture `undo` step always means this (FIXTURES.md 8). |
| `actor` | The latest such group by a given actor. |
| `group` | The group at an explicit absolute index. |
| `human` | The latest such group whose actor is the GM or any character. |

Undoing a target G conflicts with a later group H when H is not an undo group,
H is not undone, and the two share a touched key:

- a cell write touches the cell's key, and so does a change to that cell's
  per-cell visibility;
- replacing an object's action list touches its `actions:<object>` key, which
  conflicts with itself and with creating or removing that object;
- replacing an object's face layout touches its `face:<object>` key, which
  conflicts with itself and with creating or removing that object;
- a move touches the `contents` key of the container at both ends;
- creating or removing objects touches every key on those objects, and the
  `contents` key of the container they were created in or removed from;
- allocation and retirement touch nothing.

Undo groups never conflict. A conflicting undo is refused as `undo_conflict`,
and so is an undo whose inverse fails an invariant on commit. A later group
that conflicts in this sense is what FIXTURES.md 8 calls a *surviving*
operation.

**Undo and writes in the UI.** The UI's undo targets `human`: the latest
group by the GM or by a character the GM drove (a button pressed in view-as
or on an object that character owns, §4.5), docs/PROTOCOL.md §6, so the GM's undo never reverses the agent's
newer work.
Every UI write carries the revision its interaction began on (drag start,
editor open, formula bar focus, or the click for instantaneous commands),
never the latest one, so a conflicting write committed since the
interaction began makes it `stale_write` (5.2). Two exceptions: the inspector
Face section's edits are queued, and each carries the later of its own
captured revision and the latest own face write's committed revision,
because each field is its own interaction; and action invocations (face
buttons, the default action, the inspector's Run) are queued per session,
each sent after the viewer's own earlier invocation is acknowledged and
stamped past the own invocations that committed directly on top of its
captured revision, so a fast second press is not stale against the first
(M6-D18). Stale writes and uncertain
outcomes are shown to the GM and never retried automatically.

**Replay and rewind.** Replaying a group applies its recorded effects and sets
the revision to the group's `revision`, also for a group with no effects.
Rewinding a group applies its exact historical inverse and sets the revision
to the group's `base_revision`. Historical inverses are an internal
representation, never persisted, and distinct from the effects of a user undo:
a retirement records exactly the ids it added, so rewinding it removes exactly
those, whereas a user undo never shrinks `retired_ids` (4.1). Comparisons of
stored state for replay exclude the revision.

**History invariants**, checked on load:

- Retained groups have contiguous absolute indices starting at `first_index`.
- Each group's `revision` is its `base_revision` + 1, and each
  `base_revision` equals the previous group's `revision`.
- `kind` is `undo` exactly when `undoes` is present.
- `undoes` names an earlier index that is not itself an undo group, or an
  index below `first_index` (compacted away); no index is undone twice.
- `undo_barrier` lies in `first_index` … the next index.
- The last retained group's `revision` equals the snapshot's, except when the
  file was edited by hand: the barrier then equals the next index and the
  snapshot wins.

**Scale.** Evaluation is defined over the whole document at a revision. An
unloaded object is never treated as absent. The renderer may load and draw
only the region in view, and spatial queries are backed by an index that is
invalidated on position, shape, board, tag, and deletion changes. Whole-table
queries (`objects(expr)`) are allowed and budgeted; if a formula exceeds its
budget it shows `#LIMIT` rather than stalling the table. V1 must stay
responsive during play on a table of a few thousand objects; a numeric target
waits for a platform.

**Persistence.** The file is a readable text document containing the schema
version, the snapshot, the retained operations, and references to assets
(images) stored beside it. Saves are atomic. Opening a file from an older
schema version migrates it. Hand-editing the file is allowed; on load the
snapshot wins and the operation history is kept as record, not replayed over
the edited snapshot. Long campaigns imply the file is something you keep,
version, and diff across months.

**The file** holds a fresh snapshot, taken at every save, plus the retained
groups as history, with their absolute indices, `first_index`, and
`undo_barrier`. There are no operations "since" the snapshot. A
`snapshot_hash` detects hand edits. After one, the snapshot wins and the undo
barrier is set to the next absolute group index, so every earlier group stays
as record and new groups remain undoable; with an empty retained log the next
index is `first_index`. Snapshots are taken at every save and at load;
in-memory checkpoints are Polish. A file with an
older `schema_version` migrates one version at a time. Compaction drops old
groups, keeps absolute indices, and raises the barrier to at least
`first_index`.

**Saving** is atomic and has two failure stages. A failure before the new file
replaces the old leaves the old file intact and reports an error. A
durability failure after the replacement (the directory fsync) leaves the new
file intact and reports that the save completed but durability was not
confirmed.

**Autosave.** The authority saves 2 s after the last commit, but at most 10 s
after the first unsaved commit, on an explicit `save`, and on shutdown. Saves
are serialized; each captures its snapshot and revision synchronously when it
starts and marks only that revision saved. The asset list loaded with the
file is kept through every save and grows by import (`addAsset`); saved state
is the pair (revision, assets generation). An import schedules a save like a
commit, and a save marks its pair saved only when the file holds both the
captured revision and the captured asset list. A failed save is retried after 1 s, 5 s,
30 s, then every 60 s until that revision or a later one is saved; a save that
completed without confirmed durability does not mark its revision saved and
is retried like a failure. Results are broadcast to clients. Shutdown awaits
outstanding saves and its final save, never throws for a save failure,
reports `{saved, revision, error?}`, and always releases the lock. There is
no automatic compaction in v1.

**New tables and ownership.** Opening a missing file creates it with one
board, `gm_board` named "GM". `vtt-serve` puts on it the GM binder stocked
with the example templates (4.7), or, with `--empty`, no objects; the host's
own default stays the empty table, which tests keep (M5-D19, amending
M3-D25). One authority owns a table at a
time through a lock file `<file>.lock`, created exclusively and released only
by its owner; a lock left by a dead process is refused, never taken over
automatically, and removing it is a human decision (`vtt-serve
--force-unlock`). A table identity file `<file>.table-id` holds a random id,
created once under the lock and never rewritten, so clients can tell one
table from another across restarts without changing the file format. Lock and
identity paths derive from the table file's real path, so symlink aliases
share them. Details in docs/PROTOCOL.md §2.

**Revisions and assets.** Every group records its `base_revision`, and every
protocol `transact` carries one. A `transact` is refused as `stale_write`
when its `base_revision` is below the retained-history floor, when a group
committed after it (undo groups included) shares a key with its ops' declared
intended-write keys (checked before any primitive runs, so a write to an
object removed since is stale rather than a primitive refusal), or when such a
group shares a key with its actual effects (checked after the ops ran, before
commit). The keys are the undo conflict keys above. Disjoint writes commit;
nothing is rebased or re-evaluated. `undo` takes no `base_revision` and is
never stale-checked; it may pin its target with `expect_index`. `save` has
neither. A `transact` may carry a client-chosen transaction id (`txn_id`): a
repeat from the same client instance with the same parameters returns the
stored result instead of executing again, and a repeat with different
parameters is rejected. A client resends a `transact` whose response was lost
only to the same authority session, once; `undo` is never resent. Any other
unsettled outcome of a sent `transact` or `undo` is reported as uncertain,
never re-executed. The deduplication store is in memory (the last 1,000 per
client instance) and persistent deduplication is Later. Details in
docs/PROTOCOL.md §6.

Asset paths in the file are relative to the file's directory, never
absolute. Parsing a file is pure; whether its assets exist is checked only
when loading from a path.

An image cell is the ordinary text cell `image` (4.6, **Appearance cells**)
holding an asset path relative to the table file, as listed in the file's
`assets`. Imported images are stored in `<table basename>.assets/` beside the
file, named `<slug>-<hash8>.<ext>` (`hash8` being the first 8 hex digits of
the bytes' SHA-256); PNG, JPEG, WebP and GIF are accepted, SVG is not (it can
carry script). An imported path is listed in the file's `assets` from the
next save. Assets are never garbage-collected in v1. Asset upload is HTTP
(`POST /assets`, docs/PROTOCOL.md §1), not a document operation: a map image
exceeds the 1 MiB client frame limit. The UI and the MCP process (tool
`import_asset`, docs/PROTOCOL.md §11) both use it, so the parity rule of 5.2
holds.

**Smaller decisions.**

- The `table` destination (FORMULAS.md 8.2) is resolved by M5 into a board
  destination: the `table` parameter of `invoke` (docs/PROTOCOL.md §4), the
  board and point the invoker names (the UI's active board and viewport
  centre); without it the step is a step error. `beside(r)` places right of
  `r` (or of its outermost container on a board), touching plus 0.25 by
  footprint widths (FORMULAS.md 8.2). M2's primitives take only board and
  container destinations.
- Renaming a cell does not rewrite formulas that name it. It is refused when
  either name is structural (FORMULAS.md 3.1) or the destination cell exists.
  Any per-cell visibility recorded for the (absent) destination is replaced
  with the source's.
- Spawn initial cells may be literals or formulas (4.1); a `spawn` step's
  record gives values (FORMULAS.md 8.3).
- Reordering `contents` by `shuffle` is allowed despite the membership
  protection of FORMULAS.md 3.1: it changes order, not membership.

**Platform.** TypeScript end to end. The **authority** is a local process
(Node), one per table (`vtt-serve <file>`), that owns the document file,
evaluates formulas, ships the MCP server, and serves the UI over localhost
with the op stream over a WebSocket. It serves the built UI at `/` with the
session token injected into the page, and refuses HTTP requests whose `Host`
is not its own loopback address (docs/PROTOCOL.md §1, §2). The MCP server
runs as its own stdio process (`vtt-mcp`), launched by the agent host, and
attaches to the running authority as a protocol client with an `agent`
actor. `pnpm start <file>` builds the UI when `packages/ui/dist` is missing
or older than its sources (`--no-build` skips that) and runs `vtt-serve
<file> --open`, which opens the served page in a browser once listening
(`$BROWSER` if set, else the platform opener); a failure to open is logged
and never stops the server. `pnpm start <file> --no-open` leaves `--open`
off, for reopening a table whose old tab offers Reload (M6-D23). `pnpm mcp` runs `vtt-mcp`. The wire schemas and
the client (`ProtocolClient`, `ViewMirror`) live in the browser-safe package
`@vtt/protocol`, which depends only on `@vtt/schema` and zod and is shared by
the authority, the MCP server and the UI; its wire schemas are
JSON-Schema-compatible so MCP tool input schemas can be generated from them,
while `@vtt/schema`'s canonical schemas stay for unfiltered document data.
The UI is a browser tab in v1; a desktop shell (Tauri or Electron) can wrap
the same process later. Formulas evaluate only in the authority, because they
may read cells the viewer cannot see; clients receive cell results, never
inputs. The UI and the agent are two clients of the same
protocol, so the protocol is designed first, not deferred.

In the tab, the scene is drawn on a canvas and the chrome (inspector, formula
bar, log) is DOM; binders are canvas objects (4.7). In-place editing is a DOM overlay positioned over
the cell. Canvas2D with viewport culling and an image cache; per-object
render caching is deferred until profiling asks (vtt-qf5.10). The renderer
sits behind a small renderer interface; PixiJS is the known upgrade if
profiling demands it. Objects are never DOM nodes. Canvas text is weak at
small sizes, which face elements' `min_size` zoom thresholds already
accommodate. Very large
map images are a tiling problem and stay in Later.

**Protocol.** The wire protocol is specified in docs/PROTOCOL.md: JSON
messages over one WebSocket, a token handshake, one batched write command
(`transact`) whose ops map one to one onto the store's primitives, queries,
explanations, subscriptions that push viewer-filtered views after each
commit, and the MCP tools built on them.

Decided since (CLAUDE.md): React for the chrome, a hand-written Pratt parser,
and Node for the authority. Left open on purpose: the desktop shell.

## 8. Scope

### 8.1 V1: single GM

The first version is a tool one GM uses alone for playtesting the model. It
must prove the core model works and is pleasant:

- Infinite 2D canvas with pan, zoom, and multiple boards. A plain wheel or
  two-finger scroll pans; Ctrl/Cmd+wheel or a trackpad pinch zooms about the
  pointer; `+` (or `=`) and `-` zoom about the viewport centre; Space-drag
  (wherever focus is, outside a text field) or middle-drag pans. A list that
  scrolls takes a plain wheel over it first (M6-D11).
- Objects with image, shape, text, facing, stacking, single-parent
  containment, and template copying.
- Cells with literals and formulas, a formula bar, manual override, per-cell
  visibility.
- Zones with `contents` and `zones_containing`, opaque zones, and the
  filtering needed for the dice-tray case.
- Characters as objects. Visibility as a cell keyed to characters, composed
  through containers, with a "view as" mode. Toggling view-as in one window is
  sufficient; a separate player window is not required.
- Actions as step lists with preconditions: set, add, append, roll, move,
  spawn, remove, shuffle, each. Atomic, logged, undoable as a unit. Buttons on
  faces. Actions editable in the inspector.
- Face layouts with value, editor, button, and contents elements, show-when
  conditions, and a collapsed face.
- A binder per character and one for the GM. Templates in binders, working
  copies for in-binder use, drag out to copy onto the table, a separate
  edit-template affordance.
- Example templates: die, token, zone, card, sheet, sticky note, stack, hand,
  binder, character, and Attack, Damage, and Area Save cards. These are
  **examples, not shipped game content**: they use generic cell names and
  the GM is expected to edit or discard them. `vtt-serve` stocks them into
  the GM binder of a new table (4.7, **Example templates**; 7, **New tables
  and ownership**).
- A log panel rendered from the operation stream.
- Freehand drawing and text, so improvisation is cheap (the ink and text
  tools; ink is the cell `ink`, 4.6).
- Save and load to a readable text format with assets, atomic saves, schema
  version.
- A local MCP server exposing query, write, explain, and subscribe.
- Undo of whole actions.

### 8.2 Later

- Multiplayer: participants mapped to the characters they control, an ordered
  server authority, and a rights model separating viewing, editing literals,
  editing formulas and actions, and invoking actions.
- Computed vision (walls, lights, line of sight).
- Richer templates, template propagation, and sharing of templates.
- Performance work for very large maps.
- Communication in the log panel.
- Possibly a built-in agent once the BYOA surface has stabilized.

### 8.3 Non-goals

These are not part of this project. Some may become separate projects later.

- Rules implementations for specific game systems (no "5e module").
- Compendiums, SRD content, licensed content.
- Marketplace or content store.
- Physics simulation.
- 3D.
- Video or voice chat.
- Character builders or campaign management outside the table.

### 8.4 The first session (v1 acceptance scenario)

V1 is done when this can be done, and feels good. One GM, alone, playtesting.
A D&D-flavored dungeon crawl with four PCs, because the fixtures lean that
way; nothing about the tool assumes it.

**Prep (about 30 minutes)**

1. Open a new table. The GM board is empty except for the GM binder, stocked
   with the example templates.
2. Add the HIT badge formula to the character template's token once. Then
   drag the character template out four times. Each creates a character
   object owning a sheet and a binder. Name each character on its token,
   then fill in AC, HP, attack bonus and Dex save by typing into the sheet
   faces; each sheet's header shows its character's name. Each binder
   already holds an Attack card template.
3. Import the dungeon map as one image on a second board, "Crypt." Draw six
   opaque zones over the rooms, each `visible_to = gm`. Give rooms 2 and 4 the
   re-hiding formula; leave the rest manual.
4. Make a goblin template once: image, `ac` (GM-only cell), `max_hp`,
   `damage_taken`, `attack_bonus`, `dex_save`, the HIT badge formula, tag
   `creature`, and
   an owned attack d20 whose `modifier` follows the owner's attack bonus.
   Place eight: four in room 3, four in room 5.
5. Through the MCP server, ask the agent: "Make room 4 difficult terrain and
   hatch it, and make a Fireball card for Aldric with DC 14 and 8d6." The
   agent gives Aldric's binder a copy of the Area Save card named Fireball
   with `caster` and `owner` Aldric and `damage_dice` 8d6, and writes 14 into Aldric's
   sheet `spell_dc`, which the card's `dc` follows. Check its work in the
   inspector. Correct the DC by typing over it.
6. Scribble "trap on the third stair" in ink on a sticky note on the GM board.
   Save. Glance at the file; it is readable.

**Play (about two hours, GM driving everything)**

7. Show the Crypt board in "view as" Aldric: every room is covered. Reveal
   room 1, the entrance, by hand; now only it is uncovered. Toggle back to GM
   view as needed.
8. Move the PC tokens into room 1. Reveal room 3 by hand when they open the
   door. Room 2 reveals itself when a PC token enters and re-covers once the
   party has left.
9. Combat in room 3. Draw a dice tray zone beside the map. Roll initiative
   with loose d20s from the GM binder, double-clicking each to roll, adding
   bonuses by eye from the sheets. Line the tokens up in a strip zone by
   initiative. No initiative tracker feature exists; none is needed.
10. Aldric attacks: expand the Attack card in Aldric's binder (a working copy
    appears), drop a goblin onto `target`, press Roll. HIT shows; AC does not.
    Roll damage, press Apply. The goblin's `hp` changes on its face and the
    log says so in a sentence. Apply stays visible but disabled, and says
    why.
11. Goblins attack back: drag a goblin's own attack die out of the goblin's
    contents list onto a PC token and double-click it. Its `total` includes
    the goblin's bonus; the PC's HIT badge reads it. Fast path, no cards.
12. Aldric casts Fireball: drag the card from the binder onto the table, drag
    its zone out of the card onto room 3, nudge it to catch three goblins and miss the fighter
    while `targets` updates live. Press Lock targets; three rows appear. Roll
    damage once, roll each save, Apply All. Three goblins update; the log
    lists each.
13. The rogue triggers the stair trap. No template exists. Make a sticky note,
    type the DC on it, roll a loose d20 in the tray, decide by eye. The tool
    got out of the way.
14. Discard the spent Attack card with its Discard button, attack the wrong
    goblin with a fresh one, and undo once after applying the damage. Delete a
    goblin by mistake and undo that too. Scroll the log back to confirm what
    happened.
15. Save. Close. Reopen; everything, including the log, the undo, and the
    deleted-then-restored goblin, is there.

**Exercised:** boards, opaque zones, visibility as a composed cell, view-as,
manual and formula-driven reveal, characters and binders, templates and
graph copying, working copies, in-place editing, cards with buttons,
preconditions and show-when, spawned rows, dice with owner-aware modifiers,
`on()`, the tray sum, apply and undo, ink, the log, save and load, the agent
through the MCP surface.

**Deliberately absent:** computed line of sight, a second connected person,
a separate player window, shipped game-system content.

## 9. Open questions

- **Card lifetime.** Decided: manual (M5-D16, 4.7).
- **Template propagation.** When a binder template is edited, do the copies
  already on the table change? Not by default; worth an explicit "update from
  template" action later.
- **Shared templates.** Decided: the GM binder, giving a template by
  dropping it on a binder (M5-D18, 4.7).
- **Edit-template UI.** Decided: a gear (M5-D17, 4.7).
- **Rendering stack and platform.** Decided (section 7 and CLAUDE.md: React, a hand-written Pratt parser, Node). Still open within it: desktop shell.

## 10. Decision log

| Date | Decision | Rationale |
|---|---|---|
| 2026-11-04 | Single object type with cells; no built-in classes, only templates. | Versatility. A die must be usable as a counter. |
| 2026-11-04 | Character sheets are objects on the table, not separate windows. | Physicality; margins; same model for everything. |
| 2026-11-04 | Per-object visibility is the primitive; hands, binders, GM screen build on it. | One mechanism for all hidden information; vision later computes the same cell. |
| 2026-11-04 | Physicality means placement, facing, stacking, containment. No physics simulation. | Simulation adds clumsiness without adding meaning. |
| 2026-11-04 | Asymmetric visibility with GM reveal in v1; geometric vision later. | Separates the valuable part from the fiddly part. |
| 2026-11-04 | Spatial formulas (`contents`, `zones_containing`) are core; "sum the dice in this box" is a benchmark. | The most novel part of the pitch; rules attach to space declaratively. |
| 2026-11-04 | Formula language is visible and editable in the UI. | Spreadsheet trust model; makes agent-authored rules overridable. |
| 2026-11-04 | Agents are rules authors with their own affordances, via bring-your-own-agent MCP server. | Agents experience the world differently; avoid shipping a model dependency early. |
| 2026-11-04 | One canonical schema; file is its lossless serialization; API is validated commands over it. (Originally "model = file = API"; narrowed after review.) | One source of truth; meaningful diffs; agent-readable; invariants enforced on every path. |
| 2026-11-04 | V1 single-GM; architecture is document plus operation stream. | Prove the model without multiplayer cost; don't foreclose it. |
| 2026-11-04 | Non-goals: system modules, compendiums, marketplace, physics, 3D, A/V. | Separate projects at best. |
| 2026-11-04 | Appearance is not separate from cells: image, shape, ink are cells; the face is a layout of cells. | One data model; "what it looks like" is editable like anything else. |
| 2026-11-04 | Ink is a cell value type. | Margin scrawl travels with the object and appears in the inspector. |
| 2026-11-04 | Containment is one owning `contents` cell per object, single-parent, acyclic; `container` is derived; other reference cells are non-owning. Zone containment is geometric and computed. | Cascade delete, move, and copy need a tree. Rows, inventories, hands, stacks all fit it. |
| 2026-11-04 | Two presentations of cells: the face (layout on the object, edit in place, zoom as level of detail) and the inspector (side panel). One formula bar. | Tokens look like tokens; every value remains one click from its formula. |
| 2026-11-04 | Procedures are cards (objects with cells and buttons), not chat messages. No chat panel. A log panel is rendered from the operation stream; communication deferred. | Procedures stay editable templates rather than per-system code; the table is the UI. |
| 2026-11-04 | Cards live in per-character binders as templates. In-binder use acts on a working copy; editing the template is a separate affordance. Drag out to copy onto the table. | People place cards, not the software. Templates are never mutated by play. |
| 2026-11-04 | Face elements: value, editor, button, contents; all with show-when conditions over cells plus viewer-local zoom and collapsed inputs. Amended by M5-D8. | Covers multi-target procedures and stepped reveal without a wizard mode; presentation state never leaks into game formulas. |
| 2026-11-04 | Derived state is formulas; accumulated state is written by actions. Formulas may read hidden cells; viewers see results, not inputs; formula authors are trusted. | Damage is history. Hit/miss should show without leaking AC. |
| 2026-11-04 | Formula language: pure expression language, lowercase functions, broadcasting over lists, dice as a value type, `where(expr)` as the only filter, no keyword-filter shorthand. Actions are a fixed set of step kinds. Specified in FORMULAS.md. | One way to say each thing; small enough for a GM to learn and an agent to hold in context. |
| 2026-11-04 | Visibility and ownership are keyed to characters, not people. The GM is a principal, not a character. V1 has one person with a "view as character" mode. Participants are a later mapping; union visibility is intentional. | The in-fiction question is what the GM decides; multiplayer then changes rights, not the table. |
| 2026-11-04 | The first-session scenario (8.4) is the v1 acceptance test. | Concrete, end to end, touches every v1 feature once. |
| 2026-11-04 | Re-hiding explored rooms in v1 is a one-line visibility formula the GM applies per room. Such rooms are revealed by characters entering, never by hand. | The GM chooses per room; manual reveal would override the formula. |
| 2026-11-04 | Multi-target rows are spawned child objects in the card's `contents`, committed by a Lock targets action. `spawn` takes initial cells and copies the template subgraph. `remove` cascades. The contents face element serves rows, binders, hands. | Rows need identity, ownership, and storage; formulas cannot spawn; one rendering mechanism. |
| 2026-11-04 | **Review response.** Effective visibility is own `visible_to` intersected with container's, with per-cell overrides; zones never affect visibility; opaque zones cover what is beneath them for viewers who cannot see the zone. | Per-object visibility could not hide part of a map image; inheritance needed a composition rule. |
| 2026-11-04 | **Review response.** Actions are atomic, read-your-writes, snapshot `each`, abort on error, undo as a unit, with `when` preconditions and explicit procedure state (`applied`). | Apply must not run twice; `empty`-as-zero must not make unfinished procedures look finished. |
| 2026-11-04 | **Review response.** Operation records store resolved effects; single ordered authority; no CRDT promise; snapshots, compaction, schema versions, atomic saves, assets beside the file. | "For free" was overstated; the contract has to be stated before code. |
| 2026-11-04 | **Review response.** Evaluation is whole-document at a revision; unloaded objects are never absent; spatial index invalidation events are specified; `objects()` is budgeted and shows `#LIMIT`. | Large maps need a data-access contract now and optimization later. |
| 2026-11-04 | **Review response.** V1 rights: only GM and agent edit formulas and actions. Finer rights deferred to multiplayer. | Single-GM v1 does not need the rights model; stating the deferral avoids pretending it exists. |
| 2026-11-04 | **Review response.** Toggling view-as in a single window is sufficient for v1; no separate player window. | V1 is for playtesting, not live screen-shared games. |
| 2026-11-04 | **Review response.** Example templates ship as editable examples, not as game-system content. | Resolves the tension between example cards and the no-system-content non-goal. |
| 2026-11-04 | **Review round 2.** Objects on a board are owned by nothing; a card references its deployed zone non-owningly and removes it in Discard. Broadcasting excludes `has`, `and`, `or`, `not`, and two-list equality. All visibility restrictions intersect. Within an action, written cells read as written, others as of action start, spawned formula cells as empty. The "applied card shows what was applied" promise is withdrawn in favor of the log. One-frame target dropped. | Each was a contradiction or an over-promise; each fix is a sentence, not a mechanism. |
| 2026-11-04 | **Platform.** TypeScript end to end. Local authority process owns the document, evaluates formulas, hosts MCP, serves a browser-tab UI over a WebSocket op stream. Canvas2D scene plus DOM chrome, behind a renderer interface. No desktop shell in v1. | One language while the model is changing fast; formulas must evaluate where hidden inputs are visible; UI and agent as peer clients makes multiplayer a networking change. Browser is the strongest platform for whiteboard-plus-spreadsheet chrome. |
| 2026-11-05 | Zones are marked by a protected boolean structural cell `is_zone`, not by tag or shape kind. | Shape kinds are shared with token outlines; tags are user-editable; `zone` is a natural name for a user reference cell, as the Fireball card shows. |
| 2026-11-05 | `shape` is a value type, `{type:"shape", shape}`, read from the structural `shape` cell. Opaque to formulas: equality only, every other operation `#TYPE`; truthy; no literal syntax. FORMULAS §2. | §3.1 typed the cell as shape but no such value existed; formulas need to read it without manipulating geometry. |
| 2026-11-05 | Language values are the FIXTURES §2 tagged encoding plus the shape value and the error value `{type:"error", code, message?, origin?}`. Errors are never storable. Op records and the file reuse these types unchanged. FORMULAS §2.4. | One encoding across evaluator, fixtures, ops, and file; no translation layer to drift. |
| 2026-11-05 | A reference to a deleted object read from a cell, directly or inside a list or viewers value, makes the whole read `#REF`; visibility then fails closed. FORMULAS §2.4. | A dangling ref hidden in a list must not silently vanish or admit a viewer. |
| 2026-11-05 | Roll results act as their total in arithmetic, comparison, numeric functions, and `sum`/`avg`; render as their total in `&` and `text()`; are always truthy; `min`/`max`/`if`/`first`/`last` return the roll unchanged. FORMULAS §2.2. | "Acts as a number in arithmetic and comparison" left every other context open; a rolled 0 is still a roll. |
| 2026-11-05 | Dice dialect: lowercase `d`, uppercase `F`; each modifier kind once per term, any order; `khN`/`klN` 1 ≤ N ≤ count, `dhN`/`dlN` 1 ≤ N < count; count ≤ 1000, sides 2–1,000,000; no `!` or `r` on `dF`; explosion extras separate, at most 100 per die, not rerolled; reroll once, original to dropped; keep/drop ranks all dice, ties by roll order; `max_roll`/`min_roll` ignore explosion and rerolls; `sides` of `dF` is 3. FORMULAS §2.2. | The v1 subset named modifiers without semantics; rolls must be reproducible from the spec alone. |
| 2026-11-05 | Normalized dice expression: explicit counts, modifiers reroll, explode, keep/drop, integer constants folded into one trailing term, term order preserved, no semantic simplification. Used by dice equality and fixture script matching. FORMULAS §2.2. | Term order is roll order of `.dice`; simplifying `1d20kh1` to `1d20` would equate different rolls. |
| 2026-11-05 | `#SYNTAX` is the error for source that does not parse, including the parser's limits (AST depth 256 counting every nesting, 10,000 nodes) and non-finite numeric literals. The fixture format's `ErrorCodeSchema` gains it additively. FORMULAS §2.3, §3.2; FIXTURES §4, §7, §11. | A parse failure needs a code; reusing `#TYPE` would hide typos as type errors. Limits keep pathological source from exhausting the stack. |
| 2026-11-05 | Lists never contain errors: a list built from an error item is that error; with several errors the first in evaluation order (left to right, list order) wins; origin is preserved. FORMULAS §2.3. | Deterministic error reporting; an error inside a list would otherwise leak into aggregates unpredictably. |
| 2026-11-05 | Complete syntax contract: whitespace and no comments; numbers digits or digits.digits, no exponent, no adjacency to identifier characters; text with `\"` and `\\` only; identifiers and backtick names; dice literals winning over identifiers; precedence loosest to tightest or, and, comparisons, has, &, + -, * / %, prefix, postfix; left-associative; chained comparisons `#TYPE`; records reject duplicate fields; calls are identifier plus `(`; methods only `.where(e)` and `.sort(e[, desc])`. FORMULAS §3.2, §4. | The parser (vtt-o9i.4) and every later bead need one frozen grammar to cite. |
| 2026-11-05 | Reserved words: `all` and `gm` are viewer literals (`all(...)` is the aggregate); `desc` is contextual, only in `.sort(e, desc)`; `owner` in a formula is always the cell, never the symbolic viewer entry; `dS` is always dice, so a dice-like cell name needs backticks; `1d6!=3` is `1d6 != 3`. FORMULAS §3.2. | `desc` and `owner` are likely cell names; the dice rule keeps lexing context-free. |
| 2026-11-05 | Dot-access on `empty` is `empty`. FORMULAS §3. | A blank, not a typo (§2.1); `#REF` would make every unspawned template show errors. |
| 2026-11-05 | Bare names inside `where`/`sort`/`objects` resolve only against the item's cells, with no fallback to `this`; a bare name on a non-ref item is `#TYPE`; `it` works for any item. FORMULAS §3. | A fallback would make a missing item cell silently read the enclosing object. |
| 2026-11-05 | `name` is literal-only in v1, like `tag`; the store refuses a formula on either. `obj(x)`: exact id wins, else exact match over literal names, exactly one or `#REF`; the cell depends on the found object's `name` and on the index. FORMULAS §3, §3.1. | Name lookup over formula names would make the index depend on evaluation. |
| 2026-11-05 | `objects()` ranges over every object in the document, including contained objects and templates. FORMULAS §3, §6. | "On the table" was ambiguous; filtering belongs to `where` and tags. |
| 2026-11-05 | In `< <= > >=`, `empty` acts as 0 against numbers and roll results and as `""` against text; empty against empty compares equal; `empty = 0` stays false. FORMULAS §4. | Keeps `save_roll + save_bonus >= card.dc` usable before a cell is filled, consistent with empty-as-zero in arithmetic. |
| 2026-11-05 | `=` never errors except on ink: different kinds are unequal (number vs roll compares the total); viewers compare as sets; shapes structurally; `ink = x` is `#TYPE` unless `x` is empty. FORMULAS §4. | Equality is used in guards; it must not fail on mixed kinds. Ink comparison has no meaning beyond emptiness. |
| 2026-11-05 | Numbers are IEEE doubles; `/0` and `%0` are `#DIV0`; other non-finite results are `#TYPE`; `%` takes the dividend's sign; `round` is half away from zero; `number()` accepts `-?digits(.digits)?` after trimming. FORMULAS §4. | Pins every edge case the evaluator would otherwise inherit from JavaScript. |
| 2026-11-05 | Text ordering is by Unicode code point, not UTF-16 unit. FORMULAS §4. | "Code point order" must mean it; JS `<` differs on astral characters. |
| 2026-11-05 | `if` returns the chosen branch's value unchanged; a roll stays a roll. FORMULAS §5. | `if` is selection, not coercion. |
| 2026-11-05 | Query results of `contents(zone)`, `zones_containing`, `on`, `objects` are ordered by ascending `z` (empty = 0), then id by code point; the evaluator sorts. The `contents` cell keeps stored order. Candidates are evaluated in id order before any geometry read or predicate. FORMULAS §5. | Every host agrees on order and on which error a query returns; `on` comes out nearest first; Draw depends on stored order. |
| 2026-11-05 | Errors in `where`/`sort`/`objects` expressions are strict: one item's error makes the whole result that error. FORMULAS §5. | Treating errors as false would hide typos (§2.1: a condition on an error yields the error). |
| 2026-11-05 | Aggregates take exactly one argument; a scalar is a one-item list and `empty` is `[]` (`max(a, b)` is `#TYPE`); all but `len` skip empty items; `min`/`max` return the item; `sum` of dice is `#TYPE`; `has` with an empty left side is false. FORMULAS §4, §6. | One call shape for every aggregate; variadic forms would be a second way to say the same thing. |
| 2026-11-05 | Spatial queries: the host supplies a candidate set defined over literal geometry (literal index bounds intersecting the query bounds, plus every board object with a formula-valued geometry cell); the evaluator reads candidate geometry in id order through recorded reads and computes membership, overlap, and distance with the schema geometry; geometry-read errors become the query's result. FORMULAS §6. | Exact semantics live in one pure place and are host-independent; a spatial index only accelerates. |
| 2026-11-05 | An object whose position is not two finite numbers is excluded from `contents`, `zones_containing`, `on` (not `objects`); a shapeless object has a point footprint, which `on` counts as overlapping when inside the other footprint. FORMULAS §6. | Invalid geometry must not error a whole query; tokens without a shape still stack. |
| 2026-11-05 | `distance(a, b)` is Euclidean between anchors in raw board units; empty if either is off-board or has an invalid position; `#TYPE` across boards. Grid metrics and `unit` stay open. FORMULAS §6. | Smallest definition that is right for gridless boards; units wait for a need (§11). |
| 2026-11-05 | `visible_to` is consumed through `toViewers`: viewers as is, a character ref as a one-entry set, a list of refs and viewer sets as their union; anything else admits nobody. FORMULAS §7. | Makes `visible_to = owner` and lists of characters work as §2 documents, and fails closed. |
| 2026-11-05 | Query dependencies are also invalidated by `name` and `is_zone` changes. FORMULAS §7. | `obj(name)` depends on names and zone queries on `is_zone`. |
| 2026-11-05 | Budget replaces any depth limit: 20,000 units per formula evaluation; each cell read, existence check, spatial candidate tested, and id enumerated by `objects()`/`obj()` costs 1; a computed dependency costs 1 regardless of its own cost. Exceeding it is `#LIMIT`. No dependency-depth limit: iterative resolution, each dependency evaluated at most once per revision, identical results across caches and read orders. FORMULAS §7. | The charge and the result are the same on every host and every evaluation order; a depth cap would make results depend on the entry point. |
| 2026-11-05 | Propagation is lazy pull with dirty marking; a commit marks dependents dirty once; the authority decides which cells to recompute and send. FORMULAS §7. | Recomputation follows what is read and sent, not every edit's full closure. |
| 2026-11-05 | The M1 fixture runner applies `set`, `override`, `clear_override`, and `move` steps and checks `cell` and `cell_error`; every other step and expectation is skipped and reported. | Covers what the formula engine owns without the M2 authority; skips are visible rather than silent. |
| 2026-11-05 | A move never changes the `owner` cell; moving onto a board ends containment, not ownership. DESIGN §4.1; FORMULAS §8.3; FIXTURES §6. | "Ownership" meant two things: the `contents` tree and the `owner` cell. A card dropped on the table is still its owner's. |
| 2026-11-05 | `is_character` is a per-object field like `is_template`, not a cell, copied on spawn. View-as lists objects with `is_character` true and `is_template` false; a non-character viewer sees nothing; `owner` is not validated against it. Fixture runners set it for `setup.characters`. DESIGN §4.1. | View-as needs a definite list of characters; a flag keeps that out of the cell model and lets fixtures declare characters without a new cell. |
| 2026-11-05 | Spawn: ids `<original id>_<n>` from `next_seq`, skipping reserved ids; every copy's `template` is its own original; root copy `is_template` false, descendants keep theirs; `is_zone`, `is_character`, `tag`, `shape`, actions, per-cell visibility copied; refs into the copied subtree remapped in cell values and per-cell visibility, others kept; formula source verbatim; a container destination without index appends in call order. DESIGN §4.1; FORMULAS §8.3. | Copies must be deterministic and readable (5.3), remapping must reach every place a reference can live, and Lock targets must create rows in target order. |
| 2026-11-05 | One id namespace for boards and objects; an id is reserved for the document's lifetime once allocated. `next_seq` only increases and `retired_ids` only grows; user undo never reverses either. Undoing a creation removes and retires; undoing a removal restores under the same ids. Only historical rewind resets the counters. DESIGN §4.1. | "Never reused" must survive undo: spawn, undo, spawn must not hand out the same id, and a board id must not collide with an object id. |
| 2026-11-05 | Removing an object removes its contents recursively; references elsewhere dangle and read as `#REF`; undo restores the subtree under the same ids. DESIGN §4.1. | Cascade follows the containment tree; leaving references in place lets undo heal them. |
| 2026-11-05 | Structural cells have defaults: `name` empty, `tag` [], `visible_to` all, `owner` and `template` empty, `contents` [], `container` empty, `board` and `position` empty in a container, `rotation` and `z` empty (read as 0), `face_up` true, `opaque` false, `is_zone` false, `shape` empty; `is_template` and `is_character` false. FORMULAS §3.1. | FIXTURES §3 left defaults to M2; every object needs a defined starting state. |
| 2026-11-05 | `position` is `[x, y]`, present exactly when the object is on a board; board units, x right, y down; `rotation` is degrees clockwise on screen about the anchor; empty `rotation` and `z` read as 0. FORMULAS §3.1. | Geometry, rendering, and fixtures must agree on axes and units. |
| 2026-11-05 | Landing rule: every move or spawn onto a board, including within one board, sets `z` to 1 + the largest literal `z` of the other objects there (absent or empty as 0; an overridden formula `z` counts as literal) unless `z` is a formula; `position` is written as a hand edit (a formula gets an override); board-to-board moves keep `rotation`; entering a container deletes `position`, `rotation`, `z`, recorded so undo restores formulas; after a move to a board `container` is empty. FORMULAS §3.1. | A dropped object should land on top, as at a physical table; reading only literal `z` keeps the move independent of evaluation. |
| 2026-11-05 | `tag` is literal only and `set(tag, list)` is allowed. `shape` cannot be written by actions or cell writes; it changes only through the `setShape` edit primitive, which stores a literal shape value, so `shape` is literal only like `name` and `tag`. `template` is set on every spawned copy and is never a formula. FORMULAS §3.1. | Tags and shapes feed the spatial and tag index; keeping their writes literal and explicit keeps the index independent of evaluation. |
| 2026-11-05 | Exact spatial semantics live in one pure module, `packages/schema/src/geometry/`. The host returns the literal-geometry candidate set; the authority's spatial index computes exactly that set; the evaluator computes membership, overlap, and distance; the opaque-cover test uses the same geometry. DESIGN §4.3; FORMULAS §6. | One implementation of geometry means queries, index, and cover can never disagree. |
| 2026-11-05 | Point membership is boundary inclusive within 1e-9 board units for every shape; for circles the test is `sqrt(dx²+dy²) <= r + 1e-9`. DESIGN §4.3; FORMULAS §6. | A tolerance on `r²` would vary with radius; a distance-based one means the same 1e-9 everywhere. |
| 2026-11-05 | Overlap is positive-area intersection; touching or near-tangent (penetration at most 1e-9) is not overlap. Exception: a point footprint overlaps a shape when inside its region, boundary inclusive; two points never overlap. Zones are never in `on()`. Polygons must be simple. DESIGN §4.3; FORMULAS §6. | Stacking must not be triggered by adjacent tokens; the point exception keeps shapeless tokens stackable; a zone is a region, not something stacked. |
| 2026-11-05 | Opaque cover is independent of `z`: an object is covered when it is on the board of an opaque zone the viewer cannot effectively see and its anchor is in the zone's region; a contained object is covered when its outermost container is; a zone never covers itself; the renderer draws cover above everything. DESIGN §4.4. | Fog must not be defeated by stacking a token above the room; anchor containment matches `contents(zone)`. |
| 2026-11-05 | A cell is visible to a viewer only if its object is (`object_visible`, which includes cover); then the cell's own visibility and the face-down rule apply. DESIGN §4.4; FIXTURES §7. | A public cell of a hidden object must not leak it. |
| 2026-11-05 | An absent `visible_to` reads as the default `all`; a present one is converted with `toViewers` (FORMULAS §7) and a failed conversion admits nobody. The `owner` viewer entry resolves against the object holding the viewer set. DESIGN §4.4. | Distinguishes a missing cell (default) from a formula yielding `empty` or an error (fail closed). |
| 2026-11-05 | Every evaluated visibility input fails closed: an error or non-boolean `face_up` is face down; an error or non-boolean `opaque` is opaque; a zone with unreadable or invalid geometry that the viewer cannot see covers its whole board. The GM is unaffected. DESIGN §4.4. | DESIGN §4.4 says errors fail closed; that has to hold for every input, not only `visible_to`. |
| 2026-11-05 | Per-cell visibility is per-object metadata, `cell_visibility: {cellName: viewers}`, independent of cell content: valid for any user or structural cell name, including absent and field-backed cells; values are literal viewer sets; no entry means the object's visibility. DESIGN §4.4. | Private `tag` or `contents` has no cell content to hang visibility on; metadata needs no fictitious content. |
| 2026-11-05 | An operation group holds resolved effects (cell before/after with cause `edit` or `roll`, per-cell visibility changes, field changes, placements, subtree create and remove, reorders, board changes, id allocation and retirement), actor, kind (`edit`, `action`, `undo`), label, origin, `undoes`, `base_revision`, `revision`, and touched objects' names captured at commit (before removal for removed objects). A logged write records the resulting value. DESIGN §7. | Replay, undo, the log panel, and fixtures all read the same record; the log keeps names as they were (4.8). |
| 2026-11-05 | One transaction is open at a time. The commit point publishes the new document and the group; internal synchronization runs right after, before public notifications; a listener error never turns a commit into an abort. Before the commit point a refusal becomes a rejection result and any other error aborts and propagates; neither consumes dice or randomness. Every commit carries a change summary. DESIGN §7. | No lost updates, no stale reads by early listeners, and scenario errors stay distinct from refusals. |
| 2026-11-05 | Undo targets: `latest` (most recent non-undo, non-undone group; the fixture `undo` step), `actor`, and explicit `group`. No redo. Undo adds its own group. DESIGN §7; FIXTURES §8. | Selective undo per actor is needed once the agent writes alongside the GM; one default keeps fixtures unambiguous. |
| 2026-11-05 | Undo conflict: G conflicts with a later H when H is not an undo, not undone, and shares a touched key (cell keys; per-cell visibility touches the cell's key; a move touches the `contents` keys at both ends; create and remove touch every key on the objects and the parent's `contents` key; allocation and retirement touch nothing). Undo groups never conflict. An inverse that fails an invariant is refused as `undo_conflict`. DESIGN §7; FIXTURES §8. | Defines "surviving"; the parent's `contents` key catches a reorder or sibling insertion after a spawn or removal. |
| 2026-11-05 | Replay applies a group's recorded effects and sets revision to its `revision` (also with no effects); rewind applies exact historical inverses, internal and never persisted, and sets revision to its `base_revision`; a retirement records exactly the ids it added. Stored-state comparison for replay excludes revision. DESIGN §7. | Effects alone never change the revision; rewind must undo retirement exactly while user undo never does. |
| 2026-11-05 | History invariants checked on load: contiguous absolute indices from `first_index`; revision continuity; `kind: "undo"` iff `undoes`; `undoes` names an earlier non-undo index (or one compacted away), none twice; `undo_barrier` in `first_index` … next index; the last group's revision equals the snapshot's unless hand-edited (barrier then equals next index). DESIGN §7. | Strict schemas alone cannot reject a history that makes undo selection and replay disagree. |
| 2026-11-05 | The file holds a fresh snapshot at every save plus retained groups as history (absolute indices, `first_index`, `undo_barrier`); no operations "since" the snapshot. A `snapshot_hash` detects hand edits; the snapshot then wins and the barrier moves to the next absolute index (`first_index` for an empty log). Snapshots at every save and load; checkpoints are Polish, autosave cadence M3. Migration is step by step. Compaction keeps absolute indices and raises the barrier to at least `first_index`. DESIGN §7. | Replaces "snapshot plus operations since"; absolute indices keep the barrier right after compaction. |
| 2026-11-05 | Saving is atomic with two failure stages: before replacement the old file is intact and an error is reported; a durability failure after replacement (directory fsync) leaves the new file and reports the save completed without confirmed durability. DESIGN §7. | "Any failure leaves the original untouched" cannot hold once the rename has happened. |
| 2026-11-05 | Every group records `base_revision`; stale-write policy is M3's. Asset paths are relative to the file's directory; parsing is pure and asset existence is checked only when loading from a path; how an image cell names an asset is M4's. DESIGN §7. | Parsing without filesystem access needs relative paths; the protocol owns conflict policy. |
| 2026-11-05 | Revision continues from the last retained group after a hand edit: when `snapshot_hash` does not match on load, the edited snapshot's contents are kept but the document revision is set to the last retained group's `revision` (unchanged with an empty retained log), then the barrier moves to the next index. DESIGN §7. | A hand-edited file must not break the revision chain for groups committed after the load. |
| 2026-11-05 | The `table` destination is resolved by M5 into a board destination. Renaming a cell does not rewrite formulas, refuses a structural name at either end and an existing destination, and replaces destination per-cell visibility with the source's. Spawn initial cells may be literals or formulas. Shuffle reorders `contents` despite the membership protection. DESIGN §7. | Each closes a gap a primitive would otherwise guess at; renaming must not bypass protected cells. |
| 2026-11-05 | FIXTURES `cell_visibility` maps one to one onto the canonical per-object metadata. FIXTURES §3. | No conversion rules to drift between fixtures and the file. |
| 2026-11-05 | Confirmed: one group per non-rejected step; undo adds its own group; undo reverses the most recent non-undo, non-undone group; no redo; "surviving" as the undo-conflict row. FIXTURES §8. | FIXTURES §8 baked these in ahead of the engine; M2 makes them the engine's. |
| 2026-11-05 | Rejected actions consume no dice (consumption is transactional); unused script entries are an error for complete runs. FIXTURES §5. | A partial runner cannot know whether leftover entries were meant for skipped steps. |
| 2026-11-05 | Set-on-formula, override-on-literal, and clear-without-override stay scenario errors in the format, while the engine's `writeValue` on a formula cell overrides and clearing a missing override is refused. Runners implement the rejection protocol for every step type they support (M2: set, override, clear_override, move, spawn, undo; M5 adds when_false, when_error, step_error). FIXTURES §6, §8. | Fixtures stay precise about intent while the engine follows hand-edit semantics. |
| 2026-11-05 | `object_visible` includes cover; `cell_visible` holds only if `object_visible` holds; formula positions stay in `placement` in the format while canonically `position` is a cell present iff on a board. FIXTURES §7. | Aligns the expectations with DESIGN §4.4 and FORMULAS §3.1 without changing the format. |
| 2026-11-05 | The fixture format gains a `replay` expectation (`ReplayExpectationSchema`, optional `note`), top level or step level: replaying every group's recorded effects onto the post-setup document reproduces the stored state (cells as stored, per-cell visibility, placement, contents order, structural fields, `retired_ids`, `next_seq`; never computed results or revision) and consumes no dice. Every scenario's last step and Fireball's first assert it. FIXTURES §7, §11. | DESIGN §7 promises replay never re-rolls; the M0 review deferred the expectation that tests it to M2. |
| 2026-11-04 | Operation records gain a `field: "actions"` effect holding the object's whole action list before and after; `setActions` replaces the list in one such effect, refusing as `invalid` an unknown object, an empty name or one over 100 characters, a duplicate name (exact comparison), steps that are not a list of text, and what the file schema would reject (a blank `when` or step, an unknown key); `when` and steps are stored verbatim, unparsed. It touches the new undo conflict key `actions:<object>`, which conflicts with itself and with `obj:<object>` (creation or removal); it changes no readable cell, and the change summary lists the object once in `actionsChanged`. DESIGN §4.5, §5.2, §7; FORMULAS §8. | Defining actions (§5.2) needs an edit primitive; whole-list replacement keeps one effect per edit and an exact undo, and a separate key keeps action edits from conflicting with cell writes. |
| 2026-11-04 | A board is removable only when no object is directly on it (no cascade); `removeBoard` records the board's removal and the retirement of its id. User undo re-creates the board (appended to the board order) and the id stays retired, so a later `addBoard` with it is refused. DESIGN §4.1, §4.3. | Cascading removal is a policy the UI can build from moves and removes; retiring the id keeps references and history unambiguous, as for objects. |
| 2026-11-05 | M3-D1. Process model: one authority process per table (`vtt-serve <file>`) owns the file and the `Table` and serves the protocol over a WebSocket. The MCP server is a separate stdio process (`vtt-mcp`) launched by the agent host; it attaches to the running authority as a protocol client with an `agent` actor. The authority package ships the MCP server (DESIGN §7 "hosts" becomes "ships"). DESIGN §5.2, §7; PROTOCOL §1, §11. | Stdio is supported by every MCP host; the agent becomes literally a peer client of the UI (§7); the table outlives agent sessions. In-process MCP over HTTP needs HTTP-capable hosts; an agent-launched authority ties the table's life to the agent. |
| 2026-11-05 | M3-D2. New package `@vtt/protocol` (wire schemas, `ProtocolClient`, `ViewMirror`), browser-safe, depending only on `@vtt/schema` and zod, used by the authority, the MCP server and M4's UI. Wire schemas are JSON-Schema-compatible (no `z.custom`, no transforms) so tool input schemas can be generated; `@vtt/schema`'s canonical schemas stay for unfiltered document data. DESIGN §7. | One client for the UI and MCP; putting the client in `@vtt/authority` would make the UI depend on the authority, and schemas with `z.custom` cannot be exported to JSON Schema. |
| 2026-11-05 | M3-D3. Transport: JSON text frames on one WebSocket at `ws://127.0.0.1:<port>/ws`; envelope tagged by `type`; client-chosen request ids echoed in responses; exact-match `protocol: 1` in `hello`. The wire format lives in docs/PROTOCOL.md. PROTOCOL §1, §4. | `type` tagging matches every tagged form in the project (JSON-RPC would clash); a separate doc keeps DESIGN from growing by hundreds of lines. |
| 2026-11-05 | M3-D4. Auth: bind 127.0.0.1 only; a random 256-bit token per server start, required in `hello` (amended by vtt-qf5.32: a generated token never starts with `-`, redrawn until its first character is alphanumeric, so it is safe as a separate CLI argument); WebSocket upgrades with an `Origin` other than the server's own origin or an `--allow-origin` entry are refused with 403. Every authenticated connection has GM authority; `viewer` is a view-as selector, not a security boundary, in v1. DESIGN §5.2; PROTOCOL §2, §3. | The token stops other local processes, the Origin check stops web pages driving the table through the browser; a token in the URL would leak into logs and history. V1 has one person, so viewers are presentation, not rights. |
| 2026-11-05 | M3-D5. Discovery: `vtt-serve` writes `$XDG_CONFIG_HOME/vtt/session.json` (`{url, token, pid, table_path, table_id}`, mode 0600); `vtt-mcp` uses `--url/--token`, else `VTT_URL`/`VTT_TOKEN`, else that file; the last started authority wins. A discovery-based client re-reads the file on every reconnect attempt and adopts a new url and token only when `table_path` and `table_id` equal those recorded at its first connect, else it stops with `wrong_table`; with explicitly supplied credentials a 4401 is terminal (reported `unauthorized`) and in-flight writes report `uncertain`. PROTOCOL §2. | The MCP config need not name the table, and a normal authority restart (new token) is followed transparently, while a restart onto another table is never silently adopted. |
| 2026-11-05 | M3-D6. Commands: one write command `transact` carrying a list of ops (19 kinds, one per M2 primitive, including `set_actions` and `remove_board`) applied in one transaction, which is one group and one undo unit, with batch-local `$name` bindings usable in op id positions and in ref values; plus `undo`, `save`, `invoke`. PROTOCOL §4, §5. | An agent authors a zone, a card and their links atomically as one undoable group; one command per primitive cannot, and a generic document patch would bypass the primitives' invariants (§5.2). |
| 2026-11-05 | M3-D7. Stale writes: every `transact` carries `base_revision`. It is refused `stale_write` when `base_revision` is below the retained-history floor (`truncated`), when a group committed after `base_revision` (undo groups included) shares a key with the ops' declared intended-write keys (checked before any primitive runs, so a write to an object removed since is stale, not a primitive refusal), or when such a group shares a key with the transaction's actual effects (checked after the ops ran, before commit). Keys are the undo-conflict keys of DESIGN §7. Disjoint writes commit; nothing is rebased or re-evaluated. Undo is not stale-checked and may pin its target with `expect_index` (`undo_target_changed`). Replaces "the policy for stale writes belongs to M3's protocol" in §7. DESIGN §5.2, §7; PROTOCOL §6. | Refusing on any intervening commit would make the UI and the agent refuse each other constantly; last writer wins contradicts "rejected on conflict" (§5.2). Ops are explicit, so a disjoint write is safe to commit as is. |
| 2026-11-05 | M3-D8. Retries and identity: `hello` carries a client-chosen `client.instance` kept across reconnects; `welcome` carries the authority `session` id, new at every authority start. `transact` may carry `txn_id`; the deduplication key is (`client.instance`, `txn_id`) with a fingerprint of the params; a repeat with the same fingerprint returns the stored result, one with a different fingerprint is rejected `invalid`. Only structural, state-independent validation precedes the lookup, so an identical retry always gets the stored outcome. The authority keeps the last 1,000 txn ids per client instance, in memory only. A client retries an in-flight write only after reconnecting to the same `session`, marking the resend `retry: true`; a marked resend whose key is no longer retained is answered `retry_unknown` instead of executing; after a session change or `retry_unknown` the client reports `uncertain` and never re-executes. Persistent deduplication is Later. DESIGN §7; PROTOCOL §6. | A retry without deduplication may double-apply; tying retries to the session means a restart (which loses the store) can never cause a silent re-execution. |
| 2026-11-05 | M3-D9. Actors: `client.kind: "agent"` gives `{type:"agent", name}`; `ui` and `test` give `gm`; non-agent connections may pass `actor: {type:"character", id}` per `transact` (the GM driving a character); agents cannot. PROTOCOL §3. | Matches FIXTURES §1's "the GM driving this character" and keeps the agent from impersonating anyone in the log. |
| 2026-11-05 | M3-D10. Subscriptions: per connection, each with a scope (`board` including contents recursively, `objects` with optional subtree, `all`, `log`) and a viewer; `subscribe` returns full views; afterwards one `commit` event per commit per connection with the group header and, per subscription, upserted whole object views, removed ids, cover changes, and for `log` scope group upserts and removals over a window of the newest 200 retained groups. After each commit the authority evaluates what the changed subscribed views need (their cells, those cells' transitive dependencies, and the visibility and geometry inputs the views need, even outside the scope); every other dirty cell stays dirty until read (FORMULAS §7). DESIGN §5.2; FORMULAS §7; PROTOCOL §8. | Raw op groups cannot be sent to character views (results, never inputs); valueless notifications force re-queries; whole-view upserts keep mirrors simple, and cell-level patches stay Polish. |
| 2026-11-05 | M3-D11. Cell views: GM views carry value, kind, formula source, override flag, per-cell visibility entry and full actions; character views carry value, kind, override flag and action names only, never formula source, action source or per-cell visibility metadata, in object views, group effects and explain alike. Every readable structural cell except `id` (with defaults) is part of a view's `cells`. DESIGN §4.4; PROTOCOL §7.2. | A formula source can embed secrets (`if(roll >= 15, ...)`), and FORMULAS §9 lets the author decide what a formula publishes; structural cells as ordinary cells make per-cell visibility on `tag` or `contents` filter uniformly. |
| 2026-11-05 | M3-D12. Redaction: in character views a ref (top level, in lists at any depth, in viewers values) to an object the viewer cannot see, or to an id that is neither a live object nor a board, is the wire-only value `{type:"redacted"}` in place, so contents keep their count; a ref to a board is never redacted (boards are not a visibility boundary, DESIGN §4.3); an error whose origin the viewer cannot see keeps only its code. Group effects use separate presentation types (`EffectView`) filtered per effect variant. DESIGN §4.4; PROTOCOL §7.3, §7.6. | Ids are meaningful by design (§5.3), so leaving them would leak `goblin_assassin`; dropping refs would change lengths a real table shows (a hand's card count). |
| 2026-11-05 | M3-D14. Covers: character views carry, per board in scope, a `Cover` (region: position, rotation, shape; or `whole_board` for an undetermined zone) for each opaque zone on that board that is not effectively visible to the viewer (M2's `isEffectivelyVisible` on the zone, the predicate of M2's cover oracle, never `canSeeObject`), keyed so the zone id is not revealed; the zone and covered objects are absent. An `objects` scope gets the covers of every board its objects are on (a contained object counts on its outermost container's board). DESIGN §4.4; PROTOCOL §7.5. | The renderer must draw the cover without learning the zone; sending the zone with hidden cells would leak its id and name. Using the oracle's predicate makes drawn covers agree with object visibility. |
| 2026-11-05 | M3-D15. Log filtering for characters is by current visibility, per effect variant: effects limited to what the viewer can see now, `names` entries only for objects whose `name` cell the viewer can read, an object that no longer exists counts as invisible, groups with nothing left omitted, header kept except that `label` is `null` unless every effect of the group (other than id bookkeeping) is visible to the viewer unreduced. DESIGN §4.4; PROTOCOL §7.6. | Historical visibility would need rewind and re-evaluation per group; a GM-written label may describe hidden effects, so it is shown only when nothing was hidden. |
| 2026-11-05 | M3-D16. Explain: `explain_cell` returns content (source, override, whether it parses), the recorded dependency tree to depth at most 4 and at most 200 nodes with values (for characters: hidden cells named without value, invisible objects as `object: null`), the error-origin chain and the last writing group; `explain_group` returns effects plus the origin action's current definition; `explain_action` returns the `when` source, value and enabled state, and step text. An explain target the viewer cannot see (object, cell, group) answers exactly the same `not_found` as a nonexistent one. DESIGN §4.4, §5.2; PROTOCOL §9. | FORMULAS §9: tracing names a hidden cell without its value and does not highlight invisible objects; an identical `not_found` keeps explain from being an existence oracle. Recording action definitions in groups would be a schema change. |
| 2026-11-05 | M3-D17. MCP tools: `table_info`, `list_objects`, `get_objects`, `evaluate`, `zones`, `at_position`, `changes_since`, `log`, `explain_cell`, `explain_group`, `explain_action`, `transact`, `undo`, `save`, `subscribe`, `poll_changes`, `unsubscribe`; input schemas generated from the protocol schemas; rejected writes return `isError: true`; resources `vtt://docs/formulas`, `vtt://docs/design`, `vtt://docs/protocol`, `vtt://schema/ops`, `vtt://subscriptions/<handle>`. DESIGN §5.2, §5.3; PROTOCOL §11. | One `transact` tool with a discriminated op union keeps the tool list short and batches atomic; docs as resources give the agent the language spec (§5.3). |
| 2026-11-05 | M3-D18. MCP subscribe: a change buffer per subscription in the MCP process under a stable MCP handle (unchanged when the protocol subscription id changes on reconnect), drained by `poll_changes` (long poll up to 30 s), plus `notifications/resources/updated` on `vtt://subscriptions/<handle>`; records carry cell changes and object flag and action changes; cap 1,000 records, then `overflowed`, after which the agent re-reads the subscription resource for current state. PROTOCOL §11. | Most hosts do not surface notifications to the model, so polling is the reliable path; `changes_since` alone would not satisfy "Subscribe" (§5.2). |
| 2026-11-05 | M3-D19. `invoke` is part of protocol v1 and answered `unsupported` until M5; M5 adds its MCP tool together with the UI's buttons. PROTOCOL §4, §11. | Fixes the method's shape now without an always-failing tool in the agent's list. |
| 2026-11-05 | M3-D21. Limits: `max_message_bytes` 1 MiB applies to client-to-server frames only; server-to-client messages have no size limit, so an initial view of a few-thousand-object table is one response (chunked delivery is Later); the slow-consumer threshold `max_buffered_bytes` is 64 MiB (closed 4429); the other limits as in PROTOCOL §10 (`max_ops` 1,000, `max_page` 200, `max_ids` 200, `max_subscriptions` 16, `max_explain_depth` 4, `max_explain_nodes` 200, `max_source_length` 10,000, `max_groups` 500, `max_log_window` 200, `max_txn_ids_per_client` 1,000, `max_requests_per_second` 200). Formula cost stays under the engine budget. DESIGN §5.2; PROTOCOL §10. | "A runaway agent cannot stall the table" (§5.2): a rate limit stops a flooding agent starving the UI, while capping server messages would break the initial view of a v1-sized table. |
| 2026-11-05 | M3-D22. Ordering: each connection's messages are handled one at a time in arrival order; every method except `save` is handled synchronously, so commits are totally ordered by revision, every connection receives every commit event in revision order, and the committer receives the commit event before its response; `save` awaits file I/O while other connections proceed. PROTOCOL §8. | With the response first, clients would have to handle a known revision whose delta has not arrived. |
| 2026-11-05 | M3-D23. Reconnection: no server-side resumption; the client re-sends `hello` with the same `client.instance`, resubscribes and replaces its mirrors with full views (`resync`); requests never written to a socket fail `disconnected`, while a write already sent whose outcome cannot be settled reports `uncertain` (M3-D8); a resubscribe failing for a transport reason leaves the subscription `recovering` for the next connection, while an error response from the server makes it terminal (an `error` report, mirror emptied, the subscription object or MCP handle kept); the client is ready for ordinary callers only once every live subscription is resubscribed or terminal, reporting `disconnected` with `recovering: true` until then; every live mirror's revision advances on every processed commit, including commits with no delta for it; ping every 15 s, two missed pongs terminate. PROTOCOL §8. | Resuming from a revision with buffered deltas is complex, and full views are cheap locally; distinguishing transport from server failures keeps a flaky socket from killing subscriptions. |
| 2026-11-05 | M3-D24. Autosave: 2 s after the last commit, at most 10 s after the first unsaved commit, on `save`, and on shutdown. Saves are serialized; each captures its snapshot and revision synchronously when it starts and marks only that revision saved; the asset list loaded with the file is kept through every save; a failed save is retried after 1 s, 5 s, 30 s, then every 60 s until that revision or a later one is saved; `saved_not_durable` does not mark the revision saved (it is retried like a failure); results are broadcast; shutdown awaits outstanding saves and its final save, never throws for a save failure, reports `{saved, revision, error?}`, and always releases the lock. No automatic compaction in v1. Replaces "autosave cadence is M3's" in §7. Amended by M4 (vtt-3l6.25): the asset list grows by import, an import schedules a save like a commit, and saved state is the pair (revision, assets generation). DESIGN §7. | Saving per commit would fsync constantly during drags; a periodic save alone loses up to a period of work. Capturing the revision at the start keeps "saved" truthful while commits continue. |
| 2026-11-05 | M3-D25. New table and files: a missing file is created with one board `gm_board` named "GM" and no objects; default port 4747; lock and identity paths derived from the canonical (realpath) table path, so symlink aliases share them; lock file `<file>.lock` created exclusively (`wx`), cleaned up on any failure after creation, released only by its owner (nonce check), released on every failed open; table identity file `<file>.table-id` holding a random id, created under the held lock (temp file and rename) and never rewritten; an empty or malformed identity file fails the open. Amended by M5-D19. DESIGN §7; PROTOCOL §2. | A fixed default port keeps the UI URL stable; the identity file lets clients recognise a table across restarts without changing the table file format, which has no id. |
| 2026-11-05 | M3-D26. Step 5 acceptance writes the hatch as an ordinary cell `pattern: "hatch"` (M4 decides appearance cells) and authors the Fireball card from scratch. DESIGN §8.4. | "Hatch it" names no cell and appearance cells are M4's; authoring the card from scratch exercises "define actions" rather than spawning a prepared template. |
| 2026-11-05 | M3-D27. Runtime dependencies: `ws` 8.22.0 (with `@types/ws` 8.18.2), `@modelcontextprotocol/server` 2.3.1 (with `@modelcontextprotocol/client` 2.3.1 for tests), `tsx` 4.23.15 to run the binaries, `zod` 4.6.7. New runtime dependencies are pinned exactly and recorded in the decision log. DESIGN §7. | Node has a WebSocket client but no server, and hand-rolled framing is a security-sensitive parser to own; the v2 MCP server package uses zod 4 without v1's HTTP framework tree; extensionless relative imports do not run under Node's type stripping, hence tsx. |
| 2026-11-05 | M3-D28. `evaluate` (ad hoc formulas) is GM-only. PROTOCOL §9. | Evaluating arbitrary source as a character would be an oracle for hidden values, and its result cannot be filtered meaningfully. |
| 2026-11-05 | M3-D29. `at_position`: objects directly on the board whose evaluated footprint contains the point (boundary inclusive; shapeless: anchor within epsilon), zones listed separately, both ascending `z` then id; contained objects excluded. PROTOCOL §9. | One order across the product (FORMULAS §5); footprint matching answers "what is under the cursor" better than anchors alone. |
| 2026-11-05 | M3-D30. A GM-only `document` method returns the canonical snapshot and retained log; no MCP tool. PROTOCOL §4, §9. | The protocol scenario runner needs it for `replay` and bulk reads; agents have the filtered queries. |
| 2026-11-05 | M3-D32. Compatibility: the authority parses client messages strictly (unknown keys are `bad_request`); clients parse server messages forward-compatibly (unknown keys ignored, unknown message types and event kinds ignored with a warning, unknown `EffectView` variants dropped with a warning, never a disconnect for these); a response's `result` is validated by the client against the schema of the pending request's method (looked up by id), and a result that fails it fails that request only; a change that breaks a v1 client bumps `protocol`. PROTOCOL §10, §12. | Strict input catches client bugs at the boundary; loose output lets protocol v1 grow additively (M5's fields) without breaking older clients. |
| 2026-11-05 | M3-D33. Stale locks: v1 refuses stale locks; takeover is manual via `vtt-serve --force-unlock`. PROTOCOL §2. | No file-system protocol available here can tell a stale lock from a live one created between the read and the takeover, so automatic takeover could let two authorities own one file. |
| 2026-11-05 | M3-D34. Object-free ad hoc evaluation: `AdhocOptions.thisId` is optional; with no object, `this` is `#REF` ("no object in scope"), a bare cell name is `#NAME`, and everything else evaluates as usual, with budget and dependency recording unchanged. `evaluate` without `this` uses it. FORMULAS §2; PROTOCOL §9. | Replaces vtt-5su.8's workaround of evaluating on the first board, which made `this` a board reference and answered `#REF` for everything when the document had no boards. |
| 2026-11-05 | M4-D1. The authority serves the built UI at `/` with the session token injected into the page and refuses HTTP requests whose `Host` is not its own loopback address; image assets are served at `/assets/` only for paths listed in the table file's `assets`, with `no-store` and the same `Host` check, and uploaded with `POST /assets`. PROTOCOL §1, §2; DESIGN §7. | One process and one URL for the GM; the `Host` check closes DNS rebinding, which the WebSocket `Origin` check already covers for `/ws`. |
| 2026-11-05 | M4-D2. An image cell is the ordinary text cell `image` holding an asset path relative to the table file, as listed in the file's `assets`; imported images are stored in `<table>.assets/` as `<slug>-<hash8>.<ext>` (PNG, JPEG, WebP, GIF; no SVG) and never garbage-collected in v1. Replaces "how an image cell names an asset is M4's decision" in §7. DESIGN §4.6, §7. | A text cell needs no new value type, schema or formula change; hashed names are readable, collision-free and deduplicated; SVG can carry script. |
| 2026-11-05 | M4-D3. Asset upload is HTTP (`POST /assets`); the UI and the MCP process (tool `import_asset`) both use it. DESIGN §5.2, §7; PROTOCOL §1, §11. | A map image exceeds the 1 MiB client frame limit and is not a document operation; the MCP process is local and can read a path and POST it, so §5.2's parity rule holds with no gap. |
| 2026-11-05 | M4-D4. Appearance is ordinary user cells read by the renderer: `image`, `color`, `pattern` (`hatch`), `text`, with `name` as the label; unreadable or ill-typed appearance cells are not drawn. DESIGN §4.6. | Keeps appearance inside the cell model (formulas, overrides, per-cell visibility apply unchanged) and keeps M3-D26's `pattern: "hatch"` as written; a structured `style` cell is not storable and structural appearance cells would change FORMULAS §3.1 and every view. |
| 2026-11-05 | M4-D5. Face-down objects show a generic back in v1 (plus `name`; the GM also sees a face-down glyph); per-object backs would need a cell in the face-down exemption set. DESIGN §4.4, §4.6. | `FACE_DOWN_EXEMPT` has no appearance cell, so a per-object back cannot be shown to non-owners without an M2 change; no fixture needs one (Later). |
| 2026-11-05 | M4-D6. Cell input: a leading `=` is a formula, in any value editor (the formula bar shows and edits the current formula source; `name` is always text); otherwise literal syntax (numbers, quoted text, booleans, `empty`, dice, lists) or `@id` is that value and anything else is text; a literal typed over a formula is an override; replacing a formula is an explicit command. Replaces "the only place formulas are typed" in §4.6. DESIGN §4.6. | One grammar for every editor; spreadsheets train `=`; typing a literal over a formula keeps §4.2's override model instead of silently discarding the formula. |
| 2026-11-05 | M4-D7. The UI's undo targets the GM's own latest group (`mine`); every UI write carries the revision its interaction began on; stale writes and uncertain outcomes are shown to the GM and never retried automatically. DESIGN §7 Undo. | `latest` would undo the agent's last edit when the GM presses Ctrl+Z after an agent write; a revision taken when the interaction began is what makes a concurrent edit stale (a later one would hide the conflict); the mirror already shows the winner, so a retry or rebase would overwrite it. |
| 2026-11-05 | M4-D8. On the canvas, copy-versus-move is decided at drag start: one selected template without Alt spawns a copy where it is dropped, Alt moves it; other selections containing templates are moved. DESIGN §4.6, §4.7. | §4.7's "dragging a template straight onto the table creates a copy there" without binders, which M5's drag-out reuses; deciding at drag start keeps a modifier change mid-gesture from changing the outcome, and a multi-object spawn would have no single drop target. |
| 2026-11-05 | M4-D9. On the canvas, for non-template drags, Alt held at the drop onto an object puts the dragged objects into its `contents`; a plain drop places on the board (stacking). DESIGN §4.6. | Nesting on every drop would be too easy to do by accident; a die stacked on a token must stay a board placement for `on()`. |
| 2026-11-05 | M4-D10. Until face layouts (M5) an object draws its shape, image, color, pattern, `text` and `name` label; labels hide below 24 px on screen; dependency tracing highlights what a hovered formula references and a hovered zone's contents, filtered by the viewer. DESIGN §4.6. | Fixes what M4's "§4.6 (partial)" covers: enough to see and edit objects before faces, with one level-of-detail rule; tracing uses the protocol's `explain_cell` and `zones`, which are already viewer-filtered. |
| 2026-11-05 | M4-D11. View-as switches the viewer of what is drawn and inspected; the inspector is read-only there and shows the character's view; edits on the canvas are still the GM's. DESIGN §4.4, §4.6. | The GM drives everything in play (§8.4 step 8) while checking what a character sees ("HIT shows; AC does not"); the inspector is GM territory (§4.6), so it shows but does not edit the character's view. |
| 2026-11-05 | M4-D12. `create_object` takes an optional `id_base`; the authority allocates `<id_base>_<n>` as spawn does; GM object views carry `absent_cell_visibility` so visibility rules on absent cells can be inspected. PROTOCOL §5, §7.2; DESIGN §4.1, §4.4, §5.3. | UI-created objects must be human-meaningful from the first commit (§5.3) without a racy client-side retry loop; per-cell visibility is valid for absent cells (§4.4), so the GM's inspector must be able to see and clear such entries. Both are additive (PROTOCOL §12). |
| 2026-11-05 | M4-D13. UI tests: pure logic in node, the renderer against a recording 2D context, components in jsdom with an injected renderer, integration against a real in-process authority; no browser automation in v1's test suite. CLAUDE.md Conventions. | Fast, deterministic tests in the existing four checks; jsdom has no 2D context and a native canvas or canvas mock adds weight without asserting draw order; browser automation needs a Chromium download on every machine (the manual browser checklist stays the user's). |
| 2026-11-05 | M4-D14. `@testing-library/user-event` 14.6.8 (dev dependency of `@vtt/ui`) for UI interaction tests. | Realistic typing and pointer sequences in jsdom; its peer `@testing-library/dom` is already present. Pinned exactly per CLAUDE.md. |
| 2026-11-05 | M4-D15. Per-object render caching is deferred until profiling asks; v1 ships viewport culling and an image cache (vtt-qf5.10). Replaces "per-object render caching" in §7 Platform. DESIGN §7. | Bitmap caches add invalidation logic before any profile shows a need; principle 8 (§3) allows deferring performance work. |
| 2026-11-05 | M4-D16. Covers are drawn above every object and object-related overlay; only viewer-independent chrome is drawn above them, and the in-place editor never shows over a cover (its rectangle must intersect none). DESIGN §4.4, §4.6. | A selection outline, handle, ghost or editor drawn over a cover would reveal the shape or position of a covered object; chrome such as the marquee carries nothing about the table. |
| 2026-11-05 | M4-D17. "Replace formula with value" is `set_value` with `replace: true`: one cell effect from the formula (and any override) to the literal, valid on structural cells, undoable. PROTOCOL §5; DESIGN §4.2, §4.6. | `delete_cell` is refused on structural cells such as `visible_to` (a zone's re-hiding formula), and `delete_cell` + `set_value` would be two effects; one invariant-preserving cell effect keeps the replacement one exact undo. |
| 2026-11-05 | M4-D18. `ws` 8.22.0 (with `@types/ws` 8.18.2) as dev dependencies of `@vtt/ui`, the authority's pinned versions (M3-D27), used only by the UI's test helper (`packages/ui/test/support/authority.ts`) as the WebSocket client injected into `createTableSession`. | jsdom's WebSocket cannot open a connection under Vitest's jsdom environment (undici dispatches Node events through jsdom's `Event` global), so jsdom component tests against a real authority need a Node client; `ws` is already in the workspace, and its types are needed because the UI typechecks its tests. |
| 2026-11-05 | M5-D1. `invoke` takes `object`, `action`, `base_revision` and optional `txn_id`, `retry`, `actor` (character), `label` and `table` (the board and point the `table` destination resolves to); it declares `obj:<object>` and `actions:<object>`, is stale-checked on its effects like `transact`, shares `transact`'s deduplication (the method is part of the fingerprint), and evaluates `when` at the current revision; results carry the created ids or the refusal with its step index; the command runs the action inside its own transaction (`runAction`) and checks stale keys before commit. PROTOCOL §4, §6. | Actions consume randomness, so a lost response must be resendable exactly once; the log must name the character the GM drove; the authority cannot know the GM's viewport. |
| 2026-11-05 | M5-D2. Action steps have a step-level grammar in `@vtt/formula`: `set(path, expr)`, `add(path, expr)`, `append(path, expr)`, `roll(expr) -> path`, `move(expr, dest)`, `spawn(expr, dest, {name: expr})`, `remove(expr)`, `shuffle(expr)`, `each(expr, step)` whose second argument is parsed recursively as a step (one level); expression arguments are parsed with the expression parser's prefix mode and `->` is step syntax, never an expression operator; paths are names or `….name`; destinations are `table`, `board(b, p)`, `beside(r)` or a reference; none of these words is reserved. FORMULAS §8.4. | Steps reuse the one expression grammar; reserving words would break cells named `board` or `table`. |
| 2026-11-05 | M5-D3. Step semantics: `add` treats rolls as their totals and `empty` as 0 and writes a number; `append` appends one item to a list or `empty`; `each` over `empty` runs nothing and over a scalar once; `set` refuses protected cells and `shape`; expression errors abort with their code. FORMULAS §8.3. | FORMULAS §8.3 was ambiguous about `empty`, and the Attack card's Apply adds a roll. |
| 2026-11-05 | M5-D4. `beside(r)` places right of `r` (or of its outermost container on a board), touching-plus-0.25 by footprint widths; `table` resolves to the `table` parameter of `invoke` and is a step error without it. FORMULAS §8.2; DESIGN §7 Smaller decisions. | The authority cannot know the GM's viewport; `beside` had no placement rule. |
| 2026-11-05 | M5-D5. Limits: `max_each_items` 1,000 and `max_action_writes` 10,000 per invocation (`#LIMIT`); `max_face_elements` 200 per list. PROTOCOL §10. | A runaway `each` over `objects()` must not stall the table. |
| 2026-11-05 | M5-D6. Action refusals: `when_false`, `when_error` (with code; `#SYNTAX` for an unparsable guard), `step_error` (step index, optional code; `#SYNTAX` for an unparsable step, found before any step runs); primitive refusals inside a step keep their own type. Schema `Rejection`; FIXTURES §6; FORMULAS §8.1. | FIXTURES §6 predicts these reasons; primitive reasons stay distinguishable. |
| 2026-11-05 | M5-D7. A face layout is an object field `face` (`elements`, `collapsed`, `default_action`) replaced whole by `set_face` (conflict key `face:<object>`), copied verbatim on spawn and carried in create/remove snapshots; element rects are board units in the object's unrotated local frame (the shape's bounding box; collapsed faces in a fixed 6 × 0.6 row frame). DESIGN §4.1, §4.6; PROTOCOL §5, §7.2. | Faces are data like actions: one effect per edit, an exact undo, no new value type. |
| 2026-11-05 | M5-D8. Show-when is a formula over cells evaluated by the authority and sent as a boolean; zoom is an element's `min_size` (on-screen px) applied by the UI; collapsed is a separate element list; character views get neither source nor hidden elements. Amends the face-elements row of 2026-11-04. DESIGN §4.6; PROTOCOL §7.2. | Formulas evaluate only in the authority and their sources are GM-only; zoom changes continuously and locally. |
| 2026-11-05 | M5-D9. Objects with guards or show-when are re-viewed after every commit; dependency tracking for them is deferred. PROTOCOL §8. | Simple and exact; tracked expressions are a Polish optimization (vtt-qf5.25). |
| 2026-11-05 | M5-D10. Objects without a face layout show their action buttons and contents below them; contents elements scroll per session (never stored); an expanded contained object is drawn as on a board, scaled into its row; a single click on an editor element and a double-click on a value element edit in place; a double-click on an object with a `default_action` invokes it; dropping an object on an editor element sets that cell to a reference to it; dropping on a contents element inserts it there (a single template without Alt is copied). DESIGN §4.6, §4.7. | Actions and contents must be reachable without authoring a face; §8.4 steps 9 and 10 name these gestures. |
| 2026-11-05 | M5-D11. In view-as, pressing a button invokes as the viewed character (`actor`); other edits remain the GM's. DESIGN §4.4, §4.5. | FIXTURES §1: a character actor is the GM driving that character, and the log records it. |
| 2026-11-05 | M5-D12. The UI never invokes actions on templates; templates change only by editing. DESIGN §4.7. | 'The template itself is never mutated by play.' |
| 2026-11-05 | M5-D13. Binders are canvas objects with a contents element; there is no DOM binder panel. DESIGN §4.7, §7. | One face renderer and one interaction stack; drag-out and drop-onto-cell are canvas gestures. |
| 2026-11-05 | M5-D14. Expanding a template entry makes (or reuses) a working copy right after it and expands that copy. DESIGN §4.7. | §8.4 step 10: 'expand the Attack card … (a working copy appears)'. |
| 2026-11-05 | M5-D15. The fixture format gains setup `face` and the `face_element` expectation (shown in a viewer's face); Attack card scenario asserts its show-when. FIXTURES §6, §7, §11. | FORMULAS §10 and FIXTURES §9 anticipate show-when in the format. |
| 2026-11-05 | M5-D16. Card lifetime is manual: cards are discarded by an action or by hand. | DESIGN §9 leaned manual; nothing in v1 needs automation here. |
| 2026-11-05 | M5-D17. Edit-template is a gear that selects the template for editing; no save-to-template in v1. | The least surprising affordance; propagation is vtt-y1w.3. |
| 2026-11-05 | M5-D18. Shared templates live in the GM binder. A binder is an object tagged `binder`; dropping a template onto a binder's contents element gives a template (one `transact`: `spawn` as `$copy`, then `set_template_flag` `$copy` true), while dropping onto any other contents element copies an instance. | The recipient must hold a reusable template that makes working copies; one atomic group keeps undo whole. |
| 2026-11-05 | M5-D19. `vtt-serve` creates new tables with a GM binder stocked with the example templates (`--empty` for none). Amends M3-D25. DESIGN §7, §8.1, §8.4 step 1. | §8.4 step 1 expects a stocked GM binder; tests keep the empty table. |
| 2026-11-05 | M5-D20. Ink is the cell `ink` in object-local units; the ink tool draws onto the object under the pointer or creates an ink object; the text tool creates a text object. DESIGN §4.1, §4.6, §8.1. | 'Scrawl in the margin travels with the object' (DESIGN §4.1). |
| 2026-11-05 | M5-D21. The log panel renders resolved effects as sentences, filters by actor, kind and text, and undoes any group by index; action definitions are not recorded in groups. DESIGN §4.8. | The log is the record of resolved effects (§4.5, §4.8); recording definitions would be a schema change. |
| 2026-11-05 | M5-D22. `@vtt/authority` exposes its scenario runner helpers at the dev-only subpath `./test-runner`. CLAUDE.md Conventions. | The UI acceptance test needs the runner's setup helper without duplicating it. |
| 2026-11-05 | M5-D23. Object views carry action definitions (`ActionDefinitionView`: name, and for the GM `when` and steps; also used in effects and snapshots) and, separately, live action state (`ActionStateView`: name, enabled, reason) only in live views; face element views carry `index`, their position in the stored layout, which the fixture `face_element.element` names. PROTOCOL §7.2, §7.6; FIXTURES §7. | Historical effects must not need live evaluation; character filtering must not renumber elements. |
| 2026-11-05 | M5-D24. MCP tools: the request-surface server has 15 tools (14 plus `invoke`); the composed `vtt-mcp` process has 19 (with `subscribe`, `poll_changes`, `unsubscribe` and `import_asset`). PROTOCOL §11. | `import_asset` (M4-D3) already exists; counting the composed process avoids deleting it. |
| 2026-11-05 | M5-D25. `ObjectView.action_states` optional on the wire, always sent in live views: the authority sends it in every live object view; the wire schema (`ObjectViewSchema`) marks it optional and clients read a missing list as empty. PROTOCOL §7.2, §12. | §12 grows protocol v1 only by optional fields, and existing view literals need no churn; consumers use `view.action_states ?? []`. |
| 2026-11-05 | M6-D1. §8.4 is amended: step 2 names characters on their tokens (sheet headers show the owner); step 4's goblin has `dex_save`; step 5's agent writes Aldric's sheet `spell_dc` 14, which the card's `dc` follows; step 7 reveals room 1 by hand before checking the view; step 10's Apply stays visible, disabled, with the reason; step 11's die comes out of the goblin's contents list; step 14 discards the spent card first and also deletes a goblin and undoes it. DESIGN §8.4. | Step 7 contradicted step 3 (every room starts `gm`); step 15 checked a deleted-then-restored goblin no step made; Fireball save rows read `target.dex_save`; a sheet cannot name its character; a hidden button cannot be pressed again. |
| 2026-11-05 | M6-D2. Undo gains the target `human`: the latest group by `gm` or any character (characters are driven only from non-agent connections). The UI's Ctrl+Z uses it, so it reverses a button the GM pressed in view-as and never the agent's work; `mine` is unchanged. Amends M4-D7 (the UI's undo target). Additive on the wire. PROTOCOL §4, §6, §12; DESIGN §7. | A view-as press commits as the character (M5-D11); `mine` would skip it. |
| 2026-11-05 | M6-D3. Example templates: tokens carry `attack_bonus`, `dex_save`, a HIT badge (`hit`, shown when true) and a contents list; an owned sheet's header shows its owner; Apply buttons stay drawn once their roll exists, disabled with the reason after use; Attack and Damage cards show a Discard button. DESIGN §4.7. | §8.4 steps 2, 4, 10, 11 and 12 could not be done as written with the M5 records. |
| 2026-11-05 | M6-D4. The inspector's `image` row offers Upload…, writing the imported asset's path. DESIGN §4.6. | §8.4 step 4 puts an image on a token; the image tool makes a separate object. |
| 2026-11-05 | M6-D5. `pnpm start <file>` builds the UI only when its build is missing or older than its sources (`--no-build` skips) and runs `vtt-serve --open`; `--open` uses `$BROWSER` or the platform opener and never fails the server; `pnpm mcp` runs `vtt-mcp`; local tables live in the gitignored `tables/`. DESIGN §7; PROTOCOL §2. | One command from clone to table without a needless rebuild; stdio MCP launched through `pnpm --silent`. |
| 2026-11-05 | M6-D6. The MCP server sends `instructions` at `initialize`. DESIGN §5.2; PROTOCOL §11. | A bring-your-own agent should find the templates and the write rules without being told by the GM. |
| 2026-11-05 | M6-D7. Example images (`crypt-map.png`, `goblin.png`) ship in `@vtt/fixtures/assets`, generated in-repo. | §8.4 step 3 needs a map; generated art has no licence question. |
| 2026-11-05 | M6-D8. A group's `names` are the touched objects' plus, when the actor is a character, that character's, captured at commit (before removal if the group removes it). Gm and agent actors add nothing. Character group views filter `names` as before. Amends the operation group entry above. DESIGN §7; PROTOCOL §7.6. | The log must name the character the GM drove (M5-D1) and keep names as they were (4.8); a view-as Apply touches only the card and its target, so the header showed the character's id. |
| 2026-11-06 | M6-D9. A double-click on an object's body, image or value element invokes its enabled `default_action` before anything else; only without one (or with it disabled, which counts as absent) does a double-click on a value element edit it in place. The two clicks before it select and never open an editor. An editor element is unchanged (its click opens the editor; the double-click adds nothing); each click on a button is one press and the double-click adds nothing; chevrons and gears are unchanged. Amends M5-D10's double-click sentence. DESIGN §4.6. | Playtest 1 steps 4 and 13: the d20 draws `total` over its centre, so a GM double-click opened the editor (a formula cell: the formula bar) and a view-as one did nothing; only the rim rolled. |
| 2026-11-06 | M6-D10. Hit order is three buckets of the objects under the pointer, each by descending z then descending draw index: non-zones that are not backdrops, then zones, then backdrops, a backdrop being a non-zone whose bounding rect contains the bounding rect of at least one zone under the pointer. Containment wins over z across buckets. Board clicks, drags, double-clicks, Alt+click cycling, marquee order and face hits (`hitOrder` in `scene/hit-test.ts`) all use it. Amends the old non-zones-before-zones rule. DESIGN §4.6. | Playtest 1 steps 3 and 12: a room zone drawn over the map could not be clicked, renamed or dragged without Alt+click; tokens inside a zone must still be picked before it. An Alt-drop through a room zone now lands on the board, not in the map below, as "onto an object (not a zone)" reads. |
| 2026-11-06 | M6-D11. Navigation: a plain wheel (or two-finger scroll) pans the camera by its deltas; Ctrl or Meta with the wheel (how browsers deliver a trackpad pinch) zooms about the pointer; the active tool's `wheel` hook still comes first, so a list that scrolls takes a plain wheel over it, but never a Ctrl or Meta wheel, which zooms there too. Space is heard on the window, so Space-drag pans wherever focus is except in a text field (a Space typed there is ignored and never prevented); middle-drag is unchanged. `+` and `=` zoom in and `-` zooms out, by 1.25 about the viewport centre, as `KEY_BINDINGS` rows. Amends vtt-1xv.16's wheel zoom. DESIGN §4.6, §8.1. | Playtest 1 step 3: a trackpad has no middle button and Space was only seen with focus in the canvas, so panning was undiscoverable; the zoom keys keep zoom for a mouse wheel that now pans. |
| 2026-11-06 | M6-D16. Stocked faces: the HIT badge has no `min_size`, token `name` and `hp` use 8 px, a binder's header shows its owner, the Area save face shows `targets`. `tpl_token` and `tpl_character` `name` and `hp` are `m=8`; `tpl_binder` (and so each character's binder) is headed by `value name sw="owner = empty"` and `value owner sw="owner != empty"`, `name` staying the literal "Binder" (its collapsed row); `gm_binder`, which has no `owner`, keeps its plain `name` header; `tpl_area_save` adds `value targets` between `damage` and a shorter contents list. Amends M6-D3. DESIGN §4.7. | Playtest 1 (vtt-nb8.14): a 0.3-unit element under `m=12` never draws below zoom 0.6, where a GM viewing the map sits, so the badge, name and hp were invisible; `name` is literal-only, so a binder could not name its character; `targets` showed only in the inspector. |
| 2026-11-06 | M6-D12. A contents face element takes the optional boolean `when_selected` (additive; absent is unset; refused unless boolean; `set_face`, views, effects, snapshots and the file carry it unchanged; no `schema_version` change). When true, the element is drawn, hit-tested and offered as a drop target only while its object, or an object contained in it at any depth, is selected, or while a drag with Alt held hovers the object (the Alt-drop-inside gesture); otherwise, when `contents` is non-empty, the object draws a small count badge in the element's place ("3", lower right, drawn at any zoom), hit-testing never reaches the hidden list, and only the Alt-hover offers it as a drop target. Expanded entries in a hidden list keep their per-session expanded state and reappear with it. The default layout of an object without a face (`defaultLayoutFor`) sets it on its contents element; the stocked `tpl_character` and `tpl_token` faces set it on theirs (`contentsList([-1.5, 0.9, 3, 1.2], { m: 24, whenSelected: true })`); binders, cards, hands and sheets leave it unset. Existing tables keep their stored faces: the templates of a table made before this change still show their lists (playtest 2 starts a fresh table). The inspector's Face section shows it as the checkbox "Only when selected" on contents element rows. The guide's gestures become "click the token, then …". Amends M5-D7 (the encoding) and M5-D10 (objects without a face show their contents below them only while selected). Supersedes Polish vtt-qf5.49. DESIGN §4.6, §4.7; PROTOCOL §5; FIXTURES §3. | Playtest 1 steps 2 and 12: lists under tokens clog the board where spatial position matters and are hard to avoid; an empty token list silently took a zone dropped over it (vtt-nb8.11); expanded lists of neighbouring tokens overlap (vtt-qf5.49). One click to show the list keeps it reachable. |
| 2026-11-06 | M6-D13. Snap: `UiState.snap`, a per-session flag (default true, never stored in the table), toggled by the toolbar's Snap checkbox beside Fog, read by tools as `ReducerInput.snap` (absent counts as off). `snapPoint(point, snap)` in `interaction/effects.ts` rounds each axis to the nearest multiple of 0.5. With Snap on at the release, the select tool's board move or spawn puts the grabbed object's anchor (the dragged object under the pointer at pointer down) on `snapPoint` and moves the rest by the same delta; an entry drag's board drop (template copy or working copy) snaps the dropped anchor. Containment drops, drops on contents lists, editor elements and binders, and live drag previews are unsnapped; Alt changes nothing. The grid is a scene flag, `Scene.grid` (the app sets it from Snap), not a renderer option: with it, the Canvas2D renderer strokes 1-unit lines within the visible bounds, before the items, in `GRID_STROKE` at one CSS pixel, only while a unit is at least `GRID_MIN_PX` (8) on screen. Creation and handles (vtt-nb8.34) read the same flag: token, card and note anchors, zone corners, centres, radii (multiples of 0.5) and polygon vertices, and an image's anchor (never its size), snap, previews included; a resize, radius or vertex handle snaps the dragged handle's board point (a rect is recomputed from it in its local frame), clamped to the minimum sizes; rotation is unsnapped. DESIGN §4.6. | Playtest 1 step 2: placing tokens on the map's squares meant typing positions in the inspector. Half units let a token sit on a square's centre or on its corner; a scene flag redraws with the scene's own memo, where a renderer option would need its own redraw path. Creation and resize snapping are vtt-nb8.34. |
| 2026-11-06 | M6-D17. Persistent text keeps a legibility floor: a value element shown as text without `min_size` (or with `min_size` 0), and the when_selected count badge, is drawn at any zoom, and where its fitted font (after shrink-to-fit) would be under 8 CSS px it is magnified about its alignment anchor (left, centre or right of its middle line) until the font is 8 px, the layout otherwise as at any larger zoom (no extra cut) and the 1 px no-text rule not applied to it; the magnified text may overhang its rect, and hit-testing still uses the rect. Elements with a positive `min_size`, editors, buttons and contents rows are unchanged. The floor is in CSS px like `min_size`, so the renderer's dpr scaling applies on top. DESIGN §4.6; amends M6-D12 and M6-D16 ("drawn at any zoom"). | Codex review of vtt-nb8.24 (vtt-qf5.61): at the minimum zoom (1/32) the HIT badge's 0.5-unit rect has 0.82 px after padding and was skipped, and the count badge drew at under 1 px, so "drawn at any zoom" was false; a 1 px badge is not legible, so the badge keeps a minimum size rather than just lowering the 1 px suppression; 8 px matches the smallest `min_size` the stocked faces use for legible text (M6-D16). An author who wants text to vanish when zoomed out gives it a `min_size`. |
| 2026-11-06 | M6-D18. A face button press (any UI `invoke`: face button, `default_action` double-click, the inspector's Run) whose only intervening change is the viewer's own earlier press on the same table is sent after that press's acknowledgement and stamped with the revision the mirror then shows. Invocations are queued per session: a first one is sent at once; one made while an earlier own invocation is unacknowledged waits for it to settle (and, when it committed, for the mirror to show the commit), then is sent with its stamp advanced over own invocations that committed directly on top of it (committed revision = its base + 1). A press preceded by another client's change keeps its stamp and is refused as stale with the existing notice; nothing else is retried or rebased. Refines M4-D7 for own presses. DESIGN §4.5, §7. | Two quick clicks on Roll sent two invokes stamped with the revision at the first pointer down (the mirror had not seen the first commit), so the second was refused as `stale_write` against the GM's own roll: one roll and a stale notice for their own action. The precedent is the face editor's queue (vtt-nb8.22). Advancing only over own commits made directly on top of the base keeps M4-D7's guarantee that another client's change is never hidden. |
| 2026-11-06 | M6-D14. A resize, radius or vertex handle drag of an object with a face layout also writes `set_face`, in the same write as `set_shape` (and `set_value position` where the anchor moves), when the shape's local bounding box changes: each rect of the full list (`elements`) becomes `[x0' + (x − x0)·fx, y0' + (y − y0)·fy, w·fx, h·fy]`, where `[x0, y0]` and `[x0', y0']` are the old and new box origins and `fx`, `fy` the new/old box width and height (a circle's radius handle gives `fx = fy = r'/r`). The factors are taken in the object's unrotated local frame, after Snap (M6-D13); the collapsed list (its frame is fixed), `min_size` and the rest of the layout are unchanged; one undo reverses shape, position and face. The layout scaled is the GM view's at the pointer down, or that of the drag's own pending handle write; the scaled face is previewed with the shape during the drag and held with the write until it is visible (`ScenePreview.face`, vtt-qf5.67). Objects without a face layout and rotation are unchanged. `scaleFace` in `interaction/handles.ts`. Amends M5-D7 (rects stay board units, but a handle resize rewrites them). DESIGN §4.6, §4.7, §8.1. | Playtest 1 step 10: a binder made bigger kept its name and list at the old size inside the bigger box, so the only way to see more was to zoom the whole board. Scaling the rects with the box shows more rows at the same row height in a taller binder and wider rows in a wider one. |
| 2026-11-06 | M6-D15. In GM view, a UI button press (face button, `default_action` double-click, the inspector's Run) on an object whose owning character is known invokes as that character (`invoke`'s `actor`); in view-as, as the viewed character (unchanged). The owning character of an object is the object itself if it is a character; else its `owner` cell when that is a reference to a character; else the owning character of its container, recursively; else none, and the press is the GM's as before. The UI resolves it from the session's GM directory (structural cells of every live object on any board; `owningCharacter` over `ownerLookup` in `actions/invoke.ts`), so a character on another board still counts; the directory decides only the attribution and the owner write, never what the viewer sees or what the press reads. Giving a template to a binder whose `owner` is a character also sets the new template's `owner` to that character, in the same group, on every path: the UI's give-template drop (`spawn` as `$copy`, `set_template_flag`, `set_value $copy owner`), the MCP instructions, and §8.4 step 5's agent; working copies copy `owner` verbatim. Agents are unchanged: PROTOCOL §3 still refuses an agent's `actor` and the MCP tools do not expose it. Visibility stays the viewer's; undo `human` covers these groups. Amends M5-D11 and M5-D18. DESIGN §4.5, §4.6, §4.7, §8.4 step 5; PROTOCOL §3. | Playtest 1 step 10: the GM had to view the world as a character to act as them, and then saw only that character's view. An owned card is the character's whichever view the GM is in; without the owner write a Fireball given by the recipe (which set only `caster`) and dragged onto the board would resolve to no one. Rights are not modelled (v1 has one person). |
| 2026-11-06 | M6-D19. The inspector's Create face (`defaultLayoutFor`) always ends the generated layout with the object's contents list: after the name, cell and action rows, a contents element `{type: "contents", rect, min_size: 24, when_selected: true}` (entries collapsed by default), 6 units wide, centred under the frame, its top `STRIP_TOP_GAP` (0.15) below the last row, one 0.6-unit row per `contents` entry from 1 up to 8, as the faceless default places its list (`defaultContentsRect`, without the action strip, whose buttons are rows of the generated layout). It is included whether or not `contents` is empty. Amends M6-D12. DESIGN §4.6. | vtt-qf5.64: Create face dropped the contents list, so an object that showed its contents while faceless (M6-D12) lost them when a face was created. Every object may hold contents, and an empty when_selected list draws nothing while hidden (not even the badge) and is only an empty drop target while the object is selected, so including it always costs almost nothing, while a layout that silently lacks a list the object later acquires is the worse surprise. `min_size` 24 matches the stocked token faces. |
| 2026-11-06 | M6-D20. Fireball save rows are owned by their target: the stocked `tpl_area_save`'s Lock targets spawns each row with `{target: it, owner: it.owner or it}` (was `owner: it.owner`), so a row's `owner` is its target's `owner` when set and otherwise the target itself. Under M6-D15 a GM-view Roll save on an unowned goblin's row is then the goblin's (the goblin is a character), not the card owner's; a PC's row is that PC's; a non-character token's own owner still wins. No formula change: `is_character` stays unreadable by formulas (§4.1), and `or` returning an operand (FORMULAS §2.1) gives the default. It differs from "the target if a character, else its owner" only for a character whose `owner` names another character, whose row goes to that owner. Visibility is unchanged: the row has no `visible_to`, so its visibility is its container's (the card), and `owner` is read only through `visible_to = owner` (4.4); Aldric's view still shows every row in his card. Amends M5-D18's recipe (the stocked example). DESIGN §4.7; FORMULAS §10 (the Fireball listing); fixture `fireball`. | Playtest follow-up to vtt-nb8.33: with `owner: it.owner` a goblin's row had an empty `owner`, so its owning character fell through to the card's owner and a GM-view Roll save logged "Aldric: Roll save" for the goblin's own save. |
| 2026-11-06 | M6-D21. A double-click within `ALT_CYCLE_RADIUS_PX` (4 screen px) of an Alt+click cycle's point, with the same hit list there, acts on the cycled object instead of the first hit: the select tool selects it and opens its in-place editor, and `withFaces` hands the double-click to the select tool when the cycled object is not the face hit's board object (so another object's face element or `default_action` is skipped). The cycle counts while open and through at most two plain clicks within the radius after it (a browser double-click's own clicks, which still select the first hit and close the cycle as before); a third plain click, a click elsewhere, a drag or a marquee forgets it. A cycle at the first hit, or a double-click beyond the radius, is unchanged. `Tool.doubleClickTarget`, `cycledTarget` in `interaction/select-tool.ts`. DESIGN §4.6. | vtt-nb8.19, vtt-qf5.50: after Alt+click reached a zone under a map image, a double-click there still renamed (or ran the default action of) the top object, so a covered zone could only be renamed in the inspector. |
| 2026-11-06 | M6-D22. A cell effect written by an `add` step carries `added`, the number added (a roll counted as its total, `empty` as 0); no other write carries it, and undo's reversal of an add drops it (a plain write back). The log reads such an effect "Added 14 to G1.damage_taken (now 20)", or "Subtracted 3 from G1.damage_taken (now 17)" for a negative amount, the new value being the literal or the override written. The field is optional on the schema `Effect`, the persisted log and the wire `EffectView` (PROTOCOL §7.6); it is a number, so a character's view keeps it unredacted wherever the cell effect is kept. A roll value reads as its total in the log and on faces (compact), with its dice in the inspector (full), as before. DESIGN §4.8, §7; FORMULAS §8.3; PROTOCOL §7.6. | Playtest vtt-nb8.11 note (3): Apply all logged "Set G1.damage_taken to 20 (was 6)", which reads as a set, not as dealing 14. A new optional field rather than a new `cause` value: an unknown enum value would make older clients drop the effect, an unknown key is ignored (PROTOCOL §12), and the amount cannot be derived from before and after when an add overrides a formula cell. |
| 2026-11-06 | M6-D23. `pnpm start` takes `--no-open` (anywhere in its arguments, like `--no-build`): vtt-serve then runs without `--open`, so no browser tab opens; without it `--open` is still appended. No detection of a reconnecting tab. The guide's step 15 reopens with it. Amends M6-D5. DESIGN §7. | vtt-nb8.12 (guide step 15): reopening a table after Ctrl+C opened a second tab beside the old tab's Reload banner, and the guide had the user close it. A flag the user chooses is predictable; a heuristic for whether an old tab will reconnect is not. |
