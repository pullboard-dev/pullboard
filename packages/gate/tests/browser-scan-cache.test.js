/** The browser scan persists each verdict with its import closure and reuses it until a closure path changes [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { browserBoundFiles } from '../src/shell/browser-admission.js';
import { browserScanCacheFile } from '../src/shell/browser-scan-cache.js';
import { BROWSER_RULE_VERSION } from '../src/shell/browser-scan-cache.js';
import { cacheExists } from '../src/shell/browser-scan-cache.js';
import { cachedVerdictHolds } from '../src/shell/browser-scan-cache.js';
import { readBrowserScanCache } from '../src/shell/browser-scan-cache.js';

/** A committed repository with two test files sharing one helper; `git` runs with a fixed identity. */
function repo(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-scan-cache-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  mkdirSync(join(root, 'test'), { recursive: true });
  mkdirSync(join(root, 'lib'), { recursive: true });
  writeFileSync(join(root, 'lib', 'helper.js'), 'export const helper = 1;\n');
  writeFileSync(join(root, 'test', 'one.test.js'), "import { test } from 'node:test';\nimport { helper } from '../lib/helper.js';\ntest('one', () => { if (!helper) throw new Error('x'); });\n");
  writeFileSync(join(root, 'test', 'two.test.js'), "import { test } from 'node:test';\ntest('two', () => {});\n");
  git('add', '-A'); git('commit', '-q', '-m', 'seed');
  return { root, git };
}

test('the first scan walks every file and writes the cache; the second reuses every verdict [C7]', async (t) => {
  const { root } = repo(t);
  const first = {};
  const bound = await browserBoundFiles(root, ['test/one.test.js', 'test/two.test.js'], { byLaunch: false, stats: first });
  assert.deepEqual(bound, [], 'plain tests need no browser');
  assert.deepEqual(first, { scanned: 2 });
  assert.ok(cacheExists(browserScanCacheFile(root)), 'the cache is written beside the board');
  const cache = readBrowserScanCache(browserScanCacheFile(root));
  assert.ok(cache.entries['test/one.test.js'].closure.includes('lib/helper.js'), 'the closure names the helper the test imports');
  const second = {};
  await browserBoundFiles(root, ['test/one.test.js', 'test/two.test.js'], { byLaunch: false, stats: second });
  assert.deepEqual(second, { reused: 2 });
});

test('a change to a closure path rescans only the files that reach it; an unrelated commit reuses all [C7]', async (t) => {
  const { root, git } = repo(t);
  await browserBoundFiles(root, ['test/one.test.js', 'test/two.test.js'], { byLaunch: false });
  writeFileSync(join(root, 'README.md'), 'unrelated\n');
  git('add', '-A'); git('commit', '-q', '-m', 'docs');
  const unrelated = {};
  await browserBoundFiles(root, ['test/one.test.js', 'test/two.test.js'], { byLaunch: false, stats: unrelated });
  assert.deepEqual(unrelated, { reused: 2 }, 'a tree that left every closure alone reuses both verdicts');
  writeFileSync(join(root, 'lib', 'helper.js'), 'export const helper = 2;\n');
  git('add', '-A'); git('commit', '-q', '-m', 'helper');
  const touched = {};
  await browserBoundFiles(root, ['test/one.test.js', 'test/two.test.js'], { byLaunch: false, stats: touched });
  assert.deepEqual(touched, { reused: 1, scanned: 1 }, 'only the test whose closure holds the helper is walked again');
});

test('a verdict never holds across modes or without a current tree [C7]', () => {
  const entry = { bound: false, byLaunch: false, tree: 'a'.repeat(40), closure: ['test/x.test.js'], ruleVersion: BROWSER_RULE_VERSION };
  assert.equal(cachedVerdictHolds(entry, { byLaunch: true, tree: 'a'.repeat(40), changed: () => new Set() }), false);
  assert.equal(cachedVerdictHolds(entry, { byLaunch: false, tree: null, changed: () => new Set() }), false);
  assert.equal(cachedVerdictHolds(entry, { byLaunch: false, tree: 'b'.repeat(40), changed: () => null }), false, 'an unreadable diff is everything changed');
  assert.equal(cachedVerdictHolds(entry, { byLaunch: false, tree: 'b'.repeat(40), changed: () => new Set(['other.js']) }), true);
});
