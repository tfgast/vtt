The plan needs revision before parallel implementation. The package boundaries are sensible, but shared-file ownership and the fixture contract leave several agents unable to finish independently.

1. **vtt-1me.3, vtt-1me.4 — blocker — Concurrent root configuration edits.**  
   Both package beads will update `pnpm-lock.yaml`, and UI integration also needs the root TypeScript references that `.3` explicitly edits. Their common dependency on `.2` allows both to run concurrently against the same starting files.  
   **Change:** Make `.4` depend on `.3`, and explicitly require `.4` to register UI typechecking in the root build.

2. **vtt-1me.6, vtt-1me.8 — should-fix — Lint adoption races fixture development.**  
   `.6` may format every existing package while `.8` changes the fixtures package, and both introduce dependencies into the shared lockfile. Neither depends on the other, so passing checks in their separate worktrees does not establish that the merged result passes.  
   **Change:** Make `.8` depend on `.6`; require `.8` and its transcription children to satisfy the established lint and formatting commands.

3. **vtt-1me.2, vtt-1me.3, vtt-1me.4 — blocker — Test discovery has no complete owner.**  
   The root promises Vitest projects, but only the UI bead explicitly promises a package-level test configuration. The permanent `passWithNoTests` setting also permits an incorrectly wired scaffold to report success without delivering the epic’s required package tests.  
   **Change:** Define the exact project discovery convention in `.2`, require each package bead to supply its project configuration, and remove the temporary empty-workspace allowance once packages exist.

4. **vtt-1me.2, vtt-1me.3, vtt-1me.4 — should-fix — TypeScript and package consumption contracts are underspecified.**  
   “Composite-ready,” source `.ts` exports, and “builds via project references” do not specify whether packages emit artifacts or how consumers resolve them. The UI inherits a Node-oriented configuration without instructions for its browser build, while the proposed `node -e` check does not identify an import or assertion.  
   **Change:** State the root typecheck command, library emit/output policy, source-import convention, and exact import smoke check; give UI an explicit browser/bundler configuration and explain its participation in root typechecking.

5. **vtt-1me.3 — should-fix — Its acceptance criterion depends on scheduling.**  
   “Exactly one test per package” can include the concurrently implemented UI and becomes false when fixture tests arrive. `pnpm -r exec` likewise ranges over whichever packages happen to exist rather than the four packages owned by this bead.  
   **Change:** Require one passing smoke test in each of the four named libraries, allow additional tests, and scope import checks to those libraries.

6. **vtt-1me.8, vtt-1me.9, vtt-1me.10 — blocker — Shared fixture files and format ownership overlap.**  
   Both transcription beads edit `docs/FIXTURES.md` and may reasonably create the same scenario index test, while `.9` may add format fields that `.10` needs but cannot depend on. The hit-points and die examples in `.8` also overlap the production scenarios assigned to `.9`.  
   **Change:** Have `.8` own the generic discovery/validation test and shared format, with documentation links predetermined or split into bead-owned files; identify its examples as test-only samples that `.9` replaces or promotes. Remove `.9`’s permission to evolve the shared format concurrently with `.10`.

7. **vtt-1me.8 — blocker — Done-when permits a format that cannot support its dependents.**  
   Documenting constructs the format cannot express is sufficient to finish `.8` as written. `.10` can then encounter a required construct it cannot encode, file a follow-up, and still leave M0 without its promised fixtures.  
   **Change:** Require the format to express every mandatory §10 behavior before `.8` completes; unresolved format gaps must block the affected transcription bead, not merely produce follow-ups.

8. **vtt-1me.8, vtt-1me.10 — blocker — Spawned objects cannot be reliably addressed or checked.**  
   The scenario commands do not explicitly include spawning a template with initial cells, although `.10` must exercise Fireball copying and reference remapping. Expectations also lack an explicit way to bind generated identities and assert object existence, deletion, ownership, placement, and ordered contents.  
   **Change:** Add a fixture-level spawn command or a specified setup action, symbolic bindings for generated objects, and structural expectations covering those properties; require `.10` to assert remapping and recursive cleanup rather than just subsequent cell values.

9. **vtt-1me.8 — should-fix — Literal values need an explicit encoding.**  
   FORMULAS §2 distinguishes text, empty, references, dice expressions, roll results, viewers, and ink, but the bead leaves their machine-readable representation open. An untagged string or arbitrary object representation could make text indistinguishable from formula/dice source and accidentally admit records as stored cell values.  
   **Change:** Require unambiguous encodings and validation for all §2 storable values, including roll-result fields; explicitly separate formula source, literal text, errors, and spawn-only records.

10. **vtt-1me.8 — should-fix — The setup model risks contradicting containment semantics.**  
    The proposed table description emphasizes `container` as input without defining its relationship to ordered owning `contents` or mutually exclusive board placement. That leaves Draw and Shuffle without a guaranteed ordering and gives M2 a potentially inconsistent fixture representation to translate.  
    **Change:** Name DESIGN §4.1 and FORMULAS §3.1, and specify one authoritative setup representation with ordered contents, derived container links, unique IDs, acyclic ownership, and exclusive board/container placement.

11. **vtt-1me.8, vtt-1me.10 — should-fix — Scripted dice are being conflated with replay.**  
    Predetermined rolls make execution deterministic, but DESIGN §7 requires replay to apply recorded effects without executing actions or consuming randomness. Shuffle also needs a separate specified mechanism: an order-agnostic check can establish a permutation, but not an exact replayed order.  
    **Change:** Describe the dice script as execution input, define its granularity and exhaustion behavior, and choose an explicit shuffle permutation or permutation assertion. Extend the fixture contract with recorded-effect/replay expectations without implementing the runner in M0.

12. **vtt-1me.8 — should-fix — The named action contract exceeds the fixture vocabulary.**  
    FORMULAS §8 requires atomic failure, rejected preconditions with explanations, whole-action undo, and resolved log details, whereas `.8` only promises enabled/disabled state and log-group counts. A later M2 acceptance runner could not express those checks without redesigning the format.  
    **Change:** Add commands or expectations for rejected actions, unchanged state after failure, undo, and resolved log contents; name all of §8 rather than only §8.1.

13. **vtt-1me.8, vtt-1me.9, vtt-1me.10 — should-fix — Some §10 presentation and behavioral requirements are unassigned.**  
    Attack’s button show-when behavior is distinct from its guards, and Re-hiding requires object visibility and opaque-cover behavior rather than merely cell visibility. The generic transcription wording also allows omission of the tray’s container variant, die ownership variants, and Fireball’s stable applied log despite later live-value drift.  
    **Change:** Add the necessary presentation expectations to `.8` and explicitly enumerate these cases in `.9` and `.10`; give those beads the relevant visibility and face-layout doc sections.

14. **vtt-1me.10 — should-fix — The card bead contains several independently substantial scenarios.**  
    Fireball alone requires template copying, generated references, spatial membership, owned rows, multiple rolls, aggregate guards, damage, and recursive cleanup. Bundling it with Attack, Draw, and Shuffle makes a format gap in Fireball hold up three otherwise independent deliverables.  
    **Change:** Split Fireball into its own bead depending on `.8`, with separate scenario and documentation files; retain Attack, Draw, and Shuffle in the smaller card bead.

15. **vtt-1me.7 — should-fix — CI acceptance cannot be met by the stated branch trigger alone.**  
    The workflow runs on pull requests and pushes to `main`, so pushing an implementation branch without opening a pull request will not satisfy “green on a pushed branch.” Green on `main` is also a post-merge observation rather than something the coding agent can deliver within its branch.  
    **Change:** Say “green on the implementation pull request, then on main after merge,” or explicitly add branch-push triggers if that is the intended behavior.

Overall, M0 is reasonably scoped as package scaffolding plus acceptance data; it does not need to implement the canvas, authority protocol, persistence engine, or evaluator now. The blocking changes are to serialize shared configuration edits, make test discovery enforceable, and finish the fixture contract before transcription begins. With those corrections and Fireball separated, the plan should support independent agents and give M1/M2 a usable foundation without prematurely implementing their functionality.