1. **vtt-o9i.4, .5, .3, .14 — blocker — Package bootstrapping happens after its consumers.**  
   CLAUDE.md requires tests to import their own package by name, but `.14` owns the public exports and depends on the parser and dice implementation. The existing formula index exports only `PACKAGE`. Also, `.3` adds the fixtures devDependency while `.4` and `.5` can already run fixture-based tests independently.  
   **Change:** Assign each foundational bead its own public export lines, with `.14` preserving them. Establish fixture access and dependency/lockfile changes in an earlier prerequisite, or explicitly specify an independent file-loading approach.

2. **vtt-o9i.3, .10; vtt-75c.2 — should-fix — The M2 documentation dependency is missing.**  
   `.3` explicitly implements structural defaults and landing rules “as written by vtt-75c.2,” but does not depend on it. The repository’s description of `vtt-75c.2` also edits `packages/fixtures/src/schema.ts` and `test/format.test.ts`, which `.10` edits, without an ordering edge.  
   **Change:** Add `.3 → vtt-75c.2`. This also orders `.10` after those fixture-format edits transitively. Confirm the recorded graph matches.

3. **vtt-o9i.3, .8, .9, .12 — blocker — Candidate discovery has no complete error contract.**  
   The host must evaluate geometry to determine candidates, but returns only `ObjectId[]`. The beads do not settle what happens when that evaluation returns `#DIV0`, `#CYCLE`, or another error. “Invalid position is excluded” could swallow errors. Moreover, `.12` promises candidate ordering before *any geometry read*, although the host must read geometry before the evaluator receives and sorts candidates. Literal-geometry tests do not resolve this contradiction.  
   **Change:** Specify discovery-stage read ordering and error handling separately from candidate testing, including erroneous positions versus successfully evaluated invalid positions. Define how discovery errors reach the evaluator, and require equivalent outcomes on brute-force and indexed hosts with formula geometry, errors, and cycles.

4. **vtt-o9i.9, .12 — should-fix — Restarting evaluations defeats the work budget.**  
   With one unresolved dependency computed per retry, a formula that reads many distinct formula cells repeatedly evaluates its growing prefix. Only the final attempt is charged, so an evaluation within the 20,000-unit budget can perform quadratic work. The 5,000-cell chain test does not exercise this wide-dependency case. This threatens DESIGN §7’s responsiveness requirement.  
   **Change:** Preserve continuations or completed evaluation prefixes, or define a separate deterministic bound on retry work. Add a cold-cache test with thousands of distinct formula dependencies and assert a work-count bound.

5. **vtt-o9i.9 — should-fix — The engine bead is oversized.**  
   It combines iterative dependency resolution, memoization, invalidation, cycle membership and recovery, budget accounting, spatial callbacks, ad hoc evaluation, and exception recovery. Each is substantial, and several interact with unresolved host semantics.  
   **Change:** Split into sequential beads for resolution/memoization, dependency graph/invalidation/cycles, and budget/spatial integration. Give each explicit file ownership and intermediate acceptance criteria; make `.10`, `.11`, and M2’s adapter depend on the completed integration bead.

6. **vtt-o9i.14, .7 — should-fix — An acceptance test becomes false when a dependent lands.**  
   `.14` requires `x.where(...)` to return `#NAME` “before the library exists.” Once `.7` registers `where`, that assertion cannot remain valid against the normal package evaluator. `.7` owns registrations, not `.14`’s tests.  
   **Change:** Specify an injectable registry and run this test against an explicitly core-only registry, or use a permanently unknown method/function for the missing-registration test. Require `.14`’s tests to remain valid after library registration.

7. **vtt-o9i.6, .12; vtt-75c.2/.10 — blocker — Viewer conversion has no agreed consumer.**  
   FORMULAS §2 permits character references and lists as viewer expressions. `.6` supplies `toViewers` specifically for consumers of `visible_to`, but excludes evaluator conversion. Meanwhile, the cited M2 plan says any value other than an actual viewers value fails closed. Thus `visible_to = owner` or a list of character references can silently hide the object instead of expressing the documented visibility.  
   **Change:** Specify exactly where `toViewers` runs and require the visibility consumer to use it, retaining fail-closed behavior on conversion errors. Add integration criteria for reference-valued and list-valued visibility formulas. Alternatively, explicitly revise the language to disallow those forms.

8. **vtt-o9i.13 — should-fix — Roll validation accepts demonstrably invalid results.**  
   Checking each die against “some term’s range” permits a `1d6+1d20` result with kept dice `[20,1]`. Counts and total can still match. Similarly, `2d6kh1` with kept `[1]`, dropped `[6]`, and total `1` passes the stated checks despite violating keep-highest. With rerolls or explosions, even plainly incorrect totals are outside the promised checks.  
   **Change:** Validate per-term ranges, counts, and keep/drop consistency wherever term boundaries are reconstructible; validate totals wherever the encoding determines them. Explicitly document what cannot be verified for mixed signed exploding pools, and add negative tests beyond a single out-of-range die and wrong simple total.

9. **vtt-o9i.4, .14 — should-fix — Numeric literals can bypass the finite-number invariant.**  
   The lexer accepts arbitrarily long digit sequences. Converting one to a JavaScript number can produce `Infinity`, but `.14` specifies no finite-number check for number literals. `.6` only catches non-finite arithmetic results, so a standalone literal can escape those checks and produce a value rejected by `.2`.  
   **Change:** Define whether an overflowing numeric literal produces `#TYPE` or a parse failure, assign the check to one bead, and test both direct evaluation and nesting inside a list.

10. **vtt-o9i.3 — should-fix — The host-interface bead also implements a miniature mutable document store.**  
    Besides the public boundary and fixture conversion, it owns overrides, content replacement, moves, landing rules, creation, recursive deletion, and precise change reporting. That is a separate body of behavior, not a small interface prerequisite.  
    **Change:** Split interface/FakeEnv/fixture conversion from mutable MemoryHost. Keep explicit dependencies so `.14` can start after the interface work while engine and scenario tests wait for the mutable host.

11. **vtt-o9i.12, .4 — should-fix — The documentation bead neither records all decisions nor consistently precedes implementation.**  
    `.12` promises every settled language decision before any implementation starts, but `.4` explicitly runs concurrently. Its documentation checklist also omits significant parser decisions: numeric lexical restrictions, comments, backtick rules, record duplicates, and method argument syntax. Those decisions would remain discoverable only in bead text or code, contrary to FORMULAS.md’s stated purpose.  
    **Change:** Expand `.12` to document the complete syntax contract and add `.4 → .12`, or explicitly authorize concurrent parser work against a frozen contract while still requiring complete documentation before milestone acceptance.

**Overall verdict: not ready to implement.** Resolve the package bootstrap, spatial discovery/error contract, and viewer-conversion disagreement first. Then correct dependency and test-lifetime issues, strengthen numeric and roll validation, and split the engine and mutable-host work into independently reviewable beads.