/** Durable switch C: `pullboard land` runs its batch as a drive-cell job in its own process, never through bin/landing-worker.js [C7]. */
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import {
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { openBoard } from '../../../lib/index.js';
import {
  driveLanding,
  LANDING_RUN_KIND,
} from '../../../../packages/drive/index.js';
import {
  jobView,
  jobsOf,
} from '../../../../packages/jobs/index.js';
import {
  closeBoard,
  getItem,
} from '../../../../packages/store/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { captureCommandInProcess } from '../../tests/fixtures/process.js';
import { removeSandboxes } from '../../tests/fixtures/submit/handoff.js';
import { main } from '../../tests/fixtures/native.js';

/**
 * Record every node:child_process spawn while `work` runs, through the live ESM bindings every module imported.
 *
 * Why: the old path spawned `node bin/landing-worker.js guardian`; a recorded spawn naming that file is the proof.
 *
 * @param {() => Promise<any>} work
 * @returns {Promise<{ value: any, spawned: string[][] }>}
 */
async function recordingSpawns(work) {
  const original = childProcess.spawn;
  const spawned = [];
  childProcess.spawn = (command, args, ...rest) => { spawned.push([command, ...(Array.isArray(args) ? args : [])]); return original(command, args, ...rest); };
  syncBuiltinESMExports();
  try { return { value: await work(), spawned }; }
  finally { childProcess.spawn = original; syncBuiltinESMExports(); }
}

/** Add, submit and independently accept one item in a private repository with a native board. */
async function acceptedItem(t) {
  const helpers = createE2eHelpers();
  let board;
  // Close the board, then remove the tree with re-walking async retries: a background process the commands started
  // (a scheduled main audit, for one) can still write under the repository, and the synchronous cleanup never
  // re-walks, so it slept in its retry backoff past the 30 s file-exit ceiling (#3495).
  t.after(async () => {
    if (board) closeBoard(board);
    await removeSandboxes(helpers);
  });
  const box = helpers.project('true', helpers.sandbox({ declareFamilies: true }));
  /** The public CLI keeps its authorization, composition, proof writing and hooks. */
  const cli = (cwd, ...args) => captureCommandInProcess(main, args, { cwd, env: box.env });
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(box.repo, 'web/value.js'), 'export const value = 1;\n');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: private module');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const remote = join(box.dir, 'origin.git');
  box.git(box.dir, 'init', '-q', '--bare', remote);
  box.git(box.repo, 'remote', 'add', 'origin', remote);
  box.git(box.repo, 'push', '-q', '-u', 'origin', 'main');
  const added = await cli(box.repo, 'add', 'web', 'Change through the drive cell', '--specs', 'G1',
    '--criterion', 'The change marker exists.', '--check', 'test -f web/change.txt', '--wait', '--json');
  assert.equal(added.code, 0, added.err + added.out);
  const item = JSON.parse(added.out).item.item_id;
  const claim = await cli(box.web, 'claim', String(item));
  assert.equal(claim.code, 0, claim.err);
  writeFileSync(join(box.web, 'web/change.txt'), 'source change\n');
  box.git(box.web, 'add', '-A');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): drive-cell landing source [G1]');
  const submitted = await cli(box.web, 'submit', String(item), '--wait', '--no-next', '--json');
  assert.equal(submitted.code, 0, submitted.err + submitted.out);
  // @pullboard-board-file journey: the real CLI in this fixture repo owns the board file; the test seeds or reads that same file.
  board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'), undefined, { gitRoot: box.repo });
  const reviewer = join(box.dir, 'drive-reviewer');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, getItem(board, item).item_commit);
  // The board may route this item strong, and a strong verifier covers every route.
  const joined = await cli(reviewer, 'join', 'api', '--family', 'Fixture Review Vendor', '--route', 'strong', '--json');
  assert.equal(joined.code, 0, joined.err + joined.out);
  const reserved = await cli(reviewer, 'next', '--verify', String(item), '--json');
  assert.equal(reserved.code, 0, reserved.err + reserved.out);
  const accepted = await cli(reviewer, 'verify', String(item), 'accept', '--no-next', '--note', 'The frozen change-marker command passed.', '--json');
  assert.equal(accepted.code, 0, accepted.err + accepted.out);
  assert.equal(getItem(board, item).item_status, 'verified');
  return { ...box, board, item, cli };
}

test('clause 1: land runs through the drive cell [C7]', async t => {
  const box = await acceptedItem(t);
  const before = box.git(box.repo, 'rev-parse', 'main');
  const { value: landed, spawned } = await recordingSpawns(() => box.cli(box.repo, 'land', '--json'));
  assert.equal(landed.code, 0, landed.err + landed.out);
  // Every landing the worker did still happens: the accepted item is on main.
  assert.notEqual(getItem(box.board, box.item).item_merged_commit, null, landed.out);
  assert.notEqual(box.git(box.repo, 'rev-parse', 'main'), before);
  // The landing ran as one drive-cell job, started and finished under this command's lease.
  const runs = jobsOf(box.board.db, { kind: LANDING_RUN_KIND });
  assert.equal(runs.length, 1, JSON.stringify(runs));
  const [run] = runs;
  assert.equal(run.step, 'done');
  assert.equal(run.leaseOwner, null);
  assert.deepEqual(run.steps.map(step => step.name), ['started', 'finished']);
  assert.deepEqual(run.steps[1].payload.landed, [box.item]);
  // And no process was spawned for the old worker.
  assert.deepEqual(spawned.filter(argv => argv.some(arg => /landing-worker\.js$/u.test(String(arg)))), []);
});

test('a refused landing run writes its failed step and frees the job lease [C7]', async t => {
  const box = await acceptedItem(t);
  const refusal = Object.assign(new Error('the batch refused'), { code: 'LAND_TEST' });
  await assert.rejects(driveLanding(box.board.db, { owner: 'drive-test', id: 'land:run:refused', run: async () => { throw refusal; } }), refusal);
  const run = jobView(box.board.db, 'land:run:refused');
  assert.equal(run.kind, LANDING_RUN_KIND);
  assert.equal(run.leaseOwner, null);
  assert.deepEqual(run.steps.map(step => step.name), ['started', 'failed']);
  assert.equal(run.steps[1].payload.code, 'LAND_TEST');
});
