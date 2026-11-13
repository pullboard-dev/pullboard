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

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const DIGEST = /^[0-9a-f]{64}$/u;

/** The board's flake moves and receipt store, or null on a board opened without them. */
function boardPorts(board) {
  const moves = board.enginePorts?.store, receipts = board.runtimePorts?.sourceAdvanceReceipts;
  return typeof moves?.recordFlakeObservation === 'function' && typeof receipts?.boardReceiptStore === 'function' ? { moves, receipts } : null;
}

/** Whether this board quarantines tests (flakes.quarantine); a board that cannot say quarantines nothing. */
function quarantining(board) {
  try { return board.quarantineEnabled?.() === true; } catch { return false; }
}

/**
 * The red cases a pulled gate receipt names, each under an active quarantine filed before it, or null when anything
 * else is red: a job error, a refusal, a shard plan, a red phase with no case account or any unquarantined case.
 * Why: a quarantined test still runs and reports, but its red no longer blocks a submit, as the controller's computed verdict did.
 *
 * @param {any} board
 * @param {Record<string, any>} receipt
 * @returns {{ file: string, name: string, item: number }[] | null}
 */
export function quarantinedReds(board, receipt) {
  const gate = receipt?.gate ?? {};
  const red = (gate.phases ?? []).filter(phase => phase.status !== 0);
  if (!quarantining(board) || gate.green === true || gate.error || gate.proofPlan || gate.analysis?.infra || gate.analysis?.refusals?.length || !red.length
    || red.some(phase => !Array.isArray(phase.failures) || !phase.failures.length)) return null;
  let active;
  try { active = board.enginePorts.store.flakeQuarantines(board).filter(row => row.status === 'quarantined'); } catch { return null; }
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
function storedRun(ports, board, { item, submit, candidate, tree, main, runner, command, status, testOutcomes, durationMs, submitPhase }) {
  if (!Array.isArray(testOutcomes) || !testOutcomes.length || ![0, 1].includes(status)) return null;
  const failures = testOutcomes.filter(row => !row.passed && !row.skipped).map(({ file, name }) => ({ file, name }));
  const run = { version: 2, id: randomUUID(), kind: 'submit', tree, head: candidate, main, command, green: status === 0 && !failures.length, failures,
    load: null, at: new Date().toISOString(), testOutcomes,
    proof: { item, frozenDigest: submit.digest ?? null, seat: submit.agentId, runner, exitCode: status, durationMs: Number.isSafeInteger(durationMs) && durationMs >= 0 ? durationMs : 0,
      sourceClean: true, environment: null, counts: { passed: null, failed: null, skipped: null }, submitPhase } };
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
 * @param {{ job: string, receipt: Record<string, any>, item: number, candidate: string, main: string, submit: Record<string, any> }} gateJob
 * @returns {{ observations: number, runs: number } | null} null when the receipt carries no pairs.
 */
export function recordPulledPairs(board, { job, receipt, item, candidate, main, submit }) {
  const pairs = Array.isArray(receipt?.gate?.pairs) ? receipt.gate.pairs.filter(pair => typeof pair?.file === 'string' && Array.isArray(pair.names) && pair.paired) : [];
  const ports = boardPorts(board);
  const tree = submit.companion?.tree ?? submit.tree;
  if (!pairs.length || !ports || !SHA.test(String(candidate)) || !SHA.test(String(tree))) return null;
  const lane = store.getItem(board, item)?.item_lane;
  const evidenceRoot = join(dirname(ports.receipts.boardReceiptStore(board)), 'flake-evidence');
  const runner = board.db.prepare("SELECT job_step_payload FROM job_step WHERE job_step_job = ? AND job_step_name = 'receipt' ORDER BY job_step_seq DESC LIMIT 1").get(job);
  const runnerName = runner ? JSON.parse(runner.job_step_payload).runner ?? null : null;
  const done = { observations: 0, runs: 0 }, problems = [];
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
      const fields = { item, submit, candidate, tree, main, runner: runnerName, command: pair.commandSha256 };
      const original = storedRun(ports, board, { ...fields, status: phase.status, testOutcomes: phase.testOutcomes, durationMs: receipt.gate.steps?.[phase.role], submitPhase: phase.role === 'check' ? 'criterion' : 'proof' });
      const paired = original && storedRun(ports, board, { ...fields, status: pair.paired.status, testOutcomes: pair.paired.testOutcomes, durationMs: pair.paired.ms, submitPhase: 'diagnostic' });
      for (const run of paired ? [original, paired] : []) { ports.moves.recordGateRun(board, { agentId: submit.agentId, receipt: run, lane }); done.runs += 1; }
    } catch (error) { problems.push(`${pair.file} native runs: ${error?.code ?? 'GATE_RUN_UNRECORDED'}`); }
  }
  store.appendFact(board, item, { agentId: submit.agentId, kind: 'note', text: `Gate job ${job} paired its red: ${done.observations} flake observation(s), ${done.runs} native run(s) recorded; the red stands; see pullboard flakes.${problems.length ? `\nNot recorded: ${problems.join('; ')}` : ''}`.slice(0, 2000) });
  return done;
}
