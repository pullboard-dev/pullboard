/** A gate waiting because every runner is over its load limit names the overloaded runner and its load [C7,#8351]. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { runnerWaitLine } from '../../../index.js';
import { runnerWaitReasons } from '../../../index.js';

/** An in-memory pool holding only the tables the wait projection reads. */
function pool(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE runner_unavailable(host TEXT PRIMARY KEY,since TEXT NOT NULL,detail TEXT NOT NULL,failure TEXT); CREATE TABLE runner_gui(host TEXT PRIMARY KEY,gui INTEGER NOT NULL); CREATE TABLE holder(name TEXT,agent TEXT,item TEXT,browser INTEGER,timing INTEGER); CREATE TABLE runner_timing_drain(singleton INTEGER,host TEXT,token TEXT,agent TEXT,item TEXT)');
  return db;
}

test('clause 1: a wait on a runner over 1.5x its cores prints overloaded with its load, not queue priority [C7]', t => {
  const db = pool(t), now = Date.now();
  const runners = [
    { host: 'hot', slots: 2, browser: 0, cores: 4, cpuLoad: { at: new Date(now - 1000).toISOString(), busyPercent: 99, average: [9.5, 8, 7] } },
    { host: 'calm', slots: 2, browser: 0, cores: 4, cpuLoad: { at: new Date(now - 1000).toISOString(), busyPercent: 10, average: [0.5, 0.5, 0.5] } },
  ];
  const reasons = runnerWaitReasons(db, runners, { gui: 0, browser: 0, timing: 0 }, new Set(), { policy: { enabled: true }, now });
  assert.equal(reasons[0].reason, 'overloaded (load 9.5 on 4 cores, above 1.5x)');
  assert.equal(reasons[1].reason, 'available');
  const line = runnerWaitLine({ browser: false, gui: false, timing: false, runners: reasons });
  assert.match(line, /hot: overloaded \(load 9\.5 on 4 cores, above 1\.5x\), gate 2\/2 free/u);
  assert.match(line, /calm: queue priority/u);
  const off = runnerWaitReasons(db, runners, { gui: 0, browser: 0, timing: 0 }, new Set());
  assert.equal(off[0].reason, 'available', 'without load-aware dispatch nothing is skipped for load');
});
