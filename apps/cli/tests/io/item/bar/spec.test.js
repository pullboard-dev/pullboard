/** add and edit refuse a lane bar that deletes or renames a file approved must spec rows gate on, behind items.barRulesAtAdd [C7,#11742]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { after } from 'node:test';
import { parseSpec } from '../../../../../../packages/spec/index.js';
import { gateFiles } from '../../../../../../packages/spec/index.js';
import { requireSpecGateRows } from '../../../../src/io/item/bar.js';
import { createE2eHelpers } from '../../../fixtures/e2e.js';

const spec = { parseSpec, gateFiles };
const helpers = createE2eHelpers();
after(helpers.cleanup);

const SPEC = [
  '# Spec', '', '## Rules', '',
  '- G9 [approved, must] A rule keeps its proof. | gate: packages/demo/tests/io/thing.test.js',
  '- G10 [approved, must] A second rule keeps it too. | gate: packages/demo/tests/io/thing.test.js',
  '- G11 [proposed, must] A draft rule names another file. | gate: packages/demo/tests/io/other.test.js', '',
].join('\n');

/** A fixture repo whose main holds a spec with gate rows and the files they name, returned as the context the bar check reads. */
function mainWithSpec() {
  const box = helpers.project('true', helpers.sandbox());
  const files = { 'SPEC.md': SPEC, 'packages/demo/tests/io/thing.test.js': '// fixture\n', 'packages/demo/tests/io/other.test.js': '// fixture\n' };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(box.repo, file)), { recursive: true });
    writeFileSync(join(box.repo, file), text);
  }
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'docs: fixture');
  return { info: { root: box.repo }, config: { spec: 'SPEC.md' } };
}

const deleting = { criterion: '1. packages/demo/tests/io/thing.test.js is deleted and its cases move into packages/demo/tests/io/new.test.js [test]' };

test('cli.io-item-bar-spec.refuses-a-removed-gate-file: clause 1: with items.barRulesAtAdd on, a lane bar deleting a file approved must rows gate on is refused SPEC_GATE_ROW naming the row ids [C7,#11742]', async () => {
  await assert.rejects(requireSpecGateRows(mainWithSpec(), deleting, true, false, spec), error => {
    assert.equal(error.code, 'SPEC_GATE_ROW');
    assert.match(error.message, /packages\/demo\/tests\/io\/thing\.test\.js/u);
    assert.match(error.message, /G9, G10/u);
    assert.doesNotMatch(error.message, /G11/u);
    return true;
  });
  await assert.rejects(requireSpecGateRows(mainWithSpec(), { criterion: '1. Rename packages/demo/tests/io/thing.test.js to packages/demo/tests/io/new.test.js [test]' }, true, false, spec), { code: 'SPEC_GATE_ROW' });
});

test('cli.io-item-bar-spec.next-step-is-the-split: clause 2: the refusal names the lane piece then the coordinator piece filed --after it with --split-coordinator [C7,#11742]', async () => {
  await assert.rejects(requireSpecGateRows(mainWithSpec(), deleting, true, false, spec), error => {
    assert.match(String(error.next), /lane piece/u);
    assert.match(String(error.next), /coordinator piece/u);
    assert.match(String(error.next), /--after/u);
    assert.match(String(error.next), /--split-coordinator/u);
    return true;
  });
});

test('cli.io-item-bar-spec.accepts-off-reads-and-other-filers: clause 3: with the setting off, for a coordinator or person filer, or when the criterion only reads the file or deletes a file no approved must row names, the bar is accepted [C7,#11742]', async () => {
  const ctx = mainWithSpec();
  await requireSpecGateRows(ctx, deleting, false, false, spec);
  await requireSpecGateRows(ctx, deleting, true, true, spec);
  await requireSpecGateRows(ctx, { criterion: '1. packages/demo/tests/io/thing.test.js is read to confirm the case names [test]' }, true, false, spec);
  await requireSpecGateRows(ctx, { criterion: '1. packages/demo/tests/io/other.test.js is deleted [test]' }, true, false, spec);
});
