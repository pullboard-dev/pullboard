/** finishSequence: the one landing finish sequence, each of its six steps a job step that a resumed landing continues [C7]. */
import { Refused } from '../../../kernel/index.js';
import { jobView } from '../../../jobs/index.js';
import { renewLease } from '../../../jobs/index.js';
import { finishJob } from '../../../jobs/index.js';
import { takeJob } from '../../../jobs/index.js';
import { writeStep } from '../../../jobs/index.js';
import { isObjectId } from '../../../pin/index.js';
import { treeOf } from '../../../pin/index.js';
import { writeToolingPin } from '../../../pin/index.js';
import { receiptByKey } from '../../../receipt/index.js';
import { receiptKey } from '../../../receipt/index.js';
import { reusable } from '../../../receipt/index.js';
import { nextFinishStep } from '../logic/steps.js';
import { writtenSteps } from '../logic/steps.js';

/**
 * Hold the landing's lease for this driver: renew it when the driver already holds it, else take it if it lapsed.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ id: string, leaseOwner: string | null }} view
 * @param {string} owner
 * @param {number} now
 * @returns {boolean} True when this driver holds a live lease on the landing.
 */
function holdLease(db, view, owner, now) {
  if (view.leaseOwner === owner && renewLease(db, view.id, owner, { now })) return true;
  return takeJob(db, view.id, owner, { now }).taken;
}

/**
 * The handler the caller supplied for a step, refusing when it is missing.
 *
 * @param {Record<string, Function>} steps
 * @param {string} name
 * @returns {Function}
 */
function handlerFor(steps, name) {
  const handler = steps?.[name];
  if (typeof handler !== 'function') throw new Refused('LAND_STEP_HANDLER', `finishSequence needs a ${name} step: pass { steps: { ${name}(context) } }.`);
  return handler;
}

/**
 * compose: run the caller's compose and name its candidate and base commits by tree id, so prove keys by content.
 *
 * @param {Function} compose
 * @param {object} context
 * @param {string} repo
 * @returns {Promise<object>} The compose payload with candidate and base commits and their trees.
 */
async function composeStep(compose, context, repo) {
  const composed = await compose(context);
  if (!isObjectId(composed?.candidate) || !isObjectId(composed?.base)) {
    throw new Refused('LAND_COMPOSE', 'The compose step must return { candidate, base } commit ids for the composed batch and the trunk it sits on.');
  }
  return { ...composed, candidateTree: treeOf(repo, composed.candidate), baseTree: treeOf(repo, composed.base) };
}

/**
 * prove: reuse a green receipt proved at exactly the composition's trees, else run the caller's prove.
 *
 * Why: RFC 0007's reuse rule lives in the receipt cell; a landing whose composition a submit already proved
 * must not run the tests again.
 *
 * @param {Function} prove
 * @param {object} context
 * @param {Iterable<object> | Map<string, object>} receipts
 * @returns {Promise<{ receipt: string, reused: boolean, verdict: string, code: string | null }>}
 */
async function proveStep(prove, context, receipts) {
  const { candidateTree, baseTree } = context.written.compose;
  const key = receiptKey(candidateTree, baseTree);
  const reuse = reusable(receiptByKey(receipts, key), { candidate: candidateTree, base: baseTree });
  if (reuse.reuse) return { receipt: key, reused: true, verdict: 'green', code: null };
  const proved = await prove(context);
  if (typeof proved?.verdict !== 'string') throw new Refused('LAND_PROVE', 'The prove step must return { verdict } (green, red or infra) for the composed batch.');
  return { ...proved, receipt: key, reused: false, code: reuse.code };
}

/**
 * merge: run the caller's merge, then write the tooling pin for the landed commit before the step is recorded.
 *
 * Why: the landing is the one writer of the tooling pin (#3407). Writing it before the merge step is recorded means
 * a written merge step always has its pin; a driver that dies between the two reruns merge, which must answer the
 * same landed commit when it already merged.
 *
 * @param {Function} merge
 * @param {object} context
 * @param {string} repo
 * @returns {Promise<object>} The merge payload with the landed commit and the pinned tooling tree.
 */
async function mergeStep(merge, context, repo) {
  const merged = await merge(context);
  if (!isObjectId(merged?.commit)) throw new Refused('LAND_MERGE', 'The merge step must return { commit } naming the landed commit on trunk.');
  const pin = writeToolingPin(repo, merged.commit);
  return { ...merged, commit: pin.commit, tooling: pin.tree };
}

/**
 * Run one finish step's work and return the payload to write for it.
 *
 * @param {string} name
 * @param {Record<string, Function>} steps
 * @param {object} context
 * @param {{ repo: string, receipts: Iterable<object> | Map<string, object> }} options
 * @returns {Promise<object>}
 */
async function runStep(name, steps, context, { repo, receipts }) {
  const handler = handlerFor(steps, name);
  if (name === 'compose') return composeStep(handler, context, repo);
  if (name === 'prove') return proveStep(handler, context, receipts);
  if (name === 'merge') return mergeStep(handler, context, repo);
  return (await handler(context)) ?? {};
}

/**
 * End a landing whose proof was not green: write a `failed` step naming the proof and mark the job done, freeing its lease.
 *
 * Why: a stopped landing used to leave its lease to lapse with the job never done, so it read as a stalled landing for
 * ever; a failed step and `done` let a reader tell a stopped landing from a live one.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} job
 * @param {string} owner
 * @param {() => number} now
 * @returns {object} The job view after the stop.
 */
function endStopped(db, job, owner, now) {
  const view = jobView(db, job);
  if (view.step === 'done') return view;
  const prove = writtenSteps(view).prove;
  writeStep(db, job, 'failed', { code: 'LAND_PROOF_NOT_GREEN', stopped: 'prove', verdict: prove?.verdict ?? null, proof: prove?.code ?? null }, { now: now() });
  finishJob(db, job, owner, { now: now() });
  return jobView(db, job);
}

/**
 * Finish a landing batch: select → compose → prove (reuse a receipt, or run) → merge → record → publish, each written
 * as a job step before the next starts. A resumed landing skips every step its log holds and hands the later steps
 * the payloads written earlier. A red or infra proof stops before merge; a landing whose live lease another driver
 * holds is left alone. After publish the job is marked done and its lease released, so it never reads as stalled; the
 * returned `job` is the log as the steps wrote it.
 *
 * Why: the job row, not the process, holds the landing's progress, so any driver continues after any other died,
 * and a repeated step is a no-op in the job store (RFC 0008 DJ3, DJ11).
 *
 * @param {import('node:sqlite').DatabaseSync} db - The board's SQLite handle.
 * @param {string} job - The landing batch's job id.
 * @param {{ owner: string, repo: string, steps: Record<string, (context: { job: object, written: Record<string, any>, repo: string }) => any>,
 *   receipts?: Iterable<object> | Map<string, object>, now?: () => number }} options
 * @returns {Promise<{ done: boolean, ran: string[], job: object, stopped?: string, code?: string }>}
 */
export async function finishSequence(db, job, { owner, repo, steps, receipts = [], now = Date.now } = {}) {
  if (!owner) throw new Refused('LAND_OWNER', 'finishSequence needs a driver id to hold the lease: pass { owner }.');
  if (!repo) throw new Refused('LAND_REPO', 'finishSequence needs the repository it lands in: pass { repo }.');
  let view = jobView(db, job);
  if (!view) throw new Refused('JOB_MISSING', `No job ${job}: create it with createJob first.`);
  const ran = [];
  const stoppedAt = () => {
    const prove = writtenSteps(view).prove;
    return prove && prove.verdict !== 'green' && !('merge' in writtenSteps(view)) ? prove : null;
  };
  if (nextFinishStep(view) === null) {
    if (view.step !== 'done' && holdLease(db, view, owner, now())) finishJob(db, job, owner, { now: now() });
    return { done: true, ran, job: view };
  }
  if (stoppedAt()) {
    const ended = view.step !== 'done' && holdLease(db, view, owner, now()) ? endStopped(db, job, owner, now) : view;
    return { done: false, ran, job: ended, stopped: 'prove', code: 'LAND_PROOF_NOT_GREEN' };
  }
  if (!holdLease(db, view, owner, now())) return { done: false, ran, job: jobView(db, job), code: 'JOB_LEASED' };
  for (let name = nextFinishStep(view); name !== null; name = nextFinishStep(view)) {
    if (ran.length && !renewLease(db, job, owner, { now: now() })) return { done: false, ran, job: jobView(db, job), code: 'JOB_LEASED' };
    const payload = await runStep(name, steps, { job: view, written: writtenSteps(view), repo }, { repo, receipts });
    writeStep(db, job, name, payload, { now: now() });
    ran.push(name);
    view = jobView(db, job);
    if (stoppedAt()) return { done: false, ran, job: endStopped(db, job, owner, now), stopped: 'prove', code: 'LAND_PROOF_NOT_GREEN' };
  }
  finishJob(db, job, owner, { now: now() });
  return { done: true, ran, job: view };
}
