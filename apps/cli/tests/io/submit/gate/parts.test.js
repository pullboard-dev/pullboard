/** @pullboard-test-input apps/cli/src/io/commands/submit.js */
/** @pullboard-world-pin: clause 3 reads the shipped submit caller to prove it passes the tooling key. */
/** A rerun of the same candidate reads back the analysis parts already recorded for its main, source and tooling [C7]. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { remoteSubmitAnalysis } from '../../../../src/io/submit/gate.js';
import { policyRepository } from '../../../fixtures/board/submit.js';
import { privateFixtureFiles } from '../../../fixtures/child.js';
import { runFixtureGit } from '../../../fixtures/child.js';

const PARTS = ['preflight', 'static', 'selection'];
const RESULT = 'PULLBOARD_TRUSTED_RESULT ';

/** A runner transport that answers each admitted analysis part with a result bound to the commits the controller pinned. */
function countingRunner(box) {
  const admitted = [];
  const runOnRunnerAsync = async (_root, _shell, options) => {
    const part = box.nextPart;
    admitted.push(part);
    const value = { main: box.main, source: box.source, plan: { proofFiles: ['test/a.test.js'] }, admission: { browser: false, gui: false }, steps: { [part]: true },
      ...(box.refuse ? { outcomes: { [part]: { refused: { code: 'STATIC_RED', message: 'fixture refusal' } } } } : {}) };
    const bytes = Buffer.from(`${RESULT}${JSON.stringify(value)}\n`);
    writeFileSync(options.rawOutputPath, bytes);
    return { executionRunner: 'runner-1', executionSource: { commit: box.source, tree: box.tree }, rawOutputPath: options.rawOutputPath,
      privateCheck: { receipt: { requestSha256: options.privateCheck.sha256, sourceUnchanged: true,
        phases: { check: { offset: 0, length: bytes.length, code: 0, signal: null, timedOut: false, sha256: createHash('sha256').update(bytes).digest('hex') } } } } };
  };
  return { admitted, lease: { runner: { host: 'runner-1', node: process.execPath }, source: { commit: box.source, tree: box.tree },
    executionServices: { runners: { runOnRunnerAsync } } } };
}

/** The request one part sends: pinned commits and data only. */
function partRequest(box, part) {
  return { main: box.main, source: box.source, trunk: box.main, base: box.main, check: 'node --test test/a.test.js', criterion: 'fixture criterion',
    staticChecks: '', ...(box.tooling ? { tooling: box.tooling } : {}), config: { affectedTests: 'node apps/cli/src/io/run/tests.js' }, readCutItems: () => [{ item_id: 7 }], parts: [part] };
}

/** Run every analysis part for one attempt, as the submit gate does, and return the elapsed milliseconds and each result. */
async function attempt(box, runner, directory, root = box.root) {
  const started = performance.now();
  const results = [];
  for (const part of PARTS) {
    box.nextPart = part;
    results.push(await remoteSubmitAnalysis(root, partRequest(box, part), runner.lease, directory));
  }
  return { ms: performance.now() - started, results };
}

/**
 * Two commits of a private repo stand in for the pinned main and the candidate source. The repo records its own
 * pullboard.trunk, so the private-check trunk never depends on the checkout the test runs in (#5810).
 */
function commits() {
  const root = policyRepository(privateFixtureFiles('pullboard-rerun-repo-').root);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'F', GIT_AUTHOR_EMAIL: 'f@example.invalid', GIT_COMMITTER_NAME: 'F', GIT_COMMITTER_EMAIL: 'f@example.invalid' };
  const git = (...args) => runFixtureGit(args, { cwd: root, env });
  git('config', 'pullboard.trunk', 'refs/heads/main');
  writeFileSync(join(root, 'a.txt'), 'two\n');
  git('add', '.'); git('-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'two');
  const source = git('rev-parse', 'HEAD');
  const older = git('rev-parse', 'HEAD~1');
  return { root, source, older, tree: git('rev-parse', `${source}^{tree}`), treeOf: commit => git('rev-parse', `${commit}^{tree}`) };
}

test('clause 1: a rerun with the same main, source and tooling admits no analysis part and returns the same results [C7]', async () => {
  const files = privateFixtureFiles('pullboard-rerun-parts-');
  const { root, source, tree } = commits();
  const box = { root, main: source, source, tree, nextPart: '' };
  const runner = countingRunner(box);
  const first = await attempt(box, runner, files.root);
  assert.deepEqual(runner.admitted, PARTS, 'the first run admits every part');
  const second = await attempt(box, runner, files.root);
  assert.deepEqual(runner.admitted, PARTS, 'the rerun admitted no part');
  assert.deepEqual(second.results.map(row => row.steps), first.results.map(row => row.steps));
  assert.deepEqual(second.results.map(row => row.plan), first.results.map(row => row.plan));
  assert.deepEqual(readdirSync(join(files.root, 'results')).length, PARTS.length, 'one recorded result per part');
  process.stderr.write(`stage seconds: first run ${(first.ms / 1000).toFixed(3)}s, rerun ${(second.ms / 1000).toFixed(3)}s\n`);
});

test('clause 2: a change in the main commit runs every part fresh [C7]', async () => {
  const files = privateFixtureFiles('pullboard-rerun-parts-');
  const { root, source, older, tree } = commits();
  const box = { root, main: source, source, tree, nextPart: '' };
  const runner = countingRunner(box);
  await attempt(box, runner, files.root);
  box.main = older;
  await attempt(box, runner, files.root);
  assert.deepEqual(runner.admitted, [...PARTS, ...PARTS], 'a new main admits every part again');
});

test('clause 2: a change in the source commit runs every part fresh [C7]', async () => {
  const files = privateFixtureFiles('pullboard-rerun-parts-');
  const { root, source, older, tree, treeOf } = commits();
  const box = { root, main: source, source, tree, nextPart: '' };
  const runner = countingRunner(box);
  await attempt(box, runner, files.root);
  box.source = older;
  box.tree = treeOf(older);
  runner.lease.source = { commit: older, tree: box.tree };
  await attempt(box, runner, files.root);
  assert.deepEqual(runner.admitted, [...PARTS, ...PARTS], 'a new source admits every part again');
});

test('clause 2: a change in the board cut rows runs the part fresh [C7]', async () => {
  const files = privateFixtureFiles('pullboard-rerun-parts-');
  const { root, source, tree } = commits();
  const box = { root, main: source, source, tree, nextPart: '' };
  const runner = countingRunner(box);
  await attempt(box, runner, files.root);
  box.nextPart = 'static';
  await remoteSubmitAnalysis(root, { ...partRequest(box, 'static'), readCutItems: () => [{ item_id: 8 }] }, runner.lease, files.root);
  assert.deepEqual(runner.admitted, [...PARTS, 'static']);
});

test('clause 2: a change in the tooling id runs every part fresh [C7]', async () => {
  const files = privateFixtureFiles('pullboard-rerun-parts-');
  const { root, source, tree } = commits();
  const box = { root, main: source, source, tree, nextPart: '' };
  const runner = countingRunner(box);
  await attempt(box, runner, files.root);
  box.tooling = 'pullboard-handoff-tools-other';
  await attempt(box, runner, files.root);
  assert.deepEqual(runner.admitted, [...PARTS, ...PARTS], 'new tooling admits every part again');
});

test('clause 2: a part that refused is never recorded, so its rerun runs fresh [C7]', async () => {
  const files = privateFixtureFiles('pullboard-rerun-parts-');
  const { root, source, tree } = commits();
  const box = { root, main: source, source, tree, nextPart: 'static', refuse: true };
  const runner = countingRunner(box);
  const request = { ...partRequest(box, 'static'), perPart: true };
  const first = await remoteSubmitAnalysis(root, request, runner.lease, files.root);
  assert.equal(first.outcomes.static.refused.code, 'STATIC_RED', 'the per-part job returns the refusal as its outcome');
  box.refuse = false;
  const second = await remoteSubmitAnalysis(root, request, runner.lease, files.root);
  assert.deepEqual(runner.admitted, ['static', 'static'], 'the refused part is admitted again');
  assert.equal(second.reused, undefined, 'the rerun is a fresh result, not a reused refusal');
});

test('the production submit caller passes the pinned tooling key to the analysis request, so a changed tooling tree runs every part fresh [C7]', () => {
  const caller = readFileSync(new URL('../../../../src/io/commands/submit.js', import.meta.url), 'utf8');
  const start = caller.indexOf('remoteSubmitAnalysis(gateRoot, {');
  assert.ok(start > 0, 'the submit caller still calls remoteSubmitAnalysis');
  const request = caller.slice(start, caller.indexOf('ctx.submitHandoffOutput', start));
  assert.match(request, /\.\.\.submitTooling\(root, commit\)/u, 'the request carries the tools snapshot key from submitTooling');
});
