import { shellWord } from './runner-remote-tooling.js';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  git,
  gitPath,
} from './git.js';
import { Refused } from '../packages/kernel/index.js';
import { privateCheckEnvelope } from './runner-private-mode.js';
import { trunkRef } from '../packages/sandbox/index.js';

/** Accept only a complete authenticated response for the same source, policy and board snapshot. */
export async function remoteSubmitCells(root, main, source, item, lease, readCutItems, artifactDirectory) {
  if (!lease.runner || typeof lease.executionServices?.runners?.runOnRunnerAsync !== 'function') {
    throw new Refused('RUNNER_SOURCE', 'cell analysis needs its admitted remote runner');
  }
  const criterion = JSON.parse(item.item_frozen ?? 'null')?.criterion;
  const cutRows = readCutItems();
  const shell = submitCellsRemoteCommand({ main, source, criterion, title: item.item_title ?? '', cutRows, node: lease.runner.node ?? 'node' });
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
    metadata: { ...lease.runMetadata, testStage: 'cells' }, rawOutputPath: join(directory, 'raw.log'),
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
export function submitCellsRemoteCommand({ main, source, criterion, title = '', cutRows, node = 'node' }) {
  if (![main, source].every(value => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value))
    || main.length !== source.length || typeof criterion !== 'string' || !Array.isArray(cutRows) || typeof node !== 'string' || !node) {
    throw new TypeError('cell analysis needs pinned commits, criterion and cut rows');
  }
  const data = Buffer.from(JSON.stringify({ main, source, criterion, title, cutRows })).toString('base64');
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
  const run = (command, args, options = {}) => {
    const result = spawnSync(command, args, { cwd: root, env, maxBuffer: 128 * 1024 ** 2, ...options });
    if (result.error || result.status !== 0) throw new Error(`trusted cell archive failed: ${command}`);
    return result.stdout;
  };
  const git = (...args) => run('git', ['--no-replace-objects', ...args]);
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
import { importsIn, commonJsIn, withImportParseCache, foreignNodeOptions } from './packages/gate/index.js';
import { withMainCheckout } from './packages/landing/index.js';
const input = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'));
const result = await requireSubmitCells(process.argv[3], input.main, input.source,
  { item_frozen: JSON.stringify({ criterion: input.criterion }), item_title: input.title ?? '' }, {
    withMainCheckout, parsers: { importsIn, commonJsIn }, withImportParseCache,
    cacheEligible: () => !foreignNodeOptions(process.env.NODE_OPTIONS), readCutItems: () => input.cutRows,
  });
process.stdout.write('PULLBOARD_CELLS_RESULT ' + JSON.stringify(result) + '\\n');
`, { flag: 'wx', mode: 0o600 });
    process.stdout.write(run(process.execPath, [entry, encoded, root]));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
