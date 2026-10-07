/**
 * The spec (S1–S5): parsing SPEC.md rows, the lint, the frozen criterion and sign-offs.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  citedIds,
  deletedIds,
  frozenCriterion,
  idProblems,
  lintSpec,
  parseSpec,
  permanenceProblems,
  readSignoffs,
  signOff,
  standings,
  unmetRows,
} from '../src/spec.js';

const SPEC = `# Demo

Intro line.

## G · Goals
- G1 [approved, must] Same file twice is a no-op. | gate: idempotency test
- G1.2 [draft, aim] Shows a diff. | serves: G1
- G2 [retired] Old idea.

## K · Constraints
- K1 [approved, must] Runs offline. | gate: e2e test | serves: G1, G1.2
`;

test('rows parse with id, status, tier, text, gate, serves, section and line [S1]', () => {
  const spec = parseSpec(SPEC);
  assert.equal(spec.title, 'Demo');
  assert.deepEqual(spec.intro, ['Intro line.']);
  assert.equal(spec.sections.length, 2);
  assert.equal(spec.rows.length, 4);
  const row = spec.rows.find((entry) => entry.id === 'K1');
  assert.deepEqual(
    { status: row.status, tier: row.tier, text: row.text, gate: row.gate, serves: row.serves },
    { status: 'approved', tier: 'must', text: 'Runs offline.', gate: 'e2e test', serves: ['G1', 'G1.2'] },
  );
  assert.equal(row.section, 'K · Constraints');
  assert.equal(row.line, 11);
  assert.deepEqual(lintSpec(spec), []);
});

test('a row-like line that does not parse is an error, never dropped [S1]', () => {
  const spec = parseSpec('## G\n- G1 [approved, must]\n- just a bullet note\n');
  const findings = lintSpec(spec);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /does not parse/);
  assert.equal(findings[0].line, 2);
});

test('rows inside code fences are examples, not rows', () => {
  const spec = parseSpec('## G\n```\n- G1 [approved, must] Example. | gate: x\n```\n');
  assert.equal(spec.rows.length, 0);
});

test('ids are unique, retired ones included [S2]', () => {
  const findings = lintSpec(parseSpec('## G\n- G1 [retired] Old.\n- G1 [draft] New.\n'));
  assert.match(findings[0].message, /duplicate id; first on line 2/);
});

test('serves links must name real ids and never cycle [S3]', () => {
  const unknown = lintSpec(parseSpec('## G\n- G1 [draft] One. | serves: G9\n'));
  assert.match(unknown[0].message, /serves G9, which is not in the spec/);
  const cycle = lintSpec(parseSpec('## G\n- G1 [draft] One. | serves: G2\n- G2 [draft] Two. | serves: G1\n'));
  assert.ok(cycle.some((finding) => /cycle: G1 -> G2 -> G1/.test(finding.message)));
});

test('approved must-rows name their gate [S4]', () => {
  const findings = lintSpec(parseSpec('## G\n- G1 [approved, must] No gate here.\n'));
  assert.match(findings[0].message, /names its gate/);
  assert.deepEqual(lintSpec(parseSpec('## G\n- G1 [approved, aim] Aims need none.\n')), []);
});

test('bad status, bad tier and unknown fields are errors; long rows warn', () => {
  const findings = lintSpec(
    parseSpec(`## G\n- G1 [maybe, should] Text. | owner: me\n- G2 [draft] ${'word '.repeat(25)}\n`),
  );
  const messages = findings.map((finding) => `${finding.level}: ${finding.message}`);
  assert.ok(messages.some((message) => message.startsWith('error: status "maybe"')));
  assert.ok(messages.some((message) => message.startsWith('error: tier "should"')));
  assert.ok(messages.some((message) => message.startsWith('error: unknown field "owner: me"')));
  assert.ok(messages.some((message) => message.startsWith('warning: 25 words')));
});

test('cited ids must exist and must not be retired', () => {
  const spec = { ...parseSpec(SPEC), name: 'SPEC.md' };
  assert.deepEqual(idProblems(spec, ['G1', 'K1']), []);
  assert.deepEqual(idProblems(spec, ['G9', 'G2']), ['G9 is not in SPEC.md', 'G2 is retired']);
});

test('the frozen criterion covers title, criterion and cited row text [V2]', () => {
  const item = { item_title: 'Load twice', item_criterion: 'second load adds nothing', item_spec_ids: 'G1' };
  const first = frozenCriterion(parseSpec(SPEC), item);
  assert.equal(first.digest.length, 64);
  assert.equal(frozenCriterion(parseSpec(SPEC), item).digest, first.digest);
  const reworded = SPEC.replace('Same file twice is a no-op.', 'Same file twice changes nothing.');
  assert.notEqual(frozenCriterion(parseSpec(reworded), item).digest, first.digest);
  assert.notEqual(frozenCriterion(parseSpec(SPEC), { ...item, item_criterion: 'other' }).digest, first.digest);
  assert.notEqual(frozenCriterion(parseSpec(SPEC), { ...item, item_title: 'Load once' }).digest, first.digest, 'the title is frozen too');
  assert.throws(() => frozenCriterion(parseSpec(SPEC), { ...item, item_spec_ids: 'G9' }), /UNKNOWN_SPEC/);
});

test('a sign-off holds the text it approved; changing the row makes it stale [S5]', () => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-signoff-'));
  try {
    const spec = parseSpec(SPEC);
    assert.equal(signOff(root, spec, { ids: ['G1', 'K1'], by: 'CO', on: '2026-10-04' }), 2);
    assert.throws(() => signOff(root, spec, { ids: ['G1.2'], by: 'CO', on: '2026-10-04' }), /only approved rows/);
    assert.throws(() => signOff(root, spec, { ids: ['G1'], by: 'claude bot', on: '2026-10-04' }), /BAD_SIGNER/);
    const signoffs = readSignoffs(root);
    assert.equal(signoffs.length, 2);
    assert.deepEqual(unmetRows(spec.rows, signoffs), []);
    const changed = parseSpec(SPEC.replace('Runs offline.', 'Runs offline, always.'));
    assert.deepEqual(unmetRows(changed.rows, signoffs).map((row) => row.id), ['K1']);
    assert.equal(standings(changed.rows, signoffs).get('K1').stale.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('commit headers cite ids in a trailing bracket [C2]', () => {
  assert.deepEqual(citedIds('feat(web): add the page [G1, K1.2]'), ['G1', 'K1.2']);
  assert.deepEqual(citedIds('feat(web): add the page'), []);
  assert.deepEqual(citedIds('fix: handle [x] in the middle of text'), []);
});

test('a row marked wont stays with its id, drops out of the counts, and cannot be cited [S9]', () => {
  const spec = { ...parseSpec(`# Demo\n\n## G · Goals\n- G1 [approved, must] Kept. | gate: test\n- G2 [wont, must] Cut by the client on 6 Oct.\n`), name: 'SPEC.md' };
  assert.deepEqual(lintSpec(spec), []);
  assert.deepEqual(unmetRows(spec.rows, []).map((row) => row.id), ['G1']);
  assert.deepEqual(idProblems(spec, ['G2']), ["G2 is marked won't build; the person reopens it first"]);
  const item = { item_title: 'Build it', item_criterion: '', item_spec_ids: 'G2' };
  assert.throws(() => frozenCriterion(spec, item), /UNKNOWN_SPEC.*won't build.*withdraws the item/);
});

test('an id once committed or cited never leaves the spec [S8]', () => {
  const before = '# Demo\n\n## G · Goals\n- G1 [approved, must] One. | gate: t\n- G2 [draft, must] Two.\n```\n- G9 [draft] An example in a fence.\n```\n';
  assert.deepEqual(deletedIds(before, '# Demo\n\n## G · Goals\n- G1 [approved, must] One. | gate: t\n'), ['G2']);
  assert.deepEqual(deletedIds(before, before.replace('[draft, must] Two.', '[wont, must] Two.')), []);
  const spec = parseSpec('# Demo\n\n## G · Goals\n- G1 [approved, must] One. | gate: t\n');
  const problems = permanenceProblems(spec, {
    committed: new Map([['G1', 'a'.repeat(40)], ['G2', 'b'.repeat(40)]]),
    cited: new Map([['G1', 'commit 1234567'], ['G2', 'item #3'], ['X4', 'commit 89abcde']]),
  });
  assert.deepEqual(problems, [
    { id: 'G2', message: 'was committed in bbbbbbbbbbbb and is gone; ids are permanent: restore the row and mark it wont or retired' },
    { id: 'X4', message: 'commit 89abcde cites it, but it was never committed to the spec; add it as a retired row saying what it meant' },
  ]);
});

test('the check command is part of the frozen bar; items without one keep their old digest [B14]', () => {
  const item = { item_title: 'Load twice', item_criterion: 'second load adds nothing', item_spec_ids: 'G1' };
  const before = frozenCriterion(parseSpec(SPEC), item).digest;
  assert.equal(frozenCriterion(parseSpec(SPEC), { ...item, item_check: '' }).digest, before);
  assert.notEqual(frozenCriterion(parseSpec(SPEC), { ...item, item_check: 'npm test' }).digest, before);
});

