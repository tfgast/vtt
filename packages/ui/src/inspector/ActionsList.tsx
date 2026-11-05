/**
 * The inspector's actions (vtt-3l6.12; DESIGN.md §4.5 "The inspector shows an
 * action's steps and precondition", §4.6 The inspector; PROTOCOL.md §7.2
 * `ActionDefinitionView`): for the GM each action's name, `when` and steps,
 * read-only (editing arrives with M5); for a character (view-as) the names
 * only, which is all a character view carries.
 */
import type { ObjectView } from "@vtt/protocol";
import type { CSSProperties } from "react";

export interface ActionsListProps {
  /** The current viewer's view of the object. */
  view: ObjectView;
  /** The GM's view: `when` and steps are shown. */
  gm: boolean;
}

const LIST_STYLE: CSSProperties = { margin: 0, padding: 0 };
const NOTE_STYLE: CSSProperties = { fontSize: "0.85em", opacity: 0.7 };
const CODE_STYLE: CSSProperties = { fontFamily: "monospace", whiteSpace: "pre-wrap" };

export function ActionsList({ view, gm }: ActionsListProps) {
  const actions = view.actions;
  return (
    <section aria-label="Actions" style={{ marginTop: "0.75em" }}>
      <h4 style={{ margin: 0 }}>Actions</h4>
      {actions.length === 0 ? (
        <p style={NOTE_STYLE}>No actions</p>
      ) : (
        <ul style={LIST_STYLE}>
          {actions.map((action) => (
            <li key={action.name} data-action={action.name} style={{ listStyle: "none" }}>
              <span style={{ fontWeight: 600 }}>{action.name}</span>
              {gm && action.when !== undefined && (
                <div>
                  <span style={NOTE_STYLE}>when </span>
                  <code style={CODE_STYLE}>{action.when}</code>
                </div>
              )}
              {gm && action.steps !== undefined && action.steps.length > 0 && (
                <ol style={{ margin: 0 }}>
                  {action.steps.map((step, i) => (
                    // Steps are an ordered list of source lines; duplicates are allowed.
                    // biome-ignore lint/suspicious/noArrayIndexKey: steps have no identity but their position
                    <li key={i}>
                      <code style={CODE_STYLE}>{step}</code>
                    </li>
                  ))}
                </ol>
              )}
            </li>
          ))}
        </ul>
      )}
      {gm && actions.length > 0 && <p style={NOTE_STYLE}>Read-only: editing arrives with M5.</p>}
    </section>
  );
}
