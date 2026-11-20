/** A runner root sweeps unleased job folders, trims an oversized cache oldest first, and keeps an absolute amount of the disk free [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sweepRunnerDisk } from '../../index.js';
import { assertDiskFree } from '../../index.js';
import { treeBytes } from '../../index.js';
import { processCensus } from '../../index.js';
import { takeResource } from '../../../../packages/resources/index.js';
import { acquireResourceApi } from '../../index.js';

const resources = { takeResource };
const MB = 1024 * 1024;
const OLD = Date.now() - 3 * 60 * 60 * 1000;

/** Write a file of a given size and age. */
function fill(path, megabytes, when = OLD) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, Buffer.alloc(megabytes * MB, 1));
  utimesSync(path, when / 1000, when / 1000);
}

/** Build a runner root with a live, a dead and an ownerless young job folder plus repos and cache. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pb-disk-sweep-'));
  const jobs = join(root, 'jobs');
  const me = processCensus().get(process.pid);
  mkdirSync(join(jobs, 'live-AAAAAA'), { recursive: true });
  writeFileSync(join(jobs, 'live-AAAAAA', 'worker-owner.json'), JSON.stringify({ pid: me.pid, started: me.started }));
  fill(join(jobs, 'live-AAAAAA', 'checkout', 'big.bin'), 4);
  writeFileSync(join(jobs, 'live-AAAAAA', 'source-cache-pin.json'), JSON.stringify({ version: 1, repoId: 'a'.repeat(64), roots: [] }));
  mkdirSync(join(jobs, 'dead-BBBBBB'), { recursive: true });
  writeFileSync(join(jobs, 'dead-BBBBBB', 'worker-owner.json'), JSON.stringify({ pid: 2 ** 22 - 3, started: 'Mon Jan 1 00:00:00 2001' }));
  fill(join(jobs, 'dead-BBBBBB', 'checkout', 'big.bin'), 4);
  writeFileSync(join(jobs, 'dead-BBBBBB', 'job-terminal.json'), '{}\n');
  // No owner record and no result: removed only once abandoned, after 24 quiet hours [#3734].
  const ABANDONED = Date.now() - 25 * 60 * 60 * 1000;
  fill(join(jobs, 'ownerless-CCCCCC', 'big.bin'), 4, ABANDONED);
  utimesSync(join(jobs, 'ownerless-CCCCCC'), ABANDONED / 1000, ABANDONED / 1000);
  fill(join(jobs, 'young-DDDDDD', 'big.bin'), 4, Date.now());
  writeFileSync(join(jobs, 'young-DDDDDD', 'extra'), '');
  fill(join(root, 'repos', 'a'.repeat(64) + '.git', 'pack'), 4);
  fill(join(root, 'repos', 'b'.repeat(64) + '.git', 'pack'), 4, OLD - 1000);
  fill(join(root, 'repos', 'c'.repeat(64) + '.git', 'pack'), 4, OLD + 1000);
  for (const [name, when] of [['a', OLD], ['b', OLD - 1000], ['c', OLD + 1000]]) {
    utimesSync(join(root, 'repos', name.repeat(64) + '.git'), when / 1000, when / 1000);
  }
  fill(join(root, 'cache', 'resource-pool', 'db'), 1);
  return { root, jobs, me };
}

/** Pretend the disk holds 100 MB more than what the root uses now, so free space follows real removals. */
function diskOf(root, spare) {
  const total = treeBytes(root) + spare;
  return () => ({ free: total - treeBytes(root), total });
}

test('runner.sweep.a-sweep-keeps-the-leased-folder-removes: a sweep keeps the leased folder, removes unleased ones and reports at least the free-space floor [C7]', async t => {
  const { root } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const total = treeBytes(root);
  const report = await sweepRunnerDisk(root, { api: resources, machineHome: join(root, 'machine'), diskFree: diskOf(root, total * 0.1), reposBudget: 1000 * MB, cacheBudget: 1000 * MB, minFreeBytes: Math.floor(total * 0.22) });
  assert.ok(existsSync(join(root, 'jobs', 'live-AAAAAA', 'checkout', 'big.bin')), 'the leased folder survives');
  assert.ok(existsSync(join(root, 'jobs', 'young-DDDDDD')), 'a folder too new to have an owner record survives');
  assert.ok(!existsSync(join(root, 'jobs', 'dead-BBBBBB')) && !existsSync(join(root, 'jobs', 'ownerless-CCCCCC')));
  assert.deepEqual(report.removedJobs.sort(), ['dead-BBBBBB', 'ownerless-CCCCCC']);
  assert.ok(report.freeBytes >= Math.floor(total * 0.22), `free ${report.freeBytes}`);
  assert.ok(existsSync(join(root, 'cache', 'resource-pool', 'db')), 'the lease database is never trimmed');
});

test('runner.sweep.an-oversized-repos-directory-is-trimmed-oldest: an oversized repos directory is trimmed oldest first and never trims a pinned repo [C7]', async t => {
  const { root } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pinned = treeBytes(join(root, 'repos', 'a'.repeat(64) + '.git'));
  const report = await sweepRunnerDisk(root, { api: resources, machineHome: join(root, 'machine'), diskFree: diskOf(root, 1000 * MB), reposBudget: pinned, cacheBudget: 1000 * MB });
  assert.deepEqual(report.trimmed.slice(0, 2), ['repos/' + 'b'.repeat(64), 'repos/' + 'c'.repeat(64)]);
  assert.ok(existsSync(join(root, 'repos', 'a'.repeat(64) + '.git')), 'the repo a live job pins stays');
});

test('runner.sweep.a-sweep-with-no-process-census-touches: a sweep with no process census touches nothing [C7]', async t => {
  const { root } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const report = await sweepRunnerDisk(root, { api: resources, machineHome: join(root, 'machine'), census: () => null, diskFree: diskOf(root, 0) });
  assert.equal(report.skipped, 'custody unavailable');
  assert.ok(existsSync(join(root, 'jobs', 'dead-BBBBBB')));
});

test('runner.sweep.a-job-is-refused-while-protected-data: a job is refused while protected data keeps the disk under the free-space floor after the sweep [C7]', async t => {
  const { root } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // The remaining disk is occupied outside the sweep's custody, so reclaiming fixtures cannot reach the floor.
  const report = await sweepRunnerDisk(root, { api: resources, machineHome: join(root, 'machine'), diskFree: () => ({ free: 10, total: 100 }), reposBudget: 1000 * MB, cacheBudget: 1000 * MB, minFreeBytes: 50 });
  assert.ok(report.freeBytes < 50);
  assert.throws(() => assertDiskFree(report, 50), error => error.code === 'RUNNER_DISK_FULL');
  assert.throws(() => assertDiskFree({ freeBytes: null }), { code: 'RUNNER_DISK_FULL' });
  assert.doesNotThrow(() => assertDiskFree({ freeBytes: 60 }, 50));
});


test('runner.sweep.a-repo-lease-serializes-sweeping-with-a: a repo lease serializes sweeping with a newly published job pin [C7]', async t => {
  const { root, jobs, me } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repoId = 'b'.repeat(64), pool = join(root, 'cache', 'resource-pool');
  const lease = await acquireResourceApi(resources, { name: `repo-${repoId}`, capacity: 1, scope: 'machine', root,
    repo: root, agent: 'fixture-pin', kind: 'source-cache' }, pool);
  let signal;
  const waiting = new Promise(resolveWait => { signal = resolveWait; });
  const sweeping = sweepRunnerDisk(root, { api: resources, machineHome: join(root, 'machine'),
    diskFree: diskOf(root, 1000 * MB), reposBudget: 0, cacheBudget: 1000 * MB,
    onLeaseWait: id => { if (id === repoId) signal(); } });
  await waiting;
  const job = join(jobs, 'new-live-EEEEEE');
  mkdirSync(job);
  writeFileSync(join(job, 'worker-owner.json'), JSON.stringify({ pid: me.pid, started: me.started }));
  writeFileSync(join(job, 'source-cache-pin.json'), JSON.stringify({ version: 1, repoId, roots: [] }));
  lease.release();
  await sweeping;
  assert.ok(existsSync(join(root, 'repos', `${repoId}.git`)), 'the pin published while the sweep waited protects the repository');
});

test('runner.sweep.an-actual-live-gate-lease-protects-its: an actual live gate lease protects its job even when the owner record is missing [C7]', async t => {
  const { root, jobs } = fixture(), machineHome = join(root, 'machine');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const id = '00000000-0000-4000-8000-000000000001', job = join(jobs, id + '-leased');
  mkdirSync(job); utimesSync(job, OLD / 1000, OLD / 1000);
  const lease = await acquireResourceApi(resources, { name: 'gate', capacity: 1, scope: 'machine', root,
    repo: root, agent: `pullboard-ssh-${id}`, kind: 'remote-command' }, machineHome);
  try {
    await sweepRunnerDisk(root, { api: resources, machineHome, diskFree: diskOf(root, 1000 * MB), reposBudget: 1000 * MB, cacheBudget: 1000 * MB });
    assert.ok(existsSync(job), 'the actual lease preserves its ownerless job folder');
  } finally { lease.release(); }
});
