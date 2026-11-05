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
- **Actions.** Named lists of steps (see 4.6).
- **Face layout.** Which cells and buttons appear on the object's surface,
  where, and under what conditions. The face is data, part of the template,
  and editable. See 4.7.
- **Flags.** `is_template` and `is_character`, both false by default. They
  are fields of the object, not cells (FORMULAS.md 3.1), so formulas do not
  read them. A spawned copy carries both from its original, except that the
  root copy's `is_template` is false (see **Templates and copying**).

Cell values can be numbers, text, booleans, lists, dice expressions, roll
results, **ink** (freehand strokes, so scrawl in the margin travels with the
object), and **references to other objects**.

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
- **What is copied.** Every cell, plus `is_zone`, `tag`, `shape`, actions, and
  per-cell visibility (4.4). Formula source is copied verbatim, never
  rewritten.
- **Remapping.** A reference inside a copied cell value (directly, in a list,
  or in a viewers value) or inside per-cell visibility that names an object in
  the copied subtree is remapped to that object's copy; any other reference is
  kept.
- **Initial cells** may be literals or formulas, and replace what was copied
  into the root copy.
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
  cleared; the inspector says so.
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
very large maps, boards also serve as named anchors to jump to.

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
character would see. Multiplayer changes who may drive a character and adds a
rights model; it does not change what is on the table.

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
  but the GM. The GM always sees everything.
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
draws the cover above everything on the board.

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
  show-when (4.7) only hides the button and is not an execution guard.
- Formulas recompute once, after the action commits.
- **One undo reverses one whole action**, including every row of an Apply
  All.
- Every action is logged as one entry with its steps as sentences, recording
  resolved values (what was rolled, what id was created), not instructions.

Actions appear on an object's face as **buttons**. The inspector shows an
action's steps and precondition and lets the GM edit them, exactly as it does
for formulas.

### 4.6 How cells are shown

The spreadsheet shows every cell all the time, which is why it is trustworthy
and why it is ugly. A token should look like a token. Cells therefore have two
presentations and a gradient between them.

**The face.** Each object's face layout places some of its cells on its
surface. A d20 shows `total` large in the middle. A token shows `image`, with
`name` and perhaps an `hp` badge. A character sheet is a large face laid out
like paper, with dozens of cells and an ink margin. An index card shows `title`
and `body`. The face is what you see at the table.

**Edit in place.** Double-click a cell on the face to edit it there, like a
spreadsheet cell or a sticky note. Literals change directly. Formula cells open
in the formula bar. This is the path for most of play: change HP, scribble a
note, rename something.

**Zoom as level of detail.** The canvas is infinite, so zoom gives a free
gradient between glance and scrutiny. Zoomed out, a token is a small circle
showing only its image. Zoomed in, there is room for name, HP, and conditions.
The face layout carries rules of the form "show this element above this
size." A character sheet is an object you literally lean into. This avoids
most modal windows.

**Face elements.** A face layout is a list of elements. V1 needs four kinds:
a cell shown as its value; a cell shown as an in-place editor; a **button**
bound to an action; and a **contents** element that renders the objects in
this object's `contents` inline, each drawn with its own face. The contents
element is one mechanism serving three needs: the rows of a multi-target card,
the entries in a binder, and the cards in a hand. Every element can carry a
**show-when** condition: a formula over the object's cells plus two
presentation inputs, the viewer's zoom and whether the object is collapsed.
Those two inputs are local to a viewer, are not cells, and cannot be read by
game formulas. The layout stays deliberately simple: elements at positions
with sizes and show-when rules, nothing more.

**Collapsed face.** Every object can have a compact face, by default just its
`name`, used when it sits in a binder or a tight container. Expanding it shows
the full face.

**The inspector.** A side panel. Select an object and it lists every cell as
name and value, formulas shown as formulas with the computed result alongside,
overrides marked, and each action with its steps and precondition. Here cells
are added, removed, renamed, and given their own visibility; actions are
edited; broken references are repaired. A layout mode lets the GM drag cells
onto the face, which is how "I want HP visible on all these tokens" happens
without code.

**The formula bar.** One persistent bar, as in a spreadsheet, showing the
formula of whichever cell is focused, whether focused on the face or in the
inspector. It is the only place formulas are typed.

**Dependency tracing.** Hovering a formula highlights the objects and zones it
references on the canvas, filtered by what the viewer may see. Hovering a zone
highlights its contents. This is the spatial version of the colored outlines a
spreadsheet draws while editing a formula, and it is what makes an
agent-written formula legible to the GM.

**Who sees what.** The face and in-place editing of literals are for everyone
at the table, subject to ownership and visibility. The inspector, formulas,
and actions are GM and agent territory in v1.

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
deliberate affordance (a gear, a right-click "edit template," a "save to
template" on a working copy; the exact UI is undecided). Dragging a template
straight onto the table creates a copy there.

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
cannot ask for help with it.

In v1 the server is local, trusts its single connection, and acts with GM
authority. Query and write limits exist so a runaway agent cannot stall the
table.

### 5.3 Consequences for the model

The canonical schema must be readable, stable, and documented. The language
must be small enough to specify completely in the agent's context. Object ids,
cell names, and tags must be human-meaningful by default.

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
  cause, `edit` or `roll`; per-cell visibility changes; field changes;
  placements; creation and removal of whole subtrees; reorders; board changes;
  id allocation; id retirement;
- the actor; its kind, `edit`, `action`, or `undo`; a label; its origin; and,
  for an undo, `undoes`, the index of the group it reverses;
- `base_revision`, the revision it was made against, and `revision`, the
  revision it produced;
- the names of the objects it touched, captured at commit time; for a removed
  object, its name just before removal. This is how the log keeps the name an
  object had at the time (4.8).

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
There is no redo. The group to reverse is chosen by one of three targets:

| Target | Reverses |
|---|---|
| `latest` | The most recent group that is neither an undo nor already undone. The fixture `undo` step always means this (FIXTURES.md 8). |
| `actor` | The latest such group by a given actor. |
| `group` | The group at an explicit absolute index. |

Undoing a target G conflicts with a later group H when H is not an undo group,
H is not undone, and the two share a touched key:

- a cell write touches the cell's key, and so does a change to that cell's
  per-cell visibility;
- a move touches the `contents` key of the container at both ends;
- creating or removing objects touches every key on those objects, and the
  `contents` key of the container they were created in or removed from;
- allocation and retirement touch nothing.

Undo groups never conflict. A conflicting undo is refused as `undo_conflict`,
and so is an undo whose inverse fails an invariant on commit. A later group
that conflicts in this sense is what FIXTURES.md 8 calls a *surviving*
operation.

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
in-memory checkpoints are Polish, and autosave cadence is M3's. A file with an
older `schema_version` migrates one version at a time. Compaction drops old
groups, keeps absolute indices, and raises the barrier to at least
`first_index`.

**Saving** is atomic and has two failure stages. A failure before the new file
replaces the old leaves the old file intact and reports an error. A
durability failure after the replacement (the directory fsync) leaves the new
file intact and reports that the save completed but durability was not
confirmed.

**Revisions and assets.** Every group records its `base_revision`; the policy
for stale writes belongs to M3's protocol. Asset paths in the file are
relative to the file's directory, never absolute. Parsing a file is pure;
whether its assets exist is checked only when loading from a path. How an
image cell names an asset is M4's decision.

**Smaller decisions.**

- The `table` destination (FORMULAS.md 8.2) is resolved by M5 into a board
  destination; M2's primitives take only board and container destinations.
- Renaming a cell does not rewrite formulas that name it. It is refused when
  either name is structural (FORMULAS.md 3.1) or the destination cell exists.
  Any per-cell visibility recorded for the (absent) destination is replaced
  with the source's.
- Spawn initial cells may be literals or formulas (4.1).
- Reordering `contents` by `shuffle` is allowed despite the membership
  protection of FORMULAS.md 3.1: it changes order, not membership.

**Platform.** TypeScript end to end. The **authority** is a local process
(Node) that owns the document file, evaluates formulas,
hosts the MCP server, and serves the UI over localhost with the op stream
over a WebSocket. The UI is a browser tab in v1; a desktop shell (Tauri or
Electron) can wrap the same process later. Formulas evaluate only in the
authority, because they may read cells the viewer cannot see; clients receive
cell results, never inputs. The UI and the agent are two clients of the same
protocol, so the protocol is designed first, not deferred.

In the tab, the scene is drawn on a canvas and the chrome (inspector, formula
bar, binder, log) is DOM. In-place editing is a DOM overlay positioned over
the cell. Canvas2D with viewport culling and per-object render caching, behind
a small renderer interface; PixiJS is the known upgrade if profiling demands
it. Objects are never DOM nodes. Canvas text is weak at small sizes, which
show-when zoom thresholds already accommodate. Very large map images are a
tiling problem and stay in Later.

Decided since (CLAUDE.md): React for the chrome, a hand-written Pratt parser,
and Node for the authority. Left open on purpose: the desktop shell.

## 8. Scope

### 8.1 V1: single GM

The first version is a tool one GM uses alone for playtesting the model. It
must prove the core model works and is pleasant:

- Infinite 2D canvas with pan, zoom, and multiple boards.
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
  the GM is expected to edit or discard them.
- A log panel rendered from the operation stream.
- Freehand drawing and text, so improvisation is cheap.
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
   object owning a sheet and a binder. Fill in name, AC, HP, attack bonus,
   Dex save by typing into the sheet faces. Each binder already holds an
   Attack card template.
3. Import the dungeon map as one image on a second board, "Crypt." Draw six
   opaque zones over the rooms, each `visible_to = gm`. Give rooms 2 and 4 the
   re-hiding formula; leave the rest manual.
4. Make a goblin template once: image, `ac` (GM-only cell), `max_hp`,
   `damage_taken`, `attack_bonus`, the HIT badge formula, tag `creature`, and
   an owned attack d20 whose `modifier` follows the owner's attack bonus.
   Place eight: four in room 3, four in room 5.
5. Through the MCP server, ask the agent: "Make room 4 difficult terrain and
   hatch it, and make a Fireball card for Aldric with DC 14 and 8d6." Check
   its work in the inspector. Correct the DC by typing over it.
6. Scribble "trap on the third stair" in ink on a sticky note on the GM board.
   Save. Glance at the file; it is readable.

**Play (about two hours, GM driving everything)**

7. Show the Crypt board in "view as" Aldric. Only the entrance room is
   uncovered. Toggle back to GM view as needed.
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
    log says so in a sentence. Pressing Apply again does nothing and says why.
11. Goblins attack back: drag a goblin's own attack die onto a PC token and
    double-click it. Its `total` includes the goblin's bonus; the PC's HIT
    badge reads it. Fast path, no cards.
12. Aldric casts Fireball: drag the card from the binder onto the table, drag
    its zone out of the card onto room 3, nudge it to catch three goblins and miss the fighter
    while `targets` updates live. Press Lock targets; three rows appear. Roll
    damage once, roll each save, Apply All. Three goblins update; the log
    lists each.
13. The rogue triggers the stair trap. No template exists. Make a sticky note,
    type the DC on it, roll a loose d20 in the tray, decide by eye. The tool
    got out of the way.
14. Undo once after applying damage to the wrong goblin. Scroll the log back
    to confirm what happened.
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

- **Card lifetime.** Should table cards be able to mark themselves ephemeral
  (discard automatically once applied), or is discard always a person's
  action? Leaning manual in v1.
- **Template propagation.** When a binder template is edited, do the copies
  already on the table change? Not by default; worth an explicit "update from
  template" action later.
- **Shared templates.** Where does a template every character should have
  live? Probably the GM binder plus a "give a copy to each character" action,
  or a table-level binder everyone can read.
- **Edit-template UI.** Gear icon, right-click, or a mode. Not committed.
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
| 2026-11-04 | Face elements: value, editor, button, contents; all with show-when conditions over cells plus viewer-local zoom and collapsed inputs. | Covers multi-target procedures and stepped reveal without a wizard mode; presentation state never leaks into game formulas. |
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
