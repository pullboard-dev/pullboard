/** A new main that changes the fixture analyzer warms the shared fixture memo with one runner job; others start none [C7]. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { deserialize } from 'node:v8';
import { serialize } from 'node:v8';
import { gunzipSync } from 'node:zlib';
import { gzipSync } from 'node:zlib';
import { changesFixtureAnalyzer } from '../src/io/fixture-memo-warm.js';
import { warmFixtureMemo } from '../src/io/fixture-memo-warm.js';
import { absorbFixtureMemo } from '../src/io/memo.js';
import { fixtureCommittedGraph } from './fixtures/testkit.js';
import { privateFixtureFiles } from './fixtures/child.js';

const NAME = `${'c'.repeat(64)}.v8.gz`;

/** A memo carried as data, holding the given keys. */
function memo(keys) {
  const entries = new Map(keys.map(key => [key, { reads: [], result: serialize({ key }) }]));
  return { name: NAME, data: gzipSync(serialize({ version: 1, entries })).toString('base64') };
}

/** The keys of the memo stored under NAME. */
function storedKeys(directory) {
  return [...deserialize(gunzipSync(readFileSync(join(directory, NAME)))).entries.keys()].sort();
}

/** A private folder removed after the test. */
function folder(t, prefix) {
  const files = privateFixtureFiles(prefix);
  t.after(() => rmSync(files.root, { recursive: true, force: true }));
  return files.root;
}

/** A repository whose commits change, in turn, ordinary source, the cells plan and a fixture-analyzer module. */
function history(t) {
  const graph = fixtureCommittedGraph('fixture-memo-warm-');
  t.after(() => rmSync(graph.root, { recursive: true, force: true }));
  graph.put('README.md', 'start\n');
  graph.commit();
  graph.put('src/other.js', 'export const other = 1;\n');
  const ordinary = graph.commit();
  graph.put('packages/codemap/data/plan/cells.json', '{}\n');
  const planned = graph.commit();
  graph.put('packages/codemap/src/io/cells-move-fixtures.js', 'export const changed = 1;\n');
  const analyzer = graph.commit();
  return { root: graph.root, ordinary, planned, analyzer };
}

test('cli.fixture-memo-warm.only-a-main-that-changes-the-fixture: clause 1: only a main that changes the fixture analyzer closure needs a warm [C7]', t => {
  const repo = history(t);
  assert.equal(changesFixtureAnalyzer(repo.root, repo.ordinary), false);
  assert.equal(changesFixtureAnalyzer(repo.root, repo.planned), false, 'a plan-only change warms nothing');
  assert.equal(changesFixtureAnalyzer(repo.root, repo.analyzer), true);
});

test('cli.fixture-memo-warm.an-analyzer-change-runs-one-pinned-runner: clause 1: an analyzer change runs one pinned runner job and keeps its memo in the store; any other main runs none [C7]', async t => {
  const repo = history(t), store = folder(t, 'fixture-memo-warm-store-');
  absorbFixtureMemo(store, memo(['shared']));
  const slots = [], steps = [];
  const slot = async (root, action, options) => { slots.push(options); return action({ runner: { host: 'runner-1' } }); };
  const step = async (root, request) => { steps.push(request); return { value: { main: request.main, source: request.source, cells: 3, fixtureMemo: memo(['warmed']) } }; };
  const services = { executionServices: { runners: {}, landing: {} }, slot, step, store, registered: () => true };
  assert.deepEqual(await warmFixtureMemo(repo.root, repo.ordinary, services), { warmed: false, reason: 'fixture analyzer unchanged' });
  assert.equal(slots.length, 0);
  assert.deepEqual(await warmFixtureMemo(repo.root, repo.analyzer, services), { warmed: true, cells: 3 });
  assert.equal(slots.length, 1);
  assert.equal(slots[0].pinnedSource.commit, repo.analyzer);
  assert.equal(slots[0].runnerOnly, true);
  assert.equal(steps[0].main, repo.analyzer);
  assert.equal(steps[0].source, repo.analyzer);
  // The shared memos ride in the artifact frame, never in the request data (#4054).
  assert.equal('fixtureMemos' in steps[0].data, false);
  assert.ok(JSON.stringify(steps[0].data).length < 1024);
  assert.deepEqual(deserialize(steps[0].analysisArtifact.bytes).fixtureMemos.map(row => row.name), [NAME]);
  assert.deepEqual(storedKeys(store), ['shared', 'warmed']);
});

test('cli.fixture-memo-warm.a-warm-that-fails-or-finds-no: clause 2: a warm that fails or finds no runner leaves the shared store as it was [C7]', async t => {
  const repo = history(t), store = folder(t, 'fixture-memo-warm-kept-');
  absorbFixtureMemo(store, memo(['before']));
  const executionServices = { runners: {}, landing: {} };
  assert.deepEqual(await warmFixtureMemo(repo.root, repo.analyzer, { executionServices: { runners: { effectiveRunners: () => [] }, landing: {} }, store,
    slot: async () => assert.fail('no runner, no slot') }), { warmed: false, reason: 'no runner registered' }, 'a machine with no runner never waits for one');
  const failed = await warmFixtureMemo(repo.root, repo.analyzer, { executionServices, store, registered: () => true,
    slot: async (root, action) => action({}), step: async () => { throw new Error('runner step failed'); } });
  assert.equal(failed.warmed, false);
  assert.match(failed.reason, /runner step failed/u);
  const unplaced = await warmFixtureMemo(repo.root, repo.analyzer, { executionServices, store, registered: () => true,
    slot: async () => { throw Object.assign(new Error('no runner admitted'), { code: 'RUNNER_UNAVAILABLE' }); } });
  assert.equal(unplaced.warmed, false);
  assert.deepEqual(storedKeys(store), ['before']);
});

test('cli.io-fixture-memo-warm.no-plan-warm: clause 2: the warm reads no plan and warms no checkMoved memo [C7]', async t => {
  const repo = history(t), store = folder(t, 'fixture-memo-warm-noplan-');
  const steps = [];
  const slot = async (root, action) => action({ runner: { host: 'runner-1' } });
  const step = async (root, request) => { steps.push(request); return { value: { cells: 0 } }; };
  assert.deepEqual(await warmFixtureMemo(repo.root, repo.analyzer, { executionServices: { runners: {}, landing: {} }, slot, step, store, registered: () => true }), { warmed: true, cells: 0 });
  assert.equal(steps.length, 1);
  for (const word of ['readPlan', 'PLAN_FILE', 'PLAN_DIR', 'checkMoved', 'cellReadPathMap']) assert.equal(steps[0].entry.includes(word), false, `${word} is gone from the warm entry`);
  assert.deepEqual(await warmFixtureMemo(repo.root, repo.planned, { executionServices: { runners: {}, landing: {} }, slot, step, store, registered: () => true }),
    { warmed: false, reason: 'fixture analyzer unchanged' }, 'a plan-only main warms nothing');
  assert.equal(steps.length, 1);
});
