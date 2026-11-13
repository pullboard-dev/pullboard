/** The landing CLI smoke runs in at most 10 s on a one-item batch and still refuses a failing command [C7]. */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../tests/fixtures/child.js';
import { runLandingCliSmoke } from '../../../../packages/landing/index.js';

const ROOT = resolve(import.meta.dirname, '../../../..');

test('clause 1: the smoke of this checkout takes at most 10 s [C7]', () => {
  const started = performance.now();
  const { ran } = runLandingCliSmoke(ROOT);
  const elapsed = performance.now() - started;
  assert.deepEqual([...ran].sort(), ['add', 'claim', 'help', 'init', 'join', 'list', 'next', 'show', 'status']);
  assert.ok(elapsed <= 10_000, `the smoke took ${Math.round(elapsed)} ms`); // budget: declared in the item bar, 10 s, down from 23-86 s on 4 Nov.
});

test('clause 2: the smoke still runs every command and refuses LAND_CLI_SMOKE when one fails [C7]', () => {
  const files = privateFixtureFiles('smoke-budget-');
  // A CLI that answers every command except show, as a broken command in the candidate would.
  files.write('apps/cli/pullboard.js', "if (process.argv[2] === 'show') { console.error('show is broken'); process.exit(3); }\n");
  assert.throws(() => runLandingCliSmoke(files.root), error => error.code === 'LAND_CLI_SMOKE' && /pullboard show/u.test(error.message) && /exits 3/u.test(error.message));
});
