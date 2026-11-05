/**
 * One scenario's server (vtt-5su.12): the setup document in an in-memory
 * `TableHost` with the scenario's dice script (vtt-5su.4, vtt-75c.15), a
 * server on port 0 (vtt-5su.10) and one GM `ProtocolClient` of kind `test`
 * over Node's `WebSocket` (vtt-5su.7). `close` shuts all three; every open
 * session is tracked so a test's `afterEach(closeAllSessions)` closes what a
 * failure left open.
 */
import {
  DocumentStore,
  type RunningServer,
  type ScriptedDiceEntry,
  ScriptedDiceSource,
  startServer,
  TableHost,
} from "@vtt/authority";
import type { Scenario } from "@vtt/fixtures";
import { ProtocolClient } from "@vtt/protocol";
import { documentFromSetup } from "../runner/setup";

export interface ProtocolSession {
  readonly host: TableHost;
  readonly server: RunningServer;
  readonly client: ProtocolClient;
  /** The host's dice source: the scenario's script. */
  readonly dice: ScriptedDiceSource;
  /** True once `close` has finished. */
  readonly closed: boolean;
  /** Closes the client, the server and the host. Idempotent. */
  close(): Promise<void>;
}

const open = new Set<ProtocolSession>();

/** Starts a server over `scenario`'s setup and connects a GM client. */
export async function openSession(scenario: Scenario): Promise<ProtocolSession> {
  const dice = new ScriptedDiceSource(scenario.dice as ScriptedDiceEntry[]);
  const host = TableHost.inMemory(DocumentStore.fromSnapshot(documentFromSetup(scenario.setup)), {
    dice,
  });
  let server: RunningServer;
  try {
    server = await startServer({ host, port: 0 });
  } catch (err) {
    await host.close();
    throw err;
  }
  const client = new ProtocolClient({
    url: server.url,
    token: server.token,
    client: { name: "fixture-runner", kind: "test" },
    onWarning: () => undefined,
  });
  let closing: Promise<void> | undefined;
  const session = {
    host,
    server,
    client,
    dice,
    closed: false,
    close(): Promise<void> {
      closing ??= (async () => {
        client.close();
        await server.close();
        await host.close();
        session.closed = true;
        open.delete(session);
      })();
      return closing;
    },
  };
  open.add(session);
  try {
    await client.connect();
  } catch (err) {
    await session.close();
    throw err;
  }
  return session;
}

/** Closes every session still open. */
export async function closeAllSessions(): Promise<void> {
  await Promise.all([...open].map((s) => s.close()));
}
