import { runnerCellsInventory } from './submit-cells-remote.js';
import { keepRunnerStderr } from './runner-stderr.js';
import { stderrNote } from './submit-cells-remote.js';
import { throwTrustedRefusal } from './submit-cells-remote.js';
/** A queued submit's whole analysis runs as one trusted runner job: main's committed archive, candidate as data [V4,C7]. */
import { effectiveRunners } from '../../../../packages/runners/index.js';
import { shellWord } from '../../../../packages/runners/index.js';
import { loadMachineSettings } from '../../../../packages/config/index.js';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { statSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runnerPhaseFields } from '../../../../packages/gate/index.js';
import { git } from '../../../../packages/git/index.js';
import { gitPath } from '../../../../packages/git/index.js';
import { Refused } from '../../../../packages/kernel/index.js';
import { privateCheckEnvelope } from '../../../runner/index.js';
import { trunkRef } from '../../../../packages/sandbox/index.js';

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
 * Why namespace imports: an accepted main that predates an optional export still links (the cells inventory transfer included, so this change can bootstrap), and the step says what it lacks.
 */
const ANALYSIS_ENTRY = `import * as items from './packages/items/index.js';
import * as gate from './packages/gate/index.js';
import * as landing from './packages/landing/index.js';
import * as cells from './bin/cells-submit-checks.js';
import * as cellsCache from './bin/cells-inventory-cache.js';
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
const selected = name => !input.parts || input.parts.includes(name);
const outcomes = {};
const refusal = error => ({ code: error.code, message: String(error.message).replace(/^\\[\\w+\\] /u, ''), ...(error.next ? { next: error.next } : {}) });
/** In per-part mode a Refused ends only its own part and is recorded under it; otherwise it ends the whole analysis as before. */
const part = async (name, work) => {
  if (!input.perPart) return work();
  if (outcomes[name]?.refused) return undefined;
  try { return await work(); } catch (error) {
    if (error?.name !== 'Refused') throw error;
    outcomes[name] = { refused: refusal(error) };
    return undefined;
  }
};
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
  if (selected('preflight')) await part('preflight', () => step('placement', () => items.requirePlannedSource(root, input.trunk, input.source, { deferUnplaced: true })));
  if (selected('static') && input.staticChecks) await part('static', () => step('static', () => {
    const run = spawnSync('/bin/sh', ['-c', trusted(input.staticChecks)], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 ** 2 });
    const output = String(run.stdout ?? '') + String(run.stderr ?? '');
    if (run.error || run.status !== 0) throw refuse('GATE_RED', 'static checks are red; fix the named source before running proof:\\n' + (output.slice(-4000) || run.error?.message || 'static checker failed'));
  }));
  if (selected('preflight') && input.composition) await part('preflight', () => step('composition', () => items.requireSubmitComposition(root, input.composition, { commit: input.main }, input.main)));
  let artifacts = input.inventory && typeof cellsCache.transferredCellsInventories === 'function' ? cellsCache.transferredCellsInventories(readFileSync(process.env.PULLBOARD_RUNNER_ANALYSIS_ARTIFACT), input.inventory) : null;
  // The controller holds no inventory for these accepted commits: produce each here, once per runner cache (#2535).
  if (selected('cells') && !artifacts && Array.isArray(input.produceInventory) && input.produceInventory.length) artifacts = await step('inventory', async () => {
    const pending = message => Object.assign(new Error('accepted cells inventory was not produced on the runner: ' + message), { name: 'CellsInventoryInfrastructureError', code: 'CELLS_INVENTORY_PENDING', retryable: true, commit: input.main });
    if (typeof gate.warmAcceptedCells !== 'function' || typeof gate.readAcceptedCells !== 'function') throw pending('accepted main lacks the inventory producer');
    const made = new Map();
    for (const commit of input.produceInventory) {
      let found = gate.readAcceptedCells(root, commit);
      if (!found.available) {
        const { withFileLock } = await import('./packages/outbox/index.js');
        try { await gate.warmAcceptedCells(root, commit, { withCheckout: landing.withMainCheckout, withLock: withFileLock, trunk: input.main }); }
        catch (error) { throw pending(String(error?.message ?? error)); }
        found = gate.readAcceptedCells(root, commit);
        result.notes.push('submit cells inventory: produced on the runner for ' + commit.slice(0, 12));
      }
      if (!found.available) throw pending(commit.slice(0, 12) + ' is unreadable after production (' + found.cause + ')');
      made.set(commit, found);
    }
    return made;
  });
  const artifact = artifacts?.get(input.main);
  if (selected('cells')) result.cells = await part('cells', () => step('cells', () => cells.requireSubmitCells(root, input.main, input.source, { item_frozen: JSON.stringify({ criterion: input.criterion }), item_title: input.title ?? '' }, {
    withMainCheckout: landing.withMainCheckout, acceptedArtifact: artifact, acceptedArtifacts: artifacts, parsers: { importsIn: gate.importsIn, commonJsIn: gate.commonJsIn },
    withImportParseCache: gate.withImportParseCache, cacheEligible: () => !gate.foreignNodeOptions(process.env.NODE_OPTIONS), collectMachinery: input.collectMachinery === true,
    readCutItems: () => input.cutRows,
    onInventory: (mode, cause) => result.notes.push('submit cells inventory: ' + mode + (cause ? ': ' + cause : '')),
    onAllCells: file => result.notes.push('submit cells: checking all cells because shared policy or root-tool file changed: ' + file) })));
  if (selected('selection')) await part('selection', async () => {
    result.plan = await step('selection', () => gate.submitGatePlan(root, input.config, { base: input.base, trunk: input.main, check: input.check, commit: input.source, crossRunTests: input.crossRunTests ?? [] }));
    if (typeof gate.submitGateAdmission === 'function') result.admission = await step('admission', () => gate.submitGateAdmission(root, result.plan,
      { allowBrowserFreeChecks: input.browserFreeChecks, onBrowserFallback: decision => result.notes.push('browser admission: ' + decision.file + ': ' + decision.reason) }));
  });
  if (input.perPart) result.outcomes = outcomes;
} catch (error) {
  if (error?.retryable === true && (error.code === 'GIT_READ_INFRASTRUCTURE' || error.code?.startsWith('CELLS_INVENTORY_'))) result.infra = { code: error.code, message: String(error.message), commit: error.inventoryCommit ?? error.commit ?? null };
  else if (error?.retryable === true && typeof error.code === 'string') result.refusal = { code: error.code, message: String(error.message), retryable: true };
  else if (error?.name !== 'Refused') throw error;
  else result.refused = { code: error.code, message: String(error.message).replace(/^\\[\\w+\\] /u, ''), ...(error.next ? { next: error.next } : {}) };
}
process.stdout.write(${JSON.stringify(RESULT)} + JSON.stringify(result) + '\\n');
`;

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
export async function trustedRunnerStep(root, { main, source, stage, entry, data, analysisArtifact, timeoutMs = 30 * 60 * 1000 }, lease, artifactDirectory) {
  if (!lease?.runner || typeof lease.executionServices?.runners?.runOnRunnerAsync !== 'function') {
    throw new Refused('RUNNER_SOURCE', `the remote ${stage} step needs its admitted runner; register a runner or submit in the foreground`);
  }
  if (!OID.test(source ?? '') || source.length !== main?.length) throw new TypeError('a trusted runner step needs a pinned candidate');
  const shell = trustedStepCommand({ main, entry, data, node: lease.runner.node ?? 'node' });
  const checkedSource = { commit: source, tree: git(root, ['rev-parse', `${source}^{tree}`]).trim() };
  // The analysis reads data.trunk, the trunk the candidate merged; packing only main left the runner without its
  // objects whenever main had moved, and every such gate stopped GIT_READ_INFRASTRUCTURE (#2839).
  const trunkCommit = OID.test(data?.trunk ?? '') && data.trunk.length === main.length ? data.trunk : main;
  const policy = privateCheckEnvelope({ kind: 'private-check', version: 1, install: '', check: shell, timeoutMs,
    policyCommit: main, trunk: { ref: trunkRef(root), commit: trunkCommit } });
  const parent = artifactDirectory ? join(artifactDirectory, stage) : gitPath(root, `pullboard-${stage}-output`);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(parent, 'remote-'));
  const result = await lease.executionServices.runners.runOnRunnerAsync(root, shell, { runner: lease.runner, source: lease.source,
    runnerWaitDeadline: lease.runnerWaitDeadline, browser: lease.browser, checkedSource, privateCheck: policy,
    ...(analysisArtifact ? { analysisArtifact: { file: analysisArtifact.file, bytes: analysisArtifact.bytes.length, sha256: analysisArtifact.digest, context: policy.sha256 } } : {}),
    metadata: { ...lease.runMetadata, testStage: stage }, rawOutputPath: join(directory, 'raw.log'), signal: lease.signal });
  lease.executionAdmission = result.executionAdmission ?? null;
  lease.executionPhases = result.executionPhases ?? null;
  const kept = keepRunnerStderr(directory, result);
  const receipt = result.privateCheck?.receipt;
  const phase = receipt?.phases?.check;
  writeFileSync(join(directory, 'observation.json'), JSON.stringify({ version: 1, stage, policyCommit: main, checkedSource,
    toolingSource: { kind: 'pinned-main', commit: main }, privateCheckSha256: policy.sha256, runner: result.executionRunner ?? null, executionSource: result.executionSource ?? null,
    executionAdmission: result.executionAdmission ?? null, privateCheck: receipt ?? null }) + '\n', { mode: 0o600 });
  if (result.executionRunner !== lease.runner.host || result.executionSource?.commit !== source
    || result.executionSource?.tree !== checkedSource.tree || receipt?.requestSha256 !== policy.sha256
    || receipt.sourceUnchanged !== true || receipt.problem || !phase || phase.offset !== 0
    || phase.code !== 0 || phase.signal || phase.timedOut || !Number.isSafeInteger(phase.length)
    || phase.length < 0 || phase.length > 64 * 1024 * 1024 || statSync(result.rawOutputPath).size !== phase.length) {
    throw new Refused('RUNNER_RESULT_INVALID', `the remote ${stage} step did not return a complete pinned result; read ${directory}${stderrNote(kept)} and submit again`);
  }
  const bytes = readFileSync(result.rawOutputPath);
  if (bytes.length !== phase.length || createHash('sha256').update(bytes).digest('hex') !== phase.sha256) {
    throw new Refused('RUNNER_RESULT_INVALID', `the remote ${stage} output does not match its authenticated receipt; read ${directory} and submit again`);
  }
  const rows = bytes.toString('utf8').split(/\r?\n/u).filter(line => line.startsWith(RESULT));
  let value = null;
  try { if (rows.length === 1) value = JSON.parse(rows[0].slice(RESULT.length)); } catch { /* refused below */ }
  if (!value || value.main !== main || value.source !== source) {
    throw new Refused('RUNNER_RESULT_INVALID', `the remote ${stage} step returned no result bound to main ${main.slice(0, 12)} and source ${source.slice(0, 12)}; read ${directory}${stderrNote(kept)}`);
  }
  return { value, directory, sha256: phase.sha256 };
}

/** How many times the runner analysis repeats when its Git read fails for infrastructure reasons. */
const ANALYSIS_INFRA_ATTEMPTS = 3;

/**
 * Run placement, static checks, composition, cells, test selection and browser admission on the runner.
 * With `perPart`, one job runs all four parts in sequence and returns each part's refusal under `outcomes` instead of throwing the first (#3379).
 * The controller supplies only data it already holds (pinned commits, its config, the board's cut rows).
 */
export async function remoteSubmitAnalysis(root, request, lease, artifactDirectory) {
  const { main, source, readCutItems } = request;
  const perPart = request.perPart === true;
  // A missing accepted inventory is produced on the runner, never on this machine (#2535).
  const { inventory, produce } = !request.parts || request.parts.includes('cells') ? await runnerCellsInventory(root, main, source) : { inventory: null, produce: [] };
  const cutRows = readCutItems();
  const data = { main, source, trunk: request.trunk, base: request.base, check: request.check, criterion: request.criterion, title: request.title ?? '',
    composition: request.composition ?? null, staticChecks: request.staticChecks ?? '', config: request.config,
    inventory: inventory?.descriptor ?? null, ...(produce.length ? { produceInventory: produce } : {}), browserFreeChecks: request.browserFreeChecks === true, crossRunTests: request.crossRunTests ?? [], collectMachinery: request.collectMachinery === true, cutRows, ...(perPart ? { perPart } : {}), ...(request.parts ? { parts: request.parts } : {}) };
  let step;
  /** A Git read failure inside the runner is infrastructure: run the analysis again, and never refuse the builder for it (#2521). */
  for (let attempt = 1; attempt <= ANALYSIS_INFRA_ATTEMPTS; attempt++) {
    step = await trustedRunnerStep(root, { main, source, stage: 'analysis', entry: ANALYSIS_ENTRY, data, analysisArtifact: inventory }, lease, artifactDirectory);
    if (!step.value.infra || step.value.infra.code.startsWith('CELLS_INVENTORY_')) break;
  }
  if (step.value.refusal) throwTrustedRefusal(step.value.refusal);
  if (step.value.infra) throw Object.assign(new Error(step.value.infra.message), { name: step.value.infra.code.startsWith('CELLS_') ? 'CellsInventoryInfrastructureError' : 'GitReadInfrastructureError', code: step.value.infra.code, retryable: true,
    ...(typeof step.value.infra.commit === 'string' ? { commit: step.value.infra.commit } : {}) });
  const { value, directory, sha256 } = step;
  if (value.refused) throw new Refused(value.refused.code, value.refused.message, value.refused.next);
  if (JSON.stringify(readCutItems()) !== JSON.stringify(cutRows)) {
    throw new Refused('CELLS_SUBMIT', 'the board\'s cut authority changed while the remote analysis ran; submit again from a fresh snapshot');
  }
  const parts = request.parts ?? ['preflight', 'static', 'cells', 'selection'];
  const red = name => value.outcomes?.[name]?.refused;
  if (parts.includes('cells') && !red('cells') && !value.cells || parts.includes('selection') && !red('selection') && (!value.plan || !Array.isArray(value.plan.proofFiles))) {
    throw new Refused('RUNNER_RESULT_INVALID', `the remote analysis returned no cells result or test plan; read ${directory}`);
  }
  return { ...value, directory, sha256, runner: lease.runner.host };
}

/**
 * Share one analysis job among the stages that read its parts, so a submit queues one runner job on one lease.
 * Why: each part used to start its own lease and controller, about 11.7 s of start-up apiece (#3379).
 *
 * @param {(signal: AbortSignal) => Promise<object>} startJob Starts the single analysis job (a remoteSubmitAnalysis call with perPart).
 * @returns {(part: string, signal: AbortSignal) => Promise<object>} A part's reader: throws that part's own refusal, else returns the analysis.
 */
export function sharedRemoteAnalysis(startJob) {
  let job = null;
  return async (part, signal) => {
    const analysis = await (job ??= startJob(signal));
    const refused = analysis.outcomes?.[part]?.refused;
    if (refused) throw new Refused(refused.code, refused.message, refused.next);
    return analysis;
  };
}

/**
 * Accept a runner's test plan and browser admission for the controller's gate only when they bind the pinned commits and
 * cover the tests this submit must prove; anything else refuses and never runs a smaller selection (#3006).
 *
 * @param {{main?: string, source?: string, plan?: {proofFiles?: string[]}, admission?: object}} analysis
 * @param {{main: string, source: string, crossRunTests?: string[]}} pinned
 * @returns {{plan: object, admission: object|undefined}}
 */
export function acceptRunnerPlan(analysis, { main, source, crossRunTests = [] }) {
  if (analysis?.main !== main || analysis.source !== source) {
    throw new Refused('RUNNER_RESULT_INVALID', `the runner test plan is not bound to main ${main.slice(0, 12)} and source ${source.slice(0, 12)}; submit again`);
  }
  const files = analysis.plan?.proofFiles;
  if (!Array.isArray(files)) throw new Refused('RUNNER_RESULT_INVALID', 'the runner test plan names no proof files; submit again');
  const missing = crossRunTests.filter(path => !files.includes(path));
  if (missing.length) throw new Refused('RUNNER_RESULT_INVALID', `the runner test plan omits call-adjacent tests ${missing.join(', ')}; submit again`);
  // Why: a missing admission would let runSubmitGate admit browser and GUI files on the Mac, the work this item moves off it.
  const admission = analysis.admission;
  if (typeof admission?.browser !== 'boolean' || typeof admission.gui !== 'boolean') {
    throw new Refused('RUNNER_RESULT_INVALID', 'the runner test plan carries no browser and GUI admission; update the runner tooling and submit again');
  }
  return { plan: analysis.plan, admission };
}

/**
 * Run the controller's gate with the runner's plan in a handoff worker, or with none in a foreground submit so it plans
 * locally as before. A refused runner plan throws before the gate starts, so it records no proof.
 *
 * @param {boolean} remoteMode
 * @param {Promise<object>|null} selection The runner selection stage's analysis.
 * @param {{main: string, source: string, crossRunTests?: string[]}} pinned
 * @param {(runnerPlan: object) => Promise<any>} runGate
 */
export async function gateWithRunnerPlan(remoteMode, selection, pinned, runGate) {
  return runGate(remoteMode ? acceptRunnerPlan(await selection, pinned) : {});
}

/** Pass the runner's accepted selection into the controller's gate entry point without replanning locally. */
export function runSubmitGateWithRunnerPlan(runSubmitGate, root, config, runnerPlan, options) {
  return runSubmitGate(root, config, { ...options, ...runnerPlan });
}

/** Sum sequential worker intervals only when every attempted run has complete measurements. */
export function doctrineExecutionPhases(observations, attempts) {
  const phases = observations.map(row => runnerPhaseFields(row.executionPhases));
  const fields = ['prepareMs', 'capacityWaitMs', 'sourceMs', 'dependenciesMs', 'commandMs', 'cleanupMs', 'totalMs'];
  return attempts && attempts === observations.length && phases.every(Boolean)
    ? runnerPhaseFields({ version: 1, ...Object.fromEntries(fields.map(field => [field, phases.reduce((sum, phase) => sum + phase[field], 0)])) }) : null;
}

/** Bind both doctrine check sources to the actual leased worker, retaining authenticated per-rule observations. */
export function doctrineRunnerChecks(root, mainCommit, lease, artifactDirectory) {
  if (!lease.runner || typeof lease.executionServices?.runners?.runOnRunnerAsync !== 'function') throw new Refused('RUNNER_SOURCE', 'runner-only doctrine needs its actual registered runner lease; restore runner admission and retry');
  const parent = artifactDirectory ? join(artifactDirectory, 'doctrine') : gitPath(root, 'pullboard-doctrine-output');
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const observations = [];
  let attempts = 0;
  lease.tracker?.mark('runAt');
  return {
    /** Execute exactly one approved rule at its candidate or merge-base source; exit 1 is a counted result. */
    async runCheck(commit, command, timeoutMs) {
      attempts++;
      const started = performance.now();
      const directory = mkdtempSync(join(parent, 'rule-'));
      const shell = `(\n${command}\n) 2>&1`;
      const checkedSource = { commit, tree: git(root, ['rev-parse', `${commit}^{tree}`]).trim() };
      const policy = privateCheckEnvelope({ kind: 'private-check', version: 1, install: '', check: shell, timeoutMs,
        policyCommit: mainCommit, trunk: { ref: trunkRef(root), commit: mainCommit } });
      let result;
      try {
        result = await lease.executionServices.runners.runOnRunnerAsync(root, shell, { runner: lease.runner, source: lease.source,
          runnerWaitDeadline: lease.runnerWaitDeadline, browser: lease.browser, checkedSource, privateCheck: policy,
          metadata: { ...lease.runMetadata, testStage: 'doctrine' }, rawOutputPath: join(directory, 'raw.log'), signal: lease.signal });
      } catch (error) {
        writeFileSync(join(directory, 'failure.json'), JSON.stringify({ version: 1, policySha256: policy.sha256, checkedSource,
          code: error?.code ?? error?.name ?? 'unknown', rawOutputPath: join(directory, 'raw.log') }) + '\n', { mode: 0o600 });
        throw error;
      }
      const receipt = result.privateCheck?.receipt;
      const phase = receipt?.phases?.check;
      const observed = { version: 1, policyCommit: mainCommit, commandSha256: createHash('sha256').update(command).digest('hex'),
        privateCheckSha256: policy.sha256, checkedSource, executionSource: result.executionSource ?? null,
        runner: result.executionRunner ?? null, environment: result.environment ?? null,
        executionAdmission: result.executionAdmission ?? null, executionPhases: result.executionPhases ?? null,
        privateCheck: receipt ?? null, rawOutputPath: result.rawOutputPath ?? null, rawOutputSha256: result.rawOutputSha256 ?? null };
      writeFileSync(join(directory, 'observation.json'), JSON.stringify(observed) + '\n', { mode: 0o600 });
      observations.push(observed);
      if (result.executionRunner !== lease.runner.host || result.executionSource?.commit !== checkedSource.commit
        || result.executionSource?.tree !== checkedSource.tree || receipt?.requestSha256 !== policy.sha256) {
        throw new Refused('RUNNER_RESULT_INVALID', 'doctrine runner result does not bind its admitted source and approved policy; inspect the retained observation before retrying');
      }
      const seconds = Math.round((performance.now() - started) / 1000);
      const broken = !receipt.sourceUnchanged ? 'changed its private source' : receipt.problem ? receipt.problem.message
        : !phase ? 'has no complete check phase' : phase.timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s`
          : phase.signal ? `was killed by ${phase.signal}` : ![0, 1].includes(phase.code) ? `exited ${phase.code}` : '';
      if (broken) return { problems: [], broken, seconds };
      if (phase.offset !== 0 || !Number.isSafeInteger(phase.length) || phase.length < 0 || phase.length > 64 * 1024 * 1024
        || statSync(result.rawOutputPath).size !== phase.length) return { problems: [], broken: 'exceeded the complete bounded check output', seconds };
      const bytes = readFileSync(result.rawOutputPath);
      if (bytes.length !== phase.length || createHash('sha256').update(bytes).digest('hex') !== phase.sha256) {
        throw new Refused('RUNNER_RESULT_INVALID', 'doctrine check bytes do not match the authenticated phase; inspect the retained observation before retrying');
      }
      return { problems: bytes.toString('utf8').split(/\r?\n/u).map(line => line.trimEnd()).filter(line => line.trim()), broken: '', seconds };
    },
    /** Sum the disjoint worker intervals for sequential rule runs when all were measured. */
    finish() {
      lease.tracker?.mark('ranAt');
      const single = attempts === 1 && observations.length === 1 ? observations[0] : null;
      lease.environment = observations.length && attempts === observations.length && observations.every(row => JSON.stringify(row.environment) === JSON.stringify(observations[0].environment)) ? observations[0].environment : null;
      lease.executionAdmission = single?.executionAdmission ?? null;
      lease.executionPhases = doctrineExecutionPhases(observations, attempts);
    },
  };
}
