/** The coordinator gate worker reuses a kept checkout, and never a dirty one, through the real hand-off worker [C7]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { statSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { gateDriveWorkerEntry } from '../../../bin/gate-drive-worker.js';
import { admitGateDrive } from '../../../packages/drive/index.js';
import { getItem } from '../../../packages/store/index.js';
import { submitHandoff } from '../../../packages/store/index.js';
import { writeBoardCommand } from '../../../packages/store/index.js';
import { createE2eHelpers } from '../../../test/e2e-helpers.js';
import { runFixtureChildAsync } from '../../../test/fixture-child.js';
import { fixtureAdd } from '../../../test/testkit-fixture.js';
import { fixtureOpenBoard } from '../../../test/testkit-fixture.js';
import { fixtureHandoffPolicy } from '../../../test/testkit-fixture.js';

/** Demand a genuine CLI success before reading its native document. */
function document(result) {
  assert.equal(result.code, 0, result.err + result.out);
  return JSON.parse(result.out);
}

/** The kept checkouts' folders, as the pool holds them between gates. */
function keptCheckouts(commonDir) {
  const pool = join(commonDir, 'pullboard', 'gate-checkouts');
  return existsSync(pool) ? readdirSync(pool).filter(name => !name.startsWith('.')).map(name => join(pool, name)) : [];
}

/**
 * Add, claim and build one item on its own commit off main, queue its submit and run the real gate driver for it.
 * Returns the gate's checkout line and the item's job folder.
 */
async function driveOneGate(box, board, commonDir, n) {
  const id = document(fixtureAdd(box.run, box.repo, 'web', `Warm gate ${n}`, '--specs', 'G1',
    '--criterion', 'The page is ready.', '--check', 'node check.cjs', '--brief',
    `Files: web/page.txt\nTest: gate ${n} submits the committed page.`, '--wait', '--json')).item.item_id;
  document(box.run(box.web, 'claim', String(id), '--json'));
  box.git(box.web, 'reset', '-q', '--hard', 'main');
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(join(box.web, 'web', `gate-${n}.txt`), `${n}\n`);
  assert.equal(commitPage(box, n).status, 0);
  const item = getItem(board, id);
  const commit = box.git(box.web, 'rev-parse', 'HEAD');
  const tree = box.git(box.web, 'rev-parse', 'HEAD^{tree}');
  const queued = writeBoardCommand(board, 'queueSubmitHandoff', [id, {
    agentId: item.item_owner, job: randomUUID(), main: box.git(box.web, 'rev-parse', 'main'),
    commit, tree, executionCommit: commit, executionTree: tree, digest: item.item_frozen_digest,
    companionDigest: null, leaseMs: 7_200_000,
  }], item.item_owner);
  const directory = join(commonDir, 'pullboard/submit-handoffs', queued.job.id);
  mkdirSync(directory, { recursive: true });
  const request = join(directory, 'request.json');
  writeFileSync(request, JSON.stringify({ item: id, job: queued.job.id, commonDir, commit }));
  const owner = `test-driver:${queued.job.id}`;
  admitGateDrive(board.db, queued.job.id, { owner });
  // budget: the existing owned-worker hang ceiling; assertions concern the checkout and native results, not elapsed time.
  const result = await runFixtureChildAsync(process.execPath, [gateDriveWorkerEntry(), request, owner],
    { cwd: box.web, env: box.env, encoding: 'utf8', timeout: 120_000 });
  assert.equal(result.status, 0, result.context);
  assert.equal(submitHandoff(board, id).state, 'green', result.context);
  assert.equal(getItem(board, id).item_status, 'submitted');
  assert.equal(existsSync(join(directory, 'source')), false, 'the gate gives its checkout back');
  const line = /PULLBOARD_GATE_CHECKOUT (\{.*\})/u.exec(result.stderr);
  assert.ok(line, result.context);
  return { checkout: JSON.parse(line[1]), commit };
}

/** Commit the page and this gate's own file on the builder checkout. */
function commitPage(box, n) {
  writeFileSync(join(box.web, 'web', 'page.txt'), 'ready\n');
  box.git(box.web, 'add', '-A');
  return box.tryGit(box.web, 'commit', '-q', '-m', `feat(web): ready page ${n} [G1]`);
}

test('clause 1: the coordinator gate reuses a kept checkout, writing only changed files, and discards a dirty one [C7]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const isolated = helpers.sandbox();
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete isolated.env[key];
  const box = helpers.project('true', isolated);
  box.boardFile = fixtureHandoffPolicy(box, helpers.CONFIG);
  // The check fails if the gate can see a file another gate left behind.
  writeFileSync(join(box.repo, 'check.cjs'), "const fs=require('node:fs');require('node:assert/strict').equal(fs.readFileSync('web/page.txt','utf8'),'ready\\n');"
    + "if(fs.existsSync('stray.txt'))throw new Error('the gate sees another gate\\'s file');\n");
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-qm', 'test: warm gate checkout fixture [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const commonDir = join(box.repo, '.git');
  const board = fixtureOpenBoard(box);
  t.after(() => board.db.close());

  const first = await driveOneGate(box, board, commonDir, 1);
  assert.equal(first.checkout.reused, false, 'the first gate has no kept checkout and adds one');
  const [kept] = keptCheckouts(commonDir);
  assert.equal(keptCheckouts(commonDir).length, 1, 'the clean checkout is kept for the next gate');
  const unchanged = statSync(join(kept, 'check.cjs')).ino;

  const second = await driveOneGate(box, board, commonDir, 2);
  assert.equal(second.checkout.reused, true, 'the second gate reuses the kept checkout');
  assert.equal(second.checkout.from, first.commit);
  // Gate 1's commit and gate 2's differ by web/gate-1.txt removed and web/gate-2.txt added: two files, not the tree.
  assert.equal(second.checkout.written, 2);
  const [again] = keptCheckouts(commonDir);
  assert.equal(keptCheckouts(commonDir).length, 1);
  assert.equal(statSync(join(again, 'check.cjs')).ino, unchanged, 'a file that did not change was not rewritten');
  assert.equal(readFileSync(join(again, 'web', 'gate-2.txt'), 'utf8'), '2\n');
  assert.equal(existsSync(join(again, 'web', 'gate-1.txt')), false);

  // A dirty kept checkout is discarded, never reused: the third gate cannot see its stray file and adds a fresh one.
  writeFileSync(join(again, 'stray.txt'), 'left by another gate\n');
  const third = await driveOneGate(box, board, commonDir, 3);
  assert.equal(third.checkout.reused, false, 'the dirty checkout was discarded rather than reused');
  assert.equal(existsSync(again), false, 'the dirty checkout is gone');
  const [fresh] = keptCheckouts(commonDir);
  assert.equal(keptCheckouts(commonDir).length, 1);
  assert.equal(existsSync(join(fresh, 'stray.txt')), false);
  assert.notEqual(statSync(join(fresh, 'check.cjs')).ino, unchanged);
});
