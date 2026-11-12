/** Flake diagnostics run after the red result and the lease release, and reuse the main comparison's outcome [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { fixtureCommittedGraph } from '../../tests/fixtures/testkit.js';
import { flakeSource } from '../../../../packages/flakes/index.js';
import { observeNativeFailure } from '../../../../packages/flakes/index.js';
import { startDiagnostics } from '../../../../packages/gate/index.js';

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
  const graph = fixtureCommittedGraph('pullboard-native-flakes-');
  t.after(() => rmSync(graph.root, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && key !== 'NODE_TEST_CONTEXT'));
  graph.put('test/three.test.mjs', THREE);
  const main = graph.commit();
  graph.put('README.md', 'candidate\n');
  return { root: graph.root, env, main, head: graph.commit() };
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

test('clause 1: a red gate writes its result and releases its lease before the injected diagnostic runs [C7]', async () => {
  const events = [];
  const context = { root: '/unused', command: 'x', lease: { proof: { kind: 'submit' } } };
  const onFailure = Object.assign(async () => { events.push('diagnostic'); }, { queue: async () => { events.push('queued'); } });
  /** The diagnostic's own slot opens only once the gate's lease is gone. */
  const withSlot = async (_root, action) => { events.push('acquire'); try { await action({}); } finally { events.push('release-diagnostic-lease'); } };
  events.push('gate-lease', 'gate-lease-released', 'result-written');
  const started = await startDiagnostics('/unused', onFailure, [[{ isGreen: false }, context]], {}, { withSlot });
  assert.deepEqual(events.slice(0, 3), ['gate-lease', 'gate-lease-released', 'result-written'], 'nothing diagnoses inside the gate lease');
  assert.equal(events[3], 'queued', 'the diagnostic is queued as a job first');
  await started.done;
  assert.deepEqual(events, ['gate-lease', 'gate-lease-released', 'result-written', 'queued', 'acquire', 'diagnostic', 'release-diagnostic-lease']);
});

test('clause 2: recorded main outcome, main probe runs zero times [C7]', async t => {
  const box = project(t);
  const pin = flakeSource(box.root, { main: box.main, privateCheck: true });
  const run = originalRun(box);
  const probes = [], batches = [], asked = [];
  const file = 'test/three.test.mjs';
  await observeNativeFailure({ root: box.root, config: { flakes: { rerun: true } }, pin, run, command: COMMAND, kind: 'check',
    checkAtCommit: recordingCheck(box, probes),
    cachedMain: path => { asked.push(path); return { result: 'red', failures: [{ file, name: 'flaky one' }, { file, name: 'stable red' }] }; },
    recordBatch: observations => { batches.push(observations); } });
  assert.deepEqual(asked, [file], 'the diagnostic asks the main comparison once for the file');
  assert.deepEqual(probes.map(probe => probe.role), ['candidate'], 'no main run happens');
  const outcomes = Object.fromEntries(batches[0].map(observation => [observation.name, observation.classification]));
  assert.deepEqual(outcomes, { 'flaky one': 'flake', 'stable red': 'stable-red', regression: 'possible-regression' });
});
