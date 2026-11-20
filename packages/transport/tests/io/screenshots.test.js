/** @pullboard-test-input packages/transport/src/io/screenshots.js */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellRepo } from '../../../store/tests/fixtures/cell.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../../gate/tests/fixtures/child.js';
import { writeScreenshots } from '../../src/io/screenshots.js';

/** A repository with one commit and a linked worktree, whose `.git` is a file. */
function linked(t) {
  const repo = cellRepo(t, { real: true });
  repo.put('a.txt', 'a\n');
  const base = repo.commitAll();
  const scratch = privateFixtureFiles('pullboard-screenshots-');
  const tree = join(scratch.root, 'tree');
  runFixtureGit(['-C', repo.root, 'worktree', 'add', '-q', '--detach', tree, base]);
  return { main: repo.root, tree, scratch };
}

test('transport.io-screenshots.a-linked-worktree-gets-each-file: clause 1: writeScreenshots writes each file byte-identical under the absolute git dir of a linked worktree, nothing else, and returns that folder [C7]', async (t) => {
  const { tree } = linked(t);
  const gitDir = runFixtureGit(['-C', tree, 'rev-parse', '--absolute-git-dir']);
  assert.ok(readFileSync(join(tree, '.git'), 'utf8').startsWith('gitdir:'), 'the worktree .git is a file');
  const bytes = Buffer.from([0, 255, 1, 254, 137, 80, 78, 71]);
  const folder = await writeScreenshots(tree, 'job-1', [
    { path: 'one.png', base64: bytes.toString('base64') },
    { path: 'shots/two.png', base64: Buffer.from('two').toString('base64') },
  ]);
  assert.equal(folder, join(gitDir, 'pullboard', 'screenshots', 'job-1'));
  assert.deepEqual(readFileSync(join(folder, 'one.png')), bytes);
  assert.equal(readFileSync(join(folder, 'shots', 'two.png'), 'utf8'), 'two');
  assert.deepEqual(readdirSync(join(gitDir, 'pullboard')), ['screenshots']);
  assert.deepEqual(readdirSync(join(gitDir, 'pullboard', 'screenshots')), ['job-1']);
  assert.deepEqual(readdirSync(folder).sort(), ['one.png', 'shots']);
});

test('transport.io-screenshots.an-absolute-or-climbing-name-is-refused: clause 2: a job id or file path that is absolute or climbs with ../ is refused and writes nothing [C7]', async (t) => {
  const { main, scratch } = linked(t);
  const ok = { path: 'ok.png', base64: 'AA==' };
  const cases = [
    ['/abs', [ok]], ['../up', [ok]], ['a/../../b', [ok]], ['', [ok]],
    ['job-2', [ok, { path: '/etc/passwd', base64: 'AA==' }]],
    ['job-3', [ok, { path: '../escape.png', base64: 'AA==' }]],
    ['job-4', [ok, { path: 'a/../../escape.png', base64: 'AA==' }]],
  ];
  for (const [jobId, shots] of cases) {
    await assert.rejects(() => writeScreenshots(main, jobId, shots), /must be/u, `${jobId} is refused`);
  }
  const gitDir = runFixtureGit(['-C', main, 'rev-parse', '--absolute-git-dir']);
  assert.equal(existsSync(join(gitDir, 'pullboard', 'screenshots')), false, 'nothing was written');
  assert.equal(existsSync(join(scratch.root, 'escape.png')), false);
});
