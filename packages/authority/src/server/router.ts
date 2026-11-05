/**
 * The request router (PROTOCOL.md §4, §6, §10; D19, D22): maps each of the
 * 17 methods onto the module that implements it and turns the outcome into
 * a response body. Every handler but `save` is synchronous, so a commit and
 * its commit events happen inside `routeRequest`'s call; `save` returns a
 * promise. A `ProtocolFailure` becomes its error; any other exception or
 * rejection becomes `internal`, logged to stderr with the request id.
 */
import {
  type MethodName,
  type Params,
  type ProtocolError,
  ProtocolFailure,
  type RequestMessage,
  type Result,
} from "@vtt/protocol";
import type { Actor } from "@vtt/schema";
import type { TableHost } from "../host/table-host";
import {
  type CommandKind,
  executeTransact,
  executeUndo,
  type TxnCache,
} from "../protocol/commands";
import { explainAction, explainCell, explainGroup } from "../protocol/explain";
import {
  atPosition,
  changesSince,
  documentDump,
  evaluateAdhoc,
  getObjects,
  listObjects,
  logPage,
  zonesOnBoard,
} from "../protocol/queries";
import type { SubscriptionHub } from "../protocol/subscriptions";

/** What every request runs against: one per server. */
export interface RouterDeps {
  host: TableHost;
  /** The server's one hub (`createSubscriptionHub(host.table)`). */
  hub: SubscriptionHub;
  /** The server-wide deduplication cache, keyed per client instance. */
  txns: TxnCache;
}

/** Who sent a request: the connection after its `hello`. */
export interface RequestContext {
  /** The connection id, as registered with the hub. */
  conn: string;
  actor: Actor;
  kind: CommandKind;
  /** `hello` `client.instance`. */
  instance: string;
}

export type RequestOutcome = { ok: true; result: unknown } | { ok: false; error: ProtocolError };

export type RouteHandler<M extends MethodName> = (
  deps: RouterDeps,
  ctx: RequestContext,
  params: Params<M>,
) => Result<M> | Promise<Result<M>>;

export type RouteTable = { readonly [M in MethodName]: RouteHandler<M> };

const commandContext = (deps: RouterDeps, ctx: RequestContext) => ({
  table: deps.host.table,
  actor: ctx.actor,
  kind: ctx.kind,
  client: ctx.instance,
  dice: deps.host.dice,
  txns: deps.txns,
});

/** The handlers of the 17 methods of PROTOCOL.md §4. */
export const ROUTES: RouteTable = Object.freeze({
  transact: (d, c, p) => executeTransact(commandContext(d, c), p),
  undo: (d, c, p) => executeUndo(commandContext(d, c), p),
  invoke: () => {
    throw new ProtocolFailure("unsupported", "invoke is not supported until M5");
  },
  save: async (d) => {
    const event = await d.host.save();
    return event.message === undefined
      ? { status: event.status, revision: event.revision }
      : { status: event.status, revision: event.revision, message: event.message };
  },
  list_objects: (d, _c, p) => listObjects(d.host.table, p),
  get_objects: (d, _c, p) => getObjects(d.host.table, p),
  evaluate: (d, _c, p) => evaluateAdhoc(d.host.table, p),
  zones: (d, _c, p) => zonesOnBoard(d.host.table, p),
  at_position: (d, _c, p) => atPosition(d.host.table, p),
  changes_since: (d, _c, p) => changesSince(d.host.table, p),
  log: (d, _c, p) => logPage(d.host.table, p),
  document: (d, _c, p) => documentDump(d.host.table, p),
  explain_cell: (d, _c, p) => explainCell(d.host.table, p),
  explain_group: (d, _c, p) => explainGroup(d.host.table, p),
  explain_action: (d, _c, p) => explainAction(d.host.table, p),
  subscribe: (d, c, p) => d.hub.subscribe(c.conn, p),
  unsubscribe: (d, c, p) => {
    d.hub.unsubscribe(c.conn, p.subscription);
    return {};
  },
});

function failed(err: unknown, request: RequestMessage): RequestOutcome {
  if (err instanceof ProtocolFailure) return { ok: false, error: err.error };
  console.error(`vtt: internal error in request ${request.id} (${request.method}):`, err);
  return { ok: false, error: { code: "internal", message: "internal error" } };
}

/**
 * Runs one parsed request. Synchronous handlers answer synchronously; an
 * async handler (`save`) answers with a promise that never rejects.
 */
export function routeRequest(
  deps: RouterDeps,
  ctx: RequestContext,
  request: RequestMessage,
  routes: RouteTable = ROUTES,
): RequestOutcome | Promise<RequestOutcome> {
  try {
    const handler = routes[request.method] as RouteHandler<MethodName>;
    const result = handler(deps, ctx, request.params as Params<MethodName>);
    if (result instanceof Promise) {
      return result.then(
        (value): RequestOutcome => ({ ok: true, result: value }),
        (err: unknown) => failed(err, request),
      );
    }
    return { ok: true, result };
  } catch (err) {
    return failed(err, request);
  }
}
