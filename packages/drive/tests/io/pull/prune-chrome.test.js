/** The runner prune removes Chrome temp folders older than an hour [C7]; the launcher's private TMPDIR test sits with the launcher in apps/cli. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pruneChromeTemp } from '../../../index.js';
import { pruneRunnerStores } from '../../../index.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';

const HOUR = 3_600_000;

/** Make a Chrome-named temp folder with one file, last changed `ageMs` ago. */
function leaveChrome(dir, name, ageMs) {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'scoped'), 'x');
  const at = new Date(Date.now() - ageMs);
  utimesSync(join(path, 'scoped'), at, at); utimesSync(path, at, at);
  return path;
}

test('drive.prune-chrome.the-runner-prune-removes-chrome: the runner prune removes Chrome temp folders older than 1 h and keeps newer ones [C7]', t => {
  const { root: dir } = privateFixtureFiles('pullboard-prune-chrome-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const old = leaveChrome(dir, 'com.google.Chrome.old', 2 * HOUR);
  const chromium = leaveChrome(dir, 'org.chromium.Chromium.old', 2 * HOUR);
  const fresh = leaveChrome(dir, 'com.google.Chrome.fresh', 60_000);
  const other = leaveChrome(dir, 'unrelated-old', 2 * HOUR);
  assert.deepEqual(pruneChromeTemp({ dir }).sort(), [old, chromium].sort());
  assert.equal(existsSync(fresh), true);
  assert.equal(existsSync(other), true, 'only Chrome-named folders go');
  const again = leaveChrome(dir, 'com.google.Chrome.again', 3 * HOUR);
  const root = join(dir, 'root'), cache = join(dir, 'cache');
  mkdirSync(root); mkdirSync(cache);
  const result = pruneRunnerStores({ root, cache, tmp: dir, space: () => null });
  assert.ok(result.removed.includes(again), 'pruneRunnerStores runs the same Chrome prune');
});
