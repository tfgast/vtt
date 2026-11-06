/**
 * The gestures the help lists after the keybindings (vtt-nb8.8; DESIGN.md
 * §4.6 On the canvas and Gestures, §4.7; M6 plan Q12, gap G15): the pointer
 * gestures and menu commands a first user cannot discover. The keys are
 * `KEY_BINDINGS` (keybindings.ts), the table dispatch reads.
 */

/** One gesture the help lists. */
export interface HelpGesture {
  readonly gesture: string;
  readonly effect: string;
}

/** The gestures, in the help's order. */
export const HELP_GESTURES: readonly HelpGesture[] = [
  { gesture: "Space-drag or middle-drag", effect: "pan" },
  { gesture: "Wheel or two-finger scroll", effect: "pan (over a list that scrolls: scroll it)" },
  { gesture: "Ctrl/Cmd+wheel or pinch", effect: "zoom about the pointer" },
  { gesture: "Click", effect: "select" },
  { gesture: "Alt+click", effect: "cycle through the objects under the pointer" },
  { gesture: "Drag one template", effect: "drop a copy" },
  { gesture: "Alt held at drag start", effect: "move the template instead of copying it" },
  { gesture: "Alt held at drop onto an object", effect: "put the dragged objects inside it" },
  { gesture: "Drop on a card's editor field", effect: "set that cell to the dropped object" },
  { gesture: "Drop on a list", effect: "insert there" },
  { gesture: "Drop a template on a binder", effect: "give that binder a template" },
  { gesture: "Double-click", effect: "run the object's default action, else edit in place" },
  { gesture: "Click an editor field", effect: "edit it" },
  {
    gesture: "Chevron on a list entry",
    effect: "expand or collapse it (a template entry makes a working copy)",
  },
  { gesture: "Gear", effect: "edit a template" },
  {
    gesture: "Drag a cell row from the inspector onto an object (layout mode)",
    effect: "show the cell on the face",
  },
  { gesture: "Delete", effect: "remove the selection" },
  { gesture: "Move selection to board…", effect: "move objects between boards" },
];
