/** A submit from a dirty seat worktree still runs from the shared committed tools snapshot, never a private copy [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { temporaryDirectory } from '../../../fixtures/board.js';
import { temporaryRepository } from '../../../fixtures/board/submit.js';
import { toolsSnapshot } from '../../../../src/io/toolsnapshot.js';

/** Run git in a folder with no user config. */
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
}

/** A private temp dir that tmpdir() resolves to, and a small kit git repo with tooling folders and one committed bin file. */
function sandbox(t) {
  const temp = realpathSync(temporaryDirectory('pullboard-dirty-root-'));
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = temp;
  t.after(() => { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; rmSync(temp, { recursive: true, force: true }); });
  const repo = temporaryRepository(t, 'pullboard-dirty-root-repo-');
  for (const dir of ['bin', 'apps', 'packages', 'src']) {
    mkdirSync(join(repo, dir), { recursive: true });
    writeFileSync(join(repo, dir, 'a.js'), `export const ${dir} = 1;\n`);
  }
  writeFileSync(join(repo, 'package.json'), '{}\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'tools');
  return { temp, repo };
}

test('cli.io-submit-handoff-root.a-tool-root-with-an-uncommitted-bin: clause 1: a tool root with an uncommitted bin edit gets the shared snapshot, whose copy of that file is the committed one, and no private copy [C7]', t => {
  const { temp, repo } = sandbox(t);
  writeFileSync(join(repo, 'bin/a.js'), 'export const bin = "uncommitted";\n');
  writeFileSync(join(repo, 'bin/untracked.js'), 'export const stray = 1;\n');
  const folder = toolsSnapshot(repo, 'job-dirty');
  assert.match(folder, /pullboard-handoff-tools-[0-9a-f]{40}$/u, 'the folder is the shared one, not a per-job one');
  assert.equal(readFileSync(join(folder, 'bin/a.js'), 'utf8'), 'export const bin = 1;\n', 'the committed content, never the edit');
  assert.deepEqual(readdirSync(join(folder, 'bin')), ['a.js'], 'an untracked file does not leak in');
  assert.deepEqual(readdirSync(temp).filter(name => name.includes('job-dirty')), [], 'no private per-job copy is made');
  assert.equal(toolsSnapshot(repo, 'job-again'), folder, 'a second dirty submit reuses the same folder');
});

test('cli.io-submit-handoff-root.a-tool-root-that-is-not-a: clause 2: a tool root that is not a git checkout at all still gets a private per-job copy [C7]', t => {
  const { temp } = sandbox(t);
  const plain = temporaryDirectory('pullboard-plain-tools-');
  t.after(() => rmSync(plain, { recursive: true, force: true }));
  writeFileSync(join(plain, 'package.json'), '{}\n');
  const folder = toolsSnapshot(plain, 'job-plain');
  assert.match(folder, /pullboard-handoff-tools-job-plain-/u);
  assert.equal(readFileSync(join(folder, 'package.json'), 'utf8'), '{}\n');
  assert.ok(temp);
});
