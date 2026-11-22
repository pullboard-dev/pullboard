/** @pullboard-test-input source-cell packages/git */
/** Worktree install guidance follows the committed package manager and lock [C7,I1,L3]. @pullboard-test-input source-cell packages/git */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { installStep } from '../../src/io/worktree.js';

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.test' };

/** Run git in a fixture and return trimmed stdout. */
function inRepo(cwd, args) {
  const result = spawnSync('git', args, { cwd, env: ENV, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** Commit a package manager declaration and selected lockfiles; later files can be staged only. */
function fixture(t, { manager, committed = [], staged = [], dependencies = { example: '1' } }) {
  const root = privateFixtureFiles('worktree-').root;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  inRepo(root, ['init', '-q']);
  const manifest = { dependencies };
  if (manager) manifest.packageManager = manager;
  writeFileSync(join(root, 'package.json'), `${JSON.stringify(manifest)}\n`);
  for (const lock of committed) writeFileSync(join(root, lock), 'fixture lock\n');
  inRepo(root, ['add', '.']);
  inRepo(root, ['commit', '-q', '-m', 'fixture']);
  for (const lock of staged) writeFileSync(join(root, lock), 'staged fixture lock\n');
  if (staged.length) inRepo(root, ['add', ...staged]);
  return root;
}

test('git.worktree.manager-correct-install: clause 1: committed package manager and matching lock determine safe setup guidance [C7,I1,L3]', (t) => {
  const pnpm = fixture(t, { manager: 'pnpm@9.15.0', committed: ['pnpm-lock.yaml'] });
  assert.deepEqual(installStep(pnpm), {
    command: 'pnpm install --frozen-lockfile',
    note: 'its own install from the committed pnpm-lock.yaml, so its tests run its own code',
  });

  const classic = fixture(t, { manager: 'yarn@1.22.22', committed: ['yarn.lock', 'package-lock.json'] });
  assert.deepEqual(installStep(classic), {
    command: 'yarn install --frozen-lockfile',
    note: 'its own Yarn Classic install from the committed yarn.lock, so its tests run its own code',
  });

  const modern = fixture(t, { manager: 'yarn@4.5.0', committed: ['yarn.lock'] });
  assert.deepEqual(installStep(modern), {
    command: 'yarn install --immutable',
    note: 'its own modern Yarn install from the committed yarn.lock, so its tests run its own code',
  });

  const npm = fixture(t, { committed: ['package-lock.json'] });
  assert.deepEqual(installStep(npm), {
    command: 'npm ci',
    note: 'its own install from the committed package-lock.json, so its tests run its own code',
  });
});

test('git.worktree.manager-correct-missing-lock: clause 2: missing or conflicting locks never advise another manager or fabricate npm lock guidance [C7,I1,L3]', (t) => {
  const pnpmMissing = fixture(t, { manager: 'pnpm@9.15.0', committed: ['yarn.lock', 'package-lock.json'] });
  assert.deepEqual(installStep(pnpmMissing), {
    command: 'pnpm install',
    note: 'its own install; commit the pnpm-lock.yaml it writes so the first submit is not refused as UNTRACKED',
  });

  const yarnMissing = fixture(t, { manager: 'yarn@4.5.0', committed: ['pnpm-lock.yaml'] });
  assert.deepEqual(installStep(yarnMissing), {
    command: 'yarn install',
    note: 'its own install; commit the yarn.lock it writes so the first submit is not refused as UNTRACKED',
  });

  const stagedOnly = fixture(t, { manager: 'pnpm@9.15.0', staged: ['pnpm-lock.yaml'] });
  assert.deepEqual(installStep(stagedOnly), {
    command: 'pnpm install',
    note: 'its own install; commit the pnpm-lock.yaml it writes so the first submit is not refused as UNTRACKED',
  });

  const npmMissing = fixture(t, { committed: ['yarn.lock'] });
  assert.deepEqual(installStep(npmMissing), {
    command: 'npm install',
    note: 'its own install; it writes package-lock.json, so commit that file or the first submit is refused UNTRACKED',
  });

  const empty = fixture(t, { manager: 'pnpm@9.15.0', committed: ['pnpm-lock.yaml'], dependencies: {} });
  assert.equal(installStep(empty), null);
});
