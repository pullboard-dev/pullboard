/** The version probe keeps its 100 ms row because --version --json is answered before the dispatcher loads [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import ceilings from './startup-budget.json' with { type: 'json' };

const REPO = resolve(import.meta.dirname, '../../../..');

test('clause 1: version keeps a 100 ms row and --version --json answers the dispatcher document without loading it [C7]', () => {
  assert.equal(ceilings.version, 100);
  const run = args => runFixtureChild(process.execPath, [resolve(REPO, 'apps/cli/pullboard.js'), ...args], { cwd: REPO, encoding: 'utf8' });
  const thin = run(['--version', '--json']);
  const full = run(['version', '--json']);
  assert.equal(thin.status, 0, thin.stderr);
  assert.equal(thin.stdout, full.stdout);
  assert.deepEqual(JSON.parse(thin.stdout), { version: 1, release: JSON.parse(readFileSync(resolve(REPO, 'package.json'), 'utf8')).version });
});
