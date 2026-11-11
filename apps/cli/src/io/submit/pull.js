/**
 * Under gate.runnerDispatch pull, a submit offers its whole gate as one runner job row and returns: authorization,
 * doctrine, static checks, cells, test selection and the tests all run inside that job on a runner, which posts one
 * receipt. The submitting host starts no dispatcher, driver or worker process [P7].
 */
import { offerJob } from '../../../../../packages/api/index.js';
import { openJob } from '../../../../../packages/api/index.js';
import { runnerDispatchMode } from '../../../../../packages/config/index.js';
import { browserFreeChecksEnabled } from '../../../../../packages/config/index.js';
import { hasSubmitRules } from '../../../../../packages/doctrine/index.js';
import { submitRulesNarrowable } from '../../../../../packages/doctrine/index.js';
import { submitGateConfig } from '../../../../../packages/gate/index.js';
import { git } from '../../../../../packages/git/index.js';
import { itemCollisionPlan } from '../../../../../packages/items/index.js';
import { landedCutItemRows } from '../cells-submit-checks.js';
import { namedProofTests } from '../entry.js';
import { ordered } from '../entry.js';
import { withBoard } from '../entry.js';
import { ANALYSIS_ENTRY } from './gate.js';
import { BOOTSTRAP } from './gate.js';
import { DOCTRINE_ENTRY } from './gate.js';
import { inventoryCommits } from './remote.js';

/** The line a gate job prints its receipt on, the last line of its output; runner serve reads the same prefix. */
export const GATE_RECEIPT = 'PULLBOARD_GATE_RECEIPT ';
/** Budget: the most failing cases a red phase names in its receipt, so a receipt stays under the queue's size cap. */
const PHASE_CASES = 100;
/** The capabilities a runner needs to take a gate job. */
const GATE_NEEDS = ['node22'];

/**
 * The gate job's entry, written into accepted main's archive by the bootstrap: it runs main's analysis entry on the
 * candidate checkout, then, when every part passed, the frozen check and the selected proof, and prints one receipt.
 * Why one process tree: every part of the gate is one runner job on one lease, so the submitting host holds nothing.
 */
const GATE_JOB_ENTRY = `import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isAbsolute } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
const tools = dirname(fileURLToPath(import.meta.url)), root = process.argv[2];
// Main's own TAP reader names each failing case, so the board can compare them with main's receipts; without it a red phase stays unaccounted.
let light = null;
try { light = await import(pathToFileURL(join(tools, 'packages', 'gate', 'light.js')).href); } catch { /* an older main: red phases carry no cases */ }
/** A red phase's failing cases by file and name, or null when its output does not account for every failure. */
const failingCases = (status, text) => {
  let rows = null;
  try { rows = status === 1 && light?.tapFailures ? light.tapFailures(text, root) : null; } catch { rows = null; }
  if (!Array.isArray(rows) || !rows.length || rows.length > ${PHASE_CASES} || rows.some(row => !row?.file || !row.name)) return null;
  return rows.map(({ file, name }) => ({ file, name: String(name).slice(0, 500) }));
};
const input = JSON.parse(readFileSync(0, 'utf8'));
const receipt = { version: 1, main: input.analysis.main, source: input.analysis.source, steps: {}, phases: [] };
const timed = (name, work) => { const started = performance.now(); try { return work(); } finally { receipt.steps[name] = Math.round(performance.now() - started); } };
const tail = text => text.length > 4000 ? text.slice(-4000) : text;
const entry = join(tools, 'pullboard-trusted-analysis.mjs');
writeFileSync(entry, input.analysisEntry, { flag: 'wx', mode: 0o600 });
const analysed = timed('analysis', () => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', entry, root], { cwd: root, input: JSON.stringify(input.analysis), maxBuffer: 256 * 1024 ** 2, stdio: ['pipe', 'pipe', 'pipe'] }));
const line = String(analysed.stdout ?? '').split('\\n').find(row => row.startsWith('PULLBOARD_TRUSTED_RESULT '));
let analysis = null;
try { analysis = JSON.parse(line.slice(line.indexOf(' ') + 1)); } catch { /* reported below */ }
if (!analysis) receipt.error = 'the analysis returned no result: ' + tail(String(analysed.stderr ?? '') + String(analysed.stdout ?? ''));
else {
  const refusals = Object.entries(analysis.outcomes ?? {}).filter(([, outcome]) => outcome?.refused).map(([part, outcome]) => ({ part, ...outcome.refused }));
  if (analysis.refused) refusals.push({ part: 'analysis', ...analysis.refused });
  const ownership = analysis.authorization?.ownership;
  if (ownership) refusals.push({ part: 'authorization', code: 'OUTSIDE_LANE', message: ownership.message, paths: ownership.paths });
  receipt.analysis = { steps: analysis.steps ?? {}, refusals, infra: analysis.infra ?? analysis.refusal ?? null, notes: (analysis.notes ?? []).slice(0, 20),
    authorization: analysis.authorization ? { skipped: analysis.authorization.skipped ?? null, paths: (analysis.authorization.paths ?? []).length, mechanical: analysis.authorization.mechanical ?? [] } : null,
    doctrine: Array.isArray(analysis.doctrine) ? analysis.doctrine.length : null, cells: Boolean(analysis.cells), proofFiles: analysis.plan?.proofFiles ?? null, admission: analysis.admission ?? null };
  if (!refusals.length && !receipt.analysis.infra) {
    // Only the proof's test runner comes from accepted main; the test files and the frozen check are the candidate's own.
    const runner = command => command.replace(/^(\\s*\\S+\\s+)([\\w./-]+\\.[cm]?js)(?=\\s|$)/u, (all, lead, script) => !isAbsolute(script) && existsSync(join(tools, script)) ? lead + JSON.stringify(join(tools, script)) : all);
    for (const [role, command] of [['check', input.check], ['proof', analysis.plan?.proofCommand]]) {
      if (!command) continue;
      const ran = timed(role, () => spawnSync(role === 'proof' ? runner(command) : command, { shell: true, cwd: root, maxBuffer: 256 * 1024 ** 2, stdio: ['ignore', 'pipe', 'pipe'] }));
      const output = Buffer.concat([ran.stdout ?? Buffer.alloc(0), ran.stderr ?? Buffer.alloc(0)]);
      receipt.phases.push({ role, status: ran.status, signal: ran.signal, sha256: createHash('sha256').update(output).digest('hex'), bytes: output.length, tail: tail(output.toString('utf8')),
        ...(ran.status !== 0 ? { failures: failingCases(ran.status, output.toString('utf8')) } : {}) });
    }
  }
}
receipt.green = Boolean(receipt.analysis) && !receipt.analysis.refusals.length && !receipt.analysis.infra && receipt.phases.every(phase => phase.status === 0);
process.stdout.write(${JSON.stringify(GATE_RECEIPT)} + JSON.stringify(receipt) + '\\n');
process.exitCode = receipt.green ? 0 : 1;
`;

/** True when this machine runs runner jobs by pull, so a submit offers its gate as a row instead of driving it. */
export function pullGateWanted() {
  return runnerDispatchMode() === 'pull';
}

/**
 * The argv a runner executes in the candidate checkout, with the request's input on its stdin. The bootstrap archives
 * accepted main from the checkout's own objects and runs the gate entry from it, so no candidate tooling is loaded.
 *
 * @returns {string[]}
 */
export function gateJobRun() {
  return ['node', '--input-type=module', '-e',
    `import { readFileSync as readInput } from 'node:fs';\nconst ENCODED = readInput(0).toString('base64');\n${BOOTSTRAP}`];
}

/**
 * The gate job's request: the argv to run and the input it reads, bound to the pinned main and candidate.
 *
 * @param {{ main: string, source: string, trunk: string, base: string | null, check: string, criterion: string, title: string,
 *   composition: string | null, config: object, crossRunTests: string[], cutRows: object[], produceInventory: string[],
 *   doctrine: object | null, authorization: object | null, browserFreeChecks: boolean }} pinned
 * @returns {{ run: string[], input: { main: string, entry: string, data: object }, commits: string[] }} commits: what a
 *   runner fetches beside the candidate, since the bootstrap archives main and the analysis reads trunk from the checkout's objects.
 */
export function gateJobRequest(pinned) {
  const { main, source, check, doctrine, authorization, produceInventory, ...rest } = pinned;
  const commits = [...new Set([main, rest.trunk].filter(commit => typeof commit === 'string' && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(commit)))];
  const analysis = { main, source, ...rest, check, inventory: null, ...(produceInventory.length ? { produceInventory } : {}), staticChecks: rest.config?.staticChecks ?? '',
    collectMachinery: true, perPart: true, ...(doctrine ? { doctrine: { options: doctrine, entry: DOCTRINE_ENTRY } } : {}), ...(authorization ? { authorization } : {}) };
  return { run: gateJobRun(), input: { main, entry: GATE_JOB_ENTRY, data: { analysis, analysisEntry: ANALYSIS_ENTRY, check } }, commits };
}

/**
 * Offer one gate job row for a candidate, or return the open one already offered for it: a retried submit never
 * queues a second run of the same source.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ item: number, main: string, source: string, request: object, now?: number }} fields
 */
export function offerGateJob(db, { item, main, source, request, now = Date.now() }) {
  return openJob(db, { kind: 'gate', item, candidate: source })
    ?? offerJob(db, { id: `gate:${item}:${source.slice(0, 12)}:${now.toString(36)}`, kind: 'gate', needs: GATE_NEEDS, item, candidate: source, base: main, request, now });
}

/**
 * Write the submit's gate job row and return at once. The candidate is pinned under refs/pullboard/gate so a runner can
 * fetch it from the trunk remote; everything else this does is reads and one board write.
 *
 * @param {object} ctx
 * @param {{ held: object, me: { id: string }, commit: string, trunk: { commit: string }, main: { commit: string, config: object },
 *   claimHead: string | null, files: string[], requireComposition: boolean, authorize: boolean, full: boolean }} submission - files: what the
 *   item's commits changed since its claim, which the board records when the receipt submits the item.
 * @param {{ frozenCheck: Function, policyAt: Function, listItems: Function }} ports - The sandbox and store reads the submit command already holds.
 * @returns {Promise<number>} The exit code.
 */
export async function offerSubmitGate(ctx, { held, me, commit, trunk, main, claimHead, files, requireComposition, authorize, full }, { frozenCheck, policyAt, listItems }) {
  const { root } = ctx.info;
  const id = held.item_id;
  const configured = submitGateConfig(full ? policyAt(root, commit).config : ctx.config, main.config);
  const config = full ? { ...configured, affectedTests: '', submitGate: 'full' } : configured;
  const crossRun = withBoard(ctx, board => {
    board.gitRoot = root;
    return itemCollisionPlan(board, held, listItems(board, { all: true }));
  });
  for (const warning of crossRun.warnings) ctx.io.say(warning);
  const doctrine = hasSubmitRules(root, main.commit, main.config.practice) ? { mainCommit: main.commit, commit, practice: main.config.practice,
    timeoutMs: main.config.check?.timeoutMs, ...(submitRulesNarrowable(root, main.commit, main.config.practice) ? { fast: true } : {}) } : null;
  const request = gateJobRequest({ main: main.commit, source: commit, trunk: trunk.commit, base: claimHead, check: frozenCheck(held),
    criterion: JSON.parse(held.item_frozen ?? 'null')?.criterion ?? '', title: held.item_title ?? '', composition: requireComposition ? commit : null,
    config, crossRunTests: namedProofTests(root, held, commit, { crossRunTests: crossRun.tests }), cutRows: withBoard(ctx, board => landedCutItemRows(board.db)),
    produceInventory: inventoryCommits(root, main.commit, commit), doctrine, browserFreeChecks: browserFreeChecksEnabled(),
    authorization: authorize ? { item: { item_id: held.item_id, item_lane: held.item_lane, item_claim_head: held.item_claim_head, item_frozen: held.item_frozen } } : null });
  // The board applies the receipt as this seat's submit at this bar, tree and change list; a later claim or bar makes it stale [P7].
  request.submit = { agentId: me.id, digest: held.item_frozen_digest ?? null, tree: git(root, ['rev-parse', `${commit}^{tree}`]).trim(), files };
  git(root, ['update-ref', `refs/pullboard/gate/${id}`, commit]);
  const job = withBoard(ctx, board => offerGateJob(board.db, { item: id, main: main.commit, source: commit, request }));
  await withBoard(ctx, board => ordered(ctx, board, 'appendFact', [id, { agentId: me.id, kind: 'note',
    text: `Gate job ${job.id} offered for ${commit.slice(0, 12)} on main ${main.commit.slice(0, 12)}; a runner pulls it and posts its receipt.` }]));
  if (ctx.json) ctx.io.result({ item: id, commit, gateJob: job.id, queued: true });
  else ctx.io.say(`#${id} queued as gate job ${job.id}: a runner pulls the whole gate and posts one receipt; nothing runs here.`);
  return 0;
}
