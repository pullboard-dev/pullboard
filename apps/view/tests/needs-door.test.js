/** @pullboard-test-input apps/view/src/** */
/** @pullboard-module-loads apps/view/needs.js apps/view/index.js */
/** The needs door exports one name and loads no view shell [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { join } from 'node:path';
import { relative } from 'node:path';
import { sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { privateFixtureFiles } from '../../../packages/gate/tests/fixtures/child.js';

const viewDir = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const doorUrl = pathToFileURL(join(viewDir, 'needs.js')).href;

test('view.x-needs-door.clause-3-loading-apps-view-needs-js: clause 3: loading apps/view/needs.js loads no io file but needs.js, state.js and its readers, and no logic file outside needs, resume and four pure files [C7]', async () => {
  // Declared first: the hook sees only modules this process has not loaded yet, so nothing may import the door before it.
  const logFile = join(privateFixtureFiles('needs-door-').root, 'loaded.txt');
  writeFileSync(logFile, '');
  const hook = `
import { appendFileSync } from 'node:fs';
export async function load(url, context, next) {
  appendFileSync(${JSON.stringify(logFile)}, url + '\\n');
  return next(url, context);
}`;
  register('data:text/javascript,' + encodeURIComponent(hook));
  await import(doorUrl);
  {
    const loaded = readFileSync(logFile, 'utf8').split('\n').filter((u) => u.startsWith('file:'));
    const logic = ['apps', 'view', 'src', 'logic'].join(sep) + sep;
    const rels = loaded.map((u) => relative(repoRoot, fileURLToPath(u)));
    assert.ok(rels.some((r) => r.endsWith(join('src', 'io', 'needs.js'))), 'the hook saw the needs reader load');
    const io = ['apps', 'view', 'src', 'io'].join(sep) + sep;
    const pure = ['counts.js', 'stale.js', join('live', 'runners.js'), 'public.js'].map((name) => logic + name);
    // state.js reads the dashboard and live-runner state through these three io readers; none is a server module.
    const stateReaders = ['needs.js', 'state.js', join('dashboard', 'recent.js'), join('dashboard', 'gates.js'), join('live', 'read.js')].map((name) => io + name);
    const stray = rels.filter((r) => (r.startsWith(logic)
      && !r.startsWith(logic + 'needs' + sep)
      && r !== logic + 'resume.js'
      && !pure.includes(r))
      || (r.startsWith(io) && !stateReaders.includes(r)));
    assert.deepEqual(stray, []);
  }
});

test('view.x-needs-door.clause-1-apps-view-needs-js-exports: clause 1: apps/view/needs.js exports only personNeedsSummary, the same one index.js exports [C7]', async () => {
  const door = await import(doorUrl);
  const index = await import(pathToFileURL(join(viewDir, 'index.js')).href);
  assert.deepEqual(Object.keys(door), ['personNeedsSummary']);
  assert.equal(door.personNeedsSummary, index.personNeedsSummary);
});
