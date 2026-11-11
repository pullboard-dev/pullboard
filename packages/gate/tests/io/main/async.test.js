/** Exercise the real asynchronous local backend inside the admitted test executor [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runProfiledShellAsync } from '../../../index.js';
import { runFixtureGit } from '../../../../../apps/cli/tests/fixtures/child.js';

test('the asynchronous gate backend runs its child and writes a terminal profile [C7]', async t => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-async-backend-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  runFixtureGit(['init', '-q'], { cwd: root, encoding: 'utf8' });
  const result = await runProfiledShellAsync(root, 'printf async-backend-ready', { gateSlotHeld: true });
  assert.equal(result.isGreen, true, result.output);
  assert.match(result.output, /async-backend-ready/u);
  assert.equal(existsSync(result.profilePath), true);
  const profile = JSON.parse(readFileSync(result.profilePath, 'utf8'));
  assert.ok(profile.wallMs >= 0);
});
