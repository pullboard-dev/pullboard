/**
 * A posted runner job receipt applied to the board: a gate's receipt becomes its item's gate result (green submits it for
 * review, red hands it back to its builder), and a landing's receipt marks its items merged at the pushed commit [P7].
 */
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as store from '../../../store/index.js';
import { jobQueueCall } from './jobs.js';
import { LANDING_JOB_KIND } from './landing.js';

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const PROJECT_FILE = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\0\n\r]{1,4096}$/u;
// Budget: a red's failing parts are named one line each, bounded so a fact stays a readable record.
const PART_TEXT = 600;

/** The newest gate job offered for an item, so an older candidate's receipt reads as stale. */
function latestGateJob(db, item) {
  return db.prepare("SELECT job_id FROM job WHERE job_kind = 'gate' AND job_item = ? ORDER BY job_created DESC, rowid DESC LIMIT 1").get(item)?.job_id ?? null;
}

/** The job's kind, item, candidate, base, frozen check and the submit fields its offer recorded; null when the job is gone. */
function offeredGate(db, job) {
  const row = db.prepare(`SELECT job.job_kind, job.job_item, job.job_candidate, job.job_base, step.job_step_payload FROM job JOIN job_step AS step
    ON step.job_step_job = job.job_id AND step.job_step_name = 'offered' AND step.job_step_seq = 0 WHERE job.job_id = ?`).get(job);
  if (!row) return null;
  const request = JSON.parse(row.job_step_payload).request ?? null;
  return { kind: row.job_kind, item: row.job_item, candidate: row.job_candidate, main: row.job_base, submit: request?.submit ?? null,
    check: typeof request?.input?.data?.check === 'string' ? request.input.data.check : null };
}

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
 * Record a green gate job's phases as the item's native proof-run receipts, the evidence today's submit records and
 * pullboard show lists: one version-two submit receipt per phase, stored in the board's gate receipt folder beside
 * its database and then bound to the item by recordProofRun, so the board reads the same bytes it stored.
 *
 * Why the board host writes them: the runner holds the job's lease token, and the receipt it posted under that token
 * is the run's own report; the board stamps the item, seat and bar the job was offered for [P7].
 *
 * @returns {string[]} the receipt ids recorded, in phase order
 */
function recordPhaseReceipts(board, { job, receipt, id, candidate, main, submit, check }) {
  const { boardReceiptStore, receiptBody } = board.runtimePorts?.sourceAdvanceReceipts ?? {};
  const folder = typeof boardReceiptStore === 'function' ? boardReceiptStore(board) : null;
  if (!folder) return [];
  const gate = receipt.gate ?? {};
  const runner = board.db.prepare("SELECT job_step_payload FROM job_step WHERE job_step_job = ? AND job_step_name = 'receipt' ORDER BY job_step_seq DESC LIMIT 1").get(job);
  const runnerName = runner ? JSON.parse(runner.job_step_payload).runner ?? null : null;
  const environment = gate.environment && ['node', 'platform', 'arch'].every(key => typeof gate.environment[key] === 'string' && gate.environment[key])
    ? { node: gate.environment.node, platform: gate.environment.platform, arch: gate.environment.arch } : null;
  const ids = [];
  for (const phase of gate.phases ?? []) {
    const submitPhase = SUBMIT_PHASES[phase.role];
    if (!submitPhase || phase.status !== 0) continue;
    const command = phase.role === 'check' ? check : gate.analysis?.proofCommand;
    const run = { version: 2, id: randomUUID(), kind: 'submit', tree: submit.tree, head: candidate, main,
      command: createHash('sha256').update(String(command ?? phase.role)).digest('hex'), green: true, failures: [], load: null, at: new Date().toISOString(),
      proof: { item: id, frozenDigest: submit.digest ?? null, seat: submit.agentId, runner: runnerName, exitCode: phase.status,
        durationMs: Number.isSafeInteger(gate.steps?.[phase.role]) && gate.steps[phase.role] >= 0 ? gate.steps[phase.role] : 0,
        sourceClean: true, environment, counts: tailCounts(phase.tail), submitPhase } };
    const body = receiptBody(run);
    if (!body) continue;
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    writeFileSync(join(folder, `${run.id}.json`), body, { mode: 0o600, flag: 'wx' });
    store.recordProofRun(board, { agentId: submit.agentId, itemId: id, receiptId: run.id });
    ids.push(run.id);
  }
  return ids;
}

/** One line per part that failed: analysis refusals, red phases with their output's tail, or the job's own error. */
export function failingParts(receipt) {
  const gate = receipt?.gate ?? {};
  const clip = text => String(text ?? '').replace(/\s+/gu, ' ').trim().slice(-PART_TEXT);
  const parts = [];
  if (gate.error) parts.push(`gate: ${clip(gate.error)}`);
  if (gate.analysis?.infra) parts.push(`infrastructure: ${clip(typeof gate.analysis.infra === 'string' ? gate.analysis.infra : JSON.stringify(gate.analysis.infra))}`);
  for (const refusal of gate.analysis?.refusals ?? []) parts.push(`${refusal.part} ${refusal.code ?? 'REFUSED'}: ${clip(refusal.message)}`);
  for (const phase of gate.phases ?? []) if (phase.status !== 0) parts.push(`${phase.role} exited ${phase.status ?? phase.signal}: ${clip(phase.tail)}`);
  if (!parts.length && receipt?.status !== 0) parts.push(`the gate job exited ${receipt?.status ?? receipt?.signal}`);
  return parts;
}

/**
 * Apply one newly recorded gate-job receipt to its item. The receipt counts only while it is for the item's current
 * candidate: the newest gate job offered for the item, its source, still claimed by the seat that submitted it at the
 * same frozen bar. Anything else is stale: the receipt stays recorded on the job and the item is left as it is.
 *
 * Green records the item's submission at the candidate, as a green submit would, so it routes to review. Red keeps the
 * item claimed by its builder, records the failing parts on its thread and shouts them to the builder.
 *
 * Why here: the receipt is the gate's result, and the board host only writes rows; it starts no process and no gate.
 *
 * @param {any} board - The open board, with gitRoot set when the board host holds the repository.
 * @param {{ job: string, receipt: Record<string, any> }} posted
 * @returns {{ applied: boolean, outcome: 'review' | 'red' | 'stale' | 'not-gate', reason?: string }}
 */
export function applyGateReceipt(board, { job, receipt }) {
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
  // A green gate's phases become the item's native proof-run receipts before its submission, as today's submit records them [P7].
  if (receipt?.status === 0 && receipt?.gate?.green === true) {
    try { recordPhaseReceipts(board, { job, receipt, id, candidate, main, submit, check: offered.check }); }
    catch (error) {
      // A receipt the board refuses is named on the thread; the gate's result still applies, so the item is never stranded.
      if (!error?.code) throw error;
      store.appendFact(board, id, { agentId: submit.agentId, kind: 'note', text: `Gate job ${job}'s proof-run receipts were not recorded: ${error.code}: ${error.message}`.slice(0, 2000) });
    }
  }
  const green = receipt?.status === 0 && receipt?.gate?.green === true;
  let parts = failingParts(receipt);
  if (green) {
    const files = Array.isArray(receipt.gate.analysis?.proofFiles) ? receipt.gate.analysis.proofFiles.filter(file => typeof file === 'string' && PROJECT_FILE.test(file)) : [];
    try {
      store.submit(board, id, { agentId: submit.agentId, commit: candidate, tree: submit.tree, files: submit.files ?? [], policyCommit: main, gateGreen: true,
        submissionProof: { version: 1, files, full: false, deferred: false, reason: `pulled gate job ${job}` } });
      store.appendFact(board, id, { agentId: submit.agentId, kind: 'note', text: `Gate job ${job} green at ${candidate.slice(0, 12)} on main ${String(main).slice(0, 12)}; submitted for review.` });
      return { applied: true, outcome: 'review' };
    } catch (error) {
      // A green gate whose submission the board refuses goes back to the builder with the refusal, never lost in a log.
      if (!error?.code) throw error;
      parts = [`submit ${error.code}: ${error.message}`];
    }
  }
  store.appendFact(board, id, { agentId: submit.agentId, kind: 'measurement', text: `Gate job ${job} ${green ? 'green but not submitted' : 'red'} at ${candidate.slice(0, 12)}; failing parts:\n${parts.join('\n')}` });
  // The shout only wakes the builder; the fact above is the record, so a refused shout leaves the red recorded.
  try {
    store.shout(board, { from: 'coordinator', to: submit.agentId, lanes: [], item: id,
      text: `#${id} gate red at ${candidate.slice(0, 7)}: ${parts[0] ?? 'see pullboard show'}`.slice(0, 280) });
  } catch (error) { if (error?.code === undefined) throw error; }
  return { applied: true, outcome: 'red' };
}

/**
 * Answer one job queue call on an open board, applying each newly recorded receipt to it: the board API's jobs route.
 *
 * @param {any} board - The open board, gitRoot set to the board host's repository.
 * @param {Record<string, any>} body
 * @param {Parameters<typeof jobQueueCall>[2]} options
 */
export function boardJobQueueCall(board, body, options) {
  return jobQueueCall(board.db, body, { ...options, onReceipt: posted => applyJobReceipt(board, posted) });
}

/** Apply one newly recorded receipt by its job's kind; kinds with no board effect only stay recorded. */
export function applyJobReceipt(board, posted) {
  const kind = board.db.prepare('SELECT job_kind FROM job WHERE job_id = ?').get(posted.job)?.job_kind;
  if (kind === 'gate') return applyGateReceipt(board, posted);
  if (kind === LANDING_JOB_KIND) return applyLandingReceipt(board, posted);
  return { applied: false, outcome: 'recorded' };
}

/**
 * Mark each item a landed receipt names merged at the trunk commit the runner pushed: the items it merged and those
 * trunk already held. An item no longer accepted and unmerged is left as it is. Any other outcome (a conflict, a red
 * check, a busy trunk) changes no item; the items stay accepted for the next landing.
 *
 * @param {any} board
 * @param {{ job: string, receipt: Record<string, any> }} posted
 * @returns {{ applied: boolean, outcome: string, merged?: number[] }}
 */
export function applyLandingReceipt(board, { job, receipt }) {
  if (receipt?.outcome !== 'landed' || !SHA.test(receipt.trunk ?? '')) return { applied: false, outcome: String(receipt?.outcome ?? 'unknown') };
  const offered = JSON.parse(board.db.prepare("SELECT job_step_payload FROM job_step WHERE job_step_job = ? AND job_step_name = 'offered' AND job_step_seq = 0").get(job)?.job_step_payload ?? '{}');
  const named = new Set((offered.payload?.items ?? []).map(entry => entry.id));
  const merged = [];
  for (const id of [...(receipt.landed ?? []), ...(receipt.already ?? [])]) {
    if (!named.has(id)) continue;
    const item = store.getItem(board, id);
    if (item?.item_status !== 'verified' || item.item_merged_commit) continue;
    store.merged(board, id, { agentId: 'coordinator', commit: receipt.trunk, note: `landed by runner job ${job}` });
    merged.push(id);
  }
  return { applied: merged.length > 0, outcome: 'landed', merged };
}
