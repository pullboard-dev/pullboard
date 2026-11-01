/** Real module graphs distinguish unused barrel capabilities from executable browser work [C7,O5]. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { browserBoundFiles, testsNeedBrowser, withImportParseCache } from '../packages/gate/index.js';

/** Write actual ES modules whose launch expressions the classifier must inspect without executing. */
function graph(t, sources) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-browser-barrel-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [file, source] of Object.entries(sources)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), source);
  }
  return root;
}

const SOURCES = {
  'packages/cell/index.js': "export { read } from './read.js'; export { launch } from './launch.js';",
  'packages/cell/read.js': 'export function read() { return 42; }',
  'packages/cell/launch.js': "import { spawnSync } from 'node:child_process'; export function launch(options) { return spawnSync(options.command, []); }",
  'bridge.js': "export { read as scan, launch as open } from './packages/cell/index.js';",
  'test/scanner.test.js': "import { read } from '../packages/cell/index.js'; read();",
  'test/alias.test.js': "import { scan } from '../bridge.js'; scan();",
  'test/launcher.test.js': "import { open } from '../bridge.js'; open({ command: 'google-chrome' });",
  'test/namespace.test.js': "import * as cell from '../packages/cell/index.js'; cell.read();",
  'test/union.test.js': "import { read } from '../packages/cell/index.js'; import { launch } from '../packages/cell/index.js'; read(); launch({command:'google-chrome'});",
};

test('named barrel reads exclude uncalled executors but aliases and namespace capabilities stay bound [C7,O5]', async t => {
  const root = graph(t, SOURCES);
  await withImportParseCache(async () => {
    for (const file of ['scanner', 'alias']) assert.equal(await testsNeedBrowser(root, [`test/${file}.test.js`], { byLaunch: true }), false, file);
    for (const file of ['launcher', 'namespace', 'union']) assert.equal(await testsNeedBrowser(root, [`test/${file}.test.js`], { byLaunch: true }), true, file);
    assert.equal(await testsNeedBrowser(root, ['test/scanner.test.js'], { byLaunch: false }), true, 'the legacy conservative mode retains its browser reservation');
  });
});

test('unselected barrel modules retain direct and transitive evaluation launches [C7,O5]', async t => {
  for (const source of [
    "import {spawnSync} from 'node:child_process'; spawnSync('google-chrome', []); export function launch() {}",
    "import {spawnSync} from 'node:child_process'; function boot() { spawnSync('google-chrome', []); } boot(); export function launch() {}",
    "import './boot.js'; export function launch() {}",
  ]) {
    const root = graph(t, { ...SOURCES, 'packages/cell/launch.js': source,
      'packages/cell/boot.js': "import {spawnSync} from 'node:child_process'; spawnSync('google-chrome', []);" });
    assert.equal(await testsNeedBrowser(root, ['test/scanner.test.js'], { byLaunch: true }), true, source);
  }
});

test('selected function defaults, callback escapes and function expressions retain browser work [C7,O5]', async t => {
  for (const source of [
    "import {spawnSync} from 'node:child_process'; export function read(value = spawnSync('google-chrome', [])) {return value;}",
    "import {spawnSync} from 'node:child_process'; function work() {spawnSync('google-chrome', []);} export function read() { [1].map(work); }",
    "import {spawnSync} from 'node:child_process'; const work = function named() {spawnSync('google-chrome', []);}; export { work as read };",
    "import {spawnSync} from 'node:child_process'; export const read = () => spawnSync('google-chrome', []);",
    "import {spawnSync} from 'node:child_process'; export function read() { return launch(); } function launch() { spawnSync('google-chrome', []); }",
  ]) {
    const root = graph(t, { ...SOURCES, 'packages/cell/read.js': source });
    assert.equal(await testsNeedBrowser(root, ['test/scanner.test.js'], { byLaunch: true }), true, source);
  }
});

test('barrel cycles and later broader imports never hide a browser capability [C7,O5]', async t => {
  const root = graph(t, { ...SOURCES,
    'packages/cell/index.js': "export { read } from './read.js'; export * from '../../cycle.js';",
    'cycle.js': "export * from './packages/cell/index.js'; export { launch } from './packages/cell/launch.js';",
  });
  assert.equal(await testsNeedBrowser(root, ['test/scanner.test.js'], { byLaunch: true }), false);
  assert.equal(await testsNeedBrowser(root, ['test/union.test.js'], { byLaunch: true }), true);
});

test('the four real scanners stay source-only while real browser journeys retain admission [C7,O5]', async () => {
  const root = resolve(import.meta.dirname, '..');
  const scanners = ['packages/gate/tests/gui-marker-guard.test.js', 'test/cell-lint-guard.test.js',
    'test/shared-wait-guard.test.js', 'test/view-test-policy.test.js'];
  assert.deepEqual(await browserBoundFiles(root, scanners, { byLaunch: true }), []);
  const browsers = ['test/chrome-fixture.test.js', 'test/relay-browser.test.js', 'test/relay-pairing.test.js',
    'test/person-passkey-browser.test.js', 'test/cockpit/shared-wait-browser.test.js'];
  assert.deepEqual(await browserBoundFiles(root, browsers, { byLaunch: true }), browsers);
});
