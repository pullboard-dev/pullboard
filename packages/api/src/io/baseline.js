/**
 * The check baseline as a pull job [C7,V2,#2520,#3851]: add and edit offer one `check-baseline` job (main's commit and
 * the frozen check) to the runner queue; any runner, the machine's local loopback runner included, runs the check at
 * main and posts a receipt, and the board records the result on the item. Nothing runs the check on the host.
 *
 * Why here: with no registered runner the detached worker had no place to run it, so a fresh board's baseline stayed
 * pending and the CRITERION_PROVES_NOTHING guard never fired (#6560).
 */
import { jobView } from '../../../jobs/index.js';
import { openJob } from './jobs.js';
import { offerJob } from './jobs.js';

/** The job kind of one check baseline. */
export const CHECK_BASELINE_KIND = 'check-baseline';
/** The line the job's entry prints last: the check's exit status and wall seconds. */
const BASELINE_LINE = 'PULLBOARD_CHECK_BASELINE ';
/** What a runner needs to take the job: the gate's own Node. */
const NEEDS = ['node22'];
// Budget: the output the receipt carries is its last 2500 characters, so the line fits the runner's 4 KiB receipt tail.
const OUTPUT_TAIL = 2500;

/** The job's entry, run with Node in the main checkout: the captured check under a shell, then one line naming its exit. */
const ENTRY = `import { spawnSync } from 'node:child_process';
const [command] = process.argv.slice(1);
const env = { ...process.env, PULLBOARD_PULLED_JOB: '1' };
delete env.NODE_TEST_CONTEXT;
const started = Date.now();
const ran = spawnSync(command, { shell: true, env, encoding: 'utf8', maxBuffer: 256 * 1024 ** 2 });
const text = (ran.stdout ?? '') + (ran.stderr ?? '') + (ran.error ? String(ran.error.message) : '');
process.stdout.write(text.slice(-${OUTPUT_TAIL}) + '\\n${BASELINE_LINE}' + JSON.stringify({ status: ran.status ?? 1, seconds: (Date.now() - started) / 1000 }) + '\\n');
process.exitCode = ran.status === 0 ? 0 : 1;
`;

/** The result-applying port this process provides; null until a host provides one. */
let applier = null;

/**
 * Provide the function that records a finished baseline on its item: it reads the run's output into the baseline's
 * shape and completes the item's pending request. Why a provider: the gate cell owns that shape, and the board API
 * stays free of it [P7].
 * @param {((board: any, result: { item: number, expected: { command: string, main: string, request: string }, run: { exitCode: number, output: string }, seconds: number }) => unknown) | null} record
 */
export function provideBaselineRecorder(record) {
  applier = typeof record === 'function' ? record : null;
}

/**
 * Offer the check baseline of an item as a pull job at the captured main, or return the open one already offered for
 * that request: a retried add never queues the same measurement twice.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ item: number, expected: { command: string, main: string, request: string }, command: string, queue?: ReturnType<typeof import('./queue.js').queueFor>, now?: number }} fields - command: the check as a runner runs it at main; queue: the board's queue while runs_store is on, so the offer goes through queueRun and the runs file, and the open job is looked up there [B2,P7].
 * @returns {{ id: string }}
 */
export function offerCheckBaseline(db, { item, expected, command, queue = null, now = Date.now() }) {
  return openJob(queue ? queue.runs.db : db, { kind: CHECK_BASELINE_KIND, item, candidate: expected.main })
    ?? offerJob(db, { id: `baseline:${item}:${expected.request}`, kind: CHECK_BASELINE_KIND, needs: NEEDS, item, candidate: expected.main, base: expected.main,
      payload: { expected: { command: expected.command, main: expected.main, request: expected.request } },
      run: ['node', '--input-type=module', '-e', ENTRY, command], now }, queue);
}

/**
 * Apply a check-baseline job's posted receipt: the exit line the entry printed, with the output before it, becomes the
 * item's recorded baseline. A receipt with no exit line stays recorded and applies nothing, so the item stays pending.
 *
 * @param {any} board
 * @param {{ job: string, receipt: Record<string, any> }} posted
 * @returns {{ applied: boolean, outcome: string }}
 */
export function applyCheckBaselineReceipt(board, { job, receipt }) {
  const view = jobView(board.db, job);
  const expected = view?.steps.find(step => step.name === 'offered')?.payload?.payload?.expected;
  const text = String(receipt?.tail ?? '');
  const at = text.lastIndexOf(BASELINE_LINE);
  let ran = null;
  try { ran = at < 0 ? null : JSON.parse(text.slice(at + BASELINE_LINE.length).split('\n')[0]); } catch { ran = null; }
  if (!applier || !expected || !view.item || !Number.isInteger(ran?.status)) return { applied: false, outcome: 'unread' };
  const done = applier(board, { item: view.item, expected, run: { exitCode: ran.status, output: text.slice(0, at) }, seconds: Number(ran.seconds) || 0 });
  return { applied: done !== false, outcome: done === false ? 'stale' : 'recorded' };
}
