/** A file is browser-bound only when its import closure reaches a real Chrome launch, and the verdict says how [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { browserBoundFiles } from '../packages/gate/src/shell/browser-admission.js';
import { BROWSER_RULE_VERSION } from '../packages/gate/src/shell/browser-scan-cache.js';
import { browserScanCacheFile } from '../packages/gate/src/shell/browser-scan-cache.js';
import { currentTree } from '../packages/gate/src/shell/browser-scan-cache.js';
import { readBrowserScanCache } from '../packages/gate/src/shell/browser-scan-cache.js';
import { writeBrowserScanCache } from '../packages/gate/src/shell/browser-scan-cache.js';

const SOURCES = {
  'packages/cell/index.js': "export { read } from './read.js';\nexport { launch } from './launch.js';\nexport { git } from './git.js';\n",
  'packages/cell/read.js': 'export function read() { return 42; }\n',
  'packages/cell/launch.js': "import { spawnSync } from 'node:child_process';\nexport function launch() { return spawnSync('google-chrome', ['--headless']); }\n",
  'packages/cell/git.js': "import { spawnSync } from 'node:child_process';\nexport function git(command) { return spawnSync(command, []); }\n",
  'test/launching.test.js': "import { launch } from '../packages/cell/index.js';\nlaunch();\n",
  'test/free.test.js': "import { read } from '../packages/cell/index.js';\nread();\n",
  'test/helper.test.js': "import { git } from '../packages/cell/index.js';\ngit('git');\n",
};

/** A committed fixture repository holding SOURCES, so the verdict cache has a tree to key on. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-verdict-launch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [file, source] of Object.entries(SOURCES)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), source);
  }
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'seed');
  return root;
}

test('clause 1: a closure binds only through a launch call site and the verdict records the reaching path [C7]', async (t) => {
  const root = fixture(t);
  const reasons = new Map();
  const bound = await browserBoundFiles(root, ['test/launching.test.js', 'test/free.test.js', 'test/helper.test.js'], { byLaunch: true, reasons });
  assert.deepEqual(bound, ['test/launching.test.js'], 'the launch-free importers of the same package take no slot');
  assert.match(reasons.get('test/launching.test.js'), /test\/launching\.test\.js > packages\/cell\/index\.js > packages\/cell\/launch\.js/u);
  assert.equal(reasons.has('test/free.test.js'), false);
  assert.equal(reasons.has('test/helper.test.js'), false, 'a process call with an unknown command and no Chrome in the closure is not a launch');
  const cache = readBrowserScanCache(browserScanCacheFile(root));
  assert.equal(cache.entries['test/launching.test.js'].reason, reasons.get('test/launching.test.js'));
  assert.equal(cache.entries['test/free.test.js'].bound, false);
});

test('clause 2: a cache entry of another rule version is recomputed [C7]', async (t) => {
  const root = fixture(t);
  const file = browserScanCacheFile(root);
  const tree = currentTree(root);
  const stale = { bound: true, byLaunch: true, tree, closure: ['test/free.test.js'], ruleVersion: BROWSER_RULE_VERSION - 1, reason: 'old rule' };
  writeBrowserScanCache(file, { version: 1, entries: { 'test/free.test.js': stale } });
  const stats = {};
  assert.deepEqual(await browserBoundFiles(root, ['test/free.test.js'], { byLaunch: true, stats }), []);
  assert.deepEqual(stats, { scanned: 1 }, 'the stale entry is walked again, not reused');
  assert.equal(readBrowserScanCache(file).entries['test/free.test.js'].ruleVersion, BROWSER_RULE_VERSION);
  const again = {};
  await browserBoundFiles(root, ['test/free.test.js'], { byLaunch: true, stats: again });
  assert.deepEqual(again, { reused: 1 }, 'a current-version entry is reused');
});
