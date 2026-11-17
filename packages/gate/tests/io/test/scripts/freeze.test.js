/** @pullboard-test-input packages/gate/src/io/test/freeze.js packages/gate/src/io/test/scripts/freeze.js packages/gate/src/io/test/freeze/plan.js packages/gate/data/tests/freeze-moves.json */
/** The freeze script moves, converts or deletes test files from the manifest's tags in one change, and its dry run touches nothing [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runFreezeCommand } from '../../../../src/io/test/freeze.js';
import { FREEZE_RECORD_FILE } from '../../../../src/io/test/freeze.js';
import { generatedTestFor } from '../../../../src/io/test/freeze.js';
import { planFreeze } from '../../../../src/io/test/freeze/plan.js';
import { rebaseSpecifiers } from '../../../../src/io/test/freeze/plan.js';
import { privateFixtureFiles } from '../../../fixtures/child.js';
import { runFixtureGit } from '../../../fixtures/child.js';

const row = (file, kind, specs, extra = {}) => ({ file, kind, specs, unproven: !specs.length, ...extra });
const ROWS = [
  row('apps/cli/journeys/add/main.test.js', 'journey', ['A1'], { tag: 'keep', tagBecause: 'walks the golden path add' }),
  row('apps/cli/journeys/fact/packet.test.js', 'journey', ['F1'], { tag: 'convert', tagBecause: 'cites a spec id no cell unit or contract test cites' }),
  row('apps/cli/journeys/dup/covered.test.js', 'journey', ['M1'], { tag: 'delete', tagBecause: 'covered' }),
  row('apps/cli/journeys/dup/bare.test.js', 'journey', ['Z9'], { tag: 'delete', tagBecause: 'claimed covered' }),
  row('apps/cli/journeys/dup/nospec.test.js', 'journey', [], { tag: 'delete', tagBecause: 'no ids' }),
  row('packages/math/tests/add.test.js', 'cell unit', ['M1']),
];
const OWNERS = { 'apps/cli/journeys/add/main.test.js': 'packages/math', 'apps/cli/journeys/fact/packet.test.js': 'packages/math' };
const owner = file => OWNERS[file] ?? null;

/** A private Git repository holding the synthetic tests and the manifest; nothing here ever touches the real repo. */
function fixture(t) {
  const files = privateFixtureFiles('pullboard-freeze-');
  t.after(() => rmSync(files.root, { recursive: true, force: true }));
  const sh = (...args) => runFixtureGit(args, { cwd: files.root });
  sh('init', '-q');
  const sources = {
    'package.json': '{"type":"module"}',
    'packages/math/tests/registry.json': JSON.stringify({ A1: {}, F1: {}, M1: {} }),
    'packages/math/tests/add.test.js': "test('M1: adds', () => {});\n",
    'apps/cli/journeys/add/main.test.js': "import { x } from '../../tests/fixtures/e2e.js';\ntest('A1: adds', () => {});\n",
    'apps/cli/journeys/fact/packet.test.js': "test('F1: packet', () => {});\n",
    'apps/cli/journeys/dup/covered.test.js': "test('M1: again', () => {});\n",
    'apps/cli/journeys/dup/bare.test.js': "test('Z9: nobody', () => {});\n",
    'apps/cli/journeys/dup/nospec.test.js': 'x;\n',
    'packages/gate/data/tests/test-manifest.json': JSON.stringify({ version: 1, files: ROWS }),
  };
  for (const [file, source] of Object.entries(sources)) files.write(file, source);
  sh('add', '-A');
  sh('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
  return { ...files, sh };
}

test('gate.io-test-scripts-freeze.a-journey-tagged-delete-is-removed: a journey tagged delete is removed only when the manifest names a covering test [C7]', () => {
  const plan = planFreeze(ROWS, { owner });
  const by = file => plan.find(change => change.file === file);
  assert.deepEqual(by('apps/cli/journeys/dup/covered.test.js').coveredBy, ['packages/math/tests/add.test.js']);
  assert.equal(by('apps/cli/journeys/dup/covered.test.js').action, 'delete');
  assert.equal(by('apps/cli/journeys/dup/bare.test.js').action, 'refused');
  assert.match(by('apps/cli/journeys/dup/bare.test.js').because, /no test covers Z9/u);
  assert.equal(by('apps/cli/journeys/dup/nospec.test.js').action, 'refused');
});

test('gate.io-test-scripts-freeze.kept-and-converted-files-move-into: kept and converted files move into the owning cell tests folder, with old and new paths recorded [C7]', t => {
  const repo = fixture(t);
  const { status, stdout, stderr } = runFreezeCommand([repo.root], { owner });
  assert.equal(status, 0, stderr);
  assert.match(stdout, /1 delete, 1 move, 1 convert, 0 in place, 2 refused/u);
  assert.ok(existsSync(`${repo.root}/packages/math/tests/journeys/add/main.test.js`));
  assert.ok(existsSync(`${repo.root}/packages/math/tests/journeys/fact/packet.test.js`));
  assert.ok(!existsSync(`${repo.root}/apps/cli/journeys/add/main.test.js`));
  assert.ok(!existsSync(`${repo.root}/apps/cli/journeys/dup/covered.test.js`));
  assert.ok(existsSync(`${repo.root}/apps/cli/journeys/dup/bare.test.js`), 'an uncovered delete stays');
  const record = JSON.parse(readFileSync(`${repo.root}/${FREEZE_RECORD_FILE}`, 'utf8'));
  assert.deepEqual(record.moved.map(({ from, to, action }) => [from, to, action]), [
    ['apps/cli/journeys/add/main.test.js', 'packages/math/tests/journeys/add/main.test.js', 'move'],
    ['apps/cli/journeys/fact/packet.test.js', 'packages/math/tests/journeys/fact/packet.test.js', 'convert'],
  ]);
  assert.ok(record.moved.every(entry => entry.idsFollowed), 'stable test IDs follow every move');
  assert.deepEqual(record.deleted.map(({ file, coveredBy }) => [file, coveredBy]), [['apps/cli/journeys/dup/covered.test.js', 1]], 'a deletion records how many tests cover it, not their list');
  assert.match(readFileSync(`${repo.root}/packages/math/tests/journeys/add/main.test.js`, 'utf8'), /from '\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/apps\/cli\/tests\/fixtures\/e2e\.js'/u);
});

test('gate.io-test-scripts-freeze.the-dry-run-prints-every-planned: the dry run prints every planned change and the count per action without touching files [C7]', t => {
  const repo = fixture(t);
  const before = runFixtureGit(['status', '--porcelain'], { cwd: repo.root });
  const { status, stdout } = runFreezeCommand(['--dry-run', '--manifest', 'packages/gate/data/tests/test-manifest.json', repo.root], { owner });
  assert.equal(status, 0);
  assert.match(stdout, /would move: apps\/cli\/journeys\/add\/main\.test\.js -> packages\/math\/tests\/journeys\/add\/main\.test\.js/u);
  assert.match(stdout, /would delete: apps\/cli\/journeys\/dup\/covered\.test\.js covered by packages\/math\/tests\/add\.test\.js/u);
  assert.match(stdout, /would refused: apps\/cli\/journeys\/dup\/bare\.test\.js/u);
  assert.match(stdout, /dry run: 1 delete, 1 move, 1 convert, 0 in place, 2 refused\n$/u);
  assert.equal(runFixtureGit(['status', '--porcelain'], { cwd: repo.root }), before);
  assert.ok(existsSync(`${repo.root}/apps/cli/journeys/add/main.test.js`));
  assert.ok(!existsSync(`${repo.root}/${FREEZE_RECORD_FILE}`));
});

test('gate.io-test-scripts-freeze.a-moved-file-keeps-its-imports: a moved file keeps its imports pointing at the same targets [C7]', () => {
  assert.equal(rebaseSpecifiers("import a from './a.js'; await import('../b.js');", 'x/y/t.test.js', 'x/z/w/t.test.js'),
    "import a from '../../y/a.js'; await import('../../b.js');");
});

test('gate.io-test-scripts-freeze.the-freeze-record-names-a-generated: clause 1: the freeze record names a generated move-table test for every deleted release, claim, submit, verify and landing journey [C7,#8744]', () => {
  const root = join(import.meta.dirname, '../../../../../..');
  const record = JSON.parse(readFileSync(join(root, FREEZE_RECORD_FILE), 'utf8'));
  const folder = file => /^apps\/cli\/journeys\/([^/]+)\//u.exec(file)?.[1];
  const wanted = record.deleted.filter(entry => ['release', 'claim', 'submit', 'verify', 'land'].includes(folder(entry.file)));
  assert.ok(wanted.length > 100, 'the record holds those deleted journeys');
  for (const entry of wanted) {
    assert.equal(entry.generatedBy, generatedTestFor(entry.file), `${entry.file} names its generated test`);
    assert.match(entry.generatedBy, /^packages\/moves\/tests\/logic\/table\/(?:release|claim|submit|verify|landing)-generated\.test\.js$/u);
    assert.ok(existsSync(join(root, entry.generatedBy)), `${entry.generatedBy} exists`);
  }
  assert.ok(record.deleted.filter(entry => !wanted.includes(entry)).every(entry => entry.generatedBy === undefined), 'other deletions name none');
  assert.equal(generatedTestFor('apps/cli/journeys/add/main.test.js'), null);
});
