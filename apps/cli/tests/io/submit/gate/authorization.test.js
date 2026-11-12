/** A queued submit's authorization source check runs in the same one runner job as doctrine and test selection [C7,#5674]. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { remoteSubmitAnalysis } from '../../../../src/io/submit/gate.js';
import { remoteGateWanted } from '../../../../src/io/submit/gate.js';
import { sharedRemoteAnalysis } from '../../../../src/io/submit/gate.js';
import { temporaryDirectory } from '../../../fixtures/board.js';
import { temporaryRepository } from '../../../fixtures/board/submit.js';
import { runFixtureGit } from '../../../fixtures/child.js';

const PARTS = ['authorization', 'doctrine', 'selection'];

/** A Git environment free of the caller's repository selectors and identity. */
function gitEnv() {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && !/^GIT_(CONFIG_GLOBAL|CONFIG_NOSYSTEM|AUTHOR_|COMMITTER_)/u.test(key)) delete env[key];
  return env;
}

/**
 * A controller whose accepted main carries stand-in tooling, and a runner clone at the candidate. Each stand-in writes
 * a marker into the runner checkout's .git, so the test sees which process ran each stage. `sandbox` is the main's
 * sandbox module: 'owned', 'foreign' (an OUTSIDE_LANE refusal) or 'absent' (a main that predates the export).
 */
function fixture(t, { sandbox = 'owned' } = {}) {
  const dir = temporaryDirectory('submit-authorization-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = gitEnv(), controller = temporaryRepository(t, 'submit-authorization-controller-'), runner = join(dir, 'runner');
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env });
  const put = (path, body) => { const file = join(controller, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, body); };
  const mark = name => `(await import('node:fs')).writeFileSync(root + '/.git/ran-' + ${JSON.stringify(name)}, String(process.pid));`;
  git(controller, 'config', 'pullboard.trunk', 'refs/heads/main');
  put('package.json', '{"type":"module"}\n');
  put('packages/items/index.js', 'export function requirePlannedSource() {}\nexport function requireSubmitComposition() {}\n');
  put('packages/gate/index.js', `export function importsIn() {} export function commonJsIn() {} export function withImportParseCache() {}
export function foreignNodeOptions() { return false; }
export async function submitGatePlan(root, config, options) { ${mark('selection')} return { proofFiles: ['test/a.test.js'], check: options.check }; }
export async function submitGateAdmission() { return { browser: false, gui: false }; }
`);
  put('packages/landing/index.js', 'export function withMainCheckout() {}\n');
  put('bin/cells-submit-checks.js', 'export async function requireSubmitCells(root, main, source) { return { acceptedMain: main, source, cells: [], existingCuts: [] }; }\n');
  put('packages/codemap/src/io/cells/scripts/cache.js', 'export function transferredCellsInventories() { return null; }\n');
  put('packages/doctrine/index.js', `export async function holdDoctrineAsync(root, options) { ${mark('doctrine')} return [{ rule: 'fixture', commit: options.commit }]; }\n`);
  const outcome = sandbox === 'foreign'
    ? "throw Object.assign(new Error('[OUTSIDE_LANE] outside the web lane: docs/x.md'), { name: 'Refused', code: 'OUTSIDE_LANE', paths: ['docs/x.md'], policy: 'p' });"
    : "onMechanicalPaths(['packages/moved.js']); return ['src/thing.js'];";
  if (sandbox !== 'absent') put('packages/sandbox/index.js', `import { writeFileSync } from 'node:fs';
export function submissionPaths(root, item, commit, { onMechanicalPaths }) {
  writeFileSync(root + '/.git/ran-authorization', JSON.stringify({ pid: process.pid, item: item.item_id, lane: item.item_lane, commit }));
  ${outcome}
}
`);
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

/** An injected runner transport that runs each request in the runner clone and counts the runner jobs it starts. */
function countingRunner(box) {
  const counts = { jobs: 0 };
  const runOnRunnerAsync = async (_root, shell, options) => {
    counts.jobs++;
    let bytes;
    try { bytes = execFileSync('/bin/sh', ['-c', shell], { cwd: box.runner, env: box.env, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { bytes = Buffer.concat([error.stdout ?? Buffer.alloc(0), error.stderr ?? Buffer.alloc(0)]); }
    writeFileSync(options.rawOutputPath, bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return { executionRunner: 'runner-1', executionSource: { commit: box.source, tree: box.tree }, rawOutputPath: options.rawOutputPath,
      privateCheck: { receipt: { requestSha256: options.privateCheck.sha256, sourceUnchanged: true,
        phases: { check: { offset: 0, length: bytes.length, code: 0, signal: null, timedOut: false, sha256 } } } } };
  };
  return { counts, lease: { runner: { host: 'runner-1', node: process.execPath }, source: { commit: box.source, tree: box.tree }, executionServices: { runners: { runOnRunnerAsync } } } };
}

/** The submit gate's request: authorization, doctrine and selection read from one shared job, as submit.js asks for them. */
async function submitStages(box, runner) {
  const item = { item_id: 5674, item_lane: 'core', item_claim_head: box.main, item_frozen: null };
  const request = { main: box.main, source: box.source, trunk: box.main, base: box.main, check: 'node --test test/a.test.js', criterion: 'c',
    composition: null, staticChecks: '', config: { affectedTests: 'node apps/cli/src/io/run/tests.js' }, browserFreeChecks: true, readCutItems: () => [], perPart: true,
    doctrine: { mainCommit: box.main, commit: box.source, practice: {}, timeoutMs: 1000 }, authorization: { item } };
  const read = sharedRemoteAnalysis(() => remoteSubmitAnalysis(box.controller, request, runner.lease, join(box.dir, 'artifacts')));
  return Promise.allSettled(PARTS.map(part => read(part, new AbortController().signal)));
}

/** The marker a runner-side stage left in the runner checkout, or null when that stage never ran there. */
function ran(box, name) {
  try { return readFileSync(join(box.runner, '.git', `ran-${name}`), 'utf8'); } catch { return null; }
}

test('clause 1: authorization, doctrine and selection run inside one runner job and the controller receives each artifact [C7,#5674]', async t => {
  const box = fixture(t), runner = countingRunner(box);
  const settled = await submitStages(box, runner);
  assert.deepEqual(settled.map(row => row.status), ['fulfilled', 'fulfilled', 'fulfilled']);
  assert.equal(runner.counts.jobs, 1, 'one runner job carries every stage');
  const analysis = settled[0].value;
  assert.deepEqual(analysis.authorization, { paths: ['src/thing.js'], mechanical: ['packages/moved.js'], ownership: null });
  assert.deepEqual(analysis.doctrine, [{ rule: 'fixture', commit: box.source }]);
  assert.deepEqual(analysis.plan.proofFiles, ['test/a.test.js']);
  for (const stage of PARTS) assert.ok(Number.isInteger(analysis.steps[stage]), `${stage} carries its runner milliseconds`);
  const authorized = JSON.parse(ran(box, 'authorization'));
  assert.deepEqual([authorized.item, authorized.lane, authorized.commit], [5674, 'core', box.source], 'the runner checked the pinned candidate for the frozen item');
  assert.notEqual(Number(authorized.pid), process.pid, 'the lane check ran in the runner job, not in this controller');
  assert.ok(ran(box, 'doctrine') && ran(box, 'selection'), 'doctrine and selection ran in the runner job too');
});

test('clause 1: a lane refusal comes back as data for the controller to route after proof, never as a runner red [C7,#5674]', async t => {
  const box = fixture(t, { sandbox: 'foreign' }), runner = countingRunner(box);
  const settled = await submitStages(box, runner);
  assert.deepEqual(settled.map(row => row.status), ['fulfilled', 'fulfilled', 'fulfilled']);
  assert.deepEqual(settled[0].value.authorization, { mechanical: [], ownership: { message: 'outside the web lane: docs/x.md', paths: ['docs/x.md'], policy: 'p' } });
});

test('clause 1: an accepted main without the sandbox check reports it skipped, so the controller checks it at home [C7,#5674]', async t => {
  const box = fixture(t, { sandbox: 'absent' }), runner = countingRunner(box);
  const settled = await submitStages(box, runner);
  assert.equal(settled[0].status, 'fulfilled');
  assert.match(settled[0].value.authorization.skipped, /lacks submissionPaths/u);
  assert.equal(ran(box, 'authorization'), null);
});

test('clause 2: with no runner registered and runners-only off, the queued submit analyses on this machine as today [C7,#5674]', () => {
  assert.equal(remoteGateWanted({}, { runners: [] }), false, 'no runner: every stage stays local');
  assert.equal(remoteGateWanted({}, { runners: [{ host: 'r', slots: 2, browser: 1 }] }), true, 'a registered runner takes the one analysis job');
});
