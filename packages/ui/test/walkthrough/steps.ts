/**
 * The fifteen steps of the scripted walkthrough (vtt-nb8.17): short titles
 * for the steps of DESIGN.md §8.4 as amended by vtt-nb8.2 (M6-D1). The
 * walkthrough tests name their cases after them and docs/FIRST-SESSION.md
 * uses them as headings.
 */

/** One step of §8.4: its id (`s1`…`s15`) and short title. */
export interface WalkthroughStep {
  readonly id: string;
  readonly title: string;
}

export const WALKTHROUGH_STEPS: readonly WalkthroughStep[] = [
  { id: "s1", title: "Open a new table" },
  { id: "s2", title: "Add the HIT badge, then make four characters" },
  { id: "s3", title: "Import the Crypt map and draw six opaque rooms" },
  { id: "s4", title: "Make a goblin template and place eight" },
  { id: "s5", title: "Ask the agent for difficult terrain and a Fireball card" },
  { id: "s6", title: "Scribble a note in ink and save" },
  { id: "s7", title: "View the Crypt as Aldric and reveal room 1" },
  { id: "s8", title: "Move the party, reveal room 3, watch room 2" },
  { id: "s9", title: "Roll initiative in a dice tray and line up the tokens" },
  { id: "s10", title: "Aldric attacks with the Attack card" },
  { id: "s11", title: "A goblin attacks back with its own die" },
  { id: "s12", title: "Aldric casts Fireball" },
  { id: "s13", title: "The rogue triggers the stair trap" },
  { id: "s14", title: "Undo the wrong goblin's damage and a mistaken delete" },
  { id: "s15", title: "Save, close and reopen" },
];
