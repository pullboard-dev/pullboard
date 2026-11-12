/** A queued submit's doctrine hold runs inside the runner's one analysis job, never on the coordinator [C7]. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { remoteSubmitAnalysis } from '../../../../src/io/submit/gate.js';
import { sharedRemoteAnalysis } from '../../../../src/io/submit/gate.js';
import { temporaryDirectory } from '../../../fixtures/board.js';
import { temporaryRepository } from '../../../fixtures/board/submit.js';
import { runFixtureGit } from '../../../fixtures/child.js';

const PARTS = ['preflight', 'selection', 'cells', 'static', 'doctrine'];
const RULES = [{ id: 'C9', text: 'no file over the cap', command: 'node packages/gate/src/io/file/size.js', count: 0, committed: 0, holds: true,
  state: 'holding', mode: 'ratchet', runs: 'submit', problems: [], broken: '' }];

/** A Git environment free of the caller's repository selectors and identity. */
function gitEnv() {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && !/^GIT_(CONFIG_GLOBAL|CONFIG_NOSYSTEM|AUTHOR_|COMMITTER_)/u.test(key)) delete env[key];
  return env;
}

/** A controller whose accepted main carries stub tooling, and a runner clone at the candidate; `red` makes the doctrine rise. */
function fixture(t, red = false) {
  const dir = temporaryDirectory('submit-doctrine-runner-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = gitEnv(), controller = temporaryRepository(t, 'submit-doctrine-runner-controller-'), runner = join(dir, 'runner');
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env });
  const put = (path, body) => { const file = join(controller, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, body); };
  git(controller, 'config', 'pullboard.trunk', 'refs/heads/main');
  put('package.json', '{"type":"module"}\n');
  put('packages/items/index.js', 'export function requirePlannedSource() {}\nexport function requireSubmitComposition() {}\n');
  put('packages/gate/index.js', `export function importsIn() {} export function commonJsIn() {} export function withImportParseCache() {}
export function foreignNodeOptions() { return false; }
export function submitGatePlan(root, config, options) { return { proofFiles: ['test/a.test.js'], check: options.check }; }
export async function submitGateAdmission() { return { browser: false, gui: false }; }
`);
  put('packages/landing/index.js', 'export function withMainCheckout() {}\n');
  put('bin/cells-submit-checks.js', 'export async function requireSubmitCells(root, main, source) { return { acceptedMain: main, source, cells: [], existingCuts: [] }; }\n');
  put('packages/codemap/src/io/cells/scripts/cache.js', 'export function transferredCellsInventories() { return null; }\n');
  put('bin/static-checks.js', '');
  // Main's doctrine module records where it ran, so the test can tell the runner checkout from the controller.
  put('packages/doctrine/index.js', `import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
export async function holdDoctrineAsync(root, options) {
  writeFileSync(join(root, '..', 'doctrine-ran.json'), JSON.stringify({ root, cwd: process.cwd(), options }));
  ${red ? "throw Object.assign(new Error('[RATCHET_ROSE] C9 no file over the cap rose to 1, was 0'), { name: 'Refused', code: 'RATCHET_ROSE', machineryRule: 'rule-identity' });" : ''}
  return ${JSON.stringify(RULES)};
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

/** An injected runner that runs each trusted step's shell in the runner clone and counts the controllers it starts. */
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

/** What a queued submit does: every stage, doctrine included, reads its part from one shared runner job. */
async function submitStages(box, runner) {
  const doctrine = { mainCommit: box.main, commit: box.source, practice: 'DOCTRINE.md', timeoutMs: 60000, fast: true };
  const request = { main: box.main, source: box.source, trunk: box.main, base: box.main, check: 'node --test test/a.test.js', criterion: 'c',
    composition: box.source, staticChecks: 'node bin/static-checks.js', config: { affectedTests: 'node apps/cli/src/io/run/tests.js', gate: 'npm test' },
    browserFreeChecks: true, readCutItems: () => [], perPart: true, doctrine };
  let leases = 0;
  const read = sharedRemoteAnalysis(() => { leases++; return remoteSubmitAnalysis(box.controller, request, runner.lease, join(box.dir, 'artifacts')); });
  const settled = await Promise.allSettled(PARTS.map(part => read(part, new AbortController().signal)));
  return { settled, leases, doctrine };
}

test('clause 1: the doctrine hold runs in the runner checkout inside the one analysis job, from main\'s tooling [C7]', async t => {
  const box = fixture(t), runner = countingRunner(box);
  const { settled, leases, doctrine } = await submitStages(box, runner);
  assert.deepEqual(settled.map(row => row.status), PARTS.map(() => 'fulfilled'));
  assert.equal(leases, 1, 'one lease for every part');
  assert.equal(runner.counts.controllers, 1, 'one runner controller for every part, doctrine included');
  const ran = JSON.parse(readFileSync(join(box.dir, 'doctrine-ran.json'), 'utf8'));
  assert.equal(realpathSync(ran.root), realpathSync(box.runner), 'the hold judged the runner checkout');
  assert.equal(realpathSync(ran.cwd), realpathSync(box.runner));
  assert.deepEqual(ran.options, doctrine, 'the hold got the pinned main, source and rules options unchanged');
  assert.deepEqual(settled[PARTS.indexOf('doctrine')].value.doctrine, RULES, 'the rule results come back as a local hold returns them');
});

test('clause 2: a doctrine that rose refuses RATCHET_ROSE with its message and machinery identity, other parts green [C7]', async t => {
  const box = fixture(t, true), runner = countingRunner(box);
  const { settled } = await submitStages(box, runner);
  assert.equal(runner.counts.controllers, 1);
  settled.forEach((row, index) => {
    if (PARTS[index] !== 'doctrine') { assert.equal(row.status, 'fulfilled', `${PARTS[index]} stays green beside a red doctrine`); return; }
    assert.equal(row.status, 'rejected');
    assert.equal(row.reason.name, 'Refused');
    assert.equal(row.reason.code, 'RATCHET_ROSE');
    assert.equal(row.reason.message, '[RATCHET_ROSE] C9 no file over the cap rose to 1, was 0');
    assert.equal(row.reason.machineryRule, 'rule-identity', 'the refusal trial keys on the same rule identity');
  });
});
