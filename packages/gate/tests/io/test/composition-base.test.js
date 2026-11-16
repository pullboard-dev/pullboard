/** @pullboard-test-input source-cell gate */
/** The composition base of a land merge is the trunk parent, so a file main added after the item branched is never the item's [C7,#9524]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { runFixtureGit } from '../../fixtures/child.js';
import { compositionBase } from '../../../src/io/test/fixtures.js';

/** A real repository: main moves on (adding a test file) after the item branched off it. */
function repository(t) {
  const root = privateFixtureFiles('pullboard-composition-base-').root;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Agent', GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent', GIT_COMMITTER_EMAIL: 'agent@example.com' };
  const run = (...args) => runFixtureGit(args, { cwd: root, env }).trim();
  const put = (path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
  run('init', '-q', '-b', 'main');
  put('a.txt', 'a\n');
  run('add', '-A'); run('commit', '-qm', 'chore: base');
  run('checkout', '-q', '-b', 'item');
  put('item.txt', 'item\n');
  run('add', '-A'); run('commit', '-qm', 'feat: item');
  run('checkout', '-q', 'main');
  put('packages/x/tests/late.test.js', 'export {};\n');
  run('add', '-A'); run('commit', '-qm', 'chore: main moves on');
  return { root, run, trunk: run('rev-parse', 'main'), item: run('rev-parse', 'item') };
}

test('clause 1: a land merge (HEAD^1 main, HEAD^2 item) has the trunk parent as its base, so a file main added later passes [C7,#9524]', t => {
  const { root, run, trunk, item } = repository(t);
  run('checkout', '-q', '--detach', trunk);
  run('merge', '-q', '--no-ff', '-m', 'Merge #9524 onto main [C7]', item);
  assert.equal(compositionBase(root), trunk);
  assert.notEqual(compositionBase(root), item);
  const added = run('diff', '--name-only', '--diff-filter=A', compositionBase(root), 'HEAD');
  assert.ok(!added.includes('late.test.js'), 'main\'s own file is not counted as added by the item');
  assert.ok(added.includes('item.txt'));
});

test('clause 1: a gate merge (HEAD^1 item, HEAD^2 main) still has the second parent as its base [C7,#9524]', t => {
  const { root, run, trunk, item } = repository(t);
  run('checkout', '-q', '--detach', item);
  run('merge', '-q', '--no-ff', '-m', 'Merge main into the item', trunk);
  assert.equal(compositionBase(root), trunk);
});
