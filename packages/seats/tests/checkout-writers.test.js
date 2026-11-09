/**
 * Board writes never queue behind a slow command or a dead holder [B3,C7]. On 9 Nov the coordinator's hold, add and
 * edit waited over ten minutes: each held the checkout's lease for its whole run, so all of them queued behind a
 * `merged` that ran tests. These tests use a real Git checkout, the real resource queue and a real SQLite board.
 */
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import {
  spawn,
  spawnSync,
} from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import { createE2eHelpers } from '../../../test/e2e-helpers.js';
import { repoInfo } from '../../git/index.js';
import { listResources } from '../../resources/index.js';
import {
  beginImmediateQueued,
  boardWriteHolderText,
  configureBoardJournal,
  prepareBoardWriteIdentity,
} from '../../store/index.js';
import {
  bindLocalSession,
  checkoutWritersDirectory,
  liveCheckoutWriters,
} from '../src/shell/agent-session.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

const OWNER = createHash('sha256').update('checkout-writers-owner').digest('hex');
const NEWCOMER = createHash('sha256').update('checkout-writers-newcomer').digest('hex');

/** Run `work` with the fixture's machine home, so the resource queue is the sandbox's own. */
async function inBox(box, work) {
  const saved = { ...process.env };
  Object.assign(process.env, { PULLBOARD_MACHINE_HOME: box.env.PULLBOARD_MACHINE_HOME, PULLBOARD_HOME: box.env.PULLBOARD_HOME });
  try { return await work(); } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

/** The pid of a process that has already exited. */
function deadPid() {
  return spawnSync(process.execPath, ['-e', '']).pid;
}

/** Whether a promise settles within `ms`. */
async function settlesWithin(promise, ms) {
  let timer;
  const late = new Promise((done) => { timer = setTimeout(() => done('late'), ms); });
  try { return (await Promise.race([promise.then(() => 'settled'), late])) === 'settled'; } finally { clearTimeout(timer); }
}

test('same-session writes in one checkout run side by side while a takeover still waits for them [B3,C7]', { timeout: 60_000 }, async () => {
  const box = helpers.project();
  const info = repoInfo(box.web);
  await inBox(box, async () => {
    const slow = await bindLocalSession(info, { agent: 'web-1', digest: OWNER, keepLease: true });
    const started = performance.now();
    const quick = await bindLocalSession(info, { agent: 'web-1', digest: OWNER, keepLease: true });
    const waitedMs = performance.now() - started;
    assert.ok(waitedMs < 1_000, `a second same-session write waited ${Math.round(waitedMs)} ms behind the first`); // budget: declared ceiling, the 1 s board-write target; before this change it queued for the first write's whole run.
    const lease = listResources({ scope: 'repo', root: box.repo }).find((entry) => entry.name.startsWith('checkout-session:'));
    assert.equal(lease?.holders.length ?? 0, 0, 'neither running write keeps the checkout lease');
    assert.equal((await liveCheckoutWriters(info)).length, 2, 'each running write leaves its own writer record');

    // A record whose process is gone never holds anything up, and is removed when a takeover looks.
    writeFileSync(join(checkoutWritersDirectory(info), '00000000-0000-4000-8000-000000000000.json'), JSON.stringify({ version: 1, pid: deadPid(), at: Date.now() }));
    let recorded = false;
    const takeover = bindLocalSession(info, { agent: 'web-1', digest: NEWCOMER, takeover: true, keepLease: true, recordTakeover: async () => { recorded = true; } });
    assert.equal(await settlesWithin(takeover, 500), false, 'the takeover waits while the old session writes');
    assert.equal(recorded, false);
    assert.ok(existsSync(join(info.gitDir, 'pullboard-checkout-takeover')), 'the takeover announces itself before it waits');
    assert.equal(existsSync(join(checkoutWritersDirectory(info), '00000000-0000-4000-8000-000000000000.json')), false, 'the dead writer record is reclaimed');
    slow.release();
    assert.equal(await settlesWithin(takeover, 300), false, 'the takeover still waits for the second write');
    quick.release();
    const taken = await takeover;
    assert.equal(recorded, true);
    assert.equal(JSON.parse(readFileSync(join(info.gitDir, 'pullboard-checkout-session.json'), 'utf8')).digest, NEWCOMER);
    taken.release();
    assert.equal(existsSync(join(info.gitDir, 'pullboard-checkout-takeover')), false, 'the takeover removes its intent');
    await assert.rejects(bindLocalSession(info, { agent: 'web-1', digest: OWNER, keepLease: true }), { code: 'NOT_YOUR_CHECKOUT' });
    assert.deepEqual(readdirSync(checkoutWritersDirectory(info)), [], 'no writer record outlives its write');
  });
});

/** Start a child process that runs `source` against the board, and resolve once it prints ready. */
function boardChild(source, board) {
  const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', source, board], { stdio: ['pipe', 'pipe', 'inherit'] });
  child.closed = new Promise((done) => child.once('close', done));
  child.ready = new Promise((done, fail) => {
    child.stdout.setEncoding('utf8').on('data', (text) => { if (text.includes('ready')) done(); });
    child.once('close', (code) => fail(new Error(`board child exited ${code} before it was ready`)));
  });
  return child;
}

test('a board write lands in under 1 s past stale holder records, a long reader and a busy gate worker [C7]', { timeout: 60_000 }, async () => {
  const box = helpers.project(undefined, undefined, { withWorktree: false });
  const board = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  // Stale records like the 23 found on 9 Nov: dead writers, and a live pid whose start time is not the record's.
  const holders = board + '.write-holders';
  mkdirSync(holders, { recursive: true });
  const stale = [];
  for (let index = 0; index < 20; index += 1) {
    const pid = index === 0 ? process.pid : deadPid();
    const file = join(holders, `${pid}-${createHash('sha256').update(String(index)).digest('hex').slice(0, 8)}-0000-4000-8000-000000000000.json`);
    writeFileSync(file, JSON.stringify({ version: 1, pid, started: 'Mon Oct 26 14:56:00 2026', processSha256: 'a'.repeat(64),
      command: 'shout', seat: 'core-699', acquiredAt: Date.now() - 86_400_000, contender: true }) + '\n');
    stale.push(file);
  }
  // A reader that holds one read transaction open throughout, like a long state build.
  const reader = boardChild(`
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1], { readOnly: true });
    db.exec('BEGIN'); db.prepare('SELECT COUNT(*) FROM event').get();
    process.stdout.write('ready\\n');
    process.stdin.on('end', () => { db.exec('COMMIT'); db.close(); }).resume();`, board);
  // A gate worker that keeps reading and writing short transactions, like recordGateRun.
  const worker = boardChild(`
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA busy_timeout = 10000');
    let stop = false, writes = 0;
    process.stdin.on('end', () => { stop = true; }).resume();
    const beat = () => {
      if (stop) { db.close(); return; }
      db.prepare('SELECT COUNT(*) FROM item').get();
      db.exec('BEGIN IMMEDIATE');
      db.prepare("INSERT INTO board_meta(meta_key, meta_value) VALUES ('local:gate-worker-beat', ?) ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value").run(String(++writes));
      db.exec('COMMIT');
      if (writes === 3) process.stdout.write('ready\\n');
      setTimeout(beat, 5);
    };
    beat();`, board);
  try {
    await Promise.all([reader.ready, worker.ready]);
    const latencies = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const started = performance.now();
      const db = new DatabaseSync(board);
      try {
        db.exec('PRAGMA busy_timeout = 10000');
        configureBoardJournal(db);
        prepareBoardWriteIdentity();
        beginImmediateQueued(db, Date.now());
        db.prepare("INSERT INTO board_meta(meta_key, meta_value) VALUES ('local:write-latency', ?) ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value").run(String(attempt));
        db.exec('COMMIT');
      } finally { db.close(); }
      latencies.push(performance.now() - started);
    }
    const worst = Math.max(...latencies);
    assert.ok(worst < 1_000, `a board write took ${Math.round(worst)} ms with a reader and a gate worker active`); // budget: declared ceiling, the 9 Nov target of any board write under 1 s.
    assert.equal(boardWriteHolderText(board), '', 'no stale record is reported as a writer');
    for (const file of stale) assert.equal(existsSync(file), false, `${resolve(file)} is reclaimed`);
  } finally {
    reader.stdin.end();
    worker.stdin.end();
    await Promise.all([reader.closed, worker.closed]);
  }
  const db = new DatabaseSync(board, { readOnly: true });
  try { assert.equal(db.prepare("SELECT meta_value FROM board_meta WHERE meta_key = 'local:write-latency'").get().meta_value, '4'); }
  finally { db.close(); }
});
