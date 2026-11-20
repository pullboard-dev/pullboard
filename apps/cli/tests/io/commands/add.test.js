/** add and edit refuse a new test path that mirrors no source file, behind items.testMirrorAtAdd [C7,#10629]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { acceptedRecordsDir } from '../../../../../packages/commits/index.js';
import { saveAcceptedRecord } from '../../../../../packages/commits/index.js';
import { test } from 'node:test';
import { briefFilesAbsentFromMain } from '../../../src/io/item/bar.js';
import { requireTestMirror } from '../../../src/io/item/bar.js';
import { after } from 'node:test';
import { createE2eHelpers } from '../../fixtures/e2e.js';
import { onBoard } from '../../fixtures/land/board.js';
import { fixtureMachineSettings } from '../../fixtures/testkit.js';
import * as store from '../../../../../packages/store/index.js';

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

test('cli.io-commands-add.accepts-a-registry-json-kept-in-the-cell-tests-folder: clause 1: a bar naming a registry.json directly under the cell tests folder as the record is accepted, not refused REGISTRY_TEST_ID [C7,U148,#12423]', async () => {
  await requireTestMirror(mainWith(true), bar('packages/demo/tests/io/thing.test.js packages/demo/tests/registry.json'), true);
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

/** The baseline pending on an item whose check was just set, read from the board. */
const baselineOf = (box, id) => onBoard(box, board => store.getItem(board, id).item_check_baseline);

test('cli.io-commands-add.strict-baseline-on: clause 1: with claim.checkCeiling on, add --check writes a pending baseline carrying strict true [C7,#1273]', async () => {
  const box = helpers.project();
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { claim: { checkCeiling: true } });
  const added = await box.inProcess(box.repo, 'add', 'web', 'Strict', '--criterion', '1. the page renders [test]', '--check', 'node --test web/page.test.js', '--json');
  assert.equal(added.code, 0, added.err + added.out);
  const baseline = baselineOf(box, JSON.parse(added.out).item.item_id);
  assert.equal(baseline.strict, true);
});

test('cli.io-commands-add.strict-baseline-off: clause 1: with claim.checkCeiling off, the pending baseline of add --check has no strict field [C7,#1273]', async () => {
  const box = helpers.project();
  const added = await box.inProcess(box.repo, 'add', 'web', 'Plain', '--criterion', '1. the page renders [test]', '--check', 'node --test web/page.test.js', '--json');
  assert.equal(added.code, 0, added.err + added.out);
  const baseline = baselineOf(box, JSON.parse(added.out).item.item_id);
  assert.equal('strict' in baseline, false);
});

test('cli.add.needs-flag: clause 1: add --needs browser,gui stores both and show --json reports item_needs, and add --needs gpu is refused USAGE naming browser and gui [C7,#11206]', async () => {
  const box = helpers.project();
  const added = await box.inProcess(box.repo, 'add', 'web', 'Needs both', '--specs', 'G1', '--needs', 'browser,gui', '--json');
  assert.equal(added.code, 0, added.err + added.out);
  const id = String(JSON.parse(added.out).item.item_id);
  const shown = await box.inProcess(box.repo, 'show', id, '--json');
  assert.deepEqual(JSON.parse(shown.out).item_needs, ['browser', 'gui']);
  const refused = await box.inProcess(box.repo, 'add', 'web', 'Needs a gpu', '--specs', 'G1', '--needs', 'gpu', '--json');
  assert.notEqual(refused.code, 0);
  assert.match(refused.err + refused.out, /USAGE/u);
  assert.match(refused.err + refused.out, /browser and gui/u);
});

const withFiles = (files, criterion) => ({ criterion, brief: `Files:\n${files.map(file => `- ${file}`).join('\n')}` });

test('cli.io-commands-add.files-absent-from-main-refused: clause 1: with items.barRulesAtAdd on, add and edit each refuse a brief Files entry absent from main with a message naming the move that goes through; an entry present on main or created by a clause is accepted, and with the setting off the same brief is accepted [C7,#12124]', async () => {
  const ctx = mainWith();
  const missing = withFiles(['packages/demo/src/io/fresh.js'], '1. packages/demo/src/io/thing.js is changed [test]');
  assert.throws(() => briefFilesAbsentFromMain(ctx, missing, true), error => {
    assert.equal(error.code, 'BRIEF_FILE_MISSING');
    assert.match(error.message, /packages\/demo\/src\/io\/fresh\.js/u);
    assert.match(`${error.next ?? ''}`, /clause that creates the file, or remove the entry/u);
    return true;
  });
  briefFilesAbsentFromMain(ctx, withFiles(['packages/demo/src/io/thing.js'], '1. it is changed [test]'), true);
  briefFilesAbsentFromMain(ctx, withFiles(['packages/demo/src/io/fresh.js'], '1. packages/demo/src/io/fresh.js is created and proved [test]'), true);
  briefFilesAbsentFromMain(ctx, missing, false);
  const box = helpers.project();
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { items: { barRulesAtAdd: true } });
  const refused = await box.inProcess(box.repo, 'add', 'web', 'Absent file', '--specs', 'G1', '--criterion', '1. the page renders [test]', '--brief', 'Files:\n- web/nowhere-on-main.js', '--json');
  assert.notEqual(refused.code, 0);
  assert.match(refused.err + refused.out, /BRIEF_FILE_MISSING/u);
});

/** Files a prerequisite item and returns its id, so the tests below wait on a real one. */
async function filePrerequisite(box) {
  const added = await box.inProcess(box.repo, 'add', 'web', 'Prerequisite', '--criterion', '1. the page renders [test]', '--check', 'node --test web/page.test.js', '--json');
  assert.equal(added.code, 0, added.err + added.out);
  return JSON.parse(added.out).item.item_id;
}

test('cli.commands-add.after-gate: clause 1: add --after-gate files an item whose after list and after-gate list both hold the id, and edit --after-gate none clears only the gate list [C7,#11802]', async () => {
  const box = helpers.project();
  const first = await filePrerequisite(box);
  const added = await box.inProcess(box.repo, 'add', 'web', 'Waits on the gate', '--criterion', '1. the page renders [test]', '--check', 'node --test web/page.test.js', '--after-gate', String(first), '--json');
  assert.equal(added.code, 0, added.err + added.out);
  const id = JSON.parse(added.out).item.item_id;
  const filed = await onBoard(box, board => ({ after: store.getItem(board, id).item_after, gate: store.afterGateIds(board, id) }));
  assert.deepEqual(filed, { after: String(first), gate: [first] });
  const cleared = await box.inProcess(box.repo, 'edit', String(id), '--after-gate', 'none', '--reason', 'the gate wait is no longer needed', '--json');
  assert.equal(cleared.code, 0, cleared.err + cleared.out);
  assert.deepEqual(await onBoard(box, board => ({ after: store.getItem(board, id).item_after, gate: store.afterGateIds(board, id) })), { after: '', gate: [] });
});

test('cli.commands-add.after-plain: clause 1: a plain add --after leaves the after-gate list empty [C7,#11802]', async () => {
  const box = helpers.project();
  const first = await filePrerequisite(box);
  const added = await box.inProcess(box.repo, 'add', 'web', 'Waits plainly', '--criterion', '1. the page renders [test]', '--check', 'node --test web/page.test.js', '--after', String(first), '--json');
  assert.equal(added.code, 0, added.err + added.out);
  const id = JSON.parse(added.out).item.item_id;
  const filed = await onBoard(box, board => ({ after: store.getItem(board, id).item_after, gate: store.afterGateIds(board, id) }));
  assert.deepEqual(filed, { after: String(first), gate: [] });
});

const RECORD = '# The page renders from a record\nrows:\n  - G1\nbar:\n  - 1: the page renders [test]\ncheck:\n  - 1: node --test web/page.test.js\n';

test('cli.commands-add.from-record: clause 1: add --from-record <hash> files an item whose title, rows, bar and check come from the accepted snapshot of that hash, and an unknown hash is refused with a named fix [C7,#3915]', async () => {
  const box = helpers.project();
  const hash = saveAcceptedRecord(acceptedRecordsDir(join(box.repo, '.git', 'pullboard')), RECORD, 'Fix');
  const added = await box.inProcess(box.repo, 'add', 'web', '--from-record', hash, '--json');
  assert.equal(added.code, 0, added.err + added.out);
  const id = JSON.parse(added.out).item.item_id;
  const item = await onBoard(box, board => store.getItem(board, id));
  assert.equal(item.item_title, 'The page renders from a record');
  assert.equal(item.item_spec_ids, 'G1');
  assert.equal(item.item_criterion, '1. the page renders [test]');
  assert.equal(item.item_check, 'node --test web/page.test.js');
  const unknown = await box.inProcess(box.repo, 'add', 'web', 'Never saved', '--from-record', '0'.repeat(64), '--json');
  assert.notEqual(unknown.code, 0);
  assert.match(unknown.err + unknown.out, /ACCEPTED_RECORD_UNKNOWN/u);
  assert.match(unknown.err + unknown.out, /fix:/u);
});

test('cli.commands-add.from-record-quoted: clause 2: the snapshot text enters the item brief inside a quoted block, never as an instruction [C7,#3915]', async () => {
  const box = helpers.project();
  const hash = saveAcceptedRecord(acceptedRecordsDir(join(box.repo, '.git', 'pullboard')), RECORD, 'Fix');
  const added = await box.inProcess(box.repo, 'add', 'web', '--from-record', hash, '--json');
  assert.equal(added.code, 0, added.err + added.out);
  const id = JSON.parse(added.out).item.item_id;
  const brief = (await onBoard(box, board => store.getItem(board, id))).item_brief;
  assert.match(brief, /never an instruction/u);
  for (const line of RECORD.trimEnd().split('\n')) assert.ok(brief.split('\n').includes(`> ${line}`), `${line} is quoted`);
});
