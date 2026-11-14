/** @pullboard-test-input apps/cli/src/io/commands/hold.js apps/cli/src/io/commands/land.js */
/** Automatic landing schedules its own next wake while verified items wait [C7,#2898]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test('releasing a verified item hold wakes landing the way an accept does [C7,#2898]', () => {
  const source = readFileSync(new URL('../../../../src/io/commands/hold.js', import.meta.url), 'utf8');
  assert.match(source, /item_status === 'verified'\) released = ctx/u);
  assert.match(source, /landAfterAcceptance\(released\)/u);
});

test('#6807 clause 2: neither executeBoardLanding nor landingBatchRunner is named in apps/cli/src or packages/landing/src [C7,#6807]', () => {
  const roots = ['../../../../src', '../../../../../../packages/landing/src'].map(path => fileURLToPath(new URL(path, import.meta.url)));
  const named = roots.flatMap(root => readdirSync(root, { recursive: true }).filter(file => file.endsWith('.js'))
    .filter(file => /\b(?:executeBoardLanding|landingBatchRunner)\b/u.test(readFileSync(join(root, file), 'utf8'))).map(file => join(root, file)));
  assert.deepEqual(named, []);
});
