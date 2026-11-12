/** A submit proof's test files pulled in small batches by every slot the gate gets, merged back into one run and one receipt [C7]. */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { statSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { machineHome } from '../../../../resources/index.js';
import { runShellAsync } from '../run/shell.js';
import { DatabaseSync } from 'node:sqlite';

/** How long a shard waits for its own runner slot before it runs on the gate's first lease instead. */
export const SHARD_ADMIT_MS = 30_000;

/**
 * The least time a shard's dispatch has from connecting until its worker says READY: the same budget a late admission
 * gets. Why: the lane's 30 s admission window became its startup budget, so at load a shard whose transfer took 31 s
 * (p50, 9 Nov) missed READY on a healthy runner, was killed and rerun after a 30 s backoff; every TRANSPORT_LOST retry
 * in the hour followed such a miss [C7].
 */
export const SHARD_STARTUP_MS = 90_000;

/**
 * A shard lane's startup budget: its lease's own, or SHARD_STARTUP_MS when that is shorter.
 *
 * @param {number|undefined} leaseStartupMs
 * @returns {number}
 */
export function shardStartupMs(leaseStartupMs) {
  return Math.max(Number.isSafeInteger(leaseStartupMs) ? leaseStartupMs : 0, SHARD_STARTUP_MS);
}

/** How long a recorded shard pass stays on disk; a rerun after an infrastructure end comes within minutes. */
export const SHARD_PASS_TTL_MS = 24 * 60 * 60_000;

/** A git tree id, the only key a shard pass is recorded under. */
const TREE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

/**
 * The shard passes recorded for one candidate tree and one test command, kept in the machine home. Each green shard
 * of a proof is recorded as it settles; a later run of the same tree reads them back. A tree that is not a git tree id
 * gets no store, so a run without a pinned source never reuses anything.
 *
 * Why: #3463 took 57 min to its verdict for about 15 min of real testing; a runner drop in attempt 2 threw away the
 * shards that had already passed for the same tree, and attempt 3 ran every one of them again (8 Nov) [C7].
 *
 * @param {string|null|undefined} tree - The candidate tree the shards run.
 * @param {string} command - The test command the shard files are appended to.
 * @param {{ folder?: string, now?: () => number, tooling?: string|null }} [options] - `tooling`: the runner tooling sha256 a reused pass must carry.
 * @returns {{ tree: string, file: string, tooling: string|null, read: () => object[], record: (pass: object) => void } | null}
 */
export function shardPassStore(tree, command, { folder = join(machineHome(), 'shard-passes'), now = Date.now, tooling = null } = {}) {
  if (typeof tree !== 'string' || !TREE.test(tree) || typeof command !== 'string') return null;
  const file = join(folder, `${createHash('sha256').update(JSON.stringify([tree, command])).digest('hex')}.json`);
  /** The passes on disk for exactly this tree and command; anything unreadable or foreign reads as none. */
  const read = () => {
    try {
      const doc = JSON.parse(readFileSync(file, 'utf8'));
      return doc?.tree === tree && doc.command === command && Array.isArray(doc.passes) ? doc.passes : [];
    } catch { return []; }
  };
  /** Append one pass with an atomic rename, then drop other trees' records past SHARD_PASS_TTL_MS. A failed write only loses reuse. */
  const record = pass => {
    try {
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${process.pid}.${now()}.tmp`;
      writeFileSync(temporary, JSON.stringify({ tree, command, passes: [...read(), pass] }), { mode: 0o600 });
      renameSync(temporary, file);
      for (const name of readdirSync(folder)) {
        const path = join(folder, name);
        if (path !== file && now() - statSync(path).mtimeMs > SHARD_PASS_TTL_MS) rmSync(path, { force: true });
      }
    } catch { /* A pass that cannot be recorded is only run again. */ }
  };
  return { tree, file, tooling, read, record };
}

/** The files of `files` that recorded green shards already cover on this store's tree. */
export function reusedShardFiles(passes, files) {
  return reusablePasses(passes, files, null).flatMap(shard => shard.files);
}

/**
 * The recorded green shards a run of `files` can take as its own: each wholly inside the selection, on the same tree,
 * and sharing no file with one taken before. Each reused run's outcome frames are rebound from its own timing run id to
 * this run's, so the merged proof accounts for its files under the one id the receipt reads; its results stay as run.
 *
 * @param {ReturnType<typeof shardPassStore>} passes
 * @param {string[]} files
 * @param {string|null} timingRunId - This proof's timing run id.
 * @returns {{ files: string[], run: object }[]}
 */
function reusablePasses(passes, files, timingRunId) {
  if (!passes) return [];
  const wanted = new Set(files);
  const taken = new Set();
  const reused = [];
  for (const pass of passes.read()) {
    const shardFiles = Array.isArray(pass?.files) ? pass.files : [];
    const run = pass?.run;
    if (!shardFiles.length || run?.isGreen !== true || shardFiles.some(file => !wanted.has(file) || taken.has(file))) continue;
    if (run.executionSource?.tree && run.executionSource.tree !== passes.tree || passes.tooling && run.executionSource?.tooling?.sha256 && run.executionSource.tooling.sha256 !== passes.tooling) continue;
    for (const file of shardFiles) taken.add(file);
    const rebind = typeof pass.timingRunId === 'string' && pass.timingRunId && timingRunId && pass.timingRunId !== timingRunId;
    reused.push({ files: [...shardFiles], run: rebind ? { ...run, output: String(run.output ?? '').replaceAll(pass.timingRunId, timingRunId) } : run });
  }
  return reused;
}

/** Proof files per queued batch when a caller asks for fixed-size batches (`batchFiles`); the gate splits by lane. */
export const PROOF_BATCH_FILES = 3;

/** How long a slot request that found no slot, or whose runner dropped, pauses before it asks again. */
export const SHARD_RETRY_MS = 5_000;

/**
 * How many times one batch may go back on the queue after a runner drop before the next drop refuses the proof.
 * Why a bound: a batch that takes down every runner it lands on must end the gate on infrastructure, where the whole
 * gate rerun keeps every passed batch (#3699), rather than circle the queue forever.
 */
export const BATCH_DROP_LIMIT = 2;

/**
 * Codes that mean a slot request found no runner slot in time, or that a batch's runner dropped under it: the batch
 * goes back on the queue and the request asks again while batches remain. Any other refusal is the proof's own.
 */
const NO_SLOT = new Set(['RUNNER_UNAVAILABLE', 'RUNNER_WAIT_DEADLINE', 'RUNNER_INFRA_RETRY_EXHAUSTED', 'RUNNER_JOB_LOST',
  'RUNNER_SETUP', 'RUNNER_CLEANUP_TIMEOUT']);

/** Whether an error means no slot or a dropped runner rather than a refusal of the proof itself. */
const slotLost = error => NO_SLOT.has(error?.code) || error?.name === 'RunnerDropped';

/** The refusal a queued slot request ends with once every batch has run, so it never holds a slot it no longer needs. */
const QUEUE_DRAINED = 'PROOF_QUEUE_DRAINED';

/**
 * Count the runner slots free on this machine's pool right now: every runner's capacity, less the slots held and
 * the gates already waiting. Why waiters count: a free slot an earlier gate is about to take is not this gate's.
 * A browser gate counts only slots whose runner also has a free browser slot, and only browser waiters: #3586's gate
 * planned its shards from 66 free gate slots, took every browser slot itself, and its later shards then waited on
 * the browser leases its own earlier shards held (7 Nov) [C7]. Any unreadable pool counts as none, so the proof
 * runs as one command as before.
 *
 * @param {string} [file] - The machine resource pool.
 * @param {{ browser?: boolean, gui?: boolean, runners?: Array<{host:string,slots:number,browser:number,gui?:boolean}>|null }} [needs]
 *   - What each shard asks for and the registered runners; a browser gate without its runner list counts no free slot.
 * @returns {number}
 */
export function freeRunnerSlots(file = join(machineHome(), 'resources.sqlite'), { browser = false, gui = false, runners = null } = {}) {
  if (!existsSync(file)) return 0;
  if (browser && !Array.isArray(runners)) return 0;
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 10000');
    if (browser) return freeBrowserSlots(db, runners, gui);
    const capacity = db.prepare("SELECT COALESCE(SUM(capacity), 0) AS n FROM resource WHERE name GLOB 'runner:*'").get().n;
    const held = db.prepare("SELECT COUNT(*) AS n FROM holder WHERE name GLOB 'runner:*'").get().n;
    const waiting = db.prepare("SELECT COUNT(*) AS n FROM waiter WHERE name = 'gate' OR name GLOB 'runner:*'").get().n;
    return Math.max(0, Number(capacity) - Number(held) - Number(waiting));
  } catch { return 0; } finally { db?.close(); }
}

/**
 * Sum, over runners that can take a browser shard, the slots free for both the gate and its browser, less the browser
 * gates already waiting. Why the smaller of the two: a runner with gate slots free but every browser slot held
 * cannot start a browser shard, so counting it plans a shard that only waits.
 */
function freeBrowserSlots(db, runners, gui) {
  let free = 0;
  for (const runner of runners) {
    if (!(runner.browser >= 1) || gui && runner.gui === false) continue;
    const held = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(browser = 1), 0) AS browsers FROM holder WHERE name = ?').get(`runner:${runner.host}`);
    free += Math.max(0, Math.min(runner.slots - Number(held.n), runner.browser - Number(held.browsers)));
  }
  const waiting = db.prepare("SELECT COUNT(*) AS n FROM waiter WHERE name = 'gate' AND browser = 1").get().n;
  return Math.max(0, free - Number(waiting));
}

/**
 * The admission options for one more runner slot for the proof queue: runner-only, its own admission deadline, and a
 * wait callback only to end the request once the queue has closed. Why its own deadline: the shard inherited the
 * submit's captured runnerDeadlineAt (30 min on the laptop), so a shard with no slot waited out the whole submit budget
 * instead of SHARD_ADMIT_MS, while the gate's own shards held the browser slots it waited for (#3586, 7 Nov). Ending in
 * RUNNER_WAIT_DEADLINE only sends the request round to ask again; its batches stay on the queue for any lane.
 *
 * @param {object} slotOptions - The gate's own withGateSlot options.
 * @param {{ now?: number, admitMs?: number, closed?: (() => boolean) | null }} [clock] - `closed` says every batch has run.
 * @returns {object}
 */
export function shardSlotOptions(slotOptions, { now = Date.now(), admitMs = SHARD_ADMIT_MS, closed = null } = {}) {
  const onWait = closed ? state => {
    if (!state?.admitted && closed()) throw Object.assign(new Error('every proof batch has run; this slot request is no longer needed'), { code: QUEUE_DRAINED });
  } : undefined;
  return { ...slotOptions, onWait, runnerOnly: true, runnerWaitMs: admitMs, runnerDeadlineAt: now + admitMs };
}

/**
 * The least recorded runtime one shard should carry before the proof splits further. Why: every shard pays one runner
 * dispatch, about 4 s of transfer and 3.5 s to READY on a warm runner, so a shard shorter than two dispatches of work
 * spends more on its own dispatch than it saves the proof by running beside the others.
 */
export const PROOF_MIN_SHARD_MS = 15_000;

/**
 * How many shards a proof's files split into. An explicit `batchFiles` cuts batches of about that many files. Without
 * one, the files split into one shard per lane the gate may run (`lanes`, at most PROOF_MAX_SHARDS), and fewer when the
 * recorded runtime (`expectedMs`) would leave a shard under PROOF_MIN_SHARD_MS. Each lane then pays one transfer and one
 * READY for its whole share; the runner runs that shard's files side by side on its own slots.
 *
 * Why: one shard per free slot cut #3883's proof into 23 batches of one to three files, and its 3 lanes paid a dispatch
 * for each: 258 s of transfer and 99 s of READY summed for 146 s of tests (9 Nov). Before that, 6 files cut into
 * batches of 3 ran 2 batches one after the other on the gate's lane while runner slots idled (8 Nov) [C7].
 *
 * @param {number} fileCount
 * @param {{ lanes?: number, batchFiles?: number|null, expectedMs?: number|null }} [options]
 * @returns {number}
 */
export function proofShardCount(fileCount, { lanes = PROOF_MAX_SHARDS, batchFiles = null, expectedMs = null } = {}) {
  if (fileCount < 1) return 0;
  if (batchFiles != null) return Math.ceil(fileCount / Math.max(1, Math.floor(batchFiles) || 1));
  const cap = Math.max(1, Math.min(PROOF_MAX_SHARDS, Number.isFinite(lanes) ? Math.floor(lanes) : 1));
  const byRuntime = Number.isFinite(expectedMs) && expectedMs >= 0 ? Math.max(1, Math.floor(expectedMs / PROOF_MIN_SHARD_MS)) : cap;
  return Math.min(fileCount, cap, byRuntime);
}

/**
 * The most lanes one gate runs at once, its own lane included; the other shards wait on the queue for a free lane.
 * Why: each running shard is its own runner-controller process on the coordinator. One lane per free slot let a single
 * gate start 13 controllers; at load 59 the confirming probes took 100–200 s and marked every idle runner unresponsive,
 * stopping all gates (8 Nov). A shard per lane is safe for the 1 MiB runner request: the spec names the runtime by
 * digest (#3884), and its only per-file parts are the command line, one input key per file and the optional cached
 * results packet, which requestFor drops before it would pass the limit [C7].
 */
export const PROOF_MAX_SHARDS = 3;

/**
 * The recorded runtime of a proof's files, a new file at the average known time; null when no file has a record.
 *
 * @param {string[]} files
 * @param {Record<string, number>} times
 * @param {string|null} root
 * @param {(file: string, root: string|null) => string} key
 * @returns {number|null}
 */
function expectedRuntime(files, times, root, key) {
  const known = files.map(file => times[key(file, root)]).filter(ms => Number.isFinite(ms) && ms >= 0);
  if (!known.length) return null;
  const sum = known.reduce((total, ms) => total + ms, 0);
  return sum + (files.length - known.length) * (sum / known.length);
}

/**
 * Split proof files into the queue's shards (proofShardCount), balanced by recorded file times through the gate shard
 * planner and heaviest first, so the longest shards start soonest and no lane is left with a long tail.
 *
 * @param {string[]} files
 * @param {Record<string, number>} [times]
 * @param {string|null} [root]
 * @param {number|null} [batchFiles] - Files per batch; null splits one shard per lane.
 * @param {number} [lanes] - The lanes the gate may run; one (no runner slots to take) gives one shard.
 * @returns {Promise<string[][]>}
 */
export async function proofBatches(files, times = {}, root = null, batchFiles = null, lanes = PROOF_MAX_SHARDS) {
  const { planFreeSlotShards, fileKey } = await import('../test/shards.js');
  const count = proofShardCount(files.length, { lanes, batchFiles, expectedMs: expectedRuntime(files, times, root, fileKey) });
  const { shards } = planFreeSlotShards(files, count, times, root);
  return shards.sort((a, b) => b.weight - a.weight).map(shard => shard.files);
}

/** Wait between slot requests. */
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Run the proof files from a queue of batches, one per lane the gate may run (proofShardCount). The gate's own lease is one lane; while batches remain the gate
 * keeps asking for more runner slots with `takeSlot`, and each slot it gets is one more lane. Every lane pulls the
 * next batch as soon as it is free, so no batch waits behind another while a slot is free, and a slot the pool frees
 * mid-proof joins at once. A batch whose runner drops, on a slot or on the gate's own lease, goes back on the queue for
 * any lane, up to BATCH_DROP_LIMIT times. After a drop of its own the gate's lane leaves the queue to the slot lanes it
 * still has and asks for another slot; it pulls again only when no slot lane runs, so the proof keeps going on any lane
 * the gate has or gets. The gate's own lane stays until the queue is empty, so a busy pool only slows the proof. With no `takeSlot` (no runners),
 * the one lane pulls every batch at once and runs them as one command, as a local gate always has. A single batch with
 * nothing reused returns null, and the caller runs today's single command.
 *
 * Why: 15 gates each held exactly one runner slot while 93 of 120 slots idled, and #3660 ran its tests on one slot for
 * 45+ min: the shards were planned once from the free slots at gate start, and a shard that found no slot within
 * SHARD_ADMIT_MS ran serially on the gate's first lease even after the pool freed (8 Nov). #3400's 114 files ran on one
 * slot for 2.1 h while 56 of 66 slots idled [C7].
 *
 * Given `passes` (shardPassStore for the candidate tree), every green batch is recorded as it settles, before any
 * refusal is thrown, and a run of the same tree queues only the files no recorded pass covers; the reused shards
 * follow the fresh ones unchanged. So a rerun after an infrastructure end (a runner drop, a lost job, a stall) runs
 * only what the drop cost, not the whole proof again (#3463, 8 Nov) [C7].
 *
 * @param {string[]} files
 * @param {{ freeSlots?: number, times?: Record<string, number>, root?: string|null,
 *   runFirst: (files: string[]) => Promise<object>,
 *   takeSlot?: ((lane: (run: (files: string[]) => Promise<object>) => Promise<void>, queue: { closed: () => boolean }) => Promise<unknown>) | null,
 *   passes?: ReturnType<typeof shardPassStore>, timingRunId?: string|null, say?: (line: string) => void,
 *   retryMs?: number, batchFiles?: number|null, gateLaneFree?: Promise<unknown>|null }} options - `freeSlots` is how many slot requests open at once; with no
 *   `batchFiles` the files split one shard per lane, so each lane pays one dispatch; `takeSlot` takes one runner slot, calls `lane` with that
 *   slot's run and releases the slot when `lane` settles; `gateLaneFree` settles when the gate's own lease may run a
 *   batch (it may still run the item check), while slot requests open at once.
 * @returns {Promise<{ files: string[], run: object }[] | null>} Each batch's files and run in queue order, then reused.
 */
export async function runProofShards(files, { freeSlots = 0, times = {}, root = null, runFirst, takeSlot = null, passes = null,
  timingRunId = null, say = () => {}, retryMs = SHARD_RETRY_MS, batchFiles = null, gateLaneFree = null }) {
  const reused = reusablePasses(passes, files, timingRunId);
  const covered = new Set(reused.flatMap(shard => shard.files));
  const owed = files.filter(file => !covered.has(file));
  if (reused.length) say(`proof reuses ${covered.size} of ${files.length} files that passed for tree ${passes.tree.slice(0, 12)}; running ${owed.length}`);
  if (!owed.length) return reused;
  const queue = (await proofBatches(owed, times, root, batchFiles, takeSlot ? PROOF_MAX_SHARDS : 1)).map((batch, index) => ({ index, files: batch }));
  if (queue.length < 2 && !reused.length) return null;
  const batches = queue.length;
  const settled = [];
  let inflight = 0, failure = null, pending = 0, slots = 0, mostSlots = 0, requests = 0;
  let wake = () => {};
  let changed = new Promise(resolve => { wake = resolve; });
  /** Wake every lane waiting on the queue: a batch settled or went back on it. */
  const notify = () => { const resolve = wake; changed = new Promise(next => { wake = next; }); resolve(); };
  /** The queue closes when the proof has failed, or when every batch has run and none is running. */
  const closed = () => failure !== null || !queue.length && !inflight;
  /**
   * Run pulled batches on one lane in the original file order. A green run is recorded for a later run of the same tree
   * as soon as it settles. A runner drop on a lane that may requeue puts the batches back first in the queue, unless one
   * has already gone back BATCH_DROP_LIMIT times, and returns the drop; any other failure refuses the proof.
   */
  const run = async (lane, pulled, requeue) => {
    const wanted = new Set(pulled.flatMap(batch => batch.files));
    const batchFiles = owed.filter(file => wanted.has(file));
    inflight += 1;
    try {
      const result = await lane(batchFiles);
      if (passes && result?.isGreen === true) passes.record({ files: [...batchFiles], run: result, timingRunId, at: new Date().toISOString() });
      settled.push({ index: pulled[0].index, files: batchFiles, run: result });
      return null;
    } catch (error) {
      if (requeue && slotLost(error) && pulled.every(batch => (batch.drops ?? 0) < BATCH_DROP_LIMIT)) {
        for (const batch of pulled) batch.drops = (batch.drops ?? 0) + 1;
        queue.unshift(...pulled);
        return error;
      }
      failure ??= error;
      return null;
    } finally { inflight -= 1; notify(); }
  };
  let gateDropped = false;
  /**
   * The gate's own lease: pulls until the queue closes, waiting while other lanes still run batches that may come back.
   * After its own runner dropped a batch, it leaves the queue to any slot lane still running and pulls again only when
   * none runs, once something has changed: a batch settled or came back, or a slot request ended without a slot.
   */
  const gateLane = async () => {
    let rest = false;
    // The gate's own lease may still run the item check; its lane joins once that is done, while slot lanes start now.
    if (gateLaneFree) await gateLaneFree;
    while (!closed()) {
      if (!queue.length || rest || gateDropped && slots > 0) { rest = false; await changed; continue; }
      const dropped = await run(runFirst, queue.splice(0, takeSlot ? 1 : queue.length), Boolean(takeSlot));
      if (dropped) {
        gateDropped = true;
        rest = true;
        say(`proof batch returned to the queue: the gate's own runner dropped it (${dropped.code ?? dropped.name})`);
        grow();
      }
    }
  };
  /** One more slot's lane: pulls the next batch until the queue is empty; a dropped runner ends the lane. */
  const slotLane = async lane => {
    slots += 1;
    mostSlots = Math.max(mostSlots, slots);
    try {
      while (!closed() && queue.length) {
        const dropped = await run(lane, queue.splice(0, 1), true);
        if (dropped) throw dropped;
      }
    } finally { slots -= 1; notify(); }
  };
  /** Ask for one more slot until a lane on it ends with the queue empty; no slot or a dropped runner asks again. */
  const request = async () => {
    requests += 1;
    pending += 1;
    let waiting = true;
    /** Count the request admitted once, and open another while batches outnumber the requests still waiting. */
    const admitted = () => {
      if (!waiting) return;
      waiting = false;
      pending -= 1;
      grow();
    };
    try {
      while (!closed() && queue.length) {
        // The new lane takes its first batch before another request opens, so requests never outnumber the batches left.
        try { await takeSlot(lane => { const work = slotLane(lane); admitted(); return work; }, { closed }); }
        catch (error) {
          if (closed()) return;
          // Wake the gate's lane: after a drop of its own it pulls again when no slot lane runs.
          notify();
          if (!slotLost(error)) {
            say(`a proof slot request stopped (${error?.code ?? error?.message}); its batches stay on the queue`);
            return;
          }
        }
        if (!waiting) { waiting = true; pending += 1; }
        if (!closed() && queue.length) await pause(retryMs);
      }
    } finally { if (waiting) pending -= 1; requests -= 1; }
  };
  /**
   * Open one more slot request while batches outnumber the requests already waiting and the gate's lanes are under
   * PROOF_MAX_SHARDS. A request is a lane for its whole life: its slot pulls batch after batch, and a dropped slot asks
   * again inside the same request, so a lane never needs reopening from a lane's own end.
   */
  function grow() {
    if (takeSlot && !closed() && queue.length > pending && requests < PROOF_MAX_SHARDS - 1) request().catch(error => { failure ??= error; notify(); });
  }
  const gate = gateLane();
  const opening = Number.isFinite(freeSlots) ? Math.max(1, Math.min(PROOF_MAX_SHARDS - 1, Math.floor(freeSlots))) : 1;
  for (let count = 0; count < opening; count += 1) grow();
  await gate;
  // Drain every running batch before refusing, so each slot's receipt and lease stay accurate.
  while (inflight) await changed;
  if (failure) throw failure;
  if (takeSlot) say(`proof ran ${batches} batches on the gate's lane and up to ${mostSlots} more runner slots`);
  return [...settled.sort((a, b) => a.index - b.index).map(({ files: batchFiles, run: result }) => ({ files: batchFiles, run: result })), ...reused];
}

/**
 * Run a proof's files from the batch queue and merge them into the one run the receipt records, or as today's one
 * command when the files make a single batch and nothing was reused. The gate's own lease (`execution`) is the first
 * lane: on a runner, `takeSlot` adds a lane per runner slot it gets; with no runner lease (no runners registered),
 * the one local lane pulls every batch through the same queue as one command. The shard passes are kept per
 * candidate tree, the source the gate's lease sent, so a rerun of the same tree after an infrastructure end runs only
 * the batches with no pass (#3699).
 *
 * @param {string} root
 * @param {{ gateLease: { runner?: object, executionServices: { runners: { runOnRunnerAsync: Function } } }, remoteCommand?: string,
 *   remoteOptions?: { source?: { tree?: string }, metadata: { timingRunId?: string } }, localOptions?: object }} execution - The proof's profiled execution.
 * @param {{ files: string[], filesCommand: (files: string[]) => string, takeSlot?: Parameters<typeof runProofShards>[1]['takeSlot'],
 *   freeSlots?: number, times?: Record<string, number>, passes?: ReturnType<typeof shardPassStore>, say?: (line: string) => void,
 *   retryMs?: number, batchFiles?: number, gateLaneFree?: Promise<unknown>|null }} options - `gateLaneFree` holds runs on the gate's own lease.
 * @returns {Promise<object>} The one run the proof receipt records.
 */
export async function proveBatches(root, execution, { files, filesCommand, takeSlot = null, freeSlots = 0, times = {}, say, retryMs, batchFiles,
  passes = shardPassStore(execution.remoteOptions?.source?.tree, filesCommand([])), gateLaneFree = null }) {
  const onRunner = Boolean(execution.gateLease?.runner);
  const runners = execution.gateLease?.executionServices?.runners;
  const runFirst = onRunner
    ? batch => runners.runOnRunnerAsync(root, filesCommand(batch), execution.remoteOptions)
    : batch => runShellAsync(root, filesCommand(batch), execution.localOptions);
  const shards = await runProofShards(files, { freeSlots, times, root, runFirst, takeSlot: onRunner ? takeSlot : null, passes,
    timingRunId: execution.remoteOptions?.metadata?.timingRunId ?? null, say, retryMs, batchFiles, gateLaneFree });
  if (!shards && gateLaneFree) await gateLaneFree;
  if (!shards) return onRunner ? runners.runOnRunnerAsync(root, execution.remoteCommand, execution.remoteOptions) : runFirst(files);
  // The one local lane's single run is today's command over every file; it is the run, not a merge of one.
  return shards.length === 1 && shards[0].files.length === files.length ? shards[0].run : mergeShardRuns(shards);
}

/**
 * The files a red shard failed on, in the proof's own file order: those the shard's output names, or every file of a red
 * shard whose output names none, so a red run never reads without a file and a green shard names nothing.
 * Why: the receipt merge keeps one output and one exit, and the person fixing a red needs the file, not the shard [C7].
 *
 * @param {{ files: string[], run: object }[]} shards
 * @returns {string[]} The failing files, each once, in the order the shards list their files.
 */
export function failingShardFiles(shards) {
  const failing = new Set();
  for (const { files, run } of shards) {
    if (run.isGreen === true) continue;
    const output = String(run.output ?? '');
    const named = files.filter(file => output.includes(file.replace(/^\.\//u, '')));
    for (const file of named.length ? named : files) failing.add(file);
  }
  return [...failing];
}

/**
 * The shards' test-child rows as one list with each PID once: a PID two shards both report is dropped from every
 * shard, and no row left reads as unknown (null). Why: shards run on different runners (or one runner after its PIDs
 * wrap), so a PID names a child only within its own shard; the receipt keys rows by PID, and one collision made it
 * refuse the whole native receipt, so the gate refused PROOF_RUN_UNAVAILABLE for a check that ran [P7,#5763].
 * @param {object[]} runs
 * @returns {object[] | null | undefined}
 */
function shardTestRuntimes(runs) {
  if (!runs.some(run => Array.isArray(run.testRuntimes))) return runs[0]?.testRuntimes;
  const shardsByPid = new Map();
  runs.forEach((run, index) => {
    for (const row of Array.isArray(run.testRuntimes) ? run.testRuntimes : []) {
      shardsByPid.set(row?.pid, (shardsByPid.get(row?.pid) ?? new Set()).add(index));
    }
  });
  const rows = runs.flatMap(run => Array.isArray(run.testRuntimes) ? run.testRuntimes : []).filter(row => shardsByPid.get(row?.pid).size === 1);
  return rows.length ? rows : null;
}

/**
 * Merge shard runs into the one run the proof receipt records: one output, green only when every shard is, the first
 * red exit, the first shard's stage accounting (the others' are already profiled in their own slots), and each shard's files, exit, runner and duration kept in `shards`. Execution facts come from the first
 * shard; any shard whose source differs marks the whole run's source as changed, so the receipt is never clean on it.
 *
 * @param {{ files: string[], run: object }[]} shards
 * @returns {object}
 */
export function mergeShardRuns(shards) {
  const runs = shards.map(shard => shard.run);
  const [base] = runs;
  const green = runs.every(run => run.isGreen === true);
  const rawGreen = runs.every(run => (run.rawIsGreen ?? run.isGreen) === true);
  const red = runs.find(run => run.exitCode !== 0 && run.exitCode !== undefined);
  const source = run => run.executionSource && `${run.executionSource.commit}:${run.executionSource.tree}`;
  const sameSource = runs.every(run => source(run) === source(base));
  const merged = { ...base, isGreen: green, rawIsGreen: rawGreen, exitCode: green ? base.exitCode : red?.exitCode ?? 1,
    output: runs.map(run => String(run.output ?? '')).join('\n'), testRuntimes: shardTestRuntimes(runs),
    executionSourceUnchanged: sameSource && runs.every(run => run.executionSourceUnchanged !== false),
    ...(runs.some(run => run.timedOut) ? { timedOut: true } : {}),
    failingFiles: failingShardFiles(shards),
    shards: shards.map(({ files, run }) => ({ files: [...files], exitCode: Number.isSafeInteger(run.exitCode) ? run.exitCode : null,
      runner: typeof run.executionRunner === 'string' && run.executionRunner ? run.executionRunner : null,
      durationMs: Math.max(0, Math.round(run.remoteWallMs ?? run.profile?.wallMs ?? (run.seconds ?? 0) * 1000)) })) };
  // The whole proof's wall time is the profiled interval around every shard, not the first shard's own.
  delete merged.remoteWallMs;
  delete merged.blockingVerdict;
  return merged;
}
