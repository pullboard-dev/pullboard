/** A project whose main holds the focused runner with a per-test timeout, for the pulled `pullboard test` journeys [C7]. */
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fixtureProjectPolicy } from '../testkit.js';

export const PASSES = "import { test } from 'node:test';\ntest('passes', () => {});\n";
export const HANGS = "import { test } from 'node:test';\ntest('hangs', () => new Promise(() => {}));\n";
export const FAILS = "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest('fails here', () => assert.equal(1, 2));\n";

/** A project whose main holds the focused runner with its per-test timeout and a test that hangs on main as well; the agent's failing change is committed on its worktree, since a pulled job runs the committed head. */
export function focusedProject(e2e) {
  const box = e2e.project('true');
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  fixtureProjectPolicy(box.repo, { config: { ...config, affectedTests: 'node --test --test-reporter=tap --test-timeout=3000' } });
  mkdirSync(join(box.repo, 'test'));
  for (const [name, text] of [['ok', PASSES], ['hang', HANGS], ['changed', PASSES]]) writeFileSync(join(box.repo, `test/${name}.test.js`), text);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: focused runner and three test files');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  writeFileSync(join(box.web, 'test/changed.test.js'), FAILS);
  box.git(box.web, 'add', '-A');
  box.git(box.web, 'commit', '-q', '-m', 'test: the changed file fails');
  return box;
}

