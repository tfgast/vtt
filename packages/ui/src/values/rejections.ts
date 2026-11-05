/**
 * One-sentence messages for rejections and protocol errors (docs/PROTOCOL.md
 * §6, §10). Pure.
 */
import type { ProtocolError, ProtocolErrorCode, ProtocolRejection } from "@vtt/protocol";
import type { Actor } from "@vtt/schema";
import type { RefLabel } from "./format";

export function describeRejection(r: ProtocolRejection, refLabel: RefLabel): string {
  const label = (id: string) => refLabel(id) ?? id;
  switch (r.type) {
    case "protected_cell":
      return `${label(r.object)}.${r.cell} is protected and cannot be written.`;
    case "containment_cycle":
      return `${label(r.object)} cannot go into ${label(r.container)}: an object cannot contain itself.`;
    case "undo_conflict": {
      const later = r.conflicting.map((n) => `#${n}`).join(", ");
      const detail = r.message ? ` (${stripPeriod(r.message)})` : "";
      return `Cannot undo #${r.target}: later edits ${later} conflict${detail}.`;
    }
    case "nothing_to_undo":
      return "There is nothing to undo.";
    case "type_error":
      return `${label(r.object)}.${r.cell} expects ${r.expected}.`;
    case "invalid":
      return `The edit is invalid: ${stripPeriod(r.message)}.`;
    case "stale_write": {
      const parts = r.conflicts.map((c) => `"${c.label}" by ${describeActor(c.actor, label)}`);
      if (r.truncated) {
        parts.push(parts.length > 0 ? "and more" : "and earlier changes are no longer listed");
      }
      const detail = parts.length > 0 ? ` (${parts.join(", ")})` : "";
      return `Not applied: the table changed first${detail}.`;
    }
    case "undo_target_changed":
      return r.actual === null
        ? `Not undone: there is no edit left to undo, not #${r.expected}.`
        : `Not undone: the latest edit is now #${r.actual}, not #${r.expected}.`;
    case "when_false":
      return `${r.action}: its condition is false.`;
    case "when_error":
      return `${r.action}: its condition is an error (${withMessage(r.code, r.message)}).`;
    case "step_error": {
      const detail = r.code === undefined ? stripPeriod(r.message) : withMessage(r.code, r.message);
      return `${r.action}: step ${r.step + 1} failed${detail ? ` (${detail})` : ""}.`;
    }
  }
}

function describeActor(actor: Actor, label: (id: string) => string): string {
  switch (actor.type) {
    case "gm":
      return "the GM";
    case "character":
      return label(actor.id);
    case "agent":
      return actor.name ? `agent ${actor.name}` : "an agent";
  }
}

const ERROR_SENTENCES: Record<ProtocolErrorCode, string> = {
  bad_request: "The request was malformed",
  unknown_method: "The table does not know that request",
  unauthorized: "You are not allowed to do that",
  protocol_version: "This client and the table speak different protocol versions",
  busy: "The table is busy; try again in a moment",
  too_large: "The request is too large",
  not_found: "That was not found",
  unsupported: "The table does not support that",
  internal: "The table hit an internal error",
  disconnected: "Not connected to the table",
  timeout: "The table did not answer in time",
  uncertain: "The edit may or may not have been applied",
  wrong_table: "Connected to a different table than expected",
  retry_unknown: "The table no longer knows whether the edit was applied",
};

export function describeError(e: ProtocolError): string {
  const base = ERROR_SENTENCES[e.code] ?? "The request failed";
  const message = stripPeriod(e.message ?? "").trim();
  return message ? `${base} (${message}).` : `${base}.`;
}

/** `#CODE` or `#CODE: message`, the message without its final period. */
function withMessage(code: string, message: string | undefined): string {
  const m = stripPeriod(message ?? "").trim();
  return m ? `${code}: ${m}` : code;
}

function stripPeriod(s: string): string {
  return s.endsWith(".") ? s.slice(0, -1) : s;
}
