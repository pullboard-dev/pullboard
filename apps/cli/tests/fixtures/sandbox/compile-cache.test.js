/** Journey sandboxes share one compile cache, so the CLI is compiled once per file, not once per sandbox [C7,#10415]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { statSync } from 'node:fs';
import { test } from 'node:test';
import { createE2eHelpers } from '../e2e.js';

test('cli.sandbox-compile-cache.shared-and-filled: clause 1: two sandboxes of one helper name the same private compile cache, a real CLI process fills it, and cleanup removes it [C7,#10415]', () => {
  const e2e = createE2eHelpers();
  let folder;
  try {
    const first = e2e.sandbox();
    const second = e2e.sandbox();
    folder = first.env.NODE_COMPILE_CACHE;
    assert.ok(folder, 'the sandbox names a compile cache');
    assert.equal(second.env.NODE_COMPILE_CACHE, folder, 'both sandboxes of one helper share it');
    assert.equal(statSync(folder).mode & 0o077, 0, 'only this user can read or write it, as the CLI requires');
    assert.equal(first.run(first.dir, 'help').code, 0);
    assert.ok(readdirSync(folder).length > 0, 'the real CLI process wrote its compiled modules into the shared folder');
  } finally {
    e2e.cleanup();
  }
  assert.equal(existsSync(folder), false, 'cleanup removed the shared folder');
});
