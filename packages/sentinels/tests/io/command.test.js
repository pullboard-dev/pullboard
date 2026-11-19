/** The one-minute lapsed pass re-sweeps the derived-state table when main has moved, behind health.derivedState [C7,#3010]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixtureCommittedGraph } from '../../../gate/tests/fixtures/testkit.js';
import { fixtureMachineSettings } from '../../../gate/tests/fixtures/testkit.js';
import { trunkRef } from '../../../git/light.js';
import { readDerivedState } from '../../../health/index.js';
import { temporaryDirectory } from '../../../board/tests/fixtures/board.js';
import { fixtureBoard } from '../../../board/tests/fixtures/board.js';
import { gateAtHead } from '../../../store/index.js';
import { listItems } from '../../../store/index.js';
import { sentinelCommand } from '../../index.js';

const MAIN = 'a'.repeat(40);

/** Run the lapsed-only pass on an empty board with the derived-state ports replaced, and return what the sweep was called with. */
async function lapsedPass(t, enabled) {
  const board = fixtureBoard(t);
  const calls = [];
  const said = [];
  const ctx = { info: { root: '/scratch', isMain: false }, config: {}, clock: board.clock, io: { say: line => said.push(line) } };
  const derived = { enabled: () => enabled, mainCommit: () => MAIN, sweep: (swept, options) => { calls.push({ board: swept, options }); return null; } };
  const code = await sentinelCommand({ ctx, words: ['run'], values: { 'lapsed-only': true }, withBoard: (_ctx, work) => work(board),
    whoAmI: () => ({ id: 'coordinator' }), ordered: async () => {}, trunkRef: () => 'refs/heads/main', derived });
  return { code, calls, said, board };
}

test('sentinels.io-command.lapsed-pass-sweeps-derived-at-main: clause 1: the lapsed-only pass calls sweepDerivedAtMain once with the current main commit when derivedStateEnabled is true [C7,#3010]', async t => {
  const { code, calls, said, board } = await lapsedPass(t, true);
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].board, board);
  assert.equal(calls[0].options.mainCommit, MAIN);
  assert.equal(calls[0].options.enabled, true);
  assert.deepEqual(said, ['Lapsed claims swept.']);
});

test('sentinels.io-command.lapsed-pass-no-sweep-when-off: clause 1: the lapsed-only pass does not call sweepDerivedAtMain when derivedStateEnabled is false [C7,#3010]', async t => {
  const { code, calls } = await lapsedPass(t, false);
  assert.equal(code, 0);
  assert.equal(calls.length, 0);
});

test('sentinels.io-command.lapsed-pass-readers-are-the-real-ones: clause 2: the sweep gets the store item and gate readers and a verdict reader that answers per item [C7,#3010]', async t => {
  const { calls } = await lapsedPass(t, true);
  const { readers } = calls[0].options;
  assert.equal(readers.listItems, listItems);
  assert.equal(readers.gateAtHead, gateAtHead);
  assert.equal(typeof readers.verdictState, 'function');
});

test('sentinels.io-command.lapsed-pass-real-path-fills-the-table: clause 3: with health.derivedState on, one lapsed pass after main moves leaves the table readable at the new main [C7,#3010]', async t => {
  const root = temporaryDirectory('pullboard-sentinel-derived-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(root, 'machine-home');
  mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, { health: { derivedState: true } });
  t.after(() => {
    if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved;
    rmSync(root, { recursive: true, force: true });
  });
  const graph = fixtureCommittedGraph('pb-sentinel-derived-');
  graph.put('a.txt', 'one');
  const first = graph.commit();
  const board = fixtureBoard(t, { storage: 'file', purpose: 'persistence' });
  const pass = async () => {
    const ctx = { info: { root: graph.root, isMain: false }, config: {}, clock: board.clock, io: { say: () => {} } };
    return sentinelCommand({ ctx, words: ['run'], values: { 'lapsed-only': true }, withBoard: (_ctx, work) => work(board),
      whoAmI: () => ({ id: 'coordinator' }), ordered: async () => {}, trunkRef });
  };
  const at = commit => readDerivedState(board, { mainCommit: commit, enabled: true });
  assert.equal(at(first), null, 'nothing is swept before the first pass');
  assert.equal(await pass(), 0);
  assert.notEqual(at(first), null);
  graph.put('a.txt', 'two');
  const second = graph.commit();
  assert.notEqual(second, first);
  assert.equal(at(second), null, 'main moved: the table is not yet current');
  assert.equal(await pass(), 0);
  assert.notEqual(at(second), null, 'one lapsed pass makes the table current at the new main');
});
