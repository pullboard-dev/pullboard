/** @pullboard-test-input apps/runner/src/io/private/privacy.js packages/gate/src/io/check/rename.js */
/** checkAtCommit hands back the test-file renames it followed, so the gate can record them [C7,#2969]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../../packages/gate/tests/fixtures/child.js';
import { checkAtCommit } from '../../../index.js';

const BODY = "import { test } from 'node:test';\ntest('x', () => {});\n// padding so git sees the same file after a move\n".repeat(3);

/** A real repository frozen at `base`, then renamed on main; the frozen check only tests that a file exists. */
function repository(t) {
  const root = privateFixtureFiles('pullboard-runner-rename-').root;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Agent', GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent', GIT_COMMITTER_EMAIL: 'agent@example.com' };
  const run = (...args) => runFixtureGit(args, { cwd: root, env });
  const put = (path, source) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), source); };
  run('init', '-q', '-b', 'main');
  put('pullboard.json', '{}');
  put('test/old-name.test.js', BODY);
  put('test/steady.test.js', `${BODY}// steady\n`);
  run('add', '-A'); run('commit', '-qm', 'chore: fixture');
  const base = run('rev-parse', 'HEAD').trim();
  mkdirSync(join(root, 'packages/x/tests'), { recursive: true });
  run('mv', 'test/old-name.test.js', 'packages/x/tests/new-name.test.js');
  run('commit', '-qm', 'refactor: move');
  const commit = run('rev-parse', 'HEAD').trim();
  const item = file => ({ item_id: 1, item_claim_head: base, item_commit: commit, item_frozen: JSON.stringify({ check: `test -f ${file}` }) });
  return { root, item };
}

test('runner.renames.checkatcommit-returns-the-rename-followed-for-a: clause 1: checkAtCommit returns the rename followed for a frozen check whose test file main renamed [C7]', t => {
  const { root, item } = repository(t);
  const proof = checkAtCommit(root, item('test/old-name.test.js'));
  assert.equal(proof.state, 'pass', `${proof.stage}\n${proof.output}`);
  assert.deepEqual(proof.renames, [{ from: 'test/old-name.test.js', to: 'packages/x/tests/new-name.test.js' }]);
});

test('runner.renames.checkatcommit-returns-an-empty-rename-list-for: clause 2: checkAtCommit returns an empty rename list for a check with no renamed file [C7]', t => {
  const { root, item } = repository(t);
  const proof = checkAtCommit(root, item('test/steady.test.js'));
  assert.equal(proof.state, 'pass', `${proof.stage}\n${proof.output}`);
  assert.deepEqual(proof.renames, []);
});
