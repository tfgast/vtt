/**
 * The notices (vtt-3l6.17): presents the session's `NoticeStore` list
 * (vtt-3l6.21, which alone owns stickiness and expiry) with a dismiss
 * control per notice. Stale and uncertain writes (DESIGN.md §7 Undo,
 * PROTOCOL.md §6) are marked by their kind.
 */
import type { CSSProperties } from "react";
import type { NoticeLevel } from "../interaction/contracts";
import { useNoticeStore, useNotices } from "../session/hooks";

const LIST_STYLE: CSSProperties = {
  position: "fixed",
  right: 12,
  bottom: 32,
  zIndex: 10,
  display: "flex",
  flexDirection: "column",
  gap: 6,
  margin: 0,
  padding: 0,
  listStyle: "none",
  maxWidth: "28em",
};

const COLORS: Record<NoticeLevel, { background: string; border: string }> = {
  info: { background: "#eef2ff", border: "#8ea2e8" },
  success: { background: "#e8f6ec", border: "#6cbf83" },
  warning: { background: "#fff4d6", border: "#e0b84a" },
  error: { background: "#fde2e1", border: "#d9534f" },
};

const KIND_LABEL = { stale: "Stale write", uncertain: "Outcome unknown" } as const;

export function Notices() {
  const notices = useNotices();
  const store = useNoticeStore();
  if (notices.length === 0) return null;
  return (
    <ul aria-label="Notices" style={LIST_STYLE}>
      {notices.map((notice) => {
        const colors = COLORS[notice.level];
        return (
          <li
            key={notice.id}
            role={notice.level === "error" || notice.level === "warning" ? "alert" : "status"}
            data-level={notice.level}
            data-kind={notice.kind}
            style={{
              display: "flex",
              gap: "0.5em",
              alignItems: "flex-start",
              padding: "6px 8px",
              color: "#1b1b1f",
              background: colors.background,
              border: `1px solid ${colors.border}`,
            }}
          >
            <span style={{ flex: 1 }}>
              {notice.kind === undefined ? null : <strong>{KIND_LABEL[notice.kind]}: </strong>}
              <span>{notice.text}</span>
            </span>
            <button type="button" aria-label="Dismiss" onClick={() => store.dismiss(notice.id)}>
              ×
            </button>
          </li>
        );
      })}
    </ul>
  );
}
