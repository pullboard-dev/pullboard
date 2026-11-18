/** Opening a new item folder with no spare launches at most 3 git processes and makes the same folder as before [C7,#10821,#5329]. */
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { openItemFolder } from '../../../src/io/item/folder.js';
import { itemFolderPath } from '../../../src/io/item/folder.js';
import { gitPath } from '../../../../../packages/git/index.js';
import { repoInfo } from '../../../../../packages/git/index.js';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { runFixtureGit } from '../../fixtures/child.js';
import { policyRepository } from '../../../../../packages/store/tests/fixtures/submit.js';

const ME = { id: 'core-1', lane: 'core' };
const APIS = ['spawnSync', 'execFileSync', 'execSync', 'spawn', 'execFile', 'exec'];

/** A repository with one commit, and a seat that is a linked worktree of it with no spare beside it. */
function repository(t) {
  const root = privateFixtureFiles('pullboard-item-folder-').root;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const primary = join(root, 'primary');
  mkdirSync(primary);
  policyRepository(primary);
  const seat = join(root, 'seat');
  runFixtureGit(['worktree', 'add', '-q', '--detach', seat, 'main'], { cwd: primary });
  const info = repoInfo(seat);
  return { primary, seat, ctx: { info, io: {} }, main: runFixtureGit(['rev-parse', 'main'], { cwd: primary }) };
}

/** Run `work` while every git child this process starts is noted; the number of git launches comes back with the result. */
async function countingGit(work) {
  const real = Object.fromEntries(APIS.map(api => [api, childProcess[api]]));
  let launches = 0;
  for (const api of APIS) {
    childProcess[api] = function counted(...args) {
      const command = typeof args[0] === 'string' ? args[0].trim().split(/\s+/u)[0] : '';
      if (command.endsWith('git')) launches++;
      return real[api].apply(this, args);
    };
  }
  syncBuiltinESMExports();
  let result;
  try { result = await work(); } finally {
    for (const api of APIS) childProcess[api] = real[api];
    syncBuiltinESMExports();
  }
  return { launches, result };
}

/** What a folder is: its top level, branch, commit and the seat marker its git directory holds. */
function identity(path) {
  return {
    top: runFixtureGit(['rev-parse', '--show-toplevel'], { cwd: path }),
    branch: runFixtureGit(['symbolic-ref', '--short', 'HEAD'], { cwd: path }),
    commit: runFixtureGit(['rev-parse', 'HEAD'], { cwd: path }),
    marker: JSON.parse(readFileSync(gitPath(path, 'pullboard-item.json'), 'utf8')),
  };
}

test('cli.item-folder.new-folder-git-launches: clause 1: opening a new item folder with no spare launches at most 3 git processes [C7,#10821]', async t => {
  const { ctx } = repository(t);
  const { launches } = await countingGit(() => openItemFolder(ctx, ME, 7));
  console.log(`# git launches opening a new item folder: ${launches}`);
  assert.ok(launches <= 3, `opening the folder launched ${launches} git processes`);
});

test('cli.item-folder.same-folder-new-and-existing-branch: clause 2: the folder path, branch, commit and marker are the same for a new branch and for an existing branch [C7,#10821]', async t => {
  const { ctx, main } = repository(t);
  const fresh = await openItemFolder(ctx, ME, 7);
  assert.equal(fresh, itemFolderPath(ctx.info.root, 7));
  assert.deepEqual(identity(fresh), { top: fresh, branch: 'core/item-7', commit: main, marker: { version: 1, seat: ME.id, item: 7 } });
  runFixtureGit(['branch', 'core/item-8', 'main'], { cwd: ctx.info.root });
  const existing = await openItemFolder(ctx, ME, 8);
  assert.equal(existing, itemFolderPath(ctx.info.root, 8));
  assert.ok(existsSync(existing));
  assert.deepEqual(identity(existing), { top: existing, branch: 'core/item-8', commit: main, marker: { version: 1, seat: ME.id, item: 8 } });
});
