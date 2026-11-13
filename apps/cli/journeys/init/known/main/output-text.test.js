/** Exact case guidance leads ordinary text mode with the real main receipt [V4,B3,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from '../../../../tests/fixtures/affected.js';
import { runCliInProcess } from '../../../../tests/fixtures/process.js';
import { FILE } from '../../../../tests/fixtures/init/known-main-notice.js';

test('identical main case is first in text mode, with its real receipt [V4,B3,C7]', async t => {
  const box = fixture(t);
  const plain = await runCliInProcess(['test', FILE, '--compare-main'], { cwd: box.builder, env: box.env });
  assert.equal(plain.status, 1, plain.stdout + plain.stderr);
  assert.match(plain.stdout.split('\n')[0], new RegExp(`^also fails on main at ${box.main}:`));
  assert.ok(plain.stdout.split('\n')[0].includes('[main receipt '));
});
