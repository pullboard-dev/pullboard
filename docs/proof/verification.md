# Proof audit: the verification rows, V1 to V9 and V16

Each verification row was built before the board could verify anything, so no accepted item vouched for it. This audit breaks each row's rule in `src/`, one change at a time, and checks that a test carrying the row's id goes red. A row whose tests stay green under a broken rule is not proven, however long its tests have passed.

Re-run it with `node docs/proof/verification-mutants.mjs`. It copies the repo to a temporary folder and changes only that copy. First it checks that every target test is green on the unchanged copy, since a red that was already there proves nothing. It exits 1 if any change comes out other than expected.

| Row | Rule | Change that breaks it | Test that must go red | Result |
|---|---|---|---|---|
| V1 | The builder never verifies its own work. | `notBuilder` always passes | the builder never verifies its own work | red |
| V2 | The criterion freezes at first claim: title, criterion and cited rows. | every claim freezes again | the first claim freezes the criterion; later claims keep it | red |
| V2 | | the freeze leaves out the title | the frozen criterion covers title, criterion and cited row text | red, **after this audit** |
| V2 | | the freeze leaves out the cited row text | the frozen criterion covers title, criterion and cited row text | red |
| V3 | Verify refuses when the frozen criterion has changed. | the board's `criterionUnchanged` always passes | a verdict against a moved criterion is refused | red |
| V3 | | the board's check and the CLI's both pass | verify runs at the submitted commit, against the criterion frozen at claim | red |
| V3 | | the CLI's check alone is removed | verify runs at the submitted commit, against the criterion frozen at claim | green, as expected: the board refuses with the same code |
| V4 | Submit needs a clean tree and the gate green at HEAD. | submit takes a dirty tree | submit needs a clean tree, nothing untracked, and the gate green at HEAD | red |
| V4 | | submit takes untracked files | submit needs a clean tree, nothing untracked, and the gate green at HEAD | red |
| V4 | | submit takes a red gate | a red gate refuses submit | red, **once tagged V4 by this audit** |
| V5 | ACCEPT needs CRITERION_MET and a note; REJECT needs a reason code and a note. | no proof note; another reason; no reason code; no note (four changes) | ACCEPT needs CRITERION_MET; REJECT needs a reason code and a note | red, all four |
| V6 | REJECT reopens the item. Resubmitting needs a new head. | a rejected head may be submitted again; a reject leaves the item submitted | REJECT reopens the item; resubmitting a rejected head is refused | red, both |
| V7 | The verifier's checkout contains the submitted commit. | verify skips the containment check | verify runs at the submitted commit, against the criterion frozen at claim | red |
| V8 | Every verdict binds the submitted commit and the frozen digest. | the verdict records the verifier's head as the commit; the verdict records no digest | every verdict binds the submitted commit and the frozen digest | red, both |
| V9 | In the main checkout, verifying needs --as coordinator. | the main checkout verifies without --as | verify runs at the submitted commit, against the criterion frozen at claim | red, **once tagged V9 by this audit** |
| V16 | Submit runs the gate itself on the exact tree it submits; no stamp from an earlier run stands in. | submit trusts a stamp written by hand | submit runs the gate itself: a stamp written by hand never stands in for a red gate | red |
| V16 | | submit trusts an earlier run's stamp | submit runs the gate even on a tree an earlier run passed, which a plain gate run may skip | red |
| V16 | | the gate trusts the stamp whatever submit asks | submit runs the gate itself: a stamp written by hand never stands in for a red gate | red |
| V16 | | submit does not look whether the tree moved; it misses a new commit; it misses an edited tracked file (three changes) | submit refuses a tree its gate left changed: a new commit, or an edited tracked file | red, all three |

## What the audit changed

- **V2:** the freeze test checked that a reworded row and a changed criterion move the digest, but never the title. A freeze without the title passed. It now asserts that a changed title moves the digest too.
- **V4:** the red-gate case was tested by "a red gate refuses submit", which carried no row id. So the row's own test went green with the red-gate refusal removed. That test now carries V4.
- **V9:** the main-checkout rule was checked inside the V3 and V7 test, but no test named V9. That test now carries V9.

## Closed: a hand-written stamp passed a red gate (V4, closed by V16 in #51)

`runGate` skipped the gate when `pullboard-gate-green` in the git dir held the committed tree's hash, and any agent can write that file. The audit reproduced it on a fresh repo whose gate was red:

```
pullboard submit 1    -> [GATE_RED] the gate is red at 8c6b3057c8d7
git rev-parse 'HEAD^{tree}' > "$(git rev-parse --git-path pullboard-gate-green)"
pullboard submit 1    -> submitted #1 at 8c6b3057c8d7; gate green (this tree already passed)
```

On one machine, any file pullboard writes an agent can write too, so no stamp can be made safe to trust. Since #51, submit runs the gate itself every time. The gate starts on exactly the commit submitted, and submit refuses MOVED_DURING_GATE if HEAD or a tracked file differs from it when the gate ends. The stamp now only saves a run where nothing is proven by it: pre-push and `pullboard gate` (C3). Gitignored files that a gate may read are still out of scope; a fresh checkout per submit would be the next step.

**What submit does not claim.** The gate is code in the submitted tree. A gate that edits a tracked file and puts it back before it exits, or commits and resets, ends on the submitted commit and passes. tests-1 showed both on fresh repos while reviewing #51. Submit cannot tell such a run from an honest one: a gate could as well copy the tree elsewhere and test the copy. So submit promises only what it can see: no stamp stands in, and the gate starts and ends on the submitted commit. What the gate's code does in between is part of the submitted tree. Its verifier reads it and reruns the gate at that commit.
