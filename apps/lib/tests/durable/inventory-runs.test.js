/** The cells inventory job reads and writes its rows in the runs file while runs_store is on, and on the board otherwise [P7,#9112]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { cleanupFixtureChildren } from '../../../cli/tests/fixtures/child.js';
import { privateFixtureFiles } from '../../../cli/tests/fixtures/child.js';
import { runFixtureGit } from '../../../cli/tests/fixtures/child.js';
import { acceptedCellsFromJob } from '../../index.js';
import { withFixtureBoard } from '../fixtures/board.js';
import { jobView } from '../../../../packages/jobs/index.js';
import { CELLS_INVENTORY_KIND } from '../../../../packages/drive/index.js';
import { keyedJobId } from '../../../../packages/drive/index.js';
import { openRunsStore } from '../../../../packages/store/index.js';
import { treeOf } from '../../../../packages/pin/index.js';

const files = privateFixtureFiles('pullboard-inventory-runs-');
after(async () => { await cleanupFixtureChildren(); rmSync(files.root, { recursive: true, force: true }); });

/** A repository with one commit. */
function repo() {
  const root = join(files.root, 'repo');
  files.write('repo/packages/a/index.js', 'export const a = 1;\n');
  runFixtureGit(['-C', root, 'init', '-q']);
  runFixtureGit(['-C', root, 'config', 'user.email', 'inventory@example.test']);
  runFixtureGit(['-C', root, 'config', 'user.name', 'Inventory Test']);
  runFixtureGit(['-C', root, 'add', '-A']);
  runFixtureGit(['-C', root, 'commit', '-q', '-m', 'first']);
  return { root, commit: runFixtureGit(['-C', root, 'rev-parse', 'HEAD']) };
}
const fixture = repo();

/** The ports of an inventory that is cold until produced. */
function ports() {
  const published = new Set();
  const read = (root, commit) => published.has(treeOf(root, commit)) ? { available: true, descriptor: { digest: treeOf(root, commit) }, bytes: 1 } : { available: false, cause: 'missing-artifact' };
  const produce = async (root, commit) => { published.add(treeOf(root, commit)); };
  return { read, produce, published };
}

/** Run the body on a real board file and a runs holder over an in-memory runs store. */
async function withStores(name, body) {
  const runs = { db: openRunsStore(':memory:', { boardId: 'inventory-runs' }) };
  try { return await withFixtureBoard(join(files.root, `${name}.sqlite`), board => body(board.db, runs)); } finally { runs.db.close(); }
}

const jobId = () => keyedJobId(CELLS_INVENTORY_KIND, treeOf(fixture.root, fixture.commit));

test('clause 1: with runs_store on, the cells inventory job row is in the runs file and not on the board [P7,#9112]', async () => {
  await withStores('clause-1-on', async (db, runs) => {
    const given = ports();
    const found = await acceptedCellsFromJob(db, fixture.root, fixture.commit, { owner: 'gate-on', runs, ...given });
    assert.equal(found.available, true);
    const held = jobView(runs.db, jobId());
    assert.equal(held?.kind, 'cells-inventory');
    assert.equal(held.steps.find(step => step.name === 'result')?.payload.owner, 'gate-on', 'the result step is on the runs file');
    assert.equal(jobView(db, jobId()), null, 'the board holds no inventory job row');
    given.published.clear();
    const again = await acceptedCellsFromJob(db, fixture.root, fixture.commit, { owner: 'gate-on-2', runs, ...given });
    assert.equal(again.job, jobId(), 'a second driver finds the stored result through the runs file');
    assert.equal(again.state, 'rebuilt');
  });
});

test('clause 1: with runs_store off, the same call keeps the job row on the board [P7,#9112]', async () => {
  await withStores('clause-1-off', async (db, runs) => {
    await acceptedCellsFromJob(db, fixture.root, fixture.commit, { owner: 'gate-off', ...ports() });
    assert.equal(jobView(db, jobId())?.steps.find(step => step.name === 'result')?.payload.owner, 'gate-off');
    assert.equal(jobView(runs.db, jobId()), null, 'the runs file is untouched');
  });
});
