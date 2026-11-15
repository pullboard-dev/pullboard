/** A stale accepted-inventory identity rebuilds from the pinned commit's own tooling through a real producer instead of staying pending [C7]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { after } from 'node:test';
import { test } from 'node:test';
import {
  acceptedCellsIdentity,
  nudgeAcceptedCells,
  readAcceptedCells,
  toolingIsPinned,
} from '../../../../packages/gate/index.js';
import { acceptedInventoryKey } from '../../../../packages/codemap/index.js';
import { git } from '../../../../packages/landing/tests/fixtures/plan.js';
import { cleanupFixtureChildren } from '../../../cli/tests/fixtures/child.js';
import { fixtureChildMessage } from '../../../cli/tests/fixtures/child.js';
import { runFixtureChildAsync } from '../../../cli/tests/fixtures/child.js';
import { temporaryDirectory } from '../../../cli/tests/fixtures/board.js';
import {
  isolateMachine,
  modifiedToolingCopy,
  toolingRepo,
} from '../fixtures/test/rebuild.js';

after(cleanupFixtureChildren);

/** One runnable repository and machine cache for the producer cases: the census runs once, and the second case builds on it. */
let sharedProducer = null;
/** Cleanup for the shared producer fixture, run once when the file ends. */
const sharedCleanups = [];
after(() => { for (const work of sharedCleanups.reverse()) work(); });

/** Build (once) the producer cases' repository; its child commit changes only a file outside the checker, so its inventory is a new one. */
function producerFixture() {
  if (sharedProducer) return sharedProducer;
  const owner = { after: work => sharedCleanups.push(work) };
  const machine = temporaryDirectory('accepted-identity-machine-');
  sharedCleanups.push(() => rmSync(machine, { recursive: true, force: true }));
  const { root, commit } = toolingRepo(owner, { runnable: true });
  writeFileSync(join(root, 'fixture-note.txt'), 'a later accepted commit\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'fixture: later commit');
  sharedProducer = { machine, root, commit, later: git(root, 'rev-parse', 'HEAD').trim() };
  return sharedProducer;
}

/** Wait for the detached producer to exit, then read its ready record if it published one. */
async function published(child, file) {
  child.ref();
  await once(child, 'exit');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

test('clause 2: a producer nudged from a modified tooling copy records the pinned commit\'s checker and preloads [C7]', { timeout: 590_000 }, async t => {
  const { machine, root, commit } = producerFixture();
  isolateMachine(t, machine);
  const copy = modifiedToolingCopy(t, 'modified tooling copy');
  const identity = acceptedCellsIdentity(root, commit, { pinned: true }), key = acceptedInventoryKey(identity);
  assert.equal(toolingIsPinned(root, commit), true, 'this checkout carries the pinned tooling');
  const child = await nudgeAcceptedCells(root, pathToFileURL(join(copy, 'apps/cli/src/io/landing/audit.js')), commit);
  assert.ok(child, 'a producer was started from the copy');
  const record = await published(child, join(identity.directory, `${key}.ready.json`));
  const failure = [join(identity.directory, `${key}.failure.json`), join(identity.directory, `${commit}.failure.json`)].find(existsSync) ?? '';
  assert.ok(record, `the producer published a ready record: ${failure ? readFileSync(failure, 'utf8') : 'no failure recorded'}`);
  assert.equal(record.checker, identity.checker, 'the recorded checker is the pinned commit\'s, not the copy\'s');
  assert.equal(record.preloads, identity.preloads);
  assert.equal(readAcceptedCells(root, commit).descriptor?.checker, identity.checker);
});

test('a gate whose own checker files differ from the pinned main gets the inventory its cells-inventory job built from the pinned tooling, never a pending stop [C7]', { timeout: 590_000 }, async t => {
  const { machine, root, later: commit } = producerFixture();
  isolateMachine(t, machine);
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
