/** A tooling change moves an idle kept tools snapshot by the files that differ, proved by tree id [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { statSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { temporaryDirectory } from '../fixtures/board.js';
import { temporaryRepository } from '../fixtures/board/submit.js';
import { toolsSnapshot } from '../../src/io/toolsnapshot.js';
import { TOOLS_INDEX } from '../../src/io/toolsnapshot.js';

/** Run git in a folder with no user config. */
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
}

/** A private temp dir that tmpdir() resolves to, and a small kit repo with tooling folders. */
function sandbox(t) {
  const temp = realpathSync(temporaryDirectory('pullboard-snapshot-advance-'));
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = temp;
  t.after(() => { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; rmSync(temp, { recursive: true, force: true }); });
  const repo = temporaryRepository(t, 'pullboard-snapshot-advance-repo-');
  for (const dir of ['bin', 'apps', 'packages', 'src']) {
    mkdirSync(join(repo, dir), { recursive: true });
    writeFileSync(join(repo, dir, 'a.js'), `export const ${dir} = 1;\n`);
  }
  writeFileSync(join(repo, 'package.json'), '{}\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'tools');
  return { temp, repo };
}

/** Age a snapshot past the idle limit, as one no submit has named for an hour. */
function idle(path) { const past = new Date(Date.now() - 3600_000); utimesSync(path, past, past); }

/** Commit a tooling change: src/a.js edited, bin/a.js removed, apps/b.js added. */
function toolingChange(repo) {
  writeFileSync(join(repo, 'src/a.js'), 'export const src = 2;\n');
  rmSync(join(repo, 'bin/a.js'));
  writeFileSync(join(repo, 'apps', 'b.js'), 'export const b = 1;\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'tooling change');
}

/** The tree id of a snapshot's own index. */
function indexTree(repo, snapshot) {
  return execFileSync('git', ['-C', repo, `--work-tree=${snapshot}`, 'write-tree'], { encoding: 'utf8', env: { ...process.env, GIT_INDEX_FILE: join(snapshot, TOOLS_INDEX) } }).trim();
}

test('clause 1: a tooling change moves the idle kept snapshot, writing only the files that differ, at the commit tree id [C7]', t => {
  const { repo } = sandbox(t);
  const first = toolsSnapshot(repo, 'job-1');
  const untouched = statSync(join(first, 'packages', 'a.js')).ino;
  idle(first);
  toolingChange(repo);
  const second = toolsSnapshot(repo, 'job-2');
  assert.notEqual(second, first, 'the changed tooling has its own folder name');
  assert.equal(existsSync(first), false, 'the idle snapshot was moved, not copied');
  assert.equal(indexTree(repo, second), git(repo, 'rev-parse', 'HEAD^{tree}'), 'the moved snapshot is exactly the commit tree');
  assert.equal(statSync(join(second, 'packages', 'a.js')).ino, untouched, 'an unchanged file is not written again');
  assert.equal(readFileSync(join(second, 'src/a.js'), 'utf8'), 'export const src = 2;\n');
  assert.equal(existsSync(join(second, 'bin/a.js')), false, 'a removed file is removed');
  assert.equal(existsSync(join(second, 'apps', 'b.js')), true, 'an added file is written');
});

test('clause 1: an idle snapshot whose files differ from its index is never moved; the full snapshot is built [C7]', t => {
  const { repo } = sandbox(t);
  const first = toolsSnapshot(repo, 'job-1');
  writeFileSync(join(first, 'packages', 'a.js'), 'export const packages = "edited";\n');
  idle(first);
  toolingChange(repo);
  const second = toolsSnapshot(repo, 'job-2');
  assert.equal(indexTree(repo, second), git(repo, 'rev-parse', 'HEAD^{tree}'));
  assert.equal(readFileSync(join(second, 'packages', 'a.js'), 'utf8'), 'export const packages = 1;\n', 'the edit never reaches a gate');
});

test('clause 1: a snapshot used within the idle limit stays where it is and the full snapshot is built [C7]', t => {
  const { repo } = sandbox(t);
  const first = toolsSnapshot(repo, 'job-1');
  toolingChange(repo);
  const second = toolsSnapshot(repo, 'job-2');
  assert.equal(existsSync(first), true, 'a recently named snapshot may still start a gate');
  assert.equal(indexTree(repo, second), git(repo, 'rev-parse', 'HEAD^{tree}'));
});
