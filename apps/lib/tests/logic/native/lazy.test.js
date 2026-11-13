/** openBoard composes its store ports lazily: a write board opens without the provider packages its ports defer [C7,#7033]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const NATIVE = new URL('../../../src/logic/native.js', import.meta.url).href;

/** Provider packages no board open calls: their ports, and rigor's proof and draft runners, load them at first use. */
const DEFERRED = ['blueprints', 'flakes', 'gate', 'github', 'health', 'landing', 'runners', 'sentinels'];

/**
 * The package front doors a fresh process has loaded after opening an in-memory write board and running `steps`.
 * Why a child process: this test's own imports must not count as the board's loads.
 */
function doorsLoaded(steps = '') {
  const script = `
import { registerHooks } from 'node:module';
const loaded = new Set();
registerHooks({ load(url, context, next) { loaded.add(url); return next(url, context); } });
const native = await import(${JSON.stringify(NATIVE)});
const board = native.openBoard(':memory:');
${steps}
native.closeBoard(board);
process.stdout.write(JSON.stringify([...loaded].map(url => /\\/packages\\/(\\w+)\\/index\\.js$/u.exec(url)?.[1]).filter(Boolean)));`;
  const run = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(run.status, 0, run.stderr);
  return new Set(JSON.parse(run.stdout));
}

test('clause 1: openBoard composes its provider modules lazily: a write board opens loading none of the deferred provider packages [C7,#7033]', () => {
  const loaded = doorsLoaded();
  assert.ok(loaded.has('store') && loaded.has('rigor'), 'the board opened and warmed its rigor counters');
  assert.deepEqual(DEFERRED.filter(name => loaded.has(name)), [], 'no deferred provider package loads at open');
});

test('clause 1: a deferred port loads its own package at its first call, and only that package [C7,#7033]', () => {
  const loaded = doorsLoaded('try { board.nativePorts.landingEnvironment.requireTrunk(); } catch { /* Only the load matters here. */ }');
  assert.ok(loaded.has('landing'), 'the first landing check loads the landing package');
  assert.deepEqual(['blueprints', 'github', 'sentinels'].filter(name => loaded.has(name)), [], 'packages no call reached stay unloaded');
});
