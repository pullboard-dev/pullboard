/** The items front door never reaches apps/cli, so loading it before the CLI front door cannot hit a half-built help or view module [C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

test('clause 2: a fresh process imports packages/items/index.js first, then apps/cli/index.js, and both load [C7]', () => {
  const source = [
    "const items = await import('./packages/items/index.js');",
    "const cli = await import('./apps/cli/index.js');",
    "console.log(JSON.stringify({ items: Object.keys(items).length, cli: Object.keys(cli).length }));",
  ].join('\n');
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.doesNotMatch(run.stderr, /before initialization/u);
  const loaded = JSON.parse(run.stdout.trim().split('\n').at(-1));
  assert.ok(loaded.items > 0, 'the items front door exports its API');
  assert.ok(loaded.cli > 0, 'the CLI front door exports its API after items loaded');
});
