/**
 * Which expectations the M1 runner (support/runner.ts) checks, per scenario
 * title, in the order it checks them. Committed so coverage only changes on
 * purpose: a new scenario, a newly supported step or expectation type, or an
 * edited scenario fails scenarios.test.ts until this table is updated.
 * Locations are `setup#i` (top-level `expect`) and `step N#i`.
 */
export const SCENARIO_COVERAGE: Record<string, string[]> = {
  // attack-card: step 0 is a spawn.
  "An Attack card rolls, rolls damage, and applies once": [],
  // dice-tray: stops at step 0 (invoke).
  "Dice trays total themselves, as a zone and as a cup": ["setup#0", "setup#1"],
  // die-with-modifier: step 0 is a spawn.
  "A d20 template rolled loose, as a character's attack die, and as a goblin's die": [],
  // difficult-terrain: runs to completion.
  "A token's speed halves inside difficult terrain": [
    "setup#0",
    "step 0#0",
    "step 1#0",
    "step 2#0",
    "step 3#0",
  ],
  // drawing-a-card: step 0 is an invoke.
  "Drawing two cards from a deck into a hand": [],
  // fireball: stops at step 0 (spawn).
  "Fireball spawns its zone, locks the creatures inside, applies saves, and discards everything": [
    "setup#0",
  ],
  // goblin-hit: stops at step 4 (invoke).
  "A goblin shows HIT to the player when a die on it beats its hidden AC": [
    "setup#0",
    "step 1#0",
    "step 3#0",
    "step 3#1",
  ],
  // hit-points: stops at step 4 (undo).
  "Hit points follow damage until overridden": [
    "setup#0",
    "step 0#0",
    "step 1#0",
    "step 2#0",
    "step 2#2",
    "step 3#0",
  ],
  // re-hiding-room: runs to completion.
  "An opaque room reveals itself while a PC is inside and re-hides when he leaves": [
    "setup#0",
    "step 0#0",
    "step 1#0",
    "step 2#0",
    "step 3#1",
    "step 4#0",
    "step 5#1",
  ],
  // shuffling: step 0 is an invoke.
  "Shuffling a stack with a scripted permutation": [],
};
