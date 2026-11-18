import { serialize } from 'node:v8';
import {
  writeFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { needsFullCensus } from '../../../../../packages/codemap/index.js';
import { readAcceptedCells } from '../../../../../packages/gate/index.js';
import { shellWord } from '../../../../../packages/runners/index.js';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  git,
  gitPath,
} from '../../../../../packages/git/index.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import { keepRunnerStderr } from '../runner/stderr.js';
import { privateCheckEnvelope } from '../../../../runner/index.js';
import { trunkRef } from '../../../../../packages/sandbox/index.js';

const TRUSTED_RESULT = 'PULLBOARD_TRUSTED_RESULT ';

/** The sentence tail that points a reader at the kept stderr, or an empty string when none was kept. */
export function stderrNote(file) {
  return file ? `; runner stderr is in ${file}` : '';
}

/** The refusal payload from a runner's authenticated stdout, or null when the step printed none. */
export function trustedRefusalIn(text) {
  for (const line of String(text).split(/\r?\n/u)) {
    if (!line.startsWith(TRUSTED_RESULT)) continue;
    try {
      const refusal = JSON.parse(line.slice(TRUSTED_RESULT.length))?.refusal;
      if (refusal && typeof refusal.code === 'string' && typeof refusal.message === 'string') return refusal;
    } catch { /* not a refusal line */ }
  }
  return null;
}

/**
 * Throw a runner's refusal as the Mac would raise it: retryable becomes the infrastructure error the queue reruns
 * on the same candidate, anything else is that refusal code.
 */
export function throwTrustedRefusal(refusal) {
  if (refusal.retryable === true) {
    throw Object.assign(new Error(refusal.message), { name: 'CellsInventoryInfrastructureError', code: refusal.code, retryable: true });
  }
  throw new Refused(refusal.code, refusal.message);
}

/** Accept only a complete authenticated response for the same source, policy and board snapshot. */
export async function remoteSubmitCells(root, main, source, item, lease, readCutItems, artifactDirectory, { collectMachinery = false } = {}) {
  if (!lease.runner || typeof lease.executionServices?.runners?.runOnRunnerAsync !== 'function') {
    throw new Refused('RUNNER_SOURCE', 'cell analysis needs its admitted remote runner');
  }
  // The coordinator ships an inventory only when it already holds every accepted one; otherwise the runner produces them in its own cache (#3662).
  const { inventory, produce } = await runnerCellsInventory(root, main, source);
  const criterion = JSON.parse(item.item_frozen ?? 'null')?.criterion;
  const cutRows = readCutItems();
  const shell = submitCellsRemoteCommand({ main, source, criterion, title: item.item_title ?? '', cutRows, inventory: inventory?.descriptor ?? null, produceInventory: produce, node: lease.runner.node ?? 'node', collectMachinery });
  const tree = git(root, ['rev-parse', `${source}^{tree}`]).trim();
  const checkedSource = { commit: source, tree };
  const policy = privateCheckEnvelope({ kind: 'private-check', version: 1, install: '', check: shell,
    timeoutMs: 30 * 60 * 1000, policyCommit: main, trunk: { ref: trunkRef(root), commit: main } });
  const parent = artifactDirectory ? join(artifactDirectory, 'cells') : gitPath(root, 'pullboard-cells-output');
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(parent, 'analysis-'));
  const result = await lease.executionServices.runners.runOnRunnerAsync(root, shell, {
    runner: lease.runner, source: lease.source, runnerWaitDeadline: lease.runnerWaitDeadline, runnerStartupMs: lease.runnerStartupMs,
    browser: lease.browser, checkedSource, privateCheck: policy,
    ...(inventory ? { analysisArtifact: { file: inventory.file, bytes: inventory.bytes.length, sha256: inventory.digest, context: policy.sha256 } } : {}),
    metadata: { ...lease.runMetadata, testStage: 'cells' }, rawOutputPath: join(directory, 'raw.log'), signal: lease.signal,
  });
  lease.executionAdmission = result.executionAdmission ?? null;
  lease.executionPhases = result.executionPhases ?? null;
  const kept = keepRunnerStderr(directory, result);
  const receipt = result.privateCheck?.receipt;
  const phase = receipt?.phases?.check;
  if (result.executionRunner !== lease.runner.host || result.executionSource?.commit !== source
    || result.executionSource?.tree !== tree || receipt?.requestSha256 !== policy.sha256
    || receipt.sourceUnchanged !== true || receipt.problem || !phase || phase.offset !== 0
    || phase.code !== 0 || phase.signal || phase.timedOut || !Number.isSafeInteger(phase.length)
    || phase.length < 0 || phase.length > 64 * 1024 * 1024 || statSync(result.rawOutputPath).size !== phase.length) {
    throw new Refused('CELLS_SUBMIT', `remote cell analysis did not return a complete pinned result; inspect ${directory}${stderrNote(kept)}`);
  }
  const bytes = readFileSync(result.rawOutputPath);
  if (bytes.length !== phase.length || createHash('sha256').update(bytes).digest('hex') !== phase.sha256) {
    throw new Refused('RUNNER_RESULT_INVALID', 'remote cell analysis output does not match its authenticated receipt');
  }
  const refusal = trustedRefusalIn(bytes.toString('utf8'));
  if (refusal) throwTrustedRefusal(refusal);
  const rows = bytes.toString('utf8').split(/\r?\n/u).filter(line => line.startsWith('PULLBOARD_CELLS_RESULT '));
  let value;
  try { if (rows.length === 1) value = JSON.parse(rows[0].slice('PULLBOARD_CELLS_RESULT '.length)); } catch { /* refused below */ }
  if (!value || value.acceptedMain !== main || value.source !== source || !Array.isArray(value.cells)
    || !Array.isArray(value.existingCuts) || JSON.stringify(readCutItems()) !== JSON.stringify(cutRows)) {
    throw new Refused('CELLS_SUBMIT', 'remote cell result or trusted cut authority changed; retry from a fresh snapshot');
  }
  return value;
}

/** Construct a data-only request to run the accepted-main checker in a private runner checkout. */
export function submitCellsRemoteCommand({ main, source, criterion, title = '', cutRows, inventory = null, produceInventory = [], node = 'node', collectMachinery = false }) {
  if (![main, source].every(value => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value))
    || main.length !== source.length || typeof criterion !== 'string' || !Array.isArray(cutRows) || typeof node !== 'string' || !node) {
    throw new TypeError('cell analysis needs pinned commits, criterion and cut rows');
  }
  const data = Buffer.from(JSON.stringify({ main, source, criterion, title, cutRows, inventory, produceInventory, collectMachinery })).toString('base64');
  // A coded refusal is a result, not a crash: print it as a trusted line and exit 0; only a codeless error exits 1 [C7].
  const script = `(${remoteCells.toString()})(${JSON.stringify(data)}).catch(error => {
  if (typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]*$/u.test(error.code) && (error.name === 'Refused' || error.retryable === true)) {
    process.stdout.write('${TRUSTED_RESULT}' + JSON.stringify({ refusal: { code: error.code, message: String(error.message ?? ''), retryable: error.retryable === true } }) + '\\n');
    return;
  }
  console.error(error?.stack ?? String(error)); process.exitCode = 1;
});`;
  return `${shellWord(node)} --input-type=module -e ${shellWord(script)}`;
}

/** Archive only main's literal Git objects; candidate code is inspected as data, never loaded. */
async function remoteCells(encoded) {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const input = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  const root = process.cwd();
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  /** Run a pinned command and retain its actionable refusal line for gate diagnostics. */
  const run = (command, args, options = {}, step = `command ${command}`) => {
    const result = spawnSync(command, args, { cwd: root, env, maxBuffer: 128 * 1024 ** 2, ...options });
    if (result.error || result.status !== 0) {
      const lines = result.stderr?.toString('utf8').split(/\r?\n/u).map(line => line.trim()).filter(Boolean) ?? [];
      const diagnostic = lines.findLast(line => /^(?:[A-Za-z]*Error|Refused):/u.test(line)) ?? lines[0];
      throw new Error(`${step} failed: ${diagnostic ?? result.error?.message ?? `exit ${result.status}`}`);
    }
    return result.stdout;
  };
  const git = (...args) => run('git', ['--no-replace-objects', ...args]);
  // Generic projects have no cells plan or Pullboard's own checker modules. Match the local no-plan result on the runner.
  if (!git('ls-tree', '--name-only', input.main, '--', 'packages/codemap/data/plan/cells.json').toString().trim()) {
    process.stdout.write('PULLBOARD_CELLS_RESULT ' + JSON.stringify({ acceptedMain: input.main, source: input.source,
      cells: [], existingCuts: [], problems: [], warnings: [], reorg: null }) + '\n');
    return;
  }
  const objects = git('rev-parse', '--path-format=absolute', '--git-path', 'objects').toString().trim();
  if (!objects || /[\r\n]/u.test(objects)) throw new Error('invalid object directory');
  // A named scratch root (PULLBOARD_SCRATCH) holds throwaway folders; unset keeps the OS temp root.
  const named = process.env.PULLBOARD_SCRATCH;
  const { existsSync } = await import('node:fs');
  const { isAbsolute } = await import('node:path');
  const directory = mkdtempSync(join(named && isAbsolute(named) && existsSync(named) ? named : tmpdir(), 'pullboard-cells-trusted-'));
  try {
    const metadata = join(directory, '.objects');
    git('init', '--quiet', '--bare', metadata);
    writeFileSync(join(metadata, 'objects/info/alternates'), `${objects}\n`, { flag: 'wx' });
    mkdirSync(join(metadata, 'info'), { recursive: true });
    writeFileSync(join(metadata, 'info/attributes'), '* -text -filter -ident -export-subst -export-ignore\n', { flag: 'wx' });
    const archive = git('--git-dir', metadata, '-c', 'core.autocrlf=false', '-c', 'core.attributesFile=/dev/null', 'archive', '--format=tar', input.main);
    run('tar', ['-xf', '-', '-C', directory], { input: archive });
    const entry = join(directory, 'trusted-cells-entry.mjs');
    writeFileSync(entry, `import { existsSync } from 'node:fs';
import {
  importsIn,
  commonJsIn,
  withImportParseCache,
  foreignNodeOptions,
  readAcceptedCells,
  warmAcceptedCells,
} from './packages/gate/index.js';
import { withMainCheckout } from './packages/landing/index.js';
import * as cellsCache from './apps/cli/src/io/cells/cache.js';
import { readFileSync } from 'node:fs';
// An accepted main that predates the cli-owned module still keeps the checks in bin/.
const { requireSubmitCells } = await import(existsSync(new URL('./apps/cli/src/io/cells-submit-checks.js', import.meta.url)) ? './apps/cli/src/io/cells-submit-checks.js' : './bin/cells-submit-checks.js');
const input = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'));
let artifacts = input.inventory && typeof cellsCache.transferredCellsInventories === 'function' ? cellsCache.transferredCellsInventories(readFileSync(process.env.PULLBOARD_RUNNER_ANALYSIS_ARTIFACT), input.inventory) : null;
// The coordinator held no inventory for these accepted commits: produce each here, once per runner cache (#3662).
if (!artifacts && Array.isArray(input.produceInventory) && input.produceInventory.length) {
  const pending = (commit, message) => Object.assign(new Error('accepted cells inventory was not produced on the runner: ' + message), { name: 'CellsInventoryInfrastructureError', code: 'CELLS_INVENTORY_PENDING', retryable: true, commit });
  const made = new Map();
  for (const commit of input.produceInventory) {
    let found = readAcceptedCells(process.argv[3], commit);
    if (!found.available) {
      const { withFileLock } = await import('./packages/outbox/index.js');
      try { await warmAcceptedCells(process.argv[3], commit, { withCheckout: withMainCheckout, withLock: withFileLock, trunk: input.main }); }
      catch (error) { throw pending(commit, String(error?.message ?? error)); }
      found = readAcceptedCells(process.argv[3], commit);
    }
    if (!found.available) throw pending(commit, commit.slice(0, 12) + ' is unreadable after production (' + found.cause + ')');
    made.set(commit, found);
  }
  artifacts = made;
}
const artifact = artifacts?.get(input.main);
const result = await requireSubmitCells(process.argv[3], input.main, input.source,
  { item_frozen: JSON.stringify({ criterion: input.criterion }), item_title: input.title ?? '' }, {
    withMainCheckout, acceptedArtifact: artifact, acceptedArtifacts: artifacts, parsers: { importsIn, commonJsIn }, withImportParseCache,
    cacheEligible: () => !foreignNodeOptions(process.env.NODE_OPTIONS), readCutItems: () => input.cutRows, collectMachinery: input.collectMachinery === true,
  });
process.stdout.write('PULLBOARD_CELLS_RESULT ' + JSON.stringify(result) + '\\n');
`, { flag: 'wx', mode: 0o600 });
    process.stdout.write(run(process.execPath, [entry, encoded, root], {}, 'cells checker'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

/**
 * The accepted commits whose cells inventory a submit's cell analysis reads: main, plus the candidate's merge base
 * when main changed a file that needs a full census since that base. Empty when main has no cells plan.
 *
 * @param {string} root - Absolute repository root.
 * @param {string} main - The pinned accepted main.
 * @param {string} [source] - The pinned candidate.
 * @returns {string[]}
 */
export function inventoryCommits(root, main, source) {
  if (!git(root, ['ls-tree', '--name-only', main, '--', 'packages/codemap/data/plan/cells.json']).trim()) return [];
  const commits = [main];
  if (source) {
    const base = git(root, ['merge-base', main, source]).trim();
    const changed = base !== main ? git(root, ['diff', '--no-renames', '--name-only', '-z', main, base]).split('\0').filter(Boolean) : [];
    if (needsFullCensus(changed)) commits.push(base);
  }
  return commits;
}

/**
 * The inventory a runner analysis carries: the bundle when this machine already holds every accepted inventory, else
 * none, with the commits the runner produces itself.
 * Why: producing a main commit's inventory took a checkout and 70-110 s of this machine's CPU on every new main, the
 * heaviest gate stage left on the coordinator (6 Nov); a runner produces it once and keeps it in its own cache (#2535).
 *
 * @param {string} root - Absolute repository root.
 * @param {string} main - The pinned accepted main.
 * @param {string} [source] - The pinned candidate.
 * @returns {Promise<{ inventory: Awaited<ReturnType<typeof submitCellsInventory>>, produce: string[] }>}
 */
export async function runnerCellsInventory(root, main, source) {
  const commits = inventoryCommits(root, main, source);
  if (commits.every(commit => readAcceptedCells(root, commit).available)) return { inventory: await submitCellsInventory(root, main, source), produce: [] };
  return { inventory: null, produce: commits };
}

/**
 * A submit reads completed authority only; a cold tree defers as infrastructure, naming its commit, so the queued
 * worker gets it through the tree's cells-inventory job and runs the same candidate again (RFC 0008 DJ21).
 */
export async function submitCellsInventory(root, main, source) {
  const commits = inventoryCommits(root, main, source);
  if (!commits.length) return null;
  const sources = [], artifacts = [];
  let directory;
  for (const commit of commits) {
    const artifact = readAcceptedCells(root, commit);
    if (!artifact.available) {
      throw Object.assign(new Error(`accepted cells inventory for ${commit.slice(0, 12)} is warming (${artifact.cause}); requeue after its cells-inventory job finishes`),
        { name: 'CellsInventoryInfrastructureError', code: 'CELLS_INVENTORY_PENDING', retryable: true, commit });
    }
    directory ??= dirname(artifact.file);
    sources.push({ commit, descriptor: artifact.descriptor });
    artifacts.push({ commit, bytes: artifact.bytes });
  }
  const bytes = serialize({ version: 1, artifacts });
  if (bytes.length > 64 * 1024 ** 2) throw Object.assign(new Error('accepted inventory bundle exceeds its bounded runner stream'),
    { name: 'CellsInventoryInfrastructureError', code: 'CELLS_INVENTORY_OVERSIZE', retryable: true });
  const digest = createHash('sha256').update(bytes).digest('hex');
  const file = join(directory, `${digest}.bundle`), temporary = join(directory, `.${digest}.${process.pid}.tmp`);
  if (!existsSync(file)) {
    try { writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 }); renameSync(temporary, file); }
    finally { rmSync(temporary, { force: true }); }
  }
  return { file, bytes, digest, descriptor: { version: 1, digest, sources } };
}
