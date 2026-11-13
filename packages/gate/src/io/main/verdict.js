/**
 * The gate's main-owned verdict [C7]: a submit gate whose every red case is also red on main, per a fresh main receipt
 * for that file at the gate base, records green with those cases listed as main-owned. A red file main has no fresh
 * receipt for queues a main-test job, and the verdict waits on the board as a job step, finished when the job's receipt
 * returns. The item is never bounced to its builder for a red that main owns, and no builder fact or resubmit is needed.
 *
 * The board is reached only through ports (the jobs cell's front door and the drive cell's main-test enqueue), so the
 * gate cell adds no cross-cell edge.
 */

/** The job kind of a gate verdict that may wait on main's receipts; one row per item and candidate. */
export const GATE_VERDICT_KIND = 'gate-verdict';

/** The step a verdict waits in while main-test jobs it queued have not returned. */
export const AWAITING_MAIN_STEP = 'awaiting-main';

/** The step name a main-test job writes its receipt under when it returns. */
export const MAIN_TEST_RECEIPT_STEP = 'receipt';

/** The step a waiting verdict ends in when its item is no longer submitted at the verdict's candidate; no verdict is written. */
const WITHDRAWN_STEP = 'withdrawn';

/**
 * The verdict job's id for one item's candidate. Why: a resumed driver and a second judge of the same gate reuse one row.
 *
 * @param {number} item
 * @param {string} candidate - the candidate commit
 * @returns {string}
 */
export function gateVerdictJobId(item, candidate) {
  return `${GATE_VERDICT_KIND}:${item}:${candidate}`;
}

/**
 * Whether a main receipt answers for one red file at the gate base: same file and test command, recorded at the gate
 * base's tree, and no older than the base. Why: a receipt from an earlier main can call a case red that the base fixed,
 * so only a receipt taken at the base itself may excuse a red.
 *
 * @param {object | null | undefined} receipt - `{ id, tree, file, command, verdict, failing, at }`
 * @param {{ tree: string, at: number }} base
 * @param {string} file
 * @param {string} command
 * @returns {boolean}
 */
export function freshMainReceipt(receipt, base, file, command) {
  return Boolean(receipt) && receipt.tree === base.tree && receipt.file === file && receipt.command === command
    && ['red', 'green'].includes(receipt.verdict) && Number.isFinite(receipt.at) && receipt.at >= base.at;
}

/**
 * Judge a gate's reds against main's receipts. Pure: no board, no process. Every red case named red by a fresh receipt
 * for its file is main-owned; a case a fresh receipt does not name red is the candidate's own; a file with no fresh
 * receipt is missing, and the verdict is pending until its main-test job returns.
 *
 * @param {{ base: { commit: string, tree: string, at: number }, command: string, reds: { file: string, name: string }[],
 *   receipts: Iterable<object> }} gate
 * @returns {{ verdict: 'green' | 'red' | 'pending', mainOwned: { file: string, name: string, receipt: string }[],
 *   own: { file: string, name: string }[], missing: string[] }}
 */
export function judgeMainOwnedReds({ base, command, reds, receipts }) {
  const all = [...(receipts ?? [])];
  const files = [...new Set(reds.map(row => row.file))];
  const mainOwned = [], own = [], missing = [];
  for (const file of files) {
    const fresh = all.filter(receipt => freshMainReceipt(receipt, base, file, command)).sort((a, b) => b.at - a.at)[0];
    if (!fresh) { missing.push(file); continue; }
    const onMain = new Set(fresh.verdict === 'red' ? fresh.failing ?? [] : []);
    for (const row of reds.filter(red => red.file === file)) {
      if (onMain.has(row.name)) mainOwned.push({ file, name: row.name, receipt: fresh.id });
      else own.push({ file, name: row.name });
    }
  }
  const verdict = own.length ? 'red' : missing.length ? 'pending' : 'green';
  return { verdict, mainOwned, own, missing };
}

/**
 * Every receipt main-test jobs have returned on this board, from their receipt steps.
 *
 * @param {{ jobsOf: Function }} jobs - the jobs cell's front door
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} kind - the main-test job kind
 * @returns {object[]}
 */
export function returnedMainReceipts(jobs, db, kind) {
  // A pulled job's runner posts its own receipt under the same step name; only the keyed receipt names a tree (#6063).
  return jobs.jobsOf(db, { kind }).flatMap(job => job.steps.filter(step => step.name === MAIN_TEST_RECEIPT_STEP && typeof step.payload?.tree === 'string').map(step => step.payload));
}

/**
 * Write the verdict step for a judged gate: green with the main-owned cases, or red with the candidate's own cases.
 *
 * @param {{ writeStep: Function }} jobs
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} id - the verdict job
 * @param {ReturnType<typeof judgeMainOwnedReds>} judged
 * @param {number} now
 * @returns {object} the stored verdict payload
 */
function writeVerdict(jobs, db, id, judged, now) {
  const payload = judged.verdict === 'green'
    ? { green: true, mainOwned: judged.mainOwned, receipts: [...new Set(judged.mainOwned.map(row => row.receipt))] }
    : { green: false, own: judged.own, mainOwned: judged.mainOwned };
  return jobs.writeStep(db, id, 'verdict', payload, { now }).payload;
}

/**
 * Record a submit gate's verdict over its reds. When every red is main's own per fresh receipts at the base, the gate
 * records green with those cases listed as main-owned. When a red file has no fresh receipt, one main-test job per
 * file is queued through `queueMainTest` and the verdict waits in the `awaiting-main` step; nothing is bounced.
 *
 * @param {{ jobs: { createJob: Function, writeStep: Function, jobView: Function, jobsOf: Function },
 *   queueMainTest: (db: import('node:sqlite').DatabaseSync, at: { tree: string, file: string, command: string, now: number }) => string,
 *   mainTestKind: string }} ports - the jobs cell, and the drive cell's main-test enqueue and job kind
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ item: number, candidate: string, base: { commit: string, tree: string, at: number }, command: string,
 *   reds: { file: string, name: string }[], receipts?: Iterable<object>, now?: number }} gate
 * @returns {{ id: string, verdict: 'green' | 'red' | 'pending', mainOwned: object[], own: object[], missing: string[], queued: string[] }}
 */
export function recordGateVerdict(ports, db, { item, candidate, base, command, reds, receipts = [], now = Date.now() }) {
  const id = gateVerdictJobId(item, candidate);
  ports.jobs.createJob(db, { id, kind: GATE_VERDICT_KIND, item, candidate, base: base.commit, now });
  const judged = judgeMainOwnedReds({ base, command, reds, receipts: [...receipts, ...returnedMainReceipts(ports.jobs, db, ports.mainTestKind)] });
  if (judged.verdict !== 'pending') return { id, ...judged, queued: [], stored: writeVerdict(ports.jobs, db, id, judged, now) };
  const queued = judged.missing.map(file => ports.queueMainTest(db, { tree: base.tree, file, command, now }));
  ports.jobs.writeStep(db, id, AWAITING_MAIN_STEP, { base, command, reds, missing: judged.missing, queued }, { now });
  return { id, ...judged, queued };
}

/**
 * A main-test job returns: write its receipt step. Why: the receipt is a fact keyed by the job, so a second return of
 * the same job is a no-op and every waiting verdict reads the one receipt.
 *
 * @param {{ writeStep: Function }} jobs
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} job - the main-test job id
 * @param {{ id: string, tree: string, file: string, command: string, verdict: 'red' | 'green', failing?: string[], at: number }} receipt
 * @param {{ now?: number }} [options]
 * @returns {object} the stored receipt
 */
export function returnMainTest(jobs, db, job, receipt, { now = Date.now() } = {}) {
  return jobs.writeStep(db, job, MAIN_TEST_RECEIPT_STEP, receipt, { now }).payload;
}

/**
 * Finish every gate verdict waiting on main whose main-test jobs have returned: judge again with the returned receipts
 * and write the verdict step. A verdict whose receipts are still missing keeps waiting; none is bounced. A verdict whose
 * item is no longer submitted at its candidate (withdrawn, released or resubmitted at another head) ends in a
 * `withdrawn` step and writes no verdict (SM16); with no `itemSubmittedAt` port, no item is checked.
 *
 * @param {{ jobs: { writeStep: Function, jobsOf: Function }, mainTestKind: string,
 *   itemSubmittedAt?: (db: import('node:sqlite').DatabaseSync, item: number, candidate: string) => boolean }} ports
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ now?: number }} [options]
 * @returns {{ id: string, verdict: 'green' | 'red', mainOwned: object[], own: object[] }[]} the verdicts finished now
 */
export function finishAwaitingVerdicts(ports, db, { now = Date.now() } = {}) {
  const receipts = returnedMainReceipts(ports.jobs, db, ports.mainTestKind);
  const finished = [];
  for (const job of ports.jobs.jobsOf(db, { kind: GATE_VERDICT_KIND })) {
    if (job.step !== AWAITING_MAIN_STEP) continue;
    if (ports.itemSubmittedAt && !ports.itemSubmittedAt(db, job.item, job.candidate)) {
      ports.jobs.writeStep(db, job.id, WITHDRAWN_STEP, { item: job.item, candidate: job.candidate }, { now });
      continue;
    }
    const waiting = job.steps.find(step => step.name === AWAITING_MAIN_STEP).payload;
    const judged = judgeMainOwnedReds({ base: waiting.base, command: waiting.command, reds: waiting.reds, receipts });
    if (judged.verdict === 'pending') continue;
    writeVerdict(ports.jobs, db, job.id, judged, now);
    finished.push({ id: job.id, verdict: judged.verdict, mainOwned: judged.mainOwned, own: judged.own });
  }
  return finished;
}
