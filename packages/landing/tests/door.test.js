/** Landing's light core.js door exports the why-not-landing report and loads no shell file [C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as core from '../light.js';
import * as door from '../index.js';

const CORE = fileURLToPath(new URL('../light.js', import.meta.url));

test('core.js exports landWhy, landWhyLines, landingLine and the two batch-root checks, the same functions index.js carries [C7]', () => {
  assert.deepEqual(Object.keys(core).sort(), ['landWhy', 'landWhyLines', 'landingBatchItemsAtRoot', 'landingBatchOwnsRoot', 'landingLine']);
  for (const name of Object.keys(core)) assert.equal(door[name], core[name], name);
});

test('loading core.js resolves no shell file [C7]', () => {
  const script = `
    import { registerHooks } from 'node:module';
    const seen = [];
    registerHooks({ resolve(specifier, context, next) { const out = next(specifier, context); seen.push(out.url); return out; } });
    await import(process.argv[1]);
    console.log(JSON.stringify(seen));`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script, CORE], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const seen = JSON.parse(run.stdout.trim().split('\n').pop());
  assert.ok(seen.some(url => url.endsWith('/src/logic/land/why.js')));
  assert.deepEqual(seen.filter(url => url.includes('/src/io/')), []);
});
