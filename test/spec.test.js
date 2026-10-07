/**
 * The spec (S1–S5): parsing SPEC.md rows, the lint, the frozen criterion and sign-offs.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
  SIGNOFFS_FILE,
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
  const later = lintSpec(parseSpec('## G\n- G1 [draft] New.\n- G1 [retired] Old.\n'));
  assert.match(later[0].message, /duplicate id; first on line 2/, 'a retired row that repeats a live id is a duplicate too');
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

/**
 * A real repo and board with an isolated registry, so JSON exercises the command's lint and history
 * checks rather than just serializing the parser. Its files may use the configured names.
 */
function specBox(t, { specName = 'SPEC.md', practiceName = 'PRACTICE.md', practice } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-spec-json-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Agent', GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent', GIT_COMMITTER_EMAIL: 'agent@example.com',
    PULLBOARD_HOME: join(root, '.home'),
  };
  const git = (...args) => execFileSync('git', args, { cwd: root, env, stdio: 'pipe', encoding: 'utf8' });
  const command = (...args) => spawnSync(process.execPath, [resolve(import.meta.dirname, '../bin/pullboard.js'), ...args], { cwd: root, env, encoding: 'utf8' });
  const run = (...args) => command('spec', ...args);
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test Agent');
  git('config', 'user.email', 'agent@example.com');
  const init = spawnSync(process.execPath, [resolve(import.meta.dirname, '../bin/pullboard.js'), 'init'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const config = JSON.parse(readFileSync(join(root, 'pullboard.json'), 'utf8'));
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ ...config, spec: specName, practice: practiceName, gate: 'true', lanes: { review: { owns: [] } } }));
  rmSync(join(root, 'SPEC.md'), { force: true });
  rmSync(join(root, 'PRACTICE.md'), { force: true });
  writeFileSync(join(root, specName), SPEC);
  if (practice !== undefined) writeFileSync(join(root, practiceName), practice);
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: a spec');
  return { root, run, command, env, git, specName, practiceName };
}

test('spec --json emits one versioned document with every field, including empty fields [S13]', (t) => {
  const box = specBox(t);
  const shown = box.run('--json');
  assert.equal(shown.status, 0, shown.stderr);
  const data = JSON.parse(shown.stdout);
  assert.deepEqual(data, {
    version: 1,
    rows: [
      { id: 'G1', status: 'approved', tier: 'must', text: 'Same file twice is a no-op.', gate: 'idempotency test', serves: [], section: 'G · Goals', line: 6, file: 'SPEC.md' },
      { id: 'G1.2', status: 'draft', tier: 'aim', text: 'Shows a diff.', gate: '', serves: ['G1'], section: 'G · Goals', line: 7, file: 'SPEC.md' },
      { id: 'G2', status: 'retired', tier: '', text: 'Old idea.', gate: '', serves: [], section: 'G · Goals', line: 8, file: 'SPEC.md' },
      { id: 'K1', status: 'approved', tier: 'must', text: 'Runs offline.', gate: 'e2e test', serves: ['G1', 'G1.2'], section: 'K · Constraints', line: 11, file: 'SPEC.md' },
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
  assert.equal(data.rows.length, 7);
  assert.ok(data.rows.slice(0, 4).every((row) => row.file === 'requirements.md'));
  assert.deepEqual(data.rows.slice(4), [
    { id: 'P1', status: 'fact', tier: '', text: 'A fact.', gate: '', serves: [], section: 'P · Practice', line: 4, file: 'ways.md' },
    { id: 'P2', status: 'pending', tier: 'must', text: 'A question.', gate: '', serves: [], section: 'P · Practice', line: 5, file: 'ways.md' },
    { id: 'P3', status: 'wont', tier: '', text: 'An old plan.', gate: '', serves: [], section: 'P · Practice', line: 6, file: 'ways.md' },
  ]);
});

test('spec --json refuses errors in either file with the exact spec-check diagnostics and no JSON [S13, S4]', (t) => {
  const box = specBox(t, { practice: '# Practice\n\n## P\n- P1 [approved, must] No gate.\n' });
  writeFileSync(join(box.root, box.specName), `${SPEC}\n- K2 [maybe, must] Bad status. | serves: K9\n`);
  const check = box.run('check');
  const shown = box.run('--json');
  assert.equal(check.status, 1);
  assert.equal(shown.status, 1);
  assert.equal(shown.stdout, check.stdout);
  assert.equal(shown.stderr, check.stderr);
  assert.match(shown.stdout, /status "maybe"/);
  assert.match(shown.stdout, /serves K9/);
  assert.match(shown.stdout, /PRACTICE.md:4 P1 error:.*names its gate/);
  assert.throws(() => JSON.parse(shown.stdout));
});

test('spec --json also refuses a committed row removed from practice [S13, S8]', (t) => {
  const box = specBox(t, { practice: '# Practice\n\n## P\n- P1 [fact] Kept forever.\n' });
  writeFileSync(join(box.root, box.practiceName), '# Practice\n\n## P\n');
  const check = box.run('check');
  const shown = box.run('--json');
  assert.equal(shown.status, 1);
  assert.equal(shown.stdout, check.stdout);
  assert.match(shown.stdout, /PRACTICE.md: P1 error:.*ids are permanent/);
  assert.throws(() => JSON.parse(shown.stdout));
});

test('warning-only specs keep spec-check success while JSON stays a single document [S13]', (t) => {
  const box = specBox(t);
  writeFileSync(join(box.root, box.specName), `${SPEC}\n- K2 [draft] ${'word '.repeat(25)}\n`);
  const check = box.run('check');
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /warning: 25 words/);
  const shown = box.run('--json');
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(JSON.parse(shown.stdout).rows.length, 5);
});

test('signoff prints cited tests, preserves its note and escapes that note in the spec view [S14, S15]', (t) => {
  const box = specBox(t);
  mkdirSync(join(box.root, 'test'));
  writeFileSync(join(box.root, 'test', 'greeting.test.js'), "import { test } from 'node:test';\ntest('greeting [G1]', () => {});\n");
  box.git('add', 'test/greeting.test.js');
  box.git('commit', '-q', '-m', 'test: cite the greeting');
  const note = 'checked <img> & empty names\nwith the local greeting test';
  const signed = box.run('signoff', 'G1', '--by', 'CO', '--note', note);
  assert.equal(signed.status, 0, signed.stderr);
  assert.match(signed.stdout, /evidence for G1:\n  test: test\/greeting.test.js/);
  assert.ok(signed.stdout.indexOf('evidence for') < signed.stdout.indexOf('signed 1 rows'));
  assert.equal(readSignoffs(box.root)[0].note, note);
  assert.ok(box.run('show', 'G1').stdout.includes(note));
  const htmlFile = join(box.root, 'spec.html');
  const view = box.run('view', '--out', htmlFile);
  assert.equal(view.status, 0, view.stderr);
  const html = readFileSync(htmlFile, 'utf8');
  assert.match(html, /checked &lt;img&gt; &amp; empty names<br>with the local greeting test/);
  assert.doesNotMatch(html, /<img>/);
});

test('signoff reads --note-file exactly [S14]', (t) => {
  const box = specBox(t);
  mkdirSync(join(box.root, 'test'));
  writeFileSync(join(box.root, 'test', 'greeting.test.js'), "import { test } from 'node:test';\ntest('greeting [G1]', () => {});\n");
  box.git('add', 'test/greeting.test.js');
  box.git('commit', '-q', '-m', 'test: cite greeting');
  const note = 'quoted "text" with $vars and `ticks`\nand a final newline\n';
  const file = join(box.root, 'note.txt');
  writeFileSync(file, note);
  const signed = box.run('signoff', 'G1', '--by', 'CO', '--note-file', file);
  assert.equal(signed.status, 0, signed.stderr);
  assert.equal(readSignoffs(box.root)[0].note, note);
});

test('signoff refuses a flag it does not take [P4]', (t) => {
  const box = specBox(t);
  const unsupported = box.run('signoff', 'G1', '--by', 'CO', '--must');
  assert.notEqual(unsupported.status, 0, 'an option for a different spec command must not be ignored');
  assert.match(unsupported.stderr, /FLAG_NOT_ALLOWED.*spec signoff.*--must/);
});

test('spec view handles --json or refuses it instead of silently ignoring it [P4]', (t) => {
  const box = specBox(t);
  const htmlFile = join(box.root, 'requested-spec.html');
  const jsonAdapter = existsSync(resolve(import.meta.dirname, '../src/json.js'));
  const result = box.run('view', '--json', '--out', htmlFile);

  if (jsonAdapter) {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const document = JSON.parse(result.stdout);
    assert.equal(document.version, 1);
    assert.equal(document.path, htmlFile);
    assert.ok(existsSync(htmlFile));
    return;
  }

  assert.equal(result.status, 1);
  assert.match(result.stderr, /FLAG_NOT_ALLOWED.*spec view does not take --json/);
  assert.equal(existsSync(htmlFile), false, 'refusal happens before creating the HTML output');
});

test('spec unmet and signoff do not create a board when reading a repo without one [S14, P4]', (t) => {
  const box = specBox(t);
  const boardDir = join(box.root, '.git', 'pullboard');
  rmSync(boardDir, { recursive: true, force: true });
  assert.equal(existsSync(boardDir), false);

  const unmet = box.run('unmet');
  assert.equal(unmet.status, 0, unmet.stderr);
  assert.equal(existsSync(boardDir), false);

  const signoff = box.run('signoff', 'G1', '--by', 'CO');
  assert.equal(signoff.status, 1);
  assert.match(signoff.stderr, /NO_EVIDENCE/);
  assert.equal(existsSync(boardDir), false);
});

test('signoff refuses missing evidence atomically, and unmet shows every stage through a verified item [S14, S15, S16]', (t) => {
  const box = specBox(t);
  const failed = box.run('signoff', 'G1', '--by', 'CO', '--note', 'I looked');
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /NO_EVIDENCE.*G1.*build it or cite its id in a test first/);
  assert.equal(existsSync(join(box.root, SIGNOFFS_FILE)), false);
  assert.match(box.run('unmet').stdout, /G1 \[must\].*— no evidence/);
  const added = box.command('add', 'coordinator', 'Greeting', '--specs', 'G1');
  assert.equal(added.status, 0, added.stderr);
  assert.match(box.run('unmet').stdout, /G1 \[must\].*— building/);
  assert.equal(box.command('claim', '1').status, 0);
  const submitted = box.command('submit', '1');
  assert.equal(submitted.status, 0, submitted.stderr);
  assert.match(box.run('unmet').stdout, /G1 \[must\].*— awaiting a verdict/);
  const made = box.command('worktree', 'review');
  assert.equal(made.status, 0, made.stderr);
  const review = /^made (.+) on branch/m.exec(made.stdout)[1];
  const acceptedNote = 'checked greeting in the private fixture\nsecond line stays in the receipt';
  const accepted = spawnSync(process.execPath, [resolve(import.meta.dirname, '../bin/pullboard.js'), 'verify', '1', 'accept', '--note', acceptedNote], { cwd: review, env: box.env, encoding: 'utf8' });
  assert.equal(accepted.status, 0, `${accepted.stdout}${accepted.stderr}`);
  assert.match(box.run('unmet').stdout, /G1 \[must\].*— verified and ready to sign/);
  const signed = box.run('signoff', 'G1', '--by', 'CO', '--note', 'checked the accepting verdict');
  assert.equal(signed.status, 0, signed.stderr);
  assert.match(signed.stdout, /verified #1: checked greeting in the private fixture/);
  assert.doesNotMatch(signed.stdout, /second line stays in the receipt/);
  assert.doesNotMatch(box.run('unmet').stdout, /G1 \[must\]/);
  writeFileSync(join(box.root, box.specName), SPEC.replace('Same file twice is a no-op.', 'Same file twice stays a no-op.'));
  assert.match(box.run('unmet').stdout, /G1 \[must\].*— stale/);
  assert.match(box.run('show', 'G1').stdout, /checked the accepting verdict/);
});
