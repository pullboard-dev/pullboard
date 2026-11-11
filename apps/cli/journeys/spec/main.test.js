/**
 * The spec (S1–S5): parsing SPEC.md rows, the lint, the frozen criterion and sign-offs.
 */
import assert from 'node:assert/strict';
import { runFixtureChild as spawnSync } from '../../tests/fixtures/child.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { chmodSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { citedIds } from '../../../../packages/spec/index.js';
import { deletedIds } from '../../../../packages/spec/index.js';
import { frozenCriterion } from '../../../../packages/spec/index.js';
import { idProblems } from '../../../../packages/spec/index.js';
import { lintSpec } from '../../../../packages/spec/index.js';
import { parseSpec } from '../../../../packages/spec/index.js';
import { permanenceProblems } from '../../../../packages/spec/index.js';
import { readSignoffs } from '../../../../packages/spec/index.js';
import { SPEC_GRAMMAR_VERSION } from '../../../../packages/spec/index.js';
import { signOff } from '../../../../packages/spec/index.js';
import { standings } from '../../../../packages/spec/index.js';
import { unmetRows } from '../../../../packages/spec/index.js';
import { SPEC } from '../../tests/fixtures/spec/box.js';
import { specBox } from '../../tests/fixtures/spec/box.js';

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

test('rows parse signer requirements and lint their names and duplicates [S18]', () => {
  const spec = parseSpec('## G\n- G1 [approved, must] Two people sign. | gate: proof | signers: co@example.invalid, AB\n');
  assert.deepEqual(spec.rows[0].signers, ['co@example.invalid', 'AB']);
  assert.deepEqual(lintSpec(spec), []);
  const invalid = lintSpec(parseSpec('## G\n- G1 [approved, must] Bad names. | gate: proof | signers: bad name,CO,CO\n'));
  assert.ok(invalid.some((finding) => /signer "bad name" must be one SSH principal/u.test(finding.message)));
  assert.ok(invalid.some((finding) => /signers are unique/u.test(finding.message)));
});

test('SPEC and PRACTICE grammar defaults to version 1 and accepts its declaration [A5]', () => {
  assert.equal(SPEC_GRAMMAR_VERSION, 1);
  const legacy = parseSpec(SPEC);
  const declared = parseSpec(`<!-- pullboard-grammar ${SPEC_GRAMMAR_VERSION} -->\n${SPEC}`);
  assert.equal(legacy.grammarVersion, SPEC_GRAMMAR_VERSION);
  assert.equal(declared.grammarVersion, SPEC_GRAMMAR_VERSION);
  assert.deepEqual(declared.intro, legacy.intro);
  assert.deepEqual(declared.rows.map(({ line, ...row }) => row), legacy.rows.map(({ line, ...row }) => row));
  assert.deepEqual(lintSpec(declared), []);
});

test('a newer SPEC grammar is refused with its version and an upgrade step [A5]', () => {
  for (const version of ['2', '9007199254740993', '0', '2.5', '']) {
    assert.throws(() => parseSpec(`<!-- pullboard-grammar ${version} -->\n${SPEC}`), {
      code: 'A5_GRAMMAR_VERSION',
      message: new RegExp(`grammar .*not supported.*reads grammar ${SPEC_GRAMMAR_VERSION}.*upgrade Pullboard`),
    });
  }
  const fence = String.fromCharCode(96).repeat(3);
  assert.equal(parseSpec(`${fence}\n<!-- pullboard-grammar 2 -->\n${fence}\n${SPEC}`).grammarVersion, SPEC_GRAMMAR_VERSION);
  assert.throws(() => parseSpec(`<!-- pullboard-grammar 1 -->\n<!-- pullboard-grammar 2 -->\n${SPEC}`), { code: 'A5_GRAMMAR_VERSION' });
});

test('real spec check refuses future grammar in either configured file [A5]', (t) => {
  const practice = '# Practice\n\n## P\n- P1 [draft] A local rule.\n';
  const box = specBox(t, { specName: 'requirements.md', practiceName: 'ways.md', practice });
  for (const [name, source] of [[box.specName, SPEC], [box.practiceName, practice]]) {
    writeFileSync(join(box.root, name), `<!-- pullboard-grammar ${SPEC_GRAMMAR_VERSION} -->\n${source}`);
  }
  assert.equal(box.run('check').status, 0);
  for (const [name, source] of [[box.specName, SPEC], [box.practiceName, practice]]) {
    writeFileSync(join(box.root, name), '<!-- pullboard-grammar 2 -->\n' + source);
    const text = box.run('check');
    assert.equal(text.status, 1);
    assert.match(text.stderr, /A5_GRAMMAR_VERSION.*grammar 2.*grammar 1.*upgrade Pullboard/);
    const json = box.run('check', '--json');
    assert.equal(json.status, 1);
    const error = JSON.parse(json.stdout).error;
    assert.equal(error.code, 'A5_GRAMMAR_VERSION');
    assert.ok(!error.message.includes('[A5_GRAMMAR_VERSION]'));
    assert.match(error.message, /grammar 2.*grammar 1.*upgrade Pullboard/);
    assert.match(error.next, /upgrade Pullboard/);
    writeFileSync(join(box.root, name), source);
  }
  assert.equal(box.run('check').status, 0);
});

test('spec check names both locations when ids repeat within or across configured files [A5]', (t) => {
  const practiceRow = '# Practice\n\n## P\n- P1 [draft] A local rule.\n';
  const crossFile = specBox(t, { practice: practiceRow });
  writeFileSync(join(crossFile.root, crossFile.practiceName), practiceRow.replace('P1', 'G1'));
  const cross = crossFile.run('check');
  assert.equal(cross.status, 1);
  assert.match(cross.stdout, /SPEC\.md:6 G1 error: duplicate id; also appears at PRACTICE\.md:4/u);
  assert.match(cross.stdout, /PRACTICE\.md:4 G1 error: duplicate id; also appears at SPEC\.md:6/u);

  const duplicateSpec = specBox(t);
  writeFileSync(join(duplicateSpec.root, 'SPEC.md'), SPEC.replace('- G1.2 [draft, aim]', '- G1 [draft, aim]'));
  const duplicateSpecResult = duplicateSpec.run('check');
  assert.equal(duplicateSpecResult.status, 1);
  assert.match(duplicateSpecResult.stdout, /SPEC\.md:7 G1 error: duplicate id; also appears at SPEC\.md:6/u);

  const duplicatePractice = specBox(t, { practice: practiceRow });
  writeFileSync(join(duplicatePractice.root, 'PRACTICE.md'), practiceRow.replace('- P1 [draft] A local rule.', '- P1 [draft] First.\n- P1 [draft] Second.'));
  const duplicatePracticeResult = duplicatePractice.run('check');
  assert.equal(duplicatePracticeResult.status, 1);
  assert.match(duplicatePracticeResult.stdout, /PRACTICE\.md:5 P1 error: duplicate id; also appears at PRACTICE\.md:4/u);
});

test('spec check lists primary-branch collisions as known warnings [A5]', (t) => {
  const practice = '# Practice\n\n## G\n- G1 [draft] A known local rule.\n';
  const box = specBox(t, { practice });
  const result = box.run('check');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /SPEC\.md:6 G1 warning: known duplicate id; also appears at PRACTICE\.md:4/u);
  assert.match(result.stdout, /PRACTICE\.md:4 G1 warning: known duplicate id; also appears at SPEC\.md:6/u);
});

test('spec check uses the retained trunk after its coordinator checkout detaches [A5]', (t) => {
  const practice = '# Practice\n\n## P\n- P1 [draft] A local rule.\n';
  const box = specBox(t, { practice });
  const gitAt = (cwd, ...args) => runFixtureGit(args, { cwd, env: box.env, encoding: 'utf8', stdio: 'pipe' });
  const runAt = (cwd, ...args) => runFixtureChild(process.execPath, [resolve(import.meta.dirname, '../../pullboard.js'), ...args], {
    cwd, env: box.env, encoding: 'utf8',
  });
  gitAt(box.root, 'branch', '-m', 'trunk');
  gitAt(box.root, 'config', '--local', 'pullboard.trunk', 'refs/heads/trunk');
  const configPath = join(box.root, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.lanes.spec = { owns: ['PRACTICE.md'] };
  writeFileSync(configPath, JSON.stringify(config));
  gitAt(box.root, 'add', 'pullboard.json');
  gitAt(box.root, 'commit', '-q', '-m', 'chore: add the spec fixture lane');
  const builder = join(box.root, 'builder');
  gitAt(box.root, 'worktree', 'add', '-q', builder, '-b', 'builder');
  const joined = spawnSync(process.execPath, [resolve(import.meta.dirname, '../../pullboard.js'), 'join', 'spec'], {
    cwd: builder, env: box.env, encoding: 'utf8',
  });
  assert.equal(joined.status, 0, joined.stderr);
  writeFileSync(join(builder, 'PRACTICE.md'), practice.replace('- P1 [draft] A local rule.', '- P1 [draft] A local rule.\n- G1 [draft] Duplicate.'));
  gitAt(builder, 'add', 'PRACTICE.md');
  gitAt(builder, 'commit', '-q', '-m', 'chore: add a colliding row');
  const result = runAt(builder, 'spec', 'check');
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}${result.stderr}`, /duplicate id; also appears at PRACTICE\.md:\d+/u);
  gitAt(box.root, 'switch', '-q', '--detach');
  const detached = runAt(builder, 'spec', 'check');
  assert.equal(detached.status, 1);
  assert.match(detached.stdout, /duplicate id; also appears at PRACTICE\.md:\d+/u);
  assert.doesNotMatch(`${detached.stdout}${detached.stderr}`, /COORDINATOR_DETACHED/u);
  gitAt(box.root, 'switch', '-q', 'trunk');
});

test('a grammar-1 repair can commit after grammar 2 was already recorded [A5,S8]', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-grammar-history-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, '.bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec "${process.execPath}" "${resolve(import.meta.dirname, '../../pullboard.js')}" "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Agent',
    GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent',
    GIT_COMMITTER_EMAIL: 'agent@example.com',
    PULLBOARD_HOME: join(root, '.home'),
    PULLBOARD_MACHINE_HOME: join(root, '.home'),
  };
  const git = (...args) => runFixtureGit(args, { cwd: root, env, encoding: 'utf8', stdio: 'pipe' });
  const command = (...args) => runFixtureChild(process.execPath, [resolve(import.meta.dirname, '../../pullboard.js'), ...args], { cwd: root, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test Agent');
  git('config', 'user.email', 'agent@example.com');
  writeFileSync(join(root, 'SPEC.md'), `<!-- pullboard-grammar 2 -->\n${SPEC}`);
  writeFileSync(join(root, 'PRACTICE.md'), '<!-- pullboard-grammar 2 -->\n# Practice\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'docs: preserve pre-upgrade grammar');
  writeFileSync(join(root, 'SPEC.md'), `<!-- pullboard-grammar 1 -->\n${SPEC}`);
  writeFileSync(join(root, 'PRACTICE.md'), '<!-- pullboard-grammar 1 -->\n# Practice\n');
  const initialized = command('init');
  assert.equal(initialized.status, 0, `${initialized.stdout}${initialized.stderr}`);
  git('add', '-A');
  const repaired = spawnSync('git', ['commit', '-q', '-m', 'docs: restore supported grammar'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(repaired.status, 0, `${repaired.stdout}${repaired.stderr}`);
  const checked = command('spec', 'check');
  assert.equal(checked.status, 0, `${checked.stdout}${checked.stderr}`);
});

test('a row-like line that does not parse is an error, never dropped [S1]', () => {
  const spec = parseSpec('## G\n- G1 [approved, must]\n- just a bullet note\n');
  const findings = lintSpec(spec);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /does not parse/);
  assert.equal(findings[0].line, 2);
});

test('rows inside code fences are examples, not rows [S1]', () => {
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

test('bad status, bad tier and unknown fields are errors; long rows warn [S1]', () => {
  const findings = lintSpec(
    parseSpec(`## G\n- G1 [maybe, should] Text. | owner: me\n- G2 [draft] ${'word '.repeat(25)}\n`),
  );
  const messages = findings.map((finding) => `${finding.level}: ${finding.message}`);
  assert.ok(messages.some((message) => message.startsWith('error: status "maybe"')));
  assert.ok(messages.some((message) => message.startsWith('error: tier "should"')));
  assert.ok(messages.some((message) => message.startsWith('error: unknown field "owner: me"')));
  assert.ok(messages.some((message) => message.startsWith('warning: 25 words')));
});

test('cited ids must exist and must not be retired [S2]', () => {
  const spec = { ...parseSpec(SPEC), name: 'SPEC.md' };
  assert.deepEqual(idProblems(spec, ['G1', 'K1']), []);
  assert.deepEqual(idProblems(spec, ['G9', 'G2']), ['G9 is not in SPEC.md', 'G2 is retired']);
});

test('doctrine ids use their own namespace when an id also exists in SPEC.md [A5]', () => {
  const spec = { ...parseSpec('## G\n- G1 [approved] Product rule.\n'), name: 'SPEC.md' };
  const doctrine = { rows: [
    { id: 'G1', status: 'approved', text: 'House rule.', gate: '' },
    { id: 'PB1', status: 'approved', text: 'Inherited rule.', gate: '' },
  ] };
  assert.deepEqual(idProblems(spec, ['G1', 'doctrine:G1', 'doctrine:PB1'], doctrine), []);
  assert.deepEqual(idProblems(spec, ['doctrine:PB9'], doctrine), ['doctrine:PB9 is not in doctrine']);
  assert.deepEqual(idProblems(spec, ['other:G1'], doctrine), ['other:G1 uses an unknown namespace; use doctrine:<id> for a doctrine row']);
  const frozen = frozenCriterion(spec, {
    item_title: 'Use the house rule', item_criterion: 'follow it', item_spec_ids: 'doctrine:G1',
  }, doctrine);
  assert.match(frozen.text, /"id":"doctrine:G1","text":"House rule\."/u);
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
  assert.deepEqual(citedIds('feat(web): add the rule [doctrine:PB1]'), ['doctrine:PB1']);
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
    cited: new Map([['G1', 'commit 1234567'], ['G2', 'item #3'], ['X4', 'commit 89abcde'], ['doctrine:CD60', 'item #1592']]),
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
