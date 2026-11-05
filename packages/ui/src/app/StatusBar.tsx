/**
 * The status bar (vtt-3l6.17; PROTOCOL.md §2 connection errors, §8; review
 * r1 finding 13): the connection state, the revision and the save status.
 *
 * - Before the first connection: "Connecting…".
 * - `disconnected` after a connection: a banner; with `recovering`, a
 *   resynchronizing banner. Both clear by themselves.
 * - `unauthorized` (terminal: the page's credentials are explicit, so a new
 *   token is never picked up): the authority restarted with a new token;
 *   "Reload" reloads the page, which fetches the new bootstrap token.
 * - `wrong_table` (terminal): the authority now serves another table.
 */
import type { ConnectionError } from "@vtt/protocol";
import { type CSSProperties, useRef } from "react";
import { useSaveStatus, useSession } from "../session/hooks";
import type { SaveStatus } from "../session/writes";

const BAR_STYLE: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "1em",
  padding: "2px 6px",
  fontSize: "0.85em",
};
const BANNER_STYLE: CSSProperties = {
  padding: "2px 8px",
  background: "#fff4d6",
  color: "#4a3500",
  border: "1px solid #e0b84a",
};
const TERMINAL_STYLE: CSSProperties = {
  ...BANNER_STYLE,
  background: "#fde2e1",
  color: "#5c0f0b",
  border: "1px solid #d9534f",
};

/** The save status as shown. */
export function saveStatusText(status: SaveStatus | null): string | null {
  if (status === null) return null;
  switch (status.status) {
    case "saving":
      return "Saving…";
    case "saved":
      return "Saved";
    case "saved_not_durable":
      return status.message === undefined
        ? "Saved, not durably"
        : `Saved, not durably: ${status.message}`;
    case "failed":
      return `Save failed: ${status.message ?? "no reason given"}`;
  }
}

function ConnectionBanner({ connection }: { connection: ConnectionError }) {
  if (connection.code === "unauthorized") {
    return (
      <div role="alert" style={TERMINAL_STYLE}>
        The authority restarted with a new token, so this page can no longer connect. Reload the
        page to connect with the new token.{" "}
        <button type="button" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
  if (connection.code === "wrong_table") {
    return (
      <div role="alert" style={TERMINAL_STYLE}>
        The authority now serves a different table than this page was opened for (
        {connection.message}). Open the page the authority prints for its table.
      </div>
    );
  }
  return (
    <div role="alert" style={BANNER_STYLE}>
      {connection.recovering
        ? "Reconnected. Resynchronizing…"
        : `Disconnected from the authority (${connection.message}). Reconnecting…`}
    </div>
  );
}

export function StatusBar() {
  const connection = useSession((s) => s.connection);
  const ready = useSession((s) => s.ready);
  const revision = useSession((s) => s.revision);
  const saveText = saveStatusText(useSaveStatus());
  // Whether the session has been connected at least once (before that, `disconnected` means connecting).
  const connected = useRef(false);
  if (ready || connection === null) connected.current = true;
  const connecting =
    !connected.current && connection?.code === "disconnected" && connection.recovering !== true;

  return (
    <footer style={BAR_STYLE}>
      {connecting ? (
        <span role="status">Connecting…</span>
      ) : connection !== null ? (
        <ConnectionBanner connection={connection} />
      ) : null}
      <span>Revision {revision}</span>
      {saveText === null ? null : <span role="status">{saveText}</span>}
    </footer>
  );
}
