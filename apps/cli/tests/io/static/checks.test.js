import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { crashLine } from '../../../src/io/static/checks.js';

const checks = fileURLToPath(new URL('../../../src/io/static/checks.js', import.meta.url));

test('a crashed registry child reports its thrown error, not the Node.js banner [C7]', () => {
  const fixture = privateFixtureFiles('pullboard-checks-');
  // The preload throws only in the `-e` child that runs the registry, so the preflight itself starts.
  fixture.write('crash.cjs', "if (process.execArgv.includes('-e')) throw new Error('registry boom');\n");
  const run = spawnSync(process.execPath, [checks], { cwd: fixture.root, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: `--require ${join(fixture.root, 'crash.cjs')}` } });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /could not run: Error: registry boom \(at .*crash\.cjs:1/);
  assert.doesNotMatch(run.stderr, /could not run: Node\.js v/);
});

test('crashLine skips the trailing version banner [C7]', () => {
  assert.equal(crashLine('x.js:3\nthrow 1\n\nTypeError: bad\n    at f (x.js:3:1)\n\nNode.js v22.22.2\n'), 'TypeError: bad (at f (x.js:3:1))');
  assert.equal(crashLine('\nNode.js v22.22.2\n'), 'no output');
});
