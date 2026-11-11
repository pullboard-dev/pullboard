/** A stale accepted-inventory identity rebuilds from the pinned commit's own tooling instead of staying pending [C7]. */
import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  join,
} from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { after } from 'node:test';
import { test } from 'node:test';
import {
  acceptedCellsIdentity,
  nudgeAcceptedCells,
  readAcceptedCells,
  toolingIsPinned,
} from '../../../packages/gate/index.js';
import { acceptedInventoryKey } from '../../../packages/codemap/index.js';
import { git } from '../../../packages/landing/tests/fixtures/plan.js';
import { cleanupFixtureChildren } from '../../cli/tests/fixtures/child.js';
import { fixtureChildMessage } from '../../cli/tests/fixtures/child.js';
import { runFixtureChildAsync } from '../../cli/tests/fixtures/child.js';
import { temporaryDirectory } from '../../cli/tests/fixtures/board.js';
import { temporaryRepository } from '../../cli/tests/fixtures/board/submit.js';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));

after(cleanupFixtureChildren);

/** Isolate the machine cache for one test and restore the caller's setting. */
function isolateMachine(t) {
  const previous = process.env.PULLBOARD_MACHINE_HOME, options = process.env.NODE_OPTIONS;
  // The runner's own preloads are foreign to the inventory fingerprint; the producer must see a plain Node.
  delete process.env.NODE_OPTIONS;
  const directory = temporaryDirectory('accepted-identity-machine-');
  process.env.PULLBOARD_MACHINE_HOME = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = previous;
    if (options !== undefined) process.env.NODE_OPTIONS = options;
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

/** Build a real repository holding this checkout's tooling plus a cells plan, committed on main. */
function toolingRepo(t) {
  const root = temporaryRepository(t, 'accepted-identity-repo-');
  const files = execFileSync('git', ['-C', REPO, 'ls-files', '-z', 'packages', 'apps', 'package.json'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const file of files) {
    if (!existsSync(join(REPO, file))) continue;
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(join(REPO, file), join(root, file));
  }
  writeFileSync(join(root, 'packages/codemap/data/plan/cells.json'), '{}\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'fixture');
  return { root, commit: git(root, 'rev-parse', 'HEAD').trim() };
}

/** Wait for the detached producer to exit, then read its ready record if it published one. */
async function published(child, file) {
  child.ref();
  await once(child, 'exit');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

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

test('clause 2: a producer nudged from a modified tooling copy records the pinned commit\'s checker and preloads [C7]', { timeout: 590_000 }, async t => {
  isolateMachine(t);
  const { root, commit } = toolingRepo(t);
  const copy = temporaryDirectory('accepted-identity-copy-');
  t.after(() => rmSync(copy, { recursive: true, force: true }));
  for (const dir of ['packages', 'apps']) cpSync(join(root, dir), join(copy, dir), { recursive: true });
  writeFileSync(join(copy, 'package.json'), readFileSync(join(root, 'package.json')));
  const checker = join(copy, 'packages/codemap/src/io/module/imports.js');
  writeFileSync(checker, `${readFileSync(checker, 'utf8')}\n// modified tooling copy\n`);
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

/** Copy the fixture's tooling into a fresh folder and change one checker file, as a candidate that edits the gate does. */
function modifiedToolingCopy(t, root) {
  const copy = temporaryDirectory('accepted-identity-candidate-');
  t.after(() => rmSync(copy, { recursive: true, force: true }));
  for (const dir of ['packages', 'apps']) cpSync(join(root, dir), join(copy, dir), { recursive: true });
  writeFileSync(join(copy, 'package.json'), readFileSync(join(root, 'package.json')));
  const checker = join(copy, 'packages/codemap/src/io/module/imports.js');
  writeFileSync(checker, `${readFileSync(checker, 'utf8')}\n// candidate changes the checker\n`);
  return copy;
}

test('a gate whose own checker files differ from the pinned main gets the inventory its cells-inventory job built from the pinned tooling, never a pending stop [C7]', { timeout: 590_000 }, async t => {
  const machine = isolateMachine(t);
  const { root, commit } = toolingRepo(t);
  const copy = modifiedToolingCopy(t, root);
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
