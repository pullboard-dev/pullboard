/** Failure classification probes a file's failing cases together and records each case's own outcome [C7,H16]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runFixtureChild } from '../../../gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../../gate/tests/fixtures/child.js';
import { flakeSource } from '../../index.js';
import { observeNativeFailure } from '../../index.js';

const COMMAND = 'node --test --test-reporter=tap test/three.test.mjs';

/** Three cases in one file whose results depend on which probe runs them, so each case classifies differently. */
const THREE = `import assert from 'node:assert/strict';
import { test } from 'node:test';
test('flaky one', () => { assert.equal(process.env.PROBE_ROLE, 'candidate'); });
test('stable red', () => { assert.fail('always red'); });
test('regression', () => { assert.equal(process.env.PROBE_ROLE, 'main'); });
test('passes everywhere', () => {});
`;

/** A real Git repository with a main commit and a candidate commit, both holding the three-case file. */
function project(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-native-flakes-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && key !== 'NODE_TEST_CONTEXT'));
  const git = (...args) => runFixtureGit(args, { cwd: root, env });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Fixture');
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, 'test/three.test.mjs'), THREE);
  git('add', '.');
  git('commit', '-q', '-m', 'main');
  const main = git('rev-parse', 'HEAD');
  writeFileSync(join(root, 'README.md'), 'candidate\n');
  git('add', '.');
  git('commit', '-q', '-m', 'candidate');
  return { root, env, main, head: git('rev-parse', 'HEAD') };
}

/** Run a probe for real in the fixture, telling its cases whether they run as the candidate or as main. */
function recordingCheck(box, probes) {
  return (root, item) => {
    const { check } = JSON.parse(item.item_frozen);
    const role = item.item_commit === box.main ? 'main' : 'candidate';
    probes.push({ role, check });
    const result = runFixtureChild('/bin/sh', ['-c', check], { cwd: root, encoding: 'utf8', env: { ...box.env, PROBE_ROLE: role } });
    const outputPath = join(root, `.git/probe-${probes.length}.log`);
    writeFileSync(outputPath, result.stdout + result.stderr);
    return { state: result.status === 0 ? 'pass' : 'fail', outputPath, executionRoot: root };
  };
}

/** The original red run, with no probe role, fails all three selected cases. */
function originalRun(box) {
  const result = runFixtureChild('/bin/sh', ['-c', COMMAND], { cwd: box.root, encoding: 'utf8', env: box.env });
  assert.equal(result.status, 1, 'the original run is really red');
  return { isGreen: false, output: result.stdout + result.stderr };
}

test('flakes.native.one-probe-per-file: three failures in one file produce one candidate probe, one main probe and three recorded outcomes [C7,H16]', async t => {
  const box = project(t);
  const pin = flakeSource(box.root, { main: box.main, privateCheck: true });
  const run = originalRun(box);
  const probes = [], batches = [];
  await observeNativeFailure({ root: box.root, config: { flakes: { rerun: true } }, pin, run, command: COMMAND, kind: 'check',
    checkAtCommit: recordingCheck(box, probes),
    record: () => { throw new Error('a batch-capable caller records once, not per case'); },
    recordBatch: observations => { batches.push(observations); } });
  assert.deepEqual(probes.map(probe => probe.role), ['candidate', 'main'], 'one candidate and one main probe for the whole file');
  for (const probe of probes) {
    for (const name of ['flaky one', 'stable red', 'regression']) assert.ok(probe.check.includes(name), `${probe.role} selects ${name}`);
    assert.doesNotMatch(probe.check, /passes everywhere/u, 'a passing case is never re-probed');
  }
  assert.equal(batches.length, 1, 'the board facts are written in one batch');
  const outcomes = Object.fromEntries(batches[0].map(observation => [observation.name, observation.classification]));
  assert.deepEqual(outcomes, { 'flaky one': 'flake', 'stable red': 'stable-red', regression: 'possible-regression' });
  const ids = new Set(batches[0].map(observation => observation.id));
  assert.equal(ids.size, 3, 'each case keeps its own evidence identity');
  for (const observation of batches[0]) {
    assert.equal(observation.file, 'test/three.test.mjs');
    assert.ok(observation.paired && observation.mainReceipt, `${observation.name} keeps its own paired and main receipts`);
    const kept = JSON.parse(readFileSync(join(box.root, '.git/pullboard/flake-evidence', observation.id, 'observation.json'), 'utf8'));
    assert.equal(kept.classification, observation.classification, 'the retained evidence matches what was recorded');
  }
  assert.equal(run.isGreen, false, 'diagnostics never replace the original red');
  assert.deepEqual(run.flakeDiagnostics.observations.map(row => row.recorded), [true, true, true]);
});

test('flakes.native.records-once-without-writer: without a batch writer each case is still recorded once, after every probe has run [C7,H16]', async t => {
  const box = project(t);
  const pin = flakeSource(box.root, { main: box.main, privateCheck: true });
  const run = originalRun(box);
  const probes = [], recorded = [];
  await observeNativeFailure({ root: box.root, config: { flakes: { rerun: true } }, pin, run, command: COMMAND, kind: 'check',
    checkAtCommit: recordingCheck(box, probes),
    record: observation => { recorded.push({ name: observation.name, probesSoFar: probes.length }); } });
  assert.equal(probes.length, 2);
  assert.deepEqual(recorded.map(row => row.name), ['flaky one', 'stable red', 'regression']);
  assert.ok(recorded.every(row => row.probesSoFar === 2), 'no case is recorded between probes');
});

test('flakes.native.crashed-batch-proves-none: a batch probe that crashes after some cases ran proves none of them [C7,H16]', async t => {
  const box = project(t);
  const pin = flakeSource(box.root, { main: box.main, privateCheck: true });
  const run = originalRun(box);
  const batches = [];
  const crashing = (root, item) => {
    const outputPath = join(root, '.git/crashed.log');
    writeFileSync(outputPath, 'TAP version 13\nok 1 - flaky one\n');
    return { state: item.item_commit === box.main ? 'fail' : 'fail', outputPath, executionRoot: root };
  };
  await observeNativeFailure({ root: box.root, config: { flakes: { rerun: true } }, pin, run, command: COMMAND, kind: 'check',
    checkAtCommit: crashing, recordBatch: observations => { batches.push(observations); } });
  assert.ok(batches[0].every(observation => observation.classification === 'unclassified'), 'a partial batch receipt classifies nothing');
});
