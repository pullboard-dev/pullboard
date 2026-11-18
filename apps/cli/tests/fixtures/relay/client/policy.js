/** Manage committed relay policy in isolated linked-replica fixtures [H21,H16]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { ROLES } from '../../../../index.js';
import { CODEX_AUTOMATION_FILE } from '../../../../../../packages/config/index.js';

const INITIALIZED_REPO_FILES = [
  ...Object.values(ROLES).map(name => `.agents/skills/${name}/SKILL.md`),
  '.claude/settings.json',
  ...Object.values(ROLES).map(name => `.claude/skills/${name}/SKILL.md`),
  CODEX_AUTOMATION_FILE,
  '.codex/config.toml',
  '.codex/hooks.json',
  '.codex/rules/pullboard.rules',
  '.githooks/commit-msg',
  '.githooks/post-commit',
  '.githooks/pre-commit',
  '.githooks/pre-merge-commit',
  '.githooks/pre-push',
  '.gitignore',
  '.mcp.json',
  'AGENTS.md',
  'CLAUDE.md',
  'COORDINATOR.md',
];

/** Commit only the exact setup files `init` created, through the fixture's installed hooks. */
export function commitInitializedRepoFiles(root, env, gitAt) {
  const untracked = gitAt(root, env, 'ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean).sort();
  assert.deepEqual(untracked, [...INITIALIZED_REPO_FILES].sort(), 'init created only its expected agent setup files');
  gitAt(root, env, 'add', '--', ...INITIALIZED_REPO_FILES);
  gitAt(root, env, 'commit', '-q', '-m', 'test: commit initialized fixture setup [G1]');
  assert.equal(gitAt(root, env, 'status', '--porcelain'), '', 'the ordinary hook-checked setup commit leaves clone main clean');
}

/** Commit and merge an explicit legacy ACK policy, returning an exact-byte restoration callback. */
export async function enterLegacyAckPolicy({ clones, worktrees, envs, gitAt }) {
  const original = clones.map(root => readFileSync(join(root, 'pullboard.json')));
  for (let index = 0; index < clones.length; index += 1) {
    const root = clones[index];
    const worktree = worktrees[index];
    const env = envs[index];
    assert.equal(gitAt(root, env, 'branch', '--show-current'), 'main', 'policy changes are committed on each fixture main');
    assert.equal(gitAt(root, env, 'status', '--porcelain'), '', 'fixture main is clean before changing relay policy');
    assert.equal(gitAt(worktree, env, 'status', '--porcelain'), '', 'fixture worktree is clean before merging relay policy');
    const config = JSON.parse(original[index].toString('utf8'));
    assert.notEqual(config.relay?.outbox, false, 'the default-on controls precede the explicit legacy opt-out');
    config.relay = { ...config.relay, outbox: false };
    writeFileSync(join(root, 'pullboard.json'), `${JSON.stringify(config, null, 2)}\n`);
    gitAt(root, env, 'add', 'pullboard.json');
    gitAt(root, env, 'commit', '-q', '-m', 'test: opt out of the relay outbox [G1]');
    assert.equal(JSON.parse(gitAt(root, env, 'show', 'main:pullboard.json')).relay.outbox, false,
      'the accepted fixture main explicitly disables local-first queuing');
    gitAt(worktree, env, 'merge', '--no-ff', '-m', 'test: merge relay outbox opt-out [G1]', 'main');
    assert.deepEqual(readFileSync(join(worktree, 'pullboard.json')), readFileSync(join(root, 'pullboard.json')),
      'the ACK scenario worktree inherits its committed main policy');
  }

  let restored = false;
  /** Restore each isolated fixture's exact original bytes after its ACK-only phase. */
  return async function restoreDefaultRelayPolicy() {
    assert.equal(restored, false, 'the fixture policy is restored only once');
    restored = true;
    for (let index = 0; index < clones.length; index += 1) {
      const root = clones[index];
      const worktree = worktrees[index];
      const env = envs[index];
      assert.equal(gitAt(root, env, 'status', '--porcelain'), '', 'fixture main is clean before restoring relay policy');
      assert.equal(gitAt(worktree, env, 'status', '--porcelain'), '', 'fixture worktree is clean before merging restored policy');
      writeFileSync(join(root, 'pullboard.json'), original[index]);
      gitAt(root, env, 'add', 'pullboard.json');
      gitAt(root, env, 'commit', '-q', '-m', 'test: restore the relay outbox default [G1]');
      assert.deepEqual(readFileSync(join(root, 'pullboard.json')), original[index], 'fixture main restores exact config bytes');
      gitAt(worktree, env, 'merge', '--no-ff', '-m', 'test: merge restored relay outbox policy [G1]', 'main');
      assert.deepEqual(readFileSync(join(worktree, 'pullboard.json')), original[index], 'fixture worktree restores exact config bytes');
      assert.equal(JSON.parse(gitAt(root, env, 'show', 'main:pullboard.json')).relay?.outbox, undefined,
        'the restored fixture main returns to the absent setting and default-on behavior');
    }
  };
}

/** Require the injected lost HTTP reply to have been consumed by an actual fixture request. */
export function assertDroppedReplyConsumed(relay, operation) {
  assert.equal(relay.dropPending(), false, `the injected reply loss was consumed by ${operation}`);
}
