/** The main facts cache finds its folder from Git's files and launches no git process for it, falling back to git when the files cannot answer [C7,#10823,#5329]. */
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { cachedMainFact } from '../../src/io/main-facts-cache.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../../gate/tests/fixtures/child.js';
import { runFixtureSetupGit } from '../../../gate/tests/fixtures/child.js';

const APIS = ['spawnSync', 'execFileSync', 'execSync', 'spawn', 'execFile', 'exec'];

/** A primary checkout with one commit and a linked worktree of it. */
function checkouts(t) {
  const dir = privateFixtureFiles('codemap-facts-cache-').root;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const primary = join(dir, 'primary');
  mkdirSync(primary);
  const run = (...args) => runFixtureGit(args, { cwd: primary });
  run('init', '-q', '-b', 'main');
  run('config', 'user.name', 't');
  run('config', 'user.email', 't@example.com');
  writeFileSync(join(primary, 'README.md'), 'fixture\n');
  run('add', '-A');
  runFixtureSetupGit(['commit', '-q', '-m', 'fixture'], { cwd: primary });
  const linked = join(dir, 'linked');
  run('worktree', 'add', '-q', '--detach', linked, 'main');
  return { primary, linked };
}

/** Open the cache for `root` and return the git launches that asked for the common directory. */
function opened(root, name) {
  const real = Object.fromEntries(APIS.map(api => [api, childProcess[api]]));
  let asks = 0;
  for (const api of APIS) {
    childProcess[api] = function counted(...args) {
      const words = Array.isArray(args[1]) ? args[1].map(String) : typeof args[0] === 'string' ? args[0].split(/\s+/u) : [];
      if (String(args[0]).trim().split(/\s+/u)[0].endsWith('git') && words.includes('--git-common-dir')) asks++;
      return real[api].apply(this, args);
    };
  }
  syncBuiltinESMExports();
  try {
    const value = cachedMainFact(root, name, ['fixture'], () => ({ ok: true }), fact => fact?.ok === true);
    assert.deepEqual(value, { ok: true });
    return asks;
  } finally {
    for (const api of APIS) childProcess[api] = real[api];
    syncBuiltinESMExports();
  }
}

/** The cache file Git's own answer names for a checkout. */
function expectedFile(root) {
  const common = runFixtureGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root });
  return join(realpathSync(common), 'pullboard-main-facts', 'facts.sqlite');
}

test('codemap.main-facts-cache.no-git-launch: clause 1: opening the main facts cache from a linked worktree and from the primary checkout launches no git process for the common directory [C7,#10823]', t => {
  const { primary, linked } = checkouts(t);
  assert.equal(opened(linked, 'linked'), 0);
  assert.equal(opened(primary, 'primary'), 0);
});

test('codemap.main-facts-cache.same-cache-path: clause 2: the cache file path is the same as on main for both checkouts, and a checkout whose files cannot answer still opens the cache through git [C7,#10823]', t => {
  const { primary, linked } = checkouts(t);
  opened(linked, 'linked');
  opened(primary, 'primary');
  assert.equal(existsSync(expectedFile(linked)), true);
  assert.equal(expectedFile(linked), expectedFile(primary));
  const gitDir = runFixtureGit(['rev-parse', '--path-format=absolute', '--git-dir'], { cwd: linked });
  rmSync(expectedFile(linked), { force: true });
  // A repository selected by environment is one Git's files may not answer for, so Git is asked.
  const before = process.env.GIT_DIR;
  process.env.GIT_DIR = gitDir;
  try { assert.ok(opened(linked, 'selected') >= 1, 'git was asked for the common directory'); }
  finally { if (before === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = before; }
  assert.equal(existsSync(expectedFile(linked)), true, 'the cache opened at the same path through git');
});
