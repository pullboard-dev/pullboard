/** @pullboard-world-pin reads every tracked file under apps/cli/tests/fixtures to prove none names a machine host [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const WORD = ['van', 'illa'].join('');

test('clause 1: no tracked file under apps/cli/tests/fixtures contains the Studio host name [C7]', () => {
  const files = execFileSync('git', ['ls-files', '-z', 'apps/cli/tests/fixtures'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0').filter(Boolean);
  const hits = files.filter((f) => readFileSync(join(ROOT, f), 'utf8').toLowerCase().includes(WORD));
  assert.deepEqual(hits, []);
});

test('clause 2: the edited fixture module still loads and exports its helpers [C7]', async () => {
  const module = await import('./fixtures/test.js');
  assert.ok(Object.values(module).some((value) => typeof value === 'function'));
});
