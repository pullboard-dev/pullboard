/** Standard doctrine and repo overrides (D1–D4), using real private files. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { packText } from '../src/run.js';
import { doctrineText, loadDoctrine, standardDoctrine, STANDARD_VERSION } from '../src/doctrine.js';
import { lintSpec, parseSpec } from '../src/spec.js';

/** A private repo's configured practice file, automatically removed after its test. */
function practiceBox(t, text, name = 'PRACTICE.md') {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-doctrine-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  if (text !== undefined) writeFileSync(join(root, name), text);
  return { root, config: { practice: name } };
}

test('standard version1 ships exactly the twelve RFC rules and is inherited without a practice file [D1,D2]', (t) => {
  const standard = standardDoctrine();
  const rfc = parseSpec(readFileSync(new URL('../docs/rfcs/0001-standard-doctrine.md', import.meta.url), 'utf8'));
  /** Comparable rule fields; the packaged file legitimately has different source lines. */
  const fields = ({ id, status, tier, text, gate, serves }) => ({ id, status, tier, text, gate, serves });
  assert.deepEqual(standard.rows.map(fields), rfc.rows.filter((row) => /^PB\d/.test(row.id)).map(fields));
  assert.equal(standard.rows.length, 12);
  assert.equal(STANDARD_VERSION, 1);
  assert.match(readFileSync(new URL('../src/standard-doctrine.md', import.meta.url), 'utf8'), /\nVersion: 1\n/);
  const box = practiceBox(t);
  const merged = loadDoctrine(box.root, box.config);
  assert.equal(merged.repoExists, false);
  assert.deepEqual(merged.rows, standard.rows);
  assert.deepEqual(lintSpec(merged), []);
  assert.ok(merged.rows.every((row) => row.origin === 'standard 1' && row.version === 1));
});

test('repo rules override and decline inherited rows with a reason, keeping source labels and legacy text [D2,D3,D4]', (t) => {
  const text = '# Local rules\n\n## Team\n- PB2 [approved, must] Deletion needs two approvals. | gate: review\n- PB8 [wont] No persistent data is stored.\n- R1 [fact] An existing local rule.\n';
  const box = practiceBox(t, text, 'ways.md');
  const merged = loadDoctrine(box.root, box.config);
  assert.deepEqual(lintSpec(merged), []);
  assert.equal(merged.rows.length, 13);
  const own = merged.rows.filter((row) => row.origin === 'repo');
  assert.deepEqual(own.map((row) => row.id), ['PB2', 'PB8', 'R1']);
  assert.ok(own.every((row) => row.file === 'ways.md' && row.version === null));
  assert.ok(merged.rows.every(row => 'origin' in row && 'version' in row && 'reason' in row));
  assert.equal(merged.rows.filter((row) => row.id === 'PB2').length, 1);
  assert.equal(own[0].text, 'Deletion needs two approvals.');
  assert.equal(own[1].reason, 'No persistent data is stored.');
  assert.equal(readFileSync(join(box.root, 'ways.md'), 'utf8'), text);
  assert.match(doctrineText(merged), /PB1 \(standard 1\)/);
  assert.match(doctrineText(merged), /PB8 \(repo\).*No persistent data/);
});

test('a missing or blank decline reason fails lint, and duplicate repo overrides are not silently discarded [D3]', (t) => {
  const box = practiceBox(t);
  for (const trailing of ['   ', '    | gate: review']) {
    writeFileSync(join(box.root, 'PRACTICE.md'), '# Rules\n\n## Local\n- PB2 [wont]' + trailing + '\n');
    const findings = lintSpec(loadDoctrine(box.root, box.config));
    assert.ok(findings.some((finding) => finding.level === 'error' && finding.id === 'PB2' && /reason/.test(finding.message)));
  }
  writeFileSync(join(box.root, 'PRACTICE.md'), '# Rules\n\n## Local\n- PB2 [fact] First.\n- PB2 [fact] Second.\n');
  assert.ok(lintSpec(loadDoctrine(box.root, box.config)).some((finding) => /duplicate id/.test(finding.message)));
});


test('cold-start run pack uses configured legacy practice and labels each source [D2,D3,D4]', (t) => {
  const text = '# Legacy rules\n\n## Local\n- PB2 [fact] Delete only after review.\n- PB8 [wont] This fixture stores no secrets.\n- R1 [fact] The legacy rule stays.\n';
  const box = practiceBox(t, text, 'ways.md');
  writeFileSync(join(box.root, 'pullboard.json'), JSON.stringify({ gate: 'true', spec: 'SPEC.md', practice: 'ways.md', lanes: { core: { owns: ['src/'] } } }));
  const pack = packText(box.root, { item_id: 1, item_title: 'Fixture', item_criterion: 'A local proof.', item_lane: 'core', item_brief: '', item_check: 'true' }, { attempt: 1, attempts: 1, digest: '', earlier: [] });
  assert.match(pack, /PB1 \(standard 1\)/);
  assert.match(pack, /PB2 \(repo\) \[fact\] Delete only after review/);
  assert.match(pack, /PB8 \(repo\) \[wont\] This fixture stores no secrets/);
  assert.match(pack, /R1 \(repo\).*The legacy rule stays/);
  assert.doesNotMatch(pack, /PB2 \(standard 1\)/);
  assert.equal(readFileSync(join(box.root, 'ways.md'), 'utf8'), text);
});
