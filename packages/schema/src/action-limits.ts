/**
 * Action and face limits (docs/PROTOCOL.md §10, M5-D5). The schema owns the
 * values so the authority can enforce them without importing the protocol;
 * `@vtt/protocol`'s `LIMITS` advertises the same numbers in `welcome`.
 */

/** Items one `each` step iterates; beyond it the action refuses `step_error` `#LIMIT`. */
export const MAX_EACH_ITEMS = 1000;

/** Primitive calls in one action invocation; beyond it the action refuses `step_error` `#LIMIT`. */
export const MAX_ACTION_WRITES = 10000;

/** Elements per face element list; beyond it `set_face` is rejected `invalid`. */
export const MAX_FACE_ELEMENTS = 200;
