/** The gate panel calls a lease-free shadow gate stalled only when no live hand-off worker runs it [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { privateFixtureFiles } from './fixture-child.js';
import { openBoard, closeBoard } from '../apps/lib/index.js';
import { createJob, writeStep, takeJob, gatePanel, stalledGates, LEASE_MS } from '../packages/jobs/index.js';

const files = privateFixtureFiles('pullboard-gate-shadow-stalled-');
after(() => rmSync(files.root, { recursive: true, force: true }));

/** Open a fresh real board file and hand its SQLite handle to the body. */
function withBoard(name, body) {
  const board = openBoard(join(files.root, `${name}.sqlite`));
  try { return body(board.db); } finally { closeBoard(board); }
}

test('clause 1: a running shadow gate job whose hand-off worker is alive reads running, not stalled [C7]', () => {
  withBoard('shadow', (db) => {
    const now = 10 * 60_000;
    createJob(db, { id: 'alive', kind: 'gate', item: 1, now: 0 });
    writeStep(db, 'alive', 'running', {}, { now: 0 });
    createJob(db, { id: 'orphan', kind: 'gate', item: 2, now: 0 });
    writeStep(db, 'orphan', 'running', {}, { now: 0 });
    createJob(db, { id: 'leased', kind: 'gate', item: 3, now: 0 });
    takeJob(db, 'leased', 'driver', { now: 1000 });
    writeStep(db, 'leased', 'running', {}, { now: 1000 });
    const workerAlive = (view) => view.id !== 'orphan';
    assert.equal(gatePanel(db, 'alive', { now, workerAlive }).text, 'running');
    assert.equal(gatePanel(db, 'orphan', { now, workerAlive }).stalled, true);
    assert.match(gatePanel(db, 'orphan', { now, workerAlive }).text, /^stalled \(reclaimable\) \d+m$/u);
    assert.equal(gatePanel(db, 'leased', { now: now + LEASE_MS, workerAlive }).stalled, true, 'a lapsed lease is stalled whatever the worker says');
    assert.deepEqual(stalledGates(db, { now: now + LEASE_MS, workerAlive }).map(row => row.id).sort(), ['leased', 'orphan']);
    assert.equal(gatePanel(db, 'alive', { now }).stalled, true, 'with no worker signal the lease-free row still reads stalled');
  });
});
