/**
 * The entry point (vtt-3l6.17; PROTOCOL.md §2 session bootstrap): without a
 * `vtt-session` element the start screen names `vtt-serve`; with one the app
 * connects with those explicit credentials.
 */
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { type StartedApp, startApp } from "@vtt/ui";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanupAuthorities, NodeWebSocket, startAuthority } from "../support/authority";

let started: StartedApp | null = null;
let container: HTMLElement;

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 800,
    height: 600,
    x: 0,
    y: 0,
    right: 800,
    bottom: 600,
    toJSON: () => ({}),
  });
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  started?.unmount();
  started = null;
  container.remove();
  document.getElementById("vtt-session")?.remove();
  cleanup();
  vi.restoreAllMocks();
  await cleanupAuthorities();
});

test("without a bootstrap element the start screen names vtt-serve", async () => {
  started = startApp({ container, WebSocket: NodeWebSocket });
  expect(started.session).toBeNull();
  const heading = await screen.findByRole("heading", { name: "No authority running" });
  expect(heading).toBeDefined();
  expect(within(container).getByText(/vtt-serve/)).toBeDefined();
});

test("with a bootstrap element the app connects and shows the GM board", async () => {
  const authority = await startAuthority();
  const element = document.createElement("script");
  element.id = "vtt-session";
  element.type = "application/json";
  element.textContent = JSON.stringify({ url: authority.url, token: authority.token });
  document.head.append(element);

  started = startApp({ container, WebSocket: NodeWebSocket });
  expect(started.session).not.toBeNull();
  await within(container).findByRole("tab", { name: "GM" }, { timeout: 4000 });
  await waitFor(() => expect(started?.session?.getSnapshot().ready).toBe(true));
  const session = started.session;
  started.unmount();
  started = null;
  // Unmounting closes the session it created.
  expect(session?.client.state).toBe("closed");
});
