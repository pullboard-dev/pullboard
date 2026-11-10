/**
 * Board writes never queue behind a slow command or a dead holder [B3,C7]. On 9 Nov the coordinator's hold, add and
 * edit waited over ten minutes: each held the checkout's lease for its whole run, so all of them queued behind a
 * `merged` that ran tests. This test uses a real Git checkout and the real resource queue.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { cellProject } from '../../../store/tests/fixtures/cell.js';
import { repoInfo } from '../../../git/index.js';
import { listResources } from '../../../resources/index.js';
import {
  bindLocalSession,
  checkoutWritersDirectory,
  liveCheckoutWriters,
} from '../../src/io/agent/session.js';

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

test('same-session writes in one checkout run side by side while a takeover still waits for them [B3,C7]', { timeout: 60_000 }, async t => {
  const box = cellProject(t);
  const web = join(box.dir, 'web-1');
  box.git(box.repo, 'worktree', 'add', '-q', '-b', 'web/one', web, 'main');
  const info = repoInfo(web);
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
