/** Exercise the generated state reader with explicit transport replies; this is an adapter contract, not a pure renderer witness. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { applyStateDelta } from '../../../../../../packages/api/index.js';
import { expandItemSummaries } from '../../../../index.js';
import { pageScriptPart3 } from '../../../../index.js';

/** Execute the actual generated board reader with explicit transport replies and no browser or board. */
function compactBoardReader(replies, { local = true, snapshot = false } = {}) {
  const script = pageScriptPart3({ applyStateDelta, expandItemSummaries });
  const start = script.indexOf('const sentStates = new Map();');
  const end = script.indexOf('/** Whether a board state already carries', start);
  assert.ok(start >= 0 && end > start, 'the generated script contains its actual state reader');
  const paths = [];
  const read = runInNewContext(script.slice(start, end) + '; boardRead', {
    snapshot, localBoardIds: new Set(local ? ['board'] : []),
    api: async path => { paths.push(path); assert.ok(replies.length, 'every request has an explicit response'); return replies.shift(); },
  });
  return { read: seen => read({ id: 'board' }, seen), paths };
}

test('the view expands compact snapshots before rendering and using ordinary deltas [N26,C7]', async () => {
  const first = { sequence: 10, itemEncoding: { version: 1, defaults: {
    lane: 'web', status: 'open', specs: [], claim: null, needsYou: false, effort: 1,
  } }, items: [{ id: 1, title: 'First' }, { id: 2, title: 'Second', effort: 0 }] };
  const unchanged = JSON.stringify(first);
  const updated = { id: 1, title: 'First updated', lane: 'api', status: 'claimed', specs: ['G1'], claim: null, needsYou: false, effort: 1 };
  const { read, paths } = compactBoardReader([
    { state: first, eventLogVersion: 127 },
    { sequence: 11, eventLogVersion: 127, delta: { replace: { sequence: 11 }, merge: {
      items: { key: 'id', set: [updated], ids: [1, 2] },
    } } },
  ]);
  const shown = await read(3);
  assert.deepEqual(JSON.parse(JSON.stringify(shown.items)), [
    { lane: 'web', status: 'open', specs: [], claim: null, needsYou: false, effort: 1, id: 1, title: 'First' },
    { lane: 'web', status: 'open', specs: [], claim: null, needsYou: false, effort: 0, id: 2, title: 'Second' },
  ]);
  assert.equal(Object.hasOwn(shown, 'itemEncoding'), false, 'the renderer receives the expanded state');
  assert.equal(JSON.stringify(first), unchanged, 'decoding never mutates the transport snapshot');
  const changed = await read(4);
  assert.deepEqual(JSON.parse(JSON.stringify(changed.items)), JSON.parse(JSON.stringify([updated, shown.items[1]])), 'deltas replace ordinary full rows over an expanded base');
  assert.equal(changed.sequence, 11);
  assert.equal(Object.hasOwn(changed, 'itemEncoding'), false, 'the retained delta base has no wire dictionary');
  assert.deepEqual(paths, [
    '/api/v1/boards/board/state?seen=3&items=compact',
    '/api/v1/boards/board/state?since=10&seen=4&eventLogVersion=127',
  ], 'only a local full snapshot opts into compact items');
});

test('the view accepts ordinary snapshots and re-expands a compact reset without changing relay or export requests [N26,C7]', async () => {
  const legacy = { sequence: 1, items: [{ id: 1, title: 'Ordinary', lane: 'web', status: 'open' }] };
  const reset = { sequence: 2, itemEncoding: { version: 1, defaults: { lane: 'api', status: 'open' } }, items: [{ id: 2, title: 'Reset' }] };
  const local = compactBoardReader([{ state: legacy }, { reset: true }, { state: reset }]);
  assert.equal(await local.read(null), legacy, 'an older server can ignore the opt-in and return its ordinary shape');
  const next = await local.read(null);
  assert.equal(next.items[0].lane, 'api');
  assert.equal(Object.hasOwn(next, 'itemEncoding'), false, 'a reset is decoded before becoming the next delta base');
  assert.deepEqual(local.paths, ['/api/v1/boards/board/state?items=compact',
    '/api/v1/boards/board/state?since=1', '/api/v1/boards/board/state?items=compact']);
  for (const options of [{ local: false }, { snapshot: true }]) {
    const plain = compactBoardReader([{ state: legacy }], options);
    assert.equal(await plain.read(null), legacy);
    assert.deepEqual(plain.paths, ['/api/v1/boards/board/state'], 'relay and export reads retain their existing request shape');
  }
});

test('the generated reader expands V2 columns with fresh rows before ordinary deltas and resets [N26,C7]', async () => {
  const first = { sequence: 20, itemEncoding: { version: 2, count: 2 }, items: [
    ['id', 'r', [1, 2], []],
    ['title', 'r', ['Column first', 'Column second'], []],
    ['status', 'd', [0, 1], ['open', 'claimed']],
    ['specs', 'd', [0, 0], [['G1']]],
    ['optional', 'd', [-1, 0], [null]],
    ['updatedAt', 't', [0, 1000], [1704067200000, []]],
  ] };
  const wire = JSON.stringify(first);
  const updated = { id: 1, title: 'Ordinary delta', status: 'verified', specs: [], optional: null };
  const ordinary = { sequence: 22, items: [{ id: 3, title: 'Ordinary reset', specs: [] }] };
  const { read, paths } = compactBoardReader([
    { state: first, eventLogVersion: 127 },
    { sequence: 21, eventLogVersion: 127, delta: { replace: { sequence: 21 }, merge: {
      items: { key: 'id', set: [updated], ids: [1, 2] },
    } } },
    { reset: true }, { state: ordinary, eventLogVersion: 128 },
  ]);
  const shown = await read(null);
  assert.deepEqual(JSON.parse(JSON.stringify(shown.items)), [
    { id: 1, title: 'Column first', status: 'open', specs: ['G1'], updatedAt: '2024-01-01T00:00:00.000Z' },
    { id: 2, title: 'Column second', status: 'claimed', specs: ['G1'], optional: null, updatedAt: '2024-01-01T00:00:01.000Z' },
  ]);
  assert.equal(Object.hasOwn(shown.items[0], 'optional'), false);
  assert.equal(shown.items[1].optional, null);
  assert.notEqual(shown.items[0].specs, shown.items[1].specs, 'dictionary arrays are fresh for each row');
  shown.items[0].specs.push('private mutation');
  assert.deepEqual(JSON.parse(JSON.stringify(shown.items[1].specs)), ['G1']);
  assert.equal(JSON.stringify(first), wire, 'the transport dictionary is untouched');
  assert.equal(Object.hasOwn(shown, 'itemEncoding'), false);
  const changed = await read(null);
  assert.deepEqual(JSON.parse(JSON.stringify(changed.items[0])), updated, 'ordinary full-row deltas replace expanded columns');
  assert.equal(changed.sequence, 21);
  assert.equal(Object.hasOwn(changed, 'itemEncoding'), false);
  const reset = await read(null);
  assert.equal(reset, ordinary, 'ordinary reset returns to an ordinary retained base');
  assert.equal(Object.hasOwn(reset.items[0], 'optional'), false);
  assert.deepEqual(paths, ['/api/v1/boards/board/state?items=compact',
    '/api/v1/boards/board/state?since=20&eventLogVersion=127',
    '/api/v1/boards/board/state?since=21&eventLogVersion=127',
    '/api/v1/boards/board/state?items=compact']);
});
