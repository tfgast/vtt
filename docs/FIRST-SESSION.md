# The first session: a playtest guide

This guide walks you through the first session of DESIGN.md §8.4, the v1
acceptance scenario: a short prep, then a small fight in a crypt, played by
one GM driving everything. Each step quotes §8.4, then says exactly what to
do and what you should see. The steps do the same things, at the same
places, with the same names and values, as the scripted walkthrough tests
(`packages/ui/test/walkthrough/`); `guide-sync.test.ts` keeps the two in
step.

Press `?` in the app at any time for the keys and gestures.

## Setup

1. Follow the quick start in [README.md](../README.md), then run, in the
   repo root:

   ```sh
   pnpm start tables/crypt.table.json
   ```

   Use a file that does not exist yet, so you start from a fresh table. If
   `tables/crypt.table.json` is left over from an earlier run, pick a new
   name, such as `tables/crypt-2.table.json`. The table opens in your
   browser. Below, `tables/<your table>.table.json` means the file you
   chose here.

2. Attach your own agent before step 5 (README.md, "Attach an agent"). In
   step 5, paste the request quoted there into the agent verbatim.

3. The example images are in the repo:
   `packages/fixtures/assets/crypt-map.png` (the dungeon map) and
   `packages/fixtures/assets/goblin.png` (the goblin's picture).

4. The map's rooms are numbered on the map itself. Rooms 4, 5 and 6 run
   left to right along the top. Room 1 (the entrance) and room 2 are at the
   bottom left, and room 3 (the guard room, the largest) is at the bottom
   right. Corridors join them.

**Moving around.** Scroll with the mouse wheel or two fingers on a
trackpad to pan; hold Space (or the middle button) and drag to pan by hand.
Space works wherever focus is, except while you are typing in a field.
Ctrl/Cmd+wheel or a trackpad pinch zooms about the pointer, and `+` and `-`
zoom about the middle of the screen. Over a list that scrolls (a binder, a
token's contents), the wheel scrolls the list instead. A board you open for
the first time is fitted to what is on it. `?` lists every key and gesture.

**Snap.** The toolbar's Snap checkbox, next to Fog, is on when the table
opens. While it is on, a faint grid of whole units is drawn under the
objects, and an object you move or drop on the board lands with its centre
on the nearest half unit. Untick it to place objects freely; it is not
saved with the table.

### Positions

Positions on the Crypt board are given as `M + [x, y]`. M is the top-left
corner of the map. `x` counts board units to the right, `y` counts units
down. One unit is 100 map pixels, so the map is 24 × 16 units. The
walkthrough puts the map so that M is `[0, 0]`, which makes its positions
equal to the `position` row of the inspector. You do not need to be exact:
landing in the right room, near the right spot, is enough. With Snap on,
positions land on half units, so every position the guide puts an object
at is a whole or half unit, and a drop near one lands on it. Positions on
the GM board are plain `[x, y]`; the GM binder's centre is `[0, 0]`.

### Words used below

- **Entry**: a row in a contents list (a binder's, a token's or a card's).
  Each entry has a chevron that expands or collapses it. A template entry
  also has a gear.
- **Count badge**: a token's (or character's) contents list shows only
  while the token is selected. Otherwise a small number below the token,
  at the lower right, says how many entries the list holds; an empty list
  shows no badge. Click the token to show its list.
- **Inspector**: the panel on the right, with the tabs Inspector, Objects
  and Log. To change a cell there, double-click its value, type, and press
  Enter. Each such edit is its own change.
- **View as**: the toolbar menu that shows the table as one character sees
  it. "GM" switches back.

### Known rough edges

The walkthrough found these. Work around them as described in the steps;
they are not new findings, but say so if they bother you.

- After reopening the table (step 15), one Ctrl+Z undoes the wrong goblin's
  Roll damage, because the Apply and the Delete before it are already
  undone.

### How to report

Each step ends with a result line. Fill it in as you go:

- **ok**: everything did what this guide says.
- **friction**: it worked, but it was awkward, slow or confusing.
- **broken**: an interaction did not do what this guide says.
- **game went differently**: your dice rolled differently, or the game took
  another turn (a miss, a failed save). That is not a fault. Mark it in its
  own field, and keep going.

When you are done, copy the fifteen filled result lines, the final
`Felt good:` line and any other feedback into one comment on the bead
vtt-nb8, or hand them to the orchestrator.

## Prep

### Step 1 — Open a new table

> Open a new table. The GM board is empty except for the GM binder, stocked
> with the example templates.

1. Run `pnpm start tables/<your table>.table.json` on a fresh file (see
   Setup).
2. Wait for the browser tab to open.

You should see: the board tab "GM", holding only the GM binder. Its list
holds fifteen template entries, in this order: Character, Attack, Damage,
Area save, Save, Token, Marker, Zone, Card, Note, Sheet, Hand, Binder,
Stack, d20.

Result: ok / friction / broken — game went differently: yes / no — notes:

### Step 2 — Add the HIT badge, then make four characters

> Add the HIT badge formula to the character template's token once. Then drag
> the character template out four times. Each creates a character object
> owning a sheet and a binder. Name each character on its token, then fill in
> AC, HP, attack bonus and Dex save by typing into the sheet faces; each
> sheet's header shows its character's name. Each binder already holds an
> Attack card template.

First, the HIT badge on the character template:

1. In the GM binder, click the gear on the Character entry. A banner says
   "Editing template Character", and the inspector shows the template.
2. In the inspector's Cells section, type `hit` into the new cell name box
   (right below the cells, above Structural) and press Add cell. The new
   `hit` row scrolls into view with its value box open and focused.
3. Type the new `hit` cell's value,
   `=any(on(this).where(tag has "d20").total >= ac)`, and press Enter.
4. In the inspector's Face section, press Add value. A new element row
   appears at the end of the list, marked "new", with its Cell picker
   focused.
5. In that row, pick `hit` as its Cell. Then set x to `-0.5`, y to `-0.95`,
   w to `1`, h to `0.3` and Show when to `hit`; Enter, Tab or a click on
   the next field each commits a value.

Then the four characters, one at a time:

6. Drag the Character entry out of the GM binder onto the GM board, to the
   right of the binder. The walkthrough makes Dara first at `[16, 0]`, then
   Corin at `[14, 0]`, Brenna at `[12, 0]` and Aldric last at `[10, 0]`.
   Drag the Character entry while its row is collapsed. If you opened it
   with the chevron, that made a working copy inside the binder: drag that
   copy's picture out instead, it becomes the character.
7. Double-click the new token's name and type the character's name.
8. Click the token to show its contents list, then expand the sheet entry
   with its chevron. While the token is not selected, its count badge
   reads 2 (the sheet and the binder) in place of the list.
9. On the sheet, click each field and type its value from this table:

| Character | AC | Max HP | Attack bonus | Dex save |
|---|---|---|---|---|
| Aldric | 16 | 24 | 5 | 1 |
| Brenna | 18 | 30 | 6 | 0 |
| Corin | 14 | 18 | 5 | 4 |
| Dara | 12 | 16 | 4 | 2 |

You should see:

- Each sheet's header shows its character's name.
- Each token's `hp` reads its Max HP: 24, 30, 18 and 16.
- No token shows a HIT badge yet.
- Each character's binder (the other entry in its token's list, shown
  while the token is selected) holds an Attack template.
- Each binder's header on the board shows its character's name; its entry
  in the token's list still reads Binder.

Result: ok / friction / broken — game went differently: yes / no — notes:

### Step 3 — Import the Crypt map and draw six opaque rooms

> Import the dungeon map as one image on a second board, "Crypt." Draw six
> opaque zones over the rooms, each `visible_to = gm`. Give rooms 2 and 4 the
> re-hiding formula; leave the rest manual.

1. Press the "+" after the board tabs (New board), type `Crypt` and press
   Enter. The Crypt board opens.
2. Press I (the image tool) and click the board. In the file picker, choose
   `packages/fixtures/assets/crypt-map.png`. The map appears, 24 × 16 units,
   centred where you clicked.
3. Press R (the rectangle zone tool). Make sure Fog is checked in the
   toolbar. If you forget, select the zone and check Fog in the inspector's
   Object section.
4. Draw a zone exactly over each room, dragging from its top-left corner to
   its bottom-right corner. Drawing a zone selects it and switches back to
   the select tool, so press R again before each room (or hold Shift as you
   start the drag, which keeps the zone tool). With Snap on (the default),
   both corners snap to the nearest half unit, so a corner dropped near a
   room's corner lands on it. Check that Fog is still checked each time:

| Room | Name on the map | Top-left | Size |
|---|---|---|---|
| 1 | Entrance | M + [1, 11] | 5 × 4 |
| 2 | Hall | M + [7, 11] | 5 × 4 |
| 3 | Guard room | M + [13, 9] | 7 × 6 |
| 4 | Stair | M + [1, 1] | 6 × 6 |
| 5 | Barracks | M + [9, 1] | 7 × 6 |
| 6 | Shrine | M + [18, 1] | 5 × 6 |

5. Right after drawing each zone, while it is still selected, set its
   `name` in the inspector: "Room 1" to "Room 6". (Double-clicking the zone
   on the board and typing the name works too.)
6. For rooms 2 and 4, also set `visible_to` in the inspector to
   `=if(len(contents(this).where(tag has "pc")) > 0, all, gm)`.
7. Go to the GM board. Click the GM binder, press "Move selection to
   board…" and choose Crypt.
8. On Crypt, drag the GM binder to the right of the map, to about
   `M + [27, 5]`.

You should see: six opaque zones over the rooms, named "Room 1" to
"Room 6". Rooms 1, 3, 5 and 6 have `visible_to` `gm`. Rooms 2 and 4 show
the formula, which evaluates to `gm` while no PC is inside. The GM binder
sits beside the map.

Result: ok / friction / broken — game went differently: yes / no — notes:

### Step 4 — Make a goblin template and place eight

> Make a goblin template once: image, `ac` (GM-only cell), `max_hp`,
> `damage_taken`, `attack_bonus`, `dex_save`, the HIT badge formula, tag
> `creature`, and an owned attack d20 whose `modifier` follows the owner's
> attack bonus. Place eight: four in room 3, four in room 5.

The goblin starts as a copy of the Token template, which already has
`damage_taken`, the tag `creature` and a HIT badge element.

1. Drag the Token entry out of the GM binder to the left of the map, at
   `M + [-4, 8]`.
2. Double-click its name and type `Goblin`.
3. With the goblin selected, press Upload… on the inspector's `image` row
   and choose `packages/fixtures/assets/goblin.png`.
4. In the inspector, set `ac` to `13`.
5. Make `ac` GM-only: in the Visibility rules section, type `ac` as the
   rule's cell name, check `gm`, and press Add visibility rule.
6. Set `max_hp` to `7`, `attack_bonus` to `4` and `dex_save` to `2`.
7. Set `hit` to `=any(on(this).where(tag has "d20").total >= ac)`.
8. In the inspector's Object section, check both Character and Template.
   Both matter: the goblin's die must be owned by a character, and the
   copies keep the Character flag.

Check the badge with a loose die:

9. Drag the d20 entry out of the GM binder onto the goblin, at
   `M + [-4, 8]`.
10. Double-click the die to roll it. The goblin's HIT badge shows when the
    die's total is 13 or more. If it rolled less, double-click it again
    until it does. The badge is drawn at any zoom, so you do not need to
    zoom in to see it.
11. Click the die and press Delete. The HIT badge disappears.

Give the goblin its own attack die:

12. Click the goblin to show its contents list (empty for now, so no count
    badge showed), then drag the d20 entry from the GM binder onto that
    list. A die is inserted into the list.
13. Click that die's row to select it. In the inspector, set `owner` (in
    the Structural group) to `@` followed by the goblin's id, which the
    goblin's `id` row shows. Set `modifier` to `=owner.attack_bonus`.

Place eight copies:

14. Drag the goblin template eight times. Each drag drops a copy and
    selects it. Right after each drop, set the copy's `name` in the
    inspector: G1, G2, and so on to G8. Drop them here:
    - Room 3: G1 at `M + [14.5, 10.5]`, G2 at `M + [15.5, 12]`, G3 at
      `M + [14.5, 13.5]`, G4 at `M + [18.5, 13.5]`.
    - Room 5: G5 at `M + [11, 2.5]`, G6 at `M + [12.5, 2.5]`, G7 at
      `M + [11, 4.5]`, G8 at `M + [12.5, 4.5]`.

You should see:

- G1 to G4 in room 3 and G5 to G8 in room 5, each with the goblin picture
  and `hp` 7.
- No HIT badge on any goblin.
- Each G shows a count badge reading 1: click it to show its contents
  list, which holds its die; the die's `modifier` is 4.
- Each copy is a character but not a template.

Result: ok / friction / broken — game went differently: yes / no — notes:

### Step 5 — Ask the agent for difficult terrain and a Fireball card

> Through the MCP server, ask the agent: "Make room 4 difficult terrain and
> hatch it, and make a Fireball card for Aldric with DC 14 and 8d6." The agent
> gives Aldric's binder a copy of the Area Save card named Fireball with
> `caster` and `owner` Aldric and `damage_dice` 8d6, and writes 14 into Aldric's sheet
> `spell_dc`, which the card's `dc` follows. Check its work in the inspector.
> Correct the DC by typing over it.

1. Paste the quoted request into your agent, verbatim.
2. Wait for it to finish. If it did not set the card's `owner`, tell it to
   set the card's `owner` to Aldric (its instructions say so): the card's
   buttons are then pressed as Aldric.

The walkthrough's agent commits two changes, labelled "Room 4: difficult
terrain, hatched" and "Fireball for Aldric". Yours may label or split them
differently; note it if it does.

3. Look at room 4 on Crypt: it is hatched.
4. Go to the GM board. Click Aldric to show his contents list, then
   expand his binder entry. It now holds a Fireball entry after the Attack
   template.
5. Click the gear on the Fireball entry. The inspector shows `dc` 14,
   `caster` Aldric, `owner` Aldric and `damage_dice` 8d6.
6. Correct the DC: set `dc` to `15` in the inspector.

You should see: room 4 hatched, with the tag `difficult`; Aldric's sheet
`spell_dc` 14; the Fireball template's `dc` 15. The 15 overrides the
formula, which stays (`caster.spell_dc`). The Log tab lists the agent's
changes under its name.

Result: ok / friction / broken — game went differently: yes / no — notes:

### Step 6 — Scribble a note in ink and save

> Scribble "trap on the third stair" in ink on a sticky note on the GM board.
> Save. Glance at the file; it is readable.

1. On Crypt, drag the Note entry out of the GM binder to the left of the
   map, at `M + [-4, 12]`.
2. With the note selected, press "Move selection to board…" and choose GM.
   The GM board opens with the note on it.
3. Press D (the ink tool). Write "trap on the third stair" over the note.
   The walkthrough draws three strokes.
4. Press V to go back to the select tool.
5. Press Ctrl+S (Cmd+S on a Mac).
6. Open the table file you chose in setup
   (`tables/<your table>.table.json`) in a text editor.

You should see: each stroke drawn on the note; the status bar showing
"Saved"; the file is indented JSON, and searching it finds "Room 4" and
"Fireball".

Result: ok / friction / broken — game went differently: yes / no — notes:

## Play

### Step 7 — View the Crypt as Aldric and reveal room 1

> Show the Crypt board in "view as" Aldric: every room is covered. Reveal room
> 1, the entrance, by hand; now only it is uncovered. Toggle back to GM view
> as needed.

1. Open the Crypt board. In View as, choose Aldric.
2. Every room is covered: six covers.
3. In View as, choose GM.
4. Click room 1 to select the zone.
5. Set its `visible_to` to `all` in the inspector.
6. View as Aldric again.

You should see: five covers. Room 1 is uncovered; rooms 2 to 6 stay
covered.

Result: ok / friction / broken — game went differently: yes / no — notes:

### Step 8 — Move the party, reveal room 3, watch room 2

> Move the PC tokens into room 1. Reveal room 3 by hand when they open the
> door. Room 2 reveals itself when a PC token enters and re-covers once the
> party has left.

Do this in GM view; switch to view as Aldric only to check.

1. Go to the GM board. Click Aldric to show his contents list, then
   collapse his binder and his sheet.
2. Drag a selection rectangle around the four character tokens and nothing
   else. The walkthrough drags from `[8, -1]` to `[18, 2.5]`.
3. Press "Move selection to board…" and choose Crypt. The four keep their
   positions and Crypt opens.
4. Drag them into room 1: Aldric to `M + [2, 12]`, Brenna to
   `M + [3, 12]`, Corin to `M + [4, 12]` and Dara to `M + [5, 12]`.
5. The party opens the door: click room 3 to select it, and set its
   `visible_to` to `all`.
6. Drag Aldric into room 2, to `M + [9, 13]`.
7. View as Aldric: room 2 is uncovered, leaving three covers (rooms 4, 5
   and 6). Switch back to GM.
8. Drag Aldric back into room 1, to `M + [2, 13]`.
9. View as Aldric: room 2 is covered again, so four covers. Switch back
   to GM.

You should see: the counts above. Room 2's `visible_to` reads `gm` again
once no PC is inside it.

Result: ok / friction / broken — game went differently: yes / no — notes:

### Step 9 — Roll initiative in a dice tray and line up markers

> Combat in room 3. Draw a dice tray zone beside the map. Roll initiative with
> loose d20s from the GM binder, double-clicking each to roll, adding bonuses
> by eye from the sheets. Line up markers from the GM binder in a strip zone
> by initiative, dropping each PC token on a marker's `of`, so the tokens
> stay on the map. No initiative tracker feature exists; none is needed.

The tray:

1. Press R (the rectangle zone tool). Uncheck Fog in the toolbar.
2. Draw a zone below the map from `M + [0, 17]` to `M + [6, 20]`.
3. While it is selected, set its `name` to `Tray` in the inspector.
4. Add a cell `text` to it (the Cells section's new cell name box, then
   Add cell; the new row's value box opens focused) with the value
   `=sum(contents(this).where(tag has "die").value)`.
   There is no tray template; the formula is the tray.

The rolls, one die per character, in the order Aldric, Brenna, Corin, Dara:

5. Drag the d20 entry out of the GM binder into the tray four times, to
   `M + [1, 18.5]`, `M + [2, 18.5]`, `M + [3, 18.5]` and `M + [4, 18.5]`.
6. Double-click each die to roll it.

The strip:

7. Press R again: drawing the tray switched back to the select tool. Make
   sure Fog is unchecked, then draw a zone from `M + [8, 17]` to
   `M + [20, 18]`. Set its `name` to `Initiative`.
8. Work out each character's initiative: the die's value plus that
   character's sheet `dex_save` (Aldric 1, Brenna 0, Corin 4, Dara 2).
9. Highest initiative first, drag the Marker entry out of the GM binder
   into the strip, to `M + [9, 17.5]`, `M + [11, 17.5]`, `M + [13, 17.5]`
   and `M + [15, 17.5]`. After each one, drop that character's token on
   the new marker's `of` field (the small box captioned `of`). The token
   does not move; the marker takes its name and image.

You should see: the tray shows the sum of the four dice as rolled, without
the bonuses. The strip holds four markers in initiative order, each showing
its character's name (and image, if the token has one); the tokens are
still in room 1. The walkthrough rolled 14, 9, 17 and 6: the tray reads 46,
and the order is Corin 21, Aldric 15, Brenna 9, Dara 8. Your rolls will
differ.

Result: ok / friction / broken — game went differently: yes / no — notes:

### Step 10 — Aldric attacks with the Attack card

> Aldric attacks: expand the Attack card in Aldric's binder (a working copy
> appears), drop a goblin onto `target`, press Roll. HIT shows; AC does not.
> Roll damage, press Apply. The goblin's `hp` changes on its face and the log
> says so in a sentence. Apply stays visible but disabled, and says why.

1. In GM view, click Aldric to show his contents list, then drag his
   binder entry out of it onto Crypt, to the right of the map at
   `M + [27, 15]`. If its list is cramped, select it and resize a binder
   with its handles to see more entries: its rows keep their height.
2. You can stay in GM view; the buttons are pressed as Aldric because the
   card is his. View as Aldric to check that `ac` is hidden.
3. In Aldric's binder, expand the Attack template with its chevron. A
   working copy appears right after it, expanded and selected.
4. Drag G1 onto the copy's `target` field. G1 does not move.
5. Press Roll. The card's `total` is the d20 plus Aldric's attack bonus
   (5). The attack hits when `total` is at least the goblin's AC (13).
6. If it hits, press Roll damage, then Apply.
7. Press Apply again.

You should see:

- After Roll: HIT on the card, when it hits. G1's `ac` is not shown
  anywhere in Aldric's view.
- After Apply: G1's `hp` on its face is `max_hp` − `damage_taken`, so 7
  minus the damage rolled. The Log tab's newest entry is "Apply" by Aldric,
  with a sentence naming G1.
- Apply stays drawn but disabled. Pressing it shows the notice "Apply: its
  condition is false" (in GM view followed by the condition itself) and
  changes nothing.

The walkthrough rolled 15 (total 20, a hit) and 6 damage, leaving G1 at
`hp` 1.

If it misses (`hit` is false), Roll damage and Apply are not shown at all.
Press Discard on the copy, expand the Attack template again for a fresh
copy as the next turn, drop G1 on its `target` and press Roll. Repeat until
it hits. Apply is drawn but disabled only after it has been applied. The
step is ok if the buttons behaved as described.

Result: ok / friction / broken — game went differently: yes / no — notes:

### Step 11 — A goblin attacks back with its own die

> Goblins attack back: drag a goblin's own attack die out of the goblin's
> contents list onto a PC token and double-click it. Its `total` includes the
> goblin's bonus; the PC's HIT badge reads it. Fast path, no cards.

1. View as GM.
2. Click G2 to show its contents list (its count badge reads 1), then
   drag the die's row out of the list onto the centre of Aldric's token
   (in room 1).
3. Double-click the die to roll it.

You should see: the die leaves G2's list (G2's badge disappears) and sits
on Aldric. Its `total` is
the roll plus G2's attack bonus (4). Aldric's HIT badge shows when that
total is at least Aldric's AC (16). The walkthrough rolled 13, a total of
17: HIT. A lower total leaves the badge hidden, which is correct too. The
badge is drawn at any zoom, so you can watch for it with the whole map in
view.

Result: ok / friction / broken — game went differently: yes / no — notes:

### Step 12 — Aldric casts Fireball

> Aldric casts Fireball: drag the card from the binder onto the table, drag
> its zone out of the card onto room 3, nudge it to catch three goblins and
> miss the fighter while `targets` updates live. Press Lock targets; three
> rows appear. Roll damage once, roll each save, Apply All. Three goblins
> update; the log lists each.

Brenna, the fighter, steps into room 3 first, so the nudge has someone to
miss.

1. In GM view, drag Brenna's token from room 1 into room 3, to
   `M + [17, 11]`.
2. You can stay in GM view; the buttons are pressed as Aldric because the
   card is his. View as Aldric to check that `ac` is hidden.
3. Drag the Fireball entry out of Aldric's binder onto the table, below his
   binder at `M + [27, 22]`. This drops a copy; its `dc` is your 15.
4. Drag the zone's row out of the card's contents list onto room 3, to
   `M + [15.5, 11.5]`. The card's `targets` now holds G1, G2 and Brenna.
5. Nudge the zone so its centre is at `M + [14.5, 12]`: drag the zone from
   a point inside it, clear of the tokens in it. The goblins are not
   selected, so their contents lists are hidden (only their count badges
   show), and releasing over where a list would be leaves the zone on the
   board. The walkthrough grabs it just above its centre and releases it
   at `M + [14.3, 11.5]`, below G1, where G1's list shows when G1 is
   selected. `targets` updates as the zone moves: G1, G2 and G3, without
   Brenna.
6. Press Lock targets. Three save rows appear in the card's list.
7. Press Roll damage once.
8. Expand each row in turn and press its Roll save.
9. Press Apply all.

You should see:

- The card shows `targets` (G1, G2 and G3) above its contents list.
- A row passes when its `save_roll` plus the goblin's `dex_save` (2) is at
  least the card's `dc` (15). A passing goblin takes half the damage,
  rounded down; a failing one takes all of it.
- Each goblin's `damage_taken` grows by its row's damage. Its `hp` is
  `max_hp` − `damage_taken`, so it can go below zero.
- Each "Roll save" in the Log tab is by its goblin (G1, G2, G3), not
  Aldric: a save row belongs to its target.
- The Log tab's newest entry is "Apply all" by Aldric, with one sentence
  per goblin and none for Brenna.

The walkthrough rolled 28 damage and saves of 15, 5 and 12: G1 passed and
took 14 (`damage_taken` 20 with step 10's 6), G2 and G3 failed and took 28
each. The Apply all sentences read "Added 14 to G1.damage_taken (now 20)",
"Added 28 to G2.damage_taken (now 28)" and "Added 28 to G3.damage_taken
(now 28)".

Result: ok / friction / broken — game went differently: yes / no — notes:

### Step 13 — The rogue triggers the stair trap

> The rogue triggers the stair trap. No template exists. Make a sticky note,
> type the DC on it, roll a loose d20 in the tray, decide by eye. The tool got
> out of the way.

1. View as GM.
2. Drag the Note entry out of the GM binder to `M + [7, 19]`, beside the
   tray.
3. Click the note's text field, type `DC 12` and press Enter.
4. Drag the d20 entry out of the GM binder into the tray, at
   `M + [5, 18.5]`.
5. Double-click the die to roll it.
6. Compare the roll with the note and decide by eye.

You should see: the note reads "DC 12". The tray's sum goes up by the new
roll. The walkthrough rolled 8, so the tray went from 46 to 54.

Result: ok / friction / broken — game went differently: yes / no — notes:

### Step 14 — Undo the wrong goblin's damage and a mistaken delete

> Discard the spent Attack card with its Discard button, attack the wrong
> goblin with a fresh one, and undo once after applying the damage. Delete a
> goblin by mistake and undo that too. Scroll the log back to confirm what
> happened.

1. View as Aldric.
2. On step 10's working copy, press Discard. It is drawn and enabled. The
   copy disappears.
3. Expand the Attack template in Aldric's binder again. A fresh working
   copy appears.
4. Drag G4 (the wrong goblin) onto the copy's `target` field.
5. Press Roll. It hits when the roll plus 5 is at least 13.
6. Press Roll damage, then Apply. G4's `hp` drops by the damage.
7. Press Ctrl+Z. This works in view-as.
8. View as GM. Click G4 and press Delete. G4 and its die disappear.
9. Press Ctrl+Z.
10. Open the Log tab. Press Load older until the agent's step-5 changes
    are listed.

You should see:

- After the first Ctrl+Z: G4's `damage_taken` back to 0 (`hp` 7), and the
  card's Apply enabled again. One undo reversed the whole Apply.
- After the second Ctrl+Z: G4 is back, with its die in its list (its
  count badge reads 1).
- In the Log tab: the "Apply" entry and the "Delete G4" entry are marked
  undone, and older entries lead back to the agent's (the walkthrough's is
  "Fireball for Aldric").

The walkthrough rolled 18 (total 23) and 5 damage.

If the fresh copy misses (`hit` is false), Roll damage and Apply are not
shown at all. Press Discard, expand the Attack template again for a fresh
copy as the next turn, drop G4 on its `target` and press Roll. Repeat until
it hits. Apply is drawn but disabled only after it has been applied. The
step is ok if the buttons behaved as described.

Result: ok / friction / broken — game went differently: yes / no — notes:

### Step 15 — Save, close and reopen

> Save. Close. Reopen; everything, including the log, the undo, and the
> deleted-then-restored goblin, is there.

1. Press Ctrl+S. The status bar shows "Saved".
2. Close: press Ctrl+C in the terminal running `pnpm start`. It saves and
   stops.
3. Reopen: run `pnpm start tables/<your table>.table.json --no-open`,
   with the same file you chose in setup. `--no-open` keeps a second tab
   from opening.
4. In the old tab, press Reload on the banner that says the authority
   restarted.
5. Press Ctrl+Z once.

You should see:

- After Reload: the Crypt board (the app reopens on the board you were
  on), with everything where you left it: the tokens, hp, cards, tray,
  notes, ink, and G4 with its die.
- The Log tab: the same entries, with the same ones marked undone.
- After Ctrl+Z: it undoes the wrong goblin's Roll damage (the fresh card's
  damage clears). That is the newest of your changes not yet undone,
  because the Apply and the Delete were undone before you closed. This is
  the undo surviving the reopen, not a fault.

Result: ok / friction / broken — game went differently: yes / no — notes:

## Overall

Felt good: yes / not yet — why:
