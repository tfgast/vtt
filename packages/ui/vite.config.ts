/**
 * The UI's Vite config (DESIGN.md §7 Platform; PROTOCOL.md §1 HTTP routes,
 * §2 Session bootstrap; M4-D1; vtt-3l6.15).
 *
 * - `vite build` writes its bundles under `ui-assets/`, which the authority
 *   serves at `/ui-assets/`, apart from the table-image namespace `/assets/`.
 *   The build contains no session element: the serving authority injects it.
 * - The dev server (`pnpm dev`) gives the page the same bootstrap: the
 *   `vttSession()` plugin injects the session element from
 *   `VTT_URL`/`VTT_TOKEN`, else from the discovery file, else nothing (the UI
 *   then shows its "No authority running" screen). Run the authority beside
 *   it with `vtt-serve <file> --allow-origin http://localhost:5173`, so the
 *   page's WebSocket `Origin` is accepted.
 * - The dev server proxies `/assets` (uploads and image downloads) to the
 *   authority with `changeOrigin: true`, so the authority sees its own `Host`
 *   and its `Host` check passes. The target is resolved when the config
 *   loads; restart `pnpm dev` if the authority moves to another port.
 *
 * The workspace packages are imported by name, so the config must be loaded
 * with Vite's module runner (`--configLoader runner` on the `dev` and `build`
 * scripts; `configLoader: "runner"` through the JS API; M6-D41): the default
 * bundling loader externalizes bare imports, and Node cannot load
 * `@vtt/authority`'s TypeScript source (extensionless imports).
 */
import react from "@vitejs/plugin-react";
import {
  injectSession,
  readSessionFile,
  type SessionCredentials,
  sessionFilePath,
} from "@vtt/authority";
import { DEFAULT_PORT } from "@vtt/protocol";
import { defineConfig, type Plugin } from "vite";

/**
 * The credentials the dev page gets: `VTT_URL` and `VTT_TOKEN` when both are
 * set and non-empty, else the discovery file's `url` and `token`
 * (`$XDG_CONFIG_HOME/vtt/session.json`), else null.
 */
export function devSession(env: NodeJS.ProcessEnv = process.env): SessionCredentials | null {
  const url = env.VTT_URL;
  const token = env.VTT_TOKEN;
  if (url !== undefined && url !== "" && token !== undefined && token !== "") {
    return { url, token };
  }
  const info = readSessionFile(sessionFilePath(env));
  return info === null ? null : { url: info.url, token: info.token };
}

/** The http origin of an authority's `ws://host:port/ws` URL (`http://host:port`). */
export function authorityOrigin(wsUrl: string): string {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return url.origin;
}

/**
 * The dev server's session bootstrap (PROTOCOL.md §2): on every page load,
 * injects the `vtt-session` element with `devSession(env)`'s credentials
 * (read afresh, so an authority restart's new token arrives with a reload),
 * or leaves the page alone when there are none. `apply: "serve"`: never part
 * of `vite build`, whose output must not carry credentials.
 */
export function vttSession(env: NodeJS.ProcessEnv = process.env): Plugin {
  return {
    name: "vtt-session",
    apply: "serve",
    transformIndexHtml(html) {
      const session = devSession(env);
      return session === null ? html : injectSession(html, session);
    },
  };
}

export default defineConfig(() => {
  const session = devSession();
  // Without any session, `vtt-serve`'s default port (PROTOCOL.md §2).
  const target =
    session === null ? `http://127.0.0.1:${DEFAULT_PORT}` : authorityOrigin(session.url);
  return {
    plugins: [react(), vttSession()],
    build: { assetsDir: "ui-assets" },
    server: {
      proxy: {
        "/assets": { target, changeOrigin: true },
      },
    },
  };
});
