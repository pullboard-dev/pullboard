/** A runner reads a trunk commit it lacks after fetching it, so 'not a tree object' never reaches a builder [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { requirePlannedSource } from '../../../index.js';
import { readTrunkEntry } from '../../../src/logic/submit/preflight.js';
import { runFixtureGit } from '../../../../../apps/cli/tests/fixtures/child.js';

const IDENTITY = ['-c', 'user.name=Trunk Test', '-c', 'user.email=trunk@example.test', '-c', 'commit.gpgsign=false'];
const PLAN = 'packages/codemap/data/plan/cells.json';

/** Commit one file change in a repository and return the new commit. */
function commit(root, file, text) {
  mkdirSync(join(root, file, '..'), { recursive: true });
  writeFileSync(join(root, file), text);
  runFixtureGit(['add', '-A'], { cwd: root });
  runFixtureGit([...IDENTITY, 'commit', '-q', '-m', 'change'], { cwd: root });
  return runFixtureGit(['rev-parse', 'HEAD'], { cwd: root });
}

/**
 * A main repository and a runner-style job clone with no remote, made from main's older commit; main then lands a newer
 * commit the clone has never seen, as happens when main moves mid-job.
 */
function fixture(t, { recordSource = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-runner-trunk-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const main = join(dir, 'main'), job = join(dir, 'job');
  mkdirSync(main);
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: main });
  const older = commit(main, PLAN, JSON.stringify({ cells: [], stays: [] }));
  mkdirSync(job);
  runFixtureGit(['init', '-q'], { cwd: job });
  runFixtureGit(['-c', 'protocol.file.allow=always', 'fetch', '-q', '--no-tags', main, older], { cwd: job });
  runFixtureGit(['checkout', '-q', '--detach', 'FETCH_HEAD'], { cwd: job });
  if (recordSource) runFixtureGit(['config', '--local', 'pullboard.fetchSource', main], { cwd: job });
  const newest = commit(main, 'lib/landed.js', 'export const landed = true;\n');
  return { main, job, older, newest };
}

test('items.preflight.fetch-once: a runner clone lacking the newest main commit reads it after one fetch, with no infrastructure error [C7]', t => {
  const { job, older, newest } = fixture(t);
  assert.throws(() => runFixtureGit(['cat-file', '-e', newest], { cwd: job }), 'the clone starts without the newest commit');
  const entry = readTrunkEntry(job, newest, PLAN);
  assert.equal(entry.status, 0);
  assert.match(entry.stdout, /^100644 blob [0-9a-f]+\tpackages\/codemap\/data\/plan\/cells\.json\0$/u);
  assert.doesNotThrow(() => requirePlannedSource(job, newest, older, { deferUnplaced: true }), 'placement reads the fetched trunk');
});

test('items.preflight.infra-retry: a trunk commit no source can supply is an infrastructure retry, never a builder refusal [C7]', t => {
  const { job, newest } = fixture(t, { recordSource: false });
  assert.throws(() => readTrunkEntry(job, newest, PLAN), error => error.code === 'GIT_READ_INFRASTRUCTURE' && error.retryable === true && error.name !== 'Refused');
});
