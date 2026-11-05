/**
 * The React binding of the interaction runtime (vtt-3l6.23; M4 plan review
 * r2 finding 3): the runtime's overlays and previews, re-rendering when they
 * change, and the `BoardCanvas` handlers that feed it events. vtt-3l6.17
 * passes `previews` into `buildScene`, `overlays` as `toolOverlays` and
 * spreads `handlers` onto `BoardCanvas`. The runtime's owner disposes it.
 */
import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { BoardCanvasProps } from "../canvas/BoardCanvas";
import type { Previews } from "./contracts";
import type { ToolOverlay } from "./overlays";
import type { InteractionRuntime } from "./runtime";

/** `BoardCanvas`'s event props. */
export type InteractionHandlers = Pick<BoardCanvasProps, "onEvent">;

export interface UseInteractionOptions {
  runtime: InteractionRuntime;
}

export interface InteractionBinding {
  overlays: ToolOverlay[];
  previews: Previews;
  handlers: InteractionHandlers;
}

export function useInteraction({ runtime }: UseInteractionOptions): InteractionBinding {
  const subscribe = useCallback((fn: () => void) => runtime.subscribe(fn), [runtime]);
  const view = useSyncExternalStore(subscribe, () => runtime.getView());
  const handlers = useMemo<InteractionHandlers>(
    () => ({ onEvent: (event) => runtime.dispatch(event) }),
    [runtime],
  );
  return { overlays: view.overlays, previews: view.previews, handlers };
}
