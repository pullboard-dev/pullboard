/** The thin pre-commit and commit-msg hook processes load at least 25 percent fewer modules than the whole-CLI graph they loaded before [C7,#8841]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after } from 'node:test';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { createE2eHelpers } from '../../fixtures/e2e.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

const BIN = resolve(import.meta.dirname, '../../../pullboard.js');

/** Modules each commit-hook process loaded before the thin path was cut, counted by this test on a runner at main (run id in the item thread). */
const BEFORE = { 'pre-commit': 100000, 'commit-msg': 100000, 'post-commit': 100000 };

/** The most modules the pre-commit and commit-msg processes may load: 25 percent under the count before. */
const MOST = hook => Math.floor(BEFORE[hook] * 0.75);

const HOOKS_OF_LOADER = `
let counts;
export function initialize(data) { counts = new Int32Array(data.shared); }
export async function load(url, context, next) { if (url.startsWith('file:')) Atomics.add(counts, 0, 1); return next(url, context); }
`;

/**
 * Run one hook process the way git does, with a loader that counts every file module it loads, and return the count.
 * Why: the count is the process's real module graph, static and dynamic, so a lazy import that still runs is counted.
 *
 * @param {{ env: Record<string, string> }} box
 * @param {string} cwd the checkout the hook runs in
 * @param {string} hook the hook name
 * @param {string[]} extra the hook's own arguments
 * @returns {number}
 */
function modulesLoaded(box, cwd, hook, extra = []) {
  const dir = privateFixtureFiles('pullboard-hook-modules-').root;
  const out = join(dir, `${hook}.count`);
  const counter = join(dir, 'count.mjs');
  const loader = join(dir, 'loader.mjs');
  writeFileSync(loader, HOOKS_OF_LOADER);
  writeFileSync(counter, `import { register } from 'node:module';
import { writeFileSync } from 'node:fs';
const shared = new SharedArrayBuffer(4);
const counts = new Int32Array(shared);
register(${JSON.stringify(pathToFileURL(loader).href)}, { data: { shared } });
process.on('exit', () => writeFileSync(${JSON.stringify(out)}, String(Atomics.load(counts, 0))));
`);
  const ran = spawnSync(process.execPath, ['--import', counter, BIN, 'hook', hook, ...extra], { cwd, env: { ...box.env, PULLBOARD_HOOK_STATIC: '' }, encoding: 'utf8' });
  assert.ok(existsSync(out), `the ${hook} process wrote no count: status ${ran.status}, signal ${ran.signal}, error ${ran.error}, stderr ${String(ran.stderr).slice(0, 700)}`);
  return Number(readFileSync(out, 'utf8'));
}

/** The three commit-hook processes counted once in the one project this file builds. */
let counted;
function counts() {
  if (counted) return counted;
  const box = e2e.project('true');
  const message = join(privateFixtureFiles('pullboard-hook-message-').root, 'message');
  writeFileSync(message, 'feat(web): count modules [G1]\n');
  counted = {
    'pre-commit': modulesLoaded(box, box.web, 'pre-commit'),
    'commit-msg': modulesLoaded(box, box.web, 'commit-msg', [message]),
    'post-commit': modulesLoaded(box, box.web, 'post-commit'),
  };
  return counted;
}

for (const hook of ['pre-commit', 'commit-msg']) {
  test(`clause 2: the ${hook} process loads at least 25 percent fewer modules than before the cut [C7,#8841]`, t => {
    const loaded = counts()[hook];
    t.diagnostic(`modules loaded: ${JSON.stringify(counts())}`);
    assert.ok(loaded > 0, 'the loader counted the hook process');
    assert.ok(loaded <= MOST(hook), `${hook} loaded ${loaded} modules; at most ${MOST(hook)} (25 percent under ${BEFORE[hook]})`);
  });
}

test('clause 1: all three commit-hook processes are counted, each at most 746 modules [C7,#8841]', t => {
  const loaded = counts();
  t.diagnostic(`modules loaded: ${JSON.stringify(loaded)}`);
  for (const hook of Object.keys(BEFORE)) assert.ok(loaded[hook] > 0 && loaded[hook] <= 746, `${hook} loaded ${loaded[hook]} modules`);
});
