/**
 * The session bootstrap (PROTOCOL.md §2, M4-D1): the page served by the
 * authority carries its connection credentials in one
 * `<script id="vtt-session" type="application/json">{"url", "token"}</script>`
 * element (vtt-3l6.14 injects it; the built UI has none).
 */

/** The explicit credentials the UI connects with. */
export interface SessionBootstrap {
  url: string;
  token: string;
}

/**
 * Reads the `vtt-session` element of `doc`: its JSON's `url` and `token`, or
 * null when the element is missing, is not `application/json`, or does not
 * hold a JSON object with non-empty string `url` and `token`.
 */
export function readBootstrap(doc: Document = document): SessionBootstrap | null {
  const element = doc.getElementById("vtt-session");
  if (element === null || element.tagName.toLowerCase() !== "script") return null;
  if ((element.getAttribute("type") ?? "").trim().toLowerCase() !== "application/json") {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(element.textContent ?? "");
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const { url, token } = parsed as Record<string, unknown>;
  if (typeof url !== "string" || url === "" || typeof token !== "string" || token === "") {
    return null;
  }
  return { url, token };
}
