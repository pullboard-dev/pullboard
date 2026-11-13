/** A blocked landing batch reaches the coordinator inbox without a fresh sentinel scan, and a failed notice retries without duplicates [C7,#3844]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureBoard } from '../../tests/fixtures/board.js';
import { register } from '../../../../packages/store/index.js';
import { addItem } from '../../../../packages/store/index.js';
import { atomic } from '../../../../packages/store/index.js';
import { logEvent } from '../../../../packages/store/index.js';
import { recordHealthFindings } from '../../../../packages/store/index.js';
import { recordLandingNotices } from '../../src/io/commands/land.js';

/** A board with a coordinator, one item and a blocked batch naming it, and no health scan ever recorded. */
function blockedBatch(t) {
  const board = fixtureBoard(t, { clock: { now: () => new Date('2026-11-02T00:00:00Z') } });
  register(board, { lane: 'coordinator', path: '/coordinator' });
  const item = addItem(board, { by: 'coordinator', lane: 'core', title: 'Blocked item', criterion: 'It lands.' });
  const batch = { id: 'blocked-batch', state: 'blocked', items: [{ id: item }], updatedAt: '2026-11-02T00:00:00.000Z',
    refusal: { code: 'LAND_TRUNK_MOVED', at: '2026-11-02T00:00:00.000Z' } };
  atomic(board, () => logEvent(board, 'coordinator', 'landing_batch', null, { batch }));
  const noScan = board.db.prepare("SELECT COUNT(*) AS n FROM event WHERE event_kind='health-scan'").get().n;
  assert.equal(noScan, 0, 'the fixture has no sentinel scan');
  return { board, item };
}

/** The coordinator shouts naming the refusal code. */
function notices(board) {
  return board.db.prepare("SELECT shout_text FROM shout WHERE shout_to='coordinator'").all().filter(row => row.shout_text.includes('LAND_TRUNK_MOVED'));
}

const real = (board) => (operation, args) => {
  assert.equal(operation, 'recordHealthFindings');
  return recordHealthFindings(board, ...args);
};

test('clause 1: a blocked batch with no sentinel scan posts its refusal to the coordinator, retrying a stale read once [C7,#3844]', async t => {
  const { board, item } = blockedBatch(t);
  let stale = 0;
  const lines = [];
  await recordLandingNotices({}, board, { err: line => lines.push(line) }, (operation, args) => {
    if (stale++ === 0) atomic(board, () => logEvent(board, 'coordinator', 'note', item, { text: 'the board moved between read and write' }));
    return real(board)(operation, args);
  });
  assert.equal(stale, 2, 'the first write was stale, the retry read the observation again');
  assert.deepEqual(lines, []);
  assert.equal(notices(board).length, 1);
  assert.ok(notices(board)[0].shout_text.includes('#' + item));
});

test('clause 2: a notice that fails logs its code, and a retry posts it once without duplicates [C7,#3844]', async t => {
  const { board } = blockedBatch(t);
  const lines = [];
  const io = { err: line => lines.push(line) };
  await recordLandingNotices({}, board, io, () => { throw Object.assign(new Error('board busy'), { code: 'BOARD_BUSY' }); });
  assert.deepEqual(lines, ['landing refusal notice deferred: BOARD_BUSY']);
  assert.equal(notices(board).length, 0);
  await recordLandingNotices({}, board, io, real(board));
  await recordLandingNotices({}, board, io, real(board));
  assert.equal(notices(board).length, 1, 'the second retry finds nothing new to post');
  assert.equal(lines.length, 1);
});
