/** A cleanup error after the tests finish never changes the result; it is logged for the sweep [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTestSandbox } from '../../../index.js';

test('gate.io-test-cleanup.a-sandbox-whose-removal-fails-is: a sandbox whose removal fails is reported, not thrown, so the run stays green [C7]', t => {
  const sandbox = mkdtempSync(join(tmpdir(), 'pb-sandbox-cleanup-'));
  const locked = join(sandbox, 'locked');
  mkdirSync(locked);
  writeFileSync(join(locked, 'leftover'), 'x');
  chmodSync(locked, 0o500);
  t.after(() => { chmodSync(locked, 0o700); rmSync(sandbox, { recursive: true, force: true }); });
  if (process.getuid?.() === 0) return t.skip('root removes a locked directory');
  const lines = [];
  assert.equal(removeTestSandbox(sandbox, line => lines.push(line)), false);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /SANDBOX_CLEANUP_DEFERRED/u);
  assert.ok(lines[0].includes(sandbox), 'the log names the sandbox for the sweep');
  assert.ok(existsSync(sandbox), 'the leftover stays for the sweep');
});

test('gate.io-test-cleanup.a-removable-sandbox-is-removed-and: a removable sandbox is removed and nothing is logged [C7]', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'pb-sandbox-cleanup-'));
  const lines = [];
  assert.equal(removeTestSandbox(sandbox, line => lines.push(line)), true);
  assert.deepEqual(lines, []);
  assert.equal(existsSync(sandbox), false);
});
