/** Failure diagnostics read real private records and SQLite without publishing private payloads [C7,#12952]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { pullFailureSnapshot } from './pull-failure.js';

test('cli.fixture-pull-failure.bounded-safe-read-only-snapshot: failure snapshots retain queue phases and real pool counts while excluding private records and bounded log payloads [C7,#12952]', () => {
  const { root } = privateFixtureFiles('pullboard-pull-failure-');
  const home = join(root, 'worker');
  const machineHome = join(root, 'controller');
  const requests = join(root, 'requests');
  const records = join(machineHome, 'runner-jobs');
  const running = join(home, '.pullboard-runner', 'running');
  mkdirSync(records, { recursive: true });
  mkdirSync(running, { recursive: true });
  const startedAt = Date.now();
  const privateValue = 'private-payload-must-not-escape';
  for (let i = 0; i < 20; i++) {
    const id = randomUUID();
    writeFileSync(join(records, id + '.json'), JSON.stringify({ id, phase: 'connect', phaseAt: { connect: startedAt + 1 }, spec: { value: privateValue } }));
    const job = join(running, id);
    mkdirSync(job);
    writeFileSync(join(job, 'control.log'), privateValue.repeat(10000) + '\nPULLBOARD_RUNNER_READY ' + id + '\n');
    writeFileSync(join(job, 'source.pack.ready'), '');
  }
  writeFileSync(requests + '.phases', 'dispatched\nreturned\n');
  const pool = new DatabaseSync(join(machineHome, 'resources.sqlite'));
  try {
    pool.exec('CREATE TABLE holder(value TEXT); CREATE TABLE waiter(value TEXT); INSERT INTO holder VALUES (\'private\');');
    const snapshot = pullFailureSnapshot({ home, machineHome, requests, startedAt });
    assert.equal(snapshot.controller.count, 20);
    assert.equal(snapshot.controller.jobs.length, 16);
    assert.equal(snapshot.remote[1].count, 20);
    assert.equal(snapshot.remote[1].jobs.length, 16);
    assert.ok(snapshot.remote[1].jobs.every(job => job.sourceSent && job.observedMarkersInTail.includes('READY')));
    assert.ok(snapshot.controller.jobs.every(job => /^J\d+$/u.test(job.job) && job.phase === 'connect' && job.marks.connect === 1));
    assert.deepEqual(snapshot.pools.controller, { state: 'read', holders: 1, waiters: 0 });
    assert.deepEqual(pool.prepare('SELECT * FROM holder').all().map(row => row.value), ['private']);
    const text = JSON.stringify(snapshot);
    assert.ok(text.length < 12000, 'retained failure output stays bounded even with more than twelve jobs');
    assert.ok(!text.includes(privateValue));
    assert.ok(!text.includes(root));
    assert.equal(snapshot.transports.dispatched, 1);
    assert.equal(snapshot.transports.returned, 1);
  } finally { pool.close(); }
});
