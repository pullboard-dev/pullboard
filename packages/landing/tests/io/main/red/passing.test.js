/** A Main red item whose test already passes on main closes without a builder; the open list is read only when a main run is recorded [C7,H24,#5329]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { passingMainRedItems } from '../../../../index.js';
import { privateFixtureFiles } from '../../../../../gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../../gate/tests/fixtures/child.js';

/** A real repository on main with one commit, isolated from machine Git settings, and a way to record a main run for it. */
function fixture(t) {
  const { root: directory } = privateFixtureFiles('pb-passing-main-red-');
  const root = join(directory, 'repo'); mkdirSync(root);
  const prior = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM };
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
  t.after(() => {
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(directory, { recursive: true, force: true });
  });
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const sh = (...args) => runFixtureGit(args, { cwd: root, env }).trim();
  sh('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'a.txt'), 'a\n');
  sh('add', '-A');
  sh('commit', '-qm', 'test: fixture main');
  const main = sh('rev-parse', 'HEAD');
  const record = entries => {
    mkdirSync(join(root, '.git', 'pullboard'), { recursive: true });
    writeFileSync(join(root, '.git', 'pullboard', 'main-red.json'), JSON.stringify({ version: 2, entries }), { mode: 0o600 });
  };
  return { root, main, record };
}

const ITEMS = [{ item_id: 7, item_status: 'open', item_title: 'Main red: test/a.test.js' }, { item_id: 8, item_status: 'open', item_title: 'Main red: test/b.test.js' }];

test('landing.passing.lazy-items-not-called-without-main-run: clause 1: passingMainRedItems calls a function given as its items zero times when no run is recorded for main\'s commit [C7,#5329]', t => {
  const { root, record } = fixture(t);
  record({ ['0'.repeat(40)]: { 'test/a.test.js': { result: 'green', receiptId: 'older' } } });
  let calls = 0;
  const rows = passingMainRedItems(root, () => { calls += 1; return ITEMS; });
  assert.deepEqual(rows, []);
  assert.equal(calls, 0, 'the item list was built for a main commit with no recorded run');
});

test('landing.passing.lazy-items-same-rows-as-array: clause 2: passingMainRedItems given its items as a function returns the rows it returns for the same items as an array [C7,#5329]', t => {
  const { root, main, record } = fixture(t);
  record({ [main]: { 'test/a.test.js': { result: 'green', receiptId: 'run-1' } } });
  let calls = 0;
  const lazy = passingMainRedItems(root, () => { calls += 1; return ITEMS; });
  const eager = passingMainRedItems(root, ITEMS);
  assert.deepEqual(eager.map(row => row.item), [7]);
  assert.deepEqual(lazy, eager);
  assert.equal(calls, 1, 'the function ran once');
});
