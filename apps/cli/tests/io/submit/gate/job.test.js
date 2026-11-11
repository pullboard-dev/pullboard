/** A queued submit's four analysis parts run as one runner job on one lease; a red part still refuses with its own code [C7]. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { remoteSubmitAnalysis } from '../../../../src/io/submit/gate.js';
import { sharedRemoteAnalysis } from '../../../../src/io/submit/gate.js';
import { temporaryDirectory } from '../../../fixtures/board.js';
import { temporaryRepository } from '../../../fixtures/board/submit.js';
import { runFixtureGit } from '../../../fixtures/child.js';

const PARTS = ['preflight', 'selection', 'cells', 'static'];

/** A Git environment free of the caller's repository selectors and identity. */
function gitEnv() {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && !/^GIT_(CONFIG_GLOBAL|CONFIG_NOSYSTEM|AUTHOR_|COMMITTER_)/u.test(key)) delete env[key];
  return env;
}

/** Build a controller with trusted main tooling and a runner clone at the candidate; `red` names parts whose tooling refuses. */
function fixture(t, red = []) {
  const dir = temporaryDirectory('submit-one-analysis-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = gitEnv(), controller = temporaryRepository(t, 'submit-one-analysis-controller-'), runner = join(dir, 'runner');
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env });
  const put = (path, body) => { const file = join(controller, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, body); };
  const refuse = (part, code) => red.includes(part) ? `throw Object.assign(new Error('${part} is red'), { name: 'Refused', code: '${code}' });` : '';
  git(controller, 'config', 'pullboard.trunk', 'refs/heads/main');
  put('package.json', '{"type":"module"}\n');
  put('packages/items/index.js', `export function requirePlannedSource() { ${refuse('preflight', 'PLACEMENT_RED')} }
export function requireSubmitComposition() {}\n`);
  put('packages/gate/index.js', `export function importsIn() {} export function commonJsIn() {} export function withImportParseCache() {}
export function foreignNodeOptions() { return false; }
export function submitGatePlan(root, config, options) { ${refuse('selection', 'SELECTION_RED')}
  return { proofFiles: ['test/a.test.js'], check: options.check }; }
export async function submitGateAdmission() { return { browser: false, gui: false }; }
`);
  put('packages/landing/index.js', 'export function withMainCheckout() {}\n');
  put('bin/cells-submit-checks.js', `export async function requireSubmitCells(root, main, source) { ${refuse('cells', 'CELLS_SUBMIT')}
  return { acceptedMain: main, source, cells: [], existingCuts: [] }; }\n`);
  put('packages/codemap/src/io/cells/scripts/cache.js', 'export function transferredCellsInventories() { return null; }\n');
  put('bin/static-checks.js', red.includes('static') ? "console.error('static is red'); process.exitCode = 1;\n" : '');
  git(controller, 'add', '.');
  git(controller, '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'main');
  const main = git(controller, 'rev-parse', 'HEAD');
  put('src/thing.js', 'export const thing = 1;\n');
  git(controller, 'add', '.');
  git(controller, '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'candidate');
  const source = git(controller, 'rev-parse', 'HEAD');
  git(dir, 'clone', '--quiet', '--no-checkout', controller, runner);
  git(runner, '-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', source);
  return { controller, runner, main, source, env, tree: git(controller, 'rev-parse', `${source}^{tree}`), dir };
}

/** An injected runner that counts every controller process it starts: one per runOnRunnerAsync call. */
function countingRunner(box) {
  const counts = { controllers: 0 };
  const runOnRunnerAsync = async (_root, shell, options) => {
    counts.controllers++;
    let bytes;
    try { bytes = execFileSync('/bin/sh', ['-c', shell], { cwd: box.runner, env: box.env, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { bytes = Buffer.concat([error.stdout ?? Buffer.alloc(0), error.stderr ?? Buffer.alloc(0)]); }
    writeFileSync(options.rawOutputPath, bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return { executionRunner: 'runner-1', executionSource: { commit: box.source, tree: box.tree }, rawOutputPath: options.rawOutputPath,
      privateCheck: { receipt: { requestSha256: options.privateCheck.sha256, sourceUnchanged: true,
        phases: { check: { offset: 0, length: bytes.length, code: 0, signal: null, timedOut: false, sha256 } } } } };
  };
  const lease = { runner: { host: 'runner-1', node: process.execPath }, source: { commit: box.source, tree: box.tree }, executionServices: { runners: { runOnRunnerAsync } } };
  return { counts, lease };
}

/** What the submit command does: four stages each read their part from one shared job. */
async function submitStages(box, runner, artifacts) {
  const request = { main: box.main, source: box.source, trunk: box.main, base: box.main, check: 'node --test test/a.test.js', criterion: 'c',
    composition: box.source, staticChecks: 'node bin/static-checks.js', config: { affectedTests: 'node packages/gate/src/io/run/tests.js', gate: 'npm test' },
    browserFreeChecks: true, readCutItems: () => [], perPart: true };
  let leases = 0;
  const read = sharedRemoteAnalysis(() => { leases++; return remoteSubmitAnalysis(box.controller, request, runner.lease, artifacts); });
  const settled = await Promise.allSettled(PARTS.map(part => read(part, new AbortController().signal)));
  return { settled, leases };
}

test('clause 1: the four analysis parts make one remoteSubmitAnalysis call, one lease and one runner controller instead of four [C7]', async t => {
  const box = fixture(t), artifacts = join(box.dir, 'artifacts');
  const before = countingRunner(box);
  for (const part of PARTS) await remoteSubmitAnalysis(box.controller, { main: box.main, source: box.source, trunk: box.main, base: box.main, check: 'x', criterion: 'c',
    composition: box.source, staticChecks: 'node bin/static-checks.js', config: { affectedTests: 'node packages/gate/src/io/run/tests.js' }, browserFreeChecks: true, readCutItems: () => [], parts: [part] }, before.lease, join(artifacts, 'old'));
  assert.equal(before.counts.controllers, 4, 'one controller per part, as before');
  const after = countingRunner(box);
  const { settled, leases } = await submitStages(box, after, join(artifacts, 'new'));
  assert.deepEqual(settled.map(row => row.status), ['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled']);
  assert.equal(leases, 1);
  assert.equal(after.counts.controllers, 1);
  assert.deepEqual(Object.keys(settled[0].value.outcomes), []);
  assert.deepEqual(settled[1].value.plan.proofFiles, ['test/a.test.js']);
});

test('clause 2: a red part refuses with its own code and message, unchanged, while the other parts stay green [C7]', async t => {
  const expected = { preflight: ['PLACEMENT_RED', /preflight is red/u], selection: ['SELECTION_RED', /selection is red/u],
    cells: ['CELLS_SUBMIT', /cells is red/u], static: ['GATE_RED', /static checks are red.*static is red/su] };
  for (const part of PARTS) {
    const box = fixture(t, [part]), runner = countingRunner(box);
    const { settled } = await submitStages(box, runner, join(box.dir, 'artifacts'));
    assert.equal(runner.counts.controllers, 1, `${part} red still used one controller`);
    settled.forEach((row, index) => {
      if (PARTS[index] === part) {
        assert.equal(row.status, 'rejected');
        assert.equal(row.reason.code, expected[part][0]);
        assert.match(row.reason.message, expected[part][1]);
        assert.equal(row.reason.name, 'Refused');
      } else assert.equal(row.status, 'fulfilled', `${PARTS[index]} stays green beside red ${part}`);
    });
  }
});
