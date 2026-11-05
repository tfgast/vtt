/**
 * A subscription's local mirror (PROTOCOL.md §8): the views of a subscribe
 * result, kept current by applying each commit event's delta. Whole views
 * are upserted (D10); for `log` scope, `groups` holds the window of group
 * views by index. Browser-safe.
 */
import type { ObjectId } from "@vtt/schema";
import type { SubscriptionDelta } from "./messages";
import type { SubscribeResult } from "./methods";
import type { Cover, GroupView, ObjectView } from "./views";

export class ViewMirror {
  /** Object views by id. */
  readonly objects = new Map<ObjectId, ObjectView>();
  /** Covers by their opaque key. */
  readonly covers = new Map<string, Cover>();
  /** Log-scope window: group views by group index. */
  readonly groups = new Map<number, GroupView>();
  /** The revision the mirror reflects. */
  revision = 0;

  constructor(initial?: SubscribeResult) {
    if (initial) this.reset(initial);
  }

  /** Replaces the whole mirror with a subscribe result. */
  reset(initial: SubscribeResult): void {
    this.objects.clear();
    this.covers.clear();
    this.groups.clear();
    for (const view of initial.objects) this.objects.set(view.id, view);
    for (const cover of initial.covers) this.covers.set(cover.key, cover);
    for (const group of initial.groups ?? []) this.groups.set(group.index, group);
    this.revision = initial.revision;
  }

  /** Empties the mirror, at `revision`. */
  clear(revision: number): void {
    this.objects.clear();
    this.covers.clear();
    this.groups.clear();
    this.revision = revision;
  }

  /** Moves the revision only (a commit with no delta for this subscription). */
  advance(revision: number): void {
    this.revision = revision;
  }

  /** Applies one subscription delta of the commit at `revision`. */
  apply(delta: SubscriptionDelta, revision: number): void {
    for (const view of delta.objects) this.objects.set(view.id, view);
    for (const id of delta.removed) this.objects.delete(id);
    if (delta.covers) {
      for (const cover of delta.covers.upsert) this.covers.set(cover.key, cover);
      for (const key of delta.covers.removed) this.covers.delete(key);
    }
    for (const group of delta.groups_upserted ?? []) this.groups.set(group.index, group);
    for (const index of delta.groups_removed ?? []) this.groups.delete(index);
    this.revision = revision;
  }

  /** The log window, newest (highest index) first. */
  groupsNewestFirst(): GroupView[] {
    return [...this.groups.values()].sort((a, b) => b.index - a.index);
  }
}
