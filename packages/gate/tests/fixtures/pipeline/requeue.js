/**
 * Repro, 8 Nov: a gate driver killed mid-gate waited 22 min (p50) for its retry, because only a timed sweep found it.
 * The invariant: the dispatcher sees its own worker die and the gate is requeued, same candidate, within 20 s, with no
 * builder command and no builder red [C7]. Fails on 3a89d81fc5^ (a 60 s sweep, no exit trigger); passes after it.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  gone,
  guardProcesses,
  hopCheck,
  waitUntil,
  within,
} from './kit.js';
import {
  handoffProject,
  json,
} from './project.js';

/** The requeue bound the brief sets: a dead gate restarts in seconds, not at the next timed sweep. */
const REQUEUE_MS = 20_000;

let box;
guardProcesses({ before: () => { if (box) writeFileSync(box.release, 'release\n'); } });

test('a worker killed mid-gate is requeued within 20 s on the same candidate, without a builder red [C7]', { timeout: 240_000 }, async () => {
  box = handoffProject();
  const id = box.item('Killed mid-gate');
  json(box.run(box.web, 'claim', String(id), '--json'));
  box.candidate(box.web, 'hold');
  assert.equal(json(box.run(box.web, 'submit', String(id), '--no-next', '--json')).queued, true);
  const first = await waitUntil(() => {
    const job = box.state(id).job;
    const driver = job?.state === 'running' ? box.driver(job.id) : null;
    return driver?.pid ? { job, driver } : null;
  }, 'the held gate is running under its driver', 120_000, 150);
  await waitUntil(() => box.state(id).job?.state === 'running', 'the gate is mid-run', 60_000);

  await hopCheck('dead-requeue', async () => {
    process.kill(-first.driver.pid, 'SIGKILL');
    const killedAt = Date.now();
    await waitUntil(() => gone(first.driver.pid), 'the killed driver is gone', 10_000, 50);
    let next;
    try {
      next = await waitUntil(() => {
        const job = box.state(id).job;
        return job && job.id !== first.job.id && ['queued', 'running'].includes(job.state) ? job : null;
      }, 'the gate requeued', REQUEUE_MS + 40_000, 100);
    } catch (error) {
      within(false, `the killed gate was requeued within ${REQUEUE_MS} ms; it was not requeued in 60 s`, { ms: Date.now() - killedAt, measured: 'no requeue in 60 s' });
      throw error;
    }
    const ms = Date.now() - killedAt;
    const measured = { ms, measured: `requeued as ${next.state} ${Math.round(ms / 100) / 10} s after the kill, retry ${next.infrastructureRetries ?? '?'}` };
    within(ms <= REQUEUE_MS, `the killed gate was requeued within ${REQUEUE_MS} ms; it took ${ms} ms`, measured);
    assert.equal(next.commit, first.job.commit, 'the retry runs the same candidate');
    assert.equal(box.state(id).item.item_status, 'claimed', 'a dead driver is infrastructure, never a builder red');
    return measured;
  });

  writeFileSync(box.release, 'release\n');
  await waitUntil(() => box.state(id).item.item_status === 'submitted', 'the retried gate finishes and the item is submitted', 120_000, 200);
});
