/** With landing.perItem on, landing takes one verified item at a time and a red item is its own culprit [C7,#2901]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../packages/store/index.js';
import { openBoard } from '../apps/lib/index.js';
import { configProblems, defaults } from '../packages/config/src/shell/config.js';
import { candidates, perItemMaximum } from '../packages/landing/src/shell/landing-step-selection.js';
import { bisect } from '../packages/landing/src/shell/landing-step-diagnose.js';

const BASE = 'b'.repeat(40);
const own = { file: 'test/own.test.js', name: 'own red' };

test('landing.perItem is a boolean setting, off by default [C7,#2901]', () => {
  assert.equal(defaults().landing?.perItem ?? false, false);
  assert.deepEqual(configProblems({ ...defaults(), landing: { perItem: true } }).filter(p => /perItem/u.test(p)), []);
  assert.ok(configProblems({ ...defaults(), landing: { perItem: 'yes' } }).some(p => /landing\.perItem/u.test(p)));
});

test('perItem on limits every selection to one item; off keeps the caller limit [C7,#2901]', () => {
  assert.equal(perItemMaximum({ landing: { perItem: true } }, Infinity), 1);
  assert.equal(perItemMaximum({ landing: { perItem: true } }, 8), 1);
  assert.equal(perItemMaximum({ landing: {} }, 8), 8);
  assert.equal(perItemMaximum({}, undefined), Infinity);
});

test('selection with maximum 1 keeps scanning past a skipped item in accept order [C7,#2901]', t => {
  const board = openBoard(':memory:', { now: () => new Date('2026-11-04T08:00:00.000Z') });
  t.after(() => store.closeBoard(board));
  const held = id => ({ item_id: id, item_status: 'verified', item_merged_commit: null, item_commit: String(id).repeat(40).slice(0, 40),
    item_hold_at: '2026-11-04T07:00:00.000Z', item_hold_reason: 'held' });
  const selected = candidates(board, '/nowhere', BASE, perItemMaximum({ landing: { perItem: true } }), { listItems: () => [held(3), held(1)] });
  assert.deepEqual(selected.blocked.map(entry => entry.id), [3, 1].sort((a, b) => a - b), 'neither skipped item stops the scan');
  assert.deepEqual(selected.ready, []);
});

test('a red single item is recorded as its own culprit and returns nothing to land [C7,#2901]', async t => {
  const board = openBoard(':memory:', { now: () => new Date('2026-11-04T08:00:00.000Z') });
  t.after(() => store.closeBoard(board));
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Red item' });
  const facts = [];
  const state = { board, landingPorts: { quarantineWaivers: () => [] }, culprits: [], say() {}, onWait: undefined,
    batch: { id: 'batch', root: '/nowhere', base: BASE, tip: 'tip', revision: 0, items: [{ id, commit: 'c7' }] },
    write: async (operation, args) => { if (operation === 'appendFact') facts.push(args); return args[0]?.batch ?? state.batch; } };
  const compare = async () => ({ main: BASE, files: [{ file: own.file, result: 'green' }] });
  const green = await bisect(state, [{ id, commit: 'c7' }], [own], 'split', async () => { throw new Error('no gate'); }, compare);
  assert.deepEqual(green, []);
  assert.deepEqual(state.culprits.map(entry => [entry.id, entry.commit, entry.tests]), [[id, 'c7', [own]]]);
  assert.equal(facts.length, 1, 'the culprit is told why on its own item');
});
