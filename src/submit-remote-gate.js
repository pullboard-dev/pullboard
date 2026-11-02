/** A queued submit's whole analysis runs as one trusted runner job: main's committed archive, candidate as data [V4,C7]. */
import { shellWord } from './runner-remote-tooling.js';
import { effectiveRunners } from './runner-slots.js';
import { loadMachineSettings } from '../packages/config/index.js';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { statSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withItemPatchSubmit } from '../packages/items/index.js';
import { git } from './git.js';
import { gitPath } from './git.js';
import { Refused } from '../packages/kernel/index.js';
import { privateCheckEnvelope } from './runner-private-mode.js';
import { trunkRef } from '../packages/sandbox/index.js';

const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const RESULT = 'PULLBOARD_TRUSTED_RESULT ';

/**
 * Archive accepted main from the runner checkout's own Git objects, then run one entry from that archive.
 * Why: the runner's checkout is the candidate; its files are data the trusted entry reads, never code it loads.
 */
const BOOTSTRAP = `import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const request = JSON.parse(Buffer.from(ENCODED, 'base64').toString('utf8'));
const root = process.cwd();
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: root, env, maxBuffer: 256 * 1024 ** 2, ...options });
  if (result.error || result.status !== 0) throw new Error('trusted main archive failed: ' + command + ' ' + String(result.stderr ?? '').slice(0, 2000));
  return result.stdout;
};
const git = (...args) => run('git', ['--no-replace-objects', ...args]);
const objects = git('rev-parse', '--path-format=absolute', '--git-path', 'objects').toString().trim();
if (!objects || /[\\r\\n]/u.test(objects)) throw new Error('invalid object directory');
const directory = mkdtempSync(join(tmpdir(), 'pullboard-trusted-main-'));
let status = 1;
try {
  const metadata = join(directory, '.objects');
  git('init', '--quiet', '--bare', metadata);
  writeFileSync(join(metadata, 'objects/info/alternates'), objects + '\\n', { flag: 'wx' });
  mkdirSync(join(metadata, 'info'), { recursive: true });
  writeFileSync(join(metadata, 'info/attributes'), '* -text -filter -ident -export-subst -export-ignore\\n', { flag: 'wx' });
  const archive = git('--git-dir', metadata, '-c', 'core.autocrlf=false', '-c', 'core.attributesFile=/dev/null', 'archive', '--format=tar', request.main);
  run('tar', ['-xf', '-', '-C', directory], { input: archive });
  const entry = join(directory, 'pullboard-trusted-entry.mjs');
  writeFileSync(entry, request.entry, { flag: 'wx', mode: 0o600 });
  const child = spawnSync(process.execPath, [entry, root], { cwd: root, env, input: JSON.stringify(request.data), stdio: ['pipe', 'inherit', 'inherit'] });
  status = child.status ?? 1;
} finally { rmSync(directory, { recursive: true, force: true }); }
process.exitCode = status;
`;

/**
 * The analysis entry, written into main's archive: every step imports main's modules, the candidate is the checked tree.
 * Why namespace imports: an accepted main that predates an optional export still links, and the step says what it lacks.
 */
const ANALYSIS_ENTRY = `import * as items from './packages/items/index.js';
import * as gate from './packages/gate/index.js';
import * as landing from './packages/landing/index.js';
import * as cells from './bin/cells-submit-checks.js';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isAbsolute } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const tools = dirname(fileURLToPath(import.meta.url));
const root = process.argv[2];
const input = JSON.parse(readFileSync(0, 'utf8'));
const result = { main: input.main, source: input.source, steps: {}, notes: [] };
const step = async (name, work) => {
  const started = performance.now();
  try { return await work(); } finally { result.steps[name] = Math.round(performance.now() - started); }
};
const refuse = (code, message) => Object.assign(new Error(message), { name: 'Refused', code });
const trusted = command => command.split(/(\\s+)/u).map(word => /^[\\w./-]+\\.[cm]?js$/u.test(word) && !isAbsolute(word)
  && existsSync(join(tools, word)) ? JSON.stringify(join(tools, word)) : word).join('');
try {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout?.trim();
  if (head !== input.source) throw refuse('RUNNER_SOURCE', 'the runner checkout is not the queued candidate; resubmit the captured source');
  for (const name of ['requirePlannedSource', 'requireSubmitComposition']) if (typeof items[name] !== 'function') throw refuse('RUNNER_TOOLING_FILES', 'accepted main lacks ' + name);
  if (typeof cells.requireSubmitCells !== 'function' || typeof gate.submitGatePlan !== 'function') throw refuse('RUNNER_TOOLING_FILES', 'accepted main lacks the submit cells or selection tooling');
  await step('placement', () => items.requirePlannedSource(root, input.trunk, input.source));
  if (input.staticChecks) await step('static', () => {
    const run = spawnSync('/bin/sh', ['-c', trusted(input.staticChecks)], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 ** 2 });
    const output = String(run.stdout ?? '') + String(run.stderr ?? '');
    if (run.error || run.status !== 0) throw refuse('GATE_RED', 'static checks are red; fix the named source before running proof:\\n' + (output.slice(-4000) || run.error?.message || 'static checker failed'));
  });
  if (input.composition) await step('composition', () => items.requireSubmitComposition(root, input.composition, { commit: input.main }, input.main));
  result.cells = await step('cells', () => cells.requireSubmitCells(root, input.main, input.source, { item_frozen: JSON.stringify({ criterion: input.criterion }) }, {
    withMainCheckout: landing.withMainCheckout, parsers: { importsIn: gate.importsIn, commonJsIn: gate.commonJsIn },
    withImportParseCache: gate.withImportParseCache, cacheEligible: () => !gate.foreignNodeOptions(process.env.NODE_OPTIONS),
    readCutItems: () => input.cutRows,
    onInventory: mode => result.notes.push('submit cells inventory: ' + mode),
    onAllCells: file => result.notes.push('submit cells: checking all cells because shared policy or root-tool file changed: ' + file) }));
  result.plan = await step('selection', () => gate.submitGatePlan(root, input.config, { base: input.base, trunk: input.main, check: input.check, commit: input.source }));
  if (typeof gate.submitGateAdmission === 'function') result.admission = await step('admission', () => gate.submitGateAdmission(root, result.plan,
    { allowBrowserFreeChecks: input.browserFreeChecks, onBrowserFallback: decision => result.notes.push('browser admission: ' + decision.file + ': ' + decision.reason) }));
} catch (error) {
  if (error?.name !== 'Refused') throw error;
  result.refused = { code: error.code, message: String(error.message).replace(/^\\[\\w+\\] /u, ''), ...(error.next ? { next: error.next } : {}) };
}
process.stdout.write(${JSON.stringify(RESULT)} + JSON.stringify(result) + '\\n');
`;

/**
 * Check only the changed files' style on this machine before cells: the cheap lint subset of a foreground submit.
 * The full static stage still runs later; a queued submit's runner analysis runs the full stage instead.
 */
export async function changedStaticChecks(root, companion, main, source, staticChecks) {
  if (!/\bbin\/static-style-checks\.js\b/u.test(staticChecks ?? '')) return;
  await withItemPatchSubmit(root, companion, gateRoot => {
    const changed = git(gateRoot, ['diff', '--name-only', '-z', '--diff-filter=ACMR', main, source]).split('\0').filter(Boolean);
    const checker = fileURLToPath(new URL('../bin/static-style-checks.js', import.meta.url));
    const run = spawnSync(process.execPath, ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning', checker, '--changed-files', ...changed], { cwd: gateRoot, encoding: 'utf8' });
    if (run.error || run.status !== 0) throw new Refused('GATE_RED', `changed-file static checks are red; fix the named source before cells:\n${run.stderr || run.error?.message || 'static checker failed'}`);
  });
}

/** A queued submit sends its analysis to a runner whenever this machine has one registered or allows only runners. */
export function remoteGateWanted(runnerAdmission, settings = loadMachineSettings()) {
  return runnerAdmission?.runnerOnly === true || effectiveRunners(settings).length > 0;
}

/** Build the data-only shell request that runs `entry` from main's archive; nothing in it names a candidate file. */
export function trustedStepCommand({ main, entry, data, node = 'node' }) {
  if (!OID.test(main ?? '') || typeof entry !== 'string' || !entry || typeof node !== 'string' || !node) {
    throw new TypeError('a trusted runner step needs a pinned main, an entry and a node executable');
  }
  const encoded = Buffer.from(JSON.stringify({ main, entry, data })).toString('base64');
  return `${shellWord(node)} --input-type=module -e ${shellWord(`const ENCODED = ${JSON.stringify(encoded)};\n${BOOTSTRAP}`)}`;
}

/**
 * Run one trusted step on the admitted runner and accept only a complete result bound to its source and policy.
 * The private-check receipt hashes the exact request and output; any mismatch refuses rather than trusting bytes.
 */
export async function trustedRunnerStep(root, { main, source, stage, entry, data, timeoutMs = 30 * 60 * 1000 }, lease, artifactDirectory) {
  if (!lease?.runner || typeof lease.executionServices?.runners?.runOnRunnerAsync !== 'function') {
    throw new Refused('RUNNER_SOURCE', `the remote ${stage} step needs its admitted runner; register a runner or submit in the foreground`);
  }
  if (!OID.test(source ?? '') || source.length !== main?.length) throw new TypeError('a trusted runner step needs a pinned candidate');
  const shell = trustedStepCommand({ main, entry, data, node: lease.runner.node ?? 'node' });
  const checkedSource = { commit: source, tree: git(root, ['rev-parse', `${source}^{tree}`]).trim() };
  const policy = privateCheckEnvelope({ kind: 'private-check', version: 1, install: '', check: shell, timeoutMs,
    policyCommit: main, trunk: { ref: trunkRef(root), commit: main } });
  const parent = artifactDirectory ? join(artifactDirectory, stage) : gitPath(root, `pullboard-${stage}-output`);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(parent, 'remote-'));
  const result = await lease.executionServices.runners.runOnRunnerAsync(root, shell, { runner: lease.runner, source: lease.source,
    runnerWaitDeadline: lease.runnerWaitDeadline, browser: lease.browser, checkedSource, privateCheck: policy,
    metadata: { ...lease.runMetadata, testStage: stage }, rawOutputPath: join(directory, 'raw.log') });
  lease.executionAdmission = result.executionAdmission ?? null;
  lease.executionPhases = result.executionPhases ?? null;
  const receipt = result.privateCheck?.receipt;
  const phase = receipt?.phases?.check;
  writeFileSync(join(directory, 'observation.json'), JSON.stringify({ version: 1, stage, policyCommit: main, checkedSource,
    privateCheckSha256: policy.sha256, runner: result.executionRunner ?? null, executionSource: result.executionSource ?? null,
    executionAdmission: result.executionAdmission ?? null, privateCheck: receipt ?? null }) + '\n', { mode: 0o600 });
  if (result.executionRunner !== lease.runner.host || result.executionSource?.commit !== source
    || result.executionSource?.tree !== checkedSource.tree || receipt?.requestSha256 !== policy.sha256
    || receipt.sourceUnchanged !== true || receipt.problem || !phase || phase.offset !== 0
    || phase.code !== 0 || phase.signal || phase.timedOut || !Number.isSafeInteger(phase.length)
    || phase.length < 0 || phase.length > 64 * 1024 * 1024 || statSync(result.rawOutputPath).size !== phase.length) {
    throw new Refused('RUNNER_RESULT_INVALID', `the remote ${stage} step did not return a complete pinned result; read ${directory} and submit again`);
  }
  const bytes = readFileSync(result.rawOutputPath);
  if (bytes.length !== phase.length || createHash('sha256').update(bytes).digest('hex') !== phase.sha256) {
    throw new Refused('RUNNER_RESULT_INVALID', `the remote ${stage} output does not match its authenticated receipt; read ${directory} and submit again`);
  }
  const rows = bytes.toString('utf8').split(/\r?\n/u).filter(line => line.startsWith(RESULT));
  let value = null;
  try { if (rows.length === 1) value = JSON.parse(rows[0].slice(RESULT.length)); } catch { /* refused below */ }
  if (!value || value.main !== main || value.source !== source) {
    throw new Refused('RUNNER_RESULT_INVALID', `the remote ${stage} step returned no result bound to main ${main.slice(0, 12)} and source ${source.slice(0, 12)}; read ${directory}`);
  }
  return { value, directory, sha256: phase.sha256 };
}

/**
 * Run placement, static checks, composition, cells, test selection and browser admission on the runner.
 * The controller supplies only data it already holds (pinned commits, its config, the board's cut rows).
 */
export async function remoteSubmitAnalysis(root, request, lease, artifactDirectory) {
  const { main, source, readCutItems } = request;
  const cutRows = readCutItems();
  const data = { main, source, trunk: request.trunk, base: request.base, check: request.check, criterion: request.criterion,
    composition: request.composition ?? null, staticChecks: request.staticChecks ?? '', config: request.config,
    browserFreeChecks: request.browserFreeChecks === true, cutRows };
  const { value, directory, sha256 } = await trustedRunnerStep(root, { main, source, stage: 'analysis', entry: ANALYSIS_ENTRY, data }, lease, artifactDirectory);
  if (value.refused) throw new Refused(value.refused.code, value.refused.message, value.refused.next);
  if (JSON.stringify(readCutItems()) !== JSON.stringify(cutRows)) {
    throw new Refused('CELLS_SUBMIT', 'the board\'s cut authority changed while the remote analysis ran; submit again from a fresh snapshot');
  }
  if (!value.cells || !value.plan || !Array.isArray(value.plan.proofFiles)) {
    throw new Refused('RUNNER_RESULT_INVALID', `the remote analysis returned no cells result or test plan; read ${directory}`);
  }
  return { ...value, directory, sha256, runner: lease.runner.host };
}
