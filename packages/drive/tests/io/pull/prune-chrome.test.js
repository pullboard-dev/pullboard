// pullboard: browser
/** @pullboard-test-gui */
/** A browser test leaves no Chrome temp folder in TMPDIR, and the runner prune removes stale ones after an hour [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pruneChromeTemp } from '../../../index.js';
import { pruneRunnerStores } from '../../../index.js';
import { launchChromeProcess } from '../../../../../apps/cli/tests/fixtures/chrome.js';
import { privateFixtureFiles } from '../../../../../apps/cli/tests/fixtures/child.js';

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

/** The com.google.Chrome* names currently in the shared temp directory. */
function chromeTemps() { return readdirSync(tmpdir()).filter(name => name.startsWith('com.google.Chrome')); }

test('a browser-test run leaves no com.google.Chrome folder in its TMPDIR after it exits [C7]', async () => {
  const before = new Set(chromeTemps());
  const script = "const { mkdirSync } = require('node:fs'); const { join } = require('node:path'); mkdirSync(join(process.env.TMPDIR, 'com.google.Chrome.fixture'));"
    + " process.on('SIGTERM', () => process.exit(0)); console.error(process.env.TMPDIR); setInterval(() => {}, 1000);";
  const chrome = launchChromeProcess({ executable: process.execPath, args: ['-e', script], env: { ...process.env, TMPDIR: '' } });
  await new Promise(resolve => chrome.child.stderr.once('data', resolve));
  const privateTmp = chrome.stderr.trim();
  assert.notEqual(privateTmp, tmpdir(), 'the launch gets its own TMPDIR');
  assert.ok(existsSync(join(privateTmp, 'com.google.Chrome.fixture')), 'the stand-in made its Chrome temp folder there');
  await chrome.close();
  assert.equal(existsSync(privateTmp), false, 'the private TMPDIR goes with the launch');
  assert.deepEqual(chromeTemps().filter(name => !before.has(name)), [], 'nothing new in the shared temp directory');
});

test('the runner prune removes Chrome temp folders older than 1 h and keeps newer ones [C7]', t => {
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
