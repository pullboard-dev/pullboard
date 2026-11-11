/** @pullboard-test-input apps/lib/src/io/main/audit.js */
/** @pullboard-world-pin: clause 1 reads the shipped producer source to prove it never blocks the lease renewal timer. */
/** A cells-inventory producer job reaches a result, or its lease lapses and another driver resumes it [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { cleanupFixtureChildren } from '../../../cli/tests/fixtures/child.js';
import { privateFixtureFiles } from '../../../cli/tests/fixtures/child.js';
import { runFixtureGit } from '../../../cli/tests/fixtures/child.js';
import { acceptedCellsFromJob } from '../../index.js';
import { closeBoard } from '../../index.js';
import { openBoard } from '../../index.js';
import { LEASE_MS } from '../../../../packages/jobs/index.js';
import { createJob } from '../../../../packages/jobs/index.js';
import { jobView } from '../../../../packages/jobs/index.js';
import { takeJob } from '../../../../packages/jobs/index.js';
import { writeStep } from '../../../../packages/jobs/index.js';
import { CELLS_INVENTORY_KIND } from '../../../../packages/drive/index.js';
import { keyedJobId } from '../../../../packages/drive/index.js';
import { keyedResult } from '../../../../packages/drive/index.js';
import { treeOf } from '../../../../packages/pin/index.js';

const files = privateFixtureFiles('pullboard-inventory-producer-');
after(async () => { await cleanupFixtureChildren(); rmSync(files.root, { recursive: true, force: true }); });

/** A one-commit repository whose tree names the inventory job. */
function repo() {
  const root = join(files.root, 'repo');
  files.write('repo/packages/a/index.js', 'export const a = 1;\n');
  runFixtureGit(['-C', root, 'init', '-q']);
  runFixtureGit(['-C', root, 'config', 'user.email', 'producer@example.test']);
  runFixtureGit(['-C', root, 'config', 'user.name', 'Producer Test']);
  runFixtureGit(['-C', root, 'add', '-A']);
  runFixtureGit(['-C', root, 'commit', '-q', '-m', 'first']);
  return { root, commit: runFixtureGit(['-C', root, 'rev-parse', 'HEAD']) };
}
const fixture = repo();

/** Open a real board file and hand its SQLite handle to the body. */
async function withBoard(name, body) {
  const board = openBoard(join(files.root, `${name}.sqlite`));
  try { return await body(board.db); } finally { closeBoard(board); }
}

test('clause 1: a producer that dies after produce.started lets its lease lapse and another driver resumes the job to a result, and a producer that throws frees the job at once [C7]', async () => {
  await withBoard('clause-1', async db => {
    const tree = treeOf(fixture.root, fixture.commit);
    const id = keyedJobId(CELLS_INVENTORY_KIND, tree);
    const start = 5_000_000;
    // A driver that took the job, wrote produce.started and died: its lease is still held.
    createJob(db, { id, kind: CELLS_INVENTORY_KIND, candidate: tree, now: start });
    assert.equal(takeJob(db, id, 'gate:job-1:111', { now: start }).taken, true);
    writeStep(db, id, 'produce.started', { owner: 'gate:job-1:111', attempt: 0 }, { seq: 0, now: start });
    let clock = start + 1000;
    const live = await keyedResult(db, { kind: CELLS_INVENTORY_KIND, key: tree, owner: 'gate:job-2:222', produce: () => assert.fail('a live lease is never stolen'),
      now: () => clock, waitMs: 3000, sleep: async ms => { clock += ms; } });
    assert.equal(live.state, 'pending', 'inside the lease the job waits on its holder');
    const resumed = await keyedResult(db, { kind: CELLS_INVENTORY_KIND, key: tree, owner: 'gate:job-2:222', produce: () => ({ tree, resumed: true }),
      now: () => start + LEASE_MS + 1, sleep: async () => {} });
    assert.equal(resumed.state, 'produced', 'once the dead producer\'s lease lapses another driver produces the result');
    assert.equal(jobView(db, id).steps.filter(step => step.name === 'produce.started').length, 2, 'the resumed attempt is its own produce.started step');
    assert.deepEqual(jobView(db, id).steps.find(step => step.name === 'result').payload.result, { tree, resumed: true });

    // A producer that throws releases the lease immediately, so the next driver needs no lease wait.
    const failing = 'e'.repeat(40);
    const failId = keyedJobId(CELLS_INVENTORY_KIND, failing);
    await assert.rejects(keyedResult(db, { kind: CELLS_INVENTORY_KIND, key: failing, owner: 'gate:job-3:333', produce: () => { throw new Error('checkout failed'); }, now: () => start }), /checkout failed/u);
    assert.equal(jobView(db, failId).leaseOwner ?? null, null, 'a failed producer holds no lease');
    const next = await keyedResult(db, { kind: CELLS_INVENTORY_KIND, key: failing, owner: 'gate:job-4:444', produce: () => ({ tree: failing }), now: () => start + 1, sleep: async () => assert.fail('no lease wait after a failed producer') });
    assert.equal(next.state, 'produced');
  });
});

test('clause 1: the pinned producer runs asynchronously so the lease renewal timer keeps firing while it works [C7]', () => {
  const code = readFileSync(new URL('../../src/io/main/audit.js', import.meta.url), 'utf8');
  assert.doesNotMatch(code, /spawnSync/u, 'a blocking spawn froze the renewal timer and let the lease of a live producer lapse');
});

test('clause 2: with a fresh main commit and a cold inventory, a gate gets a ready inventory through the job within the producer run, past a dead driver\'s lapsed lease [C7]', async () => {
  await withBoard('clause-2', async db => {
    const tree = treeOf(fixture.root, fixture.commit);
    const id = keyedJobId(CELLS_INVENTORY_KIND, tree);
    const start = 9_000_000;
    createJob(db, { id, kind: CELLS_INVENTORY_KIND, candidate: tree, now: start });
    takeJob(db, id, 'gate:dead:999', { now: start });
    writeStep(db, id, 'produce.started', { owner: 'gate:dead:999', attempt: 0 }, { seq: 0, now: start });
    let published = false, produced = 0;
    const read = () => published ? { available: true, descriptor: { digest: tree }, bytes: 1 } : { available: false, cause: 'missing-artifact' };
    const found = await acceptedCellsFromJob(db, fixture.root, fixture.commit, { owner: 'gate:live:1', read,
      produce: async () => { produced += 1; published = true; }, now: () => start + LEASE_MS + 1, sleep: async () => {} });
    assert.equal(found.available, true, 'the inventory is ready, not missing-artifact');
    assert.equal(produced, 1, 'one producer ran for the tree');
    assert.equal(found.state, 'produced');
  });
});
