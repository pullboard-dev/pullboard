import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { remoteSubmitCells } from '../../../src/io/submit/remote.js';
import { submitCellsRemoteCommand } from '../../../src/io/submit/remote.js';

test('cli.io-submit-remote.remote-cells-loads-pinned-main-tooling-and: remote cells loads pinned main tooling and treats candidate tooling as data [C7,D3]', () => {
  const root = mkdtempSync(join(tmpdir(), 'cells-remote-test-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && !['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'].includes(key)) delete env[key];
  const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' }).trim();
  const put = (path, body) => { const file = join(root, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, body); };
  try {
    git('init', '--quiet');
    put('package.json', '{"type":"module"}\n');
    put('packages/codemap/data/plan/cells.json', '{"version":1,"cells":[]}\n');
    const trustedGate = 'export function importsIn(){}; export function commonJsIn(){}; export function withImportParseCache(){}; export function foreignNodeOptions(){ return false; }; export function readAcceptedCells(){}; export function warmAcceptedCells(){}\n';
    put('packages/gate/heavy.js', "export * from './index.js';\n");
    put('packages/gate/index.js', trustedGate);
    put('packages/landing/index.js', 'export function withMainCheckout(){}\n');
    put('apps/cli/src/io/cells/cache.js', 'export {};\n');
    put('bin/cells-submit-checks.js', `export async function requireSubmitCells(root, main, source, item, services) {
      if (JSON.parse(item.item_frozen).criterion !== 'fixture' || services.readCutItems()[0].item_id !== 7 || !services.cacheEligible()
        || typeof services.parsers.importsIn !== 'function' || typeof services.parsers.commonJsIn !== 'function'
        || typeof services.withImportParseCache !== 'function') throw new Error('lost authority');
      return { acceptedMain: main, source, cells: ['trusted-main'], existingCuts: [] };
    }\n`);
    git('add', '.'); git('-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'trusted');
    const main = git('rev-parse', 'HEAD');
    put('bin/cells-submit-checks.js', "throw new Error('candidate tooling was executed');\n");
    put('packages/gate/index.js', "throw new Error('candidate gate tooling was executed');\n");
    git('add', '.'); git('-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'candidate');
    const source = git('rev-parse', 'HEAD');
    const command = submitCellsRemoteCommand({ main, source, criterion: 'fixture', cutRows: [{ item_id: 7 }] });
    const output = execFileSync('/bin/sh', ['-c', command], { cwd: root, env, encoding: 'utf8' });
    const result = JSON.parse(output.match(/^PULLBOARD_CELLS_RESULT (.*)$/mu)[1]);
    assert.deepEqual(result, { acceptedMain: main, source, cells: ['trusted-main'], existingCuts: [] });

    put('packages/gate/index.js', trustedGate);
    put('bin/cells-submit-checks.js', "export async function requireSubmitCells() { throw new Error('CELL_DIAGNOSTIC: refusing candidate'); }\n");
    git('add', '.'); git('-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'refusing checker');
    const refusingMain = git('rev-parse', 'HEAD');
    const refusingCommand = submitCellsRemoteCommand({ main: refusingMain, source, criterion: 'fixture', cutRows: [{ item_id: 7 }] });
    const refused = spawnSync('/bin/sh', ['-c', refusingCommand], { cwd: root, env, encoding: 'utf8' });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /cells checker failed: Error: CELL_DIAGNOSTIC: refusing candidate/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('cli.io-submit-remote.remote-cells-rejects-altered-output-and-a: remote cells rejects altered output and a changed cut authority snapshot [C7,D3]', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cells-remote-proof-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && !['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'].includes(key)) delete env[key];
  const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' }).trim();
  try {
    git('init', '--quiet'); git('config', 'pullboard.trunk', 'refs/heads/main');
    writeFileSync(join(root, 'file'), 'fixture\n'); git('add', '.');
    git('-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'fixture');
    const main = git('rev-parse', 'HEAD'), tree = git('rev-parse', 'HEAD^{tree}');
    let changed = false, corrupt = false, reads = 0;
    const readCuts = () => [{ item_id: changed && ++reads > 1 ? 8 : 7 }];
    const runOnRunnerAsync = async (_root, _shell, options) => {
      const bytes = Buffer.from(`PULLBOARD_CELLS_RESULT ${JSON.stringify({ acceptedMain: main, source: main, cells: [], existingCuts: [] })}\n`);
      writeFileSync(options.rawOutputPath, bytes);
      return { executionRunner: 'fixture', executionSource: { commit: main, tree }, rawOutputPath: options.rawOutputPath,
        privateCheck: { receipt: { requestSha256: options.privateCheck.sha256, sourceUnchanged: true,
          phases: { check: { offset: 0, length: bytes.length, code: 0, signal: null, timedOut: false,
            sha256: corrupt ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex') } } } } };
    };
    const lease = { runner: { host: 'fixture' }, source: { commit: main, tree }, executionServices: { runners: { runOnRunnerAsync } } };
    const item = { item_frozen: JSON.stringify({ criterion: 'fixture' }) };
    assert.equal((await remoteSubmitCells(root, main, main, item, lease, readCuts, root)).acceptedMain, main);
    corrupt = true;
    await assert.rejects(remoteSubmitCells(root, main, main, item, lease, readCuts, root), { code: 'RUNNER_RESULT_INVALID' });
    corrupt = false; changed = true; reads = 0;
    await assert.rejects(remoteSubmitCells(root, main, main, item, lease, readCuts, root), { code: 'CELLS_SUBMIT' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('cli.io-submit-remote.remote-cell-analysis-accepts-a-generic-project: remote cell analysis accepts a generic project without core checker files [C7,V4]', () => {
  const root = mkdtempSync(join(tmpdir(), 'cells-remote-generic-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && !['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'].includes(key)) delete env[key];
  const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' }).trim();
  try {
    git('init', '--quiet');
    writeFileSync(join(root, 'README.md'), 'generic project\n');
    git('add', '.'); git('-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'generic');
    const main = git('rev-parse', 'HEAD');
    const command = submitCellsRemoteCommand({ main, source: main, criterion: 'fixture', cutRows: [] });
    const output = execFileSync('/bin/sh', ['-c', command], { cwd: root, env, encoding: 'utf8' });
    const result = JSON.parse(output.match(/^PULLBOARD_CELLS_RESULT (.*)$/mu)[1]);
    assert.equal(result.acceptedMain, main);
    assert.equal(result.source, main);
    assert.deepEqual(result.cells, []);
    assert.deepEqual(result.existingCuts, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
