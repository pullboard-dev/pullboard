/** The main-wide test job a sprint landing queues on the landed tip, and its receipt: a red one reopens the sprint items it carries [V2,M1,#12182,#12183]. */

import { itemPace } from '../../../../store/index.js';
import { offerJob } from '../jobs.js';
import { store } from './moves.js';

/** The id prefix of a post-land test job; the landed tip follows it, so one tip holds one job. */
export const POST_LAND_JOB_PREFIX = 'post-land:';

/** The request builder this process's board API calls; null until a host provides one. */
let requestBuilder = null;

/**
 * Provide the function that builds the main-wide test job for a landed tip: build({ root, trunk }) answers
 * { needs, request } for a test job the runner can claim, or null when the project names no gate command.
 * Why a provider: the test job's entry (testJobEntry) and its needs are the CLI's, so `pullboard serve` hands the
 * builder in beside the screen starter and the board API keeps no import of the CLI [V2,M1].
 * @param {((request: { root: string, trunk: string }) => { needs: string[], request: object } | null) | null} build
 */
export function providePostLandMainTest(build) {
  requestBuilder = typeof build === 'function' ? build : null;
}

/**
 * Queue one main-wide test job on the tip a land job just landed, when it landed a sprint item, carrying the land job and
 * those sprint items for the receipt that reads its result. Why: after a sprint landing nothing ran main's tests, so a
 * test the landed work broke on main was seen only by a hand command. The pace is read from the item rows the receipt
 * apply already loaded, so a landing of steady or strict items, or a board with no builder, makes no added board call.
 * The job id names the tip, so a second receipt for the same tip queues none. A builder that throws is logged, never
 * thrown into the receipt apply.
 * @param {{ db: import('node:sqlite').DatabaseSync, gitRoot?: string }} board
 * @param {{ job: string, trunk: string, items: Array<{ item_id: number, item_frozen?: string } | null | undefined>, queue?: object | null }} landed
 * @returns {string | null} the queued job's id, or null when none was queued
 */
export function queuePostLandMainTest(board, { job, trunk, items, queue = null }) {
  const build = requestBuilder;
  if (!build) return null;
  const sprint = items.filter(item => item && itemPace(item) === 'sprint').map(item => item.item_id);
  if (!sprint.length || !board.gitRoot) return null;
  try {
    const built = build({ root: board.gitRoot, trunk });
    if (!built) return null;
    const id = `${POST_LAND_JOB_PREFIX}${trunk}`;
    offerJob(board.db, { id, kind: 'test', needs: built.needs ?? [], candidate: trunk, base: trunk, request: built.request, payload: { postLand: { job, items: sprint } } }, queue);
    return id;
  } catch (error) {
    process.stderr.write(`${new Date().toISOString()} main-wide test after land job ${job} not queued: ${error?.code ?? error?.name ?? 'Error'}: ${error?.message ?? error}\n`);
    return null;
  }
}

/** The pull-out starter this process's board API calls for the items a red post-land receipt reopened; null until a host provides one. */
let pullOutStarter = null;

/**
 * Provide the function that runs the pull-out of the items a red post-land receipt reopened: start({ root, items }).
 * Why a provider: the pull-out reverts on the trunk with git and pushes through the fence from the CLI's lander, so
 * `pullboard serve` hands it in and the board API keeps no import of the CLI [M2,R3,#12184].
 * @param {((request: { root: string, items: number[] }) => unknown) | null} start
 */
export function providePostLandPullOut(start) {
  pullOutStarter = typeof start === 'function' ? start : null;
}

/** Start the pull-out of `items` once this receipt's writes are done; a failed start is logged, and the landing wake runs it again. */
function startPullOut(board, items) {
  if (!pullOutStarter || !board.gitRoot || !items.length) return;
  const start = pullOutStarter, root = board.gitRoot;
  setImmediate(() => {
    Promise.resolve().then(() => start({ root, items })).catch(error => {
      process.stderr.write(`${new Date().toISOString()} pull-out of ${items.map(id => `#${id}`).join(', ')} not started after a red main-wide test: ${error?.code ?? error?.name ?? 'Error'}: ${error?.message ?? error}\n`);
    });
  });
}

/** Whether a job id names a post-land test job: one id per landed tip, under POST_LAND_JOB_PREFIX. */
export function postLandJob(job) {
  return String(job ?? '').startsWith(POST_LAND_JOB_PREFIX);
}

// Budget: the failing cases a reopen note names; the receipt keeps the rest.
const NOTE_CASES = 5;

/** The offered row of job `job`: the board's, or with runs_store on the runs file's, which the queue holds [B2,P7]. */
function offeredRow(board, job, queue) {
  const db = queue ? queue.runs.db : board.db;
  const row = db.prepare("SELECT job_step_payload FROM job_step WHERE job_step_job = ? AND job_step_name = 'offered' ORDER BY job_step_id LIMIT 1").get(job);
  try { return JSON.parse(row?.job_step_payload ?? '{}'); } catch { return {}; }
}

/**
 * Apply a post-land test job's receipt. A red one reopens each sprint item its land job landed, still submitted and merged,
 * through the store's reopen writer with the failing cases and the item's merge commit, so the reopen table's sprint row
 * pull-out-red writes pull_out and the item goes back to its builder. A green one changes nothing.
 * Why: a test the sprint landing broke on main was seen only by a hand command, and the landed work stayed on main.
 * A reopen the board refuses (the item was reopened or accepted meanwhile) is logged and leaves that item as it is.
 *
 * @param {any} board
 * @param {{ job: string, receipt: Record<string, any> }} posted
 * @param {{ queue?: { runs: { db: import('node:sqlite').DatabaseSync } } | null }} [ports]
 * @returns {{ applied: boolean, outcome: 'green' | 'red', reopened: number[] }}
 */
export function applyPostLandReceipt(board, { job, receipt }, ports = {}) {
  const phase = receipt?.gate?.phases?.[0];
  if (receipt?.status === 0 && receipt?.gate?.green === true && (phase?.status ?? 0) === 0) return { applied: false, outcome: 'green', reopened: [] };
  const offered = offeredRow(board, job, ports.queue ?? null);
  const failures = (Array.isArray(phase?.failures) ? phase.failures : []).filter(row => row?.file && row?.name).slice(0, NOTE_CASES);
  const cases = failures.length ? failures.map(row => `${row.file}: ${String(row.name).replace(/[;\r\n]+/gu, ' ').trim()}`).join('; ')
    : `pullboard.json: main-wide test job ${job} red with no named case`;
  const reopened = [];
  for (const id of offered.payload?.postLand?.items ?? []) {
    const item = store.getItem(board, id);
    if (item?.item_status !== 'submitted' || !item.item_merged_commit) continue;
    try {
      store.reopen(board, id, { agentId: 'coordinator', note: `${cases}; merge commit ${item.item_merged_commit}` });
      reopened.push(id);
    } catch (error) {
      process.stderr.write(`${new Date().toISOString()} #${id} not reopened after main-wide test job ${job} went red: ${error?.code ?? error?.name ?? 'Error'}: ${error?.message ?? error}\n`);
    }
  }
  startPullOut(board, reopened);
  return { applied: reopened.length > 0, outcome: 'red', reopened };
}
