/** The hand-off tools snapshot is named by the tooling trees, and stale unused ones are swept [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sweepToolSnapshots, toolsSnapshot } from '../apps/cli/src/shell/submit-handoff.js';

/** Run git in a folder with no user config. */
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
}

/** A private temp dir, and a small git repo with tooling folders, routed so tmpdir() lands in the private dir. */
function sandbox(t) {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-snapshot-key-')));
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = temp;
  t.after(() => { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; rmSync(temp, { recursive: true, force: true }); });
  const repo = join(temp, 'repo');
  for (const dir of ['bin', 'apps', 'packages', 'src', 'test']) mkdirSync(join(repo, dir), { recursive: true });
  git(temp, 'init', '-q', repo);
  for (const dir of ['bin', 'apps', 'packages', 'src']) writeFileSync(join(repo, dir, 'a.js'), `export const ${dir} = 1;\n`);
  writeFileSync(join(repo, 'package.json'), '{}\n');
  writeFileSync(join(repo, 'test', 'a.test.js'), '// one\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'tools');
  return { temp, repo };
}

/** The shared snapshot folders in a temp dir. */
function snapshots(temp) { return readdirSync(temp).filter(name => /^pullboard-handoff-tools-[0-9a-f]{40}$/u.test(name)); }

test('clause 1: a commit that changes only tests shares the tools snapshot of the commit before it [C7]', t => {
  const { temp, repo } = sandbox(t);
  const first = toolsSnapshot(repo, 'job-1');
  writeFileSync(join(repo, 'test', 'a.test.js'), '// two\n');
  git(repo, 'commit', '-q', '-am', 'tests only');
  assert.equal(toolsSnapshot(repo, 'job-2'), first, 'same tooling trees, same folder');
  assert.equal(snapshots(temp).length, 1);
  writeFileSync(join(repo, 'src', 'a.js'), 'export const src = 2;\n');
  git(repo, 'commit', '-q', '-am', 'tooling change');
  assert.notEqual(toolsSnapshot(repo, 'job-3'), first, 'changed tooling gets its own folder');
  assert.equal(snapshots(temp).length, 2);
});

test('clause 2: snapshots older than 24 h with no running worker are removed and fresh ones stay [C7]', t => {
  const { temp } = sandbox(t);
  const old = 'pullboard-handoff-tools-' + 'a'.repeat(40);
  const fresh = 'pullboard-handoff-tools-' + 'b'.repeat(40);
  for (const name of [old, fresh]) mkdirSync(join(temp, name));
  const past = new Date(Date.now() - 25 * 3600 * 1000);
  utimesSync(join(temp, old), past, past);
  assert.deepEqual(sweepToolSnapshots(null, { directory: temp }), [old]);
  assert.deepEqual(snapshots(temp), [fresh]);
});
