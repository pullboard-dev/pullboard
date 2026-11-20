/** The hand-off tools snapshot is named by the tooling trees, and stale unused ones are swept [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { temporaryDirectory } from '../../../fixtures/board.js';
import { temporaryRepository } from '../../../fixtures/board/submit.js';
import { toolsSnapshot } from '../../../../src/io/toolsnapshot.js';
import { sweepToolTrees } from '../../../../../../packages/items/index.js';

/** Run git in a folder with no user config. */
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
}

/** A private temp dir that tmpdir() resolves to, and a small kit git repo with tooling folders. */
function sandbox(t) {
  const temp = realpathSync(temporaryDirectory('pullboard-snapshot-key-'));
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = temp;
  t.after(() => { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; rmSync(temp, { recursive: true, force: true }); });
  const repo = temporaryRepository(t, 'pullboard-snapshot-repo-');
  for (const dir of ['bin', 'apps', 'packages', 'src', 'test']) mkdirSync(join(repo, dir), { recursive: true });
  for (const dir of ['bin', 'apps', 'packages', 'src']) writeFileSync(join(repo, dir, 'a.js'), `export const ${dir} = 1;\n`);
  writeFileSync(join(repo, 'package.json'), '{}\n');
  writeFileSync(join(repo, 'test/a.test.js'), '// one\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'tools');
  return { temp, repo };
}

/** The shared snapshot folders in a temp dir. */
function snapshots(temp) { return readdirSync(temp).filter(name => /^pullboard-handoff-tools-[0-9a-f]{40}$/u.test(name)); }

test('cli.io-submit-handoff-snapshot.a-commit-that-changes-only-tests-shares: clause 1: a commit that changes only tests shares the tools snapshot of the commit before it [C7]', t => {
  const { temp, repo } = sandbox(t);
  const first = toolsSnapshot(repo, 'job-1');
  writeFileSync(join(repo, 'test/a.test.js'), '// two\n');
  git(repo, 'commit', '-q', '-am', 'tests only');
  assert.equal(toolsSnapshot(repo, 'job-2'), first, 'same tooling trees, same folder');
  assert.equal(snapshots(temp).length, 1);
  writeFileSync(join(repo, 'src/a.js'), 'export const src = 2;\n');
  git(repo, 'commit', '-q', '-am', 'tooling change');
  assert.notEqual(toolsSnapshot(repo, 'job-3'), first, 'changed tooling gets its own folder');
  assert.equal(snapshots(temp).length, 2);
});

test('cli.io-submit-handoff-snapshot.snapshots-older-than-24-h-with-no: clause 2: snapshots older than 24 h with no running worker are removed and fresh ones stay [C7]', t => {
  const { temp } = sandbox(t);
  const old = 'pullboard-handoff-tools-' + 'a'.repeat(40);
  const fresh = 'pullboard-handoff-tools-' + 'b'.repeat(40);
  for (const name of [old, fresh]) mkdirSync(join(temp, name));
  const past = new Date(Date.now() - 25 * 3600 * 1000);
  utimesSync(join(temp, old), past, past);
  assert.deepEqual(sweepToolTrees({ temp, maxAgeMs: 24 * 3600 * 1000 }), [join(temp, old)]);
  assert.deepEqual(snapshots(temp), [fresh]);
});

test('cli.io-submit-handoff-snapshot.a-submit-that-reuses-the-shared-snapshot: clause 2: a submit that reuses the shared snapshot still removes a stale unowned one [C7]', t => {
  const { temp, repo } = sandbox(t);
  const shared = toolsSnapshot(repo, 'job-1');
  const old = join(temp, 'pullboard-handoff-tools-' + 'c'.repeat(40));
  mkdirSync(old);
  const past = new Date(Date.now() - 25 * 3600 * 1000);
  utimesSync(old, past, past);
  assert.equal(toolsSnapshot(repo, 'job-2'), shared, 'the reuse path');
  assert.deepEqual(snapshots(temp), [shared.split('/').pop()], 'the stale snapshot is gone, the live one stays');
});
