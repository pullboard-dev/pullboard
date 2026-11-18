/** @pullboard-test-input apps/cli/src/io/submit/remote.js packages/gate/src/io/main/audit/nudge.js */
/** Durable gate 21: the cells inventory is a content-keyed job result, not a producer process [C7]. */
/** @pullboard-world-pin: clause 1 reads the shipped production callers to prove none nudges or waits on a producer process. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { cleanupFixtureChildren } from '../../../cli/tests/fixtures/child.js';
import { privateFixtureFiles } from '../../../cli/tests/fixtures/child.js';
import { runFixtureChildAsync } from '../../../cli/tests/fixtures/child.js';
import { runFixtureGit } from '../../../cli/tests/fixtures/child.js';
import { acceptedCellsFromJob } from '../../index.js';
import { closeBoard } from '../../index.js';
import { openBoard } from '../../index.js';
import { submitUntilSettled } from '../../index.js';
import { LEASE_MS } from '../../../../packages/jobs/index.js';
import { createJob } from '../../../../packages/jobs/index.js';
import { jobView } from '../../../../packages/jobs/index.js';
import { takeJob } from '../../../../packages/jobs/index.js';
import { writeStep } from '../../../../packages/jobs/index.js';
import { CELLS_INVENTORY_KIND } from '../../../../packages/drive/index.js';
import { cellsInventoryJob } from '../../../../packages/drive/index.js';
import { keyedJobId } from '../../../../packages/drive/index.js';
import { keyedResult } from '../../../../packages/drive/index.js';
import { treeOf } from '../../../../packages/pin/index.js';

const files = privateFixtureFiles('pullboard-durable-inventory-');
after(async () => { await cleanupFixtureChildren(); rmSync(files.root, { recursive: true, force: true }); });

/** A repository with a commit, an empty commit on the same tree, and a commit on a different tree. */
function repo() {
  const root = join(files.root, 'repo');
  files.write('repo/packages/a/index.js', 'export const a = 1;\n');
  runFixtureGit(['-C', root, 'init', '-q']);
  runFixtureGit(['-C', root, 'config', 'user.email', 'inventory@example.test']);
  runFixtureGit(['-C', root, 'config', 'user.name', 'Inventory Test']);
  runFixtureGit(['-C', root, 'add', '-A']);
  runFixtureGit(['-C', root, 'commit', '-q', '-m', 'first']);
  const first = runFixtureGit(['-C', root, 'rev-parse', 'HEAD']);
  runFixtureGit(['-C', root, 'commit', '-q', '--allow-empty', '-m', 'same tree']);
  const same = runFixtureGit(['-C', root, 'rev-parse', 'HEAD']);
  files.write('repo/packages/b/index.js', 'export const b = 2;\n');
  runFixtureGit(['-C', root, 'add', '-A']);
  runFixtureGit(['-C', root, 'commit', '-q', '-m', 'second tree']);
  const other = runFixtureGit(['-C', root, 'rev-parse', 'HEAD']);
  return { root, first, same, other };
}
const fixture = repo();

/** Open a real board file and hand its SQLite handle to the body. */
async function withBoard(name, body) {
  // @pullboard-board-file persistence: a killed driver process and the resumed one share this board file
  const board = openBoard(join(files.root, `${name}.sqlite`));
  try { return await body(board.db); } finally { closeBoard(board); }
}

/** The tree's file listing: the slow part of an inventory, saved as a part so a resumed driver skips it. */
function listing(tree) {
  return runFixtureGit(['-C', fixture.root, 'ls-tree', '-r', '--full-tree', tree]);
}

/** The inventory descriptor every driver must agree on for a tree. */
function descriptor(tree, list) {
  return { tree, files: list.split('\n').filter(Boolean).length, digest: createHash('sha256').update(list).digest('hex') };
}

/** A produce port that counts its calls and its listings, reusing a saved listing part when one exists. */
function producer() {
  const calls = { produced: 0, listed: 0 };
  return {
    calls,
    produce: ({ key, saved, save }) => {
      calls.produced += 1;
      let list = saved.get('files')?.list;
      if (list === undefined) { calls.listed += 1; list = save('files', { list: listing(key) }).list; }
      return descriptor(key, list);
    },
  };
}

test('lib.durable-inventory.the-cells-inventory-is-a-cells: clause 1: the cells inventory is a cells-inventory job keyed by the tree id; a gate reads the stored result or enqueues the job and waits on its lease, never on a background producer process [C7]', async () => {
  await withBoard('clause-1', async (db) => {
    const tree = treeOf(fixture.root, fixture.first);
    const port = producer();
    const first = await cellsInventoryJob(db, { repo: fixture.root, commit: fixture.first, owner: 'gate-a', produce: port.produce });
    assert.equal(first.state, 'produced', 'the first gate on a tree enqueues the job and produces it');
    assert.equal(first.job, keyedJobId(CELLS_INVENTORY_KIND, tree));
    assert.equal(first.key, tree, 'the job is keyed by the tree id, not the commit');
    assert.deepEqual(first.result, descriptor(tree, listing(tree)));
    const job = jobView(db, first.job);
    assert.equal(job.kind, 'cells-inventory');
    assert.equal(job.candidate, tree);

    const reused = await cellsInventoryJob(db, { repo: fixture.root, commit: fixture.same, owner: 'gate-b', produce: port.produce });
    assert.equal(reused.state, 'stored', 'a gate on another commit with the same tree reads the stored result');
    assert.deepEqual(reused.result, first.result);
    assert.equal(port.calls.produced, 1, 'the inventory for a tree is computed once');

    const otherTree = treeOf(fixture.root, fixture.other);
    const otherId = keyedJobId(CELLS_INVENTORY_KIND, otherTree);
    const now = 1_000_000;
    withHeldJob(db, otherId, otherTree, now);
    const sleeps = [];
    const waited = await cellsInventoryJob(db, { repo: fixture.root, commit: fixture.other, owner: 'gate-c', produce: port.produce,
      now: () => now + 1000, sleep: async (ms) => {
        sleeps.push(ms);
        writeStep(db, otherId, 'result', { result: descriptor(otherTree, listing(otherTree)), owner: 'driver-x' }, { now: now + 1000 });
      } });
    assert.equal(sleeps.length, 1, 'while another driver holds a live lease the gate waits on it');
    assert.equal(waited.state, 'stored', 'the gate gets the holder\'s result once written');
    assert.equal(waited.owner, 'driver-x');
    assert.equal(port.calls.produced, 1, 'a waiting gate never produces a second copy');

    const pendingTree = 'f'.repeat(40);
    const pendingId = keyedJobId(CELLS_INVENTORY_KIND, pendingTree);
    withHeldJob(db, pendingId, pendingTree, now);
    let clock = now;
    const pending = await keyedResult(db, { kind: CELLS_INVENTORY_KIND, key: pendingTree, owner: 'gate-d', produce: port.produce, waitMs: 3000,
      now: () => clock, sleep: async (ms) => { clock += ms; } });
    assert.equal(pending.state, 'pending', 'a bounded wait on a live lease returns pending, it never fails the gate');
    assert.equal(pending.holder, 'driver-x');
    assert.equal(port.calls.produced, 1);
  });
});

test('lib.durable-inventory.a-queued-gate-whose-cells-inventory: clause 1: a queued gate whose cells inventory is cold gets it through the tree\'s cells-inventory job and runs the same candidate again; no production caller nudges or waits on a producer process [C7]', async () => {
  await withBoard('clause-1-gate', async (db) => {
    const published = new Set();
    const produced = [];
    const read = (root, commit) => published.has(treeOf(root, commit)) ? { available: true, descriptor: { digest: treeOf(root, commit) }, bytes: 1 } : { available: false, cause: 'missing-artifact' };
    const produce = async (root, commit) => { produced.push(commit); published.add(treeOf(root, commit)); };
    const ran = [];
    const gate = () => submitUntilSettled(async () => {
      ran.push(1);
      const found = read(fixture.root, fixture.other);
      if (!found.available) throw Object.assign(new Error('accepted cells inventory is warming'), { code: 'CELLS_INVENTORY_PENDING', retryable: true, commit: fixture.other });
      return 'green';
    }, { waitInventory: commit => acceptedCellsFromJob(db, fixture.root, commit, { owner: 'gate-q', read, produce }), healthy: async () => assert.fail('an inventory wait spends no infrastructure retry') });
    const settled = await gate();
    assert.equal(settled.result, 'green', 'the same candidate runs again once the job made the inventory readable');
    assert.equal(ran.length, 2);
    assert.deepEqual(settled.attempts, [], 'the inventory wait is not an infrastructure attempt');
    assert.deepEqual(produced, [fixture.other], 'the job produced the inventory once, in this driver, under its lease');
    const job = jobView(db, keyedJobId(CELLS_INVENTORY_KIND, treeOf(fixture.root, fixture.other)));
    assert.equal(job.kind, 'cells-inventory');
    assert.equal(job.steps.find(step => step.name === 'result')?.payload.owner, 'gate-q', 'the result is a step on the keyed job row');

    published.clear();
    const rebuilt = await acceptedCellsFromJob(db, fixture.root, fixture.other, { owner: 'gate-r', read, produce });
    assert.equal(rebuilt.available, true, 'a stored result whose artifact is missing here is rebuilt, never a stall');
    assert.equal(rebuilt.state, 'rebuilt');

    for (const source of ['../../../cli/src/io/submit/remote.js', '../../../../packages/gate/src/io/main/audit/nudge.js']) {
      const code = readFileSync(new URL(source, import.meta.url), 'utf8');
      assert.doesNotMatch(code, /\b(?:nudgeAcceptedCells|waitForAcceptedCells)\b/u, `${source} no longer starts or waits on a background producer`);
    }
  });
});

/** Create a keyed job and take its lease as another driver, so a gate finds it held. */
function withHeldJob(db, id, key, now) {
  createJob(db, { id, kind: CELLS_INVENTORY_KIND, candidate: key, now });
  assert.equal(takeJob(db, id, 'driver-x', { now }).taken, true);
}

/** The producing driver run in its own process: it saves the listing part, says so on stderr, then hangs until killed. */
const CHILD = `
const [boardFile, repo, commit, appsUrl, driveUrl] = process.argv.slice(-5);
const { openBoard } = await import(appsUrl);
const { cellsInventoryJob } = await import(driveUrl);
const { execFileSync } = await import('node:child_process');
const board = openBoard(boardFile);
setInterval(() => {}, 1000);
await cellsInventoryJob(board.db, { repo, commit, owner: 'driver-a', renewMs: 50, produce: ({ key, save }) => {
  save('files', { list: execFileSync('git', ['-C', repo, 'ls-tree', '-r', '--full-tree', key], { encoding: 'utf8' }).trim() });
  process.stderr.write('saved\\n');
  return new Promise(() => {});
} });
`;

test('lib.durable-inventory.killing-the-producing-driver-mid-run: clause 2: killing the producing driver mid-run loses nothing; the next driver resumes the job and the gate gets the same result [C7]', async () => {
  const name = 'clause-2';
  const boardFile = join(files.root, `${name}.sqlite`);
  await withBoard(name, async () => {});
  const tree = treeOf(fixture.root, fixture.first);
  let killed = false;
  const run = runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', CHILD, '--', boardFile, fixture.root, fixture.first,
    new URL('../../index.js', import.meta.url).href, new URL('../../../../packages/drive/index.js', import.meta.url).href], {
    onStderrChunk: (part, child) => { if (!killed && part.includes('saved')) { killed = true; child.kill('SIGKILL'); } },
  });
  const ended = await run;
  assert.equal(ended.signal, 'SIGKILL', `the producing driver is killed mid-run: ${ended.stderr}`);

  await withBoard(name, async (db) => {
    const id = keyedJobId(CELLS_INVENTORY_KIND, tree);
    const before = jobView(db, id);
    assert.equal(before.leaseOwner, 'driver-a');
    assert.ok(!before.steps.some(step => step.name === 'result'), 'the dead driver wrote no result');
    assert.ok(before.steps.some(step => step.name === 'part.files'), 'the dead driver\'s saved work is on the row');

    const port = producer();
    const later = () => Date.now() + LEASE_MS + 10_000;
    const resumed = await cellsInventoryJob(db, { repo: fixture.root, commit: fixture.first, owner: 'driver-b', produce: port.produce, now: later });
    assert.equal(resumed.state, 'produced', 'once the lease lapses the next driver takes the job over');
    assert.equal(port.calls.listed, 0, 'the next driver resumes from the saved part and loses nothing');
    assert.deepEqual(resumed.result, descriptor(tree, listing(tree)), 'the gate gets the same result an uninterrupted run gives');

    const steps = jobView(db, id).steps.map(step => [step.name, step.seq, step.payload.owner ?? null]);
    assert.deepEqual(steps, [['produce.started', 0, 'driver-a'], ['part.files', 0, null], ['produce.started', 1, 'driver-b'], ['result', 0, 'driver-b']]);

    const gate = await cellsInventoryJob(db, { repo: fixture.root, commit: fixture.same, owner: 'gate-z', produce: port.produce, now: later });
    assert.equal(gate.state, 'stored');
    assert.deepEqual(gate.result, resumed.result, 'every later gate on the tree reuses the resumed result');
  });
});
