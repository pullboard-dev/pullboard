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
import { chmodSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';

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

/** A project box whose machine turns the self-check on or leaves it off, with its coordinator board open. */
function sentinelBox(t, { on }) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true', undefined, { withWorktree: false });
  const file = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  let settings = {};
  try { settings = JSON.parse(readFileSync(file, 'utf8')); } catch { /* an empty machine home */ }
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  writeFileSync(file, JSON.stringify({ ...settings, ...(on ? { sentinels: { landingSelfCheck: true } } : {}) }));
  // @pullboard-board-file journey: this is the same durable board.sqlite opened by the fixture's real CLI.
  // fixture-subject: addItem (the real CLI's durable board, read and seeded with landing batch events; no kit seam builds that)
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  t.after(() => store.closeBoard(board));
  return { box, board };
}
/** Write twenty red main comparisons to the repository's local comparison cache, as landing records them. */
function redCache(box, { green = false } = {}) {
  const file = join(box.repo, '.git', 'pullboard', 'main-red.json');
  const files = {};
  for (let n = 0; n < 20; n++) files[`test/f${n}.test.js`] = { result: n === 19 && green ? 'green' : 'red', fileIsolation: !(n === 19 && green) || undefined, ...(n === 19 && green ? { failures: [] } : {}), at: new Date(Date.UTC(2026, 10, 4, 0, n)).toISOString() };
  mkdirSync(join(box.repo, '.git', 'pullboard'), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 2, entries: { ['a'.repeat(40)]: files } }), { mode: 0o600 });
  chmodSync(file, 0o600);
}
/** The coordinator shouts the sentinel recorded. */
const selfShouts = board => board.db.prepare("SELECT shout_text FROM shout WHERE shout_from='sentinel' AND shout_to='coordinator'").all();
const sentinelRun = box => runCliInProcess(['sentinel', 'run', '--health-only', '--json'], { cwd: box.repo, env: box.env });

test('clause 1: a real sentinel run with twenty red main comparisons in the cache shouts the failing check once, only behind sentinels.landingSelfCheck [C7,#10125]', async t => {
  const off = sentinelBox(t, { on: false });
  redCache(off.box);
  assert.equal((await sentinelRun(off.box)).status, 0);
  assert.equal(selfShouts(off.board).length, 0, 'off by default: no shout');
  const { box, board } = sentinelBox(t, { on: true });
  redCache(box, { green: true });
  assert.equal((await sentinelRun(box)).status, 0);
  assert.equal(selfShouts(board).length, 0, 'a green among the last twenty means no shout');
  redCache(box);
  const first = await sentinelRun(box);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(selfShouts(board).length, 1);
  assert.match(selfShouts(board)[0].shout_text, /none of the last 20 was green/u);
  assert.match(selfShouts(board)[0].shout_text, /test\/f/u);
  assert.equal((await sentinelRun(box)).status, 0);
  assert.equal(selfShouts(board).length, 1, 'a standing fault is shouted once');
});

test('clause 2: a real sentinel run after three landing batches stopped for the same reason shouts that reason once [C7,#10125]', async t => {
  const { box, board } = sentinelBox(t, { on: true });
  for (const id of ['a', 'b', 'c']) atomic(board, () => logEvent(board, 'coordinator', 'landing_batch', null, { batch: { id, state: 'blocked', items: [{ id: 7 }], refusal: { code: 'COMMIT_HEADER_LONG' } } }));
  const run = await sentinelRun(box);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(selfShouts(board).length, 1);
  assert.match(selfShouts(board)[0].shout_text, /COMMIT_HEADER_LONG.*#7/u);
  await sentinelRun(box);
  assert.equal(selfShouts(board).length, 1, 'shouted once');
});
