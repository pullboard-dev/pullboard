/** driveOnce: continue one gate job from its last written step by exactly one transition, on the board or over job rows a recorder writes [C7]. */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Refused } from '../../../kernel/index.js';
import { jobView } from '../../../jobs/index.js';
import { releaseLease } from '../../../jobs/index.js';
import { renewLease } from '../../../jobs/index.js';
import { takeJob } from '../../../jobs/index.js';
import { finishJob } from '../../../jobs/index.js';
import { writeStep } from '../../../jobs/index.js';
import { bundleFor } from '../../../pin/index.js';
import { listTreeObjects } from '../../../pin/index.js';
import { packObjects } from '../../../pin/index.js';
import { toolingFor } from '../../../pin/index.js';
import { treeOf } from '../../../pin/index.js';
import { receiptKey } from '../../../receipt/index.js';
import { settle } from '../../../receipt/index.js';
import { doneShards } from '../logic/phase.js';
import { gateSections } from '../logic/phase.js';
import { owedShards } from '../logic/phase.js';
import { phaseOf } from '../logic/phase.js';
import { shardSections } from '../logic/phase.js';
import { stepPayload } from '../logic/phase.js';
import { queueFlakeDiagnoses } from './diagnose.js';

/** The transport cell, loaded at a drive's first step: show and test --status never drive, so its modules stay unloaded for them [C7]. */
const transportCell = () => import('../../../transport/index.js');

/** Where tooling tar bundles are written before they are sent; keyed by tree id, so every gate reuses one. */
const BUNDLE_FOLDER = join(tmpdir(), 'pullboard-tooling-bundles');

/** How often a driver renews its lease while a whole gate runs in-process; the lease lapses after 2 minutes. */
const GATE_RENEW_MS = 5_000;

/**
 * @typedef {{ name: string, seq: number, payload: any, at: number }} JobStep
 * @typedef {ReturnType<typeof jobView>} JobView
 * @typedef {{ type: 'step', job: string, name: string, seq: number, payload: any, at: number }} StepRow
 * @typedef {{ type: 'ticket', job: string, action: 'take' | 'renew' | 'release' | 'finish', owner: string, at: number }} TicketRow
 * @typedef {{ type: 'verdict', job: string, name: string, payload: any, owner: string, at: number,
 *   flakes: { tree: string, failures: { file: string, case: string }[] } | null }} VerdictRow
 * @typedef {StepRow | TicketRow | VerdictRow} JobRow
 * @typedef {{ rows: true, view: (job: string) => JobView | null, step: (job: string, name: string, payload: any, options: { seq?: number, now: number }) => { written: boolean, payload: any },
 *   ticket: (job: string, action: 'take' | 'renew' | 'release' | 'finish', owner: string, now: number) => boolean,
 *   verdict: (job: string, step: { name: string, payload: any }, owner: string, now: number, flakes: VerdictRow['flakes']) => void }} JobRows
 */

/**
 * True when `target` is a JobRows object rather than a board SQLite handle.
 *
 * @param {any} target
 * @returns {boolean}
 */
export function isJobRows(target) {
  return target?.rows === true;
}

/**
 * Apply one row a driver emitted to the board: the only board write a sink-driven gate makes. A step row appends a
 * step (a repeat writes nothing), a ticket row takes, renews or frees the lease and answers whether it held, and a
 * verdict row writes the verdict, frees the lease and queues the red verdict's flake diagnoses.
 *
 * @param {import('node:sqlite').DatabaseSync} db - The coordinator's board handle.
 * @param {JobRow} row
 * @returns {any} The step write's result, or the ticket's answer.
 */
export function recordJobRow(db, row) {
  if (row.type === 'step') return writeStep(db, row.job, row.name, row.payload, { seq: row.seq, now: row.at });
  if (row.type === 'ticket') {
    if (row.action === 'take') return takeJob(db, row.job, row.owner, { now: row.at }).taken;
    if (row.action === 'renew') return renewLease(db, row.job, row.owner, { now: row.at });
    if (row.action === 'finish') return finishJob(db, row.job, row.owner, { now: row.at });
    return releaseLease(db, row.job, row.owner, { now: row.at });
  }
  if (row.type === 'verdict') {
    writeStep(db, row.job, row.name, row.payload, { now: row.at });
    releaseLease(db, row.job, row.owner, { now: row.at });
    // Bookkeeping after the verdict: a diagnosis that cannot be queued never undoes the recorded verdict.
    if (row.flakes) {
      try { queueFlakeDiagnoses(db, jobView(db, row.job), row.flakes.tree, row.flakes.failures, { now: row.at }); }
      catch { /* the verdict stands; no diagnosis is queued */ }
    }
    return true;
  }
  throw new Refused('JOB_ROW', `a driver emitted a row of unknown type ${/** @type {any} */ (row).type}`);
}

/**
 * How long a whole gate may run with no step written before the drive cell ends that run. Why: a renewed lease
 * proves the driver is alive, not that it progresses; #2828's driver renewed its lease for 2 h 10 min after its
 * last step (7 Nov) and nothing ended it.
 */
export const GATE_STALL_MS = 20 * 60_000;

/**
 * The least time between two progress steps a gate writes: a gate reports each runner-wait poll and a beat a minute
 * while tests run, and this keeps the step log to about two rows a minute while a report still lands well inside
 * every 2 minutes.
 */
const GATE_PROGRESS_STEP_MS = 30_000;

/** Reruns of the same candidate after a stalled run; the next stall ends the gate as infrastructure. */
export const GATE_STALL_RETRIES = 1;

/**
 * The result a gate records when its stall retries are spent: the canonical refusal shape the hand-off records.
 *
 * @param {Refused} error
 * @returns {{ code: 1, version: 1, error: { code: string, message: string, next: string } }}
 */
function stalledRefusal(error) {
  return { code: 1, version: 1, error: { code: error.code, message: error.message, next: error.next ?? '' } };
}

/**
 * The job rows of a board SQLite handle: each read and write goes straight to the board, as every driver did before
 * rows existed. driveOnce uses this when it is handed a board handle.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {JobRows}
 */
export function boardRows(db) {
  return {
    rows: true,
    view: job => jobView(db, job),
    step: (job, name, payload, { seq = 0, now }) => recordJobRow(db, { type: 'step', job, name, seq, payload, at: now }),
    ticket: (job, action, owner, now) => recordJobRow(db, { type: 'ticket', job, action, owner, at: now }),
    verdict: (job, step, owner, now, flakes) => { recordJobRow(db, { type: 'verdict', job, name: step.name, payload: step.payload, owner, at: now, flakes }); },
  };
}

/**
 * Job rows that hold no board handle: the driver reads its job from a copy taken when the drive began and kept up to
 * date by its own writes, and every write is emitted as a step, ticket or verdict row to `sink`. The sink (a
 * coordinator-side recorder) is the only board writer; a ticket row's answer is the sink's return value.
 *
 * Why: a runner holds no board.sqlite, so the drive loop must run on rows alone; the coordinator records them.
 *
 * @param {JobView} start - The job as the recorder read it before the drive began.
 * @param {(row: JobRow) => any} sink - Records one row and answers a ticket row.
 * @returns {JobRows}
 */
export function rowSink(start, sink) {
  if (!start) throw new Refused('JOB_MISSING', 'a row-driven drive needs its job: create it before the drive begins.');
  const copy = { ...start, steps: start.steps.map(step => ({ ...step })) };
  /** Append a step to the driver's own copy. */
  const append = (name, seq, payload, at) => {
    copy.steps.push({ name, seq, payload, at });
    copy.step = name;
    copy.updated = at;
  };
  /** The copy as a fresh view, so a caller never mutates the driver's state. */
  const snapshot = () => ({ ...copy, steps: copy.steps.map(step => ({ ...step })) });
  return {
    rows: true,
    view: job => (job === copy.id ? snapshot() : null),
    step: (job, name, payload = {}, { seq = 0, now }) => {
      const stored = copy.steps.find(step => step.name === name && step.seq === seq);
      if (stored) return { written: false, payload: stored.payload };
      sink({ type: 'step', job, name, seq, payload: payload ?? {}, at: now });
      append(name, seq, payload ?? {}, now);
      return { written: true, payload: payload ?? {} };
    },
    ticket: (job, action, owner, now) => {
      const held = sink({ type: 'ticket', job, action, owner, at: now }) === true;
      if ((action === 'release' || action === 'finish') && held) copy.leaseOwner = null;
      if (action === 'finish' && held) copy.step = 'done';
      else if (held) copy.leaseOwner = owner;
      return held;
    },
    verdict: (job, step, owner, now, flakes) => {
      sink({ type: 'verdict', job, name: step.name, payload: step.payload, owner, at: now, flakes });
      append(step.name, 0, step.payload, now);
      copy.leaseOwner = null;
    },
  };
}

/**
 * Hold the job's lease for this driver: renew it when the driver already holds it, else take it if it lapsed. Both
 * are ticket rows, so a row-driven driver asks its recorder and holds no board handle.
 *
 * @param {JobRows} rows
 * @param {{ id: string, leaseOwner: string | null }} view
 * @param {string} owner
 * @param {number} now
 * @returns {boolean} True when this driver holds a live lease on the job.
 */
function holdLease(rows, view, owner, now) {
  if (view.leaseOwner === owner && rows.ticket(view.id, 'renew', owner, now)) return true;
  return rows.ticket(view.id, 'take', owner, now);
}

/**
 * queued → captured: resolve the candidate and base to tree ids and record the tooling pin.
 *
 * Why: the tooling comes from packages/pin's toolingFor(repo, seatCommit), the tree of the last landing when one
 * is pinned, never from whichever seat checkout runs the driver, so a seat on an older tree runs main's tooling.
 *
 * @param {JobRows} rows
 * @param {ReturnType<typeof jobView>} view
 * @param {string} repo
 * @param {number} now
 */
function capture(rows, view, repo, now, ran = null) {
  if (!repo) throw new Refused('DRIVE_REPO', 'driveOnce needs the repository to capture a job: pass { repo }.');
  if (!view.candidate) throw new Refused('DRIVE_CANDIDATE', `Job ${view.id} names no candidate commit: create it with { candidate }.`);
  const pin = toolingFor(repo, view.candidate);
  const base = view.base ? treeOf(repo, view.base) : null;
  // The commit of the gate machinery this driver runs beside the source it proves, so a retry on current tooling shows both.
  const machinery = ran?.toolsCommit ? { toolsCommit: ran.toolsCommit, source: view.candidate } : {};
  rows.step(view.id, 'captured', { tree: pin.tree, tooling: pin.tooling, pinned: pin.pinned, base, ...machinery }, { now });
}

/**
 * Start every planned shard that has no done step, writing a `shard.started` step for each. Starting is idempotent
 * on the runner, so a resumed driver may call it for a shard it already started.
 *
 * @param {JobRows} rows
 * @param {ReturnType<typeof jobView>} view
 * @param {object} channel
 * @param {string} owner
 * @param {number} now
 */
async function startOwed(rows, view, channel, owner, now) {
  const { runner } = stepPayload(view, 'running');
  const { tree, base, tooling } = stepPayload(view, 'captured');
  // Why: a pull runner signs these into its result, so the offer must carry the gate's own base, tooling pin and attempt [C7].
  const bound = { tree, base: base ?? '', tooling: tooling ?? '', attempt: String(view.attempt) };
  for (const shard of owedShards(view)) {
    await (await transportCell()).startShard(channel, { job: view.id, shard: shard.shard, command: shard.command, owner, ...bound });
    rows.step(view.id, 'shard.started', { shard: shard.shard, runner: runner.host }, { seq: shard.seq, now });
  }
}

/**
 * captured → running: write the shard plan and the runner, then start the shards. A whole-gate job (`gate`) writes
 * a running step with no shards, since its gate runs in-process at the next transition.
 *
 * @param {JobRows} rows
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
async function send(rows, view, { runner, plan, transport, owner, now, gate, repo, tooling = true, source = true, bundles = BUNDLE_FOLDER }) {
  if (gate) {
    rows.step(view.id, 'running', { gate: true, shards: [] }, { now });
    return;
  }
  if (typeof runner?.host !== 'string') throw new Refused('DRIVE_RUNNER', 'driveOnce needs a runner to send a job to: pass { runner: { host } }.');
  const where = runner.root === undefined ? { host: runner.host } : { host: runner.host, root: runner.root };
  const captured = stepPayload(view, 'captured');
  let pinned;
  if (repo && tooling !== false && captured.tooling) {
    pinned = await (await transportCell()).ensureTooling(transport.connect(where), { tree: captured.tooling, bundle: bundleFor(repo, captured.tooling, bundles).path });
  }
  let sourced;
  if (repo && source !== false && captured.tree) sourced = await (await transportCell()).ensureSource(transport.connect(where), { tree: captured.tree, objects: () => listTreeObjects(repo, captured.tree), pack: ids => packObjects(repo, ids) });
  const planned = { ...captured, ...(pinned ? { toolingPath: pinned.path } : {}), ...(sourced ? { sourcePath: sourced.path } : {}) };
  const shards = typeof plan === 'function' ? plan(planned) : plan;
  if (!Array.isArray(shards) || !shards.length || shards.some(s => typeof s?.shard !== 'string' || typeof s?.command !== 'string')) {
    throw new Refused('DRIVE_PLAN', 'driveOnce needs a shard plan to send: pass { plan: [{ shard, command }] } with the project\'s own test command.');
  }
  const step = { runner: where, shards: shards.map(({ shard, command }) => ({ shard, command })) };
  if (pinned) step.tooling = { tree: pinned.tree, path: pinned.path, held: pinned.held, bytesSent: pinned.bytesSent };
  if (sourced) step.source = { tree: sourced.tree, path: sourced.path, held: sourced.held, total: sourced.total, sent: sourced.sent, reused: sourced.reused, bytesSent: sourced.bytesSent };
  rows.step(view.id, 'running', step, { now });
  await startOwed(rows, rows.view(view.id), transport.connect(where), owner, now);
}

/**
 * running → collected: read each shard that has no done step, record what finished, restart what was invalid or
 * lost, and write `collected` once every shard is done. Shards with a done step are never started or read again.
 *
 * @param {JobRows} rows
 * @param {ReturnType<typeof jobView>} view
 * @param {{ transport: object, owner: string, now: number }} options
 * @returns {Promise<number>} How many shards are still owed.
 */
async function collect(rows, view, { transport, owner, now }) {
  const channel = transport.connect(stepPayload(view, 'running').runner);
  let invalid = view.steps.filter(step => step.name === 'shard.invalid').length;
  for (const shard of owedShards(view)) {
    const result = await (await transportCell()).fetchResult(channel, { job: view.id, shard: shard.shard });
    if (result.state === 'done') {
      rows.step(view.id, 'shard.done', { shard: shard.shard, status: result.status, digest: result.digest }, { seq: shard.seq, now });
    } else if (result.state === 'import.invalid') {
      rows.step(view.id, 'shard.invalid', { shard: shard.shard, reason: result.reason, digest: result.digest ?? null }, { seq: invalid, now });
      invalid += 1;
    }
  }
  const after = rows.view(view.id);
  const owed = owedShards(after);
  if (owed.length) {
    await startOwed(rows, after, channel, owner, now);
    return owed.length;
  }
  const shards = Object.fromEntries([...doneShards(after)].map(([id, done]) => [id, { status: done.status, digest: done.digest }]));
  rows.step(view.id, 'collected', { shards }, { now });
  return 0;
}

/**
 * Wrap a gate's stages so each records a `section.done` step with its outcome as it settles, keeping the stages'
 * own functions, order and values. A stage stopped by another stage's red is recorded as skipped, never failed.
 *
 * @param {JobRows} rows
 * @param {string} job
 * @param {{ order: string[], sections: Record<string, object>, seq: number }} seen - This run's record, filled in place.
 * @param {() => number} now
 * @returns {(stages: { name: string, run: (signal: AbortSignal) => unknown }[]) => { name: string, run: (signal: AbortSignal) => Promise<unknown> }[]}
 */
function observeStages(rows, job, seen, now, ended = null) {
  return stages => {
    seen.order = stages.map(stage => stage.name);
    seen.sections = {};
    /** Record one stage's outcome as a step and in this run's record; an ended run records nothing more. */
    const record = (index, name, outcome, code) => {
      if (ended?.aborted) return;
      seen.sections[name] = { outcome, code };
      rows.step(job, 'section.done', { section: name, index, outcome, code }, { seq: seen.seq, now: now() });
      seen.seq += 1;
    };
    return stages.map((stage, index) => ({ ...stage, run: async signal => {
      try {
        const value = await stage.run(ended && signal ? AbortSignal.any([signal, ended]) : signal ?? ended ?? undefined);
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
 * One run of a whole gate, renewing the lease while it runs (retaking it when a late tick finds it lapsed and still
 * this driver's) and watching the job's steps: the run ends with the gate's result, or as stalled once no step was
 * written for `stallMs`. The gate's `run.progress` reports write `gate.progress` steps, so a gate that waits for a
 * runner or runs tests a long while is not stalled. A stalled run's stages get its signal and it records
 * nothing more, so a stage that never settles cannot hold the gate.
 *
 * @param {JobRows} rows
 * @param {ReturnType<typeof jobView>} view
 * @param {{ gate: Function, owner: string, now: () => number, seen: object, stallMs: number, checkMs: number }} options
 * @returns {Promise<{ result: object } | { stalled: { idleMs: number, lastStep: string | null } }>}
 */
async function attemptGate(rows, view, { gate, owner, now, seen, stallMs, checkMs, serving }) {
  const ended = new AbortController();
  const startedAt = now();
  let servedAt = startedAt;
  let watch;
  // Not unref'd: a gate whose stage holds no handle of its own must still reach its stall.
  const stalled = new Promise(resolvePromise => {
    watch = setInterval(() => {
      const at = now();
      const current = rows.view(view.id);
      // A tick that came late (a blocked event loop) finds its lease lapsed; while no other driver took the job, it
      // retakes the lease, so a live driver never reads as gone (#3836).
      if (!rows.ticket(view.id, 'renew', owner, at) && current.leaseOwner === owner) rows.ticket(view.id, 'take', owner, at);
      const steps = current.steps;
      const last = steps.reduce((latest, step) => (step.at > latest.at ? step : latest), { at: startedAt, name: null });
      // The gate's item moved on (withdrawn, reopened, replaced): the gate stops at this tick (#4072, SM1).
      if (serving && at - servedAt >= SERVING_CHECK_MS) {
        servedAt = at;
        if (servingNow(serving) === false) { resolvePromise({ stale: { lastStep: last.name } }); return; }
      }
      if (at - last.at >= stallMs) resolvePromise({ stalled: { idleMs: at - last.at, lastStep: last.name } });
    }, checkMs);
  });
  // A gate waiting for a runner or running tests reports progress; each report past the bound is a step (#3829).
  let reported = -Infinity;
  const progress = (detail = {}) => {
    const at = now();
    if (ended.signal.aborted || at - reported < GATE_PROGRESS_STEP_MS) return;
    reported = at;
    rows.step(view.id, 'gate.progress', { waiting: detail.waiting === true, running: detail.running === true }, { seq: seen.progress, now: at });
    seen.progress += 1;
  };
  const run = Promise.resolve().then(() => gate(observeStages(rows, view.id, seen, now, ended.signal), { signal: ended.signal, progress }))
    .then(result => ({ result }));
  try {
    const outcome = await Promise.race([run, stalled]);
    if (outcome.stale) {
      ended.abort(new Refused('GATE_STALE', `gate job ${view.id} no longer serves its item`));
      run.catch(() => {});
      return outcome;
    }
    if (outcome.stalled) {
      ended.abort(new Refused('GATE_STALLED', `gate job ${view.id} recorded no step for ${Math.round(outcome.stalled.idleMs / 60_000)} min`));
      run.catch(() => {});
    }
    return outcome;
  } finally { clearInterval(watch); }
}

/** How often a running gate asks whether it still serves its item: one board read per gate every 30 s. */
const SERVING_CHECK_MS = 30_000;

/** The marker runGate returns for a gate it ended because its item moved on. */
const STALE = Symbol('stale');

/** Ask the caller's serving port; one that throws never ends a gate. */
function servingNow(serving) {
  try { return serving(); } catch { return null; }
}

/**
 * End a gate that no longer serves its item: an `ended` step saying so, then the job marked done with its lease freed.
 *
 * @param {JobRows} rows
 * @param {{ id: string }} view
 * @param {string} owner
 * @param {number} at
 * @param {string | null} lastStep
 * @returns {typeof STALE}
 */
function endStale(rows, view, owner, at, lastStep) {
  rows.step(view.id, 'ended', { stale: true, reason: 'its hand-off ended or its item left its serving state', lastStep: lastStep ?? null }, { now: at });
  rows.ticket(view.id, 'finish', owner, at);
  return STALE;
}

/**
 * running → collected for a whole submit gate: run the caller's gate in-process with its stages observed, renewing
 * the lease while it runs, and write `collected` with the stage order, each stage's outcome and the gate's result.
 * A run that writes no step for `stallMs` is ended by this cell: a `gate.stalled` step is written and the same
 * candidate runs again, GATE_STALL_RETRIES times; the next stall writes `collected` with a GATE_INFRA_EXHAUSTED
 * refusal (`stalled(error)` shapes it), so the gate ends as infrastructure and never waits on a live lease forever.
 *
 * Why the caller's gate: the hand-off worker's gate (canonical submit) is the one source of what runs and in what
 * order; the driver only records it, so a gate driven here runs exactly the worker's sections and result.
 * Why its own watch: lease renewal proves the driver is alive, not that it progresses (#2828, 7 Nov).
 *
 * @param {JobRows} rows
 * @param {ReturnType<typeof jobView>} view
 * @param {{ gate: (observe: ReturnType<typeof observeStages>, run: { signal: AbortSignal, progress: (detail?: { waiting?: boolean, running?: boolean }) => void }) => Promise<object>, owner: string, now: () => number,
 *   stallMs?: number, stallCheckMs?: number, stalled?: (error: Refused) => object }} options
 * @returns {Promise<number>} Always 0: a gate owes nothing once its result is written.
 */
async function runGate(rows, view, { gate, owner, now, stallMs = GATE_STALL_MS, stallCheckMs = GATE_RENEW_MS, stalled = stalledRefusal, serving }) {
  if (typeof gate !== 'function') throw new Refused('DRIVE_GATE', `Job ${view.id} runs a whole gate: pass { gate } to driveOnce.`);
  const seen = { order: [], sections: {}, seq: view.steps.filter(step => step.name === 'section.done').length,
    progress: view.steps.filter(step => step.name === 'gate.progress').length };
  let stalls = view.steps.filter(step => step.name === 'gate.stalled').length;
  let result;
  for (;;) {
    const outcome = await attemptGate(rows, view, { gate, owner, now, seen, stallMs, checkMs: stallCheckMs, serving });
    if (outcome.stale) return endStale(rows, view, owner, now(), outcome.stale.lastStep);
    if (!outcome.stalled) { result = outcome.result; break; }
    const retry = stalls < GATE_STALL_RETRIES;
    rows.step(view.id, 'gate.stalled', { attempt: stalls + 1, idleMs: outcome.stalled.idleMs, lastStep: outcome.stalled.lastStep, retry }, { seq: stalls, now: now() });
    stalls += 1;
    if (!retry) {
      result = stalled(new Refused('GATE_INFRA_EXHAUSTED',
        `gate job ${view.id} renewed its lease but recorded no step for ${Math.round(outcome.stalled.idleMs / 60_000)} min on ${stalls} runs of the same candidate (last step ${outcome.stalled.lastStep ?? 'none'}); nothing is wrong with the candidate`,
        'nothing to do as the builder: the coordinator finds the stalled section and requeues this gate'));
      break;
    }
  }
  rows.step(view.id, 'collected', { gate: true, order: seen.order, sections: seen.sections, result, ...(stalls ? { stalls } : {}) }, { now: now() });
  return 0;
}

/**
 * collected → verdict: judge with the receipt cell, write the verdict step with the receipt id and free the lease.
 * Only then, as bookkeeping, a red verdict queues one flake-diagnose job per failing case for any driver to run later.
 *
 * Why: diagnostics never hold the gate's worker or delay its verdict; they are their own jobs, off the critical path.
 *
 * @param {JobRows} rows
 * @param {ReturnType<typeof jobView>} view
 * @param {{ sections?: (collected: object) => object, failures?: (collected: object) => { file: string, case: string }[], owner: string, now: number }} options
 */
function decide(rows, view, { sections, failures, owner, now }) {
  const captured = stepPayload(view, 'captured');
  const collected = stepPayload(view, 'collected');
  const receipt = receiptKey(captured.tree, captured.base ?? captured.tree, captured.tooling ?? captured.tree);
  settle((sections ?? (collected.gate ? gateSections : shardSections))(collected), receipt, {
    record: step => rows.verdict(view.id, step, owner, now, flakeTargets(step, captured, collected, failures)),
  });
}

/**
 * The flake diagnoses a red verdict queues, as bookkeeping carried on its verdict row: the failing cases
 * `failures(collected)` names under the captured tree, or null for a green verdict, no `failures`, or a `failures`
 * that throws, since bookkeeping never holds back the verdict.
 *
 * @param {{ payload: { verdict: string } }} step - The verdict step.
 * @param {{ tree: string }} captured
 * @param {object} collected
 * @param {((collected: object) => { file: string, case: string }[]) | undefined} failures
 * @returns {{ tree: string, failures: { file: string, case: string }[] } | null}
 */
function flakeTargets(step, captured, collected, failures) {
  if (step.payload.verdict !== 'red' || !failures) return null;
  try { return { tree: captured.tree, failures: failures(collected) }; }
  catch { return null; }
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
 * @param {import('node:sqlite').DatabaseSync | JobRows} db - The board's SQLite handle, or job
 *   rows (rowSink) whose writes a coordinator-side recorder applies, so the driver holds no board handle.
 * @param {string} job - The job id.
 * @param {{ owner: string, repo?: string, runner?: { host: string, root?: string },
 *   plan?: { shard: string, command: string }[] | ((captured: object) => { shard: string, command: string }[]),
 *   gate?: (observe: (stages: object[]) => object[]) => Promise<object>,
 *   transport?: { connect: Function }, sections?: (collected: object) => object,
 *   failures?: (collected: object) => { file: string, case: string }[], tooling?: boolean, source?: boolean, bundles?: string,
 *   stallMs?: number, stallCheckMs?: number, stalled?: (error: Refused) => object, ran?: { toolsCommit?: string | null }, serving?: () => boolean | null, now?: () => number }} options - A whole gate that
 *   writes no step for stallMs (GATE_STALL_MS) is ended and rerun once, then recorded as stalled(error). `ran.toolsCommit`, the
 *   commit of the tools this driver runs, is recorded on `captured` with the source commit it proves. `serving`, when
 *   given, is asked at the start and every 30 s while a gate runs; false ends the gate stale (GATE_STALE). `runs`: the board's
 *   runs holder while runs_store is on (boardRunsHolder); the job's rows are read and written there, not on `db` [P7,#9080].
 * @returns {Promise<{ transition: string | null, phase: string, job: ReturnType<typeof jobView>, owed?: number, code?: string }>}
 */
export async function driveOnce(db, job, { owner, repo, runner, plan, gate, transport, sections, failures, tooling, source, bundles, stallMs, stallCheckMs, stalled, ran, serving, runs = null, now = Date.now } = {}) {
  if (!owner) throw new Refused('DRIVE_OWNER', 'driveOnce needs a driver id to hold the lease: pass { owner }.');
  const rows = isJobRows(db) ? /** @type {JobRows} */ (db) : boardRows(/** @type {any} */ (runs?.db ?? db));
  const view = rows.view(job);
  if (!view) throw new Refused('JOB_MISSING', `No job ${job}: create it with createJob first.`);
  const before = phaseOf(view);
  if (before === 'verdict') return { transition: null, phase: before, job: view };
  const at = now();
  if (!holdLease(rows, view, owner, at)) return { transition: null, phase: before, job: rows.view(job), code: 'JOB_LEASED' };
  // A gate whose item moved on is ended before any transition, so a resumed driver never runs it (#4072, SM1).
  if (serving && servingNow(serving) === false) {
    endStale(rows, view, owner, at, view.steps.at(-1)?.name ?? null);
    return { transition: null, phase: before, job: rows.view(job), code: 'GATE_STALE' };
  }
  const channels = transport ?? (await transportCell()).sharedTransport();
  let owed;
  if (before === 'queued') capture(rows, view, repo, at, ran);
  else if (before === 'captured') await send(rows, view, { runner, plan, transport: channels, owner, now: at, gate, repo, tooling, source, bundles });
  else if (before === 'running' && stepPayload(view, 'running')?.gate) owed = await runGate(rows, view, { gate, owner, now, stallMs, stallCheckMs, stalled, serving });
  else if (before === 'running') owed = await collect(rows, view, { transport: channels, owner, now: at });
  else decide(rows, view, { sections, failures, owner, now: at });
  const after = rows.view(job);
  if (owed === STALE) return { transition: null, phase: phaseOf(after), job: after, code: 'GATE_STALE' };
  const phase = phaseOf(after);
  const result = { transition: phase === before ? null : phase, phase, job: after };
  return owed === undefined ? result : { ...result, owed };
}
