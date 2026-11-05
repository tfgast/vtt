/**
 * The edit-template banner (vtt-1xv.17; DESIGN.md §4.7 edit-template is the
 * gear; M5 plan Q17b): while a template selected with the gear is being
 * edited (`BinderPolicy.editing()`), "Editing template <name>: changes
 * apply to copies made from now on". Nothing otherwise. The name follows
 * the template's current view (its non-empty `name`, else its id).
 */
import { type CSSProperties, useCallback, useSyncExternalStore } from "react";
import { objectName } from "../interaction/drop-targets";
import { useSession, useTableSession } from "../session/hooks";
import type { BinderPolicy } from "./binder-policy";

const BANNER_STYLE: CSSProperties = {
  padding: "4px 8px",
  color: "#1b1b1f",
  background: "#fff4d6",
  border: "1px solid #e0b84a",
};

/** The banner's text for a template named `name`. */
export function editTemplateText(name: string): string {
  return `Editing template ${name}: changes apply to copies made from now on`;
}

export interface EditTemplateBannerProps {
  policy: Pick<BinderPolicy, "editing" | "subscribe">;
  style?: CSSProperties;
}

/** Shows which template is being edited (inside a `TableProvider`). */
export function EditTemplateBanner({ policy, style }: EditTemplateBannerProps) {
  const subscribe = useCallback((fn: () => void) => policy.subscribe(fn), [policy]);
  const editing = useSyncExternalStore(subscribe, () => policy.editing());
  const session = useTableSession();
  // Re-render when views change, so the name stays current.
  useSession((s) => s.viewVersion);
  if (editing === null) return null;
  const name = objectName(session.objectView(editing), editing);
  return (
    <div role="status" aria-label="Editing template" style={{ ...BANNER_STYLE, ...style }}>
      {editTemplateText(name)}
    </div>
  );
}
