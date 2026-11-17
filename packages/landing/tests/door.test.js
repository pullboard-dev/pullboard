/** Landing's light core.js door exports the why-not-landing report and the prepared-conflict check, and loads no shell file [C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as core from '../light.js';
import * as door from '../index.js';

const CORE = fileURLToPath(new URL('../light.js', import.meta.url));

test('clause 1: core.js exports landWhy, landWhyLines, landingLine, localReleaseRank, requirePreparedComputedConflict and the two batch-root checks, the same functions index.js carries [C7]', () => {
  assert.deepEqual(Object.keys(core).sort(), ['landWhy', 'landWhyLines', 'landingBatchItemsAtRoot', 'landingBatchOwnsRoot', 'landingLine', 'localReleaseRank', 'requirePreparedComputedConflict']);
  for (const name of Object.keys(core)) assert.equal(door[name], core[name], name);
});

test('clause 2: loading core.js loads no landing file outside src/logic and the computed conflict receipt module [C7]', () => {
  const script = `
    import { registerHooks } from 'node:module';
    const seen = [];
    registerHooks({ load(url, context, next) { seen.push(url); return next(url, context); } });
    await import(process.argv[1]);
    console.log(JSON.stringify(seen));`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script, CORE], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const seen = JSON.parse(run.stdout.trim().split('\n').pop());
  const landing = seen.filter(url => url.includes('/packages/landing/'));
  const outside = landing.filter(url => !url.endsWith('/packages/landing/light.js') && !url.includes('/packages/landing/src/logic/') && !url.endsWith('/packages/landing/src/io/computed/conflict/receipt.js'));
  assert.deepEqual(outside, []);
  assert.ok(landing.some(url => url.endsWith('/src/io/computed/conflict/receipt.js')));
});
