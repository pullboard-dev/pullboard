/** spec draft writes the draft row it prints, and refuses without printing an id when it cannot [S1]. */
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../apps/cli/tests/fixtures/child.js';
import { draftRow } from '../../index.js';

const CONFIG = { spec: 'SPEC.md' };
/** The doctrine door's shape with no doctrine rows, so the draft sees only SPEC.md. */
const loadDoctrine = () => ({ name: 'DOCTRINE.md', repo: { file: 'DOCTRINE.md', name: 'DOCTRINE.md', exists: false, rows: [], problems: [], sections: [] } });
const SPEC = '# Spec\n\n## G · Goals\n\n- G1 [approved, must] Existing row. | gate: a test\n';

/** A fixture repo root holding only a SPEC.md. */
function fixture() {
  const files = privateFixtureFiles('pullboard-spec-draft-');
  files.write('SPEC.md', SPEC);
  return files;
}

test('spec.draft.appends-row: spec draft appends a draft row with the printed id to the spec file [S1]', () => {
  const files = fixture();
  const { id, line } = draftRow(files.root, CONFIG, { target: 'spec', text: 'A new requirement.', gate: 'review' }, { loadDoctrine });
  assert.equal(id, 'G2');
  const written = readFileSync(join(files.root, 'SPEC.md'), 'utf8');
  assert.ok(written.includes(`${line}\n`) || written.endsWith(line), 'the spec file holds the printed row');
  assert.match(written, /- G2 \[draft, must\] A new requirement\. \| gate: review/u);
  assert.ok(written.includes('- G1 [approved, must] Existing row.'), 'the existing row is untouched');
});

test('spec.draft.refuses-unwritable: spec draft refuses with a next step and prints no id when the spec file cannot be written [S1]', (t) => {
  const files = fixture();
  const path = join(files.root, 'SPEC.md');
  chmodSync(path, 0o444);
  t.after(() => chmodSync(path, 0o644));
  let returned;
  assert.throws(() => { returned = draftRow(files.root, CONFIG, { target: 'spec', text: 'A new requirement.', gate: 'review' }, { loadDoctrine }); }, (error) => {
    assert.equal(error.code, 'SPEC_NOT_WRITABLE');
    assert.match(error.message, /SPEC\.md/u);
    assert.match(error.next ?? error.message, /writable/u);
    return true;
  });
  assert.equal(returned, undefined, 'no id is returned');
  assert.equal(readFileSync(path, 'utf8'), SPEC, 'the spec file is unchanged');
});
