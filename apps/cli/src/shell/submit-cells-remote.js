import { serialize } from 'node:v8';
import {
  writeFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { needsFullCensus } from '../../../../packages/codemap/index.js';
import {
  readAcceptedCells,
  nudgeAcceptedCells,
} from '../../../../packages/gate/index.js';
import { shellWord } from '../../../../packages/runners/index.js';
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
} from '../../../../packages/git/index.js';
import { Refused } from '../../../../packages/kernel/index.js';
import { privateCheckEnvelope } from '../../../runner/index.js';
import { trunkRef } from '../../../../packages/sandbox/index.js';

/** Accept only a complete authenticated response for the same source, policy and board snapshot. */
export async function remoteSubmitCells(root, main, source, item, lease, readCutItems, artifactDirectory, { collectMachinery = false } = {}) {
  if (!lease.runner || typeof lease.executionServices?.runners?.runOnRunnerAsync !== 'function') {
    throw new Refused('RUNNER_SOURCE', 'cell analysis needs its admitted remote runner');
  }
  const inventory = await submitCellsInventory(root, main, source);
  const criterion = JSON.parse(item.item_frozen ?? 'null')?.criterion;
  const cutRows = readCutItems();
  const shell = submitCellsRemoteCommand({ main, source, criterion, title: item.item_title ?? '', cutRows, inventory: inventory?.descriptor ?? null, node: lease.runner.node ?? 'node', collectMachinery });
  const tree = git(root, ['rev-parse', `${source}^{tree}`]).trim();
  const checkedSource = { commit: source, tree };
  const policy = privateCheckEnvelope({ kind: 'private-check', version: 1, install: '', check: shell,
    timeoutMs: 30 * 60 * 1000, policyCommit: main, trunk: { ref: trunkRef(root), commit: main } });
  const parent = artifactDirectory ? join(artifactDirectory, 'cells') : gitPath(root, 'pullboard-cells-output');
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(parent, 'analysis-'));
  const result = await lease.executionServices.runners.runOnRunnerAsync(root, shell, {
    runner: lease.runner, source: lease.source, runnerWaitDeadline: lease.runnerWaitDeadline,
    browser: lease.browser, checkedSource, privateCheck: policy,
    ...(inventory ? { analysisArtifact: { file: inventory.file, bytes: inventory.bytes.length, sha256: inventory.digest, context: policy.sha256 } } : {}),
    metadata: { ...lease.runMetadata, testStage: 'cells' }, rawOutputPath: join(directory, 'raw.log'), signal: lease.signal,
  });
  lease.executionAdmission = result.executionAdmission ?? null;
  lease.executionPhases = result.executionPhases ?? null;
  const receipt = result.privateCheck?.receipt;
  const phase = receipt?.phases?.check;
  if (result.executionRunner !== lease.runner.host || result.executionSource?.commit !== source
    || result.executionSource?.tree !== tree || receipt?.requestSha256 !== policy.sha256
    || receipt.sourceUnchanged !== true || receipt.problem || !phase || phase.offset !== 0
    || phase.code !== 0 || phase.signal || phase.timedOut || !Number.isSafeInteger(phase.length)
    || phase.length < 0 || phase.length > 64 * 1024 * 1024 || statSync(result.rawOutputPath).size !== phase.length) {
    throw new Refused('CELLS_SUBMIT', `remote cell analysis did not return a complete pinned result; inspect ${directory}`);
  }
  const bytes = readFileSync(result.rawOutputPath);
  if (bytes.length !== phase.length || createHash('sha256').update(bytes).digest('hex') !== phase.sha256) {
    throw new Refused('RUNNER_RESULT_INVALID', 'remote cell analysis output does not match its authenticated receipt');
  }
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
export function submitCellsRemoteCommand({ main, source, criterion, title = '', cutRows, inventory = null, node = 'node', collectMachinery = false }) {
  if (![main, source].every(value => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value))
    || main.length !== source.length || typeof criterion !== 'string' || !Array.isArray(cutRows) || typeof node !== 'string' || !node) {
    throw new TypeError('cell analysis needs pinned commits, criterion and cut rows');
  }
  const data = Buffer.from(JSON.stringify({ main, source, criterion, title, cutRows, inventory, collectMachinery })).toString('base64');
  const script = `(${remoteCells.toString()})(${JSON.stringify(data)}).catch(error => { console.error(error?.stack ?? String(error)); process.exitCode = 1; });`;
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
  if (!git('ls-tree', '--name-only', input.main, '--', 'bin/cells-plan.json').toString().trim()) {
    process.stdout.write('PULLBOARD_CELLS_RESULT ' + JSON.stringify({ acceptedMain: input.main, source: input.source,
      cells: [], existingCuts: [], problems: [], warnings: [], reorg: null }) + '\n');
    return;
  }
  const objects = git('rev-parse', '--path-format=absolute', '--git-path', 'objects').toString().trim();
  if (!objects || /[\r\n]/u.test(objects)) throw new Error('invalid object directory');
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-cells-trusted-'));
  try {
    const metadata = join(directory, '.objects');
    git('init', '--quiet', '--bare', metadata);
    writeFileSync(join(metadata, 'objects/info/alternates'), `${objects}\n`, { flag: 'wx' });
    mkdirSync(join(metadata, 'info'), { recursive: true });
    writeFileSync(join(metadata, 'info/attributes'), '* -text -filter -ident -export-subst -export-ignore\n', { flag: 'wx' });
    const archive = git('--git-dir', metadata, '-c', 'core.autocrlf=false', '-c', 'core.attributesFile=/dev/null', 'archive', '--format=tar', input.main);
    run('tar', ['-xf', '-', '-C', directory], { input: archive });
    const entry = join(directory, 'trusted-cells-entry.mjs');
    writeFileSync(entry, `import { requireSubmitCells } from './bin/cells-submit-checks.js';
import {
  importsIn,
  commonJsIn,
  withImportParseCache,
  foreignNodeOptions,
} from './packages/gate/index.js';
import { withMainCheckout } from './packages/landing/index.js';
import * as cellsCache from './bin/cells-inventory-cache.js';
import { readFileSync } from 'node:fs';
const input = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'));
const artifacts = input.inventory && typeof cellsCache.transferredCellsInventories === 'function' ? cellsCache.transferredCellsInventories(readFileSync(process.env.PULLBOARD_RUNNER_ANALYSIS_ARTIFACT), input.inventory) : null;
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

/** A submit reads completed authority only; a cold tree wakes the independent producer and defers as infrastructure. */
export async function submitCellsInventory(root, main, source) {
  if (!git(root, ['ls-tree', '--name-only', main, '--', 'bin/cells-plan.json']).trim()) return null;
  const commits = [main];
  if (source) {
    const base = git(root, ['merge-base', main, source]).trim();
    const changed = base !== main ? git(root, ['diff', '--no-renames', '--name-only', '-z', main, base]).split('\0').filter(Boolean) : [];
    if (needsFullCensus(changed)) commits.push(base);
  }
  const sources = [], artifacts = [];
  let directory;
  for (const commit of commits) {
    const artifact = readAcceptedCells(root, commit);
    if (!artifact.available) {
      let nudgeFailure;
      try { await nudgeAcceptedCells(root, new URL('../../../../bin/main-audit.js', import.meta.url), commit); }
      catch (error) { nudgeFailure = String(error.message); }
      throw Object.assign(new Error(`accepted cells inventory for ${commit.slice(0, 12)} is warming (${artifact.cause}${nudgeFailure ? `; ${nudgeFailure}` : ''}); requeue after the independent producer finishes`),
        { name: 'CellsInventoryInfrastructureError', code: 'CELLS_INVENTORY_PENDING', retryable: true });
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
