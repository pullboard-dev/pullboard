/** @pullboard-world-pin reads every tracked file under packages/moves to prove none names a machine host [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const WORD = ['van', 'illa'].join('');

test('clause 1: no tracked file under packages/moves contains the Studio host name [C7]', () => {
  const files = execFileSync('git', ['ls-files', '-z', 'packages/moves'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0').filter(Boolean);
  const hits = files.filter((f) => readFileSync(join(ROOT, f), 'utf8').toLowerCase().includes(WORD));
  assert.deepEqual(hits, []);
});
