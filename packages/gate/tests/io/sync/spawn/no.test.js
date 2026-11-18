/** A synchronous child process in a module reached from a leased job, driver or producer entry is refused, with a shrinking baseline [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../fixtures/child.js';
import { syncCallsIn } from '../../../../../codemap/index.js';
import { syncSpawnProblems } from '../../../../../codemap/index.js';
import { syncSpawnReport } from '../../../../../codemap/index.js';
import { STATIC_CHECKS } from '../../../../heavy.js';

const REPO = join(import.meta.dirname, '../../../../../..');
const made = [];
after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

/** A fixture tree with a leased entry, a helper it imports, an unrelated module, and the check's config. */
function fixture(config = {}, extra = {}) {
  const inputs = privateFixtureFiles('sync-spawn-leases-');
  made.push(inputs.root);
  const files = {
    'packages/gate/data/ceilings/sync-spawn-in-leases.json': JSON.stringify({ entries: ['packages/jobs/src/io/'], baseline: {}, ...config }),
    'packages/jobs/src/io/job.js': "import { prepare } from '../../../util/prepare.js';\nexport const run = () => prepare();\n",
    'packages/util/prepare.js': "import { spawnSync } from 'node:child_process';\nexport function prepare() {\n  return spawnSync('git', ['status']);\n}\n",
    'packages/other/unleased.js': "import { execSync } from 'node:child_process';\nexport const x = () => execSync('ls');\n",
    ...extra,
  };
  for (const [file, text] of Object.entries(files)) inputs.write(file, text);
  return inputs.root;
}

/** Problems as `path:line` plus their text, for assertions. */
function lines(root) {
  return syncSpawnProblems(root).map(row => `${row.path}:${row.line}: ${row.text}`);
}

test('gate.io-sync-spawn-no.spawnsync-execsync-and-execfilesync-in-a: clause 1: spawnSync, execSync and execFileSync in a module reached from a leased entry are refused by file and line, and unreached files are not [C7]', () => {
  const root = fixture({}, {
    'packages/util/exec.js': "import { execFileSync as run } from 'node:child_process';\nexport const a = () => run('ls');\n// execSync('commented') is not code\nexport const b = 'execSync(\"in a string\")';\n",
    'packages/jobs/src/io/more.js': "import { a } from '../../../util/exec.js';\nimport { execSync } from 'node:child_process';\nexport const m = () => { a(); return execSync('pwd'); };\n",
  });
  const text = lines(root).join('\n');
  assert.match(text, /^packages\/jobs\/src\/io\/more\.js:3: synchronous child process in leased work \(reached from packages\/jobs\/src\/io\/more\.js\)/mu, 'an entry file itself is judged, by line');
  assert.match(text, /^packages\/util\/prepare\.js:3: synchronous child process in leased work \(reached from packages\/jobs\/src\/io\/(?:job|more)\.js\)/mu, 'a helper reached by import is judged, naming its entry');
  assert.match(text, /^packages\/util\/exec\.js:2:/mu, 'an aliased execFileSync call is found');
  assert.doesNotMatch(text, /unleased\.js/u, 'a module no entry reaches is not judged');
  assert.doesNotMatch(text, /exec\.js:[34]:/u, 'a comment and a string are not calls');
  assert.deepEqual(syncCallsIn("import { spawnSync as s } from 'x';\ns();\nspawnSync();\ncp.execSync('a');\n").map(call => call.line), [2, 3, 4]);
});

test('gate.io-sync-spawn-no.existing-calls-listed-in-the-baseline: clause 1: existing calls listed in the baseline pass, growth past the baseline is refused, and the baseline can only fall [C7]', () => {
  const baseline = { 'packages/util/prepare.js': 1 };
  assert.deepEqual(lines(fixture({ baseline })), [], 'a listed call passes');
  const grown = fixture({ baseline }, { 'packages/util/prepare.js': "import { spawnSync } from 'node:child_process';\nexport const a = () => spawnSync('a');\nexport const b = () => spawnSync('b');\n" });
  const text = lines(grown).join('\n');
  assert.match(text, /prepare\.js:2: .*2 calls exceed the baseline 1/u);
  assert.match(text, /prepare\.js:3: .*2 calls exceed the baseline 1/u, 'every call site in the grown file is named');
  const fewer = fixture({ baseline: { 'packages/util/prepare.js': 3 } });
  assert.deepEqual(lines(fewer), [], 'a baseline above today still passes; --write lowers it');
  assert.equal(syncSpawnReport(fewer)['packages/util/prepare.js'].lines.length, 1);
});

test('gate.io-sync-spawn-no.the-committed-baseline-lists-every-existing: clause 1: the committed baseline lists every existing use, so this repository passes today and submit runs the check [C7]', () => {
  assert.deepEqual(syncSpawnProblems(REPO), [], 'no leased module calls more than its baseline');
  assert.ok(STATIC_CHECKS.some(check => check.name === 'sync-spawn-in-leases'), 'the static registry runs the check');
  const reached = syncSpawnReport(REPO);
  assert.ok(Object.keys(reached).length > 0, 'the leased entries reach existing uses');
});
