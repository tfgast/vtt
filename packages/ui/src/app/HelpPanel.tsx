/**
 * The keyboard and gesture help (vtt-nb8.8; DESIGN.md §4.6 On the canvas,
 * §4.7; M6 plan Q12): a dialog listing `KEY_BINDINGS` (the table the
 * keybindings dispatch from), then `HELP_GESTURES`. The app opens it with
 * `?` and the toolbar's "?" button; Esc and its close button close it.
 */
import { type CSSProperties, useEffect, useId, useRef } from "react";
import { HELP_GESTURES } from "./help-content";
import { KEY_BINDINGS } from "./keybindings";

const BACKDROP_STYLE: CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(0, 0, 0, 0.3)",
  zIndex: 10,
};
const DIALOG_STYLE: CSSProperties = {
  background: "#fff",
  color: "#1c1c22",
  borderRadius: "6px",
  padding: "12px 16px",
  maxWidth: "min(40em, calc(100vw - 32px))",
  maxHeight: "calc(100vh - 32px)",
  overflow: "auto",
  boxShadow: "0 4px 24px rgba(0, 0, 0, 0.25)",
};
const HEADER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1em",
};
const TABLE_STYLE: CSSProperties = { borderCollapse: "collapse", width: "100%" };
const KEY_CELL_STYLE: CSSProperties = {
  padding: "2px 1em 2px 0",
  verticalAlign: "top",
  whiteSpace: "nowrap",
  fontWeight: 600,
};
const GESTURE_CELL_STYLE: CSSProperties = { ...KEY_CELL_STYLE, whiteSpace: "normal" };
const CELL_STYLE: CSSProperties = { padding: "2px 0", verticalAlign: "top" };
const CAPTION_STYLE: CSSProperties = { textAlign: "left", fontWeight: 600, padding: "8px 0 4px" };

export interface HelpPanelProps {
  onClose(): void;
}

export function HelpPanel({ onClose }: HelpPanelProps) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement;
    closeRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  return (
    <div
      style={BACKDROP_STYLE}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} style={DIALOG_STYLE}>
        <div style={HEADER_STYLE}>
          <h2 id={titleId} style={{ margin: 0, fontSize: "1.1em" }}>
            Keyboard and gesture help
          </h2>
          <button ref={closeRef} type="button" onClick={onClose}>
            Close
          </button>
        </div>
        <table style={TABLE_STYLE}>
          <caption style={CAPTION_STYLE}>Keys</caption>
          <tbody>
            {KEY_BINDINGS.map((b) => (
              <tr key={b.keys}>
                <td style={KEY_CELL_STYLE}>{b.keys}</td>
                <td style={CELL_STYLE}>{b.label}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <table style={TABLE_STYLE}>
          <caption style={CAPTION_STYLE}>Gestures</caption>
          <tbody>
            {HELP_GESTURES.map((g) => (
              <tr key={g.gesture}>
                <td style={GESTURE_CELL_STYLE}>{g.gesture}</td>
                <td style={CELL_STYLE}>{g.effect}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
