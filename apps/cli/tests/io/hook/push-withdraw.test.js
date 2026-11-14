/** A pre-push gate that blocks, times out or is interrupted withdraws its shard jobs, and a waiting one keeps them alive [C7,#7805]. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { SHARD_JOB_KIND } from '../../../../../packages/api/index.js';
import { PUSH_ALIVE_MS } from '../../../../../packages/api/index.js';
import { claimJob } from '../../../../../packages/api/index.js';
import { jobViews } from '../../../../../packages/api/index.js';
import { offerJob } from '../../../../../packages/api/index.js';
import { cellBoard } from '../../../../../packages/store/tests/fixtures/cell.js';
import { awaitAndWithdraw } from '../../../src/io/hook/push.js';

const NAMES = [1, 2, 3].map(at => `push:abc:tag:shard:${at}`);

/** A temp board with three offered shards and the board seams awaitAndWithdraw takes. */
function gateOn(t, clock) {
  const { db } = cellBoard(t, ':memory:');
  for (const id of NAMES) offerJob(db, { id, kind: SHARD_JOB_KIND, priority: 'gate', now: clock.at });
  const on = work => work({ db });
  return { db, seams: { read: on, write: on, now: () => clock.at } };
}
const steps = db => jobViews(db, NAMES).map(view => view.step);

test('clause 1: a gate that blocks at its ceiling withdraws every unfinished shard, so no runner claims one again [C7,#7805]', async t => {
  const clock = { at: 1_000_000 };
  const { db, seams } = gateOn(t, clock);
  claimJob(db, { runner: 'r1', now: clock.at });
  const wait = async () => { clock.at += 21 * 60_000; };
  const settled = await awaitAndWithdraw({}, NAMES, { ...seams, wait, pollMs: 0, exit: () => assert.fail('no exit'), signals: new EventEmitter() });
  assert.match(settled.refused, /ran past the 20-minute job ceiling/u);
  assert.deepEqual(steps(db), ['done', 'done', 'done']);
  assert.equal(claimJob(db, { runner: 'r2', now: clock.at }), null);
});

test('clause 1: a gate that throws or is interrupted by SIGINT or SIGTERM withdraws its shards and exits 130 or 143 [C7,#7805]', async t => {
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    const clock = { at: 1_000_000 }, signals = new EventEmitter(), exits = [];
    const { db, seams } = gateOn(t, clock);
    let release;
    const wait = () => new Promise(resolve => { release = resolve; });
    const running = awaitAndWithdraw({}, NAMES, { ...seams, wait, pollMs: 0, exit: exitCode => exits.push(exitCode), signals });
    await new Promise(resolve => setImmediate(resolve));
    signals.emit(signal);
    assert.deepEqual(exits, [code]);
    assert.deepEqual(steps(db), ['done', 'done', 'done'], `${signal} ends every shard`);
    release(); await running.catch(() => {});
    assert.equal(signals.listenerCount(signal), 0, 'the handlers are removed');
  }
  const clock = { at: 5 }, { db, seams } = gateOn(t, clock);
  await assert.rejects(awaitAndWithdraw({}, NAMES, { ...seams, read: () => { throw new Error('board gone'); }, wait: async () => {}, signals: new EventEmitter() }), /board gone/u);
  assert.deepEqual(steps(db), ['done', 'done', 'done'], 'a throw withdraws too');
});

test('clause 2: a waiting gate renews its shards every 30 seconds, so none ends as abandoned while it waits [C7,#7805]', async t => {
  const clock = { at: 1_000_000 };
  const { db, seams } = gateOn(t, clock);
  let polls = 0, taken = null;
  // Each poll is a minute: past the 5-minute window by the sixth, so only the gate's renewals keep a claim possible.
  const wait = async () => {
    polls += 1; clock.at += 60_000;
    if (polls === 8) { taken = claimJob(db, { runner: 'r1', now: clock.at })?.job; throw new Error('stop'); }
  };
  await assert.rejects(awaitAndWithdraw({}, NAMES, { ...seams, wait, pollMs: 0, signals: new EventEmitter() }), /stop/u);
  assert.ok(clock.at - 1_000_000 > PUSH_ALIVE_MS, 'the wait outlasted the alive window');
  assert.equal(taken, NAMES[0], 'eight minutes in, the renewals kept the shards claimable');
});
