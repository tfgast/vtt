/**
 * Invoking actions from the UI (vtt-1xv.16; DESIGN.md §4.5 Pressing buttons
 * in the UI, §7 Undo and writes in the UI, §5.2; docs/PROTOCOL.md §4
 * `invoke`, §6 `uncertain`; M5 plan Q1 A1/A2, Q2, Q12, Q13, review r2
 * finding 4).
 *
 * - `requestInvoke` is the single UI invocation path, used by face buttons,
 *   the body double-click (`default_action`) and the inspector's Run
 *   (vtt-1xv.19): the policy's `canInvoke` first (templates are not played),
 *   then the action's `action_states` entry; a refusal is one notice and
 *   nothing is sent. Otherwise one `invoke` extension effect carrying the
 *   stamp, with `table` = the stamp's board at the camera's centre and, in
 *   view-as, the viewed character as `actor`.
 * - `invokeExtension` is the runtime's handler for that effect (vtt-3l6.23's
 *   extensions): one `invokeWithRetry` with the stamp's `baseRevision`
 *   (never the latest revision), whose single same-session resend is the
 *   only retry. A rejection is a notice (`describeRejection`; `when_false`
 *   adds the guard's source for the GM; a stale write is a sticky `stale`
 *   notice); an unsettled outcome is the sticky `uncertain` notice. The
 *   notice is shown whatever happened to the board or viewer since; the
 *   outcome settles back to the tool, which changes nothing with it.
 */
import {
  type InvokeResult,
  invokeWithRetry,
  type ObjectView,
  type ProtocolError,
  ProtocolFailure,
  type ProtocolRejection,
} from "@vtt/protocol";
import type { BoardId, ObjectId, Point } from "@vtt/schema";
import type { FacePolicy } from "../face/face-contracts";
import type { InteractionStamp } from "../interaction/contracts";
import type { Effect } from "../interaction/effects";
import type { ExtensionEffectHandler } from "../interaction/runtime";
import type { ReducerInput } from "../interaction/tool";
import type { NoticeStore } from "../session/notices";
import type { TableSession } from "../session/table-session";
import { WRITE_RETRY_TIMEOUT_MS } from "../session/writes";
import { describeError, describeRejection } from "../values/rejections";

/** The runtime extension name of an invocation (register `invokeExtension` under it). */
export const INVOKE_EXTENSION = "invoke";

/** Why the UI refuses to play a template (M5 plan Q13; DESIGN.md §4.5). */
export const TEMPLATE_REFUSAL = "Templates are not played: drag out a copy.";

/** The payload of an `invoke` extension effect (PROTOCOL.md §4 `invoke` params). */
export interface InvokePayload {
  object: ObjectId;
  action: string;
  /** What the `table` destination resolves to: the stamp's board at the camera's centre. */
  table: { board: BoardId; position: Point };
  /** In view-as, the viewed character (M5 plan Q12). */
  actor?: { type: "character"; id: ObjectId };
}

/**
 * How an invocation ended, as settled back to the tool: the authority's
 * `InvokeResult`, an outcome left unknown (`uncertain`), or another protocol
 * error (`failed`).
 */
export type InvokeOutcome =
  | InvokeResult
  | { status: "uncertain"; reason: string }
  | { status: "failed"; error: ProtocolError };

/** The default `FacePolicy`: every object but a template may be played. */
export const defaultFacePolicy: FacePolicy = {
  canInvoke(view) {
    return view.is_template ? { ok: false, reason: TEMPLATE_REFUSAL } : { ok: true };
  },
};

function stripPeriod(s: string): string {
  return s.endsWith(".") ? s.slice(0, -1) : s;
}

/** `text` with the guard's source when there is one (the GM's views carry it). */
function withGuard(text: string, when: string | undefined): string {
  return when === undefined ? text : `${stripPeriod(text)} (when: ${when}).`;
}

function whenOf(view: ObjectView | null | undefined, action: string): string | undefined {
  return view?.actions.find((a) => a.name === action)?.when;
}

/** Why `action` of `view` may not run now, from its `action_states` entry; null when enabled. */
function disabledReason(view: ObjectView, action: string): string | null {
  const state = (view.action_states ?? []).find((s) => s.name === action);
  if (state === undefined) return `${action} is not available.`;
  if (state.enabled) return null;
  if (state.reason === "when_error") return `${action}: its condition is an error.`;
  return withGuard(`${action}: its condition is false.`, whenOf(view, action));
}

/**
 * The effects of asking to invoke `action` of `view` with `stamp` (see the
 * module comment): one notice when refused, else one `invoke` extension
 * effect. `input` supplies the camera whose centre `table` names.
 */
export function requestInvoke(
  policy: FacePolicy,
  view: ObjectView,
  action: string,
  stamp: InteractionStamp,
  input: Pick<ReducerInput, "camera">,
): Effect[] {
  const allowed = policy.canInvoke(view);
  if (!allowed.ok) return [{ type: "notice", level: "info", text: allowed.reason }];
  const refused = disabledReason(view, action);
  if (refused !== null) return [{ type: "notice", level: "info", text: refused }];
  const payload: InvokePayload = {
    object: view.id,
    action,
    table: { board: stamp.board, position: [input.camera.x, input.camera.y] },
  };
  if (stamp.viewer.type === "character") {
    payload.actor = { type: "character", id: stamp.viewer.id };
  }
  return [{ type: "extension", name: INVOKE_EXTENSION, stamp, payload }];
}

function isPayload(p: unknown): p is InvokePayload {
  if (typeof p !== "object" || p === null) return false;
  const q = p as Partial<InvokePayload>;
  return (
    typeof q.object === "string" &&
    typeof q.action === "string" &&
    typeof q.table === "object" &&
    q.table !== null
  );
}

function rejectionText(
  session: TableSession,
  rejection: ProtocolRejection,
  payload: InvokePayload,
  gm: boolean,
): string {
  const viewer = session.getSnapshot().viewer;
  const text = describeRejection(rejection, (id) => session.refLabel(viewer, id));
  if (rejection.type !== "when_false" || !gm) return text;
  return withGuard(text, whenOf(session.objectView(payload.object), rejection.action));
}

/**
 * The runtime's `invoke` extension handler over `session`, pushing its
 * notices to `notices` (normally `sessionNotices(session)`). Resolves to the
 * `InvokeOutcome`.
 */
export function invokeExtension(
  session: TableSession,
  notices: NoticeStore,
): ExtensionEffectHandler {
  return async (effect): Promise<InvokeOutcome> => {
    const { stamp, payload } = effect;
    if (stamp === undefined || !isPayload(payload)) {
      const error: ProtocolError = { code: "bad_request", message: "malformed invoke effect" };
      notices.push({ level: "error", text: "The action was not invoked: malformed request." });
      return { status: "failed", error };
    }
    let result: InvokeResult;
    try {
      result = await invokeWithRetry(
        session.client,
        {
          object: payload.object,
          action: payload.action,
          base_revision: stamp.baseRevision,
          table: { board: payload.table.board, position: [...payload.table.position] },
          ...(payload.actor === undefined ? {} : { actor: payload.actor }),
        },
        { retry: { timeoutMs: WRITE_RETRY_TIMEOUT_MS } },
      );
    } catch (e) {
      const error: ProtocolError =
        e instanceof ProtocolFailure ? e.error : { code: "internal", message: String(e) };
      if (error.code === "uncertain") {
        notices.push({
          level: "warning",
          kind: "uncertain",
          text: `${payload.action} may or may not have been applied.`,
        });
        return { status: "uncertain", reason: describeError(error) };
      }
      notices.push({
        level: "error",
        text: `"${payload.action}" was not applied. ${describeError(error)}`,
      });
      return { status: "failed", error };
    }
    if (result.status === "rejected") {
      const gm = stamp.viewer.type === "gm";
      const text = rejectionText(session, result.rejection, payload, gm);
      if (result.rejection.type === "stale_write") {
        notices.push({ level: "warning", kind: "stale", text });
      } else {
        notices.push({ level: "error", text });
      }
    }
    return result;
  };
}
