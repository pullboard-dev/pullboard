/** @pullboard-test-input source-cell api */
/** With gate.endStaleJobs on, a new gate candidate ends the item's older open gate jobs and a landed item's open gate jobs end; off, nothing ends [C7,#8816]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellBoard } from '../../../../store/tests/fixtures/cell.js';
import { temporaryDirectory } from '../../../../board/tests/fixtures/board.js';
import { endStaleGateJobs } from '../../../index.js';
import { jobViews } from '../../../index.js';
import { offerJob } from '../../../index.js';

const ITEM = 7;
const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);

/** A real board file with gate jobs for ITEM at two older candidates, one for another item, and a land job. */
function board(t) {
  const root = temporaryDirectory('pullboard-end-stale-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { db } = cellBoard(t, join(root, 'board.sqlite'));
  offerJob(db, { id: 'gate:7:old', kind: 'gate', needs: [], item: ITEM, candidate: OLD, now: 1000 });
  offerJob(db, { id: 'gate:7:new', kind: 'gate', needs: [], item: ITEM, candidate: NEW, now: 2000 });
  offerJob(db, { id: 'gate:8:other', kind: 'gate', needs: [], item: 8, candidate: OLD, now: 1000 });
  offerJob(db, { id: 'land:7', kind: 'land', needs: [], now: 1000 });
  return db;
}

/** The step of each named job. */
const steps = (db, ids) => jobViews(db, ids).map(view => view.step);

test('clause 1: with gate.endStaleJobs on, offering a new candidate ends the item\'s older open gate jobs and keeps the new one and other items\' [C7,#8816]', t => {
  const db = board(t);
  const ended = endStaleGateJobs(db, { item: ITEM, keep: NEW, enabled: true, now: 3000 });
  assert.deepEqual(ended, ['gate:7:old']);
  assert.deepEqual(steps(db, ['gate:7:old', 'gate:7:new', 'gate:8:other', 'land:7']), ['done', 'offered', 'offered', 'offered']);
});

test('clause 2: with gate.endStaleJobs on, an item that lands has all its open gate jobs ended [C7,#8816]', t => {
  const db = board(t);
  const ended = endStaleGateJobs(db, { item: ITEM, enabled: true, now: 3000 });
  assert.deepEqual(ended.sort(), ['gate:7:new', 'gate:7:old']);
  assert.deepEqual(steps(db, ['gate:7:old', 'gate:7:new', 'gate:8:other']), ['done', 'done', 'offered']);
  assert.deepEqual(endStaleGateJobs(db, { item: ITEM, enabled: true, now: 4000 }), [], 'ended jobs end only once');
});

test('clause 3: gate.endStaleJobs is off unless given: neither a new candidate nor a landing ends any job [C7,#8816]', t => {
  const db = board(t);
  assert.deepEqual(endStaleGateJobs(db, { item: ITEM, keep: NEW, now: 3000 }), []);
  assert.deepEqual(endStaleGateJobs(db, { item: ITEM, enabled: false, now: 3000 }), []);
  assert.deepEqual(steps(db, ['gate:7:old', 'gate:7:new', 'gate:8:other']), ['offered', 'offered', 'offered']);
});
