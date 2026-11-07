/** Flake diagnostics as their own jobs: queued after a red verdict, driven by any driver, attached to the item [C7]. */
import { Refused } from '../../../kernel/index.js';
import { createJob } from '../../../jobs/index.js';
import { jobView } from '../../../jobs/index.js';
import { jobsOf } from '../../../jobs/index.js';
import { releaseLease } from '../../../jobs/index.js';
import { renewLease } from '../../../jobs/index.js';
import { takeJob } from '../../../jobs/index.js';
import { writeStep } from '../../../jobs/index.js';
import { FLAKE_DIAGNOSE_KIND } from '../core/flake-diagnose.js';
import { diagnoseTargets } from '../core/flake-diagnose.js';
import { flakeDiagnoseKey } from '../core/flake-diagnose.js';
import { stepPayload } from '../core/drive-phase.js';

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
  if (!owner) throw new Refused('DRIVE_OWNER', 'driveFlakeDiagnose needs a driver id to hold the lease: pass { owner }.');
  if (typeof diagnose !== 'function') throw new Refused('FLAKE_DIAGNOSE_RUN', 'driveFlakeDiagnose needs the diagnostic to run: pass { diagnose }.');
  const view = jobView(db, job);
  if (!view || view.kind !== FLAKE_DIAGNOSE_KIND) throw new Refused('JOB_MISSING', `No flake-diagnose job ${job}: queue it with queueFlakeDiagnoses.`);
  if (stepPayload(view, 'attached')) return { transition: null, job: view };
  const at = now();
  const held = (view.leaseOwner === owner && renewLease(db, job, owner, { now: at })) || takeJob(db, job, owner, { now: at }).taken;
  if (!held) return { transition: null, job: jobView(db, job), code: 'JOB_LEASED' };
  const target = stepPayload(view, 'queued');
  let diagnosed = stepPayload(view, 'diagnosed');
  if (!diagnosed) {
    const result = await diagnose({ tree: target.tree, file: target.file, case: target.case, item: view.item, candidate: view.candidate });
    diagnosed = writeStep(db, job, 'diagnosed', { result: result ?? null }, { now: now() }).payload;
  }
  await attach?.({ item: view.item, tree: target.tree, file: target.file, case: target.case, result: diagnosed.result });
  writeStep(db, job, 'attached', { item: view.item }, { now: now() });
  releaseLease(db, job, owner, { now: now() });
  return { transition: 'attached', job: jobView(db, job) };
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
