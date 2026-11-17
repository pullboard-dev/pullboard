/** @pullboard-test-input source-cell packages/runners */
/** Concurrent runner fetches of the trunk reuse one cached pack per trunk commit [E28]. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { temporaryRepository } from '../../../store/tests/fixtures/submit.js';
import { temporaryDirectory } from '../../../board/tests/fixtures/board.js';
import { runFixtureChildAsync } from '../../../gate/tests/fixtures/child.js';
import { cachedTrunkPack } from '../../src/io/worktree.js';

const IDENTITY = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test'];

/**
 * Run git in a fixture repository.
 * @param {string} cwd The repository directory.
 * @param {...string} args Git arguments.
 * @returns {Promise<string>} Trimmed standard output.
 */
async function git(cwd, ...args) {
  const run = await runFixtureChildAsync('git', [...IDENTITY, ...args], { cwd });
  assert.equal(run.failure, null, run.context);
  return run.stdout.trim();
}

test('runners.trunk-pack.two-concurrent-fetches-of-the-same: two concurrent fetches of the same trunk commit run pack-objects once [E28]', async t => {
  const repo = temporaryRepository(t, 'trunk-pack-repo-'), dir = temporaryDirectory('trunk-pack-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const commit = await git(repo, 'rev-parse', 'HEAD');
  const runs = await Promise.all([cachedTrunkPack(repo, commit, { dir }), cachedTrunkPack(repo, commit, { dir })]);
  assert.equal(runs.filter(run => run.built).length, 1);
  assert.equal(runs[0].file, runs[1].file);
  assert.ok(existsSync(runs[0].file));
});

test('runners.trunk-pack.a-new-trunk-commit-builds-a: a new trunk commit builds a new pack and drops the old one [E28]', async t => {
  const repo = temporaryRepository(t, 'trunk-pack-repo-'), dir = temporaryDirectory('trunk-pack-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = await git(repo, 'rev-parse', 'HEAD');
  const old = await cachedTrunkPack(repo, first, { dir });
  await git(repo, 'commit', '--allow-empty', '-m', 'next');
  const second = await git(repo, 'rev-parse', 'HEAD');
  const fresh = await cachedTrunkPack(repo, second, { dir });
  assert.equal(fresh.built, true);
  assert.equal(existsSync(old.file), false);
  assert.deepEqual(readdirSync(dir), [`trunk-${second}.pack`]);
  assert.equal(join(dir, `trunk-${second}.pack`), fresh.file);
});
