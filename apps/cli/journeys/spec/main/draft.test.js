/**
 * The spec (S1–S5): parsing SPEC.md rows, the lint, the frozen criterion and sign-offs.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { standardDoctrine } from '../../../../../packages/doctrine/index.js';
import { parseSpec } from '../../../../../packages/spec/index.js';
import { SPEC } from '../../../tests/fixtures/spec/box.js';
import { specBox } from '../../../tests/fixtures/spec/box.js';

test('spec draft files a row in the named section [S1,C7]', (t) => {
  const specSource = `# Demo

## K · Constraints
- K1 [draft, must] Works locally. | gate: review

## G · Goals
- G1 [draft, must] The first goal. | gate: review
- G2 [retired] An old goal.

## Q · Questions
- Q4 [pending, aim] A question. | gate: review
`;
  const box = specBox(t, { specSource });
  const rows = () => parseSpec(readFileSync(join(box.root, box.specName), 'utf8')).rows;
  const constraint = box.run('draft', 'Uses the local disk', '--section', 'K');
  assert.equal(constraint.status, 0, constraint.stderr);
  assert.equal(constraint.stdout.trim().split('\n')[0], 'K2');
  assert.equal(rows().find(row => row.id === 'K2').section, 'K · Constraints');

  const goal = box.run('draft', 'A new goal');
  assert.equal(goal.status, 0, goal.stderr);
  assert.equal(goal.stdout.trim().split('\n')[0], 'G3', 'G stays the default even when another section comes first');
  assert.equal(rows().find(row => row.id === 'G3').section, 'G · Goals');

  const question = box.run('draft', 'Another question', '--section', 'Q', '--aim', '--gate', 'question test', '--json');
  assert.equal(question.status, 0, question.stderr);
  const result = JSON.parse(question.stdout);
  assert.equal(result.id, 'Q5');
  assert.equal(result.row.section, 'Q · Questions');
  assert.equal(result.row.tier, 'aim');
  assert.equal(result.row.gate, 'question test');
  assert.equal(rows().find(row => row.id === 'Q5').section, 'Q · Questions');

  const before = readFileSync(join(box.root, box.specName), 'utf8');
  const unknown = box.run('draft', 'Must not be written', '--section', 'Z');
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /SPEC_SECTION.*Z.*K.*G.*Q/u);
  assert.equal(readFileSync(join(box.root, box.specName), 'utf8'), before);
  const misplaced = box.run('check', '--section', 'K');
  assert.equal(misplaced.status, 1);
  assert.match(misplaced.stderr, /FLAG_NOT_ALLOWED.*section/u);
});

test('spec draft with an inline gate names the flag to use [S1,P4]', (t) => {
  const box = specBox(t, { freshInit: true });
  const result = box.run('draft', 'A requirement | gate: node --test test/example.test.js');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /INLINE_GATE/u);
  assert.match(result.stderr, /pullboard spec draft "<text>" --gate "<check>"/u);
  assert.equal(readFileSync(join(box.root, box.specName), 'utf8').includes('A requirement'), false);
});

/** Exercise fresh-init examples, cross-file ID reservation, and fail-closed malformed rows. */
test('spec draft never reuses an existing id [S1,C7]', (t) => {
  const fresh = specBox(t, { freshInit: true });
  const freshSpec = join(fresh.root, fresh.specName);
  assert.equal(parseSpec(readFileSync(freshSpec, 'utf8')).rows.length, 0, 'the fenced examples are not real rows');
  const first = fresh.run('draft', 'The first real requirement');
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout.trim().split('\n')[0], 'G1', 'the first real requirement receives the first available id');
  assert.deepEqual(parseSpec(readFileSync(freshSpec, 'utf8')).rows.map(({ id, status }) => [id, status]), [['G1', 'draft']]);

  const doctrine = '# Doctrine\n\n## G · Goals\n- G3 [draft] A repo doctrine id occupies this number.\n';
  const crossFile = specBox(t, { practiceName: 'DOCTRINE.md', practice: doctrine });
  const next = crossFile.run('draft', 'The next requirement');
  assert.equal(next.status, 0, next.stderr);
  assert.equal(next.stdout.trim().split('\n')[0], 'G4', 'the allocator reserves ids present in DOCTRINE.md as well as SPEC.md');
  const specRows = parseSpec(readFileSync(join(crossFile.root, crossFile.specName), 'utf8')).rows;
  const doctrineRows = parseSpec(readFileSync(join(crossFile.root, crossFile.practiceName), 'utf8')).rows;
  assert.ok(specRows.some((row) => row.id === 'G4'));
  assert.ok(doctrineRows.some((row) => row.id === 'G3'));

  for (const source of ['spec', 'doctrine']) {
    const malformed = specBox(t, {
      ...(source === 'doctrine' ? { practiceName: 'DOCTRINE.md', practice: '# Doctrine\n\n## G · Goals\n- G3 [draft, must\n' } : {}),
      ...(source === 'spec' ? { specSource: SPEC + '\n- G3 [draft, must\n' } : {}),
    });
    const target = join(malformed.root, source === 'spec' ? malformed.specName : malformed.practiceName);
    const before = readFileSync(target);
    const refused = malformed.run('draft', 'Cannot choose safely');
    assert.notEqual(refused.status, 0, `${source} with an unparsed row-like entry refuses a draft`);
    assert.match(refused.stderr, /SPEC_INVALID.*unparsed row/u);
    assert.deepEqual(readFileSync(target), before, 'refusal leaves the source bytes unchanged');
  }
});

test('a drafted row reads as draft [S1,C7]', (t) => {
  const specSource = SPEC.replace(
    '- G2 [retired] Old idea.',
    '- G2 [retired] Old idea.\n- G3 [pending, must] Still a question. | gate: review',
  );
  const box = specBox(t, { specSource });

  const drafted = box.run('draft', 'A proposed requirement');
  assert.equal(drafted.status, 0, drafted.stderr);
  assert.equal(drafted.stdout.trim().split('\n')[0], 'G4');

  const rows = () => parseSpec(readFileSync(join(box.root, box.specName), 'utf8')).rows;
  assert.deepEqual(rows().filter((row) => ['G3', 'G4'].includes(row.id)).map(({ id, status }) => [id, status]), [
    ['G3', 'pending'],
    ['G4', 'draft'],
  ], 'the existing question stays pending and the newly drafted row is distinct');
  const approved = box.run('approve', 'G3', 'G4');
  assert.equal(approved.status, 0, approved.stderr);
  const applied = box.run('apply');
  assert.equal(applied.status, 0, applied.stderr);
  assert.deepEqual(rows().filter((row) => ['G3', 'G4'].includes(row.id)).map(({ id, status }) => [id, status]), [
    ['G3', 'approved'],
    ['G4', 'approved'],
  ], 'both an existing pending question and a newly drafted row remain approvable');
});

test('spec --json emits one versioned document with every field, including empty fields [S13]', (t) => {
  const box = specBox(t);
  const shown = box.run('--json');
  assert.equal(shown.status, 0, shown.stderr);
  const data = JSON.parse(shown.stdout);
  const inherited = data.rows.filter(row => row.origin === 'standard');
  assert.equal(data.rows.length, 4 + standardDoctrine().rows.length);
  assert.deepEqual(inherited.map(row => row.id), standardDoctrine().rows.map(row => row.id));
  assert.ok(inherited.every(row => row.file === 'standard doctrine 1' && row.version === 1 && row.reason === ''));
  assert.deepEqual({ version: data.version, rows: data.rows.filter(row => row.file === 'SPEC.md') }, {
    version: 1,
    rows: [
      { id: 'G1', status: 'approved', tier: 'must', text: 'Same file twice is a no-op.', gate: 'idempotency test', serves: [], signers: [], section: 'G · Goals', line: 6, file: 'SPEC.md' },
      { id: 'G1.2', status: 'draft', tier: 'aim', text: 'Shows a diff.', gate: '', serves: ['G1'], signers: [], section: 'G · Goals', line: 7, file: 'SPEC.md' },
      { id: 'G2', status: 'retired', tier: '', text: 'Old idea.', gate: '', serves: [], signers: [], section: 'G · Goals', line: 8, file: 'SPEC.md' },
      { id: 'K1', status: 'approved', tier: 'must', text: 'Runs offline.', gate: 'e2e test', serves: ['G1', 'G1.2'], signers: [], section: 'K · Constraints', line: 11, file: 'SPEC.md' },
    ],
  });
});

test('spec --json combines both configured files and keeps every row status [S13]', (t) => {
  const practice = '# Practice\n\n## P · Practice\n- P1 [fact] A fact.\n- P2 [pending, must] A question.\n- P3 [wont] An old plan.\n';
  const box = specBox(t, { specName: 'requirements.md', practiceName: 'ways.md', practice });
  const shown = box.run('--json');
  assert.equal(shown.status, 0, shown.stderr);
  const data = JSON.parse(shown.stdout);
  assert.equal(data.version, 1);
  assert.equal(data.rows.length, 7 + standardDoctrine().rows.length);
  assert.equal(data.rows.filter(row => row.origin === 'standard').length, standardDoctrine().rows.length);
  assert.ok(data.rows.slice(0, 4).every((row) => row.file === 'requirements.md'));
  assert.deepEqual(data.rows.filter(row => row.file === 'ways.md'), [
    { id: 'P1', status: 'fact', tier: '', text: 'A fact.', gate: '', serves: [], signers: [], section: 'P · Practice', line: 4, file: 'ways.md', origin: 'repo', version: null, reason: '' },
    { id: 'P2', status: 'pending', tier: 'must', text: 'A question.', gate: '', serves: [], signers: [], section: 'P · Practice', line: 5, file: 'ways.md', origin: 'repo', version: null, reason: '' },
    { id: 'P3', status: 'wont', tier: '', text: 'An old plan.', gate: '', serves: [], signers: [], section: 'P · Practice', line: 6, file: 'ways.md', origin: 'repo', version: null, reason: 'An old plan.' },
  ]);
});

test('spec --json refuses errors in either file with versioned spec-check diagnostics [S13, S4, A1]', (t) => {
  const box = specBox(t, { practice: '# Practice\n\n## P\n- P1 [approved, must] No gate.\n' });
  writeFileSync(join(box.root, box.specName), `${SPEC}\n- K2 [maybe, must] Bad status. | serves: K9\n`);
  const check = box.run('check');
  const shown = box.run('--json');
  assert.equal(check.status, 1);
  assert.equal(shown.status, 1);
  const document = JSON.parse(shown.stdout);
  assert.equal(document.version, 1);
  assert.equal(document.error.message, check.stdout.trim());
  assert.equal(typeof document.error.next, 'string');
  assert.equal(shown.stderr, check.stderr);
  assert.match(document.error.message, /status "maybe"/);
  assert.match(document.error.message, /serves K9/);
  assert.match(document.error.message, /PRACTICE.md:4 P1 error:.*names its gate/);
  assert.equal(document.error.code, 'COMMAND_FAILED');
});

test('spec --json also refuses a committed row removed from practice [S13, S8]', (t) => {
  const box = specBox(t, { practice: '# Practice\n\n## P\n- P1 [fact] Kept forever.\n' });
  writeFileSync(join(box.root, box.practiceName), '# Practice\n\n## P\n');
  const check = box.run('check');
  const shown = box.run('--json');
  assert.equal(shown.status, 1);
  const document = JSON.parse(shown.stdout);
  assert.equal(document.version, 1);
  assert.equal(document.error.message, check.stdout.trim());
  assert.equal(typeof document.error.next, 'string');
  assert.match(shown.stdout, /PRACTICE.md: P1 error:.*ids are permanent/);
  assert.equal(document.error.code, 'COMMAND_FAILED');
});

test('warning-only specs keep spec-check success while JSON stays a single document [S13]', (t) => {
  const box = specBox(t);
  writeFileSync(join(box.root, box.specName), `${SPEC}\n- K2 [draft] ${'word '.repeat(25)}\n`);
  const check = box.run('check');
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /warning: 25 words/);
  const shown = box.run('--json');
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(JSON.parse(shown.stdout).rows.length, 5 + standardDoctrine().rows.length);
});
