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
import { offerJob } from './jobs.js';
import { LANDING_JOB_KIND } from './landing.js';

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const PROJECT_FILE = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\0\n\r]{1,4096}$/u;
// Budget: a red's failing parts are named one line each, bounded so a fact stays a readable record.
const PART_TEXT = 600;
/** The job kind of one part of a pulled gate's proof, which the board offers from the gate's plan and any runner pulls [P7]. */
export const SHARD_JOB_KIND = 'gate-shard';
// Budget: one gate's proof splits into at most 32 shard jobs, so one receipt never floods the queue.
const MAX_SHARDS = 32;

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

/** The request a job was offered with, or null. */
function offeredRequest(db, job) {
  const row = db.prepare("SELECT job_step_payload FROM job_step WHERE job_step_job = ? AND job_step_name = 'offered' AND job_step_seq = 0").get(job);
  return row ? JSON.parse(row.job_step_payload) : null;
}

/** The newest receipt posted for a job, or null. */
function postedReceipt(db, job) {
  const row = db.prepare("SELECT job_step_payload FROM job_step WHERE job_step_job = ? AND job_step_name = 'receipt' ORDER BY job_step_seq DESC LIMIT 1").get(job);
  return row ? JSON.parse(row.job_step_payload) : null;
}

/** Quote one word for a shell, as the gate's planner quotes the files it names. */
function shellWord(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/** The shard jobs offered for one gate job, oldest first. */
function shardJobs(db, job) {
  const prefix = `${job}:shard:`;
  return db.prepare('SELECT job_id, job_step FROM job WHERE job_kind = ? AND substr(job_id, 1, ?) = ? ORDER BY job_created, job_id').all(SHARD_JOB_KIND, prefix.length, prefix);
}

/**
 * Offer a gate's proof as shard jobs: its plan's files split round-robin into one shard per runner's worth of cores,
 * each a job any runner pulls and runs through the gate's own bootstrap and entry. Null when the plan is not one the
 * board can split. Why the board offers them: it already holds the queue, so runners never need offer credentials [P7].
 *
 * @returns {{ applied: true, outcome: 'sharded', shards: string[] } | null}
 */
function offerProofShards(board, { job, receipt, offered }) {
  const gate = receipt?.gate ?? {};
  const plan = gate.proofPlan;
  const files = Array.isArray(plan?.files) ? plan.files : [];
  const cores = Number.isSafeInteger(plan?.cores) && plan.cores > 0 ? plan.cores : 0;
  if (receipt?.status === undefined || gate.error || gate.analysis?.infra || gate.analysis?.refusals?.length || (gate.phases ?? []).some(phase => phase.status !== 0)
    || typeof plan?.runner !== 'string' || !plan.runner.trim() || /[\0\n\r]/u.test(plan.runner) || !cores || files.length <= cores
    || files.some(file => typeof file !== 'string' || !PROJECT_FILE.test(file))) return null;
  const request = offeredRequest(board.db, job);
  const gateRequest = request?.request;
  if (!Array.isArray(gateRequest?.run) || typeof gateRequest.input?.entry !== 'string') return null;
  const count = Math.min(MAX_SHARDS, Math.ceil(files.length / cores));
  const buckets = Array.from({ length: count }, () => []);
  files.forEach((file, at) => buckets[at % count].push(file));
  const ids = buckets.map((part, index) => {
    const command = `${plan.runner.trim()} ${part.map(file => shellWord('./' + file)).join(' ')}`;
    return offerJob(board.db, { id: `${job}:shard:${index + 1}`, kind: SHARD_JOB_KIND, needs: request.needs ?? [], item: offered.item, candidate: offered.candidate, base: offered.main,
      request: { run: gateRequest.run, gate: job, commits: gateRequest.commits ?? [],
        input: { main: offered.main, entry: gateRequest.input.entry, data: { main: offered.main, source: offered.candidate, shard: { index: index + 1, of: count, files: part, command } } } } }).id;
  });
  store.appendFact(board, offered.item, { agentId: offered.submit.agentId, kind: 'note',
    text: `Gate job ${job} passed its checks at ${offered.candidate.slice(0, 12)}; its proof of ${files.length} files is offered as ${count} shard jobs any runner pulls, and the gate result applies when the last one posts.` });
  return { applied: true, outcome: 'sharded', shards: ids };
}

/**
 * The gate receipt the shards of one proof make together: the gate's own receipt with one proof phase that is green
 * only when every shard is, naming every failing case its red shards name (none when any red shard names none).
 */
function combinedReceipt(gateReceipt, shards) {
  const gate = gateReceipt.gate ?? {};
  const parts = shards.map(({ job, posted }) => {
    const shardGate = posted?.receipt?.gate ?? {};
    const phase = (shardGate.phases ?? []).find(row => row.role === 'proof') ?? null;
    const green = posted?.receipt?.status === 0 && shardGate.green === true && phase?.status === 0;
    return { job, runner: posted?.runner ?? null, green, phase, error: shardGate.error ?? null, files: shardGate.shard?.files?.length ?? null, ms: shardGate.steps?.proof ?? 0 };
  });
  const reds = parts.filter(part => !part.green);
  const counts = parts.map(part => tailCounts(part.phase?.tail));
  const sum = key => counts.every(row => row[key] !== null) ? counts.reduce((total, row) => total + row[key], 0) : null;
  const totals = [['pass', sum('passed')], ['fail', sum('failed')], ['skipped', sum('skipped')]].filter(([, n]) => n !== null).map(([name, n]) => `# ${name} ${n}`);
  const tail = [...reds.map(part => `shard ${part.job}: ${String(part.error ?? part.phase?.tail ?? 'no proof phase').slice(-PART_TEXT)}`), ...totals].join('\n');
  const failures = reds.length && reds.every(part => Array.isArray(part.phase?.failures) && part.phase.failures.length) ? reds.flatMap(part => part.phase.failures) : null;
  const proof = { role: 'proof', status: reds.length ? (reds.find(part => part.phase?.status)?.phase.status ?? 1) : 0, signal: reds.find(part => part.phase?.signal)?.phase.signal ?? null,
    sha256: createHash('sha256').update(parts.map(part => part.phase?.sha256 ?? '').join('\n')).digest('hex'), bytes: parts.reduce((total, part) => total + (part.phase?.bytes ?? 0), 0), tail,
    ...(reds.length ? { failures } : {}) };
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
  const parent = offeredRequest(board.db, job)?.request?.gate;
  if (typeof parent !== 'string') return { applied: false, outcome: 'not-shard' };
  const shards = shardJobs(board.db, parent);
  const remaining = shards.filter(row => row.job_step !== 'done').length;
  if (remaining) return { applied: false, outcome: 'waiting', remaining };
  const gateReceipt = postedReceipt(board.db, parent)?.receipt;
  if (!gateReceipt?.gate?.proofPlan) return { applied: false, outcome: 'not-shard' };
  const combined = combinedReceipt(gateReceipt, shards.map(row => ({ job: row.job_id, posted: postedReceipt(board.db, row.job_id) })));
  return applyGateReceipt(board, { job: parent, receipt: combined }, ports);
}

/** One line per part that failed: analysis refusals, each failing case of a red phase (its output's tail when it names none), or the job's own error. */
export function failingParts(receipt) {
  const gate = receipt?.gate ?? {};
  const clip = text => String(text ?? '').replace(/\s+/gu, ' ').trim().slice(-PART_TEXT);
  const parts = [];
  if (gate.error) parts.push(`gate: ${clip(gate.error)}`);
  if (gate.analysis?.infra) parts.push(`infrastructure: ${clip(typeof gate.analysis.infra === 'string' ? gate.analysis.infra : JSON.stringify(gate.analysis.infra))}`);
  for (const refusal of gate.analysis?.refusals ?? []) parts.push(`${refusal.part} ${refusal.code ?? 'REFUSED'}: ${clip(refusal.message)}`);
  for (const phase of gate.phases ?? []) {
    if (phase.status === 0) continue;
    // A phase whose receipt names its cases lists them as the controller gate does, file :: case name.
    const cases = Array.isArray(phase.failures) ? phase.failures.filter(row => typeof row?.file === 'string' && row.file && typeof row.name === 'string' && row.name) : [];
    if (cases.length) parts.push(...cases.map(row => `${phase.role} failed: ${row.file} :: ${clip(row.name)}`));
    else parts.push(`${phase.role} exited ${phase.status ?? phase.signal}: ${clip(phase.tail)}`);
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
 * @param {((request: { root: string, db: import('node:sqlite').DatabaseSync, main: string, cases: { file: string, name: string }[] }) =>
 *   { classes: { file: string, owner: string, own: string[], receipt: unknown, job: string | null }[] } | null) | null} lookup
 * @returns {{ cases: { phase: string, file: string, name: string, onMain: boolean | null, receipt: string | null }[], jobs: string[] } | null}
 *   null when the red is not only test cases (a job error, infrastructure, a refusal, a phase with no case account),
 *   when no lookup is given (gate.mainComparison off) or when main's receipts cannot be keyed.
 */
export function compareGateWithMain(board, receipt, main, lookup) {
  const gate = receipt?.gate ?? {};
  if (typeof lookup !== 'function' || !board.gitRoot || !SHA.test(String(main)) || gate.error || gate.analysis?.infra || gate.analysis?.refusals?.length) return null;
  const red = (gate.phases ?? []).filter(phase => phase.status !== 0);
  if (!red.length || red.some(phase => !Array.isArray(phase.failures) || !phase.failures.length
    || phase.failures.some(row => typeof row?.name !== 'string' || !row.name || !PROJECT_FILE.test(row?.file ?? '')))) return null;
  const cases = red.flatMap(phase => phase.failures.map(({ file, name }) => ({ phase: String(phase.role), file, name })));
  let found = null;
  try { found = lookup({ root: board.gitRoot, db: board.db, main, cases: cases.map(({ file, name }) => ({ file, name })) }); } catch (error) { if (!error?.code) throw error; }
  const classes = new Map((found?.classes ?? []).map(row => [row.file, row]));
  if (cases.some(row => !classes.has(row.file))) return null;
  const receiptId = value => typeof value === 'string' ? value : typeof value?.id === 'string' ? value.id : null;
  return {
    cases: cases.map(row => {
      const one = classes.get(row.file);
      return { ...row, onMain: one.owner === 'unknown' ? null : !one.own.includes(row.name), receipt: receiptId(one.receipt) };
    }),
    jobs: [...new Set([...classes.values()].map(row => row.job).filter(Boolean))],
  };
}

/** One line per compared case, saying whether main fails it too. */
function caseLines(compared) {
  return compared.cases.map(row => `${row.onMain === true ? 'also fails on main' : row.onMain === false ? 'new' : 'main receipt missing'}: ${row.phase} ${row.file} (${row.name})`);
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
export function applyGateReceipt(board, { job, receipt }, { compareWithMain = null } = {}) {
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
  // A gate that left its proof to shards waits for them; the gate result applies when the last shard posts [P7].
  if (receipt?.gate?.proofPlan) {
    const sharded = offerProofShards(board, { job, receipt, offered });
    if (sharded) return sharded;
  }
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
  const compared = green ? null : compareGateWithMain(board, receipt, main, compareWithMain);
  const mainOnly = Boolean(compared?.cases.length) && compared.cases.every(row => row.onMain === true);
  const recorded = compared ? { cases: compared.cases } : {};
  let parts = compared ? [...failingParts({ ...receipt, gate: { ...receipt.gate, phases: [] } }).filter(part => !part.startsWith('the gate job exited')), ...caseLines(compared)] : failingParts(receipt);
  if (compared?.jobs.length) parts.push(`main-test job ${compared.jobs.join(', ')} queued for main's missing receipts; submit again once it records`);
  if (green || mainOnly) {
    const files = Array.isArray(receipt.gate?.analysis?.proofFiles) ? receipt.gate.analysis.proofFiles.filter(file => typeof file === 'string' && PROJECT_FILE.test(file)) : [];
    try {
      store.submit(board, id, { agentId: submit.agentId, commit: candidate, tree: submit.tree, files: submit.files ?? [], policyCommit: main, gateGreen: green,
        submissionProof: { version: 1, files, full: false, deferred: false, reason: `pulled gate job ${job}${mainOnly ? '; red only in cases that also fail on main' : ''}` } });
      if (mainOnly) store.appendFact(board, id, { agentId: submit.agentId, kind: 'measurement', text: `Gate job ${job} red at ${candidate.slice(0, 12)} only in cases that also fail on main ${String(main).slice(0, 12)} (not this item's; accepted):\n${caseLines(compared).join('\n')}\nReviewers: these main reds are listed, not blocking; no new failure is accepted.` });
      store.appendFact(board, id, { agentId: submit.agentId, kind: 'note', text: `Gate job ${job} ${green ? 'green' : 'red only on main\'s own cases'} at ${candidate.slice(0, 12)} on main ${String(main).slice(0, 12)}; submitted for review.` });
      return { applied: true, outcome: 'review', ...recorded };
    } catch (error) {
      // A green gate whose submission the board refuses goes back to the builder with the refusal, never lost in a log.
      if (!error?.code) throw error;
      parts = [`submit ${error.code}: ${error.message}`];
    }
  }
  store.appendFact(board, id, { agentId: submit.agentId, kind: 'measurement', text: `Gate job ${job} ${green || mainOnly ? 'passed but not submitted' : 'red'} at ${candidate.slice(0, 12)}; failing parts:\n${parts.join('\n')}` });
  // The shout only wakes the builder; the fact above is the record, so a refused shout leaves the red recorded.
  try {
    store.shout(board, { from: 'coordinator', to: submit.agentId, lanes: [], item: id,
      text: `#${id} gate red at ${candidate.slice(0, 7)}: ${parts.find(part => !part.startsWith('also fails on main')) ?? parts[0] ?? 'see pullboard show'}`.slice(0, 280) });
  } catch (error) { if (error?.code === undefined) throw error; }
  return { applied: true, outcome: 'red', ...recorded };
}

/** The main-receipt lookup this process's board API applies red gate receipts with; null until a host provides one. */
let mainComparison = null;

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
 * @param {Parameters<typeof jobQueueCall>[2] & { compareWithMain?: Parameters<typeof compareGateWithMain>[3] }} options - compareWithMain:
 *   main's receipt lookup for a red gate's cases; the one provided to this process by default.
 */
export function boardJobQueueCall(board, body, { compareWithMain = mainComparison, ...options }) {
  return jobQueueCall(board.db, body, { ...options, onReceipt: posted => applyJobReceipt(board, posted, { compareWithMain }) });
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
  const commit = SHA.test(String(receipt?.source ?? '')) ? receipt.source : null;
  const rows = [];
  for (const phase of Array.isArray(receipt?.phases) ? receipt.phases : []) {
    const { contexts, files } = phase?.ledger ?? {};
    if (!Array.isArray(contexts) || !Array.isArray(files)) continue;
    for (const [file, inputKey, context, status] of files.filter(Array.isArray)) {
      rows.push({ file, inputKey, command: String(phase.role ?? 'proof'), context: contexts[context], status });
    }
  }
  return store.recordTestResults(board.db, { receipt: `${job}#${attempt}`, origin: `${origin}:${runner}`, commit, rows });
}

/** Apply one newly recorded receipt by its job's kind; kinds with no board effect only stay recorded. */
export function applyJobReceipt(board, posted, ports = {}) {
  const kind = board.db.prepare('SELECT job_kind FROM job WHERE job_id = ?').get(posted.job)?.job_kind;
  if (kind === 'gate' || kind === SHARD_JOB_KIND) recordReceiptLedger(board, posted, kind === 'gate' ? 'pulled' : 'shard');
  if (kind === 'gate') return applyGateReceipt(board, posted, ports);
  if (kind === SHARD_JOB_KIND) return applyShardReceipt(board, posted, ports);
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
