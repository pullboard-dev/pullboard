/** The pre-commit hook logic run in-process refuses and prints exactly what the real hook does through git commit [C7,#9211]. */
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { createE2eHelpers } from '../../fixtures/e2e.js';
import { PRE_COMMIT_STATIC } from '../../fixtures/hook/pre-commit.js';
import { runPreCommitInProcess } from '../../fixtures/hook/pre-commit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

const BIN = resolve(import.meta.dirname, '../../../pullboard.js');

/** A hooks folder holding only the repository's own pre-commit line, so the commit prints the pre-commit hook and nothing else. */
function realHooks(box) {
  const dir = join(privateFixtureFiles('pullboard-pre-commit-hooks-').root, 'hooks');
  mkdirSync(dir);
  writeFileSync(join(dir, 'pre-commit'), `#!/bin/sh\nPULLBOARD_HOOK_STATIC= exec "${process.execPath}" "${BIN}" hook pre-commit\n`);
  chmodSync(join(dir, 'pre-commit'), 0o755);
  return dir;
}

/** Stage one state in a fixture checkout; called twice per state, because a fixer rewrites what it fixes. */
function stage(box, cwd, state) {
  for (const [path, text] of Object.entries(state.files)) {
    mkdirSync(join(cwd, path, '..'), { recursive: true });
    writeFileSync(join(cwd, path), text);
  }
  box.git(cwd, 'add', '-A');
}

/** Return a fixture checkout to its HEAD with nothing staged or left over. */
function clean(box, cwd) {
  assert.ok(cwd.startsWith(box.dir), 'only a fixture checkout is ever reset');
  box.git(cwd, 'reset', '-q', '--hard');
  box.git(cwd, 'clean', '-fdq');
}

/** The in-process answer and the real hook's answer through git commit, for one staged state. */
async function bothAnswers(box, cwd, state) {
  stage(box, cwd, state);
  const inProcess = await runPreCommitInProcess(box, cwd, { staticCheck: '' });
  clean(box, cwd);
  stage(box, cwd, state);
  const commit = box.tryGit(cwd, '-c', `core.hooksPath=${realHooks(box)}`, 'commit', '-q', '--allow-empty', '-m', 'feat(web): parity [G1]');
  const real = { status: commit.status === 0 ? 0 : 1, stderr: commit.stderr };
  if (commit.status !== 0) clean(box, cwd);
  return { inProcess, real };
}

const STATES = [
  { name: 'a clean change', where: 'web', files: { 'web/clean.txt': 'a change inside the lane\n' }, refuses: false },
  { name: 'a path outside the lane', where: 'web', files: { 'api/outside.txt': 'a path the web lane does not own\n' }, refuses: true },
  { name: 'a bad import', where: 'repo', files: { 'src/bad.js': "import { one, two } from './other.js';\nexport { one, two };\n" }, refuses: false },
  { name: 'a seat item folder', where: 'web', branch: 'web/item-7', files: { 'web/item.txt': 'item work in the seat checkout\n' }, refuses: true },
  { name: 'an empty stage', where: 'web', files: {}, refuses: false },
];

for (const state of STATES) {
  test(`clause 2: for ${state.name} the in-process pre-commit status and stderr equal the real hook's through git commit [C7,#9211]`, async () => {
    const box = e2e.project('true');
    const cwd = state.where === 'web' ? box.web : box.repo;
    if (state.branch) box.git(cwd, 'checkout', '-q', '-b', state.branch);
    const { inProcess, real } = await bothAnswers(box, cwd, state);
    assert.equal(inProcess.status, real.status, `status: in-process ${inProcess.status}, real ${real.status}\n${real.stderr}`);
    assert.equal(inProcess.stderr, real.stderr);
    assert.equal(real.status !== 0, state.refuses, `the real hook ${state.refuses ? 'refuses' : 'accepts'} ${state.name}: ${real.stderr}`);
  });
}

test('clause 1: runPreCommitInProcess returns the hook status and stderr, and names the same static check as .githooks/pre-commit [C7,#9211]', async () => {
  const box = e2e.project('true');
  stage(box, box.web, { files: { 'api/outside.txt': 'x\n' } });
  const answer = await runPreCommitInProcess(box, box.web, { staticCheck: '' });
  assert.deepEqual(Object.keys(answer).sort(), ['status', 'stderr']);
  assert.notEqual(answer.status, 0);
  assert.match(answer.stderr, /pullboard pre-commit/u);
  assert.equal(PRE_COMMIT_STATIC, 'packages/gate/src/io/changed/scripts/static.js');
  clean(box, box.web);
});
