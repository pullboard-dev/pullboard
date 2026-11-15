/** A stale accepted-inventory identity rebuilds from the pinned commit's own tooling instead of staying pending [C7]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { git } from '../../../packages/landing/tests/fixtures/plan.js';
import {
  cleanupFixtureChildren,
  fixtureChildMessage,
  runFixtureChildAsync,
} from '../../cli/tests/fixtures/child.js';
import { temporaryDirectory } from '../../cli/tests/fixtures/board.js';
import { pathToFileURL } from 'node:url';
import { after } from 'node:test';
import { test } from 'node:test';
import {
  acceptedCellsIdentity,
  nudgeAcceptedCells,
  readAcceptedCells,
  toolingIsPinned,
} from '../../../packages/gate/index.js';
import { acceptedInventoryKey } from '../../../packages/codemap/index.js';
import {
  isolateMachine,
  modifiedToolingCopy,
  toolingRepo,
} from './fixtures/test/rebuild.js';

after(cleanupFixtureChildren);

test('clause 1: nudgeAcceptedCells treats a ready record whose checker differs from the identity as absent and starts a producer [C7]', { timeout: 120_000 }, async t => {
  isolateMachine(t);
  const { root, commit } = toolingRepo(t);
  const identity = acceptedCellsIdentity(root, commit, { pinned: true }), key = acceptedInventoryKey(identity);
  mkdirSync(identity.directory, { recursive: true });
  writeFileSync(join(identity.directory, `${key}.inventory.gz`), 'x');
  const stat = { bytes: 1, modified: 0 };
  const seed = { version: 1, tree: identity.tree, checker: '0'.repeat(64), preloads: identity.preloads, key, ...stat };
  writeFileSync(join(identity.directory, `${key}.ready.json`), JSON.stringify(seed));
  const missing = await nudgeAcceptedCells(root, pathToFileURL(join(root, 'bin/no-such-worker.js')), commit).catch(error => error);
  assert.ok(missing && missing !== null, 'a stale ready record must not read as ready: the nudge must try a producer');
  assert.ok(readFileSync(join(identity.directory, `${key}.owner.json`), 'utf8').includes(identity.tree), 'the producer ownership was recorded');
});

test('a gate whose own checker files differ from the pinned main gets the inventory its cells-inventory job built from the pinned tooling, never a pending stop [C7]', { timeout: 590_000 }, async t => {
  const machine = isolateMachine(t);
  const { root, commit: pinnedCommit } = toolingRepo(t, { runnable: true });
  writeFileSync(join(root, 'fixture-note.txt'), 'a later accepted commit\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'fixture: later commit');
  const commit = git(root, 'rev-parse', 'HEAD').trim();
  const copy = modifiedToolingCopy(t, 'candidate changes the checker');
  const boards = temporaryDirectory('accepted-identity-board-');
  t.after(() => rmSync(boards, { recursive: true, force: true }));
  const pinned = acceptedCellsIdentity(root, commit, { pinned: true });
  // The hand-off worker runs the candidate's tooling: this entry imports the modified copy, never this checkout.
  const entry = join(copy, 'inventory-gate-entry.mjs');
  writeFileSync(entry, `import { acceptedCellsFromJob, closeBoard, openBoard } from './apps/lib/index.js';
import { toolingIsPinned } from './packages/gate/index.js';
const [root, commit, file] = process.argv.slice(2);
const board = openBoard(file);
try {
  const pinnedHere = toolingIsPinned(root, commit);
  const got = await acceptedCellsFromJob(board.db, root, commit, { owner: 'gate:candidate' });
  process.stdout.write(JSON.stringify({ pinnedHere, available: got.available, waited: got.waited, state: got.state, checker: got.descriptor?.checker, preloads: got.descriptor?.preloads }));
} catch (error) {
  process.stdout.write(JSON.stringify({ code: error.code ?? null, message: error.message }));
} finally { closeBoard(board); }
`);
  const env = { ...process.env, PULLBOARD_MACHINE_HOME: machine };
  delete env.NODE_OPTIONS;
  const ran = await runFixtureChildAsync(process.execPath, [entry, root, commit, join(boards, 'board.sqlite')], { cwd: copy, env });
  assert.equal(ran.status, 0, fixtureChildMessage(ran));
  const got = JSON.parse(ran.stdout);
  assert.equal(got.pinnedHere, false, 'the gate runs tooling that differs from the pinned main');
  assert.equal(got.code, undefined, `the gate got the inventory instead of a stop: ${got.message}`);
  assert.equal(got.available, true);
  assert.equal(got.state, 'produced', 'the missing identity enqueued the cells-inventory job and this driver produced it');
  assert.equal(got.checker, pinned.checker, 'the inventory carries the pinned main\'s checker, not the candidate\'s');
  assert.equal(got.preloads, pinned.preloads);
  assert.equal(readAcceptedCells(root, commit).descriptor?.checker, pinned.checker, 'any later reader finds it by the commit alone');
});
