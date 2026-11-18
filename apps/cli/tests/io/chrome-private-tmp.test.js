// pullboard: browser
/** @pullboard-test-gui */
/** A browser test leaves no Chrome temp folder in TMPDIR after it exits; moved from packages/drive so packages keep off the CLI fixture kit [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { launchChromeProcess } from '../fixtures/chrome.js';

/** The com.google.Chrome* names currently in the shared temp directory. */
function chromeTemps() { return readdirSync(tmpdir()).filter(name => name.startsWith('com.google.Chrome')); }

test('cli.io-chrome-private-tmp.a-browser-test-run-leaves-no-com: a browser-test run leaves no com.google.Chrome folder in its TMPDIR after it exits [C7]', async () => {
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
