/** Protocol version, default port, limits and close codes (PROTOCOL.md §1, §2, §10). */

/** The `protocol` number of `hello` and `welcome`; v1 grows only additively (§12). */
export const PROTOCOL_VERSION = 1;

/** The authority's default port (§2, D25). */
export const DEFAULT_PORT = 4747;

/** The limits of PROTOCOL.md §10 (D21), as sent in `welcome.limits`. */
export type Limits = {
  max_message_bytes: 1048576;
  max_ops: 1000;
  max_page: 200;
  max_ids: 200;
  max_subscriptions: 16;
  max_explain_depth: 4;
  max_explain_nodes: 200;
  max_source_length: 10000;
  max_groups: 500;
  max_log_window: 200;
  max_txn_ids_per_client: 1000;
  max_requests_per_second: 200;
  max_buffered_bytes: 67108864;
};

export const LIMITS: Readonly<Limits> = Object.freeze({
  max_message_bytes: 1048576,
  max_ops: 1000,
  max_page: 200,
  max_ids: 200,
  max_subscriptions: 16,
  max_explain_depth: 4,
  max_explain_nodes: 200,
  max_source_length: 10000,
  max_groups: 500,
  max_log_window: 200,
  max_txn_ids_per_client: 1000,
  max_requests_per_second: 200,
  max_buffered_bytes: 67108864,
});

/** WebSocket close codes (§1). */
export const CLOSE_CODES = Object.freeze({
  protocol: 4400,
  unauthorized: 4401,
  hello_timeout: 4408,
  slow_consumer: 4429,
  shutdown: 1001,
} as const);

export type CloseCode = (typeof CLOSE_CODES)[keyof typeof CLOSE_CODES];
