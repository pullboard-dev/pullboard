/** Core code names no test runner or operating system: a new literal outside the adapters is refused, with a shrinking baseline [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { privateFixtureFiles } from '../../../../apps/cli/tests/fixtures/child.js';
import { assumptionProblems } from '../../../codemap/index.js';
import { assumptionsIn } from '../../../codemap/index.js';
import { writeAssumptionBaseline } from '../../../codemap/index.js';
import { STATIC_CHECKS } from '../../index.js';

const REPO = join(import.meta.dirname, '../../../..');
const made = [];
after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

/** A fixture tree with one clean core file, one adapter, and the check's config. */
function fixture(config = {}, extra = {}) {
  const inputs = privateFixtureFiles('no-runtime-assumptions-');
  made.push(inputs.root);
  const files = {
    'packages/gate/data/ceilings/no-runtime-assumptions.json': JSON.stringify({ adapters: ['packages/adapter/'], baseline: {}, ...config }),
    'packages/core/clean.js': "export const answer = 42;\n",
    'packages/adapter/node.js': "export const pattern = /\\.test\\.js$/u;\nexport const shell = '/bin/sh';\nexport const mac = process.platform === 'darwin';\n",
    ...extra,
  };
  for (const [file, text] of Object.entries(files)) inputs.write(file, text);
  return inputs.root;
}

/** Problems as `path:line` plus their text, for assertions. */
function lines(root) {
  return assumptionProblems(root).map(row => `${row.path}:${row.line}: ${row.text}`);
}

test('clause 1: a new .test.js, node --test, /bin/sh or darwin literal in a core file is refused by file and line, and adapters, tests and comments are not [C7]', () => {
  const root = fixture({}, {
    'packages/core/runner.js': "export const pick = name => name.endsWith('.test.js');\n",
    'packages/core/shell.js': "import { spawn } from 'node:child_process';\nexport const run = () => spawn('/bin/sh', ['-c', 'ls']);\n",
    'packages/core/mac.js': "export const mac = () => process.platform === 'darwin';\n",
    'packages/core/cmd.js': "export const cmd = 'node --test test/a.test.js';\n",
    'packages/core/noted.js': "// the /bin/sh and node --test names in a comment are prose, not code\nexport const x = 1;\n",
    'packages/core/pattern.js': "export const isTest = /\\.test\\.[cm]?js$/u;\n",
    'test/helper.test.js': "export const shell = '/bin/sh';\n",
  });
  const text = lines(root).join('\n');
  assert.match(text, /^packages\/core\/runner\.js:1: core code names a \.test\.js file name/mu);
  assert.match(text, /^packages\/core\/shell\.js:2: core code names \/bin\/sh/mu);
  assert.match(text, /^packages\/core\/mac\.js:1: core code names a darwin check/mu);
  assert.match(text, /^packages\/core\/cmd\.js:1: core code names node --test/mu);
  assert.match(text, /^packages\/core\/pattern\.js:1: core code names a \.test\.js file name/mu, 'a regular expression names the runner too');
  assert.doesNotMatch(text, /adapter\/node\.js/u, 'an adapter path may name them');
  assert.doesNotMatch(text, /noted\.js/u, 'a comment is not code');
  assert.doesNotMatch(text, /helper\.test\.js/u, 'a test file judges nothing');
  assert.doesNotMatch(text, /clean\.js/u);
  assert.deepEqual(assumptionsIn("const a = '/bin/sh'; const b = 'darwin';\n").map(site => site.kind), ['binSh', 'darwin']);
});

test('clause 1: adding one such line to a clean core file is refused, and the same line in an adapter is not [C7]', () => {
  const root = fixture();
  assert.deepEqual(lines(root), [], 'a clean tree passes');
  const added = fixture({}, { 'packages/core/clean.js': "export const answer = 42;\nexport const shell = '/bin/sh';\n" });
  assert.match(lines(added).join('\n'), /^packages\/core\/clean\.js:2: core code names \/bin\/sh: 1 sites exceed the baseline 0/mu);
  const moved = fixture({}, { 'packages/adapter/shell.js': "export const shell = '/bin/sh';\n" });
  assert.deepEqual(lines(moved), [], 'the line in an adapter passes');
});

test('clause 2: existing sites listed in the baseline pass, growth past it is refused, and --write only lowers it [C7]', () => {
  const dirty = { 'packages/core/old.js': "export const a = '/bin/sh';\nexport const b = '/bin/sh';\n" };
  const baseline = { 'packages/core/old.js': { binSh: 2 } };
  assert.deepEqual(lines(fixture({ baseline }, dirty)), [], 'listed sites pass');
  const grown = fixture({ baseline: { 'packages/core/old.js': { binSh: 1 } } }, dirty);
  const text = lines(grown).join('\n');
  assert.match(text, /old\.js:1: .*2 sites exceed the baseline 1/u);
  assert.match(text, /old\.js:2: .*2 sites exceed the baseline 1/u, 'every site in the grown file is named');
  const fewer = fixture({ baseline: { 'packages/core/old.js': { binSh: 5 }, 'packages/core/gone.js': { darwin: 1 } } }, dirty);
  assert.deepEqual(writeAssumptionBaseline(fewer), [], 'the write leaves no growth');
  const written = JSON.parse(readFileSync(join(fewer, 'packages/gate/data/ceilings/no-runtime-assumptions.json'), 'utf8'));
  assert.deepEqual(written.baseline, { 'packages/core/old.js': { binSh: 2 } }, 'a baseline above today falls to it and a file with no sites leaves the list');
});

test('clause 2: node packages/gate/src/io/assumptions.js --check exits 0 on this repository and submit runs the check [C7]', () => {
  assert.deepEqual(assumptionProblems(REPO), [], 'no core file names more than its baseline');
  assert.ok(STATIC_CHECKS.some(check => check.name === 'no-runtime-assumptions'), 'the static registry runs the check');
  const run = spawnSync(process.execPath, [join(REPO, 'packages/gate/src/io/assumptions.js'), '--check'], { cwd: REPO, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
});
