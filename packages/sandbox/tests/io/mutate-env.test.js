/** A journey that passes in the checkout passes in the mutation check's copy: the copy's children take no browser marker from an undeclared parent [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  privateFixtureFiles,
  runFixtureChild,
  runFixtureSetupGit,
} from '../../../gate/tests/fixtures/child.js';
import {
  childEnv,
  mutateCell,
} from '../../src/io/mutate.js';

const GUARD = '--import=file:///work/packages/gate/src/io/browser/guard.js';

test('sandbox.mutate-env.undeclared-job-passes-no-marker: an undeclared parent job passes no browser marker, guard or file name to a child [C7]', () => {
  const env = childEnv({ NODE_TEST_CONTEXT: 'child-v8', PULLBOARD_TEST_BROWSER_SLOT: 'none', PULLBOARD_TEST_FILE: 'a.test.js', NODE_OPTIONS: `--max-old-space-size=512 ${GUARD}`, KEPT: '1' });
  assert.deepEqual(env, { NODE_OPTIONS: '--max-old-space-size=512', KEPT: '1' });
  assert.equal(childEnv({ PULLBOARD_TEST_BROWSER_SLOT: 'none', NODE_OPTIONS: GUARD }).NODE_OPTIONS, undefined);
});

test('sandbox.mutate-env.lease-holder-keeps-lease: a parent job that holds a browser lease keeps it for its children [C7]', () => {
  const held = { PULLBOARD_TEST_BROWSER_SLOT: 'held', PULLBOARD_TEST_FILE: 'a.test.js', NODE_OPTIONS: '--max-old-space-size=512' };
  assert.deepEqual(childEnv(held), held);
});

test('sandbox.mutate-env.chrome-journey-before-fault: a journey that launches Chrome passes before any fault is seeded when the parent job is undeclared [C7]', async (t) => {
  const box = privateFixtureFiles('mutate-env-');
  mkdirSync(join(box.root, 'cell'));
  writeFileSync(join(box.root, 'cell', 'a.js'), 'export const a = 1;\n');
  writeFileSync(join(box.root, 'cell', 'a.test.js'), "import { test } from 'node:test';\ntest('cell', () => {});\n");
  writeFileSync(join(box.root, 'journey.test.js'), "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest('journey', () => { assert.notEqual(process.env.PULLBOARD_TEST_BROWSER_SLOT, 'none'); assert.doesNotMatch(process.env.NODE_OPTIONS ?? '', /guard\\.js/u); });\n");
  const git = (...args) => runFixtureSetupGit(['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd: box.root });
  assert.equal(runFixtureChild('git', ['init', '-q', '-b', 'main'], { cwd: box.root }).status, 0);
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  const saved = { slot: process.env.PULLBOARD_TEST_BROWSER_SLOT, options: process.env.NODE_OPTIONS };
  t.after(() => {
    for (const [key, value] of [['PULLBOARD_TEST_BROWSER_SLOT', saved.slot], ['NODE_OPTIONS', saved.options]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });
  process.env.PULLBOARD_TEST_BROWSER_SLOT = 'none';
  process.env.NODE_OPTIONS = [saved.options, GUARD].filter(Boolean).join(' ');
  const report = await mutateCell(box.root, 'cell', { all: true, extra: ['journey.test.js'] }, { faults: () => [], changedLines: () => ({}) });
  assert.deepEqual(report.redBefore, []);
});
