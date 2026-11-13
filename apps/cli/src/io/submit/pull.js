/**
 * Under gate.runnerDispatch pull, or for an item the gate.pullPilot setting picks, a submit offers its whole gate as one
 * runner job row and returns: authorization, doctrine, static checks, cells, test selection and the tests all run inside
 * that job on a runner, which posts one receipt. The submitting host starts no dispatcher, driver or worker process [P7].
 */
import { gateLedgerHits } from '../../../../../packages/api/index.js';
import { offerJob } from '../../../../../packages/api/index.js';
import { openJob } from '../../../../../packages/api/index.js';
import { pulledGateReds } from '../../../../../packages/api/index.js';
import { pullGateFor } from '../../../../../packages/config/index.js';
import { browserFreeChecksEnabled } from '../../../../../packages/config/index.js';
import { hasSubmitRules } from '../../../../../packages/doctrine/index.js';
import { submitRulesNarrowable } from '../../../../../packages/doctrine/index.js';
import { LEDGER_HITS_ENV } from '../../../../../packages/gate/index.js';
import { PULLED_JOB_ENV } from '../../../../../packages/gate/index.js';
import { submitGateConfig } from '../../../../../packages/gate/index.js';
import { missingGate } from '../../../../../packages/gate/index.js';
import { git } from '../../../../../packages/git/index.js';
import { toolingFor } from '../../../../../packages/pin/index.js';
import { itemCollisionPlan } from '../../../../../packages/items/index.js';
import { changedLines } from '../../../../../packages/items/index.js';
import { oversizeNote } from '../../../../../packages/items/index.js';
import { landedCutItemRows } from '../cells-submit-checks.js';
import { namedProofTests } from '../entry.js';
import { ordered } from '../entry.js';
import { withBoard } from '../entry.js';
import { deliverSubmitActivity } from '../submit.js';
import { ANALYSIS_ENTRY } from './gate.js';
import { BOOTSTRAP } from './gate.js';
import { DOCTRINE_ENTRY } from './gate.js';
import { inventoryCommits } from './remote.js';
import { ensureLocalRunner } from '../runner/local.js';
import { primaryCheckoutRoot } from '../worktree.js';
import { exitLines } from '../../logic/runner/output.js';
import { fitReceipt } from '../../logic/runner/output.js';
import { tapCaseErrors } from '../../logic/runner/output.js';
import { FAILURE_DIAGNOSTICS_SOURCE } from '../../../../../packages/kernel/index.js';

/**
 * The tooling tree that judges this submit (RFC 0007 SC7), for the board to record with the submit it applies, so review
 * reuses the pulled gate's receipts only under the same tooling; an unreadable pin records none and nothing is reused [C7].
 */
function pulledTooling(root, commit) {
  try { return { tooling: toolingFor(root, commit).tooling }; } catch { return {}; }
}

/** The line a gate job prints its receipt on, the last line of its output; runner serve reads the same prefix. */
export const GATE_RECEIPT = 'PULLBOARD_GATE_RECEIPT ';
/** Budget: the most failing cases a red phase names in its receipt, so a receipt stays under the queue's size cap. */
const PHASE_CASES = 100;
/** Budget: a phase's output is held up to 256 MiB in the gate job; a phase that prints more is killed, as the serial spawn did. */
const PHASE_BUFFER_BYTES = 256 * 1024 ** 2;
/** The capabilities a runner needs to take a gate job, or a pulled test job, which runs through the same bootstrap. */
export const GATE_NEEDS = ['node22'];
/** The variable runner serve names its kept-output folder for this job in; the gate entry writes each phase's full output there. */
export const RUNNER_OUTPUT_ENV = 'PULLBOARD_RUNNER_OUTPUT';
/** Budget: a phase's kept output is its last 8 MiB on the runner; the receipt carries its digest and byte count. */
const KEPT_PHASE_BYTES = 8 * 1024 ** 2;
/** Budget: the receipt line stays under runner serve's 60 KiB receipt-line cap and the board's 64 KiB receipt cap. */
const RECEIPT_FIT_BYTES = 56 * 1024;
/** Budget: a receipt's test plan names at most 200 files per list, and each phase command up to 2000 characters. */
const PLAN_ROWS = 200;
const PLAN_COMMAND_CHARS = 2000;
const TEST_FILE = /\.(?:test|spec)\.[cm]?js$/u;

/**
 * The gate job's entry, written into accepted main's archive by the bootstrap: it runs main's analysis entry on the
 * candidate checkout, then, when every part passed, the frozen check and the selected proof, and prints one receipt.
 * Why one process tree: every part of the gate is one runner job on one lease, so the submitting host holds nothing.
 */
const GATE_JOB_ENTRY = `import { spawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { symlinkSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { delimiter } from 'node:path';
import { dirname } from 'node:path';
import { isAbsolute } from 'node:path';
import { join } from 'node:path';
import { normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
const tools = dirname(fileURLToPath(import.meta.url)), root = process.argv[2];
// Runner serve's kept-output folder for this job; the phases run without it, so a test of the runner never writes there.
const keptFolder = process.env.${RUNNER_OUTPUT_ENV} || null;
delete process.env.${RUNNER_OUTPUT_ENV};
/** Keep a phase's full output on the runner by job, bounded to its last bytes; a folder that cannot take it keeps nothing. */
const keepOutput = (name, output) => {
  if (!keptFolder) return null;
  try { writeFileSync(join(keptFolder, name), output.length > ${KEPT_PHASE_BYTES} ? output.subarray(-${KEPT_PHASE_BYTES}) : output, { mode: 0o600 }); return name; } catch { return null; }
};
${tapCaseErrors}
${FAILURE_DIAGNOSTICS_SOURCE}
${exitLines}
${fitReceipt}
// Main's own TAP reader names each failing case, so the board can compare them with main's receipts; without it a red phase stays unaccounted.
let light = null, gate = null;
try { light = await import(pathToFileURL(join(tools, 'packages', 'gate', 'light.js')).href); } catch { /* an older main: red phases carry no cases */ }
// Main's gate door also lifts the run's own timing frame out of the TAP account, as the controller gate does before it reads a red proof.
try { gate = await import(pathToFileURL(join(tools, 'packages', 'gate', 'index.js')).href); } catch { /* an older main: the plain TAP reader alone */ }
// Main's flakes door pairs a red's failing cases, as the controller's diagnostics did; an older main has none and pairs nothing [C7].
let flakes = null;
try { flakes = await import(pathToFileURL(join(tools, 'packages', 'flakes', 'index.js')).href); } catch { /* an older main: a red stays unpaired */ }
/** Main's tree, extracted from this checkout's own objects into a throwaway folder for the pair's main run; null when unreadable. */
const mainTree = main => {
  const archive = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(String(main)) ? spawnSync('git', ['--no-replace-objects', 'archive', '--format=tar', main], { cwd: root, maxBuffer: 1024 ** 3 }) : null;
  if (archive?.status !== 0) return null;
  const folder = mkdtempSync(join(tools, '.pullboard-pair-main-'));
  return spawnSync('tar', ['-xf', '-', '-C', folder], { input: archive.stdout }).status === 0 ? folder : null;
};
const accounting = typeof gate?.accountedFailures === 'function' && typeof gate.timingAccountingStages === 'function' && typeof gate.timingSource === 'function';
/** A red phase's failing cases by file and name, or null when its output does not account for every failure; run: the phase's timing id and source. */
const failingCases = (status, text, run) => {
  let rows = null;
  try {
    rows = status !== 1 ? null : accounting ? gate.accountedFailures({ isGreen: false, stages: gate.timingAccountingStages([{ status, output: text }], run.id, run.source) }, root, { nativeLeaves: true })
      : light?.tapFailures ? light.tapFailures(text, root) : null;
  } catch { rows = null; }
  if (!Array.isArray(rows) || !rows.length || rows.length > ${PHASE_CASES} || rows.some(row => !row?.file || !row.name)) return null;
  // A file Node killed (a timeout) is named by its path in this job's own checkout; the project path names it on any runner.
  return rows.map(({ file, name }) => ({ file, name: (String(name).startsWith(root + '/') ? String(name).slice(root.length + 1) : String(name)).slice(0, 500) }));
};
/**
 * PATH for the check and the proof: main's trusted CLI first as \`pullboard\`, then this Node. Why: an item check calls
 * pullboard by name, as on the controller, where the seat's CLI is on PATH; a runner job's PATH has none, and the check exited 127.
 */
const cliPath = () => {
  const cli = join(tools, 'apps', 'cli', 'pullboard.js'), bin = join(tools, '.pullboard-bin');
  if (!existsSync(cli)) return [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter);
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  // The archive keeps the CLI's mode and its env-node line, which finds this Node next on PATH.
  if (!existsSync(join(bin, 'pullboard'))) symlinkSync(cli, join(bin, 'pullboard'));
  return [bin, dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter);
};
const input = JSON.parse(readFileSync(0, 'utf8'));
// A proof shard the board offered from a gate's plan runs only its part of the proof, with the same trusted runner [P7].
const shard = input.shard && typeof input.shard.command === 'string' ? input.shard : null;
const environment = { node: process.versions.node, platform: process.platform, arch: process.arch };
const receipt = shard ? { version: 1, kind: 'shard', main: input.main, source: input.source, shard: { index: shard.index, of: shard.of, files: shard.files }, steps: {}, phases: [], environment }
  : { version: 1, main: input.analysis.main, source: input.analysis.source, steps: {}, phases: [], environment };
const timed = (name, work) => { const started = performance.now(); try { return work(); } finally { receipt.steps[name] = Math.round(performance.now() - started); } };
const tail = text => text.length > 4000 ? text.slice(-4000) : text;
/** The run's own TAP or Node reporter totals, the last ones printed; null when it printed none, so a count is never guessed. */
const totals = text => {
  const found = {};
  for (const line of text.split(/\\r?\\n/u)) { const match = /^(?:#|\\u2139)\\s+(pass|fail|skipped)\\s+(\\d+)$/u.exec(line.trim()); if (match) found[match[1]] = Number(match[2]); }
  return 'pass' in found || 'fail' in found ? { passed: found.pass ?? null, failed: found.fail ?? null, skipped: found.skipped ?? null } : null;
};
/** The selected test plan as the inline gate returned it, each list bounded to ${PLAN_ROWS} rows so the receipt keeps its cap. */
const planOf = plan => {
  const rows = list => Array.isArray(list) ? list.slice(0, ${PLAN_ROWS}) : list;
  const tiers = plan.testTiers && typeof plan.testTiers === 'object' ? Object.fromEntries(Object.entries(plan.testTiers).map(([key, value]) => [key, rows(value)])) : null;
  const files = Array.isArray(plan.proofFiles) ? plan.proofFiles : [];
  return { files: rows(files), ...(files.length > ${PLAN_ROWS} ? { filesOmitted: files.length - ${PLAN_ROWS} } : {}), testTiers: tiers,
    phasePlan: (Array.isArray(plan.phases) ? plan.phases : []).map(phase => ({ role: String(phase.role), command: String(phase.command ?? '').slice(0, ${PLAN_COMMAND_CHARS}) })) };
};
/**
 * What the plan decided about deferral, in the fields the inline gate returned: full, deferred, deferredFiles and the report.
 * Why: the board records the submission's deferral from the receipt, as the controller records it from its own gate [C7].
 */
const deferralOf = (plan, config) => {
  const files = plan.deferSelection && Array.isArray(plan.selection?.files) ? plan.selection.files : null;
  const proof = Array.isArray(plan.proofFiles) ? plan.proofFiles : [];
  const invariants = plan.deferred && Array.isArray(plan.invariants) && plan.invariants.length ? 'submit invariants: ' + plan.invariants.join(', ') + '; ' : '';
  const note = files ? (typeof gate?.deferredSelectionNote === 'function' ? gate.deferredSelectionNote(files) : files.length + ' affected test files deferred to the landing gate') : '';
  const report = files ? invariants + note + ' (over submitDeferAbove ' + config?.submitDeferAbove + '): ' + files.join(', ')
    : plan.deferFullFallback ? invariants + 'full suite deferred to the landing gate'
    : plan.selection?.full ? 'full gate' : 'affected tests: ' + (proof.join(', ') || 'none');
  return { full: plan.selection?.full === true, deferred: plan.deferred === true, ...(files ? { deferredFiles: files, deferAbove: config?.submitDeferAbove ?? null } : {}), ...(plan.deferred ? { deferNote: note || 'full suite deferred to the landing gate' } : {}),
    ...(plan.deferFullFallback ? { deferFullFallback: true } : {}), report };
};
/** The checkout-relative script a proof command runs first (\`node <script>.js …\`), or null when it names none. */
const proofScript = command => { const found = /^\\s*\\S+\\s+([\\w./-]+\\.[cm]?js)(?=\\s|$)/u.exec(command); return found && !isAbsolute(found[1]) ? normalize(found[1]) : null; };
/** The modules a script imports by name, sorted: its static and dynamic import specifiers; null when the file is missing. */
const importsOf = file => {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  return [...new Set([...text.matchAll(/(?:\\bfrom\\s*|\\bimport\\s*\\(\\s*|\\bimport\\s+)(['"])([^'"\\n]+)\\1/gu)].map(found => found[2]))].sort();
};
/**
 * The proof runner, when the candidate changed what it imports against accepted main, else null. Why: the proof runs
 * as written inside the checkout, as on the controller; a runner that loads other modules than main's is refused.
 */
const changedRunner = command => {
  const script = proofScript(command), trusted = script ? importsOf(join(tools, script)) : null;
  return trusted && JSON.stringify(importsOf(join(root, script))) !== JSON.stringify(trusted) ? script : null;
};
/** Run one phase as written, inside the candidate checkout, as the controller does; the files and the frozen check are the candidate's own. */
// The board's ledger hits for this job's files: written once, named to the proof phase only, never to the item's own check.
const ledger = (shard ? shard.ledger : input.ledger) ?? null;
let hitsFile = null;
if (ledger && Array.isArray(ledger.files)) { hitsFile = join(tools, 'pullboard-ledger-hits.json'); writeFileSync(hitsFile, JSON.stringify(ledger), { mode: 0o600 }); }
/**
 * The reason a green proof does not prove its selected files: main's own account check, as the controller gate applies it
 * (TEST_SELECTION_UNVERIFIED), read from the phase's outcome frames or its TAP cases; null when every file reported.
 * Why: a runner that ran none of the selected units exits 0 with an empty account, which is no proof [C7].
 */
const unaccounted = (files, outcomes, text) => {
  if (typeof gate?.requireTestTierAccount !== 'function') return null;
  try { gate.requireTestTierAccount({ green: true, testOutcomes: outcomes, profile: { tests: typeof gate.tapTests === 'function' ? gate.tapTests(text, root) : [] } }, files); return null; }
  catch (error) { return String(error?.message ?? error).replace(/^\\[\\w+\\] /u, ''); }
};
/** Run one phase; \`selected\` names the files a green proof must account for, when the plan has test tiers. */
const runPhase = async (role, command, PATH, selected = null) => {
  // As on the controller: one timing id per run, the source it ran on, and stderr in line with stdout, so TAP's summary ends the account.
  // This runner is the job's whole execution host, so the run spreads its files over every core [P7,#5790].
  const run = { id: randomUUID(), source: accounting ? gate.timingSource(root) : null };
  const started = performance.now();
  const ran = await new Promise(resolve => {
    const child = spawn('(' + command + '\\n) 2>&1', { shell: true, cwd: root,
      env: { ...process.env, PATH, [gate?.TIMING_RUN_ID_ENV ?? 'PULLBOARD_TIMING_RUN_ID']: run.id, ${JSON.stringify(PULLED_JOB_ENV)}: '1', ...(role === 'proof' && hitsFile ? { ${LEDGER_HITS_ENV}: hitsFile } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [], err = [];
    let held = 0;
    const keep = into => chunk => { held += chunk.length; if (held > ${PHASE_BUFFER_BYTES}) child.kill('SIGKILL'); else into.push(chunk); };
    child.stdout.on('data', keep(out)); child.stderr.on('data', keep(err));
    child.on('error', () => resolve({ status: null, signal: null, stdout: Buffer.concat(out), stderr: Buffer.concat(err) }));
    child.on('close', (status, signal) => resolve({ status, signal, stdout: Buffer.concat(out), stderr: Buffer.concat(err) }));
  });
  receipt.steps[role] = Math.round(performance.now() - started);
  const output = Buffer.concat([ran.stdout ?? Buffer.alloc(0), ran.stderr ?? Buffer.alloc(0)]);
  const text = output.toString('utf8'), kept = keepOutput(role + '.log', output);
  const failures = ran.status !== 0 ? failingCases(ran.status, text, run) : null;
  // Each named case's diagnostic signature, as the controller signs it, so the board tells two failures of one case apart [V4,B3].
  let failureSignatures = null;
  try { failureSignatures = failures ? caseSignatures(failures, tapFailureDiagnostics(text, root, value => createHash('sha256').update(value).digest('hex'))) : null; } catch { failureSignatures = null; }
  // Each file that ran under a key becomes a proof-ledger row on the board, green files of a red phase included [P7].
  let ledger = null;
  try { ledger = typeof gate?.phaseLedger === 'function' ? gate.phaseLedger(text, { status: ran.status, failures, root }) : null; } catch { ledger = null; }
  // The phase's per-case outcomes ride to the board whole or not at all, so the review packet can map a clause to a run;
  // a plain single-file check prints TAP only, so its cases are read from that TAP as the in-process gate did [V4,C7].
  let outcomes = null, blocked = null;
  try { blocked = ran.status !== 0 && typeof gate?.sandboxBlockedOperation === 'function' ? gate.sandboxBlockedOperation(root, text) : null; outcomes = typeof gate?.readTestOutcomes === 'function' ? gate.readTestOutcomes(text, run.id) : null; outcomes ??= typeof gate?.singleFileTapOutcomes === 'function' ? gate.singleFileTapOutcomes(command, text) : null; } catch { outcomes = null; }
  // Every failing case is kept whole on the runner, so a receipt fitted to its cap still leads to each one [#5828].
  const errors = ran.status !== 0 ? tapCaseErrors(text, root, { errorBytes: 4000 }) : [];
  const unreported = ran.status === 0 && selected?.length ? unaccounted(selected, outcomes, text) : null;
  const errorsKept = errors.length ? keepOutput(role + '.errors.json', Buffer.from(JSON.stringify(errors))) : null;
  for (const row of errors) if (row.error.length > 600) row.error = row.error.slice(0, 600) + '…';
  // A red phase names each failing case with its error, and the lines that explain its exit, whether or not its TAP accounts for every failure.
  const counts = totals(text);
  return { role, status: ran.status, signal: ran.signal, sha256: createHash('sha256').update(output).digest('hex'), bytes: output.length, tail: tail(text), ...(counts ? { counts } : {}),
    ...(kept ? { kept } : {}), ...(ran.status !== 0 ? { failures, ...(failureSignatures ? { failureSignatures } : {}), errors, errorCount: errors.length, ...(errorsKept ? { errorsKept } : {}), exit: exitLines(text) } : {}), ...(ledger ? { ledger } : {}), ...(outcomes ? { testOutcomes: outcomes } : {}), ...(blocked ? { sandboxBlocked: blocked } : {}), ...(unreported ? { unreported } : {}) };
};
if (shard) receipt.phases.push(await runPhase('proof', shard.command, cliPath(), shard.account ? shard.files : null));
else {
const entry = join(tools, 'pullboard-trusted-analysis.mjs');
writeFileSync(entry, input.analysisEntry, { flag: 'wx', mode: 0o600 });
const analysed = timed('analysis', () => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', entry, root], { cwd: root, input: JSON.stringify(input.analysis), maxBuffer: 256 * 1024 ** 2, stdio: ['pipe', 'pipe', 'pipe'] }));
const line = String(analysed.stdout ?? '').split('\\n').find(row => row.startsWith('PULLBOARD_TRUSTED_RESULT '));
let analysis = null;
try { analysis = JSON.parse(line.slice(line.indexOf(' ') + 1)); } catch { /* reported below */ }
if (!analysis) {
  const said = String(analysed.stderr ?? '') + String(analysed.stdout ?? ''), kept = keepOutput('analysis.log', Buffer.from(said));
  receipt.error = 'the analysis returned no result: ' + tail(said);
  if (kept) receipt.kept = kept;
}
else {
  const refusals = Object.entries(analysis.outcomes ?? {}).filter(([, outcome]) => outcome?.refused).map(([part, outcome]) => ({ part, ...outcome.refused }));
  if (analysis.refused) refusals.push({ part: 'analysis', ...analysis.refused });
  // A lane-ownership finding is data, not a refusal: the proof still runs, and the board routes green proof to the owners [B3,L1,P7].
  const ownership = analysis.authorization?.ownership;
  receipt.analysis = { steps: analysis.steps ?? {}, refusals, infra: analysis.infra ?? analysis.refusal ?? null, notes: (analysis.notes ?? []).slice(0, 20),
    ...(ownership ? { ownership: { code: 'OUTSIDE_LANE', message: String(ownership.message ?? '').slice(0, 2000), paths: (ownership.paths ?? []).slice(0, 200) } } : {}),
    authorization: analysis.authorization ? { skipped: analysis.authorization.skipped ?? null, paths: (analysis.authorization.paths ?? []).length, mechanical: analysis.authorization.mechanical ?? [] } : null,
    doctrine: Array.isArray(analysis.doctrine) ? analysis.doctrine.length : null, cells: Boolean(analysis.cells),
    // The cells machinery's diagnostics ride to the board, which records them in the repository's refusal-trial ledger [C7].
    machinery: (analysis.cells?.machinery ?? []).slice(0, 20).map(row => ({ kind: row.kind, code: row.code, message: String(row.message ?? '').slice(0, 2000), rule: row.rule })), proofFiles: analysis.plan?.proofFiles ?? null, proofCommand: analysis.plan?.proofCommand ?? null, admission: analysis.admission ?? null };
  if (analysis.plan && typeof analysis.plan === 'object') { receipt.plan = planOf(analysis.plan); Object.assign(receipt, deferralOf(analysis.plan, input.analysis.config)); }
  // A candidate that changed what the proof runner imports cannot run its proof as written [P7].
  const runnerEdit = !refusals.length && analysis.plan?.proofCommand ? changedRunner(analysis.plan.proofCommand) : null;
  if (runnerEdit) refusals.push({ part: 'proof', code: 'PROOF_RUNNER_CHANGED', paths: [runnerEdit],
    message: 'the candidate changed the imports of the proof runner ' + runnerEdit + ' against accepted main; next: land the runner change as its own item, then resubmit' });
  if (!refusals.length && !receipt.analysis.infra) {
    const PATH = cliPath();
    // A named-file proof over more files than this runner has cores is left to the board, which offers it as shard jobs any runner pulls [P7].
    const plan = analysis.plan ?? {}, cores = availableParallelism();
    // Test tiers make the controller demand an account for every selected file; the pulled proof demands the same [C7].
    const selected = plan.testTiers && Array.isArray(plan.proofFiles) ? plan.proofFiles : null;
    const shardable = input.shards === true && !receipt.analysis.ownership && !plan.selection?.full && typeof plan.testRunner === 'string' && plan.testRunner.trim() && Array.isArray(plan.proofFiles) && plan.proofFiles.length > cores;
    // The check and the proof are independent commands: they start together and their phases keep the check-then-proof order [C7].
    // A shardable proof waits for the check, since the board takes it as shard jobs only when the check passed.
    if (shardable) {
      if (input.check) receipt.phases.push(await runPhase('check', input.check, PATH));
      if (plan.proofCommand && receipt.phases.every(phase => phase.status === 0)) receipt.proofPlan = { runner: plan.testRunner.trim(), files: plan.proofFiles, cores, ...(selected ? { account: true } : {}) };
      else if (plan.proofCommand) receipt.phases.push(await runPhase('proof', plan.proofCommand, PATH, selected));
    } else receipt.phases.push(...await Promise.all([['check', input.check], ['proof', plan.proofCommand]].filter(([, command]) => command).map(([role, command]) => runPhase(role, command, PATH, role === 'proof' ? selected : null))));
    // A green proof that left a selected file unreported is red, as the controller gate refuses it [C7].
    for (const phase of receipt.phases) if (phase.unreported) refusals.push({ part: phase.role, code: 'TEST_SELECTION_UNVERIFIED', message: phase.unreported });
  }
}
}
// A gate whose proof waits on its shards is not green yet: a board that cannot shard reads it as red, never as a passed proof.
if (shard && receipt.phases[0]?.unreported) receipt.error = 'TEST_SELECTION_UNVERIFIED: ' + receipt.phases[0].unreported;
receipt.green = shard ? receipt.phases.length === 1 && receipt.phases[0].status === 0 && !receipt.phases[0].unreported
  : Boolean(receipt.analysis) && !receipt.analysis.refusals.length && !receipt.analysis.ownership && !receipt.analysis.infra && !receipt.proofPlan && receipt.phases.every(phase => phase.status === 0);
// A red's named cases get one paired rerun at the candidate and one run at main when the board's flakes.rerun is on; the red stands [C7,H16].
if (!shard && !receipt.green && !receipt.proofPlan && input.flakes?.rerun === true && typeof flakes?.pairReds === 'function') {
  try {
    const pairs = await flakes.pairReds({ root, phases: receipt.phases, flakes: input.flakes, mainRoot: () => mainTree(input.analysis.main), readOutcomes: gate?.readTestOutcomes, timingEnv: gate?.TIMING_RUN_ID_ENV,
      env: { ...process.env, PATH: cliPath(), ${JSON.stringify(PULLED_JOB_ENV)}: '1' } });
    if (pairs) receipt.pairs = pairs;
  } catch { /* a pair that cannot run leaves the red unclassified, never changed */ }
}
// Ledger rows give way first when the receipt nears its cap; each phase counts what it left out. Then the rest is fitted.
for (let phase; Buffer.byteLength(JSON.stringify(receipt)) > ${RECEIPT_FIT_BYTES} && (phase = receipt.phases.findLast(row => row.ledger?.files.length));) {
  const drop = Math.ceil(phase.ledger.files.length / 4);
  phase.ledger.files.splice(-drop);
  phase.ledger.omitted += drop;
}
fitReceipt(receipt, ${RECEIPT_FIT_BYTES});
// A plan that still overflows gives up its tiers, then its file rows, which it counts; the run itself is never cut for it.
if (receipt.plan && Buffer.byteLength(JSON.stringify(receipt)) > ${RECEIPT_FIT_BYTES}) receipt.plan.testTiers = null;
while (receipt.plan?.files.length && Buffer.byteLength(JSON.stringify(receipt)) > ${RECEIPT_FIT_BYTES}) {
  const drop = Math.ceil(receipt.plan.files.length / 4);
  receipt.plan.files.splice(-drop);
  receipt.plan.filesOmitted = (receipt.plan.filesOmitted ?? 0) + drop;
}
process.stdout.write(${JSON.stringify(GATE_RECEIPT)} + JSON.stringify(receipt) + '\\n');
process.exitCode = receipt.green ? 0 : 1;
`;

/**
 * The item's pulled gates that came back red on a failing test phase, read through the board API.
 * Why here: the submit command loads this module only when it needs it, and its red-loop stop counts these reds [C7].
 * @param {{ db: import('node:sqlite').DatabaseSync }} board
 * @param {number} id
 */
export function itemPulledReds(board, id) {
  return pulledGateReds(board, id);
}

/**
 * True when this item's submit offers its gate as a row instead of driving it: under gate.runnerDispatch pull, or when
 * the gate.pullPilot setting names the item or takes it in its share; everything else stays on the controller path [P7].
 * @param {number} item
 */
export function pullGateWanted(item) {
  return pullGateFor(item);
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
  return { run: gateJobRun(), input: { main, entry: GATE_JOB_ENTRY, data: { analysis, analysisEntry: ANALYSIS_ENTRY, check, shards: true } }, commits };
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
    ?? offerJob(db, { id: `gate:${item}:${source.slice(0, 12)}:${now.toString(36)}`, kind: 'gate', priority: 'gate', needs: GATE_NEEDS, item, candidate: source, base: main, request, now });
}

/**
 * What a red gate job pairs when accepted main turns flakes.rerun on: the structured runner prefix of each phase's
 * command, the frozen check's and the proof's, so the job reruns only exact failing cases; null when reruns are off.
 * Why from main: the controller's diagnostics read the same accepted policy, so a candidate cannot turn pairing off [C7,H16].
 *
 * @param {string} root
 * @param {{ main: { commit: string, config: object }, config: object, source: string, check: string | null }} pinned
 * @param {(root: string, command: string | null, config: object, pin: { head: string, main: string }) => string | null} pairPrefix - The flakes cell's runner-prefix reader.
 * @returns {{ rerun: true, prefixes: { check: string | null, proof: string | null } } | null}
 */
export function pairRequest(root, { main, config, source, check }, pairPrefix) {
  if (main.config.flakes?.rerun !== true) return null;
  const pin = { head: source, main: main.commit };
  const proof = typeof config.affectedTests === 'string' && config.affectedTests.trim() ? config.affectedTests : config.gate;
  return { rerun: true, prefixes: { check: pairPrefix(root, check, config, pin), proof: pairPrefix(root, proof, config, pin) } };
}

/**
 * Write the submit's gate job row and return at once. The candidate is pinned under refs/pullboard/gate so a runner can
 * fetch it from the trunk remote; everything else this does is reads and one board write. A companion submit's gate
 * judges its composed source, and its submit record carries the composition, so the board binds the receipts to it [P7].
 *
 * @param {object} ctx
 * @param {{ held: object, me: { id: string }, commit: string, trunk: { commit: string }, main: { commit: string, config: object },
 *   claimHead: string | null, files: string[], requireComposition: boolean, authorize: boolean, full: boolean,
 *   companion?: { version: number, source: string, sourceTree: string, commit: string, tree: string, digest: string } | null, infra?: object | null }} submission - files: what the
 *   item's commits changed since its claim, which the board records when the receipt submits the item. companion: the
 *   attached companions composed onto the builder head, or null. infra: the drafted infra note the receipt records with the submit.
 * @param {{ frozenCheck: Function, policyAt: Function, listItems: Function, pairPrefix?: Function }} ports - The sandbox and store reads the submit command
 *   already holds; pairPrefix names a paired rerun's runner when flakes.rerun is on.
 * @returns {Promise<number>} The exit code.
 */
export async function offerSubmitGate(ctx, { held, me, commit, trunk, main, claimHead, files, requireComposition, authorize, full, companion = null, infra = null }, { frozenCheck, policyAt, listItems, pairPrefix }) {
  const { root } = ctx.info;
  const id = held.item_id;
  // The gate judges what would land: the builder head, or the companions composed onto it.
  const source = companion?.commit ?? commit;
  const configured = submitGateConfig(full || companion ? policyAt(root, source).config : ctx.config, main.config);
  const config = full ? { ...configured, affectedTests: '', submitGate: 'full' } : configured;
  // A repo with no gate command is refused before any job row is written, as the controller path refuses it (NO_GATE).
  if (!config.gate?.trim()) throw missingGate(root);
  const crossRun = withBoard(ctx, board => {
    board.gitRoot = root;
    return itemCollisionPlan(board, held, listItems(board, { all: true }));
  });
  for (const warning of crossRun.warnings) ctx.io.say(warning);
  const doctrine = hasSubmitRules(root, main.commit, main.config.practice) ? { mainCommit: main.commit, commit, practice: main.config.practice,
    timeoutMs: main.config.check?.timeoutMs, ...(submitRulesNarrowable(root, main.commit, main.config.practice) ? { fast: true } : {}) } : null;
  const request = gateJobRequest({ main: main.commit, source, trunk: trunk.commit, base: claimHead, check: frozenCheck(held),
    criterion: JSON.parse(held.item_frozen ?? 'null')?.criterion ?? '', title: held.item_title ?? '', composition: requireComposition ? commit : null,
    config, crossRunTests: namedProofTests(root, held, source, { crossRunTests: crossRun.tests }), cutRows: withBoard(ctx, board => landedCutItemRows(board.db)),
    produceInventory: inventoryCommits(root, main.commit, source), doctrine, browserFreeChecks: browserFreeChecksEnabled(),
    authorization: authorize === true ? { item: { item_id: held.item_id, item_lane: held.item_lane, item_claim_head: held.item_claim_head, item_frozen: held.item_frozen } } : authorize || null });
  const pairing = typeof pairPrefix === 'function' ? pairRequest(root, { main, config, source, check: frozenCheck(held) }, pairPrefix) : null;
  if (pairing) request.input.data.flakes = pairing;
  // The board applies the receipt as this seat's submit at this bar, tree and change list; a later claim or bar makes it stale [P7].
  // The claim base rides along, so the board never excuses a red at a later main that the item's own base passed [V4,B3].
  // root: the builder checkout the board seals an owner wait from when the runner finds only lane ownership [B3,L1].
  request.submit = { agentId: me.id, digest: held.item_frozen_digest ?? null, tree: git(root, ['rev-parse', `${commit}^{tree}`]).trim(), files, root, ...(claimHead ? { claimBase: claimHead } : {}),
    ...(companion ? { companion } : {}), ...(infra ? { infra } : {}), ...pulledTooling(root, commit) };
  // The board's proof ledger rides along for the files this gate is known to prove, so a runner with an empty store reuses them [P7,CD2].
  withBoard(ctx, board => gateLedgerHits(board.db, request, [...request.input.data.analysis.crossRunTests ?? [], ...files.filter(file => TEST_FILE.test(file))]));
  git(root, ['update-ref', `refs/pullboard/gate/${id}`, source]);
  // The same pin the controller path writes, so doctor and review find the work whatever the gate's outcome (#7076).
  git(root, ['update-ref', `refs/pullboard/items/${id}/${commit.slice(0, 12)}`, commit]);
  const job = withBoard(ctx, board => offerGateJob(board.db, { item: id, main: main.commit, source, request }));
  await withBoard(ctx, board => ordered(ctx, board, 'appendFact', [id, { agentId: me.id, kind: 'note',
    text: `Gate job ${job.id} offered for ${source.slice(0, 12)}${companion ? ` (companions composed onto ${commit.slice(0, 12)})` : ''} on main ${main.commit.slice(0, 12)}; a runner pulls it and posts its receipt.` }]));
  // With no registered runners this machine is its own runner: the same pull path, on loopback [P7].
  const host = primaryCheckoutRoot(ctx.info);
  const local = host ? await ensureLocalRunner(host) : { running: false, started: false, pid: null };
  // id and pin keep the fields the inline submit document carried, so a script reading .id still reads the item (#6832).
  const acknowledgment = { id, item: id, commit, pin: `refs/pullboard/items/${id}/${commit.slice(0, 12)}`, ...(companion ? { composed: source } : {}), gateJob: job.id, queued: true, localRunner: local.running ? { pid: local.pid, started: local.started } : null };
  if (ctx.json) ctx.io.result(acknowledgment);
  // The controller path delivers the activity digest after a submit; the pulled one does as the job is queued (#7076).
  else await deliverSubmitActivity(ctx, id);
  if (!ctx.json) ctx.io.say(`#${id} is in the gate as job ${job.id}: a runner pulls the whole gate and posts one receipt; nothing runs here.`
    + (local.started ? ` Started this machine's local runner (pid ${local.pid}) to pull it.` : ''));
  // A large submit still goes through; the note only suggests a chain of smaller items, as the inline path says (#1162).
  const sizeNote = oversizeNote(changedLines(root, main.commit, commit), main.config.itemSizeBudget);
  if (sizeNote && !ctx.json) ctx.io.say(`note: ${sizeNote}`);
  // The submit hands the seat its next work, and tops it up to its N claims, as the controller path did [N2,V4,C7].
  if (ctx.afterSubmission) await ctx.afterSubmission(acknowledgment);
  return 0;
}
