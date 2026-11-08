/** A submit proof's test files fanned out across free runner slots, merged back into one run and one receipt [C7]. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { machineHome } from '../../../resources/index.js';
import { DatabaseSync } from 'node:sqlite';

/** How long a shard waits for its own runner slot before it runs on the gate's first lease instead. */
export const SHARD_ADMIT_MS = 30_000;

/** Admission codes that mean a shard found no slot in time, so it runs on the gate's own lease after its shard. */
const NO_SLOT = new Set(['RUNNER_UNAVAILABLE', 'RUNNER_WAIT_DEADLINE', 'RUNNER_INFRA_RETRY_EXHAUSTED']);

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
 * The admission options for one shard beyond the gate's first: runner-only, no wait callback, and its own admission
 * deadline. Why its own deadline: the shard inherited the submit's captured runnerDeadlineAt (30 min on the MacBook),
 * so a shard with no slot waited out the whole submit budget instead of SHARD_ADMIT_MS, while the gate's own shards
 * held the browser slots it waited for (#3586, 7 Nov). Ending in RUNNER_WAIT_DEADLINE sends it to the gate's lane.
 *
 * @param {object} slotOptions - The gate's own withGateSlot options.
 * @param {{ now?: number, admitMs?: number }} [clock]
 * @returns {object}
 */
export function shardSlotOptions(slotOptions, { now = Date.now(), admitMs = SHARD_ADMIT_MS } = {}) {
  return { ...slotOptions, onWait: undefined, runnerOnly: true, runnerWaitMs: admitMs, runnerDeadlineAt: now + admitMs };
}

/**
 * Split the proof files across the gate's own slot plus the free ones with planFreeSlotShards, and run every shard at
 * once: the first on the gate's lease, each other in a slot of its own. A shard that gets no slot in time runs on the
 * gate's lease after the first, so a busy pool only slows the proof, never refuses it. One shard returns null and the
 * caller runs today's single command.
 *
 * Why: #3400's 114 files ran as one command on one slot for 2.1 h while 56 of 66 runner slots idled.
 *
 * @param {string[]} files
 * @param {{ freeSlots: number, times?: Record<string, number>, root?: string|null,
 *   runFirst: (files: string[]) => Promise<object>, runOther: (files: string[]) => Promise<object> }} options
 * @returns {Promise<{ files: string[], run: object }[] | null>} Each shard's files and run, in plan order.
 */
export async function runProofShards(files, { freeSlots, times = {}, root = null, runFirst, runOther }) {
  const { planFreeSlotShards } = await import('../../../landing/index.js');
  const { shards } = planFreeSlotShards(files, Math.max(0, freeSlots) + 1, times, root);
  if (shards.length < 2) return null;
  // The gate's own lease is one lane: its shard first, then any shard that found no slot, one after another.
  let lane = runFirst(shards[0].files);
  const runs = [lane.then(run => ({ files: shards[0].files, run })), ...shards.slice(1).map(shard => runOther(shard.files)
    .then(run => ({ files: shard.files, run }), error => {
      if (!NO_SLOT.has(error?.code)) throw error;
      lane = lane.catch(() => {}).then(() => runFirst(shard.files));
      return lane.then(run => ({ files: shard.files, run }));
    }))];
  // Drain every shard before refusing, so each slot's receipt and lease stay accurate.
  const outcomes = await Promise.allSettled(runs);
  const failure = outcomes.find(outcome => outcome.status === 'rejected');
  if (failure) throw failure.reason;
  return outcomes.map(outcome => outcome.value);
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
  const joined = key => runs.some(run => Array.isArray(run[key])) ? runs.flatMap(run => Array.isArray(run[key]) ? run[key] : []) : base[key];
  const merged = { ...base, isGreen: green, rawIsGreen: rawGreen, exitCode: green ? base.exitCode : red?.exitCode ?? 1,
    output: runs.map(run => String(run.output ?? '')).join('\n'), testRuntimes: joined('testRuntimes'),
    executionSourceUnchanged: sameSource && runs.every(run => run.executionSourceUnchanged !== false),
    ...(runs.some(run => run.timedOut) ? { timedOut: true } : {}),
    shards: shards.map(({ files, run }) => ({ files: [...files], exitCode: Number.isSafeInteger(run.exitCode) ? run.exitCode : null,
      runner: typeof run.executionRunner === 'string' && run.executionRunner ? run.executionRunner : null,
      durationMs: Math.max(0, Math.round(run.remoteWallMs ?? run.profile?.wallMs ?? (run.seconds ?? 0) * 1000)) })) };
  // The whole proof's wall time is the profiled interval around every shard, not the first shard's own.
  delete merged.remoteWallMs;
  delete merged.blockingVerdict;
  return merged;
}
