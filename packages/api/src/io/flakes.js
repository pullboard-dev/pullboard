/**
 * A pulled gate's flake judgement on the board host: the paired reruns its receipt carries become flake observations
 * with their evidence and native runs (which file quarantines), and a red only in quarantined cases is excused [C7,H16].
 * Why on the board host: the runner reports what ran; only the board holds the ledger, the quarantines and the seat.
 */
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import * as store from '../../../store/index.js';
import { tryGit } from '../../../git/index.js';
import { CONFIG_FILE } from '../../../kernel/browser.js';

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const DIGEST = /^[0-9a-f]{64}$/u;

/** The board's flake moves and receipt store, or null on a board opened without them. */
function boardPorts(board) {
  const moves = board.enginePorts?.store, receipts = board.runtimePorts?.sourceAdvanceReceipts;
  return typeof moves?.recordFlakeObservation === 'function' && typeof receipts?.boardReceiptStore === 'function' ? { moves, receipts } : null;
}

/**
 * Whether this board quarantines tests: flakes.quarantine in the policy the gate judged, accepted main's committed
 * config. Why main's file: a board API host opens the board without the CLI's write policy, so quarantineEnabled may
 * be absent there; a board or main that cannot say quarantines nothing.
 */
function quarantining(board, main) {
  try { if (board.quarantineEnabled?.() === true) return true; } catch { /* read main's own policy below */ }
  if (!board.gitRoot || !SHA.test(String(main))) return false;
  const shown = tryGit(board.gitRoot, ['show', `${main}:${CONFIG_FILE}`]);
  try { return shown.status === 0 && JSON.parse(shown.stdout).flakes?.quarantine === true; } catch { return false; }
}

/**
 * The red cases a pulled gate receipt names, each under an active quarantine filed before it, or null when anything
 * else is red: a job error, a refusal, a shard plan, a red phase with no case account or any unquarantined case.
 * Why: a quarantined test still runs and reports, but its red no longer blocks a submit, as the controller's computed verdict did.
 *
 * @param {any} board
 * @param {Record<string, any>} receipt
 * @param {string} main - The accepted main the gate job was offered against, whose policy says whether quarantine is on.
 * @param {number | null} [before] - Only quarantines filed before this event excuse; null takes every active one.
 * @returns {{ file: string, name: string, item: number }[] | null}
 */
export function quarantinedReds(board, receipt, main, before = null) {
  const gate = receipt?.gate ?? {};
  const red = (gate.phases ?? []).filter(phase => phase.status !== 0);
  if (!quarantining(board, main) || gate.green === true || gate.error || gate.proofPlan || gate.analysis?.infra || gate.analysis?.refusals?.length || !red.length
    || red.some(phase => !Array.isArray(phase.failures) || !phase.failures.length)) return null;
  let active;
  try { active = board.enginePorts.store.flakeQuarantines(board).filter(row => row.status === 'quarantined' && (before === null || row.eventId < before)); } catch { return null; }
  const cases = red.flatMap(phase => phase.failures.map(row => ({ row, held: active.find(entry => entry.file === row.file && entry.name === row.name) })));
  return cases.every(entry => entry.held) ? cases.map(({ row, held }) => ({ file: row.file, name: row.name, item: held.item })) : null;
}

/** Write one probe's output as immutable evidence and describe it as a flake observation receipt does. */
function evidence(directory, id, label, text, green) {
  const bytes = Buffer.from(String(text ?? ''), 'utf8');
  writeFileSync(join(directory, label + '.log'), bytes, { flag: 'wx', mode: 0o600 });
  return { green, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, artifact: `flake-evidence/${id}/${label}.log`, profileSha256: null };
}

/** The controller's classification of one case from its paired and main results [C7,H16]. */
function classify(pairResult, mainResult) {
  if (mainResult === true) return ['possible-regression', 'The exact target passes on pinned main; this candidate failure is not a flake observation.'];
  if (pairResult === true && mainResult === false) return ['flake', 'The red target passed its one paired rerun at the same pinned head; original red retained.'];
  if (pairResult === false) return ['stable-red', 'The target remains red in its one paired rerun; original red retained.'];
  return ['unclassified', 'A probe did not establish the exact target at its pinned source; it remains unclassified.'];
}

/**
 * One version-two native run for a pulled phase or probe, stored byte for byte in the board's receipt folder, so the
 * board's gate-run record binds to it. Null when its outcomes are missing or the store refuses the body.
 */
function storedRun(ports, board, { item, submit, candidate, tree, main, runner, command, status, testOutcomes, durationMs, submitPhase, admission = null }) {
  if (!Array.isArray(testOutcomes) || !testOutcomes.length || ![0, 1].includes(status)) return null;
  const failures = testOutcomes.filter(row => !row.passed && !row.skipped).map(({ file, name }) => ({ file, name }));
  const run = { version: 2, id: randomUUID(), kind: 'submit', tree, head: candidate, main, command, green: status === 0 && !failures.length, failures,
    load: null, at: new Date().toISOString(), testOutcomes,
    proof: { item, frozenDigest: submit.digest ?? null, seat: submit.agentId, runner, exitCode: status, durationMs: Number.isSafeInteger(durationMs) && durationMs >= 0 ? durationMs : 0,
      sourceClean: true, environment: null, counts: { passed: null, failed: null, skipped: null }, submitPhase, ...(admission ? { diagnosticAdmission: admission } : {}) } };
  const body = ports.receipts.receiptBody(run);
  const folder = ports.receipts.boardReceiptStore(board);
  if (!body || !folder) return null;
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  writeFileSync(join(folder, run.id + '.json'), body, { mode: 0o600, flag: 'wx' });
  return JSON.parse(body);
}

/**
 * Record the paired reruns a red pulled gate receipt carries: one typed flake observation per paired case, with the
 * original, paired and main output kept as evidence beside the board (the board event binds each log's digest), then the red phase's and the pair's native runs,
 * whose red-and-green pair on one tree files the quarantine. Every failure is a note on the item, never a changed verdict.
 *
 * @param {any} board
 * @param {{ job: string, receipt: Record<string, any>, item: number, candidate: string, main: string, submit: Record<string, any>, queue?: { runs: { db: any } } | null }} gateJob
 * @returns {{ observations: number, runs: number } | null} null when the receipt carries no pairs.
 */
export function recordPulledPairs(board, { job, receipt, item, candidate, main, submit, admit = null, queue = null }) {
  const pairs = Array.isArray(receipt?.gate?.pairs) ? receipt.gate.pairs.filter(pair => typeof pair?.file === 'string' && Array.isArray(pair.names) && pair.paired) : [];
  const ports = boardPorts(board);
  const tree = submit.companion?.tree ?? submit.tree;
  if (!pairs.length || !ports || !SHA.test(String(candidate)) || !SHA.test(String(tree))) return null;
  const lane = store.getItem(board, item)?.item_lane;
  const evidenceRoot = join(dirname(ports.receipts.boardReceiptStore(board)), 'flake-evidence');
  // With runs_store on the job's receipt step is in the runs file the queue holds, not the board's job rows [B2,P7,#9007].
  const runner = (queue ? queue.runs.db : board.db).prepare("SELECT job_step_payload FROM job_step WHERE job_step_job = ? AND job_step_name = 'receipt' ORDER BY job_step_seq DESC LIMIT 1").get(job);
  const runnerName = runner ? JSON.parse(runner.job_step_payload).runner ?? null : null;
  const done = { observations: 0, runs: 0 }, problems = [];
  // The pair's runs name the Submit admission this gate job held, the witness the controller's Submit recorded as it paired [C7,H16].
  let witness;
  for (const pair of pairs) {
    const phase = (receipt.gate.phases ?? []).find(row => row.role === pair.phase && row.status !== 0);
    if (!phase) continue;
    for (const name of pair.names) {
      try {
        const id = randomUUID(), directory = join(evidenceRoot, id);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const pairResult = pair.paired.results?.[name] ?? null, mainResult = pair.main ? pair.main.results?.[name] ?? null : null;
        const [classification, reason] = classify(pairResult, mainResult);
        const observation = { id, file: pair.file, name, head: candidate, tree, main: SHA.test(String(main)) ? main : null, kind: 'submit', classification, reason,
          commandSha256: DIGEST.test(pair.commandSha256 ?? '') ? pair.commandSha256 : createHash('sha256').update(pair.file).digest('hex'),
          at: new Date().toISOString(), diagnosticMs: (pair.paired.ms ?? 0) + (pair.main?.ms ?? 0), load: pair.load,
          original: evidence(directory, id, 'original', phase.tail, false), paired: evidence(directory, id, 'paired', pair.paired.tail, pair.paired.status === 0),
          mainReceipt: pair.main ? evidence(directory, id, 'main', pair.main.tail, pair.main.status === 0) : null };
        ports.moves.recordFlakeObservation(board, { agentId: submit.agentId, observation, lane });
        done.observations += 1;
      } catch (error) { problems.push(`${pair.file} :: ${name}: ${error?.code ?? 'FLAKE_DIAGNOSTIC_FAILED'}`); }
    }
    // The red phase's run and the pair's run, both with per-case outcomes on the candidate's tree, are what files a quarantine.
    try {
      witness ??= admit?.() ?? null;
      const fields = { item, submit, candidate, tree, main, runner: runnerName, command: pair.commandSha256, admission: witness?.id };
      const original = storedRun(ports, board, { ...fields, status: phase.status, testOutcomes: phase.testOutcomes, durationMs: receipt.gate.steps?.[phase.role], submitPhase: phase.role === 'check' ? 'criterion' : 'proof' });
      const paired = original && storedRun(ports, board, { ...fields, status: pair.paired.status, testOutcomes: pair.paired.testOutcomes, durationMs: pair.paired.ms, submitPhase: 'diagnostic' });
      for (const run of paired ? [original, paired] : []) { ports.moves.recordGateRun(board, { agentId: submit.agentId, receipt: run, lane }); done.runs += 1; }
    } catch (error) { problems.push(`${pair.file} native runs: ${error?.code ?? 'GATE_RUN_UNRECORDED'}`); }
  }
  store.appendFact(board, item, { agentId: submit.agentId, kind: 'note', text: `Gate job ${job} paired its red: ${done.observations} flake observation(s), ${done.runs} native run(s) recorded; the red stands; see pullboard flakes.${problems.length ? `\nNot recorded: ${problems.join('; ')}` : ''}`.slice(0, 2000) });
  return done;
}

/**
 * Judge a pulled gate receipt's flakes once: the quarantines in force before its pairs were first recorded excuse its
 * reds, and its pairs are recorded only on the first application. Why: a red waiting on main's receipts is applied
 * again when they record (settleWaitingGates), and its own pairs' quarantine must never excuse it then [C7,H16].
 *
 * @param {any} board
 * @param {Parameters<typeof recordPulledPairs>[1]} gateJob
 * @returns {ReturnType<typeof quarantinedReds>}
 */
export function judgePulledFlakes(board, gateJob) {
  const { job, item, receipt, main } = gateJob;
  const paired = board.db.prepare("SELECT MIN(event_id) AS id FROM event WHERE item_id = ? AND event_kind = 'fact' AND json_extract(event_detail, '$.text') LIKE ?")
    .get(item, `Gate job ${job} pairs its red:%`)?.id ?? null;
  const excused = quarantinedReds(board, receipt, main, paired);
  if (paired === null && Array.isArray(receipt?.gate?.pairs) && receipt.gate.pairs.length) {
    // The marker comes first, so every quarantine the pairs file sits after it.
    store.appendFact(board, item, { agentId: gateJob.submit.agentId, kind: 'note', text: `Gate job ${job} pairs its red: ${receipt.gate.pairs.map(pair => pair?.file).join(', ')}`.slice(0, 2000) });
    recordPulledPairs(board, gateJob);
  }
  return excused;
}

/**
 * Record what a red land job's runner read: one flake observation per failing case, as the coordinator. A case the
 * runner paired is classified from its paired and main results; with reruns off (or a case beyond the pair budget) the
 * observation is unclassified with no paired run, so the ledger still retains the original red. The red stays the verdict;
 * every failure is a note on the item, never a changed outcome [C7,H16].
 *
 * @param {any} board
 * @param {{ job: string, receipt: Record<string, any>, item: number | null }} landing - item: the first item the receipt returned red, whose lane owns any repair item.
 * @returns {{ observations: number } | null} null when the receipt carries no red record.
 */
export function recordLandedRed(board, { job, receipt, item }) {
  const red = receipt?.red;
  const ports = boardPorts(board);
  if (!ports || !Array.isArray(red?.failures) || !red.failures.length || !SHA.test(String(red.head)) || !SHA.test(String(red.tree))) return null;
  const lane = item === null ? undefined : store.getItem(board, item)?.item_lane;
  const evidenceRoot = join(dirname(ports.receipts.boardReceiptStore(board)), 'flake-evidence');
  const main = SHA.test(String(receipt.base)) ? receipt.base : null;
  const load = Array.isArray(red.load?.average) && red.load.average.length === 3 ? red.load : { average: [0, 0, 0], cpus: 1, freeMB: 0 };
  const pairs = Array.isArray(red.pairs) ? red.pairs : [];
  let observations = 0;
  const problems = [];
  for (const { file, name } of red.failures) {
    try {
      const id = randomUUID(), directory = join(evidenceRoot, id);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const pair = pairs.find(row => row?.file === file && Array.isArray(row.names) && row.names.includes(name) && row.paired);
      const [classification, reason] = pair ? classify(pair.paired.results?.[name] ?? null, pair.main ? pair.main.results?.[name] ?? null : null)
        : ['unclassified', 'The landing ran no paired rerun for this case; its original red is retained.'];
      const observation = { id, file, name, head: red.head, tree: red.tree, main, kind: 'land', classification, reason,
        commandSha256: DIGEST.test(pair?.commandSha256 ?? '') ? pair.commandSha256 : createHash('sha256').update(`${file}\n${name}`).digest('hex'),
        at: new Date().toISOString(), diagnosticMs: pair ? (pair.paired.ms ?? 0) + (pair.main?.ms ?? 0) : 0, load: pair?.load ?? load,
        original: evidence(directory, id, 'original', red.tail, false), paired: pair ? evidence(directory, id, 'paired', pair.paired.tail, pair.paired.status === 0) : null,
        mainReceipt: pair?.main ? evidence(directory, id, 'main', pair.main.tail, pair.main.status === 0) : null };
      ports.moves.recordFlakeObservation(board, { agentId: 'coordinator', observation, lane });
      observations += 1;
    } catch (error) { problems.push(`${file} :: ${name}: ${error?.code ?? 'FLAKE_DIAGNOSTIC_FAILED'}`); }
  }
  if (item !== null) store.appendFact(board, item, { agentId: 'coordinator', kind: 'note', text: `Land job ${job} red: ${observations} flake observation(s) recorded${pairs.length ? ' with paired reruns' : ', no paired rerun'}; the red stands; see pullboard flakes.${problems.length ? `\nNot recorded: ${problems.join('; ')}` : ''}`.slice(0, 2000) });
  return { observations };
}
