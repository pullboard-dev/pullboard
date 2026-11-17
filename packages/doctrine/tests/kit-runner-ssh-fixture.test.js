/** @pullboard-world-pin: scans the tracked package test files for the CLI app's runner ssh and agent-host fixture paths and reads the app doors, to prove the stand-ins' home is packages/gate tests [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
/** This file names the app paths in its own source, so the scan skips it. */
const SELF = 'packages/doctrine/tests/kit-runner-ssh-fixture.test.js';

/** Tracked package test files that name the CLI app's runner ssh or agent-host fixture (a package test importing the app kit). */
function importersOfAppFixtures() {
  try {
    return execFileSync('git', ['grep', '-lE', 'apps/cli/tests/fixtures/runner/(ssh|agent-host)\\.js', '--', 'packages/*.js'],
      { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(file => file && file !== SELF && /\/tests\//u.test(file));
  } catch (error) {
    if (error.status === 1) return [];
    throw error;
  }
}

test('doctrine.kit-runner-ssh-fixture.clause-1-no-package-test-file-imports: clause 1: no package test file imports the CLI app runner ssh or agent-host fixtures, and the app ssh path re-exports the package one [C7]', () => {
  assert.deepEqual(importersOfAppFixtures(), []);
  const ssh = readFileSync(`${ROOT}packages/gate/tests/fixtures/runner/ssh.js`, 'utf8');
  assert.match(ssh, /export function installSshStandIn\(/u);
  assert.doesNotMatch(ssh, /apps\//u);
  const host = readFileSync(`${ROOT}packages/gate/tests/fixtures/runner/agent-host.js`, 'utf8');
  assert.match(host, /export function startAgentHost\(/u);
  assert.doesNotMatch(host, /apps\//u);
  const door = readFileSync(`${ROOT}apps/cli/tests/fixtures/runner/ssh.js`, 'utf8');
  assert.match(door, /export \* from '[./]*packages\/gate\/tests\/fixtures\/runner\/ssh\.js'/u);
  assert.equal(existsSync(`${ROOT}apps/cli/tests/fixtures/runner/agent-host.js`), false);
});
