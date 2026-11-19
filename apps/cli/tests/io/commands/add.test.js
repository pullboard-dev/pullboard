/** add and edit refuse a new test path that mirrors no source file, behind items.testMirrorAtAdd [C7,#10629]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { requireTestMirror } from '../../../src/io/item/bar.js';
import { after } from 'node:test';
import { createE2eHelpers } from '../../fixtures/e2e.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

/** A fixture repo whose main holds one source file and its mirrored test (plus a registry test and record when strict), returned as a context the bar check reads. */
function mainWith(strict = false) {
  const box = helpers.project('true', helpers.sandbox());
  for (const file of ['packages/demo/src/io/thing.js', 'packages/demo/tests/io/thing.test.js', ...(strict ? ['packages/demo/tests/registry.test.js', 'packages/demo/tests/fixtures/registry.json', 'packages/plain/src/io/a.js', 'packages/plain/tests/io/a.test.js'] : [])]) {
    mkdirSync(dirname(join(box.repo, file)), { recursive: true });
    writeFileSync(join(box.repo, file), '// fixture\n');
  }
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'docs: fixture');
  return { info: { root: box.repo } };
}

const bar = tests => ({ criterion: `1. packages/demo/src/io/thing.js is changed and proved by ${tests} [test]`, check: `node --test ${tests}` });

test('cli.io-commands-add.refuses-a-new-test-that-mirrors-no-source: clause 1: with items.testMirrorAtAdd on, a new test path that mirrors no source file is refused LAYOUT_TEST_MIRROR naming the mirror path [C7,#10629]', async () => {
  await assert.rejects(requireTestMirror(mainWith(), bar('packages/demo/tests/io/other.test.js'), true), error => {
    assert.equal(error.code, 'LAYOUT_TEST_MIRROR');
    assert.match(error.message, /packages\/demo\/tests\/io\/other\.test\.js/u);
    assert.match(`${error.next ?? ''}${error.message}`, /packages\/demo\/tests\/io\/thing\.test\.js/u);
    return true;
  });
});

test('cli.io-commands-add.accepts-an-existing-or-mirrored-test-path: clause 2: a test path that exists on main, or that mirrors a source file, is accepted unchanged [C7,#10629]', async () => {
  const ctx = mainWith();
  await requireTestMirror(ctx, bar('packages/demo/tests/io/thing.test.js'), true);
  await requireTestMirror(ctx, { criterion: '1. packages/demo/src/io/fresh.js has a case in packages/demo/tests/io/fresh.test.js [test]' }, true);
});

test('cli.io-commands-add.accepts-any-test-path-with-the-setting-off: clause 3: with the setting off, any test path is accepted as today [C7,#10629]', async () => {
  await requireTestMirror(mainWith(), bar('packages/demo/tests/io/other.test.js'), false);
});

test('cli.io-commands-add.refuses-a-test-in-a-strict-registry-cell-without-its-record: clause 1: with items.testMirrorAtAdd on, a [test] file in a cell holding registry.test.js is refused REGISTRY_TEST_ID naming the record file and the ID prefix [C7,U148,#10677]', async () => {
  await assert.rejects(requireTestMirror(mainWith(true), bar('packages/demo/tests/io/thing.test.js'), true), error => {
    assert.equal(error.code, 'REGISTRY_TEST_ID');
    assert.match(error.message, /packages\/demo\/tests\/fixtures\/registry\.json/u);
    assert.match(`${error.next ?? ''}`, /clause N/u);
    return true;
  });
});

test('cli.io-commands-add.accepts-a-registry-record-or-a-cell-without-one: clause 2: a bar naming the registry record, or a test file in a cell with no registry.test.js, is accepted [C7,U148,#10677]', async () => {
  const ctx = mainWith(true);
  await requireTestMirror(ctx, bar('packages/demo/tests/io/thing.test.js packages/demo/tests/fixtures/registry.json'), true);
  await requireTestMirror(ctx, { criterion: '1. packages/plain/src/io/a.js is proved by packages/plain/tests/io/a.test.js [test]' }, true);
});

test('cli.io-commands-add.accepts-a-registry-cell-test-with-the-setting-off: clause 3: with the setting off, the same bar naming a strict-registry cell test without its record is accepted [C7,U148,#10677]', async () => {
  await requireTestMirror(mainWith(true), bar('packages/demo/tests/io/thing.test.js'), false);
});

test('cli.io-commands-add.json-carries-level: clause 1: add --json prints level equal to route, as join --json already does [C7,#11064]', async () => {
  const box = helpers.project();
  const added = await box.inProcess(box.repo, 'add', 'web', 'Page', '--specs', 'G1', '--json');
  assert.equal(added.code, 0, added.err + added.out);
  const result = JSON.parse(added.out);
  assert.ok(result.route, 'route is kept');
  assert.equal(result.level, result.route);
  assert.equal(result.route, result.item.item_route);
});

test('cli.io-commands-add.edit-and-worktree-json-carry-level: clause 2: edit --json and worktree --json print level equal to route [C7,#11064]', async () => {
  const box = helpers.project();
  const added = await box.inProcess(box.repo, 'add', 'web', 'Page', '--specs', 'G1', '--json');
  assert.equal(added.code, 0, added.err + added.out);
  const id = String(JSON.parse(added.out).item.item_id);
  const edited = await box.inProcess(box.repo, 'edit', id, '--criterion', 'The page renders [test]', '--reason', 'The first criterion was too vague', '--json');
  assert.equal(edited.code, 0, edited.err + edited.out);
  const edit = JSON.parse(edited.out);
  assert.ok(edit.route, 'route is kept');
  assert.equal(edit.level, edit.route);
  const made = await box.inProcess(box.repo, 'worktree', 'web', '--json');
  assert.equal(made.code, 0, made.err + made.out);
  const tree = JSON.parse(made.out);
  assert.ok(tree.route, 'route is kept');
  assert.equal(tree.level, tree.route);
});
