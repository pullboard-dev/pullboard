/** A landing gate executes its merged batch's selected test files, not the full project gate [C7,S10]. */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createE2eHelpers } from './e2e-helpers.js';
import { runFixtureChild } from './fixture-child.js';
import { batchGatePlan } from '../packages/landing/src/shell/landing-step-gate.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** Build a real committed test graph and run the actual planned command against a recording runner. */
function plannedFiles(changed, { tiers = false, proof = null, mandatory = [], stale = false, full = false, moved = false } = {}) {
  const box = e2e.project('true', e2e.sandbox(), { withWorktree: false });
  const packageFile = join(box.repo, 'package.json');
  const packageData = existsSync(packageFile) ? JSON.parse(readFileSync(packageFile, 'utf8')) : {};
  writeFileSync(packageFile, JSON.stringify({ ...packageData, type: 'module' }));
  const dir = join(box.repo, 'test');
  mkdirSync(dir, { recursive: true });
  for (const name of ['a', 'b', 'unrelated']) writeFileSync(join(dir, `${name}.test.js`), `import { test } from 'node:test';\ntest('${name}', () => {});\n`);
  if (tiers) {
    mkdirSync(join(box.repo, 'packages', 'gate'), { recursive: true });
    writeFileSync(join(box.repo, 'packages', 'gate', 'test-tiers.json'), JSON.stringify({ version: 1, files: [] }));
  }
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: add fixture tests');
  const base = box.git(box.repo, 'rev-parse', 'HEAD');
  for (const name of changed) writeFileSync(join(dir, `${name}.test.js`), `import { test } from 'node:test';\ntest('${name} fixed', () => {});\n`);
  if (moved) {
    mkdirSync(join(box.repo, 'packages', 'example', 'tests'), { recursive: true });
    renameSync(join(dir, 'a.test.js'), join(box.repo, 'packages', 'example', 'tests', 'a.test.js'));
    mkdirSync(join(box.repo, 'bin', 'cells-plan', 'path-map'), { recursive: true });
    writeFileSync(join(box.repo, 'bin', 'cells-plan', 'path-map', 'example.json'), JSON.stringify({ 'test/a.test.js': 'packages/example/tests/a.test.js' }));
  }
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: fix selected tests');
  const runner = join(box.dir, 'record-runner.cjs');
  const calls = join(box.dir, 'calls.json');
  writeFileSync(runner, `require('node:fs').writeFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)));\n`);
  const commit = box.git(box.repo, 'rev-parse', 'HEAD');
  const state = { batch: { root: box.repo, base, items: proof === null ? [] : [{ id: 1, commit }] }, board: {}, config: {
    gate: 'exit 91', affectedTests: `node ${JSON.stringify(runner)}`, submitInvariants: mandatory, registryGuards: [], landing: { perItem: false },
  } };
  const frozen = JSON.stringify({ check: 'node --test test/a.test.js' });
  const digest = createHash('sha256').update(frozen).digest('hex');
  const readEvents = () => [{ event_kind: 'submit', event_detail: JSON.stringify({ commit: stale ? base : commit, criterionDigest: digest, gateGreen: true, submissionProof: { files: proof, full, deferredFiles: ['test/b.test.js'] } }) }];
  const readItem = () => ({ item_commit: commit, item_frozen: frozen, item_frozen_digest: digest });
  const plan = batchGatePlan(state, { readEvents, readItem });
  const run = runFixtureChild('/bin/sh', ['-c', plan.config.gate], { cwd: box.repo, env: box.env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return { plan, files: JSON.parse(readFileSync(calls, 'utf8')).map(file => file.replace(/^\.\//u, '')) };
}

test('a merged batch runs the union of its affected tests without the full gate [C7,S10]', () => {
  const { plan, files } = plannedFiles(['a', 'b']);
  assert.deepEqual(files, ['test/a.test.js', 'test/b.test.js']);
  assert.deepEqual(plan.files, files);
});

test('a one-file test fix runs only that file [C7,S10]', () => {
  const { files } = plannedFiles(['a']);
  assert.deepEqual(files, ['test/a.test.js']);
});

test('a tiered batch runs its affected journey without unrelated journeys [C7,S10]', () => {
  const { plan, files } = plannedFiles(['a'], { tiers: true });
  assert.deepEqual(files, ['test/a.test.js']);
  assert.deepEqual(plan.files, files);
});

test('tiered landing uses the sealed submit union and retains explicit mandatory guards [C7,S10]', () => {
  const { files } = plannedFiles(['a', 'b'], { tiers: true, proof: ['test/a.test.js'], mandatory: ['test/unrelated.test.js'] });
  assert.deepEqual(files, ['test/a.test.js', 'test/unrelated.test.js'], 'reachable and deferred b does not expand the sealed union');
});

test('a named frozen check runs even when the submit proof has no remaining files [C7,S10]', () => {
  const { files } = plannedFiles(['a', 'b'], { tiers: true, proof: [] });
  assert.deepEqual(files, ['test/a.test.js']);
});

test('the frozen criterion and submission proof contribute their complete file union [C7,S10]', () => {
  const { files } = plannedFiles(['a', 'b'], { tiers: true, proof: ['test/b.test.js'] });
  assert.deepEqual(files, ['test/a.test.js', 'test/b.test.js']);
});

test('a stale submission neither narrows nor stops landing: the merged change selects its tests [C7,S10,#2897]', () => {
  const { files } = plannedFiles(['a', 'b'], { tiers: true, proof: [], stale: true });
  assert.deepEqual(files, ['test/a.test.js', 'test/b.test.js']);
});

test('a full fallback proof does not stop landing: the merged change selects its tests [C7,S10,#2897]', () => {
  const { files } = plannedFiles(['a', 'b'], { proof: ['test/a.test.js'], full: true });
  assert.deepEqual(files, ['test/a.test.js', 'test/b.test.js']);
});

test('a frozen moved test resolves through the submitted source map [C7,S10]', () => {
  const { files } = plannedFiles(['a'], { proof: [], moved: true });
  assert.deepEqual(files, ['packages/example/tests/a.test.js']);
});
