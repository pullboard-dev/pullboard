/** replayClaims measures pull claims on a copy of the board database and leaves the source file untouched [C7,#12097]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { cellBoard } from '../../../board/tests/fixtures/cell-board.js';
import { cellRepo } from '../../../store/tests/fixtures/cell.js';
import { claimTrial } from '../../../drive/index.js';
import { restartOnCodeMove } from '../../../drive/index.js';
import { compareClaimsWithMain } from '../../src/io/claim-replay.js';
import { replayClaims } from '../../src/io/claim-replay.js';
import { replayLine } from '../../src/io/claim-replay.js';
import { trialClaims } from '../../src/io/claim-replay.js';
import { trialLine } from '../../src/io/claim-replay.js';

test('api.io-claim-replay.replay-p95: replayClaims runs 50 claims on a copy of the board database and returns p50, p95 and max with the source bytes unchanged [C7,#12097]', t => {
  const repo = cellRepo(t, { real: true });
  const board = cellBoard(t, repo.boardFile, undefined, { real: true, gitRoot: repo.root });
  const before = readFileSync(repo.boardFile);
  const { p50, p95, max } = replayClaims({ db: repo.boardFile, root: repo.root, count: 50 });
  for (const value of [p50, p95, max]) assert.ok(Number.isFinite(value) && value >= 0, `a millisecond figure: ${value}`);
  assert.ok(p50 <= p95 && p95 <= max, 'the figures rise from p50 to max');
  assert.ok(readFileSync(repo.boardFile).equals(before), 'the source database file is byte for byte as before');
  assert.ok(board.db, 'the source board stayed open through the replay');
});

test('api.io-claim-replay.free-space-guard: replayClaims throws before writing any copy when free space is under twice the source size [C7,#12097]', t => {
  const repo = cellRepo(t, { real: true });
  cellBoard(t, repo.boardFile, undefined, { real: true, gitRoot: repo.root });
  const before = readdirSync(tmpdir()).sort();
  assert.throws(() => replayClaims({ db: repo.boardFile, root: repo.root, count: 1, freeBytes: () => 0 }), /needs \d+ free bytes/);
  assert.deepEqual(readdirSync(tmpdir()).sort(), before, 'the temp directory is unchanged');
});

test('api.io-claim-replay.real-path: replayClaims over a scratch board prints one line with p50, p95 and max for 50 claims [C7,#12097]', t => {
  const repo = cellRepo(t, { real: true });
  cellBoard(t, repo.boardFile, undefined, { real: true, gitRoot: repo.root });
  const line = replayLine(replayClaims({ db: repo.boardFile, root: repo.root, count: 50 }), 50);
  console.log(line);
  assert.match(line, /^claim replay: 50 claims p50 [\d.]+ ms, p95 [\d.]+ ms, max [\d.]+ ms$/);
});

const CODE = new URL('../../../../', import.meta.url).pathname;

test('api.io-claim-replay.compare-with-main: compareClaimsWithMain returns { candidate, main, verdict }, worse for a candidate with a 50 ms delay and same for an unchanged one [C7,#12385]', async t => {
  const repo = cellRepo(t, { real: true });
  cellBoard(t, repo.boardFile, undefined, { real: true, gitRoot: repo.root });
  const mainFigures = { p50: 4, p95: 8, max: 9 };
  const run = candidateFigures => compareClaimsWithMain({
    db: repo.boardFile, root: repo.root, code: 'candidate-tree', main: 'main',
    exportMain: () => 'main-tree',
    replay: ({ codeRoot }) => (codeRoot === 'main-tree' ? mainFigures : candidateFigures),
  });
  const same = await run({ p50: 4, p95: 9, max: 10 });
  assert.deepEqual(Object.keys(same).sort(), ['candidate', 'main', 'verdict']);
  assert.equal(same.verdict, 'same');
  const delayed = await run({ p50: 54, p95: 58.5, max: 60 });
  assert.equal(delayed.verdict, 'worse', 'a 50 ms delay is over main p95 + 50 ms');
  assert.equal((await run({ p50: 1, p95: 1001, max: 1001 })).verdict, 'worse', 'over 1 s is worse');
  const slowMain = await compareClaimsWithMain({ db: repo.boardFile, root: repo.root, code: 'c', exportMain: () => 'm', replay: ({ codeRoot }) => (codeRoot === 'm' ? { p50: 300, p95: 400, max: 400 } : { p50: 300, p95: 499, max: 499 }) });
  assert.equal(slowMain.verdict, 'same', 'under 1.25 x main p95 is same');
  assert.equal(slowMain.main.p95, 400);
});

test('api.io-claim-replay.compare-real-path: compareClaimsWithMain over a scratch board with main against main reports same and prints both p95s [C7,#12385]', async t => {
  const repo = cellRepo(t, { real: true });
  cellBoard(t, repo.boardFile, undefined, { real: true, gitRoot: repo.root });
  const result = await compareClaimsWithMain({ db: repo.boardFile, root: repo.root, code: CODE, exportMain: () => CODE, count: 20 });
  console.log(`claim compare: main p95 ${result.main.p95.toFixed(2)} ms, candidate p95 ${result.candidate.p95.toFixed(2)} ms, verdict ${result.verdict}`);
  assert.ok(result.main.p95 >= 0 && result.candidate.p95 >= 0);
  assert.equal(result.verdict, 'same');
});

test('api.io-claim-replay.trial-claims: trialClaims runs 20 rolled-back claims and returns p95 and CPU time with the board rows unchanged [C7,#12096]', t => {
  const repo = cellRepo(t, { real: true });
  cellBoard(t, repo.boardFile, undefined, { real: true, gitRoot: repo.root });
  const before = readFileSync(repo.boardFile);
  const { p95, cpuMs } = trialClaims({ db: repo.boardFile, root: repo.root, count: 20 });
  assert.ok(Number.isFinite(p95) && p95 >= 0, `a p95 in milliseconds: ${p95}`);
  assert.ok(Number.isFinite(cpuMs) && cpuMs >= 0, `a CPU figure in milliseconds: ${cpuMs}`);
  assert.ok(readFileSync(repo.boardFile).equals(before), 'the board rows are identical before and after');
});

test('api.io-claim-replay.trial-claims-line: trialLine over a scratch board trial returns one line with p95 and cpuMs for 20 claims [C7,#12096]', t => {
  const repo = cellRepo(t, { real: true });
  cellBoard(t, repo.boardFile, undefined, { real: true, gitRoot: repo.root });
  const line = trialLine(trialClaims({ db: repo.boardFile, root: repo.root, count: 20 }), 20);
  console.log(line);
  assert.match(line, /^claim trial: 20 claims p95 [\d.]+ ms, cpu [\d.]+ ms$/);
});

/** Run restartOnCodeMove through one code move with the given trial and report the order of its calls, its log lines and whether the restart finished. */
async function moveOnce(t, trial) {
  const order = [];
  const lines = [];
  let revision = 'a'.repeat(40);
  let judged;
  const done = new Promise((resolve) => { judged = resolve; });
  const fresh = restartOnCodeMove({ root: '.', revision: () => revision, interval: 5, drain: 1_000, handoff: true, trial,
    log: (line) => { lines.push(line); if (/refused|could not run/u.test(line)) judged(); },
    close: async () => { order.push('close'); },
    relaunch: async () => { order.push('relaunch'); return { pid: 7, listening: true }; } });
  const hold = setInterval(() => {}, 1_000); // the watcher's timer is unref'd; this test holds the loop open
  t.after(() => { clearInterval(hold); fresh.stop(); });
  revision = 'b'.repeat(40);
  const settled = await Promise.race([fresh.restarted.then(() => true), done.then(() => new Promise((resolve) => setTimeout(() => resolve(false), 60)))]);
  return { order, lines, settled };
}

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

test('api.io-claim-replay.restart-trial-real-claims: clause 3: restartOnCodeMove runs trialClaims over a scratch board of live shape before the handoff, refuses a new process whose claims are delayed 2 s each and hands over an undelayed one [C7,#12118]', async (t) => {
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
