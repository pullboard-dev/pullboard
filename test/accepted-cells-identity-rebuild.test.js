/** A stale accepted-inventory identity rebuilds from the pinned commit's own tooling instead of staying pending [C7]. */
import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  dirname,
  join,
} from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { test } from 'node:test';
import {
  acceptedCellsIdentity,
  nudgeAcceptedCells,
  readAcceptedCells,
  toolingIsPinned,
} from '../packages/gate/index.js';
import { acceptedInventoryKey } from '../packages/codemap/index.js';
import { git } from './cells-plan-fixture.js';

const REPO = new URL('..', import.meta.url).pathname;

/** Isolate the machine cache for one test and restore the caller's setting. */
function isolateMachine(t) {
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  const directory = mkdtempSync(join(tmpdir(), 'accepted-identity-machine-'));
  process.env.PULLBOARD_MACHINE_HOME = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

/** Build a real repository holding this checkout's tooling plus a cells plan, committed on main. */
function toolingRepo(t) {
  const root = mkdtempSync(join(tmpdir(), 'accepted-identity-repo-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = execFileSync('git', ['-C', REPO, 'ls-files', '-z', 'bin', 'packages', 'src', 'apps', 'package.json'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const file of files) {
    if (!existsSync(join(REPO, file))) continue;
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(join(REPO, file), join(root, file));
  }
  writeFileSync(join(root, 'bin/cells-plan.json'), '{}\n');
  git(root, 'init', '-q', '-b', 'main');
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
  const copy = mkdtempSync(join(tmpdir(), 'accepted-identity-copy-'));
  t.after(() => rmSync(copy, { recursive: true, force: true }));
  for (const dir of ['bin', 'packages', 'src', 'apps']) cpSync(join(root, dir), join(copy, dir), { recursive: true });
  writeFileSync(join(copy, 'package.json'), readFileSync(join(root, 'package.json')));
  const checker = join(copy, 'packages/gate/src/shell/module-imports.js');
  writeFileSync(checker, `${readFileSync(checker, 'utf8')}\n// modified tooling copy\n`);
  const identity = acceptedCellsIdentity(root, commit, { pinned: true }), key = acceptedInventoryKey(identity);
  assert.equal(toolingIsPinned(root, commit), true, 'this checkout carries the pinned tooling');
  const child = await nudgeAcceptedCells(root, pathToFileURL(join(copy, 'bin/main-audit.js')), commit);
  assert.ok(child, 'a producer was started from the copy');
  const record = await published(child, join(identity.directory, `${key}.ready.json`));
  assert.ok(record, 'the producer published a ready record');
  assert.equal(record.checker, identity.checker, 'the recorded checker is the pinned commit\'s, not the copy\'s');
  assert.equal(record.preloads, identity.preloads);
  assert.equal(readAcceptedCells(root, commit).descriptor?.checker, identity.checker);
});
