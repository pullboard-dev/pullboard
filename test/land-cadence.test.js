/** Opt-in landing cadence uses real acceptances and an injected observation clock [E30,E10,E29]. */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import * as store from '../src/board.js';
import { configFromSource } from '../src/config.js';
import { cadenceDeferral, landingCadenceStatus } from '../src/landing-cadence.js';
import { acceptedVerdict } from '../src/verdict-reviews.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { json, onBoard } from './land-board-fixture.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const EVERY = 600_000;

/** Commit only fixture-owned source through the ordinary installed hooks. */
function commit(box, root, message) {
  box.git(root, 'add', '-A');
  box.git(root, 'commit', '-q', '-m', message);
  return box.git(root, 'rev-parse', 'HEAD');
}

/** Prepare a real small full gate and private bare remote, without changing machine admission or clocks. */
function project() {
  const box = e2e.project('node --test --test-reporter=tap web/check.test.js');
  delete box.env.NODE_TEST_CONTEXT;
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'web/check.test.js'), "import { test } from 'node:test';\ntest('the fixture gate passes', () => {});\n");
  commit(box, box.repo, 'test: prepare native cadence gate [G1]');
  box.remote = join(box.dir, 'origin.git');
  box.git(box.dir, 'init', '-q', '--bare', box.remote);
  box.git(box.repo, 'remote', 'add', 'origin', box.remote);
  box.git(box.repo, 'push', '-q', '-u', 'origin', 'main');
  return box;
}

/** Change accepted trunk policy before any item is claimed, preserving the same public configuration path. */
function configure(box, cadence) {
  const path = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...config, landing: { cadence } }, null, 2));
  commit(box, box.repo, 'chore: opt into queue landing cadence');
}

/** Produce a genuinely submitted and independently accepted item; the fixture never edits verdict records. */
function accepted(box, name) {
  const root = join(box.dir, name);
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', root, 'main');
  json(box, root, 'join', 'web');
  const file = `web/${name}.txt`;
  const id = json(box, box.repo, 'add', 'web', name, '--specs', 'G1', '--criterion', `${name} exists`, '--check', `test -f ${file}`).item.item_id;
  json(box, root, 'claim', String(id));
  writeFileSync(join(root, file), name + '\n');
  const head = commit(box, root, 'feat(web): supply cadence fixture [G1]');
  json(box, root, 'submit', String(id));
  box.git(box.repo, 'switch', '-q', '--detach', head);
  try { json(box, box.repo, 'verify', String(id), 'accept', '--as', 'coordinator', '--note', 'The actual frozen file existence check passed.'); }
  finally { box.git(box.repo, 'switch', '-q', 'main'); }
  return id;
}

/** Exercise both threshold edges against native verdict times while advancing only the board's injected read clock. */
function assertThresholds(box) {
  onBoard(box, board => {
    const times = store.listItems(board, { all: true }).map(item => acceptedVerdict(board, item))
      .filter(Boolean).map(row => Date.parse(row.verdict_at));
    const first = Math.min(...times);
    const latest = Math.max(...times);
    assert.equal(landingCadenceStatus(board, configFromSource('{}')).due, false, 'even accepted waiting work does not enable the default-off policy');
    const agePolicy = configFromSource(JSON.stringify({ landing: { cadence: { every: '10m', accepted: 3 } } }));
    board.clock = { now: () => new Date(first + EVERY - 1) };
    assert.equal(landingCadenceStatus(board, agePolicy).due, false, 'one millisecond before the age boundary and below count');
    board.clock = { now: () => new Date(first + EVERY) };
    assert.equal(landingCadenceStatus(board, agePolicy).due, true, 'exactly at the oldest acceptance boundary');
    board.clock = { now: () => new Date(latest) };
    const countPolicy = configFromSource(JSON.stringify({ landing: { cadence: { every: '10m', accepted: 2 } } }));
    assert.equal(landingCadenceStatus(board, countPolicy).due, true, 'exactly at count, without waiting for age');
    assert.equal(landingCadenceStatus(board, agePolicy).due, false, 'one item below the configured count');
    const duration = configFromSource(JSON.stringify({ landing: { cadence: '10m' } }));
    assert.equal(landingCadenceStatus(board, duration).due, false);
    board.clock = { now: () => new Date(first + EVERY) };
    assert.equal(landingCadenceStatus(board, duration).due, true, 'duration form also supplies the due age');
  });
}

/** Existing duration-only manual landing keeps its start-to-start cooldown at both exact clock boundaries. */
function assertLegacyCooldown(box) {
  onBoard(box, board => {
    const start = Date.parse(store.landingBatches(board).at(-1).startedAt);
    const policy = configFromSource(JSON.stringify({ landing: { cadence: '10m' } }));
    board.clock = { now: () => new Date(start + EVERY - 1) };
    assert.ok(cadenceDeferral(board, policy, 'main', () => {}).deferredUntil);
    board.clock = { now: () => new Date(start + EVERY) };
    assert.equal(cadenceDeferral(board, policy, 'main', () => {}), null);
    board.clock = { now: () => new Date(start) };
    const object = configFromSource(JSON.stringify({ landing: { cadence: { every: '10m', accepted: 2 } } }));
    assert.equal(cadenceDeferral(board, object, 'main', () => {}), null, 'object policy creates no legacy cooldown that cancels its count trigger');
  });
}

test('landing cadence is opt-in and validates both compatible policy forms [E30,E29]', () => {
  assert.equal(configFromSource('{}').landing?.cadence, undefined);
  assert.equal(configFromSource('{"landing":{"cadence":"10m"}}').landing.cadenceMs, EVERY);
  assert.equal(configFromSource('{"landing":{"cadence":{"every":"10m","accepted":5}}}').landing.cadenceMs, EVERY);
  for (const cadence of [{ every: '0m', accepted: 5 }, { every: '10m', accepted: 0 }, { every: '10m', accepted: 1.5 },
    { every: '10m' }, { every: '10m', accepted: 5, extra: true }, [], null]) {
    assert.throws(() => configFromSource(JSON.stringify({ landing: { cadence } })), /BAD_CONFIG/u);
  }
});

test('land runs on cadence at either injected-clock boundary and lands all waiting acceptances [E30,E10,E29]', { timeout: 120_000 }, // budget: two private real submit/accept cycles and one full landing; hang ceiling, not speed.
() => {
  const box = project();
  const off = json(box, box.repo, 'land', '--due');
  assert.equal(off.cadence.enabled, false);
  assert.equal(off.batch, null, 'default off is a real no-op');
  configure(box, { every: '10m', accepted: 2 });
  const first = accepted(box, 'first');
  const base = box.git(box.repo, 'rev-parse', 'main');
  const waiting = box.run(box.repo, 'land', '--due', '--json');
  assert.equal(waiting.code, 0, waiting.err + waiting.out);
  assert.equal(JSON.parse(waiting.out).batch, null);
  assert.match(waiting.err + waiting.out, /count 1\/2/u);
  assert.match(waiting.err + waiting.out, /oldest wait .*\/600000ms/u);
  assert.equal(box.git(box.repo, 'rev-parse', 'main'), base);
  const second = accepted(box, 'second');
  assertThresholds(box);
  const landed = json(box, box.repo, 'land', '--due');
  assert.deepEqual(landed.landed, [first, second], 'default due landing keeps native acceptance order and takes every waiting item');
  assert.equal(landed.batch.state, 'landed');
  assert.equal(box.git(box.repo, 'rev-parse', 'main'), landed.batch.tip);
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), landed.batch.tip);
  for (const id of [first, second]) assert.ok(json(box, box.repo, 'show', String(id)).item_merged_commit);
  assertLegacyCooldown(box);
  const recorded = onBoard(box, board => ({ batches: store.landingBatches(board).length, gates: store.gateRuns(board).length }));
  // Only this disposable fixture simulates a crash after genuine receipts but before the local Git fast-forward.
  box.git(box.repo, 'reset', '--hard', landed.batch.base);
  const recovered = json(box, box.repo, 'land', '--due');
  assert.equal(recovered.batch, null, 'an empty queue needs only recorded Git repair, not a new landing');
  assert.equal(recovered.cadence.count, 0);
  assert.equal(box.git(box.repo, 'rev-parse', 'main'), landed.batch.tip, 'due no-op cannot strand the recorded Git repair');
  assert.deepEqual(onBoard(box, board => ({ batches: store.landingBatches(board).length, gates: store.gateRuns(board).length })), recorded,
    'repair neither creates a new batch nor records another gate run');
});
