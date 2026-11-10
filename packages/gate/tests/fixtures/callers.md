# Asynchronous nested test runs

Item #1107 adds `awaitNestedRun(child)`. Its caller promises to yield until the returned wait settles. This is a scheduling contract, not proof that other JavaScript callbacks stop computing. Do not abandon the wait with `Promise.race`, do unrelated work while it is active, or open another loan in the same file. A timeout must signal its owned child inside the wait and let close and borrowed-descendant cleanup finish before returning.

Pass the original fixture promise with its `.child`, a raw child from the admitted process's current `spawn` export, or a completion promise explicitly retaining that same child. The original completion value and error are preserved. A standalone fixture promise is an ordinary wait. An unobserved standalone raw child is refused: past error and close events cannot be reconstructed. A deliberately independent child pool retains ordinary token accounting. An `exec`, `execFile`, `fork` or previously captured spawn handle with no exact offer is refused. The spawn wrapper preserves effective Node option/environment fields, including inherited environment values; it does not promise original option-object identity. Seventeen synthetic argument/environment cases compare against a separate Node process that loads neither loan wrapper.

A spawn only carries a dormant per-child offer. It does not create a loan. Explicit waiting activates the offer; an already admitted ordinary child keeps its own token. The helper closes new admission before draining the borrowed path. If cleanup cannot establish safe resumption, the owning test process exits instead of returning a live loan.

## Terminal waits migrated

| Caller | Wait and pool behavior |
| --- | --- |
| `test/runner-pid.test.js` | Both the outer runner and generated nested runner use the helper. Existing runner-PID observations and exit-code assertions remain. |
| `test/test-isolation.test.js` | The original fixture promises for calm and hostile-machine runner probes use the helper. Isolation inputs and assertions remain. The direct Node negative control keeps the inherited pool and also uses the explicit helper; it does not become a production-runner invocation. |
| `test/view-port.test.js` | The occupied-port nested suite uses the helper around its original promise. The unrelated port listener remains running. |
| `test/resources.test.js` | `runWaiter` uses the helper for the short-lock and long-lock terminal runner waits. The lock-holder process is not lent to. |
| `test/gate-admission.test.js` | Outer private-fixture runner waits use explicit helper pass-through. The parallel outer runs have deliberately separate pools. The generated busy parent deliberately does not lend. New one-token progress and no-helper diagnostic controls distinguish the two contracts. |
| `test/runner-browser-free-fixture.js` | Runner and gate completion waits use the helper while preserving the original hold/free order: the initial remote run intentionally keeps the local slot held, and local fallback waits begin after release. The fixture deliberately removes inherited test-pool state, so these are ordinary independent-pool waits. |
| `test/runner-tooling-fixture.js` | `awaitRoundTrip` keeps its exact child on a terminal progress-monitor promise. Its existing phase deadlines stop the owned group inside the wait; helper cleanup completes before return or throw. This covers `runThroughGate` and callers of the shared monitor. |
| `test/runners-*.test.js` and `test/runners-scenarios.fixture.js` | Terminal registered-runner checks use the migrated shared `awaitRoundTrip` / `runThroughGate` seam. The file's other arbitrary process starts are not all runner starts. |
| `test/runner-paired-rerun-fixture.js` | Its actual paired-rerun gate uses the shared terminal monitor. Separate phase-emitter and CPU-worker children do not become runner invocations merely because this file also configures a runner. |
| `test/gate-profile.test.js` | After releasing the queue holder, both the two-run gate and submission terminal deadlines are inside the helper. A timeout stops and awaits the owned child before returning its error. Existing output/profile results are preserved. |
| `test/landing-shards.test.js` | Single landing and runner-answer waits carry their exact child through deadline cancellation and final helper drain. The concurrent-pair case still starts both landings immediately; only lending is serial, and both terminal results settle before an error is surfaced. |

## Interactive phases reserved for #1152

These callers coordinate with a running nested test before its final close. Lending only at their final close does not fix an earlier marker wait; lending at spawn would violate the explicit yielding contract. They are not represented as deadlock-free by #1107.

| Caller | Outstanding phase |
| --- | --- |
| `test/resources.test.js` | The non-browser check/submit admission cases wait for an item/submit marker or queue observation, inspect other leases, then release a barrier before the terminal result. |
| `test/gate-resource.test.js` | `launchTestRunner`, whole-suite holders and focused-run probes wait for file-written markers and gate/resource assertions before release. Group completion must preserve these phases and each child's original result shape. |
| `test/run-tests.test.js` | Worker identity, descendant-drain and focused-pool cases inspect readiness, capture identities and release barriers before terminal close. Their existing timeout races must not abandon a live loan. |
| `test/cockpit/stable.test.js` | Runner-victim cases intentionally observe browser ownership, kill the known victim and prove drain. This is an interactive custody test, not a normal successful terminal wait. It belongs to the view lane. |

## Exclusions and scope of the inventory

The `land.test.js` adoption children use a custom landing-gate script; the actual production-runner gate in that area is invoked synchronously. `verdict-check.test.js`'s relevant verifier check is `true`. The separately inspected resource-verification fixtures use an empty check or `printf`. Browser launches, long-lived servers, classifier source strings, CPU workers and process-custody descendants are not counted as asynchronous runner starts without an execution edge.

This inventory follows actual direct runner starts and the configured CLI/gate/shard/monitor edges in the current test source. It supersedes the item's old unsupported reference to exactly 18 files; it does not claim that arbitrary dynamically constructed JavaScript can be exhaustively classified by a text search. Item #1152 owns the named interactive gaps. No promise here guarantees that a caller violating the yielding contract remains idle.
