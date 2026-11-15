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
import { after } from 'node:test';
import { test } from 'node:test';
import {
  acceptedCellsIdentity,
  nudgeAcceptedCells,
} from '../../../packages/gate/index.js';
import { acceptedInventoryKey } from '../../../packages/codemap/index.js';
import { git } from '../../../packages/landing/tests/fixtures/plan.js';
import { cleanupFixtureChildren } from '../../cli/tests/fixtures/child.js';
import { temporaryDirectory } from '../../cli/tests/fixtures/board.js';
import { temporaryRepository } from '../../cli/tests/fixtures/board/submit.js';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));

after(cleanupFixtureChildren);

/** Isolate the machine cache for one test and restore the caller's setting; a `shared` folder outlives the test. */
function isolateMachine(t, shared) {
  const previous = process.env.PULLBOARD_MACHINE_HOME, options = process.env.NODE_OPTIONS;
  // The runner's own preloads are foreign to the inventory fingerprint; the producer must see a plain Node.
  delete process.env.NODE_OPTIONS;
  const directory = shared ?? temporaryDirectory('accepted-identity-machine-');
  process.env.PULLBOARD_MACHINE_HOME = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = previous;
    if (options !== undefined) process.env.NODE_OPTIONS = options;
    if (!shared) rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

/** The checker's own tooling folders: the pinned fingerprint hashes exactly these, so a fixture needs no more to carry the pinned checker. */
const CHECKER_PATHS = ['packages/codemap', 'packages/kernel', 'packages/git', 'packages/gate/src'];

/** List this checkout's tracked files under some paths, skipping any that are gone from the working tree. */
function trackedFiles(...paths) {
  return execFileSync('git', ['-C', REPO, 'ls-files', '-z', ...paths], { encoding: 'utf8' }).split('\0').filter(file => file && existsSync(join(REPO, file)));
}

/** Copy tracked files from this checkout into a folder. */
function copyFiles(root, files) {
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(join(REPO, file), join(root, file));
  }
}

/** Code and data a producer needs to run: every tracked file under packages and apps except the test scripts. */
function runnableFiles() {
  return trackedFiles('packages', 'apps', 'package.json').filter(file => !(file.includes('/tests/') && file.endsWith('.js')));
}

/**
 * Build a real repository holding the checker's tooling plus a cells plan, committed on main; `runnable` adds the code a producer
 * runs from the pinned checkout.
 * Why not the whole checkout: the producer's census parses every file in this tree and cost about 95 s a case; the pinned
 * fingerprint covers only the checker folders, so the identity under test is unchanged.
 */
function toolingRepo(t, { runnable = false } = {}) {
  const root = temporaryRepository(t, 'accepted-identity-repo-');
  copyFiles(root, [...new Set([...trackedFiles(...CHECKER_PATHS, 'package.json'), ...(runnable ? runnableFiles() : [])])]);
  writeFileSync(join(root, 'packages/codemap/data/plan/cells.json'), '{}\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'fixture');
  return { root, commit: git(root, 'rev-parse', 'HEAD').trim() };
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
