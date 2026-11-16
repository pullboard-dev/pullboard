/** The version probe keeps its 100 ms row because --version --json is answered before the dispatcher loads [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import ceilings from './startup-budget.json' with { type: 'json' };

const REPO = resolve(import.meta.dirname, '../../../..');
const ENTRY = readFileSync(resolve(REPO, 'apps/cli/pullboard.js'), 'utf8');

test('clause 1: version keeps a 100 ms row and the entry answers --version --json before it loads the dispatcher [C7]', async () => {
  assert.equal(ceilings.version, 100);
  const thin = ENTRY.indexOf("process.argv[3] === '--json'");
  assert.ok(thin > 0, 'pullboard.js has a thin --version --json branch');
  assert.ok(thin < ENTRY.indexOf("await import('./light.js')"), 'the thin branch runs before tool selection');
  assert.ok(thin < ENTRY.indexOf("await import('./src/io/main.js')"), 'the thin branch runs before the dispatcher loads');
  const release = JSON.parse(readFileSync(resolve(REPO, 'package.json'), 'utf8')).version;
  const full = await runCliInProcess(['version', '--json']);
  assert.deepEqual(JSON.parse(full.stdout), { version: 1, release });
  assert.ok(ENTRY.includes('JSON.stringify({ version: 1, release: packageData.version }, null, 2)'), 'the thin branch prints the same document');
});
