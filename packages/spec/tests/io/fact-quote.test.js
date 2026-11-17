/** A source-backed fact records the quote it rests on next to its value, and reads it back [B2,#9550]. @pullboard-test-input source-cell packages/spec */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import {
  draftRow,
  parseSpec,
} from '../../index.js';

const CONFIG = { spec: 'SPEC.md' };
const loadDoctrine = () => ({ name: 'DOCTRINE.md', repo: { file: 'DOCTRINE.md', name: 'DOCTRINE.md', exists: false, rows: [], problems: [], sections: [] } });
const SPEC = '# Spec\n\n## G · Goals\n\n- G1 [approved, must] Existing row. | gate: a test\n';

/** A fixture repo root holding only a SPEC.md. */
function fixture() {
  const files = privateFixtureFiles('pullboard-spec-quote-');
  files.write('SPEC.md', SPEC);
  return files;
}

test('clause 1: a fact drafted with a source and a quote stores the quote beside the value and the reader returns it [B2]', () => {
  const files = fixture();
  const quote = 'The programme ran for 31 years: a cost: not a count.';
  const { id } = draftRow(files.root, CONFIG, { target: 'spec', text: 'It ran 31 years.', gate: 'review', source: 'Report p.4', quote }, { loadDoctrine });
  const written = readFileSync(join(files.root, 'SPEC.md'), 'utf8');
  assert.match(written, /\| source: Report p\.4 \| quote: The programme ran for 31 years/u);
  const row = parseSpec(written).rows.find((entry) => entry.id === id);
  assert.equal(row.quote, quote);
  assert.equal(row.source, 'Report p.4');
  assert.equal(row.text, 'It ran 31 years.');
  assert.deepEqual(row.unknown, []);
});

test('clause 1: a fact drafted without a quote stores none and old rows read unchanged [B2]', () => {
  const files = fixture();
  const { id } = draftRow(files.root, CONFIG, { target: 'spec', text: 'No quote here.', gate: 'review', source: 'Report p.4' }, { loadDoctrine });
  const written = readFileSync(join(files.root, 'SPEC.md'), 'utf8');
  assert.doesNotMatch(written, /quote:/u);
  const rows = parseSpec(written).rows;
  assert.equal(Object.hasOwn(rows.find((entry) => entry.id === id), 'quote'), false);
  assert.equal(Object.hasOwn(rows.find((entry) => entry.id === 'G1'), 'quote'), false);
});

test('clause 1: a quote that would break the row line is refused with a next step and nothing is written [B2]', () => {
  const files = fixture();
  assert.throws(() => draftRow(files.root, CONFIG, { target: 'spec', text: 'x', gate: 'review', source: 's', quote: 'two\nlines' }, { loadDoctrine }), (error) => error.code === 'SPEC_FIELD');
  assert.equal(readFileSync(join(files.root, 'SPEC.md'), 'utf8'), SPEC);
});
