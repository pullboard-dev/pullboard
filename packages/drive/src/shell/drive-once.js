/** driveOnce: continue one gate job from its last written step by exactly one transition [C7]. */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Refused } from '../../../kernel/index.js';
import { jobView } from '../../../jobs/index.js';
import { releaseLease } from '../../../jobs/index.js';
import { renewLease } from '../../../jobs/index.js';
import { takeJob } from '../../../jobs/index.js';
import { writeStep } from '../../../jobs/index.js';
import { bundleFor } from '../../../pin/index.js';
import { listTreeObjects } from '../../../pin/index.js';
import { packObjects } from '../../../pin/index.js';
import { toolingFor } from '../../../pin/index.js';
import { treeOf } from '../../../pin/index.js';
import { receiptKey } from '../../../receipt/index.js';
import { settle } from '../../../receipt/index.js';
import { ensureSource } from '../../../transport/index.js';
import { ensureTooling } from '../../../transport/index.js';
import { fetchResult } from '../../../transport/index.js';
import { sharedTransport } from '../../../transport/index.js';
import { startShard } from '../../../transport/index.js';
import { doneShards } from '../core/drive-phase.js';
import { gateSections } from '../core/drive-phase.js';
import { owedShards } from '../core/drive-phase.js';
import { phaseOf } from '../core/drive-phase.js';
import { shardSections } from '../core/drive-phase.js';
import { stepPayload } from '../core/drive-phase.js';
import { queueFlakeDiagnoses } from './flake-diagnose.js';

/** Where tooling tar bundles are written before they are sent; keyed by tree id, so every gate reuses one. */
const BUNDLE_FOLDER = join(tmpdir(), 'pullboard-tooling-bundles');

/** How often a driver renews its lease while a whole gate runs in-process; the lease lapses after 2 minutes. */
const GATE_RENEW_MS = 5_000;

/**
 * Hold the job's lease for this driver: renew it when the driver already holds it, else take it if it lapsed.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ id: string, leaseOwner: string | null }} view
 * @param {string} owner
 * @param {number} now
 * @returns {boolean} True when this driver holds a live lease on the job.
 */
function holdLease(db, view, owner, now) {
  if (view.leaseOwner === owner && renewLease(db, view.id, owner, { now })) return true;
  return takeJob(db, view.id, owner, { now }).taken;
}

/**
 * queued → captured: resolve the candidate and base to tree ids and record the tooling pin.
 *
 * Why: the tooling comes from packages/pin's toolingFor(repo, seatCommit), the tree of the last landing when one
 * is pinned, never from whichever seat checkout runs the driver, so a seat on an older tree runs main's tooling.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {ReturnType<typeof jobView>} view
 * @param {string} repo
 * @param {number} now
 */
function capture(db, view, repo, now) {
  if (!repo) throw new Refused('DRIVE_REPO', 'driveOnce needs the repository to capture a job: pass { repo }.');
  if (!view.candidate) throw new Refused('DRIVE_CANDIDATE', `Job ${view.id} names no candidate commit: create it with { candidate }.`);
  const pin = toolingFor(repo, view.candidate);
  const base = view.base ? treeOf(repo, view.base) : null;
  writeStep(db, view.id, 'captured', { tree: pin.tree, tooling: pin.tooling, pinned: pin.pinned, base }, { now });
}

/**
 * Start every planned shard that has no done step, writing a `shard.started` step for each. Starting is idempotent
 * on the runner, so a resumed driver may call it for a shard it already started.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {ReturnType<typeof jobView>} view
 * @param {object} channel
 * @param {string} owner
 * @param {number} now
 */
async function startOwed(db, view, channel, owner, now) {
  const { runner } = stepPayload(view, 'running');
  for (const shard of owedShards(view)) {
    await startShard(channel, { job: view.id, shard: shard.shard, command: shard.command, owner });
    writeStep(db, view.id, 'shard.started', { shard: shard.shard, runner: runner.host }, { seq: shard.seq, now });
  }
}

/**
 * captured → running: write the shard plan and the runner, then start the shards. A whole-gate job (`gate`) writes
 * a running step with no shards, since its gate runs in-process at the next transition.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {ReturnType<typeof jobView>} view
 * Why: before the shards start, the runner is asked for the captured tooling pin's tree. A runner that holds it is
 * sent zero tooling bytes and the shard commands read the pinned copy at `captured.toolingPath`; only a runner
 * without it is sent the bundle once. The outcome is written into the running step as `tooling` [C7].
 * Then the candidate's source is sent by tree id (ensureSource): the runner reports which of the tree's objects its
 * own store lacks, only those are sent, and the shard commands read the folder it materialised at
 * `captured.sourcePath`. The outcome is written into the running step as `source` [C7].
 *
 * @param {{ runner?: { host: string, root?: string }, plan?: object[] | ((captured: object) => object[]), transport: object, owner: string, now: number, gate?: Function, repo?: string, tooling?: boolean, source?: boolean, bundles?: string }} options
 */
async function send(db, view, { runner, plan, transport, owner, now, gate, repo, tooling = true, source = true, bundles = BUNDLE_FOLDER }) {
  if (gate) {
    writeStep(db, view.id, 'running', { gate: true, shards: [] }, { now });
    return;
  }
  if (typeof runner?.host !== 'string') throw new Refused('DRIVE_RUNNER', 'driveOnce needs a runner to send a job to: pass { runner: { host } }.');
  const where = runner.root === undefined ? { host: runner.host } : { host: runner.host, root: runner.root };
  const captured = stepPayload(view, 'captured');
  let pinned;
  if (repo && tooling !== false && captured.tooling) {
    pinned = await ensureTooling(transport.connect(where), { tree: captured.tooling, bundle: bundleFor(repo, captured.tooling, bundles).path });
  }
  let sourced;
  if (repo && source !== false && captured.tree) sourced = await ensureSource(transport.connect(where), { tree: captured.tree, objects: () => listTreeObjects(repo, captured.tree), pack: ids => packObjects(repo, ids) });
  const planned = { ...captured, ...(pinned ? { toolingPath: pinned.path } : {}), ...(sourced ? { sourcePath: sourced.path } : {}) };
  const shards = typeof plan === 'function' ? plan(planned) : plan;
  if (!Array.isArray(shards) || !shards.length || shards.some(s => typeof s?.shard !== 'string' || typeof s?.command !== 'string')) {
    throw new Refused('DRIVE_PLAN', 'driveOnce needs a shard plan to send: pass { plan: [{ shard, command }] } with the project\'s own test command.');
  }
  const step = { runner: where, shards: shards.map(({ shard, command }) => ({ shard, command })) };
  if (pinned) step.tooling = { tree: pinned.tree, path: pinned.path, held: pinned.held, bytesSent: pinned.bytesSent };
  if (sourced) step.source = { tree: sourced.tree, path: sourced.path, held: sourced.held, total: sourced.total, sent: sourced.sent, reused: sourced.reused, bytesSent: sourced.bytesSent };
  writeStep(db, view.id, 'running', step, { now });
  await startOwed(db, jobView(db, view.id), transport.connect(where), owner, now);
}

/**
 * running → collected: read each shard that has no done step, record what finished, restart what was invalid or
 * lost, and write `collected` once every shard is done. Shards with a done step are never started or read again.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {ReturnType<typeof jobView>} view
 * @param {{ transport: object, owner: string, now: number }} options
 * @returns {Promise<number>} How many shards are still owed.
 */
async function collect(db, view, { transport, owner, now }) {
  const channel = transport.connect(stepPayload(view, 'running').runner);
  let invalid = view.steps.filter(step => step.name === 'shard.invalid').length;
  for (const shard of owedShards(view)) {
    const result = await fetchResult(channel, { job: view.id, shard: shard.shard });
    if (result.state === 'done') {
      writeStep(db, view.id, 'shard.done', { shard: shard.shard, status: result.status, digest: result.digest }, { seq: shard.seq, now });
    } else if (result.state === 'import.invalid') {
      writeStep(db, view.id, 'shard.invalid', { shard: shard.shard, reason: result.reason, digest: result.digest ?? null }, { seq: invalid, now });
      invalid += 1;
    }
  }
  const after = jobView(db, view.id);
  const owed = owedShards(after);
  if (owed.length) {
    await startOwed(db, after, channel, owner, now);
    return owed.length;
  }
  const shards = Object.fromEntries([...doneShards(after)].map(([id, done]) => [id, { status: done.status, digest: done.digest }]));
  writeStep(db, view.id, 'collected', { shards }, { now });
  return 0;
}

/**
 * Wrap a gate's stages so each records a `section.done` step with its outcome as it settles, keeping the stages'
 * own functions, order and values. A stage stopped by another stage's red is recorded as skipped, never failed.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} job
 * @param {{ order: string[], sections: Record<string, object>, seq: number }} seen - This run's record, filled in place.
 * @param {() => number} now
 * @returns {(stages: { name: string, run: (signal: AbortSignal) => unknown }[]) => { name: string, run: (signal: AbortSignal) => Promise<unknown> }[]}
 */
function observeStages(db, job, seen, now) {
  return stages => {
    seen.order = stages.map(stage => stage.name);
    seen.sections = {};
    /** Record one stage's outcome as a step and in this run's record. */
    const record = (index, name, outcome, code) => {
      seen.sections[name] = { outcome, code };
      writeStep(db, job, 'section.done', { section: name, index, outcome, code }, { seq: seen.seq, now: now() });
      seen.seq += 1;
    };
    return stages.map((stage, index) => ({ ...stage, run: async signal => {
      try {
        const value = await stage.run(signal);
        record(index, stage.name, 'pass', null);
        return value;
      } catch (error) {
        record(index, stage.name, signal?.aborted && signal.reason !== error ? 'skip' : 'fail', error?.code ?? 'STAGE_FAILED');
        throw error;
      }
    } }));
  };
}

/**
 * running → collected for a whole submit gate: run the caller's gate in-process with its stages observed, renewing
 * the lease while it runs, and write `collected` with the stage order, each stage's outcome and the gate's result.
 *
 * Why the caller's gate: the hand-off worker's gate (canonical submit) is the one source of what runs and in what
 * order; the driver only records it, so a gate driven here runs exactly the worker's sections and result.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {ReturnType<typeof jobView>} view
 * @param {{ gate: (observe: ReturnType<typeof observeStages>) => Promise<object>, owner: string, now: () => number }} options
 * @returns {Promise<number>} Always 0: a gate owes nothing once its result is written.
 */
async function runGate(db, view, { gate, owner, now }) {
  if (typeof gate !== 'function') throw new Refused('DRIVE_GATE', `Job ${view.id} runs a whole gate: pass { gate } to driveOnce.`);
  const seen = { order: [], sections: {}, seq: view.steps.filter(step => step.name === 'section.done').length };
  const renew = setInterval(() => renewLease(db, view.id, owner, { now: now() }), GATE_RENEW_MS);
  renew.unref?.();
  let result;
  try { result = await gate(observeStages(db, view.id, seen, now)); }
  finally { clearInterval(renew); }
  writeStep(db, view.id, 'collected', { gate: true, order: seen.order, sections: seen.sections, result }, { now: now() });
  return 0;
}

/**
 * collected → verdict: judge with the receipt cell, write the verdict step with the receipt id and free the lease.
 * Only then, as bookkeeping, a red verdict queues one flake-diagnose job per failing case for any driver to run later.
 *
 * Why: diagnostics never hold the gate's worker or delay its verdict; they are their own jobs, off the critical path.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {ReturnType<typeof jobView>} view
 * @param {{ sections?: (collected: object) => object, failures?: (collected: object) => { file: string, case: string }[], owner: string, now: number }} options
 */
function decide(db, view, { sections, failures, owner, now }) {
  const captured = stepPayload(view, 'captured');
  const collected = stepPayload(view, 'collected');
  const receipt = receiptKey(captured.tree, captured.base ?? captured.tree);
  settle((sections ?? (collected.gate ? gateSections : shardSections))(collected), receipt, {
    record: step => {
      writeStep(db, view.id, step.name, step.payload, { now });
      releaseLease(db, view.id, owner, { now });
    },
    bookkeeping: step => {
      if (step.payload.verdict === 'red' && failures) queueFlakeDiagnoses(db, view, captured.tree, failures(collected), { now });
    },
  });
}

/**
 * Drive one gate job by one transition from its last written step, writing that step before returning:
 * queued → captured → running → collected → verdict. A resumed job reads and starts only shards with no done step.
 * A job at its verdict is terminal; a job whose live lease another driver holds is left alone. The verdict frees the
 * lease; a red verdict then queues flake-diagnose jobs for the cases `failures(collected)` names (none by default).
 * Given `gate`, the job runs a whole submit gate instead of a shard plan: `gate(observe)` runs the hand-off worker's
 * gate with its stages passed through `observe`, its stages are recorded as they settle, and the verdict is judged
 * from them with gateSections unless `sections` is passed.
 *
 * Why: the job row, not this process, holds the state, so any driver can call this after any other died, and a
 * repeat of a step it already wrote is a no-op in the job store.
 *
 * @param {import('node:sqlite').DatabaseSync} db - The board's SQLite handle.
 * @param {string} job - The job id.
 * @param {{ owner: string, repo?: string, runner?: { host: string, root?: string },
 *   plan?: { shard: string, command: string }[] | ((captured: object) => { shard: string, command: string }[]),
 *   gate?: (observe: (stages: object[]) => object[]) => Promise<object>,
 *   transport?: { connect: Function }, sections?: (collected: object) => object,
 *   failures?: (collected: object) => { file: string, case: string }[], tooling?: boolean, source?: boolean, bundles?: string, now?: () => number }} options
 * @returns {Promise<{ transition: string | null, phase: string, job: ReturnType<typeof jobView>, owed?: number, code?: string }>}
 */
export async function driveOnce(db, job, { owner, repo, runner, plan, gate, transport, sections, failures, tooling, source, bundles, now = Date.now } = {}) {
  if (!owner) throw new Refused('DRIVE_OWNER', 'driveOnce needs a driver id to hold the lease: pass { owner }.');
  const view = jobView(db, job);
  if (!view) throw new Refused('JOB_MISSING', `No job ${job}: create it with createJob first.`);
  const before = phaseOf(view);
  if (before === 'verdict') return { transition: null, phase: before, job: view };
  const at = now();
  if (!holdLease(db, view, owner, at)) return { transition: null, phase: before, job: jobView(db, job), code: 'JOB_LEASED' };
  const channels = transport ?? sharedTransport();
  let owed;
  if (before === 'queued') capture(db, view, repo, at);
  else if (before === 'captured') await send(db, view, { runner, plan, transport: channels, owner, now: at, gate, repo, tooling, source, bundles });
  else if (before === 'running' && stepPayload(view, 'running')?.gate) owed = await runGate(db, view, { gate, owner, now });
  else if (before === 'running') owed = await collect(db, view, { transport: channels, owner, now: at });
  else decide(db, view, { sections, failures, owner, now: at });
  const after = jobView(db, job);
  const phase = phaseOf(after);
  const result = { transition: phase === before ? null : phase, phase, job: after };
  return owed === undefined ? result : { ...result, owed };
}
