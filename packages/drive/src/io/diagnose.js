/** Flake diagnostics as their own jobs: queued after a red verdict, driven by any driver, attached to the item [C7]. */
import { Refused } from '../../../kernel/index.js';
import { createJob } from '../../../jobs/index.js';
import { jobView } from '../../../jobs/index.js';
import { jobsOf } from '../../../jobs/index.js';
import { releaseLease } from '../../../jobs/index.js';
import { renewLease } from '../../../jobs/index.js';
import { takeJob } from '../../../jobs/index.js';
import { writeStep } from '../../../jobs/index.js';
import { FLAKE_DIAGNOSE_KIND } from '../logic/diagnose.js';
import { diagnoseTargets } from '../logic/diagnose.js';
import { flakeDiagnoseKey } from '../logic/diagnose.js';
import { stepPayload } from '../logic/phase.js';
import { treeOf } from '../../../pin/index.js';

/**
 * Queue one flake-diagnose job per distinct failing case of a red gate job. Each job is keyed by (tree, file, case)
 * and carries the gate's item, so queueing twice, or from a second gate on the same tree, makes no new job.
 *
 * Why: diagnostics used to run inside the gate's runner lease; as jobs they wait for any driver after the verdict.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ id: string, item: number | null, candidate: string | null }} gate - The gate's job view.
 * @param {string} tree - The candidate tree the gate judged.
 * @param {unknown} failures - The failing cases: `[{ file, case }]`.
 * @param {{ now?: number }} [options]
 * @returns {string[]} The flake-diagnose job ids, one per distinct case.
 */
export function queueFlakeDiagnoses(db, gate, tree, failures, { now = Date.now() } = {}) {
  return diagnoseTargets(failures).map(({ file, case: testCase }) => {
    const id = flakeDiagnoseKey(tree, file, testCase);
    createJob(db, { id, kind: FLAKE_DIAGNOSE_KIND, item: gate.item, candidate: gate.candidate, now });
    writeStep(db, id, 'queued', { tree, file, case: testCase, gate: gate.id }, { now });
    return id;
  });
}

/**
 * Begin one flake-diagnose job: take or renew its lease and say what is left to do. A job whose result is attached is
 * done; a job another driver holds is left alone; a diagnosis already written is reported so it is never run again.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} job
 * @param {{ owner: string, now?: number }} options
 * @returns {{ state: 'done' | 'leased' | 'diagnose' | 'attach', target: { tree: string, file: string, case: string, item: number | null, candidate: string | null }, diagnosed: { result: unknown } | null }}
 */
export function startFlakeDiagnose(db, job, { owner, now = Date.now() } = {}) {
  if (!owner) throw new Refused('DRIVE_OWNER', 'A flake diagnostic needs a driver id to hold the lease: pass { owner }.');
  const view = jobView(db, job);
  if (!view || view.kind !== FLAKE_DIAGNOSE_KIND) throw new Refused('JOB_MISSING', `No flake-diagnose job ${job}: queue it with queueFlakeDiagnoses.`);
  const queued = stepPayload(view, 'queued');
  const target = { tree: queued.tree, file: queued.file, case: queued.case, item: view.item, candidate: view.candidate };
  const diagnosed = stepPayload(view, 'diagnosed');
  if (stepPayload(view, 'attached')) return { state: 'done', target, diagnosed };
  const held = (view.leaseOwner === owner && renewLease(db, job, owner, { now })) || takeJob(db, job, owner, { now }).taken;
  if (!held) return { state: 'leased', target, diagnosed };
  return { state: diagnosed ? 'attach' : 'diagnose', target, diagnosed };
}

/**
 * Finish one flake-diagnose job the driver holds: write its result (kept when one is already written), mark it
 * attached to the item and free the lease.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} job
 * @param {{ owner: string, result: unknown, now?: number }} options
 * @returns {{ result: unknown }} The stored diagnosis.
 */
export function finishFlakeDiagnose(db, job, { owner, result, now = Date.now() }) {
  const diagnosed = writeStep(db, job, 'diagnosed', { result: result ?? null }, { now }).payload;
  writeStep(db, job, 'attached', { item: jobView(db, job).item }, { now });
  releaseLease(db, job, owner, { now });
  return diagnosed;
}

/**
 * Run one flake-diagnose job to its end: diagnose the case, write the result, attach it to the item, free the lease.
 * A job whose result is attached is terminal; a job another driver holds is left alone; a diagnosis already written
 * is never run again, so a driver that died after diagnosing only attaches.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} job - The flake-diagnose job id.
 * @param {{ owner: string, diagnose: (target: { tree: string, file: string, case: string, item: number | null, candidate: string | null }) => unknown | Promise<unknown>,
 *   attach?: (attached: { item: number | null, tree: string, file: string, case: string, result: unknown }) => unknown | Promise<unknown>, now?: () => number }} options
 * @returns {Promise<{ transition: string | null, job: ReturnType<typeof jobView>, code?: string }>}
 */
export async function driveFlakeDiagnose(db, job, { owner, diagnose, attach, now = Date.now } = {}) {
  if (typeof diagnose !== 'function') throw new Refused('FLAKE_DIAGNOSE_RUN', 'driveFlakeDiagnose needs the diagnostic to run: pass { diagnose }.');
  const begun = startFlakeDiagnose(db, job, { owner, now: now() });
  if (begun.state === 'done') return { transition: null, job: jobView(db, job) };
  if (begun.state === 'leased') return { transition: null, job: jobView(db, job), code: 'JOB_LEASED' };
  const result = begun.diagnosed ? begun.diagnosed.result : await diagnose(begun.target);
  await attach?.({ ...begun.target, result: result ?? null });
  finishFlakeDiagnose(db, job, { owner, result, now: now() });
  return { transition: 'attached', job: jobView(db, job) };
}

/**
 * Wrap a gate's flake observer so each red run's diagnostics are flake-diagnose jobs: the failing cases are queued
 * keyed by (tree, file, case) for the item, the observer runs once for every case still owed, and each case's
 * observation is written as its job's result. The board is open only to queue and to record, never while the
 * observer runs. A red run that names no case still runs the observer, so its records stay as they were.
 *
 * Why: the gate calls this after its result is made and its slot released, so the diagnostic is its own job and any
 * diagnostic already attached for the same tree and case is reused instead of run again.
 *
 * @param {(run: object, context: object) => Promise<void>} observe - The flakes cell's observer.
 * @param {{ withDb: (work: (db: import('node:sqlite').DatabaseSync) => any) => Promise<any>, gate: { id: string, item: number | null, candidate: string },
 *   repo: string, owner: string, cases: (run: object, root: string) => { file: string, case: string }[] }} options
 * @returns {(run: object, context: { root: string }) => Promise<void>} An observer with the same `main` and `recordRun`.
 */
export function jobbedFlakeObserver(observe, { withDb, gate, repo, owner, cases }) {
  return Object.assign(async (run, context) => {
    let owed = [];
    try {
      const tree = treeOf(repo, gate.candidate);
      owed = await withDb(db => queueFlakeDiagnoses(db, gate, tree, cases(run, context.root))
        .map(id => ({ id, begun: startFlakeDiagnose(db, id, { owner }) })));
    } catch { owed = null; /* An unreadable board never stops the diagnostic itself. */ }
    if (owed && owed.length && owed.every(entry => entry.begun.state !== 'diagnose')) return;
    await observe(run, context);
    if (!owed?.length) return;
    const observations = run.flakeDiagnostics?.observations ?? [];
    try {
      await withDb(db => {
        for (const { id, begun } of owed) {
          if (begun.state !== 'diagnose') continue;
          const seen = observations.find(row => row.file === begun.target.file && row.name === begun.target.case) ?? null;
          finishFlakeDiagnose(db, id, { owner, result: seen ?? { classification: 'unclassified', error: run.flakeDiagnostics?.error ?? null } });
        }
      });
    } catch { /* The observation is already on the board through the observer; only the job record is missing. */ }
  }, { main: observe.main, recordRun: observe.recordRun,
    // Record the jobs alone, with no slot and no observer, so a verdict can return before a diagnostics slot is asked for [C7].
    queue: async (run, context) => {
      const tree = treeOf(repo, gate.candidate);
      await withDb(db => queueFlakeDiagnoses(db, gate, tree, cases(run, context.root)));
    } });
}

/**
 * The flake diagnostics attached to one item: every finished flake-diagnose job for it, with its key and result.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} item
 * @returns {{ job: string, tree: string, file: string, case: string, gate: string, result: unknown }[]}
 */
export function flakeDiagnosesFor(db, item) {
  return jobsOf(db, { kind: FLAKE_DIAGNOSE_KIND, item })
    .filter(view => stepPayload(view, 'attached'))
    .map(view => {
      const target = stepPayload(view, 'queued');
      return { job: view.id, tree: target.tree, file: target.file, case: target.case, gate: target.gate, result: stepPayload(view, 'diagnosed').result };
    });
}
