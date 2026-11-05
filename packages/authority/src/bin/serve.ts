#!/usr/bin/env -S node --import tsx
/**
 * `vtt-serve`: the authority process (DESIGN.md §7 Platform, Persistence;
 * PROTOCOL.md §2; D1, D5, D24, D25, D33). One process per table file: it
 * opens the table (taking its lock), serves the protocol on 127.0.0.1,
 * writes the discovery file, and on SIGINT or SIGTERM closes the server,
 * saves, releases the lock and removes the discovery file.
 *
 *   vtt-serve <file> [--port n] [--token=t] [--allow-origin o]…
 *             [--ui-dir dir | --no-ui] [--no-autosave] [--print-session]
 *             [--force-unlock] [--empty] [--open]
 *
 * A missing table file is created stocked with the example templates (the
 * GM binder on `gm_board`, DESIGN.md §4.7, §7 New tables and ownership;
 * M5-D19); with `--empty` it is created with no objects. `--empty` has no
 * effect on an existing file.
 *
 * HTTP (PROTOCOL.md §1; M4-D1): the table-image routes (`POST /assets`,
 * `GET /assets/<path>`) and then the built UI (`GET /`, `/index.html`,
 * `/ui-assets/<path>`, with the session element injected). `--ui-dir` names
 * the UI build directory (default: `packages/ui/dist` beside this package);
 * `--no-ui` serves no UI (`GET /` is 404) but still serves assets. Once
 * listening it logs `Open http://127.0.0.1:<port>/` (not with `--no-ui`).
 *
 * `--open` (PROTOCOL.md §2 "Opening a browser"; M6-D5) then opens that URL in
 * a browser (`$BROWSER` if set, else `open` on macOS, `xdg-open` elsewhere);
 * a failure to open logs one line and the server keeps serving. `--open`
 * with `--no-ui` is a usage error. `pnpm start <file>` runs vtt-serve with
 * `--open`.
 *
 * Development: run `pnpm dev` (the Vite dev server on
 * http://localhost:5173, which injects the session from the discovery file
 * and proxies `/assets` here) next to
 * `vtt-serve <file> --allow-origin http://localhost:5173`, so the dev page's
 * WebSocket `Origin` is accepted.
 *
 * Exit codes: 0 after a clean shutdown whose final save succeeded; 1 for a
 * usage error, a start-up failure (locked table, bad identity file, port in
 * use, any other open or listen failure) or a failed final save. Logs go to
 * stderr; stdout carries only the `--print-session` line, which holds
 * `{url, token, session, table_path, table_id, http}` (`http`:
 * `http://127.0.0.1:<port>/`).
 */
import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  canonicalTablePath,
  createAssetHttpHandler,
  createUiHttpHandler,
  type HttpHandler,
  newTableSnapshot,
  openBrowser,
  type RunningServer,
  removeSessionFile,
  removeTableLock,
  startServer,
  stockedTableSnapshot,
  TableHost,
  TableIdentityError,
  TableLockedError,
  writeSessionFile,
} from "../index";

const USAGE =
  "usage: vtt-serve <file> [--port n] [--token=t] [--allow-origin o]... [--ui-dir dir | --no-ui] [--no-autosave] [--print-session] [--force-unlock] [--empty] [--open]";

/** The default UI build directory: `packages/ui/dist`, resolved from this module's location. */
const DEFAULT_UI_DIR = fileURLToPath(new URL("../../../ui/dist", import.meta.url));

/**
 * The flags. Later flags (e.g. the UI's) are added here; `allowNegative`
 * gives every boolean a `--no-` form, which is how `--no-autosave` works.
 */
const OPTIONS = {
  port: { type: "string" },
  token: { type: "string" },
  "allow-origin": { type: "string", multiple: true },
  "ui-dir": { type: "string" },
  ui: { type: "boolean", default: true },
  autosave: { type: "boolean", default: true },
  "print-session": { type: "boolean", default: false },
  "force-unlock": { type: "boolean", default: false },
  empty: { type: "boolean", default: false },
  open: { type: "boolean", default: false },
} as const;

interface ServeArgs {
  file: string;
  port: number | undefined;
  token: string | undefined;
  allowOrigins: string[];
  /** The UI build directory (absolute), or null with `--no-ui`. */
  uiDir: string | null;
  autosave: boolean;
  printSession: boolean;
  forceUnlock: boolean;
  /** Create a missing file with no objects instead of the stocked GM binder. */
  empty: boolean;
  /** Open the served page in a browser once listening. */
  open: boolean;
}

class UsageError extends Error {}

function parse(argv: string[]): ServeArgs {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({
      args: argv,
      options: OPTIONS,
      allowPositionals: true,
      allowNegative: true,
      strict: true,
    });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  const { values, positionals } = parsed;
  if (positionals.length !== 1) {
    throw new UsageError(
      positionals.length === 0
        ? "missing <file>"
        : `expected one <file>, got ${positionals.length}`,
    );
  }
  let port: number | undefined;
  if (values.port !== undefined) {
    port = /^\d+$/.test(values.port) ? Number(values.port) : Number.NaN;
    if (!Number.isSafeInteger(port) || port > 65535) {
      throw new UsageError(`--port must be an integer from 0 to 65535, got ${values.port}`);
    }
  }
  if (values.token === "") throw new UsageError("--token must not be empty");
  if (!values.ui && values["ui-dir"] !== undefined) {
    throw new UsageError("--no-ui and --ui-dir cannot be combined");
  }
  if (values["ui-dir"] === "") throw new UsageError("--ui-dir must not be empty");
  if (values.open && !values.ui) {
    throw new UsageError("--open cannot be combined with --no-ui: there is no page to open");
  }
  return {
    file: positionals[0] as string,
    port,
    token: values.token,
    allowOrigins: values["allow-origin"] ?? [],
    uiDir: values.ui ? resolve(values["ui-dir"] ?? DEFAULT_UI_DIR) : null,
    autosave: values.autosave,
    printSession: values["print-session"],
    forceUnlock: values["force-unlock"],
    empty: values.empty,
    open: values.open,
  };
}

const log = (message: string): void => {
  process.stderr.write(`vtt-serve: ${message}\n`);
};

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const codeOf = (err: unknown): unknown =>
  typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;

/** Exits once stdout and stderr have flushed (pipes may be asynchronous). */
async function exit(code: number): Promise<never> {
  await Promise.all(
    [process.stdout, process.stderr].map(
      (stream) => new Promise<void>((resolve) => stream.write("", () => resolve())),
    ),
  );
  process.exit(code);
}

/** The one-line refusal for a locked table (D33: never taken over here). */
function lockedMessage(file: string, err: TableLockedError): string {
  const lockPath = `${file}.lock`;
  if (err.info === null) {
    return `${file} is locked: the lock file ${lockPath} is unreadable or malformed`;
  }
  const { pid, host, started } = err.info;
  const holder = `${file} is locked by pid ${pid} on ${host}, started ${started}`;
  return err.stale
    ? `${holder}; that process is not running: if no other vtt-serve uses this table, rerun with --force-unlock`
    : holder;
}

/** `--force-unlock`: removes the lock file, whatever it holds, and logs what it removed. */
async function forceUnlock(canonical: string): Promise<void> {
  const lockPath = `${canonical}.lock`;
  let present = true;
  try {
    lstatSync(lockPath);
  } catch (err) {
    if (codeOf(err) !== "ENOENT") throw err;
    present = false;
  }
  const info = await removeTableLock(canonical);
  if (info !== null) {
    log(
      `--force-unlock: removed ${lockPath} (pid ${info.pid} on ${info.host}, started ${info.started})`,
    );
  } else if (present) {
    log(`--force-unlock: removed ${lockPath} (unreadable or malformed content)`);
  } else {
    log(`--force-unlock: there was no lock file ${lockPath}`);
  }
}

async function main(argv: string[]): Promise<never> {
  let args: ServeArgs;
  try {
    args = parse(argv);
  } catch (err) {
    log(`${describe(err)}\n${USAGE}`);
    return exit(1);
  }

  // Signals: installed first so a signal during start-up still shuts down
  // cleanly; handled once, a second signal is ignored.
  let host: TableHost | null = null;
  let server: RunningServer | null = null;
  let sessionWritten = false;
  let started = false;
  let stopping: Promise<never> | null = null;
  let signalled = false;

  const shutdown = (): Promise<never> => {
    stopping ??= (async () => {
      if (server !== null) await server.close("shutdown");
      const result = host === null ? null : await host.close();
      if (sessionWritten) removeSessionFile(process.pid);
      if (result === null || result.saved) {
        if (result?.error !== undefined) log(result.error);
        return exit(0);
      }
      log(
        `the final save failed; revision ${result.revision} is not saved: ${result.error ?? "unknown error"}`,
      );
      return exit(1);
    })();
    return stopping;
  };

  const onSignal = (signal: NodeJS.Signals): void => {
    if (signalled) return;
    signalled = true;
    log(`${signal}: shutting down`);
    if (started) void shutdown();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  let canonical: string;
  try {
    canonical = canonicalTablePath(args.file);
    if (args.forceUnlock) await forceUnlock(canonical);
  } catch (err) {
    log(describe(err));
    return exit(1);
  }

  try {
    host = await TableHost.open(args.file, {
      createIfMissing: true,
      newTable: args.empty ? newTableSnapshot : stockedTableSnapshot,
      ...(args.autosave ? {} : { autosave: false as const }),
    });
  } catch (err) {
    if (err instanceof TableLockedError) log(lockedMessage(canonical, err));
    else if (err instanceof TableIdentityError) log(err.message);
    else log(`could not open ${canonical}: ${describe(err)}`);
    return exit(1);
  }
  for (const warning of host.warnings) log(`warning: ${warning}`);
  if (signalled) return shutdown();

  // Assets first, then the UI (vtt-3l6.16, vtt-3l6.14); both take the
  // server's url and token from the route context, known once listening.
  const http: HttpHandler[] = [createAssetHttpHandler({ host })];
  if (args.uiDir !== null) http.push(createUiHttpHandler({ uiDir: args.uiDir }));
  try {
    server = await startServer({
      host,
      ...(args.port === undefined ? {} : { port: args.port }),
      ...(args.token === undefined ? {} : { token: args.token }),
      allowOrigins: args.allowOrigins,
      http,
    });
  } catch (err) {
    const result = await host.close();
    if (codeOf(err) === "EADDRINUSE") {
      log(`port ${args.port ?? "4747 (the default)"} is in use; is another vtt-serve running?`);
    } else {
      log(`could not listen on port ${args.port ?? 4747}: ${describe(err)}`);
    }
    if (result.error !== undefined) log(result.error);
    return exit(1);
  }
  if (signalled) return shutdown();

  const tablePath = host.path as string;
  const tableId = host.tableId as string;
  try {
    writeSessionFile({
      url: server.url,
      token: server.token,
      pid: process.pid,
      table_path: tablePath,
      table_id: tableId,
    });
    sessionWritten = true;
  } catch (err) {
    // A start-up failure: stop serving rather than run undiscoverable.
    log(`could not write the session file: ${describe(err)}`);
    await server.close("shutdown");
    const result = await host.close();
    if (result.error !== undefined) log(result.error);
    return exit(1);
  }

  started = true;
  const httpUrl = `http://127.0.0.1:${server.port}/`;
  log(`serving ${tablePath} (table id ${tableId}) at ${server.url}`);
  if (args.uiDir !== null) log(`Open ${httpUrl}`);
  if (args.open) {
    // Never awaited and never fatal: the server keeps serving whatever happens.
    void openBrowser(httpUrl, { env: process.env, platform: process.platform }).then((result) => {
      if (!result.ok) log(`could not open a browser (${result.message}); open ${httpUrl}`);
    });
  }
  if (args.printSession) {
    process.stdout.write(
      `${JSON.stringify({
        url: server.url,
        token: server.token,
        session: server.session,
        table_path: tablePath,
        table_id: tableId,
        http: httpUrl,
      })}\n`,
    );
  }
  if (signalled) return shutdown();
  // Keep the process alive until a signal; the server's socket holds the loop.
  return new Promise<never>(() => undefined);
}

void main(process.argv.slice(2)).catch((err: unknown) => {
  log(`unexpected failure: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
