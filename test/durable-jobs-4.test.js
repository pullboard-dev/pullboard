/** Durable gate 4/20: show and status read the gate panel from the jobs cell [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { privateFixtureFiles } from './fixture-child.js';
import { openBoard, closeBoard } from '../apps/lib/index.js';
import { createJob, writeStep, takeJob, gatePanel, stalledGates, LEASE_MS } from '../packages/jobs/index.js';

const files = privateFixtureFiles('pullboard-durable-jobs-');
after(() => rmSync(files.root, { recursive: true, force: true }));

/** Open a fresh real board file and hand its SQLite handle to the body. */
function withBoard(name, body) {
  const board = openBoard(join(files.root, `${name}.sqlite`));
  try { return body(board.db); } finally { closeBoard(board); }
}

test('clause 1: show and status read the gate panel from the jobs cell jobView [C7]', () => {
  withBoard('live', (db) => {
    createJob(db, { id: 'g1', kind: 'gate', item: 5, now: 0 });
    assert.equal(gatePanel(db, 'g1', { now: 1000 }).text, 'queued');
    takeJob(db, 'g1', 'driver', { now: 1000 });
    writeStep(db, 'g1', 'running', {}, { now: 1000 });
    assert.equal(gatePanel(db, 'g1', { now: 1000 + LEASE_MS }).text, 'running');
    assert.equal(gatePanel(db, 'absent'), null);
  });
});

test('clause 1: a job whose lease lapsed shows stalled (reclaimable) with its age [C7]', () => {
  withBoard('stalled', (db) => {
    createJob(db, { id: 'g2', kind: 'gate', item: 6, now: 0 });
    takeJob(db, 'g2', 'driver', { now: 60_000 });
    writeStep(db, 'g2', 'running', {}, { now: 60_000 });
    const panel = gatePanel(db, 'g2', { now: 60_000 + LEASE_MS + 5 * 60_000 });
    assert.equal(panel.text, 'stalled (reclaimable) 5m');
    assert.equal(panel.stalled, true);
  });
});

test('clause 1: the nine ghost-gate shapes from 6 Nov render as stalled (reclaimable) in a fixture [C7]', () => {
  withBoard('ghosts', (db) => {
    const now = 10 * 60 * 60_000;
    /** [id, steps, taken-at or null] for nine jobs that read running or queued with nobody driving. */
    const shapes = [
      ['ghost1', ['running'], null],
      ['ghost2', ['running'], 1000],
      ['ghost3', ['queued'], 2000],
      ['ghost4', ['running', 'running'], 3000],
      ['ghost5', ['queued', 'running'], 4000],
      ['ghost6', ['running'], 5000],
      ['ghost7', ['queued'], 6000],
      ['ghost8', ['running'], null],
      ['ghost9', ['queued', 'running'], 7000],
    ];
    shapes.forEach(([id, steps, takenAt], index) => {
      createJob(db, { id, kind: 'gate', item: 100 + index, now: 500 });
      if (takenAt !== null) takeJob(db, id, 'dead-driver', { now: takenAt });
      steps.forEach((step, seq) => { if (step !== 'queued') writeStep(db, id, step, {}, { seq, now: 500 + seq }); });
    });
    createJob(db, { id: 'waiting', kind: 'gate', item: 200, now: now - 1000 });
    createJob(db, { id: 'done', kind: 'gate', item: 201, now: 0 });
    writeStep(db, 'done', 'green', {}, { now: 1 });
    for (const [id] of shapes) {
      const panel = gatePanel(db, id, { now });
      assert.equal(panel.stalled, true, `${id} is stalled`);
      assert.match(panel.text, /^stalled \(reclaimable\) \d+m$/u);
    }
    assert.equal(gatePanel(db, 'waiting', { now }).text, 'queued');
    assert.equal(gatePanel(db, 'done', { now }).text, 'green');
    assert.deepEqual(stalledGates(db, { now }).map(row => row.id).sort(), shapes.map(([id]) => id).sort());
  });
});
