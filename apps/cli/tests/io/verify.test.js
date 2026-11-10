/** A reviewer's re-run applies the submit rule: a case an open Main red repair names never fails it [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runFixtureChild } from '../fixtures/child.js';
import { runFixtureGit } from '../fixtures/child.js';
import { knownMainCheck } from '../../index.js';

const CHECK = 'node --test test/affected.test.js';
// The case fails on main and on the candidate with different messages, so no exact comparison of the two runs can match it.
const source = value => `import assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest('x case [G1]', () => assert.equal('${value}', 'fixed'));\n`;

/** A real repository whose main fails the case, and the candidate's red run of the same check. */
function fixture(t) {
  // The nested node --test runs must not inherit this runner's test context, or they report nothing.
  const context = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  t.after(() => { if (context !== undefined) process.env.NODE_TEST_CONTEXT = context; });
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-verify-known-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'F', GIT_AUTHOR_EMAIL: 'f@example.invalid', GIT_COMMITTER_NAME: 'F', GIT_COMMITTER_EMAIL: 'f@example.invalid' };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && !/^GIT_(CONFIG|AUTHOR|COMMITTER)/u.test(key)) delete env[key];
  const git = (...args) => runFixtureGit(args, { cwd: root, env }).trim();
  git('init', '-q', '-b', 'main');
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, 'test/affected.test.js'), source('main'));
  git('add', '-A'); git('commit', '-q', '-m', 'test(core): main fixture [G1]');
  const main = git('rev-parse', 'HEAD');
  writeFileSync(join(root, 'test/affected.test.js'), source('item'));
  const ran = runFixtureChild(process.execPath, ['--test', 'test/affected.test.js'], { cwd: root, env, encoding: 'utf8' });
  const output = String(ran.stdout) + String(ran.stderr);
  const check = { state: 'red', checked: true, executionSourceUnchanged: true, exitCode: 1, output };
  return { root, main, check };
}

/** The open Main red repair whose own check runs the shared file. */
const repair = { item_id: 7, item_status: 'open', item_title: 'Main red: x case', item_check: CHECK, item_criterion: "The case 'x case [G1]' passes on main." };

test('a re-run whose only red case an open Main red repair names is known main, not CHECK_RED [C7]', async t => {
  const { root, main, check } = fixture(t);
  const known = await knownMainCheck(root, check, { main, item: 9, items: () => [repair] });
  assert.ok(known, 'the owned case never fails the re-run');
  assert.deepEqual(known.failures.map(row => [row.file, row.name, row.item]), [['test/affected.test.js', 'x case [G1]', 7]]);
});

test('control: with no open Main red repair naming that case, the re-run stays red [C7]', async t => {
  const { root, main, check } = fixture(t);
  assert.equal(await knownMainCheck(root, check, { main, item: 9, items: () => [] }), null);
});
