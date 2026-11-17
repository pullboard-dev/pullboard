/** @pullboard-test-input apps/cli/index.js apps/cli/pullboard.js apps/cli/src/io/commands/push-receipts.js apps/cli/src/io/commands/tool-build.js packages/codemap/src/io/layout.js packages/kernel/index.js */
/** The layout check names every root, cell-entry, test and naming violation and holds the counts to a baseline that only lowers [V32,V33]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { fixture } from '../../../landing/tests/fixtures/plan.js';
import { git } from '../../../landing/tests/fixtures/plan.js';
import { layoutCheck } from '../../index.js';
import { layoutCounts } from '../../index.js';
import { layoutRatchet } from '../../index.js';
import { layoutViolations } from '../../index.js';
import { layoutWrite } from '../../index.js';

const CHECK = fileURLToPath(new URL('../../src/io/layout.js', import.meta.url));

/** The rules that fire on a path list, as "rule key" lines. */
function found(paths) {
  return layoutViolations(paths).map(row => `${row.rule} ${row.key}`);
}

test('codemap.layout.the-root-allows-apps-packages: the root allows apps, packages, docs, skills, package.json and the project documents [V32]', () => {
  assert.deepEqual(found(['apps/cli/index.js', 'packages/kernel/index.js', 'docs/a.md', 'skills/x/SKILL.md', 'package.json', 'README.md', 'SPEC.md', '.github/ci.yml']), []);
});

test('codemap.layout.any-other-root-entry-is: any other root entry is named, and bin, src, relay and test are migration aliases [V32]', () => {
  assert.deepEqual(found(['notes.txt', 'tools/run.js', 'bin/a.js', 'bin/b.js', 'src/x.js', 'relay/r.js', 'test/t.test.js']), [
    'alias-root bin', 'alias-root relay', 'alias-root src', 'alias-root test', 'root-entry notes.txt', 'root-entry tools',
  ]);
  assert.match(layoutViolations(['bin/a.js', 'bin/b.js'])[0].detail, /bin\/ \(2 files\)/u);
});

test('codemap.layout.a-cell-holds-index-js: a cell holds index.js, light.js, browser.js, src, tests and data, and nothing else [V33]', () => {
  assert.deepEqual(found(['packages/kern/index.js', 'packages/kern/light.js', 'packages/kern/browser.js', 'packages/kern/src/logic/a.js', 'packages/kern/src/io/b.js', 'packages/kern/data/baselines/c.json']), []);
  assert.deepEqual(found(['packages/kern/index.js', 'packages/kern/extra.js', 'packages/kern/notes/a.md', 'packages/kern/notes/b.md']), [
    'cell-entry packages/kern/extra.js', 'cell-entry packages/kern/notes',
  ]);
});

test('codemap.layout.only-an-app-holds-journeys: only an app holds journeys and one command file [V33]', () => {
  assert.deepEqual(found(['apps/cli/index.js', 'apps/cli/pullboard.js', 'apps/cli/journeys/submit/run.js']), []);
  assert.deepEqual(found(['apps/cli/pullboard.js', 'apps/cli/zeta.js', 'apps/cli/journeys/loose.js']), ['cell-entry apps/cli/zeta.js', 'journey-folder apps/cli/journeys/loose.js']);
  assert.deepEqual(found(['packages/kern/journeys/submit/run.js', 'packages/kern/run.js']), ['cell-entry packages/kern/journeys', 'cell-entry packages/kern/run.js']);
});

test('codemap.layout.core-js-and-pure-js: core.js and pure.js, src/core and src/shell are aliases, counted once each [V33]', () => {
  assert.deepEqual(found(['packages/kern/core.js', 'packages/kern/pure.js', 'packages/kern/src/core/a.js', 'packages/kern/src/core/b.js', 'packages/kern/src/shell/c.js']), [
    'alias-door packages/kern/core.js', 'alias-door packages/kern/pure.js', 'alias-folder packages/kern/src/core', 'alias-folder packages/kern/src/shell',
  ]);
});

test('codemap.layout.src-holds-only-logic-and: src holds only logic and io [V33]', () => {
  assert.deepEqual(found(['packages/kern/src/misc/a.js', 'packages/kern/src/b.js']), ['src-entry packages/kern/src/b.js', 'src-entry packages/kern/src/misc']);
});

test('codemap.layout.tests-mirror-src-and-keep: tests mirror src and keep helpers in fixtures [V33]', () => {
  assert.deepEqual(found(['packages/kern/src/logic/a.js', 'packages/kern/src/io/dir/b.js', 'packages/kern/tests/logic/a.test.js', 'packages/kern/tests/io/dir/b.test.js', 'packages/kern/tests/fixtures/helper.js', 'packages/kern/tests/index.test.js']), []);
  assert.deepEqual(found(['packages/kern/src/logic/a.js', 'packages/kern/tests/a.test.js', 'packages/kern/tests/logic/other.test.js', 'packages/kern/tests/helper.js']), [
    'test-mirror packages/kern/tests/logic/other.test.js', 'test-placement packages/kern/tests/helper.js',
  ]);
});

test('codemap.layout.a-test-in-a-folder: a test in a folder named for its source file mirrors that file [V33]', () => {
  assert.deepEqual(found(['packages/kern/src/io/admission.js', 'packages/kern/tests/io/admission/run.test.js', 'packages/kern/tests/io/admission/stop.test.js']), []);
  assert.deepEqual(found(['packages/kern/src/io/dir/admission.js', 'packages/kern/tests/io/dir/admission/run.test.js']), []);
  assert.deepEqual(found(['packages/kern/src/io/other.js', 'packages/kern/tests/io/admission/run.test.js']), ['test-mirror packages/kern/tests/io/admission/run.test.js']);
});

test('codemap.layout.a-test-with-no-source: a test with no source sits at tests/<topic>.test.js or tests/<group>/<topic>.test.js [V33]', () => {
  assert.deepEqual(found(['packages/kern/src/logic/a.js', 'packages/kern/tests/topic.test.js', 'packages/kern/tests/group/topic.test.js']), []);
  assert.deepEqual(found(['packages/kern/tests/group/deep/topic.test.js']), []);
  assert.deepEqual(found(['packages/kern/tests/group/helper.js']), ['test-placement packages/kern/tests/group/helper.js']);
});

test('codemap.layout.tests-mirror-src-through-the: tests mirror src through the old core and shell names [V33]', () => {
  assert.deepEqual(found(['packages/kern/src/core/a.js', 'packages/kern/tests/logic/a.test.js']), ['alias-folder packages/kern/src/core']);
});

test('codemap.layout.data-is-grouped: data is grouped [V33]', () => {
  assert.deepEqual(found(['packages/kern/data/ceilings/a.json', 'packages/kern/data/tests/b.json', 'packages/kern/data/loose.json', 'packages/kern/data/odd/c.json']), [
    'data-group packages/kern/data/loose.json', 'data-group packages/kern/data/odd',
  ]);
});

test('codemap.layout.data-may-also-hold-plan: data may also hold plan, history and blueprints [V33]', () => {
  assert.deepEqual(found(['packages/kern/data/plan/01.json', 'packages/kern/data/plan/path-map/a.json', 'packages/kern/data/history/152.json', 'packages/kern/data/blueprints/library.json']), []);
});

test('codemap.layout.a-file-never-repeats-its: a file never repeats its cell name or its folder name [V33]', () => {
  assert.deepEqual(found(['packages/kern/src/logic/kern-parse.js', 'packages/kern/src/logic/walk/walk-up.js', 'packages/kern/src/logic/walk/x-up.js', 'packages/kern/src/logic/parse.js']), [
    'name-repeat packages/kern/src/logic/kern-parse.js', 'name-repeat packages/kern/src/logic/walk/walk-up.js',
  ]);
});

test('codemap.layout.moves-and-commands-folders-keep: moves and commands folders keep the names a registry reads, and engines keep the -engine suffix [V33]', () => {
  assert.deepEqual(found(['packages/kern/src/logic/moves/acceptCheck.js', 'packages/kern/src/logic/moves/moves-all-three.js', 'apps/cli/src/io/commands/push-receipts.js', 'apps/cli/src/io/commands/tool-build.js']), []);
  assert.deepEqual(found(['packages/kern/src/logic/misc/acceptCheck.js']), []);
  assert.deepEqual(found(['packages/kern/src/logic/engines/coordinator-actions-engine.js', 'packages/kern/src/logic/engines/main-audit-engine.js', 'packages/kern/src/logic/engines/audit-engine.js', 'packages/kern/tests/logic/engines/audit-engine.test.js']), []);
  assert.deepEqual(found(['packages/kern/src/logic/engines/kern-engine.js']), ['name-repeat packages/kern/src/logic/engines/kern-engine.js']);
  assert.deepEqual(found(['packages/kern/src/logic/other/quick-engine.js']), ['name-length packages/kern/src/logic/other/quick-engine.js']);
});

test('codemap.layout.a-name-is-one-word: a name is one word, or two only when one word would be ambiguous [V33]', () => {
  assert.deepEqual(found(['packages/kern/src/logic/parse.js']), []);
  assert.deepEqual(found(['packages/kern/src/logic/quick-parse.js']), ['name-length packages/kern/src/logic/quick-parse.js']);
  assert.deepEqual(found(['packages/kern/src/logic/quick-parse.js', 'packages/kern/src/io/quick-parse.js']), ['name-length packages/kern/src/io/quick-parse.js', 'name-length packages/kern/src/logic/quick-parse.js']);
  assert.deepEqual(found(['packages/kern/src/logic/fast-parse.js', 'packages/kern/src/logic/slow-parse.js']), []);
  assert.deepEqual(found(['packages/kern/src/logic/a-b-c.js']), ['name-length packages/kern/src/logic/a-b-c.js']);
});

test('codemap.layout.three-files-sharing-a-first: three files sharing a first word become a subfolder [V33]', () => {
  assert.deepEqual(found(['packages/kern/src/logic/cell-a.js', 'packages/kern/src/logic/cell-b.js']), []);
  assert.deepEqual(found(['packages/kern/src/logic/cell-a.js', 'packages/kern/src/logic/cell-b.js', 'packages/kern/src/logic/cell-c.js']), ['name-group packages/kern/src/logic/cell-']);
});

test('codemap.layout.counts-cover-every-rule-and: counts cover every rule and the ratchet refuses a rise but welcomes a fall [V32]', () => {
  const violations = layoutViolations(['notes.txt', 'tools/run.js']);
  const counts = layoutCounts(violations);
  assert.equal(counts['root-entry'], 2);
  assert.equal(counts['name-length'], 0);
  assert.deepEqual(layoutRatchet(counts, { rules: { 'root-entry': 2 } }, violations), { problems: [], lowered: [] });
  assert.match(layoutRatchet(counts, { rules: { 'root-entry': 1 } }, violations).problems[0], /root-entry rose from 1 to 2 \(notes\.txt, tools\)/u);
  assert.match(layoutRatchet(counts, { rules: { 'root-entry': 3 } }, violations).lowered[0], /fell from 3 to 2/u);
  assert.equal(layoutRatchet(counts, null, violations).problems.length, 1);
});

/** A Git repository holding exactly these files, committed: the shared fixture emptied and refilled. */
function repo(t, files) {
  const { root, put } = fixture(t);
  git(root, 'rm', '-rq', '.');
  for (const file of files) put(file, '\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'tree');
  return { root, put, baselineFile: join(root, 'baseline.json') };
}

test('codemap.layout.the-runner-writes-a-baseline: the runner writes a baseline, passes against it, and refuses a rise and a raised write [V32]', t => {
  const { root, baselineFile, put } = repo(t, ['notes.txt', 'packages/kern/index.js']);
  assert.throws(() => layoutCheck(root, { baselineFile }), /LAYOUT_RATCHET/u);
  assert.equal(layoutWrite(root, { baselineFile })['root-entry'], 1);
  assert.deepEqual(layoutCheck(root, { baselineFile }).lowered, []);
  put('more.txt', '\n');
  git(root, 'add', '--', 'more.txt');
  assert.throws(() => layoutCheck(root, { baselineFile }), /root-entry rose from 1 to 2/u);
  assert.throws(() => layoutWrite(root, { baselineFile }), /LAYOUT_RATCHET/u);
  assert.equal(JSON.parse(readFileSync(baselineFile, 'utf8')).rules['root-entry'], 1);
});

test('codemap.layout.node-layout-check-js-check: node layout-check.js --check exits 1 on a rise and 0 within the baseline [V32]', t => {
  const { root } = repo(t, ['packages/kern/index.js', 'packages/kern/src/logic/parse.js']);
  const clean = spawnSync(process.execPath, [CHECK, '--check'], { cwd: root, encoding: 'utf8' });
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /layout: 0 violations/u);
  const { root: bad } = repo(t, ['stray/file.js']);
  const run = spawnSync(process.execPath, [CHECK, '--check'], { cwd: bad, encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /LAYOUT_RATCHET.*root-entry rose from 0 to 1/u);
  assert.match(run.stderr, /next: /u);
});
