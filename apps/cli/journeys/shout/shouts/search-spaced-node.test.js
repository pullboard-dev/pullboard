// pullboard: browser
/** Cockpit search wrappers under a Node at a path with spaces [C7] */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  constants,
  mkdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../tests/fixtures/child.js';

/** Copy this Node into a folder whose name has spaces, so a wrapper that does not quote its path fails. */
function nodeWithSpaces(root) {
  const folder = join(root, 'node with spaces');
  mkdirSync(folder, { recursive: true });
  const node = join(folder, 'node');
  copyFileSync(realpathSync(process.execPath), node, constants.COPYFILE_FICLONE);
  chmodSync(node, 0o700);
  return node;
}

test('search wrappers run when Node lives at a path with spaces [C7]', { timeout: 150_000 }, () => {
  const root = privateFixtureFiles('pullboard-search-spaced-node-').root;
  try {
    const node = nodeWithSpaces(root);
    const pattern = 'row ages read from one captured commit|spec rows keep newest-first order across a capture that moves';
    const args = ['--test', '--test-reporter=tap', '--test-name-pattern', pattern, 'apps/cli/journeys/shout/search.test.js'];
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    // One spaced run: it re-runs the two cases above under the spaced Node, and each of them already runs its own wrapper
    // several times, so repeating the whole run three times only tripled the file's cost.
    const result = spawnSync(node, args, { cwd: process.cwd(), env, encoding: 'utf8', timeout: 120_000 });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    assert.equal(result.status, 0, `spaced Node run failed: ${output}`);
    assert.match(output, /^ok \d+ - row ages read from one captured commit \[N26\]$/m, 'spaced Node run omitted row-age case');
    assert.match(output, /^ok \d+ - spec rows keep newest-first order across a capture that moves \[N26\]$/m, 'spaced Node run omitted moving-capture case');
    assert.match(output, /^# pass 2$/m, 'spaced Node run did not complete both cases');
    assert.doesNotMatch(output, /# SKIP\b/, 'spaced Node run skipped a case');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
