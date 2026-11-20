/** @pullboard-test-input source-tree */
/** @pullboard-world-pin reads every committed non-test source file to prove none makes a throwaway folder outside scratchFolder. */
/** No source creates a throwaway folder from tmpdir() outside scratchFolder and an explicit allowlist [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** A throwaway folder made straight from the OS temp root: join(tmpdir(), ...), mkdtemp(tmpdir()...) or `?? tmpdir()`. */
const DIRECT = /\bjoin\(\s*(?:realpathSync\(\s*|fileSystemAdapter\(\)\.realpath\(\s*)?tmpdir\(\)|\bmkdtemp(?:Sync)?\(\s*(?:realpathSync\(\s*)?tmpdir\(\)|\?\?\s*tmpdir\(\)/u;

/** The scratch root's own home: the only places allowed to read the OS temp root as the default. */
const HOME = ['packages/config/src/logic/scratch.js', 'packages/config/src/logic/scratch/folder.js'];

/**
 * Sources that still make folders from tmpdir() directly. The list may only shrink: move a site to scratchFolder, then delete its line.
 * Seats registration.js only lists temp paths and sentinels already use scratchRoot, so neither matches; the rest wait on the scratch slices.
 */
const ALLOWLIST = [
  'docs/tools/guarded-docs-refresh.js',
  'packages/drive/src/io/once.js',
  'packages/gate/src/io/run-tests.js',
  'packages/gate/src/io/snapshot.js',
  'packages/gate/src/io/test/file/dispatch.js',
  'packages/gate/src/io/test/run.js',
  'packages/git/src/io/tools.js',
  'packages/kernel/src/logic/machine.js',
];

/** The non-test source files under apps, packages and docs/tools. */
function sourceFiles() {
  return execFileSync('git', ['ls-files', '*.js'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n')
    .filter(file => /^(?:apps|packages)\/[^/]+\/(?:src\/|[^/]+\.js$)|^docs\/tools\//u.test(file))
    .filter(file => !/(?:^|\/)(?:tests|journeys|fixtures)\/|\.test\.js$/u.test(file));
}

/** The files whose text creates a throwaway folder directly from tmpdir(), outside the scratch root's home. */
export function directSites(files, read) {
  return files.filter(file => !HOME.includes(file) && DIRECT.test(read(file)));
}

test('config.scratch-sites.clause-1-no-source-creates-a-throwaway: clause 1: no source creates a throwaway folder from tmpdir() outside scratchFolder and the allowlist [C7]', () => {
  const extra = directSites(sourceFiles(), file => readFileSync(`${ROOT}${file}`, 'utf8')).filter(file => !ALLOWLIST.includes(file));
  assert.deepEqual(extra, [], `use scratchFolder(prefix) from packages/config instead of tmpdir() in: ${extra.join(', ')}`);
});

test('config.scratch-sites.clause-1-a-source-joining-tmpdir-is: clause 1: a source joining tmpdir() is named by the lint, and the allowlist only lists real sites [C7]', () => {
  const fake = { 'a.js': "const d = mkdtempSync(join(tmpdir(), 'x-'));", 'b.js': "const d = scratchFolder('x-');", 'c.js': 'const d = mkdtempSync(tmpdir());' };
  assert.deepEqual(directSites(Object.keys(fake), file => fake[file]), ['a.js', 'c.js']);
  const sites = new Set(directSites(sourceFiles(), file => readFileSync(`${ROOT}${file}`, 'utf8')));
  assert.deepEqual(ALLOWLIST.filter(file => !sites.has(file)), [], 'an allowlisted file no longer needs its line; delete it');
});
