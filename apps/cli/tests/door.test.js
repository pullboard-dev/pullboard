/** The cli app's light core.js door loads fast and pulls neither the command table nor cli-main [C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as core from '../light.js';
import * as door from '../index.js';

const CORE = fileURLToPath(new URL('../light.js', import.meta.url));

test('cli.door.core-js-exports-selectedtoolentry-and-asksversion-the: core.js exports selectedToolEntry and asksVersion, the same functions index.js carries [C7]', () => {
  assert.deepEqual(Object.keys(core).sort(), ['asksVersion', 'selectedToolEntry']);
  for (const name of Object.keys(core)) assert.equal(door[name], core[name], name);
});

test('cli.door.loading-core-js-resolves-neither-the-command: loading core.js resolves neither the command table nor cli-main, in under 100 ms of module work [C7]', () => {
  const script = `
    import { registerHooks } from 'node:module';
    const seen = [];
    registerHooks({ resolve(specifier, context, next) { const out = next(specifier, context); seen.push(out.url); return out; } });
    const started = performance.now();
    await import(process.argv[1]);
    console.log(JSON.stringify({ seen, ms: performance.now() - started }));`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script, CORE], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const { seen, ms } = JSON.parse(run.stdout.trim().split('\n').pop());
  assert.ok(seen.some(url => url.endsWith('/src/io/pinned/tool/build.js')));
  assert.deepEqual(seen.filter(url => /\/commands\/|\/main\.js$/u.test(url)), []);
  assert.ok(ms < 100, `${ms} ms`);
});
