/** The serve restart trial: a move to new code is tried on the claim path before the socket is handed over [C7,#12118]. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { restartOnCodeMove } from '../../index.js';
import { claimTrial } from '../../src/io/fresh.js';
import { trialClaims } from '../../../api/src/io/claim-replay.js';
import { cellBoard } from '../../../board/tests/fixtures/cell-board.js';
import { cellRepo } from '../../../store/tests/fixtures/cell.js';

const FROM = 'a'.repeat(40);
const TO = 'b'.repeat(40);

/**
 * Run restartOnCodeMove through one code move with the given trial and report what it did: the order of its calls and its log lines.
 * `settled` is true when the restart finished; false when the old process was still serving after the move was judged.
 */
async function moveOnce(t, trial) {
  const order = [];
  const lines = [];
  let revision = FROM;
  let judged;
  const done = new Promise((resolve) => { judged = resolve; });
  const fresh = restartOnCodeMove({ root: '.', revision: () => revision, interval: 5, drain: 1_000, handoff: true, trial,
    log: (line) => { lines.push(line); if (/refused|could not run/u.test(line)) judged(); },
    close: async () => { order.push('close'); },
    relaunch: async () => { order.push('relaunch'); return { pid: 7, listening: true }; } });
  const hold = setInterval(() => {}, 1_000); // the watcher's timer is unref'd; this test holds the loop open
  t.after(() => { clearInterval(hold); fresh.stop(); });
  revision = TO;
  const settled = await Promise.race([fresh.restarted.then(() => true), done.then(() => new Promise((resolve) => setTimeout(() => resolve(false), 60)))]);
  return { order, lines, settled };
}

/** Figures a trial reports: the old process measured at p95 10 ms and 50 ms of CPU. */
const OLD = { p95: 10, cpuMs: 50 };
const stubTrial = (next, old = OLD) => ({ old: () => old, next: () => next });

test('drive.io-fresh.trial-keeps-old: clause 1: with serve.restartTrial on, a new process whose trial p95 is over 1 s, over 2x the old p95 or whose CPU is over 2x the old keeps the old process listening, hands over no socket and logs one line with both p95s and the commit [C7,#12118]', async (t) => {
  const refused = [
    ['p95 over 1 s', { p95: 1_001, cpuMs: 50 }, { p95: 900, cpuMs: 500 }],
    ['p95 over 2x the old', { p95: 21, cpuMs: 50 }, OLD],
    ['CPU over 2x the old', { p95: 10, cpuMs: 101 }, OLD],
  ];
  for (const [why, next, old] of refused) {
    const moved = await moveOnce(t, stubTrial(next, old));
    assert.equal(moved.settled, false, `${why}: the old process keeps serving`);
    assert.deepEqual(moved.order, [], `${why}: no new process starts and no socket moves`);
    assert.equal(moved.lines.length, 1, `${why}: one log line: ${moved.lines.join(' | ')}`);
    assert.match(moved.lines[0], new RegExp(`${TO.slice(0, 10)}.*p95 ${next.p95.toFixed(2)} ms.*p95 ${old.p95.toFixed(2)} ms`, 'u'), why);
  }
});

test('drive.io-fresh.trial-passes-hands-over: clause 2: a trial within the thresholds hands over as before, and with the setting off nothing changes and no trial runs [C7,#12118]', async (t) => {
  const ran = [];
  const within = { old: () => { ran.push('old'); return OLD; }, next: () => { ran.push('next'); return { p95: 20, cpuMs: 100 }; } };
  const passed = await moveOnce(t, within);
  assert.equal(passed.settled, true);
  assert.deepEqual(passed.order, ['relaunch', 'close'], 'the new process listens first, then this one stops');
  assert.deepEqual(ran, ['old', 'next'], 'a trial on measures this process, then the new code');
  ran.length = 0;
  const off = await moveOnce(t, null);
  assert.equal(off.settled, true);
  assert.deepEqual(off.order, ['relaunch', 'close']);
  assert.deepEqual(ran, [], 'with the setting off no trial runs');
  assert.equal(off.lines.some((line) => /trial/u.test(line)), false, 'and it says nothing of one');
});

/**
 * The live board's shape on 19 Nov: gate shard rows by the tens of thousands and gate jobs by the dozen, written into the scratch board.
 * `scanned` of the gates belong to a claimed item and are done with a shard still queued, so every claim's settle pass reads that gate's shards.
 */
function fillLikeLive(file, { shards = 60_000, gates = 93, scanned = 3 } = {}) {
  const db = new DatabaseSync(file); // a plain connection: this board's move guard belongs to the opener, and the seed sets status the way a claim left it
  const now = Date.now();
  const stamp = new Date(now).toISOString();
  const item = db.prepare("INSERT INTO item (item_lane, item_title, item_created_by, item_created_at, item_updated_at) VALUES ('core', ?, 'fixture', ?, ?)");
  const job = db.prepare('INSERT INTO job (job_id, job_kind, job_item, job_step, job_created, job_updated) VALUES (?, ?, ?, ?, ?, ?)');
  const ids = [];
  db.exec('BEGIN');
  try {
    for (let gate = 0; gate < gates; gate++) {
      const id = Number(item.run(`gate ${gate}`, stamp, stamp).lastInsertRowid);
      if (gate < scanned) db.prepare("UPDATE item SET item_status = 'claimed', item_owner = 'fixture', item_lease_until = ?, item_frozen_digest = 'fixture' WHERE item_id = ?").run(new Date(now + 3_600_000).toISOString(), id);
      ids.push(`gate:${id}:${String(gate).padStart(12, '0')}:m${gate}`);
      job.run(ids[gate], 'gate', id, gate < scanned ? 'done' : 'queued', now + gate, now + gate);
    }
    for (let row = 0; row < shards; row++) {
      const gate = row % gates;
      job.run(`${ids[gate]}:shard:${row}`, 'gate-shard', null, row < gates && gate < scanned ? 'queued' : 'done', now + row, now + row);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
}

test('drive.io-fresh.trial-real-claims: clause 3: restartOnCodeMove runs trialClaims over a scratch board of live shape before the handoff, refuses a new process whose claims are delayed 2 s each and hands over an undelayed one [C7,#12118]', async (t) => {
  const repo = cellRepo(t, { real: true });
  cellBoard(t, repo.boardFile, undefined, { real: true, gitRoot: repo.root });
  fillLikeLive(repo.boardFile);
  const count = 10;
  const claims = ({ db, root, count: n }) => trialClaims({ db, root, count: n });
  /** The new process's claims: the same rolled-back claims, each answered `delay` ms later than the board gave it. */
  const newProcess = (delay) => (_to, options) => {
    const figures = claims(options);
    return { p95: figures.p95 + delay, cpuMs: figures.cpuMs };
  };
  const trial = (delay) => claimTrial({ claims, db: repo.boardFile, root: repo.root, count, next: newProcess(delay) });
  const slow = await moveOnce(t, trial(2_000));
  assert.equal(slow.settled, false, 'claims delayed 2 s each are refused');
  assert.deepEqual(slow.order, [], 'the old process keeps the socket');
  assert.equal(slow.lines.length, 1, slow.lines.join(' | '));
  assert.match(slow.lines[0], /restart trial refused bbbbbbbbbb/u);
  const quick = await moveOnce(t, trial(0));
  assert.equal(quick.settled, true, `undelayed claims hand over: ${quick.lines.join(' | ')}`);
  assert.deepEqual(quick.order, ['relaunch', 'close']);
});
