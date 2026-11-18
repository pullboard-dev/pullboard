/** The stats light door carries the coordinator action and work-free names without the stats shell [C7]. @pullboard-test-input source-cell packages/stats packages/kernel */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import * as barrel from '../index.js';
import * as door from '../light.js';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const NAMES = ['previousCoordinatorMilestone', 'coordinatorActions', 'coordinatorActionRise', 'readWorkFreeReleases'];
const HOOK = `
import { registerHooks } from 'node:module';
const loaded = new Set();
registerHooks({ load(url, context, next) { loaded.add(url); return next(url, context); } });
await import(process.argv[1]);
console.log(JSON.stringify([...loaded]));
`;

test('stats.coordinator-door.the-stats-door-exports-the-four: the stats door exports the four coordinator action and work-free names strictly equal to the barrel\'s [C7]', () => {
  for (const name of NAMES) {
    assert.equal(typeof door[name], 'function', `${name} is exported by the door`);
    assert.strictEqual(door[name], barrel[name], `${name} is the barrel's function`);
  }
});

test('stats.coordinator-door.loading-the-door-loads-no-file: loading the door loads no stats file outside logic and the actions file, recorded by a module hook [C7]', () => {
  const urls = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', HOOK, new URL('../light.js', import.meta.url).href], { encoding: 'utf8', cwd: ROOT }));
  const stats = urls.filter(url => url.startsWith('file:')).map(url => relative(ROOT, fileURLToPath(url))).filter(file => file.startsWith('packages/stats/src/'));
  assert.ok(stats.includes('packages/stats/src/io/actions.js'), 'the door loads the actions file');
  const outside = stats.filter(file => !file.startsWith('packages/stats/src/logic/') && file !== 'packages/stats/src/io/actions.js');
  assert.deepEqual(outside, [], 'no stats file but logic and io/actions.js loads with the door');
});
