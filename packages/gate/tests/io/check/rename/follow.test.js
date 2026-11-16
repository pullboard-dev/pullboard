/** A frozen check naming a test file main renamed runs the renamed file; a deleted file still refuses [C7,#2969]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../fixtures/child.js';
import { runFixtureGit } from '../../../fixtures/child.js';
import { followRenames } from '../../../../index.js';

const BODY = "import { test } from 'node:test';\ntest('x', () => {});\n// padding so git sees the same file after a move\n".repeat(3);

/** A real Git repository: frozen at `base`, then main renames one test and deletes another. */
function repository(t) {
  const root = privateFixtureFiles('pullboard-check-rename-').root;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Agent', GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent', GIT_COMMITTER_EMAIL: 'agent@example.com' };
  const run = (...args) => runFixtureGit(args, { cwd: root, env });
  const put = (path, source) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), source); };
  run('init', '-q', '-b', 'main');
  put('test/old-name.test.js', BODY);
  put('test/doomed.test.js', `${BODY}// doomed\n`);
  put('test/steady.test.js', `${BODY}// steady\n`);
  run('add', '-A'); run('commit', '-qm', 'chore: fixture');
  const base = run('rev-parse', 'HEAD').trim();
  mkdirSync(join(root, 'packages/x/tests'), { recursive: true });
  run('mv', 'test/old-name.test.js', 'packages/x/tests/new-name.test.js');
  run('rm', '-q', 'test/doomed.test.js');
  run('commit', '-qm', 'refactor: move and delete');
  return { root, base, commit: run('rev-parse', 'HEAD').trim() };
}

test('clause 1: a frozen check naming a test file main renamed runs the renamed file [C7]', t => {
  const { root, base, commit } = repository(t);
  const answer = followRenames(root, 'node --test test/old-name.test.js test/steady.test.js', { base, commit });
  assert.equal(answer.command, 'node --test packages/x/tests/new-name.test.js test/steady.test.js');
  assert.deepEqual(answer.followed, [{ from: 'test/old-name.test.js', to: 'packages/x/tests/new-name.test.js' }]);
  assert.deepEqual(answer.missing, []);
});

test('clause 2: a check whose file main deleted without a rename keeps its command and still refuses [C7]', t => {
  const { root, base, commit } = repository(t);
  const command = 'node --test test/doomed.test.js';
  const answer = followRenames(root, command, { base, commit });
  assert.equal(answer.command, command);
  assert.deepEqual(answer.followed, []);
  assert.deepEqual(answer.missing, ['test/doomed.test.js']);
});
