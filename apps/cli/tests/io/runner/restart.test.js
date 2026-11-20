/** next's dead-runner check finds gate jobs from the in-flight items, never the open list [C7,#10852,#6556]. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fixture } from '../../fixtures/next/take.js';
import { restartDeadRunner } from '../../../src/io/runner/restart.js';

/** A context restartDeadRunner reads: the board file, the clock and the primary checkout. */
function context(box) {
  return { file: box.file, clock: box.clock, config: box.config, io: { err: () => {} }, info: { root: box.root, isMain: true } };
}

/** Put a claimed item's gate job in the queue, as submit offers it to a runner. */
function offerGate(box, id) {
  const at = box.clock.now().getTime();
  box.board.db.prepare('INSERT INTO job (job_id, job_kind, job_item, job_step, job_created, job_updated) VALUES (?, ?, ?, ?, ?, ?)')
    .run(`gate-${id}`, 'gate', id, 'offered', at, at);
}

/** Run `work` and return the item-list queries the board received, by wrapping DatabaseSync.prototype.prepare. */
async function itemLists(work) {
  const real = DatabaseSync.prototype.prepare, seen = [];
  DatabaseSync.prototype.prepare = function recorded(sql, ...rest) {
    if (/SELECT item\.\*/u.test(sql)) seen.push(/item_status IN \('claimed','submitted'\)/u.test(sql) ? 'in-flight' : 'open or all');
    return real.call(this, sql, ...rest);
  };
  try { return { result: await work(), seen }; } finally { DatabaseSync.prototype.prepare = real; }
}

test('cli.io-runner-restart.in-flight-only: clause 1: a claimed item whose gate job waits restarts the runner once for that item, and the check lists only the in-flight items [C7,#10852]', async t => {
  const box = await fixture(t);
  for (let n = 0; n < 40; n += 1) box.add(`Open work ${n}`);
  const id = box.add('Work waiting in its gate');
  box.claim(id);
  offerGate(box, id);
  const starts = [];
  const { result, seen } = await itemLists(() => restartDeadRunner(context(box), async host => { starts.push(host); return { started: true, pid: 4242 }; }));
  assert.deepEqual(starts, [box.root], 'the starter runs once, for the primary checkout');
  assert.equal(result, `restarted this machine's local runner (pid 4242) for the gate job of #${id}`);
  assert.deepEqual(seen, ['in-flight'], `item lists read: ${seen.join(', ')}`);
});

test('cli.io-runner-restart.no-gate-no-start: clause 2: a board whose only claim has no gate job never starts the runner and answers null [C7,#10852]', async t => {
  const box = await fixture(t);
  box.add('Open work');
  box.claim(box.add('Work still building'));
  const starts = [];
  const result = await restartDeadRunner(context(box), async host => { starts.push(host); return { started: true, pid: 1 }; });
  assert.equal(result, null);
  assert.deepEqual(starts, []);
});
