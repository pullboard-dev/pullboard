/** Landing alarms when its own checks stop working [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { atomic } from '../../../../packages/store/index.js';
import { insertShout } from '../../../../packages/store/index.js';
import { landingBatches } from '../../../../packages/store/index.js';
import { logEvent } from '../../../../packages/store/index.js';
import { register } from '../../../../packages/store/index.js';
import { mainComparisonAlarm } from '../../../../packages/health/index.js';
import { repeatedStopAlarm } from '../../../../packages/health/index.js';
import { fixtureBoard } from '../../tests/fixtures/board.js';

const ports = { insertShout, landingBatches };
/** Count the coordinator's self-check shouts. */
const shouts = board => board.db.prepare("SELECT shout_text FROM shout WHERE shout_from='sentinel' AND shout_to='coordinator'").all();
/** A main comparison receipt `n` minutes after the epoch. */
const receipt = (n, green, extra = {}) => ({ id: `r${n}`, kind: 'main-red', green, at: new Date(Date.UTC(2026, 10, 4, 0, n)).toISOString(),
  failures: green ? [] : [{ file: 'test/a.test.js', name: 'case' }], ...extra });
/** Seed one landing batch event. */
const batch = (board, id, refusal, items = [7]) =>
  atomic(board, () => logEvent(board, 'coordinator', 'landing_batch', null, { batch: { id, state: 'blocked', items: items.map(n => ({ id: n })), refusal } }));

test('clause 1: twenty red main comparisons shout the failing check and its first line once [C7]', t => {
  const board = fixtureBoard(t); register(board, { lane: 'coordinator', path: '/c' });
  const reds = Array.from({ length: 20 }, (_, n) => receipt(n, false, n === 19 ? { failureSignatures: { version: 1, failures: [{ file: 'test/a.test.js', name: 'case', signature: 'a'.repeat(64), firstError: 'refused in a detached clone' }] } } : {}));
  assert.equal(mainComparisonAlarm(board, reds.slice(0, 19), ports), false, 'fewer than 20 is not yet an alarm');
  assert.equal(mainComparisonAlarm(board, [...reds, receipt(0, true, { id: 'old', at: '2026-11-01T00:00:00Z' })], ports), true, 'a green older than the last 20 does not count');
  assert.equal(mainComparisonAlarm(board, reds, ports), false, 'the same fault is shouted once');
  const [row] = shouts(board);
  assert.match(row.shout_text, /test\/a\.test\.js/u);
  assert.match(row.shout_text, /refused in a detached clone/u);
  assert.equal(mainComparisonAlarm(fixtureBoard(t), [...reds.slice(1), receipt(30, true)], ports), false, 'one green means no alarm');
});

test('clause 2: a landing stop repeated across three batches is shouted once with its reason and item [C7]', t => {
  const board = fixtureBoard(t); register(board, { lane: 'coordinator', path: '/c' });
  batch(board, 'a', { code: 'COMMIT_HEADER_LONG' }); batch(board, 'b', { code: 'COMMIT_HEADER_LONG' });
  assert.equal(repeatedStopAlarm(board, ports), false, 'two in a row is not enough');
  batch(board, 'c', { code: 'COMMIT_HEADER_LONG' });
  assert.equal(repeatedStopAlarm(board, ports), true);
  assert.equal(repeatedStopAlarm(board, ports), false, 'shouted once');
  const [row] = shouts(board);
  assert.match(row.shout_text, /COMMIT_HEADER_LONG/u);
  assert.match(row.shout_text, /#7/u);
  batch(board, 'd', { code: 'OTHER' });
  assert.equal(repeatedStopAlarm(board, ports), false, 'a different reason breaks the run');
});
