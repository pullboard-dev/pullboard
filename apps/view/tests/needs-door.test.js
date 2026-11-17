/** @pullboard-test-input source-cell apps/view */
/** The needs door exports one name and loads no view shell [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

test('clause 1: apps/view/needs.js exports only personNeedsSummary, the same one index.js exports [C7]', async () => {
  const door = await import(doorUrl);
  const index = await import(pathToFileURL(join(viewDir, 'index.js')).href);
  assert.deepEqual(Object.keys(door), ['personNeedsSummary']);
  assert.equal(door.personNeedsSummary, index.personNeedsSummary);
});

test('clause 3: loading apps/view/needs.js loads no io file but needs.js, state.js and its readers, and no logic file outside needs, resume and four pure files [C7]', () => {
  const logFile = join(privateFixtureFiles('needs-door-').root, 'loaded.txt');
  const hook = `
import { appendFileSync } from 'node:fs';
export async function load(url, context, next) {
  appendFileSync(process.env.NEEDS_DOOR_LOG, url + '\\n');
  return next(url, context);
}`;
  const boot = `
import { register } from 'node:module';
register('data:text/javascript,' + encodeURIComponent(${JSON.stringify(hook)}));
await import(${JSON.stringify(doorUrl)});`;
  {
    execFileSync(process.execPath, ['--input-type=module', '-e', boot], {
      env: { ...process.env, NEEDS_DOOR_LOG: logFile },
      stdio: 'pipe',
    });
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
