/**
 * Cross-reference checks that a structural schema cannot express: unique ids,
 * containment as a forest, exactly-one placement, references that resolve,
 * bindings introduced before use, and where each expectation kind may appear.
 *
 * Nothing here evaluates a formula or runs a step. Whatever needs evaluation
 * (dice script exhaustion, a bind query matching exactly one object, a roll's
 * expression matching the step that consumes it) is a runtime scenario error
 * and belongs to the runner.
 */
import type { z } from "zod";
import type { ScenarioShape } from "./schema";

type Ctx = z.RefinementCtx;
type Path = (string | number)[];
type Obj = ScenarioShape["setup"]["objects"][number];
type Expectation = NonNullable<ScenarioShape["expect"]>[number];

/** Reserved words of the viewer encoding; never object, board, or binding names. */
export const RESERVED_NAMES: readonly string[] = ["gm", "all", "owner"];

/** Structural cells that setup expresses through dedicated fields, never `cells`. */
export const NON_CELL_STRUCTURAL: readonly string[] = [
  "id",
  "tag",
  "contents",
  "container",
  "board",
  "position",
  "shape",
];

/** Allowed literal value types for structural cells that may appear in `cells`. */
const STRUCTURAL_CELL_TYPES: Record<string, readonly string[]> = {
  name: ["text", "formula"],
  visible_to: ["viewers", "formula"],
  owner: ["ref", "empty", "formula"],
  template: ["ref", "empty"],
  face_up: ["boolean", "formula"],
  opaque: ["boolean", "formula"],
  rotation: ["number", "empty", "formula"],
  z: ["number", "empty", "formula"],
};

interface Value {
  type: string;
  object?: string;
  items?: Value[];
  viewers?: (string | { type: "ref"; object: string })[];
}

export function checkScenario(scenario: ScenarioShape, ctx: Ctx): void {
  const issue = (path: Path, message: string) => ctx.addIssue({ code: "custom", path, message });
  const { boards, characters, objects } = scenario.setup;

  // ---- ids
  const boardIds = new Set<string>();
  const objectById = new Map<string, Obj>();
  const seen = new Set<string>();
  const claim = (id: string, path: Path) => {
    if (RESERVED_NAMES.includes(id)) issue(path, `"${id}" is reserved and cannot be an id`);
    if (seen.has(id)) issue(path, `duplicate id "${id}"`);
    seen.add(id);
  };
  boards.forEach((b, i) => {
    claim(b.id, ["setup", "boards", i, "id"]);
    boardIds.add(b.id);
  });
  objects.forEach((o, i) => {
    claim(o.id, ["setup", "objects", i, "id"]);
    objectById.set(o.id, o);
  });

  const characterSet = new Set<string>();
  characters.forEach((c, i) => {
    const path = ["setup", "characters", i];
    if (!objectById.has(c)) issue(path, `character "${c}" is not an object`);
    if (characterSet.has(c)) issue(path, `character "${c}" listed twice`);
    characterSet.add(c);
  });

  // ---- values: references resolve, viewer references name characters
  const checkValue = (v: Value, path: Path, known: (name: string) => boolean) => {
    if (v.type === "ref" && v.object !== undefined && !known(v.object)) {
      issue([...path, "object"], `reference to unknown object "${v.object}"`);
    }
    if (v.type === "list") {
      v.items?.forEach((item, i) => {
        checkValue(item, [...path, "items", i], known);
      });
    }
    if (v.type === "viewers") {
      v.viewers?.forEach((entry, i) => {
        if (typeof entry !== "string" && !characterSet.has(entry.object)) {
          issue([...path, "viewers", i, "object"], `viewer "${entry.object}" is not a character`);
        }
      });
    }
  };
  const knownInSetup = (name: string) => objectById.has(name) || boardIds.has(name);

  // ---- objects
  const containerOf = new Map<string, string>();
  objects.forEach((o, i) => {
    const base: Path = ["setup", "objects", i];
    for (const [cell, content] of Object.entries(o.cells ?? {})) {
      const path = [...base, "cells", cell];
      if (NON_CELL_STRUCTURAL.includes(cell)) {
        issue(path, `"${cell}" is structural; set it through the object's own field, not cells`);
        continue;
      }
      const allowed = STRUCTURAL_CELL_TYPES[cell];
      if (allowed && !allowed.includes(content.type)) {
        issue(path, `"${cell}" cannot hold a ${content.type}; allowed: ${allowed.join(", ")}`);
      }
      if (content.type !== "formula") checkValue(content, path, knownInSetup);
    }
    for (const [cell, viewers] of Object.entries(o.cell_visibility ?? {})) {
      const path = [...base, "cell_visibility", cell];
      if (!(cell in (o.cells ?? {}))) issue(path, `cell_visibility names unknown cell "${cell}"`);
      checkValue(viewers, path, knownInSetup);
    }
    const actionNames = new Set<string>();
    o.actions?.forEach((a, j) => {
      if (actionNames.has(a.name)) {
        issue([...base, "actions", j, "name"], `duplicate action "${a.name}"`);
      }
      actionNames.add(a.name);
    });
    if (o.placement && !boardIds.has(o.placement.board)) {
      issue([...base, "placement", "board"], `unknown board "${o.placement.board}"`);
    }
    o.contents?.forEach((child, j) => {
      const path = [...base, "contents", j];
      if (!objectById.has(child)) {
        issue(path, `contents names unknown object "${child}"`);
        return;
      }
      const previous = containerOf.get(child);
      if (previous !== undefined) {
        issue(path, `"${child}" is already in the contents of "${previous}"`);
        return;
      }
      containerOf.set(child, o.id);
    });
  });

  objects.forEach((o, i) => {
    const path = ["setup", "objects", i];
    const contained = containerOf.has(o.id);
    if (contained && o.placement) {
      issue([...path, "placement"], `"${o.id}" is in a container and on a board; pick one`);
    }
    if (!contained && !o.placement) {
      issue(path, `"${o.id}" is neither in a container nor placed on a board`);
    }
    // Walk up the container chain; returning to o means a cycle.
    let cursor = containerOf.get(o.id);
    const visited = new Set<string>();
    while (cursor !== undefined && !visited.has(cursor)) {
      if (cursor === o.id) {
        issue([...path, "contents"], `containment cycle through "${o.id}"`);
        break;
      }
      visited.add(cursor);
      cursor = containerOf.get(cursor);
    }
  });

  const descendants = (id: string): Set<string> => {
    const out = new Set<string>();
    const stack = [...(objectById.get(id)?.contents ?? [])];
    while (stack.length > 0) {
      const next = stack.pop() as string;
      if (out.has(next)) continue;
      out.add(next);
      stack.push(...(objectById.get(next)?.contents ?? []));
    }
    return out;
  };

  // ---- dice script
  scenario.dice.forEach((entry, i) => {
    if (entry.type !== "permutation") return;
    const sorted = [...entry.order].sort((a, b) => a - b);
    if (sorted.some((n, k) => n !== k)) {
      issue(["dice", i, "order"], "order must be a permutation of 0..n-1");
    }
  });

  // ---- names in steps: setup ids, then bindings in the order they are made.
  // Each name maps to the setup object whose actions it has (null if unknown).
  const names = new Map<string, string | null>();
  for (const id of objectById.keys()) names.set(id, id);
  const knownName = (name: string) => names.has(name) || boardIds.has(name);

  const requireObject = (name: string, path: Path) => {
    if (!names.has(name)) issue(path, `unknown object or binding "${name}"`);
  };
  const requireBoard = (name: string, path: Path) => {
    if (!boardIds.has(name)) issue(path, `unknown board "${name}"`);
  };
  const requireViewer = (name: string, path: Path, role: string) => {
    if (name !== "gm" && !characterSet.has(name)) {
      issue(path, `${role} must be "gm" or a character, got "${name}"`);
    }
  };
  const requireAction = (object: string, action: string, path: Path) => {
    const source = names.get(object);
    if (source == null) return;
    const actions = objectById.get(source)?.actions ?? [];
    if (!actions.some((a) => a.name === action)) {
      issue(path, `"${object}" has no action "${action}"`);
    }
  };
  const bindName = (name: string, source: string | null, path: Path) => {
    if (RESERVED_NAMES.includes(name)) issue(path, `"${name}" is reserved`);
    else if (knownName(name)) issue(path, `"${name}" is already bound`);
    names.set(name, source);
  };
  const checkDestination = (
    to: { type: "board"; board: string } | { type: "container"; container: string },
    path: Path,
  ) => {
    if (to.type === "board") requireBoard(to.board, [...path, "board"]);
    else requireObject(to.container, [...path, "container"]);
  };

  const checkExpectations = (list: Expectation[], base: Path, inStep: boolean) => {
    let rejections = 0;
    list.forEach((e, i) => {
      const path = [...base, i];
      if ("object" in e) requireObject(e.object, [...path, "object"]);
      switch (e.type) {
        case "cell":
          checkValue(e.value, [...path, "value"], knownName);
          break;
        case "action":
          requireAction(e.object, e.action, [...path, "action"]);
          break;
        case "rejected":
          rejections += 1;
          if (!inStep) issue(path, "rejected is only meaningful in a step's expect");
          if (rejections > 1) issue(path, "a step can be rejected only once");
          break;
        case "container":
          requireObject(e.container, [...path, "container"]);
          break;
        case "placement":
          requireBoard(e.board, [...path, "board"]);
          break;
        case "contents":
          e.contents.forEach((c, j) => {
            requireObject(c, [...path, "contents", j]);
          });
          break;
        case "cell_visible":
        case "object_visible":
          requireViewer(e.viewer, [...path, "viewer"], "viewer");
          break;
        case "log_includes":
          if (!inStep) issue(path, "log_includes needs a step; the log is empty after setup");
          requireObject(e.effect.object, [...path, "effect", "object"]);
          checkValue(e.effect.value, [...path, "effect", "value"], knownName);
          break;
        default:
          break;
      }
    });
  };

  checkExpectations(scenario.expect ?? [], ["expect"], false);

  scenario.steps.forEach((step, i) => {
    const base: Path = ["steps", i];
    const d = step.do;
    const rejected = (step.expect ?? []).some((e) => e.type === "rejected");

    if (d.type === "bind") {
      if (step.actor !== undefined) issue([...base, "actor"], "a bind step has no actor");
      if (rejected) issue([...base, "expect"], "a bind step cannot be rejected");
    } else if (step.actor === undefined) {
      issue([...base, "actor"], "actor is required");
    } else {
      requireViewer(step.actor, [...base, "actor"], "actor");
    }

    const at = [...base, "do"];
    switch (d.type) {
      case "set":
      case "override":
        requireObject(d.object, [...at, "object"]);
        checkValue(d.value, [...at, "value"], knownName);
        break;
      case "clear_override":
        requireObject(d.object, [...at, "object"]);
        break;
      case "invoke":
        requireObject(d.object, [...at, "object"]);
        requireAction(d.object, d.action, [...at, "action"]);
        break;
      case "move":
        requireObject(d.object, [...at, "object"]);
        checkDestination(d.to, [...at, "to"]);
        break;
      case "spawn": {
        const template = objectById.get(d.template);
        if (!template?.is_template) {
          issue([...at, "template"], `"${d.template}" is not a template in setup`);
        }
        checkDestination(d.to, [...at, "to"]);
        for (const [cell, content] of Object.entries(d.cells ?? {})) {
          if (NON_CELL_STRUCTURAL.includes(cell)) {
            issue([...at, "cells", cell], `"${cell}" is structural and cannot be set at spawn`);
          } else if (content.type !== "formula") {
            checkValue(content, [...at, "cells", cell], knownName);
          }
        }
        if (rejected) break;
        bindName(d.as, template ? d.template : null, [...at, "as"]);
        const owned = template ? descendants(d.template) : new Set<string>();
        for (const [source, binding] of Object.entries(d.owned ?? {})) {
          if (!owned.has(source)) {
            issue(
              [...at, "owned", source],
              `"${source}" is not in the contents of "${d.template}"`,
            );
          }
          bindName(binding, owned.has(source) ? source : null, [...at, "owned", source]);
        }
        break;
      }
      case "bind":
        if (d.in !== undefined) requireObject(d.in, [...at, "in"]);
        if (d.where) checkValue(d.where.value, [...at, "where", "value"], knownName);
        bindName(d.as, null, [...at, "as"]);
        break;
      case "undo":
        break;
    }

    checkExpectations(step.expect ?? [], [...base, "expect"], true);
  });
}
