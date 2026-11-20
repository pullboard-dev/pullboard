/**
 * A posted runner job receipt applied to the board: a gate's receipt becomes its item's gate result (green submits it for
 * review, red hands it back to its builder), and a landing's receipt marks its items merged at the pushed commit [P7].
 */
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { store } from './gate/moves.js';
import { redLocationLine } from './gate/where.js';
import { missingReceiptPart } from './gate/where.js';
import { orderedReceiptMoves } from './gate/moves.js';
import { sameTimingRed } from '../logic/gate/timing-reds.js';
import { phaseReceiptId } from '../../../jobs/index.js';
import { releaseBackoffMs } from '../../../jobs/index.js';
import { readPayload } from '../../../jobs/index.js';
import { noteLease } from '../../../jobs/index.js';
import { atomically } from '../../../jobs/index.js';
import { jobQueueCall } from './jobs.js';
import { offerJob } from './jobs.js';
import { boardRun } from '../../../store/index.js';
import { applyRunReceipt } from '../../../store/index.js';
import { offeredRequest } from './jobs.js';
import { proofBuckets } from './jobs.js';
import { SHARD_JOB_KIND } from './jobs.js';
import { LANDING_JOB_KIND } from './landing.js';
import { keepLandingLog } from './landing.js';
import { livePersonWaivers } from './landing.js';
import { reofferLandingJob } from './landing.js';
import { queueFor } from './queue.js';
import { landingRetries } from './landing.js';
import { LAND_PUSH_RETRIES } from './landing.js';
import { withLandingPermit } from './permit.js';
import { startReceiptScreen } from './gate/screen-start.js';
import { sprintLandable } from './gate/sprint-land.js';
import { applyMainTestReceipt } from './recheck.js';
import { applyCheckBaselineReceipt } from './baseline.js';
import { CHECK_BASELINE_KIND } from './baseline.js';
import { MAIN_TEST_KIND } from './recheck.js';
import { MAIN_CASE_NAME_UNITS } from './recheck.js';
import { offerMainTests } from './recheck.js';
import { endStaleGateJobs } from './stale.js';
import { landingGuardKey } from '../../../git/index.js';
import { repoInfo } from '../../../git/index.js';
import { trunkRevisionReader } from '../../../git/index.js';
import { tryGit } from '../../../git/index.js';
import { plainTrunkRef } from '../../../git/index.js';
import { resolveCommit } from '../../../git/index.js';
import { mainCheckout } from '../../../git/index.js';
import { CONFIG_FILE } from '../../../kernel/browser.js';
import { judgePulledFlakes } from './flakes.js';
import { recordLandedRed } from './flakes.js';
import { ownershipOnly } from './owner.js';
import { routePulledOwnership } from './owner.js';
import { compareFilesWithMain } from './gate/files.js';
import { fileMainLines } from './gate/files.js';
import { applyTestReceipt } from './test/receipt.js';
import { settleQueuedAccept } from './test/accept.js';
import { caseReworkLines } from './gate/files.js';
import { ledgerInputKeys } from './gate/files.js';
import { companionInherits } from './gate/companion.js';
import { retryNewReds } from './gate/retry.js';
import { retryShardId } from './gate/retry.js';
import { shardNote } from './gate/retry.js';

/** The extension of one gate run receipt file: a receipt is named by its run id [CD2]. */
const RECEIPT_EXT = '.json';

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const PROJECT_FILE = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\0\n\r]{1,4096}$/u;
// Budget: a red's failing parts are named one line each, bounded so a fact stays a readable record.
const PART_TEXT = 600;
/** Budget: a gate request with its ledger hits stays this far under the queue's 60 KiB job-request cap (jobs.js). */
const LEDGER_REQUEST_BYTES = 56 * 1024;
// Budget: one gate's proof splits into at most 32 shard jobs, so one receipt never floods the queue.
const MAX_SHARDS = 32;

/**
 * The newest gate job offered for an item, so an older candidate's receipt reads as stale.
 * runs: the board's runs holder (boardRunsHolder) while runs_store is on, so the job rows are read from the runs file; null reads the board's [B2,P7,#9149].
 */
export function latestGateJob(db, item, { runs = null } = {}) {
  return (runs ? runs.db : db).prepare("SELECT job_id FROM job WHERE job_kind = 'gate' AND job_item = ? ORDER BY job_created DESC, rowid DESC LIMIT 1").get(item)?.job_id ?? null;
}

/**
 * The item's pulled gates that came back red on a failing test phase, oldest first: each with the event id of the red
 * fact applyGateReceipt wrote, the candidate the gate judged, and the failing cases it named.
 * Why the red fact: it is written only for a receipt applied to the live claim at its bar, so a stale receipt never
 * counts, and its event id orders the red against the holder's later facts [P7,C7].
 *
 * @param {{ db: import('node:sqlite').DatabaseSync }} board
 * @param {number} item
 * @param {{ runs?: { db: import('node:sqlite').DatabaseSync } | null }} [options] - runs: the board's runs holder (boardRunsHolder) while runs_store is on, so the gate's job rows are read from the runs file; null reads the board's [B2,P7,#9150].
 * @returns {{ eventId: number, commit: string, failures: { file?: string, name?: string }[] }[]}
 */
export function pulledGateReds(board, item, { runs = null } = {}) {
  const home = runs ? runs.db : board.db;
  let jobs;
  try { jobs = home.prepare("SELECT job_id, job_candidate FROM job WHERE job_kind = 'gate' AND job_item = ? AND job_step = 'done' ORDER BY job_created, rowid").all(item); }
  catch (error) { if (/no such table/u.test(error.message)) return []; throw error; }
  const redFact = board.db.prepare("SELECT MAX(event_id) AS id FROM event WHERE item_id = ? AND event_kind = 'fact' AND json_extract(event_detail, '$.text') LIKE ?");
  const reds = [];
  for (const job of jobs) {
    const receipt = postedReceipt(home, job.job_id)?.receipt;
    // Only a test phase that ran and failed is a red loop; an analysis refusal or an infrastructure stop is not the item's code.
    const failed = (receipt?.gate?.phases ?? []).filter(phase => phase.status !== 0);
    const fact = job.job_candidate && failed.length ? redFact.get(item, `Gate job ${job.job_id} red at %`)?.id : null;
    if (fact) reds.push({ eventId: fact, commit: job.job_candidate, failures: failed.flatMap(phase => phase.failures ?? phase.errors ?? []) });
  }
  return reds;
}

/** The job's kind, item, candidate, base, frozen check and the submit fields its offer recorded; null when the job is gone. runs: as latestGateJob [#9149]. */
function offeredGate(db, job, { runs = null } = {}) {
  db = runs ? runs.db : db;
  const row = db.prepare(`SELECT job.job_kind, job.job_item, job.job_candidate, job.job_base, step.job_step_payload FROM job JOIN job_step AS step
    ON step.job_step_job = job.job_id AND step.job_step_name = 'offered' AND step.job_step_seq = 0 WHERE job.job_id = ?`).get(job);
  if (!row) return null;
  const request = offeredRequest(db, job);
  return { kind: row.job_kind, item: row.job_item, candidate: row.job_candidate, main: row.job_base, submit: request?.submit ?? null,
    check: typeof request?.input?.data?.check === 'string' ? request.input.data.check : null };
}

// Exported by name, not inline: the dispatch-gates operation check reads an `export function offer...Gate` as a second dispatch entry [C7,#9149].
export { offeredGate };

/** The submit phase each gate-job phase proves, as today's submit names its native receipts. */
const SUBMIT_PHASES = { check: 'criterion', proof: 'proof' };

/** TAP or Node reporter totals from a phase's output tail; any count not printed stays unknown, never zero. */
function tailCounts(text) {
  const found = {};
  for (const line of String(text ?? '').split(/\r?\n/u)) {
    const match = /^(?:#|\u2139)\s+(pass|fail|skipped)\s+(\d+)$/u.exec(line.trim());
    if (match) found[{ pass: 'passed', fail: 'failed', skipped: 'skipped' }[match[1]]] = Number(match[2]);
  }
  return { passed: found.passed ?? null, failed: found.failed ?? null, skipped: found.skipped ?? null };
}

/**
 * Write the timing receipt of a pulled gate the runner held exclusively, in the board's gate receipt log where a local
 * gate slot writes it, so `pullboard stats` and review read one timing record whichever machine ran the gate.
 * Why only a runner-posted `timing: true` receipt: the runner alone saw its slots, and its exclusive evidence is
 * what the frozen bar's timing asked for [C7,#8188].
 */
function recordTimedSubmitReceipt(board, { job, receipt, runner }) {
  const recordReceipt = board.runtimePorts?.sourceAdvanceReceipts?.recordReceipt;
  if (receipt?.timing !== true || !board.gitRoot || typeof recordReceipt !== 'function') return;
  const admitted = Date.parse(receipt.admittedAt), finished = Date.parse(receipt.finishedAt);
  if (!Number.isFinite(admitted) || !Number.isFinite(finished) || finished < admitted || receipt.exclusive !== true) return;
  recordReceipt(board.gitRoot, { at: receipt.finishedAt, kind: 'submit', waitMs: 0, admissionMs: 0, setupMs: 0, runMs: finished - admitted, evidenceMs: 0,
    slot: { kind: 'runner', reason: `runner ${runner ?? 'unknown'} held every slot for the timed gate` }, environment: receipt.gate?.environment ?? null,
    runner: { id: runner ?? 'unknown', kind: 'pull' }, admittedAt: receipt.admittedAt, finishedAt: receipt.finishedAt, timing: true, inherited: false,
    timingOperation: 'submit', occupiedSlots: Number.isSafeInteger(receipt.occupiedSlots) && receipt.occupiedSlots > 0 ? receipt.occupiedSlots : 1, load: null,
    exclusive: true, unfencedClients: Array.isArray(receipt.unfencedClients) ? receipt.unfencedClients : [], job });
}

/**
 * Record a green gate job's phases as the item's native proof-run receipts, the evidence today's submit records and
 * pullboard show lists: one version-two submit receipt per phase, stored in the board's gate receipt folder beside
 * its database and then bound to the item by recordProofRun, so the board reads the same bytes it stored.
 *
 * Why the board host writes them: the runner holds the job's lease token, and the receipt it posted under that token
 * is the run's own report; the board stamps the item, seat and bar the job was offered for [P7]. A companion submit's
 * receipts name its composed tree, the source the gate judged.
 *
 * runs: the board's runs holder while runs_store is on, so the posting runner is read from the runs file [B2,P7,#9150].
 *
 * @returns {{ id: string, role: string, command: string }[]} the receipts recorded, in phase order: id, submit phase and command digest
 */
export function recordPhaseReceipts(board, { job, receipt, id, candidate, main, submit, check, admission = null, runs = null }) {
  const { boardReceiptStore, receiptBody } = board.runtimePorts?.sourceAdvanceReceipts ?? {};
  const folder = typeof boardReceiptStore === 'function' ? boardReceiptStore(board) : null;
  if (!folder) return [];
  const gate = receipt.gate ?? {};
  const runner = (runs ? runs.db : board.db).prepare("SELECT job_step_payload FROM job_step WHERE job_step_job = ? AND job_step_name = 'receipt' ORDER BY job_step_seq DESC LIMIT 1").get(job);
  const runnerName = runner ? JSON.parse(runner.job_step_payload).runner ?? null : null;
  const environment = gate.environment && ['node', 'platform', 'arch'].every(key => typeof gate.environment[key] === 'string' && gate.environment[key])
    ? { node: gate.environment.node, platform: gate.environment.platform, arch: gate.environment.arch } : null;
  // A plain submit's receipts are reusable by review: they name the admission witness and the plan they ran [C7,H16].
  const reuse = admission ? { submitAdmission: admission.id, submitReuse: true, submitReusePlan: reusePlanDigest({ check: check ?? '', files: pulledProofFiles(receipt), full: gate.full === true, deferred: gate.deferred === true,
    proofCommand: gate.analysis?.proofCommand ?? '' }) } : {};
  const ids = [];
  for (const phase of gate.phases ?? []) {
    const submitPhase = SUBMIT_PHASES[phase.role];
    if (!submitPhase || phase.status !== 0) continue;
    const command = phase.role === 'check' ? check : gate.analysis?.proofCommand;
    // The runner's own per-case outcomes; the receipt body refuses malformed ones, and then the phase records none and maps no clause to a run.
    const testOutcomes = Array.isArray(phase.testOutcomes) ? phase.testOutcomes : null;
    // The runner's own child runtimes, as the controller gate's capture records them; the receipt body refuses malformed ones [C7].
    const testRuntimes = Array.isArray(phase.testRuntimes) && phase.testRuntimes.length ? phase.testRuntimes : null;
    const run = { version: 2, id: phaseReceiptId(job, phase.role), kind: 'submit', tree: submit.companion?.tree ?? submit.tree, head: candidate, main,
      command: createHash('sha256').update(String(command ?? phase.role)).digest('hex'), green: true, failures: [], load: null, at: new Date().toISOString(), ...(testOutcomes ? { testOutcomes } : {}),
      proof: { item: id, frozenDigest: submit.digest ?? null, seat: submit.agentId, runner: runnerName, exitCode: phase.status,
        durationMs: Number.isSafeInteger(gate.steps?.[phase.role]) && gate.steps[phase.role] >= 0 ? gate.steps[phase.role] : 0,
        sourceClean: true, environment, counts: tailCounts(phase.tail), submitPhase, ...(testRuntimes ? { testRuntimes } : {}), ...reuse } };
    let body = receiptBody(run);
    if (!body && testOutcomes) { delete run.testOutcomes; body = receiptBody(run); }
    if (!body && testRuntimes) { delete run.proof.testRuntimes; body = receiptBody(run); }
    if (!body) continue;
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    writeFileSync(join(folder, run.id + RECEIPT_EXT), body, { mode: 0o600, flag: 'wx' });
    store.recordProofRun(board, { agentId: submit.agentId, itemId: id, receiptId: run.id });
    ids.push({ id: run.id, role: submitPhase, command: run.command });
  }
  return ids;
}

/**
 * The digest review recomputes to match a submit's receipts to its plan: the same bytes as verify's submitReusePlanDigest
 * (packages/verify/src/logic/plan.js), restated here because this cell may not import verify; the review-reuse journey
 * fails when they drift [C7,H16].
 */
function reusePlanDigest({ check, files, full = false, deferred = false, proofCommand }) {
  return createHash('sha256').update(JSON.stringify({ check: check || '', files: [...files].sort(), full, deferred, proofCommand: proofCommand || '' })).digest('hex');
}

/** The files a pulled gate's proof ran, as its analysis named them. */
function pulledProofFiles(receipt) {
  return Array.isArray(receipt?.gate?.analysis?.proofFiles) ? receipt.gate.analysis.proofFiles.filter(file => typeof file === 'string' && PROJECT_FILE.test(file)) : [];
}

/**
 * Record the submit admission a green pulled gate's receipts are reusable under: a renewal of the builder's own live claim
 * that names the judged commit and tree, the witness the controller's submit recorded when its gate was admitted.
 * Why: review reuses a submit's proof only from receipts linked to such a witness (reusableSubmitProof) [C7,H16].
 * When the seat's newest claim event already carries a witness for the same commit and tree that no other job's receipt
 * names, that witness is returned and no new one is minted: a second admission after the first apply's receipts left
 * review finding no receipt after the newest admission, so it re-ran the tiers (#10862, #10954) [C7,P7].
 *
 * @returns {{ id: string, commit: string, tree: string } | null} The witness, or null when the claim cannot take one (the submit still applies).
 */
function recordSubmitAdmission(board, { id, item, candidate, submit, job = null }) {
  const left = Date.parse(item.item_lease_until) - board.clock.now().getTime();
  if (!(left > 0)) return null;
  const tree = submit.companion?.tree ?? submit.tree;
  const held = liveAdmission(board, { id, agentId: submit.agentId, commit: candidate, tree, job });
  if (held) return held;
  const witness = { id: randomUUID(), commit: candidate, tree };
  try {
    store.admitSubmit(board, id, { agentId: submit.agentId, lane: item.item_lane, leaseMs: left, freeze: () => null, submitAdmission: witness });
    return witness;
  } catch (error) {
    if (!error?.code) throw error;
    return null;
  }
}

/**
 * The witness the seat's newest claim or renewal carries, when it names this commit and tree and every proof-run receipt
 * linked to it is this gate job's own (phaseReceiptId), so reusing it never makes a phase's receipt ambiguous; else null.
 */
function liveAdmission(board, { id, agentId, commit, tree, job }) {
  const newest = board.db.prepare("SELECT event_id AS at, event_detail AS detail FROM event WHERE item_id = ? AND event_by = ? AND event_kind IN ('claim', 'renew') ORDER BY event_id DESC LIMIT 1").get(id, agentId);
  let witness = null;
  try { witness = newest ? JSON.parse(newest.detail).submitAdmission ?? null : null; } catch { return null; }
  if (!witness?.id || witness.commit !== commit || witness.tree !== tree) return null;
  const own = new Set(Object.keys(SUBMIT_PHASES).map(role => job ? phaseReceiptId(job, role) : null));
  const runs = board.db.prepare("SELECT event_detail AS detail FROM event WHERE item_id = ? AND event_kind = 'proof-run' AND event_id > ?").all(id, newest.at);
  for (const row of runs) {
    let run = null;
    try { run = JSON.parse(row.detail).receipt ?? null; } catch { continue; }
    if (run?.submitAdmission === witness.id && !own.has(run.id)) return null;
  }
  return { id: witness.id, commit: witness.commit, tree: witness.tree };
}

/** The offer a job was made with, its request read back whole, or null. runs: as latestGateJob [#9149]. */
export function offeredStep(db, job, { runs = null } = {}) {
  db = runs ? runs.db : db;
  const row = db.prepare("SELECT job_step_payload FROM job_step WHERE job_step_job = ? AND job_step_name = 'offered' AND job_step_seq = 0").get(job);
  return row ? { ...readPayload(db, row.job_step_payload), request: offeredRequest(db, job) } : null;
}

/**
 * The newest receipt posted for a job, or null. runs: as latestGateJob [#9149].
 * Why readPayload: a step over the jobs store's blob threshold is kept as a blob stub, so a gate receipt joined from
 * parts (#10771) read raw named no proofPlan and its last shard applied nothing (#10181) [C7,P7].
 */
export function postedReceipt(db, job, { runs = null } = {}) {
  db = runs ? runs.db : db;
  const row = db.prepare("SELECT job_step_payload FROM job_step WHERE job_step_job = ? AND job_step_name = 'receipt' ORDER BY job_step_seq DESC LIMIT 1").get(job);
  return row ? readPayload(db, row.job_step_payload) : null;
}

/** Quote one word for a shell, as the gate's planner quotes the files it names. */
function shellWord(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/** The shard jobs offered for one gate job, oldest first. runs: the board's runs holder (boardRunsHolder) while runs_store is on, so the rows are read from the runs file; null reads the board's [B2,P7,#9151]. */
export function shardJobs(db, job, { runs = null } = {}) {
  const prefix = `${job}:shard:`;
  return (runs ? runs.db : db).prepare('SELECT job_id, job_step FROM job WHERE job_kind = ? AND substr(job_id, 1, ?) = ? ORDER BY job_created, job_id').all(SHARD_JOB_KIND, prefix.length, prefix);
}

/** The note's words for the shards that hold a runner alone; none when no file is timing. */
const timed = buckets => {
  const alone = buckets.filter(bucket => bucket.timing).length;
  return alone ? ` (${alone} of them a timing file holding its runner alone)` : '';
};

/**
 * Offer a gate's proof as shard jobs: its plan's files split round-robin into one shard per runner's worth of cores,
 * each a job any runner pulls and runs through the gate's own bootstrap and entry. Null when the plan is not one the
 * board can split. Why the board offers them: it already holds the queue, so runners never need offer credentials [P7].
 * Each file the plan names under timing runs as a shard of its own whose data carries checkTiming, so its runner holds it alone (proofBuckets) [C7].
 *
 * @returns {{ applied: true, outcome: 'sharded', shards: string[] } | null}
 */
export function offerProofShards(board, { job, receipt, offered }) {
  const gate = receipt?.gate ?? {};
  const plan = gate.proofPlan;
  const files = Array.isArray(plan?.files) ? plan.files : [];
  const cores = Number.isSafeInteger(plan?.cores) && plan.cores > 0 ? plan.cores : 0;
  if (receipt?.status === undefined || gate.error || gate.analysis?.infra || gate.analysis?.refusals?.length || (gate.phases ?? []).some(phase => phase.status !== 0)
    || typeof plan?.runner !== 'string' || !plan.runner.trim() || /[\0\n\r]/u.test(plan.runner) || !cores
    || files.some(file => typeof file !== 'string' || !PROJECT_FILE.test(file))) return null;
  const buckets = proofBuckets(files, cores, plan.timing, MAX_SHARDS);
  if (!buckets.length) return null;
  // With runs_store on the gate job and its shards live in the runs file; the ledger stays on the board [B2,P7].
  const queue = queueFor(board, 'coordinator');
  const request = offeredStep(queue ? queue.runs.db : board.db, job);
  const gateRequest = request?.request;
  if (!Array.isArray(gateRequest?.run) || typeof gateRequest.input?.entry !== 'string') return null;
  const count = buckets.length;
  // A plan that names the files needing a browser or a GUI lets each shard carry its own need, so the board hands the runner what it must hold [C7].
  const needs = plan.needs && typeof plan.needs === 'object' ? plan.needs : null;
  const needing = (list, part) => Array.isArray(list) && part.some(file => list.includes(file));
  const ids = buckets.map(({ files: part, timing }, index) => {
    const command = `${plan.runner.trim()} ${part.map(file => shellWord('./' + file)).join(' ')}`;
    // Each shard carries the ledger's proven rows for its own files; its runner runs only the misses [P7,CD2].
    const ledger = store.ledgerHits(board.db, part, { budget: 16_000 });
    return offerJob(board.db, { id: `${job}:shard:${index + 1}`, kind: SHARD_JOB_KIND, priority: 'gate', needs: request.needs ?? [], item: offered.item, candidate: offered.candidate, base: offered.main,
      request: { run: gateRequest.run, gate: job, commits: gateRequest.commits ?? [],
        input: { main: offered.main, entry: gateRequest.input.entry, data: { main: offered.main, source: offered.candidate, ...(timing ? { checkTiming: true } : {}), shard: { index: index + 1, of: count, files: part, command, ...(plan.account === true ? { account: true } : {}), ...(ledger ? { ledger } : {}), ...(needs ? { plan: { browser: needing(needs.browser, part), gui: needing(needs.gui, part) } } : {}) } } } } }, queue).id;
  });
  store.appendFact(board, offered.item, { agentId: offered.submit.agentId, kind: 'note',
    text: `Gate job ${job} passed its checks at ${offered.candidate.slice(0, 12)}; its proof of ${files.length} files is offered as ${count} shard jobs any runner pulls${timed(buckets)}, and the gate result applies when the last one posts.` });
  return { applied: true, outcome: 'sharded', shards: ids };
}

/**
 * One red shard's own account: each `not ok` case its TAP printed, by file and name, and the full log its runner kept.
 * Why: a shard's tail often ends on its passing subtests, so without these no one can name the failing test [C7].
 */
function redShard(part) {
  const phase = part.phase ?? {};
  const rows = Array.isArray(phase.errors) && phase.errors.length ? phase.errors : Array.isArray(phase.failures) ? phase.failures : [];
  const cases = rows.filter(row => typeof row?.name === 'string' && row.name)
    .map(row => ({ file: typeof row.file === 'string' && row.file ? row.file : null, name: row.name }));
  const omitted = Math.max(0, (Number(phase.errorCount) || rows.length) - cases.length);
  const folder = typeof part.output?.folder === 'string' && part.output.folder ? part.output.folder : null;
  // The proof phase's own log when the gate entry kept one, else the job's whole output the runner kept beside it.
  const log = folder ? join(folder, typeof phase.kept === 'string' && /^[\w.-]+$/u.test(phase.kept) ? phase.kept : 'job.log') : null;
  return { job: part.job, runner: part.output?.runner ?? part.runner, log, cases, omitted };
}

/**
 * The gate receipt the shards of one proof make together: the gate's own receipt with one proof phase that is green
 * only when every shard is, naming every failing case its red shards name (none when any red shard names none).
 * With `signatures` (gate.settleOnMainReceipt), the cases keep their shards' diagnostic signatures, so a case main fails
 * the same way reads main-owned instead of new [C7,#9057]. A shard named in `mainRed` counts as green (#12215).
 */
export function combinedReceipt(gateReceipt, shards, { signatures = false, mainRed = null } = {}) {
  const gate = gateReceipt.gate ?? {};
  const parts = shards.map(({ job, posted, ended = null }) => {
    const shardGate = posted?.receipt?.gate ?? {};
    const phase = (shardGate.phases ?? []).find(row => row.role === 'proof') ?? null;
    const green = mainRed?.has(job) === true || (posted?.receipt?.status === 0 && shardGate.green === true && phase?.status === 0);
    return { job, runner: posted?.runner ?? null, green, phase, error: shardGate.error ?? null, files: shardGate.shard?.files?.length ?? null, ms: shardGate.steps?.proof ?? 0,
      output: posted?.receipt?.output ?? null, ended: typeof ended === 'string' && ended ? ended : null };
  });
  const reds = parts.filter(part => !part.green);
  const counts = parts.map(part => tailCounts(part.phase?.tail));
  const sum = key => counts.every(row => row[key] !== null) ? counts.reduce((total, row) => total + row[key], 0) : null;
  const totals = [['pass', sum('passed')], ['fail', sum('failed')], ['skipped', sum('skipped')]].filter(([, n]) => n !== null).map(([name, n]) => `# ${name} ${n}`);
  const tail = [...reds.map(part => `shard ${part.job}: ${String(part.error ?? (part.phase?.exit || part.phase?.tail) ?? (part.ended ? `ended: ${part.ended}` : 'no proof phase')).slice(-PART_TEXT)}`), ...totals].join('\n');
  const failures = reds.length && reds.every(part => Array.isArray(part.phase?.failures) && part.phase.failures.length) ? reds.flatMap(part => part.phase.failures) : null;
  const signed = signatures && failures ? reds.flatMap(part => part.phase.failures.map((_, index) => part.phase.failureSignatures?.[index] ?? null)) : null;
  const proof = { role: 'proof', status: reds.length ? (reds.find(part => part.phase?.status)?.phase.status ?? 1) : 0, signal: reds.find(part => part.phase?.signal)?.phase.signal ?? null,
    sha256: createHash('sha256').update(parts.map(part => part.phase?.sha256 ?? '').join('\n')).digest('hex'), bytes: parts.reduce((total, part) => total + (part.phase?.bytes ?? 0), 0), tail,
    ...(reds.length ? { failures, ...(signed ? { failureSignatures: signed } : {}), shardReds: reds.map(redShard), errors: reds.flatMap(part => Array.isArray(part.phase?.errors) ? part.phase.errors : []),
      errorCount: reds.reduce((total, part) => total + (part.phase?.errorCount ?? part.phase?.errors?.length ?? 0), 0) } : {}) };
  const { proofPlan, ...rest } = gate;
  const green = !reds.length;
  return { ...gateReceipt, status: green ? 0 : 1, gate: { ...rest, green, phases: [...(gate.phases ?? []), proof], steps: { ...gate.steps, proof: Math.max(0, ...parts.map(part => Number(part.ms) || 0)) },
    shards: parts.map(part => ({ job: part.job, runner: part.runner, green: part.green, files: part.files })) } };
}

/**
 * Apply one shard's receipt: nothing until every shard of its gate has posted, then the shards' combined receipt as
 * the gate's result, red when any shard is red. Why at the last post: the gate result is one record, never a partial proof [P7].
 *
 * @returns {{ applied: boolean, outcome: string, remaining?: number }}
 */
export function applyShardReceipt(board, { job }, ports = {}) {
  const parent = offeredRequest(board.db, job)?.gate;
  if (typeof parent !== 'string') return { applied: false, outcome: 'not-shard' };
  const every = shardJobs(board.db, parent);
  // The one retry shard (gate.retryNewRedsOnce) is no part of the proof's own split; it only replaces red shards when green [C7,P7].
  const retry = every.find(row => row.job_id === retryShardId(parent)) ?? null;
  const shards = every.filter(row => row !== retry);
  const remaining = every.filter(row => row.job_step !== 'done').length;
  if (remaining) return { applied: false, outcome: 'waiting', remaining };
  const gateReceipt = postedReceipt(board.db, parent)?.receipt;
  if (!gateReceipt?.gate?.proofPlan) return { applied: false, outcome: 'not-shard' };
  const now = Number.isFinite(ports.receiptNow) ? ports.receiptNow : Date.now();
  // The last shard's post and every board process's claim reconcile reach here at once; one claims the apply, the rest return (#10862) [C7,P7].
  if (!claimShardSettle(board.db, parent, now)) return { applied: false, outcome: 'already-settling' };
  const signatures = { signatures: ports.settleOnMainReceipt === true };
  const parts = shards.map(row => { const posted = postedReceipt(board.db, row.job_id); return { job: row.job_id, posted, ended: posted ? null : endedDetail(board.db, row.job_id) }; });
  let combined = combinedReceipt(gateReceipt, parts, signatures);
  let retried = null, mainRed = null;
  try {
    // A red whose every failing case main already fails settles green, naming those files in a note [C7,#12215].
    const compared = retry || combined.status === 0 ? null : compareGateWithMain(board, combined, offeredGate(board.db, parent)?.main, ports.compareWithMain ?? null);
    if (compared?.cases.length && compared.cases.every(row => row.onMain === true)) { mainRed = [...new Set(compared.cases.map(row => row.file))]; combined = combinedReceipt(gateReceipt, parts, { ...signatures, mainRed: new Set(parts.map(part => part.job)) }); } else if (retry) {
      // A green retry replaces the red shards it reran; a red one leaves the original red as it was.
      const posted = postedReceipt(board.db, retry.job_id);
      const shardGate = posted?.receipt?.gate ?? {};
      if (posted?.receipt?.status === 0 && shardGate.green === true && (shardGate.phases ?? []).find(row => row.role === 'proof')?.status === 0) {
        const green = part => part.posted?.receipt?.status === 0 && part.posted.receipt.gate?.green === true && (part.posted.receipt.gate.phases ?? []).find(row => row.role === 'proof')?.status === 0;
        combined = combinedReceipt(gateReceipt, [...parts.filter(green), { job: retry.job_id, posted }], signatures);
        retried = shardGate.shard?.files ?? [];
      }
    } else if (ports.retryNewRedsOnce === true && combined.status !== 0) {
      if (compared && retryNewReds(board, { parent, combined, compared }).retried) {
        // The retry's post applies the result, so this claim is handed back and nothing is noted settled.
        noteLease(board.db, parent, SHARDS_SETTLING, { released: true }, now);
        return { applied: false, outcome: 'retrying' };
      }
    }
  } catch (error) {
    noteLease(board.db, parent, SHARDS_SETTLING, { released: true }, now);
    throw error;
  }
  let applied;
  try { applied = applyGateReceipt(board, { job: parent, receipt: combined }, ports); }
  catch (error) {
    // A refused apply hands the claim back, so the next claim's reconcile tries it again (#10181).
    noteLease(board.db, parent, SHARDS_SETTLING, { released: true }, now);
    throw error;
  }
  // The parent notes it settled, whatever the outcome, so settleDoneShardGates never applies it twice [C7,P7].
  noteLease(board.db, parent, SHARDS_SETTLED, { outcome: applied.outcome }, now);
  if (applied.outcome === 'review' && (retried || mainRed)) shardNote(board, offeredGate(board.db, parent), retried
    ? `Gate job ${parent}: a red only in new cases was rerun once by the board for ${retried.join(', ') || 'its failing files'}, and the rerun passed.`
    : `Gate job ${parent}: every red shard failed only in files main already fails (main-red: ${mainRed.join(', ')}), so the gate settles green.`);
  return applied;
}

/**
 * The detail of a shard job's withdrawn step, or null when it was never withdrawn. Why: a shard ended unrun (endStaleShardOffers)
 * posts no receipt, and its gate's red should say why it ended and what to do, not only that no proof phase ran (#12166).
 */
function endedDetail(db, job) {
  const row = db.prepare("SELECT job_step_payload FROM job_step WHERE job_step_job = ? AND job_step_name = 'withdrawn' ORDER BY job_step_id DESC LIMIT 1").get(job);
  if (!row) return null;
  try { const detail = readPayload(db, row.job_step_payload)?.detail; return typeof detail === 'string' && detail ? detail : null; } catch { return null; }
}

/** The note step a sharded gate job carries once its shards' combined result was applied (noteLease prefixes `note:`). */
const SHARDS_SETTLED = 'shards.settled';
/** The note step the one process applying a sharded gate's result holds while it applies. */
const SHARDS_SETTLING = 'shards.settling';
// Budget: a settle claim a process holds this long without its settled note is a lost process's; the next claim takes it over [P7].
const SETTLING_LEASE_MS = 10 * 60_000;

/**
 * Claim the one apply of a sharded gate's result: in one immediate transaction, which serializes every process on the
 * board file, note it settling unless it is settled or another live claim holds it. True when this caller won.
 * Why: the apply ran before its settled note was written, so concurrent appliers each minted a submit admission and
 * only the first one's receipts were recorded; review then found no receipt after the newest admission (#10862) [C7,P7].
 */
function claimShardSettle(db, job, now) {
  return atomically(db, () => {
    const rows = db.prepare('SELECT job_step_name AS name, job_step_at AS at, job_step_payload AS payload FROM job_step WHERE job_step_job = ? AND job_step_name IN (?, ?)').all(job, `note:${SHARDS_SETTLED}`, `note:${SHARDS_SETTLING}`);
    if (rows.some(row => row.name === `note:${SHARDS_SETTLED}`)) return false;
    const held = row => row.name === `note:${SHARDS_SETTLING}` && !/"released":true/u.test(row.payload) && now - row.at < SETTLING_LEASE_MS;
    if (rows.some(held)) return false;
    noteLease(db, job, SHARDS_SETTLING, { pid: process.pid }, now);
    return true;
  });
}
// Budget: the reconcile looks back one day for a sharded gate whose last apply was lost; an older claim has a newer gate or none.
const SETTLE_LOOKBACK_MS = 24 * 60 * 60_000;

/**
 * Settle every sharded gate whose shards are all done but whose result never applied: the newest gate job of a claimed
 * item, done, with shard jobs, none open, and no settled note. Each applies through applyShardReceipt as if its last
 * shard had just posted, so a stale claim still reads stale and records nothing. Why: the apply runs after the receipt
 * is recorded, so a coded throw there or a lost process left the item GATE_WAITING forever (#10181) [C7,P7].
 * With runs_store on the shards live in the runs file, which applyShardReceipt does not read, so nothing runs.
 *
 * @param {any} board
 * @param {Parameters<typeof applyShardReceipt>[2]} [ports]
 * @param {{ now?: number }} [options]
 * @returns {{ job: string, outcome: string }[]} the gate jobs settled and their outcomes
 */
export function settleDoneShardGates(board, ports = {}, { now = Date.now() } = {}) {
  if (queueFor(board, 'coordinator')) return [];
  const { db } = board;
  const rows = db.prepare(`SELECT job.job_id AS job, job.job_item AS item FROM item JOIN job ON job.job_item = item.item_id
    WHERE item.item_status = 'claimed' AND job.job_kind = 'gate' AND job.job_step = 'done' AND job.job_created >= ?
      AND NOT EXISTS (SELECT 1 FROM job_step WHERE job_step_job = job.job_id AND job_step_name = ?)`).all(now - SETTLE_LOOKBACK_MS, `note:${SHARDS_SETTLED}`);
  const settled = [];
  for (const { job, item } of rows) {
    if (latestGateJob(db, item) !== job) continue;
    const shards = shardJobs(db, job);
    if (!shards.length || shards.some(row => row.job_step !== 'done')) continue;
    try {
      const applied = applyShardReceipt(board, { job: shards[shards.length - 1].job_id }, { ...ports, receiptNow: now });
      // A gate whose own receipt holds no proof plan has nothing to combine; its note keeps later claims from reading it again.
      if (applied.outcome === 'not-shard') noteLease(db, job, SHARDS_SETTLED, { outcome: applied.outcome }, now);
      settled.push({ job, outcome: applied.outcome });
    } catch (error) {
      // One gate's refusal never stops the claim that ran the reconcile; the next claim tries it again.
      if (!error?.code) throw error;
    }
  }
  return settled;
}

/** Where each red shard of a phase keeps its full log, one line per shard. */
function shardLogLines(phase) {
  return (Array.isArray(phase?.shardReds) ? phase.shardReds : [])
    .map(red => `${phase.role} shard ${red.job} log: ${red.log ? `${red.log} on runner ${red.runner ?? 'unknown'}` : `none kept on runner ${red.runner ?? 'unknown'}`}`);
}

/** One line per part that failed: analysis refusals, each failing case of a red phase (the lines that explain its exit when it names none), or the job's own error. */
export function failingParts(receipt, { receiptMissingCause = false } = {}) {
  const gate = receipt?.gate ?? {};
  const clip = text => String(text ?? '').replace(/\s+/gu, ' ').trim().slice(-PART_TEXT);
  const parts = [];
  // The job's own error leads with its reason and first failing cases, so a long file list loses its tail, never its head (#9429).
  const flat = text => String(text ?? '').replace(/\s+/gu, ' ').trim();
  const missing = gate.error && receiptMissingCause === true ? missingReceiptPart(gate.error) : null;
  if (missing) parts.push(missing);
  else if (gate.error) parts.push(`gate: ${flat(gate.error).length > PART_TEXT ? `${flat(gate.error).slice(0, PART_TEXT)} ...` : flat(gate.error)}`);
  if (gate.analysis?.infra) parts.push(`infrastructure: ${clip(typeof gate.analysis.infra === 'string' ? gate.analysis.infra : JSON.stringify(gate.analysis.infra))}`);
  for (const refusal of gate.analysis?.refusals ?? []) parts.push(`${refusal.part} ${refusal.code ?? 'REFUSED'}: ${clip(refusal.message)}`);
  if (gate.analysis?.ownership) parts.push(`authorization OUTSIDE_LANE: ${clip(gate.analysis.ownership.message)}`);
  for (const phase of gate.phases ?? []) {
    if (phase.status === 0) continue;
    // A phase whose receipt names its cases lists them as the controller gate does, file :: case name.
    const cases = Array.isArray(phase.failures) ? phase.failures.filter(row => typeof row?.file === 'string' && row.file && typeof row.name === 'string' && row.name) : [];
    if (cases.length) parts.push(...cases.map(row => `${phase.role} failed: ${row.file} :: ${clip(row.name)}`));
    // A red shard's own 'not ok' cases and its log path come ahead of any tail, which may show only passing subtests [C7].
    const reds = Array.isArray(phase.shardReds) ? phase.shardReds : [];
    if (!cases.length) for (const red of reds) {
      parts.push(...(red.cases ?? []).map(row => `${phase.role} not ok: ${row.file ? `${row.file} :: ` : ''}${clip(row.name)} (shard ${red.job})`));
      if (red.omitted) parts.push(`${phase.role} not ok: ${red.omitted} more in shard ${red.job}'s log`);
    }
    parts.push(...shardLogLines(phase));
    // A phase the runner found blocked by its environment is named by the controller's refusal code, never read as an ordinary red [C7].
    if (typeof phase.sandboxBlocked === 'string' && phase.sandboxBlocked) parts.push(`SANDBOX_BLOCKED: the environment refused ${clip(phase.sandboxBlocked)}. Ask the coordinator to bring this operation to the person, or run the gate outside the sandbox; keep the tests unchanged; to ask: pullboard shout coordinator --kind question "<the denied operation>" --decision`);
    // Why the exit lines first: a plain tail of a crashed proof ends on its closing counts, which name nothing.
    if (!cases.length) parts.push(`${phase.role} exited ${phase.status ?? phase.signal}: ${typeof phase.digest === 'string' && phase.digest ? phase.digest : clip(phase.exit || phase.tail)}`);
  }
  if (gate.proofPlan) parts.push('proof: the gate left its proof to shard jobs the board could not offer; submit again');
  if (!parts.length && receipt?.status !== 0) parts.push(`the gate job exited ${receipt?.status ?? receipt?.signal}`);
  return parts;
}

/**
 * Compare a red gate receipt's failing cases with main's receipts, as today's submit gate does: each case is marked
 * also failing on main (`onMain: true`), new (`false`), or unknown (`null`) when main has no receipt for its file yet,
 * in which case the lookup queues the main-test job that writes one. Nothing runs here.
 *
 * Why: a red that main also has is not the item's code, so it must never bounce the builder [P7,C7]. The lookup is a
 * port (the CLI's main-receipt lookup, which `pullboard serve` provides) since main's receipts belong to the
 * landing and drive cells, which the board API does not import.
 *
 * @param {any} board - The open board, gitRoot set to the board host's repository.
 * @param {Record<string, any>} receipt
 * @param {string} main - The accepted main the gate job was offered against.
 * @param {((request: { root: string, db: import('node:sqlite').DatabaseSync, main: string, cases: { file: string, name: string }[], inputKeys: Record<string, string> }) =>
 *   { classes: { file: string, owner: string, own: string[], receipt: unknown, job: string | null }[] } | null) | null} lookup
 * @param {{ excuseTiming?: boolean }} [options] - excuseTiming: a timing-table case that fails on both sides under one name reads onMain even when its signature differs, since its message carries measured milliseconds (#9755); a host may also turn it on for every comparison through provideTimingExcuse. Default off: nothing changes.
 * @returns {{ cases: { phase: string, file: string, name: string, signature: string | null, onMain: boolean | null, receipt: string | null }[], jobs: string[] } | null}
 *   null when the red is not only test cases (a job error, infrastructure, a refusal, a phase with no case account),
 *   when no lookup is given (gate.mainComparison off) or when main's receipts cannot be keyed.
 */
export function compareGateWithMain(board, receipt, main, lookup, options = {}) {
  const gate = receipt?.gate ?? {};
  if (typeof lookup !== 'function' || !board.gitRoot || !SHA.test(String(main)) || gate.error || gate.analysis?.infra || gate.analysis?.refusals?.length || gate.analysis?.ownership) return null;
  const red = (gate.phases ?? []).filter(phase => phase.status !== 0);
  if (!red.length || red.some(phase => !Array.isArray(phase.failures) || !phase.failures.length
    || phase.failures.some(row => typeof row?.name !== 'string' || !row.name || !PROJECT_FILE.test(row?.file ?? '')))) return null;
  // Each case carries its diagnostic signature from the receipt; a receipt that predates them carries null [V4,B3].
  const signed = (phase, index) => Array.isArray(phase.failureSignatures) && /^[0-9a-f]{64}$/u.test(phase.failureSignatures[index] ?? '') ? phase.failureSignatures[index] : null;
  const cases = red.flatMap(phase => phase.failures.map(({ file, name }, index) => ({ phase: String(phase.role), file, name, signature: signed(phase, index) })));
  let found = null;
  // Each failed file's test input key rides along, so a receipt from another main with the same closure answers [C7,SC11].
  try { found = lookup({ root: board.gitRoot, db: board.db, main, cases: cases.map(({ file, name }) => ({ file, name })), inputKeys: ledgerInputKeys(red) }); } catch (error) { if (!error?.code) throw error; }
  const classes = new Map((found?.classes ?? []).map(row => [row.file, row]));
  if (cases.some(row => !classes.has(row.file))) return null;
  const receiptId = value => typeof value === 'string' ? value : typeof value?.id === 'string' ? value.id : null;
  const excuse = options?.excuseTiming === true || (typeof timingExcuse === 'function' && timingExcuse() === true);
  return {
    cases: cases.map(row => {
      const one = classes.get(row.file);
      const named = one.owner === 'unknown' ? null : keyedMainFailing(board.db, receiptId(one.receipt));
      // Main fails the same case only when it fails it the same way: the name and the diagnostic signature both match, and an
      // unsigned case on either side differs, so a changed assertion is never excused by main's red of that name [V4,B3].
      // A main-test receipt keeps each name clipped, so a longer case is matched by that clip; the signature still has to agree (#7495).
      const clipped = row.name.slice(0, MAIN_CASE_NAME_UNITS);
      const signedSame = named ? named.some(main => main.name === clipped && main.signature !== null && main.signature === row.signature)
        : row.signature !== null && !one.own.includes(row.name);
      const byName = named ? named.some(main => main.name === clipped) : !one.own.includes(row.name);
      // With excuseTiming on, main's red of a timing-table case under the same name is the gate's red, whatever the measured milliseconds say (#9755).
      const same = signedSame || (excuse && byName && sameTimingRed(row, row));
      return { ...row, onMain: one.owner === 'unknown' ? null : same, ...(one.owner !== 'unknown' && byName && !same ? { differs: true } : {}), receipt: receiptId(one.receipt) };
    }),
    jobs: [...new Set([...classes.values()].map(row => row.job).filter(Boolean))],
  };
}

/**
 * The cases a main-test job's keyed receipt (step 0) records as failing on main, each name with its diagnostic signature
 * (null when the receipt has none, as a 0.9.3 receipt); null when the id names no such red receipt. Why: the comparison
 * cache keeps a main-test red as the whole file with no case names, so without this every case of a file a queued
 * main-test job measured red would read as new (#6229).
 */
function keyedMainFailing(db, id) {
  if (typeof id !== 'string') return null;
  const row = db.prepare(`SELECT step.job_step_payload FROM job_step AS step JOIN job ON job.job_id = step.job_step_job
    WHERE step.job_step_job = ? AND step.job_step_name = 'receipt' AND step.job_step_seq = 0 AND job.job_kind = ?`).get(id, MAIN_TEST_KIND);
  let keyed = null;
  try { keyed = row ? JSON.parse(row.job_step_payload) : null; } catch { keyed = null; }
  if (keyed?.verdict !== 'red' || !Array.isArray(keyed.failing) || !keyed.failing.length) return null;
  const signatures = Array.isArray(keyed.signatures) && keyed.signatures.length === keyed.failing.length ? keyed.signatures : [];
  return keyed.failing.map((name, index) => ({ name, signature: /^[0-9a-f]{64}$/u.test(signatures[index] ?? '') ? signatures[index] : null }));
}

/**
 * Who owns a red that main owns, as the controller's submit judges it: each case's single open Main red repair, the
 * files no open repair names, and whether only the frozen check was red. Why: a pulled gate must judge a frozen red
 * against main's receipts the way the controller gate's main-owned verdict does, linking repairs and asking for the rest [V4,B3,C7].
 */
function mainOwnership(board, id, compared, main) {
  // Each case keeps the diagnostic signature it matched main by, so the repair link names the exact failure, and the main
  // receipt that recorded it failing, so review cites it; a board on an older engine records no receipt id (#7495).
  const cites = (board.executionEngineVersion ?? store.ENGINE_VERSION) >= store.KNOWN_MAIN_RECEIPT_ENGINE;
  const failures = [...new Map(compared.cases.map(({ file, name, signature, receipt }) => [`${file}\0${name}`,
    { file, name, signature, ...(cites && typeof receipt === 'string' && receipt ? { receipt } : {}) }])).values()];
  const items = store.listItems(board, { all: true });
  const { clear, ambiguous } = store.splitAmbiguousMainReds({ main, failures }, items, id);
  const unowned = store.unownedMainReds(clear, items, id) ?? [];
  const owned = clear.failures.filter(row => !unowned.some(red => red.file === row.file));
  return { checkOnly: compared.cases.every(row => row.phase === 'check'), failures, unowned, ambiguous,
    known: owned.length ? store.linkKnownMainReworks({ main, failures: owned }, items, id) : null };
}

/**
 * File the derived repairs of main reds no open repair names, when accepted main's committed config opts in with
 * submit.autoFileMainReds; null when it does not or the board cannot file them, so the coordinator is asked instead.
 * Why main's file: the setting is accepted policy, never the submitter's own bytes [V4,B3,C7].
 */
function filePulledRepairs(board, { id, submit, main, unowned, receipt }) {
  if (!board.gitRoot || !SHA.test(String(main))) return null;
  let config = null;
  try { const shown = tryGit(board.gitRoot, ['show', `${main}:${CONFIG_FILE}`]); config = shown.status === 0 ? JSON.parse(shown.stdout) : null; } catch { config = null; }
  if (config?.submit?.autoFileMainReds !== true) return null;
  const errors = (receipt?.gate?.phases ?? []).flatMap(phase => Array.isArray(phase.errors) ? phase.errors : []);
  try {
    return store.filePulledMainReds(board, id, { agentId: submit.agentId, main, runner: config.affectedTests, lanes: config.lanes, unowned, errors });
  } catch (error) {
    // A repair the board refuses is named on the thread; the coordinator is asked to own the red instead.
    if (!error?.code) throw error;
    store.appendFact(board, id, { agentId: submit.agentId, kind: 'note', text: `Main red repair not filed: ${error.code}: ${error.message}`.slice(0, 2000) });
    return null;
  }
}

/** The decision shout asking the coordinator to own main reds no open repair names, bounded like the controller's. */
function unownedShout(id, unowned, main) {
  const prefix = `#${id}: known main red with no open Main red item: `;
  const suffix = ` fails identically on main at ${String(main).slice(0, 12)}; file or assign its repair. See pullboard show ${id}.`;
  const detail = Array.from(unowned.map(red => `${red.file} (${red.names.join('; ')})`).join('; '));
  const room = Math.max(0, 400 - Array.from(prefix + suffix).length);
  return prefix + (detail.length > room ? detail.slice(0, Math.max(0, room - 1)).join('') + '…' : detail.join('')) + suffix;
}

/** One line per compared case, saying whether main fails it too, the same way. */
function caseLines(compared) {
  return compared.cases.map(row => `${row.onMain === true ? 'also fails on main' : row.differs ? 'fails differently on main' : row.onMain === false ? 'new' : 'main receipt missing'}: ${row.phase} ${row.file} (${row.name})`);
}

/**
 * Pair every failing case of a red gate receipt with the person's live waiver covering it, or null. Only a red made
 * wholly of named test cases can be waived: a job error, infrastructure, a refusal, a phase with no case account, or
 * one case no live waiver covers voids it, so a waiver never hides another red. The item's own check (the criterion
 * phase) stays mandatory, as on the controller's submit gate [B3,R3,#655].
 *
 * @param {any} board
 * @param {Record<string, any>} receipt
 * @returns {{ phase: string, file: string, name: string, waiver: { id: string, kind: string, test: string, until: string, reason: string } }[] | null}
 */
function waivedCases(board, receipt) {
  const gate = receipt?.gate ?? {};
  if (gate.error || gate.analysis?.infra || gate.analysis?.refusals?.length || gate.proofPlan) return null;
  const red = (gate.phases ?? []).filter(phase => phase.status !== 0);
  if (!red.length || red.some(phase => ['criterion', 'check'].includes(phase.role) || !Array.isArray(phase.failures) || !phase.failures.length
    || phase.failures.some(row => typeof row?.name !== 'string' || !row.name || !PROJECT_FILE.test(row?.file ?? '')))) return null;
  const live = livePersonWaivers(board.db, board.clock.now().getTime());
  const cases = red.flatMap(phase => phase.failures.map(({ file, name }) => ({ phase: String(phase.role), file, name,
    waiver: live.findLast(waiver => store.landingWaiverCovers(waiver, { file, name })) ?? null })));
  return cases.every(row => row.waiver) ? cases : null;
}

/** One line per waived case: the person's waiver, its reason and its expiry, as the controller's submit names them [B3]. */
function waiverLines(cases) {
  return cases.map(({ phase, file, name, waiver }) => `waived: ${phase} ${name} (${file}) by person waiver ${waiver.id} for ${waiver.kind} ${waiver.test}: ${waiver.reason}; expires ${waiver.until}`);
}

/**
 * Accepted main's verify.inspectClauses, as the inline submit sealed it: main's normalized policy, else its committed
 * config file (on unless set false); false when neither reads. Why main's: the setting is accepted policy [C7,V4].
 */
function inspectsClauses(board, main) {
  if (!board.gitRoot || !SHA.test(String(main))) return false;
  try { return board.enginePorts.sandboxPolicyReads.policyAt(board.gitRoot, main).config.verify.inspectClauses === true; } catch { /* the committed file below */ }
  try { const shown = tryGit(board.gitRoot, ['show', `${main}:${CONFIG_FILE}`]); return shown.status === 0 && JSON.parse(shown.stdout)?.verify?.inspectClauses !== false; } catch { return false; }
}

/** Accepted main's verify.folderTicks (default off), read like inspectsClauses: a folder-named [test] clause is ticked by the gate-run tests under it (#8847) [C7]. */
function folderTicksAt(board, main) {
  try { return board.enginePorts.sandboxPolicyReads.policyAt(board.gitRoot, main).config.verify.folderTicks === true; } catch { /* the committed file below */ }
  try { const shown = tryGit(board.gitRoot, ['show', `${main}:${CONFIG_FILE}`]); return shown.status === 0 && JSON.parse(shown.stdout)?.verify?.folderTicks === true; } catch { return false; }
}

/** Accepted main's submit.edgeFollowUps (default off), read like folderTicksAt: a settled submit whose diff adds import edges files one follow-up (#8874) [C7]. */
function edgeFollowUpsAt(board, main) {
  try { return board.enginePorts.sandboxPolicyReads.policyAt(board.gitRoot, main).config.submit.edgeFollowUps === true; } catch { /* the committed file below */ }
  try { const shown = tryGit(board.gitRoot, ['show', `${main}:${CONFIG_FILE}`]); return shown.status === 0 && JSON.parse(shown.stdout)?.submit?.edgeFollowUps === true; } catch { return false; }
}

/** Accepted main's verify.titleTicks (default off), read like folderTicksAt: a [test] clause naming no file is ticked by the changed tests titled for it (#8880) [C7]. */
function titleTicksAt(board, main) {
  try { return board.enginePorts.sandboxPolicyReads.policyAt(board.gitRoot, main).config.verify.titleTicks === true; } catch { /* the committed file below */ }
  try { const shown = tryGit(board.gitRoot, ['show', `${main}:${CONFIG_FILE}`]); return shown.status === 0 && JSON.parse(shown.stdout)?.verify?.titleTicks === true; } catch { return false; }
}

/**
 * Record a settled pulled submission's clause checklist, as the inline submit did: a green gate's tick notes for each
 * [test] clause naming a file it ran green, then the "inspection, clause by clause:" summary for the reviewer [C7,V4].
 * The files are only those the gate's own phases ran, its proof files and every file an outcome names, so no clause is
 * ticked by a file the gate did not run.
 */
function recordClauseInspection(board, { id, receipt, head, agentId, green, folderTicks = false, titleTicks = false }) {
  const outcomes = (receipt?.gate?.phases ?? []).filter(phase => phase.status === 0).flatMap(phase => Array.isArray(phase.testOutcomes) ? phase.testOutcomes : [])
    .filter(row => row && typeof row.file === 'string' && typeof row.name === 'string');
  const gateFiles = new Set([...pulledProofFiles(receipt), ...outcomes.map(row => row.file)].filter(file => PROJECT_FILE.test(file)));
  store.clauseInspectionNotes(board, id, { gateFiles, outcomes, head, green, folderTicks, titleTicks }, text => store.appendFact(board, id, { agentId, kind: 'note', text }));
}

/** Budget: how many times a pulled gate's submission is prepared again after another board write overtook it. */
const SUBMIT_OVERTAKEN_TRIES = 5;

/**
 * Run operation with the board's mainPolicy reading the retained trunk branch's tip while the primary checkout is
 * detached for review. Why: a pulled gate's receipt applies inside a board API request whenever its job ends, often
 * while the coordinator verifies in the primary (every verify there detaches it); refusing there recorded a green gate
 * "passed but not submitted" and left the item claimed. The branch is read from the config file, never by spawning Git
 * on the request path; commands a person runs keep the refusal [C7,#8011].
 */
function withRetainedTrunkPolicy(board, operation) {
  const ports = board.enginePorts, reads = ports?.sandboxPolicyReads;
  if (!reads) return operation();
  /** Accepted main: the primary's branch, or the retained trunk's tip while the primary is detached. */
  const mainPolicy = root => {
    try { return reads.mainPolicy(root); }
    catch (error) {
      const branch = error?.code === 'NO_POLICY' && !mainCheckout(root) ? plainTrunkRef(root) : null;
      const commit = branch ? resolveCommit(root, branch) : null;
      if (!commit) throw error;
      return reads.policyAt(root, commit);
    }
  };
  board.enginePorts = { ...ports, sandboxPolicyReads: { ...reads, mainPolicy } };
  try { return operation(); } finally { board.enginePorts = ports; }
}

/**
 * store.submit, prepared again while another connection's write overtakes its preparation. Why: submit seals its
 * repository reads against a board snapshot and refuses BOARD_BUSY "changed while preparing" when any other command
 * wrote meanwhile; a receipt has no caller to retry it, so a green gate on a busy board was recorded as "passed but
 * not submitted" and its item stayed claimed until the builder ran the whole gate again [C7,#8011].
 */
function submitOvertaken(board, id, options) {
  for (let tries = 1; ; tries += 1) {
    try { return withRetainedTrunkPolicy(board, () => store.submit(board, id, options)); }
    catch (error) { if (error?.code !== 'BOARD_BUSY' || !/changed while preparing/u.test(String(error.message)) || tries >= SUBMIT_OVERTAKEN_TRIES) throw error; }
  }
}

/**
 * Apply one newly recorded gate-job receipt to its item. The receipt counts only while it is for the item's current
 * candidate: the newest gate job offered for the item, its source, still claimed by the seat that submitted it at the
 * same frozen bar. Anything else is stale: the receipt stays recorded on the job and the item is left as it is.
 *
 * Green records the item's submission at the candidate, as a green submit would, so it routes to review. A red whose
 * every failing case also fails on main is submitted the same way, with gateGreen false and the cases recorded for the
 * reviewer. Any other red keeps the item claimed by its builder, records the failing parts (each case marked new or
 * also failing on main) on its thread and shouts them to the builder.
 *
 * Why here: the receipt is the gate's result, and the board host only writes rows; it starts no process and no gate.
 *
 * @param {any} board - The open board, with gitRoot set when the board host holds the repository.
 * @param {{ job: string, receipt: Record<string, any> }} posted
 * @param {{ compareWithMain?: Parameters<typeof compareGateWithMain>[3] }} [ports] - the main-receipt lookup; absent, a red is not compared.
 * @returns {{ applied: boolean, outcome: 'review' | 'red' | 'stale' | 'not-gate', reason?: string, cases?: object[] }}
 */
export function applyGateReceipt(board, posted, ports = {}) {
  // Every policy read in the application, not only the submit, meets a detached primary: the receipt often applies while the coordinator verifies [C7,#8011].
  const applied = withRetainedTrunkPolicy(board, () => applyGateReceiptReads(board, posted, ports));
  // A settled gate carries the timing profiles its runner kept, as the inline submit's gate does [C7,#9615].
  const gate = applied.outcome === 'stale' || applied.outcome === 'not-gate' ? null : pulledProfilePaths(posted?.receipt);
  return gate ? { ...applied, gate } : applied;
}

/**
 * The kept timing profile files a pulled receipt names: its check and proof phase rows each carry `profileKept`, one plain
 * file name in the job's kept `output.folder`. Anything else (no folder, a path, `.`, `..`) is ignored, so a receipt can never
 * point the board outside the folder its runner kept.
 * Why: only the inline submit's gate exposed check.profilePath and proofProfilePath before [C7,#9615].
 *
 * @param {Record<string, any> | undefined} receipt
 * @returns {{ check?: { profilePath: string }, proofProfilePath?: string } | null} null when no phase names a kept profile.
 */
function pulledProfilePaths(receipt) {
  const folder = typeof receipt?.output?.folder === 'string' && receipt.output.folder ? receipt.output.folder : null;
  if (!folder) return null;
  const pathOf = role => {
    const name = (receipt.gate?.phases ?? []).find(row => row?.role === role)?.profileKept;
    return typeof name === 'string' && /^[\w.-]+$/u.test(name) && name !== '.' && name !== '..' ? join(folder, name) : null;
  };
  const check = pathOf('check'), proof = pathOf('proof');
  return check || proof ? { ...(check ? { check: { profilePath: check } } : {}), ...(proof ? { proofProfilePath: proof } : {}) } : null;
}

/** applyGateReceipt's body; its mainPolicy reads fall back to the retained trunk tip while the primary is detached. */
function applyGateReceiptReads(board, { job, receipt }, { compareWithMain = null, redLocation = false, receiptMissingCause = false, queue = null } = {}) {
  const offered = offeredGate(board.db, job);
  if (!offered || offered.kind !== 'gate' || !Number.isSafeInteger(offered.item)) return { applied: false, outcome: 'not-gate' };
  const { item: id, candidate, main, submit } = offered;
  const item = store.getItem(board, id);
  const stale = !submit ? 'the job carries no submit record'
    : latestGateJob(board.db, id) !== job ? 'a newer gate job was offered for this item'
    : receipt?.gate?.source !== undefined && receipt.gate.source !== candidate ? 'the receipt judged another source'
    : item?.item_status !== 'claimed' || item.item_owner !== submit.agentId ? 'the item is no longer claimed by the seat that submitted it'
    : item.item_frozen_digest !== submit.digest ? 'the item\'s bar was refrozen since the submit' : null;
  if (stale) return { applied: false, outcome: 'stale', reason: stale };
  recordTimedSubmitReceipt(board, { job, receipt, runner: postedReceipt(board.db, job)?.runner });
  // A gate that left its proof to shards waits for them; the gate result applies when the last shard posts [P7].
  if (receipt?.gate?.proofPlan) {
    const sharded = offerProofShards(board, { job, receipt, offered });
    if (sharded) return sharded;
  }
  // Static rows main also has, which the runner's analysis let pass: each is recorded once as a known main red on the item at the job's pinned main [C7,#10567].
  const knownMain = Array.isArray(receipt?.analysis?.staticKnownMain) ? receipt.analysis.staticKnownMain.filter(row => typeof row?.rule === 'string' && typeof row?.file === 'string') : [];
  if (knownMain.length) store.recordKnownMainStatic(board, id, { agentId: submit.agentId, findings: knownMain.slice(0, 200), main });
  // Quarantines filed before this receipt's pairs excuse its reds; the pairs record once, after that judgement [C7,H16].
  const excused = judgePulledFlakes(board, { job, receipt, item: id, candidate, main, submit, queue, admit: () => recordSubmitAdmission(board, { id, item, candidate, submit, job }) });
  const trialNotes = [];
  // A green gate's phases become the item's native proof-run receipts before its submission, as today's submit records them [P7].
  let phaseReceipts = [];
  const owned = ownershipOnly(receipt), proved = receipt?.status === 0 && receipt?.gate?.green === true || owned;
  if (proved) {
    const admission = receipt?.status === 0 && receipt?.gate?.green === true && !submit.companion ? recordSubmitAdmission(board, { id, item, candidate, submit, job }) : null;
    try { phaseReceipts = recordPhaseReceipts(board, { job, receipt, id, candidate, main, submit, check: offered.check, admission }); }
    catch (error) {
      // A receipt the board refuses is named on the thread; the gate's result still applies, so the item is never stranded.
      if (!error?.code) throw error;
      store.appendFact(board, id, { agentId: submit.agentId, kind: 'note', text: `Gate job ${job}'s proof-run receipts were not recorded: ${error.code}: ${error.message}`.slice(0, 2000) });
    }
  }
  // The runner's machinery diagnostics meet the board repository's refusal-trial ledger: one on trial reports, an enforced one refuses [C7].
  const trials = judgeMachinery(board, receipt?.gate?.analysis?.machinery, say => trialNotes.push(say));
  const green = receipt?.status === 0 && receipt?.gate?.green === true && !trials.refused.length;
  // A red only in tests the person waived is submitted waived, not green, and never compared with main [#655].
  const waived = green || trials.refused.length ? null : waivedCases(board, receipt);
  // Green proof whose only finding is lane ownership goes to the owners, as the controller submit routes it [B3,L1,P7].
  const routed = owned && !trials.refused.length ? routePulledOwnership(board, { job, id, candidate, main, submit, receiptIds: phaseReceipts.map(row => row.id) }) : null;
  if (routed?.applied) return routed;
  const compared = green || waived ? null : compareGateWithMain(board, receipt, main, compareWithMain);
  // A later main red never excuses a case green at the item's own claim base: there every case must fail the same way too,
  // as the controller's main-owned verdict asks [V4,B3]. A claim base main's receipts cannot key excuses nothing.
  const claimBase = typeof submit.claimBase === 'string' && SHA.test(submit.claimBase) && submit.claimBase !== main ? submit.claimBase : null;
  const atClaim = claimBase && compared?.cases.length && compared.cases.every(row => row.onMain === true) ? compareGateWithMain(board, receipt, claimBase, compareWithMain) : null;
  const mainOnly = Boolean(compared?.cases.length) && compared.cases.every(row => row.onMain === true) && (!claimBase || Boolean(atClaim?.cases.every(row => row.onMain === true))) && companionInherits(board, submit, main, compared.cases);
  const recorded = compared ? { cases: compared.cases } : {};
  let parts = compared ? [...trials.refused, ...failingParts({ ...receipt, gate: { ...receipt.gate, phases: [] } }, { receiptMissingCause }).filter(part => !part.startsWith('the gate job exited')), ...caseLines(compared),
    ...(claimBase && !mainOnly && compared.cases.every(row => row.onMain === true) ? (atClaim ? caseLines(atClaim) : compared.cases.map(row => `main receipt missing: ${row.phase} ${row.file} (${row.name})`)).map(line => `at claim base ${claimBase.slice(0, 12)}, ${line}`) : []),
    ...(receipt.gate.phases ?? []).flatMap(shardLogLines)] : [...trials.refused, ...failingParts(receipt, { receiptMissingCause })];
  if (routed?.refused) parts.push(`ownership routing refused: ${routed.refused}`);
  // A red whose phases name failed files but no cases (Node's spec reporter) is compared with main by file [V1,C7].
  const byFile = compared || green || waived ? null : compareFilesWithMain(board, receipt, main, compareWithMain);
  if (byFile) parts.push(...fileMainLines(board, byFile));
  // Cases main fails too name the open rework that owns them, as the inline gate's refusal named it [V1,C7].
  else if (compared && !mainOnly) parts.push(...caseReworkLines(board, main, compared));
  const jobs = [...new Set([...(compared?.jobs ?? []), ...(atClaim?.jobs ?? []), ...(byFile?.jobs ?? [])])];
  if (jobs.length) parts.push(`main-test job ${jobs.join(', ')} queued for main's missing receipts; submit again once it records`);
  // A red main's receipts cannot judge yet (some case or file has none, and main passes none of them) is unknown, not red:
  // nothing shows it is the item's, and the queued main-test job settles it (settleWaitingGates) [C7].
  const unknown = !trials.refused.length && !routed?.refused && !green && !mainOnly && !waived && !excused
    && (compared ? compared.cases.some(row => row.onMain === null) && compared.cases.every(row => row.onMain !== false)
      : Boolean(byFile?.files.some(row => row.result === null) && byFile.files.every(row => row.result !== 'green')));
  if (green || mainOnly || waived || excused && !trials.refused.length) {
    const files = pulledProofFiles(receipt);
    // A red only in main's own frozen-check cases is a green gate that names them main-owned, as the controller's verdict records [C7,#3534].
    let owners = mainOnly ? mainOwnership(board, id, compared, main) : null;
    // With submit.autoFileMainReds on accepted main, unowned main reds become derived repairs, never a coordinator shout [V4,B3,C7].
    const filed = owners?.unowned.length ? filePulledRepairs(board, { id, submit, main, unowned: owners.unowned, receipt }) : null;
    if (filed) owners = mainOwnership(board, id, compared, main);
    // A red only in cases main fails the same way, in the check or the proof, is a green gate naming them main-owned [C7,#3534].
    const gateGreen = green || Boolean(owners);
    // Deferral is the plan's own: the runner's receipt carries it, as the controller's gate returns it [C7].
    const deferred = receipt.gate?.deferred === true;
    const deferredFiles = deferred && Array.isArray(receipt.gate.deferredFiles) && receipt.gate.deferredFiles.every(file => typeof file === 'string' && PROJECT_FILE.test(file)) ? receipt.gate.deferredFiles : null;
    try {
      // A companion submit binds the builder head it composed onto to the composed source's green phase receipts, also for an inherited red [P7,V4,B3].
      if (submit.companion && !proved) phaseReceipts = recordPhaseReceipts(board, { job, receipt, id, candidate, main, submit, check: offered.check });
      const companion = submit.companion ? { ...submit.companion, receiptIds: phaseReceipts.map(row => row.id),
        phases: phaseReceipts.map(({ role, command }) => ({ role, command })) } : null;
      submitOvertaken(board, id, { agentId: submit.agentId, commit: companion?.source ?? candidate, tree: submit.tree, files: submit.files ?? [], policyCommit: main, gateGreen, ...(submit.tooling ? { tooling: submit.tooling } : {}), ...(submit.infra ? { infra: submit.infra } : {}),
        ...(deferred && typeof receipt.gate.deferNote === 'string' ? { note: receipt.gate.deferNote.replace(/[\r\n\u2028\u2029]/gu, ' ') } : {}),
        ...(companion ? { companion, pulledPlan: { phases: companion.phases, proofFiles: files, full: receipt.gate?.full === true, deferred, deferredFiles } } : {}),
        submissionProof: { version: 1, files, full: receipt.gate?.full === true, deferred, ...(deferredFiles ? { deferredFiles } : {}), reason: `pulled gate job ${job}${mainOnly ? '; red only in cases that also fail on main' : waived ? '; red only in tests the person waived' : excused && !green ? '; red only in quarantined cases' : ''}`,
          ...(owners?.known ? { knownMainFailures: owners.known } : {}), ...(owners?.ambiguous.length ? { knownMainAmbiguous: owners.ambiguous } : {}) } });
      if (waived) store.appendFact(board, id, { agentId: submit.agentId, kind: 'measurement', text: `Gate job ${job} at ${candidate.slice(0, 12)} was red and is recorded as waived, not green; every failure is covered by a live person waiver:\n${waiverLines(waived).join('\n')}`.slice(0, 2000) });
      if (mainOnly) {
        const owner = row => owners.known?.failures.find(one => one.file === row.file && one.name === row.name)?.item;
        const candidates = row => owners.ambiguous.find(one => one.file === row.file && one.name === row.name)?.candidates ?? [];
        const lines = owners.failures.map(row => `main-owned ${row.file} (${row.name}): ${owner(row) ? `open repair #${owner(row)}${filed?.includes(owner(row)) ? ' (filed by this submit)' : ''}` : owners.unowned.some(red => red.file === row.file) ? 'no open Main red item; the coordinator is asked to own it' : `several candidate owners: ${candidates(row).map(item => `#${item}`).join(', ')}`}`);
        store.appendFact(board, id, { agentId: submit.agentId, kind: 'measurement', text: `Gate job ${job} red at ${candidate.slice(0, 12)} only in cases that also fail on main ${String(main).slice(0, 12)} (not this item's; accepted):\n${[...caseLines(compared), ...lines, ...caseReworkLines(board, main, compared, { accepted: true })].join('\n')}\nReviewers: these main reds are listed, not blocking; no new failure is accepted.` });
      }
      store.appendFact(board, id, { agentId: submit.agentId, kind: 'note', text: `Gate job ${job} ${green ? 'green' : owners ? `green over main-owned ${owners.checkOnly ? 'frozen check' : 'test'} cases` : waived ? 'waived, not green,' : `red only in quarantined cases (${excused.map(row => `${row.file} :: ${row.name}, repair #${row.item}`).join('; ').slice(0, 600)})`} at ${candidate.slice(0, 12)} on main ${String(main).slice(0, 12)}; submitted for review.` });
      if (inspectsClauses(board, main)) recordClauseInspection(board, { id, receipt, head: submit.companion?.source ?? candidate, agentId: submit.agentId, green: gateGreen, folderTicks: folderTicksAt(board, main), titleTicks: titleTicksAt(board, main) });
      if (board.gitRoot && SHA.test(String(main)) && edgeFollowUpsAt(board, main)) try {
        const base = store.getItem(board, id)?.item_claim_head, head = submit.companion?.source ?? candidate;
        const edges = base ? board.enginePorts.sandboxPolicyReads.submitImportEdges(board.gitRoot, { submit: { edgeFollowUps: true } }, { base, commit: head }) : [];
        store.fileEdgeFollowUp(board, id, { agentId: submit.agentId, edges });
      } catch (error) {
        store.appendFact(board, id, { agentId: submit.agentId, kind: 'note', text: `Edge follow-up not filed: ${error?.code ?? 'EDGE_FOLLOW_UP_FAILED'}: ${error?.message ?? String(error)}`.slice(0, 2000) });
      }
      // Main reds no open repair names go to the coordinator as one decision, once the submission is recorded; nothing is filed here [B3].
      if (owners?.unowned.length) try {
        store.shout(board, { from: submit.agentId, to: 'coordinator', lanes: item.item_lane ? [item.item_lane] : [], decision: true, text: unownedShout(id, owners.unowned, main) });
      } catch (error) {
        // The submission is recorded above; a refused or failed shout is named on the thread, never thrown past it (#7495).
        store.appendFact(board, id, { agentId: submit.agentId, kind: 'note', text: `Main red decision shout not sent: ${error?.code ?? 'SHOUT_FAILED'}: ${error?.message ?? String(error)}; next: the coordinator reads pullboard show ${id}`.slice(0, 2000) });
      }
      // A green gate is one real gate for every refusal on trial, counted once per receipt set, as the controller's own submit counts it [C7].
      const counted = green ? countGate(board, phaseReceipts.map(row => row.id).sort(), job) : [];
      if (trialNotes.length || counted.length) store.appendFact(board, id, { agentId: submit.agentId, kind: 'note', text: [...trialNotes, ...counted].join('\n').slice(0, 2000) });
      if (green) startPulledComparison(board, id, submit.agentId);
      // A carried merge-only accept leaves the item verified with no verify command to offer its land job (#7948).
      // A submitted sprint item lands before its verdict: a green screen on the trunk tip stands in for the accept, else its screen
      // starts here and, once it applies green, starts the lander; both read the row already loaded [V2,M1,#12176].
      const held = store.getItem(board, id);
      if (held?.item_status === 'verified' || sprintLandable(board, held)) startReceiptLanding(board, id);
      else startReceiptScreen(board, held, main, () => startReceiptLanding(board, id, `land job for #${id} not offered after its green screen`));
      return { applied: true, outcome: 'review', ...recorded, ...(owners ? { mainOwned: owners.failures, knownMainReworks: owners.known?.failures ?? [], knownMainAmbiguous: owners.ambiguous } : {}) };
    } catch (error) {
      // A green gate whose submission the board refuses goes back to the builder with the refusal, never lost in a log.
      if (!error?.code) throw error;
      parts = [`submit ${error.code}: ${error.message}`];
    }
  }
  // With gate.redFactLocation on, a red names the file:line its static checks reported, last so the shout still leads with the first failing part [C7,#9083].
  const where = !(green || mainOnly || waived) && redLocation === true ? redLocationLine(receipt) : null;
  if (where) parts.push(where);
  const word = green || mainOnly || waived ? 'passed but not submitted' : unknown ? 'unknown' : 'red';
  store.appendFact(board, id, { agentId: submit.agentId, kind: 'measurement', text: `Gate job ${job} ${word} at ${candidate.slice(0, 12)}${unknown ? ' until main\'s missing receipts record' : ''}; failing parts:\n${parts.join('\n')}` });
  // The shout only wakes the builder; the fact above is the record, so a refused shout leaves the red recorded.
  try {
    store.shout(board, { from: 'coordinator', to: submit.agentId, lanes: [], item: id,
      text: `#${id} gate ${unknown ? 'unknown' : 'red'} at ${candidate.slice(0, 7)}: ${parts.find(part => !part.startsWith('also fails on main')) ?? parts[0] ?? 'see pullboard show'}`.slice(0, 280) });
  } catch (error) { if (error?.code === undefined) throw error; }
  return { applied: true, outcome: unknown ? 'unknown' : 'red', ...recorded };
}

/** The review comparison starter this process's board API calls when a pulled gate goes green; null until a host provides one. */
let comparisonStarter = null;
/** The fact prefix a review comparison records under; spelled here so the board API adds no edge to the verify cell. */
const COMPARISON_PREFIX = 'Review comparison: ';

/**
 * Provide the function that detaches a green pulled submission's background main comparison: start({ root, item,
 * source, digest }) launches the worker that runs and records it. Why a provider: the comparison worker and its tools
 * live in the CLI, and `pullboard serve` calls this once at start, so the board API stays free of them [C7,V4].
 * @param {((request: { root: string, item: number, source: string, digest: string }) => unknown) | null} start
 */
export function provideComparisonStart(start) {
  comparisonStarter = typeof start === 'function' ? start : null;
}

/**
 * Record a green pulled submission's comparison as pending, then detach its worker, as the inline green submit does.
 * Why: only the inline submit started it, so a pulled green gate reached review with no comparison ever recorded
 * (#7267). A comparison already pending or complete for this source and bar is left alone; a starter that fails
 * records the comparison unavailable, so no review waits on one that never ran.
 */
function startPulledComparison(board, id, agentId) {
  if (!comparisonStarter || !board.gitRoot) return;
  const item = store.getItem(board, id);
  if (!item?.item_commit || !item.item_frozen_digest) return;
  const pending = { item: id, status: 'pending', source: item.item_commit, digest: item.item_frozen_digest };
  for (const fact of [...store.itemThread(board, id)].reverse()) {
    if (fact.type !== 'fact' || !fact.text?.startsWith(COMPARISON_PREFIX)) continue;
    let recorded = null;
    try { recorded = JSON.parse(fact.text.slice(COMPARISON_PREFIX.length)); } catch { continue; }
    if (recorded?.source !== pending.source || recorded.digest !== pending.digest) continue;
    if (['pending', 'complete'].includes(recorded.status)) return;
    break;
  }
  let started;
  try { started = comparisonStarter({ root: board.gitRoot, item: id, source: pending.source, digest: pending.digest }); }
  catch (error) { started = { error }; }
  if (started === false) return;
  const failed = started?.error ? { ...pending, status: 'unavailable', error: String(started.error?.message ?? started.error).slice(0, 500) } : null;
  store.appendFact(board, id, { agentId, kind: 'measurement', text: COMPARISON_PREFIX + JSON.stringify(failed ?? pending) });
}

/** The landing starter this process's board API calls when a gate receipt leaves an item accepted; null until a host provides one. */
let landingStarter = null;

/**
 * Provide the function that offers the land job for an item a gate receipt left verified: start({ root, item }); item is
 * null when a settled land job starts the lander for every waiting item (#12185).
 * Why a provider: offering a land job publishes the item's ref and reads the trunk with git from the CLI's lander, so
 * `pullboard serve` hands it in and the board API keeps no import of the CLI [C7,#7948].
 * @param {((request: { root: string, item: number | null }) => unknown) | null} start
 */
export function provideLandingStart(start) {
  landingStarter = typeof start === 'function' ? start : null;
}

/**
 * Start the land job offer for an item this receipt left verified, once the receipt's writes are done. Why: a gate that
 * carries a merge-only accept (reopen --conflict, merge main, resubmit) verifies the item with no `verify accept` run,
 * so nothing offered its land job and it waited accepted for good (#7948). A failed start is logged with its next
 * step; the coordinator's `pullboard land` then offers the job.
 */
function startReceiptLanding(board, id, what = `land job for #${id} not offered after its gate receipt`) {
  if (!landingStarter || !board.gitRoot) return;
  const start = landingStarter, root = board.gitRoot;
  setImmediate(() => {
    Promise.resolve().then(() => start({ root, item: id })).catch(error => {
      process.stderr.write(`${new Date().toISOString()} ${what}: ${error?.code ?? error?.name ?? 'Error'}: ${error?.message ?? error}; next: pullboard land\n`);
    });
  });
}

/**
 * Whether the board's line settings batch landings: line.landingBatchSize above 1 or line.collisionFreeBatch on. Why:
 * with batching on the lander waits while a land job is open, so the job's settle must start it again for the items
 * accepted meanwhile [C7,#12185]. A line setting that cannot be read leaves batching off, as the defaults do.
 */
function batchesLandings(board) {
  let line;
  try { line = store.lineSettings(board); }
  catch { return false; }
  return (Number.isSafeInteger(line.landingBatchSize) && line.landingBatchSize > 1) || line.collisionFreeBatch === true;
}

/** The refusal-trial ledger this process's board API records pulled gates in; null until a host provides one. */
let refusalTrials = null;

/**
 * Provide the refusal-trial ledger port for every board this process serves: refuse(root, diagnostic, say) applies one
 * machinery diagnostic (throwing its Refused when enforced) and count(root, { id }) counts one real gate. Why a port:
 * the ledger lives in the board repository's .git/pullboard and only the gate cell writes it, so `pullboard serve`
 * hands it in and this route keeps no import of that cell [C7].
 * @param {{ refuse: Function, count: Function } | null} port
 */
export function provideRefusalTrials(port) {
  refusalTrials = port && typeof port.refuse === 'function' && typeof port.count === 'function' ? port : null;
}

/**
 * Apply a runner's machinery diagnostics to the board repository's trial ledger, so a pulled gate keeps the same record
 * an inline one did. A diagnostic of an enforced code refuses the gate; one on trial only reports.
 *
 * @param {any} board - gitRoot is the board host's repository; without it or a provider nothing is recorded.
 * @param {unknown} machinery
 * @param {(line: string) => void} say
 * @returns {{ refused: string[] }} One line per enforced diagnostic.
 */
function judgeMachinery(board, machinery, say) {
  const refused = [];
  if (!refusalTrials || !board.gitRoot || !Array.isArray(machinery)) return { refused };
  for (const diagnostic of machinery.slice(0, 20)) {
    try { refusalTrials.refuse(board.gitRoot, diagnostic, say); }
    catch (error) {
      if (error?.code) refused.push(`${error.code}: ${error.message}`);
      else say(`could not record ${diagnostic?.code ?? 'a diagnostic'} in the refusal-trial ledger`);
    }
  }
  return { refused };
}

/** Count one green pulled gate in the ledger; its receipt ids (or the job) key it so a re-applied receipt counts once. */
function countGate(board, receiptIds, job) {
  if (!refusalTrials || !board.gitRoot) return [];
  try { return refusalTrials.count(board.gitRoot, { id: JSON.stringify(receiptIds.length ? receiptIds : [job]) }); }
  catch { return ['could not record this gate in the refusal-trial ledger']; }
}

/** The main-receipt lookup this process's board API applies red gate receipts with; null until a host provides one. */
let mainComparison = null;

/** Whether a timing red on main excuses the same red on a gate, asked on each comparison; null until a host provides one (#9755). */
let timingExcuse = null;

/**
 * Provide the question compareGateWithMain asks to excuse timing reds, for every board this process serves; null removes
 * it. Why a provider: the setting belongs to the host, and the board API's routes read no settings themselves.
 * @param {(() => boolean) | null} fn - Answers true to excuse a timing red that main also has.
 */
export function provideTimingExcuse(fn) {
  timingExcuse = typeof fn === 'function' ? fn : null;
}

/**
 * Provide the main-receipt lookup red gate receipts are compared with, for every board this process serves; null
 * removes it. Why a provider: `pullboard serve` owns the lookup (the landing and drive cells hold main's receipts) and
 * calls this once at start, so the board API's routes stay free of those cells [P7].
 * @param {Parameters<typeof compareGateWithMain>[3]} lookup
 */
export function provideMainComparison(lookup) {
  mainComparison = typeof lookup === 'function' ? lookup : null;
}

/**
 * Answer one job queue call on an open board, applying each newly recorded receipt to it: the board API's jobs route.
 *
 * @param {any} board - The open board, gitRoot set to the board host's repository.
 * @param {Record<string, any>} body
 * @param {Parameters<typeof jobQueueCall>[2] & { compareWithMain?: Parameters<typeof compareGateWithMain>[3], landingKey?: () => string | null, ordered?: { operation: string, args: any[] }[] | null, endStale?: boolean, receiptMissingCause?: boolean, redLocation?: boolean, settleOnMainReceipt?: boolean, retryNewRedsOnce?: boolean, reofferTrunkBusy?: boolean }} options - retryNewRedsOnce: a gate red only in new cases reruns just those files once before it applies (#11712); endStale: gate.endStaleJobs, ends a landed item's open gate jobs (#8816);
 *   reofferTrunkBusy: landing.reofferTrunkBusy, offers a trunk-busy land job again after a backoff (#9102);
 *   settleOnMainReceipt: gate.settleOnMainReceipt, settles sharded gates left unknown when main's receipt records (#9057); compareWithMain:
 *   main's receipt lookup for a red gate's cases; the one provided to this process by default. landingKey: the board's
 *   landing key, which signs a land job's permit for the trunk guard (#5848); the board host's key file by default.
 *   ordered: on a relay-linked board, the list a receipt's engine moves go onto instead of this replica's store, for
 *   the caller to order through the relay (#7562); null applies them here, as on a local board.
 */
export function boardJobQueueCall(board, body, { compareWithMain = mainComparison, landingKey = () => landingGuardKey(board.gitRoot), ordered = null, endStale = false, receiptMissingCause = false, redLocation = false, settleOnMainReceipt = false, retryNewRedsOnce = false, reofferTrunkBusy = false, ...options }) {
  // Queued main-test jobs are offered before each claim, so a free runner takes one in the same call (#6063).
  const ports = { compareWithMain, ordered, endStale, receiptMissingCause, redLocation, settleOnMainReceipt, retryNewRedsOnce, reofferTrunkBusy, receiptNow: options.now };
  if (body?.action === 'claim' && options.mode === 'pull') {
    offerMainTests(board, { now: options.now });
    // A sharded gate whose last apply was lost settles on the next runner's claim, so its item never waits forever (#10181).
    settleDoneShardGates(board, ports, { now: options.now });
  }
  // With runs_store on, a shard offer or a receipt goes through the runs queue; off, queueFor is null and nothing changes [B2,P7].
  const queue = ['shards', 'receipt'].includes(body?.action) ? queueFor(board, 'coordinator') : null;
  const answer = jobQueueCall(board.db, body, { queue, onRunaway: posted => reportRunaway(board, posted), onRepeatClaim: posted => reportRepeatClaims(board, posted), ...options, onReceipt: posted => queue ? applyQueuedReceipt(board, queue, posted, ports) : applyJobReceipt(board, posted, ports) });
  return ['claim', 'renew'].includes(body?.action) ? withLandingPermit(board.db, body, answer, landingKey) : answer;
}

/**
 * The runnerCommit port a board's claim answers carry with runners.reportCommit on: the commit the board's trunk main
 * ref points at, read from Git's ref files so no Git process runs on the request path; null (no port) when off, so the
 * claim answer stays today's. Why: a pull runner's long-lived serve code had no way to learn the board moved past it [C7,#10819].
 *
 * @param {string} root - The board's repository root.
 * @param {boolean} enabled - runners.reportCommit, this machine's setting.
 * @returns {(() => string | null) | null}
 */
export function runnerCommitPort(root, enabled) {
  return enabled ? () => trunkRevisionReader(repoInfo(root))() : null;
}

/**
 * Write the proof-ledger rows one gate or shard receipt carries: one test_result row per file its phases ran under a
 * key, pass or fail by file, whatever the job's own outcome or its item's state. Why before the apply: proof is proof,
 * so a red or stale job's green files still count, and the shard combine never loses a shard's files [P7,CD2].
 *
 * @param {any} board
 * @param {{ job: string, attempt?: number, receipt: Record<string, any> }} posted
 * @param {'pulled' | 'shard'} origin
 * @returns {number} rows written
 */
export function recordReceiptLedger(board, { job, attempt = 0, receipt }, origin) {
  const runner = postedReceipt(board.db, job)?.runner ?? 'unknown';
  const gate = receipt?.gate ?? {};
  const commit = SHA.test(String(gate.source ?? '')) ? gate.source : null;
  const rows = [];
  for (const phase of Array.isArray(gate.phases) ? gate.phases : []) {
    const { contexts, files } = phase?.ledger ?? {};
    if (!Array.isArray(contexts) || !Array.isArray(files)) continue;
    for (const [file, inputKey, context, status] of files.filter(Array.isArray)) {
      rows.push({ file, inputKey, command: String(phase.role ?? 'proof'), context: contexts[context], status });
    }
  }
  return store.recordTestResults(board.db, { receipt: `${job}#${attempt}`, origin: `${origin}:${runner}`, commit, rows });
}

/**
 * Add the board ledger's hits for `files` to a gate job request, within what the request has left under the queue's
 * cap; the runner's planTestActions reuses a file whose own key a hit matches and runs only the rest [P7,CD2].
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ input: { data: Record<string, any> } }} request
 * @param {string[]} files
 */
export function gateLedgerHits(db, request, files) {
  const budget = Math.min(16_000, LEDGER_REQUEST_BYTES - Buffer.byteLength(JSON.stringify(request)));
  const hits = budget > 0 ? store.ledgerHits(db, files, { budget }) : null;
  if (hits) request.input.data.ledger = hits;
  return request;
}

/**
 * Apply one receipt from the runs inbox while runs_store is on: when the board's run row is still queued for an older
 * attempt, run the receipt applier and settle the row (outcome, summary, event); then ack the receipt in the runs file.
 * A receipt already applied, or for an older attempt, changes nothing but its ack, so a crash between the move and the
 * ack repeats as a no-op. The applier does file I/O, so it runs outside a board write [B2,P7].
 *
 * @param {any} board
 * @param {NonNullable<ReturnType<typeof queueFor>>} queue
 * @param {{ job: string, attempt: number, receipt: Record<string, any> }} posted
 * @param {Parameters<typeof applyJobReceipt>[2]} [ports]
 * @returns {{ applied: boolean, outcome?: string }}
 */
export function applyQueuedReceipt(board, queue, { job, attempt, receipt }, ports = {}) {
  const run = boardRun(board.db, job);
  const fresh = run?.run_state === 'queued' && attempt > run.run_attempt;
  const answer = fresh ? applyJobReceipt(board, { job, attempt, receipt }, { ...ports, queue }) : { applied: false, outcome: 'already-applied' };
  if (fresh) applyRunReceipt(board, { by: queue.by, job, attempt, outcome: String(receipt.outcome ?? receipt.status ?? 'unknown'), summary: receipt });
  queue.port.ack(job, attempt);
  return answer;
}

/**
 * Apply one newly recorded receipt by its job's kind; kinds with no board effect only stay recorded. With ports.ordered
 * (a relay-linked board), the engine moves the apply makes are taken back and pushed onto it for the relay [C7,H16].
 */
export function applyJobReceipt(board, posted, ports = {}) {
  if (Array.isArray(ports.ordered)) {
    const { result, moves } = orderedReceiptMoves(board, () => applyJobReceipt(board, posted, { ...ports, ordered: null }));
    ports.ordered.push(...moves);
    return result;
  }
  // With runs_store on the job lives in the runs file, so its kind is the board run row's [B2,P7].
  const kind = ports.queue ? boardRun(board.db, posted.job)?.run_kind : board.db.prepare('SELECT job_kind FROM job WHERE job_id = ?').get(posted.job)?.job_kind;
  if (kind === 'gate' || kind === SHARD_JOB_KIND) recordReceiptLedger(board, posted, kind === 'gate' ? 'pulled' : 'shard');
  if (kind === 'gate') return applyGateReceipt(board, posted, ports);
  if (kind === SHARD_JOB_KIND) return applyShardReceipt(board, posted, ports);
  if (kind === LANDING_JOB_KIND) return applyLandingReceipt(board, posted, ports);
  if (kind === CHECK_BASELINE_KIND) return applyCheckBaselineReceipt(board, posted);
  if (kind === 'test') {
    const accept = settleQueuedAccept(board, posted);
    return accept.applied ? accept : applyTestReceipt(board, posted);
  }
  if (kind === MAIN_TEST_KIND) {
    const applied = applyMainTestReceipt(board, posted);
    if (applied.applied) settleWaitingGates(board, posted.job, ports);
    return applied;
  }
  return { applied: false, outcome: 'recorded' };
}

/**
 * The note a land job's returned item carries back to its builder: only a merge conflict asks for a main merge; a red tree or a refused push
 * says fix, commit and resubmit, since submit composes current main [C7,U159].
 */
export function returnedItemNote(reason, why) {
  return reason === 'conflict' ? `${why}; merge current main, resolve the conflict, commit and resubmit` : `${why}; fix it, commit and resubmit (submit composes current main)`;
}

/** The files a land job's merge output names as conflicting, in order and without repeats; none when the output names none. */
function conflictedFiles(detail) {
  const files = [];
  for (const line of String(detail ?? '').split('\n')) {
    const file = /Merge conflict in (.+?)\s*$/u.exec(line)?.[1];
    if (file && !files.includes(file)) files.push(file);
  }
  return files;
}

/**
 * Settle the items a land receipt gives back, as 0.9.3's landing did: each red or colliding item goes back to its
 * builder with its accept withdrawn, or under separate publish parks on a hold, and its note leads with the receipt's
 * first line (the run-tests refusal or first failing test) and keeps the failing case's lines, so `pullboard show` prints why. A red receipt with no
 * returned list names every unmerged item it carried. Why: a red receipt only wrote a note, so the item stayed accepted
 * and the next accept bundled it into a land job that went red again (#6469) [P7].
 */
function returnLandedReds(board, job, named, receipt, separate) {
  const rows = Array.isArray(receipt.returned) && receipt.returned.length ? receipt.returned
    : receipt.outcome === 'red' ? [...named].map(id => ({ id, reason: 'red', detail: receipt.detail })) : [];
  const back = [];
  if (rows.length) keepLandingLog(board, job, receipt);
  for (const row of rows) {
    const item = named.has(row?.id) ? store.getItem(board, row.id) : null;
    if (!item || item.item_merged_commit) continue;
    const first = String(row.detail ?? receipt.detail ?? '').split('\n').map(line => line.trim()).find(Boolean) ?? 'no detail recorded';
    // The note keeps the failing case's lines too, so the builder reads the assertion, not only the case name.
    store.appendFact(board, row.id, { agentId: 'coordinator', kind: 'note', text: `Land job ${job} ${row.reason === 'conflict' ? 'conflict' : row.reason === 'hook' ? 'push refused' : 'red'}: ${String(row.detail ?? receipt.detail ?? first).trim() || first}`.slice(0, 900) });
    // Only an accepted item moves; any other unmerged item (a forced landing's, say) keeps the note alone.
    if (item.item_status !== 'verified' || item.item_hold_at) continue;
    const why = `land job ${job} ${row.reason === 'conflict' ? 'could not merge it' : row.reason === 'hook' ? 'had its push refused' : 'checked the merged tree red'}: ${first}`.slice(0, 400);
    try {
      // A static guard red is the item's own source, not a held landing: it goes back to its builder as the inline lander did [#7492].
      // A plain merge conflict under separate publish needs only a main merge: the accept stays, as pullboard reopen --conflict keeps it, and the builder sees the item [C7].
      const files = separate && !row.guard && row.reason === 'conflict' ? conflictedFiles(row.detail ?? receipt.detail) : [];
      const forMerge = files.length > 0 && SHA.test(receipt.base ?? '');
      if (forMerge) {
        store.reopen(board, row.id, { agentId: 'coordinator', conflict: { files, trunk: receipt.base }, note: returnedItemNote(row.reason, why) });
        if (item.item_built_by) store.persistShout(board, { from: 'coordinator', to: item.item_built_by, text: `#${row.id} is back with you: ${why}`.slice(0, 600) });
      }
      else if (separate && !row.guard) store.holdItem(board, row.id, { agentId: 'coordinator', reason: `${why}; fix it on current main and resubmit, or lift the hold` });
      else {
        store.reopen(board, row.id, { agentId: 'coordinator', withdrawVerdict: true, note: returnedItemNote(row.reason, why) });
        if (item.item_built_by) store.persistShout(board, { from: 'coordinator', to: item.item_built_by, text: `#${row.id} is back with you: ${why}`.slice(0, 600) });
      }
      back.push(row.id);
    } catch (error) {
      store.appendFact(board, row.id, { agentId: 'coordinator', kind: 'note', text: `Land job ${job} could not return #${row.id}: ${error?.code ?? 'ERROR'} ${String(error?.message ?? '').slice(0, 200)}` });
    }
  }
  return back;
}

/**
 * Re-apply each red gate receipt waiting on main's receipts at the main a main-test job just recorded: the item's
 * newest gate job at that same main, red in a case of the job's file, still claimed by its submitter. It re-applies
 * only once every one of its cases is now keyed, so it turns green when all also fail on main, or red with the new ones.
 * Why: each resubmit merges a newer main, so the comparison key moved before the queued job recorded and the red
 * never settled (#6229). Only the gate's own main is read, never another main commit [C7,P7].
 *
 * With gate.settleOnMainReceipt on (`settleOnMainReceipt`), a gate whose proof ran as shards settles too, from its shards'
 * combined result, and each settled gate records which main receipt settled it. Why: the posted gate receipt of a
 * sharded proof still holds its plan, so it was skipped and the builder had to resubmit (#8777, #8987) [C7,#9057].
 *
 * @param {any} board
 * @param {string} mainTest - The main-test job whose receipt was just recorded.
 * @param {{ compareWithMain?: Parameters<typeof compareGateWithMain>[3], settleOnMainReceipt?: boolean }} ports
 * @returns {string[]} the gate jobs re-applied
 */
export function settleWaitingGates(board, mainTest, { compareWithMain = null, settleOnMainReceipt = false, queue = null } = {}) {
  const { db } = board;
  // runs_store on: the job rows live in the runs file, so main's base and file and the earlier gates read from the board's run rows and their receipt summaries [B2,P7].
  const summary = job => JSON.parse(boardRun(db, job)?.run_summary ?? 'null');
  const main = queue ? boardRun(db, mainTest)?.run_base : db.prepare('SELECT job_base FROM job WHERE job_id = ?').get(mainTest)?.job_base;
  // The keyed main receipt is step 0; a runner's own posts sit above it.
  const keyed = queue ? null : db.prepare("SELECT job_step_payload FROM job_step WHERE job_step_job = ? AND job_step_name = 'receipt' AND job_step_seq = 0").get(mainTest);
  const file = queue ? summary(mainTest)?.file : keyed ? JSON.parse(keyed.job_step_payload)?.file : null;
  if (typeof compareWithMain !== 'function' || !SHA.test(String(main ?? '')) || typeof file !== 'string') return [];
  const settled = [];
  const earlier = queue ? db.prepare("SELECT run_job AS job_id, run_item AS job_item, run_base AS job_base FROM run WHERE run_kind = 'gate' AND run_item IS NOT NULL ORDER BY run_created DESC, rowid DESC LIMIT 300")
    : db.prepare("SELECT job_id, job_item, job_base FROM job WHERE job_kind = 'gate' AND job_item IS NOT NULL ORDER BY job_created DESC, rowid DESC LIMIT 300");
  const newest = item => queue ? db.prepare("SELECT run_job FROM run WHERE run_kind = 'gate' AND run_item = ? ORDER BY run_created DESC, rowid DESC LIMIT 1").get(item)?.run_job ?? null : latestGateJob(db, item);
  // Any base: the lookup finds this receipt for a gate on an earlier main where the file is unchanged, and skips the rest (#6333).
  for (const { job_id: job, job_item: item, job_base } of earlier.all()) {
    const posted = queue ? summary(job) : postedReceipt(db, job)?.receipt;
    const receipt = settleOnMainReceipt && !queue && posted?.gate?.proofPlan ? shardedResult(db, job, posted) : posted;
    const gate = receipt?.gate;
    if (!gate || gate.proofPlan || (receipt.status === 0 && gate.green === true) || newest(item) !== job) continue;
    if (!(gate.phases ?? []).some(phase => phase.status !== 0 && ((phase.failures ?? []).some(row => row?.file === file) || (phase.failedFiles ?? []).includes(file)))) continue;
    if (store.getItem(board, item)?.item_status !== 'claimed') continue;
    const compared = compareGateWithMain(board, receipt, job_base, compareWithMain);
    const byFile = compared ? null : compareFilesWithMain(board, receipt, job_base, compareWithMain);
    if (compared ? compared.cases.some(row => row.onMain === null) : !byFile || byFile.unavailable || byFile.files.some(row => row.result === null)) continue;
    const settledKey = `gate_settled_red:${job}`, comparison = createHash('sha256').update(JSON.stringify(compared ? compared.cases.map(row => [row.phase, row.file, row.name, row.onMain, row.differs === true]) : byFile.files.map(row => [row.file, row.result]))).digest('hex');
    if (store.readBoardMeta(db, settledKey) === comparison && !(compared && compared.cases.every(row => row.onMain === true))) continue; // same red already settled: no second facts or shout; a wholly main red stays for the claim base [C7,#12190]
    // The main-test receipt is already recorded, so a throw here would strand the item claimed with no word on its thread:
    // an uncoded error is recorded as this re-apply's refusal instead, and the next waiting gate still settles (#7495).
    try {
      const applied = applyGateReceipt(board, { job, receipt }, { compareWithMain });
      if (applied.applied) settled.push(job);
      if (applied.outcome === 'red') store.writeBoardMeta(db, settledKey, comparison); // the next pass compares against this red
      // The settled result is named on the thread under the submitting seat, as the gate's own result is, so show says no resubmit was needed [C7,#9057].
      const agentId = offeredGate(db, job)?.submit?.agentId;
      if (settleOnMainReceipt && agentId && ['review', 'red'].includes(applied.outcome)) store.appendFact(board, item, { agentId, kind: 'measurement',
        text: `Gate job ${job} settled ${applied.outcome === 'review' ? 'green' : 'red'} when main-test job ${mainTest} recorded main's receipt for ${file}; judged from the item's recorded run, with no new submit.`.slice(0, 2000) });
    }
    catch (error) {
      const why = error?.code ? `${error.code}: ${error.message}` : `GATE_REAPPLY_FAILED: ${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`;
      store.appendFact(board, item, { agentId: 'coordinator', kind: 'note', text: `Gate job ${job} was not re-applied after main-test job ${mainTest} recorded: ${why}; next: submit again`.slice(0, 2000) });
    }
  }
  return settled;
}

/** A sharded gate's combined receipt once every shard job is done, as its last shard applied it; null while any is open. runs: as shardJobs [#9151]. */
export function shardedResult(db, job, gateReceipt, { runs = null } = {}) {
  const home = runs ? runs.db : db;
  const shards = shardJobs(home, job);
  if (!shards.length || shards.some(row => row.job_step !== 'done')) return null;
  return combinedReceipt(gateReceipt, shards.map(row => ({ job: row.job_id, posted: postedReceipt(home, row.job_id) })), { signatures: true });
}

/** Shout the coordinator once that one job was claimed 3 times within 60 s, naming the job and its runners (#7445). */
export function reportRepeatClaims(board, { job, kind, claims, runners }) {
  store.persistShout(board, { from: 'coordinator', to: 'coordinator', text: `${kind} job ${job} was claimed ${claims} times in 60 s by ${runners.join(', ')}`.slice(0, 600) });
}

/**
 * End-of-line for a job claimed past its cap: shout the coordinator once, and for a land job note each unmerged item
 * with why it still waits. The items stay accepted: the next landing offers them again, so nothing is withdrawn for a
 * runner's trouble (#7386).
 */
export function reportRunaway(board, { job, kind, attempts, detail, runs = null }) {
  const named = kind === LANDING_JOB_KIND
    ? JSON.parse((runs ? runs.db : board.db).prepare("SELECT job_step_payload FROM job_step WHERE job_step_job = ? AND job_step_name = 'offered' AND job_step_seq = 0").get(job)?.job_step_payload ?? '{}').payload?.items?.map(entry => entry.id) ?? []
    : [];
  const waiting = named.filter(id => { const item = store.getItem(board, id); return item && !item.item_merged_commit; });
  for (const id of waiting) store.appendFact(board, id, { agentId: 'coordinator', kind: 'note', text: `Land job ${job} was released to the lane: ${detail}`.slice(0, 900) });
  store.persistShout(board, { from: 'coordinator', to: 'coordinator', text: `runaway ${kind} job ${job}: ${detail} (${attempts} claims)${waiting.length ? `; ${waiting.map(id => `#${id}`).join(' ')} stay accepted` : ''}`.slice(0, 600) });
}

/**
 * A land job whose push failed, or whose proof ran past its deadline, leaves its items accepted: offer the landing again,
 * up to LAND_PUSH_RETRIES times, and past that note each item and shout the coordinator the named refusal
 * (LAND_PUSH_FAILED, or LAND_PROOF_TIMEOUT). Why: the job was marked done and nothing offered the items again, so an
 * accepted item waited landing for good (#7791); a proof that never ended did the same with its lease renewed forever (#7820).
 */
function retryFailedLanding(board, job, named, receipt, { code, what, next, backoff = false, now = Date.now() }) {
  const waiting = [...named].filter(id => { const item = store.getItem(board, id); return item?.item_status === 'verified' && !item.item_merged_commit; });
  if (!waiting.length) return;
  const detail = String(receipt.detail ?? 'no detail recorded').trim();
  const tries = landingRetries(job);
  let again = null;
  if (tries < LAND_PUSH_RETRIES) {
    // A trunk-busy retry waits a backoff that grows per retry, so trunk can settle before the landing tries again [C7,#9102].
    try { again = reofferLandingJob(board.db, job, { now, queue: queueFor(board, 'coordinator'), holdMs: backoff ? releaseBackoffMs(tries + 1) : 0 }); } catch { again = null; }
  }
  const tail = again ? `offered land job ${again.id} (retry ${again.retry} of ${LAND_PUSH_RETRIES})`
    : `${code} after ${tries + 1} tries; next: ${next}`;
  for (const id of waiting) store.appendFact(board, id, { agentId: 'coordinator', kind: 'note', text: `Land job ${job} ${what}: ${detail}; ${tail}`.slice(0, 900) });
  if (!again) store.persistShout(board, { from: 'coordinator', to: 'coordinator', text: `${code}: land job ${job} ${what} (${detail.slice(0, 200)}); ${waiting.map(id => `#${id}`).join(' ')} stay accepted; next: ${next}`.slice(0, 600) });
}

/**
 * Mark each item a landed receipt names merged at the trunk commit the runner pushed: the items it merged and those
 * trunk already held. An item no longer accepted and unmerged is left as it is. The items the receipt gives back (red
 * or colliding) return to their builders or park (returnLandedReds); a busy trunk or lost lease changes no item, and
 * those stay accepted for the next landing.
 *
 * @param {any} board
 * @param {{ job: string, receipt: Record<string, any> }} posted
 * @returns {{ applied: boolean, outcome: string, merged?: number[], returned: number[] }}
 */
export function applyLandingReceipt(board, posted, ports = {}) {
  const answer = applyLandingOutcome(board, posted, ports);
  // With landing batches on, the settled job starts the lander once more, after main-moved, so the items accepted while
  // it ran go out together as the next job; with the line defaults nothing more runs [C7,#12185].
  if (landingStarter && board.gitRoot && batchesLandings(board)) startReceiptLanding(board, null, `land offer after land job ${posted.job} settled not started`);
  return answer;
}

/** Apply one land job's receipt to its items: returned reds, retries, merged items and the main-moved receipt. */
function applyLandingOutcome(board, { job, receipt }, ports) {
  // With runs_store on the job's offered row is in the runs file, which the queue holds [B2,P7,#9114].
  const offered = JSON.parse((ports.queue ? ports.queue.runs.db : board.db).prepare("SELECT job_step_payload FROM job_step WHERE job_step_job = ? AND job_step_name = 'offered' AND job_step_seq = 0").get(job)?.job_step_payload ?? '{}');
  const named = new Set((offered.payload?.items ?? []).map(entry => entry.id));
  const returned = receipt ? returnLandedReds(board, job, named, receipt, offered.payload?.publish === 'separate') : [];
  // A red's failing cases become observations after the items go back, once per receipt (the job's receipt applies once) [C7,H16].
  if (receipt?.red) { try { recordLandedRed(board, { job, receipt, item: returned[0] ?? null }); } catch { /* a diagnostic that cannot record leaves the red as it was */ } }
  if (receipt?.outcome === 'push-failed') retryFailedLanding(board, job, named, receipt, { code: 'LAND_PUSH_FAILED', what: 'push-failed', next: 'fix the trunk push, then pullboard land' });
  // With landing.reofferTrunkBusy on, a land job that lost the trunk race every attempt is offered again after a backoff [C7,#9102].
  if (receipt?.outcome === 'trunk-busy' && ports.reofferTrunkBusy === true) retryFailedLanding(board, job, named, receipt, { code: 'LAND_TRUNK_BUSY', what: 'found trunk moved', next: 'wait for trunk to settle, then pullboard land', backoff: true, now: ports.receiptNow ?? Date.now() });
  if (receipt?.outcome === 'proof-timeout') retryFailedLanding(board, job, named, receipt, { code: 'LAND_PROOF_TIMEOUT', what: 'proof ran past its deadline', next: 'find the slow or stuck test file on the runner, then pullboard land' });
  if (receipt?.outcome !== 'landed' || !SHA.test(receipt.trunk ?? '')) return { applied: returned.length > 0, outcome: String(receipt?.outcome ?? 'unknown'), returned };
  const waivers = new Map((offered.payload?.waivers ?? []).map(waiver => [waiver.id, waiver]));
  const waived = (Array.isArray(receipt.waived) ? receipt.waived : []).map(row => {
    const waiver = waivers.get(row?.waiver);
    return `waived: ${row?.name} (${row?.file}) by person waiver ${row?.waiver}${waiver ? ` for ${waiver.kind} ${waiver.test}: ${waiver.reason}; expires ${waiver.until}` : ''}`;
  });
  // The receipt's timed phases (merge, static checks, cli smoke, the gate's runner wait and tests, push), kept on each landed item for show --json [C7,#8960].
  const phases = (Array.isArray(receipt.phases) ? receipt.phases : []).filter(row => typeof row?.phase === 'string' && Number.isSafeInteger(row.ms)).map(({ phase, ms }) => ({ phase, ms }));
  const merged = [];
  for (const id of [...(receipt.landed ?? []), ...(receipt.already ?? [])]) {
    if (!named.has(id)) continue;
    const item = store.getItem(board, id);
    // A submitted sprint item lands on a green screen on the trunk the job was offered on, as a verified one does [V2,M1,#12176].
    if (item?.item_merged_commit || (item?.item_status !== 'verified' && !sprintLandable(board, item, offered.payload?.expect ?? null))) continue;
    // Each item lands at its own first-containing merge when the receipt names one; trunk already held the rest [B3,R3,#7506].
    const commit = SHA.test(receipt.merges?.[id] ?? '') ? receipt.merges[id] : receipt.trunk;
    store.merged(board, id, { agentId: 'coordinator', commit, note: `landed by runner job ${job}` });
    merged.push(id);
    if (phases.length) store.writeBoardMeta(board.db, `landing_phases:${id}`, JSON.stringify(phases));
    // With gate.endStaleJobs on, the landed item's open gate jobs end, so no runner spends time on them [C7,#8816].
    endStaleGateJobs(board.db, { item: id, enabled: ports.endStale === true });
    // A landing proof red only in waived tests is recorded on each item it landed, as the controller's waived landing gate was [#655].
    if (waived.length) store.appendFact(board, id, { agentId: 'coordinator', kind: 'measurement', text: `Land job ${job} landing gate waived, not green, at ${receipt.trunk.slice(0, 12)}:\n${waived.join('\n')}`.slice(0, 2000) });
  }
  // A landing that moved trunk writes one main-moved receipt, so seats get the main-moved notice [B3,R3,#7506].
  const moved = merged.filter(id => (receipt.landed ?? []).includes(id));
  if (moved.length) store.logEvent(board, 'coordinator', 'main-moved', null, { sha: receipt.trunk, job, items: moved });
  return { applied: merged.length > 0 || returned.length > 0, outcome: 'landed', merged, returned };
}
