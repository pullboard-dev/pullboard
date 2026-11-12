# RFC 0008: Durable jobs and the runner protocol

- Status: proposed, 7 November 2026. The runner protocol stays open until a hosted runner users never have to set up is available (#3429); what makes that easy for them may change this design.
- Proposed: 7 November 2026, by Corey Olson, from the durable-gate design of 6 November and its two approved addenda (7 November: no process is load-bearing; hosted sandbox runners).
- Serves spec row P7 (draft). The receipt, its key and its reuse rule are RFC 0007's; this RFC produces receipts and never redefines them.
- Rule ids in brackets (DJ1…) are this RFC's design ids; on approval each becomes a row with a new id.

## Summary

Every activity that takes time is a **job**: a row on the board, an append-only log of idempotent steps, and a heartbeat lease. Any driver continues a job from its last written step; a lease silent for 2 minutes frees it. Inputs are named by commit and tree ids and rebuilt from the repository when missing, so nothing a sweep or a crash can delete is load-bearing.

Runners are reached through one channel interface with two adapters: SSH push for registered machines, and pull for hosted sandboxes behind NAT. A runner gets a tree bundle and the project's own test command, and returns a signed result file. The receipt cell judges those files.

## Motivation

Gates and landings are processes today, and their state lives in those processes and in folders beside them:
- **Ghost gates.** A gate whose controller died still shows as running; the board can't tell stalled from slow.
- **Orphaned work.** A dead controller loses the shards it started; a runner process kept for a dead gate holds a slot.
- **Sweeps break queued jobs.** Temp copies and tool trees are load-bearing, so cleaning them stops work in flight.
- **One process per gate per runner.** Six concurrent gates mean six controllers and six SSH sessions on the coordinator's machine.
- **Repeat events.** A retried merge or record step can write its event twice (#3350).
- **Runners must be reachable.** A hosted sandbox behind NAT can't take an inbound SSH connection, so it can't run a gate at all.

Each of these was patched one at a time (#3221, #3248, #3256, #3342, #3348, #2873, #2990). The rule below removes the class.

## Spec row

Drafted in `SPEC.md`, quoted exactly:

> P7 [draft, must] No process is load-bearing: every activity that takes time is a job with saved steps and a heartbeat lease that any driver resumes, and every derived result is keyed by content (a tree id, or a tree plus a command). Killing any process at any moment loses no work and never blocks the board. | gate: test/durable-chaos-26.test.js

## Constraints

RFC 0006's K1–K10 (CD1–CD10) and the liveness invariant hold. In addition:
- **Language-agnostic.** A runner runs the project's own test command. Nothing in the protocol assumes Node, this repository, macOS or one machine; the remote end is a POSIX shell and a tar.
- **The board is the only state.** A process may cache; it may never hold the only copy of a fact.
- **Results are facts.** A result a runner finished is kept and collected, whoever holds the lease by then.

## 1. Jobs

- [DJ1] A job is a row: id, kind, item, candidate, base, step, attempt, lease owner, lease until, created, updated. Kinds are gate, landing batch, dispatcher, and keyed derived results (§5).
- [DJ2] Steps are append-only rows: job, name, seq, payload, time, unique on (job, name, seq). The current step is the last one written.
- [DJ3] Writing a step that exists writes nothing and returns the stored payload, so a resumed driver may replay any step it already wrote. A second `merged`, `record` or `verdict` with the same key cannot double an event.
- [DJ4] A payload is small JSON that names inputs by id: commit and tree ids, runner, shard list, receipt id, result digest. A payload never holds a path to something a sweep may delete.
- [DJ5] Every step a driver takes is written before the next one starts.

**As built.** Item branch `core/item-3403` adds the `job` and `job_step` tables as an additive board upgrade (`packages/store/src/io/board/jobs.js`, created on the next owning open) and the `jobs` cell's `createJob`, `writeStep` and `jobView`. Creating an existing id returns it unchanged; `writeStep` is a no-op on a repeat. Not on main as of 4032b7655e.

## 2. The state machine

```
queued ──take──► captured ──send──► running(runner R, shard S…) ──collect──► collected ──judge──► verdict
   ▲                │                     │                          │                        │
   │                │ capture failed       │ runner lost / lease lapsed│ import invalid         │ red/green/infra
   └── requeue ◄────┴─────────────────────┴──────────────────────────┴──── (infra, retry n+1) ──┘
```

- [DJ6] queued → captured resolves candidate and base to tree ids and records the tooling pin (RFC 0007 SC8). Nothing is copied; a temp copy is a cache keyed by tree id, rebuilt when absent.
- [DJ7] captured → running sends the source as a bundle keyed by tree id and starts shards. Each shard start and each shard result is its own step. A resumed driver reruns only shards without a done step.
- [DJ8] running → collected when every shard has a done step. Result files are fetched by digest. An invalid file is `import.invalid` and resets its shard, bounded by attempt.
- [DJ9] collected → verdict is the receipt cell's judgement (RFC 0007 SC1–SC5); the verdict step stores the receipt id. Bookkeeping runs after and can never change it.
- [DJ10] An infrastructure outcome (runner lost, lease lapsed, import invalid, inventory warming) requeues with attempt + 1 and keeps every done shard. The fourth infrastructure stop ends the job as `infra-exhausted` with the last code. Only a red verdict returns the item to its builder.
- [DJ11] A landing batch is the same row kind with steps select → compose → prove (reuse a receipt, or run) → merge → record → publish. It is the one finish sequence that `pullboard land` and `pullboard merged` both call.

## 3. Leases

- [DJ12] A driver takes a job in one statement that succeeds only where the lease has lapsed, setting owner and lease-until to now + 2 minutes. Two drivers never both win.
- [DJ13] The holder renews every 5 seconds with one update and no history read. A driver whose lease moved learns so on its next renewal and stops.
- [DJ14] A job is reclaimable the moment its lease lapses, 2 minutes after its last renewal.
- [DJ15] The dispatcher reclaims first. As a fallback, any board command that sees a lapsed job (`next`, `status`, `show`) runs one reclaim pass and drives at most one job before answering. No command waits.
- [DJ16] The dispatcher is a job row with a lease. Ensuring it means taking its row if the lease lapsed and spawning the loop, so two never run and a wedged one is replaced within 2 minutes.
- [DJ17] `show` and `status` read the job view. A job whose lease lapsed shows as "stalled (reclaimable)" with its age, never as running.
- [DJ18] Review reservations are leases on the same rules.

**As built.** Item branch `core/item-3404` adds `takeJob`, `renewLease`, `reclaimLapsed` and `LEASE_MS = 120000`. `takeJob` frees a job 2 minutes after its last renewal, as DJ14 says, but `reclaimLapsed` lists a job only when its lease lapsed at least another 2 minutes ago, so a reclaim pass first finds a silent job 4 minutes after its last renewal. DJ14 asks that branch to list on `lease_until < now`.

## 4. Cells

| cell | holds | front door | replaces |
|---|---|---|---|
| `jobs` | rows, steps, leases, idempotent writes, reclaim | createJob, writeStep, jobView, takeJob, renewLease, reclaimLapsed | submit hand-off state, landing-batch events, the hand-off folder tree, worker and request files |
| `drive` | the driver loop; the dispatcher row | driveOnce(job), ensureDispatcher, drainLoop | the hand-off worker and its cap's drain, the landing worker, automatic landing |
| `transport` | the runner channel and its adapters; bundles sent by tree id; shards; result files; probe | connect(runner), sendTree, startShard, fetchResult, probe | runner dispatch and transport, the per-gate runner controller, the leak stop |
| `receipt` | pure judgement and the receipt (RFC 0007) | judge, verdictStep, settle, receiptKey, reusable | the run-receipt stage logic and the main-red comparison decision |
| `pin` | tree ids, bundles, the tooling pin, caches named by tree | treeOf, pinFor, bundleFor, cacheFor, sweepCaches, toolingPin | tool snapshots, inventory identity, main-red checkouts |
| `land` | select, compose, prove by reuse, merge, record, publish | landOnce, finishSequence, record | the landing steps, the merged move's own sequence, the hand loop |

- [DJ19] Edges run top-down only: `land` → `receipt`, `jobs`, `pin`; `drive` → `jobs`, `transport`, `receipt`, `pin`; `receipt` → `pin`; `transport` → `pin`; `jobs` → the kernel and the store only. No cell imports `drive` or `land`. The edge ratchet enforces the table.
- [DJ20] Existing cells shrink: `gate` keeps what runs (the test planner, shards, static checks) and loses state and dispatch; `resources` keeps runner registration and slot capacity as facts `transport` reads, and loses leases and quarantine; `landing` becomes `land` and loses its worker; submit's enqueue becomes a `jobs` call.

**As built on main.** `pin`: `treeOf`, `pinFor`, `bundleFor` (a plain tar keyed by tree id, written atomically, reused when present), `cachePath`, `cacheFor` (rebuilds a missing cache from its bundle) and `sweepCaches` (keeps the trees queued jobs name). `transport`: `createTransport`, `sharedTransport`, `connect` (one reused channel per runner host), `probe` (its own call, apart from the channel), with requests framed by nonce over a plain `sh`. `receipt`: `judge`, `verdictStep`, `settle`. On item branch `core/item-3407`: the per-landing tooling pin.

## 5. Derived results and enforcement

- [DJ21] Anything derived is a result keyed by content (a tree id, or a tree plus a command): computed once by a job, reused everywhere, rebuilt when missing. Nothing is "current state" owned by a running process.
- [DJ22] The cells inventory is a keyed job result; main-red status is a receipt lookup keyed by main's tree and the test file; flake diagnostics are a job that runs after the verdict (#3423, #3424, #3425).
- [DJ23] A static check refuses a new load-bearing process or state file outside `drive`, `transport`, `jobs` and `pin`, with a ceiling that only falls (#3427).
- [DJ24] A chaos test kills drivers and runner channels at random points mid-job and asserts every job finishes exactly once (#3428). It is P7's gate, `test/durable-chaos-26.test.js`.

## 6. The runner protocol

### 6.1 One channel, two adapters

- [DJ25] `transport`'s front door is one runner-channel interface: send a tree bundle, start a shard, fetch a result file, probe. Two adapters implement it: SSH push and pull.
- [DJ26] **SSH push**, for registered machines: one reused connection per runner, shared by every gate on it, running a plain POSIX shell. Work that runs in parallel starts detached and is read back from files. The coordinator holds one process per runner, never one per gate.
- [DJ27] **Pull**, for hosted sandboxes behind NAT: the runner asks the board for a job, fetches the tree bundle, runs the command and posts a signed result file. It opens every connection itself.
- [DJ28] Drivers and jobs see only the interface. A job never knows which adapter ran its shards.

### 6.2 What a runner gets and returns

- [DJ29] A runner gets the tree bundle (a plain tar keyed by tree id, skipped when the runner already holds it), the project's own test command read from the pinned trees, and a shard list. It needs no Node, no Pullboard checkout and no copy of this repository.
- [DJ30] A runner returns one result file per shard, named by job and shard: the exit status, per-test outcomes when the project's runner reports them (a standard report such as JUnit XML, or exit status alone), the command's digest and the tree id it ran.
- [DJ31] Every result file is signed with the runner's key. The receipt cell checks the signature before judging; a missing or bad signature is `import.invalid`, an infrastructure outcome, never red.
- [DJ32] A runner that finishes a shard after the job's lease moved writes its result file anyway; the new owner collects it. A runner sweep stops only processes whose job is in a terminal step.

### 6.3 Health and trust

- [DJ33] Runner health is a lease and a heartbeat. An SSH probe is one input to it; health never rests on the probe alone.
- [DJ34] A lost channel requeues the job's unfinished shards and keeps the runner registered. A runner is quarantined only after two failed probes 30 seconds apart.
- [DJ35] A sandboxed runner gets the bundle, the command and a short-lived token scoped to one job: fetch that bundle, heartbeat, post that job's results. It never gets board write access.
- [DJ36] The open core defines the interface, the protocol and both adapters. A hosted fleet (Pullboard Cloud) is one pull runner operator among any.

## Migration

No big bang; each step lands alone and keeps today's behaviour until its switch.

1. **Shadow row first.** The `jobs` cell with its tables, steps, leases and reclaim. Submit's hand-off writes a job row and a step for every state change beside today's records, with no other behaviour change. Then `show` and `status` read the shadow, so ghost gates show as "stalled (reclaimable)" (absorbs #3221, #3207).
2. **`pin`.** Tree-id bundles, the per-landing tooling pin, temp folders as caches named by tree (absorbs #3348, #3342, #3339's sweep).
3. **`transport`, before the cells freeze.** One connection per runner with result files; the per-gate controller process goes away; quarantine by probe only (absorbs #3256, #3248, #2535's runner half). It runs before the freeze so the frozen cell table already holds it.
4. **`drive`.** The dispatcher row and `driveOnce`; the hand-off worker becomes a child calling `driveOnce` until a terminal step; the fallback reclaim in `next` and `status` (absorbs #2990, #2873).
5. **`receipt`.** The pure judge (on main) gains the key and reuse rule of RFC 0007; review and landing read receipts by key.
6. **`land`.** The finish sequence as job steps; `merged` calls it; the hand loop retires (absorbs #3368, #3369, #3273 and the pending durable-landing design).
7. **Cut the old paths.** Hand-off folders, worker and request files, the old hand-off state and landing worker are removed; the edge ratchet holds the table.
8. **Enforce P7.** The derived-result jobs, the static ceiling and the chaos test (#3423–#3428).
9. **Pull adapter.** After `transport` and `drive` land (design item 27).

Boards upgrade in place: the job tables are additive and created on the next owning open, so older clients and the schema digest stay valid.

## Open questions

1. **P7's status (settled, 7 November 2026).** P7 is approved as `must` now, with the chaos test (#3428) as its gate: the cells architecture is settled and must be carried out coherently.
2. **Who may run a pull runner (settled for now, 7 November 2026).** Only runners whose keys the person has trusted on the board (RFC 0007 SC23). A job token alone never admits a runner. This may change as hosted runners become real, through an amendment.
3. **Infrastructure retry limit (settled).** A setting, with four as its default (DJ10), following the rule of one setting per behaviour with a safe default.
