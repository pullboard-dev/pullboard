/**
 * The spec (S1–S5): parsing SPEC.md rows, the lint, the frozen criterion and sign-offs.
 */
import { repointLandingGates } from '../../../../../packages/spec/index.js';
import { missingGateFindings } from '../../../../../packages/spec/index.js';
import { boardBusyError } from '../../../../../packages/store/index.js';
import { openBoardReadOnly } from '../../../../../packages/store/index.js';
import { rowDecisions } from '../../../../../packages/spec/index.js';
import { checkLoosening } from '../../../../../packages/doctrine/index.js';
import assert from 'node:assert/strict';
import { runFixtureGit } from '../../../tests/fixtures/child.js';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { configFromSource } from '../../../../../packages/config/index.js';
import { preCommitProblems } from '../../../../../packages/commits/index.js';
import { requireRelayOnChannel } from '../../../../../packages/person/index.js';
import { parseSpec } from '../../../../../packages/spec/index.js';
import { SPEC } from '../../../tests/fixtures/spec/box.js';
import { specBox } from '../../../tests/fixtures/spec/box.js';
import { runIn } from '../../../tests/fixtures/spec/box.js';
import { SETUP_SPEC } from '../../../tests/fixtures/spec/box.js';
import { answerCommandCase } from '../../../tests/fixtures/spec/box.js';

const approvedRowPorts = { boardBusyError, openBoardReadOnly, rowDecisions, checkLoosening };

test('an approved row waits for apply, not for the person [S1,I1,P6]', (t) => {
  const box = specBox(t, { specSource: SETUP_SPEC });
  /** Setup details live on the diagnostic card; retain all original person/apply assertions. */
  const resume = () => {
    const read = runIn(box, box.root, ['resume', '--diagnostics']);
    assert.equal(read.status, 0, read.stdout + read.stderr);
    return read.stdout;
  };
  const before = resume();
  assert.match(before, /For the person: pullboard spec approve A1; pullboard spec answer A2 "<choice>"/u,
    'a draft row is offered for approval and a pending question for an answer, never approve');

  assert.equal(box.run('approve', 'A1').status, 0);
  const halfway = resume();
  assert.doesNotMatch(halfway, /spec approve A1|approve A1,|Waiting for the person to (approve|decide|answer) A1/u, 'an approved row is no longer asked of the person');
  assert.match(halfway, /The person already approved A1; pullboard spec apply writes them\./u, 'the approved row is named as waiting for apply');
  assert.match(halfway, /pullboard spec answer A2 "<choice>"/u, 'the open question is still offered as an answer');

  assert.equal(box.run('answer', 'A2', 'Netlify').status, 0);
  const decided = resume();
  assert.match(decided, /The person approved A1, A2; apply them: pullboard spec apply\./u, 'with every row decided, the coordinator is told to apply');
  assert.match(decided, /^next: pullboard spec apply, then commit SPEC\.md$/mu);
  assert.doesNotMatch(decided, /Waiting for the person|For the person|spec approve/u, 'nothing is asked of the person again');
  for (const text of [before, halfway, decided]) assert.doesNotMatch(text, /reword|redraft/iu, 'no surface asks an agent to reword or redraft a row');

  assert.equal(box.run('apply').status, 0);
  // runFixtureGit throws if the commit fails, so reaching the next line means SPEC.md is committed.
  runFixtureGit(['commit', '-q', '-m', 'docs(spec): apply row decisions', '--', box.specName], { cwd: box.root, env: box.env, encoding: 'utf8' });
  const after = resume();
  assert.doesNotMatch(after, /spec apply|Waiting for the person to (approve|decide|answer)/u, 'once applied and committed, setup moves on');
});

test('a joined seat requests answers for pending questions [S1,I1,P6]', t => {
  for (const mixed of [false, true]) {
    const source = '# Spec\n\n## Q · Setup\n- Q1 [pending, must] It deploys to: Vercel. Choices: Vercel, Netlify. | gate: review\n'
      + (mixed ? '- A1 [draft, must] Every page works at phone width. | gate: review\n' : '');
    const box = specBox(t, { specSource: source });
    const configPath = join(box.root, 'pullboard.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.lanes.build = { owns: ['app/'] };
    writeFileSync(configPath, JSON.stringify(config));
    box.git('add', 'pullboard.json');
    box.git('commit', '-q', '-m', 'chore: configure the setup fixture lane');
    const builder = join(box.root, 'builder');
    box.git('worktree', 'add', '-q', '-b', 'build/setup', builder);
    const joined = runIn(box, builder, ['join', 'build', '--model', 'Fixture']);
    assert.equal(joined.status, 0, joined.stderr + joined.stdout);
    const read = runIn(box, builder, ['resume', '--diagnostics', '--json']);
    assert.equal(read.status, 0, read.stderr + read.stdout);
    const card = JSON.parse(read.stdout);
    assert.match(card.setup.personCommand, /pullboard spec answer Q1 "<choice>"/u);
    assert.doesNotMatch([card.setup.question, card.setup.agentNext, card.next].join('\n'), /approv/iu,
      'pending-only or mixed joined-seat guidance never asks for approval of a question');
    const expected = mixed ? 'decide Q1, A1' : 'answer Q1';
    assert.ok(card.setup.question.includes(expected), card.setup.question);
    assert.ok(card.setup.agentNext.includes(expected), card.setup.agentNext);
    assert.equal(card.next, card.setup.agentNext);
    if (mixed) assert.match(card.setup.personCommand, /pullboard spec approve A1; pullboard spec answer Q1/u,
      'the draft still gets approval while the question gets its answer');
  }
});

test('a changed approved draft needs a new decision before apply [S1,I1,P6]', t => {
  const box = specBox(t, { specSource: '# Spec\n\n## A · Setup\n- A1 [draft, must] Every page works at phone width. | gate: review\n' });
  assert.equal(box.run('approve', 'A1').status, 0);
  const path = join(box.root, box.specName);
  writeFileSync(path, readFileSync(path, 'utf8').replace('phone width', 'desktop width'));
  const staleApply = box.run('apply');
  assert.equal(staleApply.status, 1, staleApply.stdout + staleApply.stderr);
  assert.match(staleApply.stderr, /STALE_ROW_DECISION/u);
  const read = runIn(box, box.root, ['resume', '--diagnostics', '--json']);
  assert.equal(read.status, 0, read.stderr + read.stdout);
  const card = JSON.parse(read.stdout);
  assert.equal(card.setup.waitingOn, 'person-approval', 'the old decision does not approve the changed text');
  assert.deepEqual(card.setup.rowIds, ['A1']);
  assert.equal(card.setup.personCommand, 'pullboard spec approve A1');
  assert.doesNotMatch(card.next, /spec apply/u, 'applying the stale receipt would loop');
  assert.equal(box.run('approve', 'A1').status, 0, 'the person can approve the current text');
  const decided = JSON.parse(runIn(box, box.root, ['resume', '--diagnostics', '--json']).stdout);
  assert.equal(decided.setup.waitingOn, 'coordinator-apply');
  assert.equal(box.run('apply').status, 0);
  runFixtureGit(['commit', '-q', '-m', 'docs(spec): apply current row decision', '--', box.specName], { cwd: box.root, env: box.env, encoding: 'utf8' });
  const applied = JSON.parse(runIn(box, box.root, ['resume', '--diagnostics', '--json']).stdout);
  assert.doesNotMatch(applied.next, /spec apply|approve A1/u);
});

test('a spec answer refused in an agent shell gives the person the exact command to paste [S1,B26]', async (t) => {
  for (const separateGitDir of [false, true]) await t.test(separateGitDir ? 'Git metadata in a separate folder' : 'a plain repository', (t) => answerCommandCase(t, separateGitDir));
  assert.throws(() => requireRelayOnChannel('terminal', { CLAUDECODE: '1' }), (error) => error.code === 'B26_PERSON_CHANNEL' && /run pullboard view/u.test(error.message),
    'relay on keeps its own refusal in an agent shell');
});

test('landing repoints only Git-renamed gate paths and keeps deleted gates missing [S4,B3]', (t) => {
  const source = '# Demo\n\n## G · Goals\n- G1 [approved, must] Original text stays exact. | gate: node test/old.test.js | serves: G2\n- G2 [approved, must] Deleted proof stays required. | gate: test/gone.test.js\n- G3 [approved, must] Untouched proof. | gate: test/still.test.js\n';
  const box = specBox(t, { specSource: SPEC });
  mkdirSync(join(box.root, 'test'));
  for (const file of ['old', 'gone', 'still']) writeFileSync(join(box.root, `test/${file}.test.js`), `export const ${file} = true;\n`);
  box.git('add', '-A'); box.git('commit', '-q', '-m', 'test: add gate proofs');
  const base = box.git('rev-parse', 'HEAD').trim();
  box.git('mv', 'test/old.test.js', 'test/new.test.js');
  box.git('rm', '-q', 'test/gone.test.js');
  box.git('commit', '-q', '-m', 'test: move one proof');
  const tip = box.git('rev-parse', 'HEAD').trim();
  writeFileSync(join(box.root, box.specName), source);
  const changes = repointLandingGates(box.root, { spec: box.specName }, base, tip);
  assert.deepEqual(changes, [{ row: 'G1', from: 'test/old.test.js', to: 'test/new.test.js' }]);
  const actual = readFileSync(join(box.root, box.specName), 'utf8');
  assert.equal(actual, source.replace('test/old.test.js', 'test/new.test.js'));
  const findings = missingGateFindings(parseSpec(actual), box.root);
  assert.ok(findings.some(row => row.id === 'G2' && row.level === 'error'));
  assert.ok(!findings.some(row => row.id === 'G1' || row.id === 'G3'));
});

test('spec check fails when an approved row names a missing gate [S4]', (t) => {
  // A gate file that was committed and then removed is a lost test: an approved must-row fails spec check and
  // names the row, the file and the removal (#809).
  const box = specBox(t, { specSource: SPEC });
  mkdirSync(join(box.root, 'test'));
  writeFileSync(join(box.root, 'test/proof-gone.test.js'), 'export {};\n');
  box.git('add', '-A');
  box.git('commit', '-q', '-m', 'test: the proof');
  box.git('rm', '-q', 'test/proof-gone.test.js');
  box.git('commit', '-q', '-m', 'test: remove the proof');
  writeFileSync(join(box.root, box.specName), `${SPEC}- G9 [approved, must] A rule keeps its proof. | gate: test/proof-gone.test.js\n`);
  const text = box.run('check');
  assert.equal(text.status, 1, text.stdout + text.stderr);
  assert.match(text.stdout + text.stderr, /G9 error: gate file test\/proof-gone\.test\.js was removed from the repository/u);
});

test('a gate test that was never written only warns, so a new project passes [S4]', (t) => {
  // A gate file that was never committed is a test not written yet: a warning, so the README's example still fits (#809).
  const source = `${SPEC}- G9 [approved, must] A rule keeps its proof. | gate: test/never-written.test.js\n`;
  const box = specBox(t, { specSource: source });
  const text = box.run('check');
  assert.equal(text.status, 0, text.stdout + text.stderr);
  assert.match(text.stdout + text.stderr, /G9 warning: gate file test\/never-written\.test\.js does not exist yet/u);
});

test('a draft row with a missing gate file only warns [S4]', (t) => {
  const source = `${SPEC}- G9 [draft, must] A rule not yet proved. | gate: test/not-yet.test.js\n`;
  const box = specBox(t, { specSource: source });
  const text = box.run('check');
  assert.equal(text.status, 0, text.stdout + text.stderr);
  assert.match(text.stderr + text.stdout, /G9 warning: gate file test\/not-yet\.test\.js does not exist/u);
});

test('a commit that deletes an approved row test is refused [S4]', (t) => {
  // Staged deletion of the file an approved row names is refused until the same commit repoints the row (#809).
  const box = specBox(t, { specSource: `${SPEC}- G9 [approved, must] A rule keeps its proof. | gate: test/proof.test.js\n` });
  mkdirSync(join(box.root, 'test'));
  writeFileSync(join(box.root, 'test/proof.test.js'), 'export {};\n');
  box.git('add', '-A');
  box.git('commit', '-q', '-m', 'test: the proof');
  const config = configFromSource(readFileSync(join(box.root, 'pullboard.json'), 'utf8'));
  box.git('rm', '-q', 'test/proof.test.js');
  const refused = preCommitProblems({ approvedRowPorts, root: box.root, isMain: true, config, agent: null });
  assert.ok(refused.some((problem) => problem.includes('G9 names test/proof.test.js, which this commit deletes')), refused.join('\n'));
  box.git('reset', '-q', '--hard', 'HEAD');
  writeFileSync(join(box.root, 'test/proof-new.test.js'), 'export {};\n');
  writeFileSync(join(box.root, config.spec), `${SPEC}- G9 [approved, must] A rule keeps its proof. | gate: test/proof-new.test.js\n`);
  box.git('rm', '-q', 'test/proof.test.js');
  box.git('add', '-A');
  const repointed = preCommitProblems({ approvedRowPorts, root: box.root, isMain: true, config, agent: null });
  assert.ok(!repointed.some((problem) => problem.includes('G9 names')), `the same commit repoints the row: ${repointed.join('\n')}`);
});

test('an exact-content gate rename passes the commit and spec guards; changed content is refused [S4,B3]', (t) => {
  const source = `${SPEC}- G9 [approved, must] A rule keeps its proof. | gate: test/proof.test.js\n`;
  const box = specBox(t, { specSource: source });
  mkdirSync(join(box.root, 'test'));
  const content = 'export const proof = true;\n'.repeat(20);
  writeFileSync(join(box.root, 'test/proof.test.js'), content);
  box.git('add', '-A'); box.git('commit', '-q', '-m', 'test: add proof');
  const config = configFromSource(readFileSync(join(box.root, 'pullboard.json'), 'utf8'));
  box.git('mv', 'test/proof.test.js', 'test/moved.test.js');
  const exact = preCommitProblems({ approvedRowPorts, root: box.root, isMain: true, config, agent: null });
  assert.ok(!exact.some(problem => problem.includes('G9 names')), exact.join('\n'));
  writeFileSync(join(box.root, 'test/moved.test.js'), content + 'export const changed = true;\n');
  box.git('add', 'test/moved.test.js');
  const changed = preCommitProblems({ approvedRowPorts, root: box.root, isMain: true, config, agent: null });
  assert.ok(changed.some(problem => problem.includes('G9 names') && problem.includes('changed content')), changed.join('\n'));
  writeFileSync(join(box.root, 'test/moved.test.js'), content);
  box.git('add', 'test/moved.test.js'); box.git('commit', '-q', '-m', 'test: rename proof');
  const findings = missingGateFindings(parseSpec(source), box.root);
  assert.ok(findings.some(row => row.id === 'G9' && row.level === 'warning' && /landing will repoint/u.test(row.message)));
  assert.ok(!findings.some(row => row.id === 'G9' && row.level === 'error'));
  writeFileSync(join(box.root, 'test/moved.test.js'), content + 'export const later = true;\n');
  box.git('add', 'test/moved.test.js'); box.git('commit', '-q', '-m', 'test: change moved proof');
  assert.ok(missingGateFindings(parseSpec(source), box.root).some(row => row.id === 'G9' && row.level === 'error'));
});

test('a gate path written another way still guards its test [S4]', (t) => {
  // ./test/proof.test.js and test/x/../proof.test.js name the file Git reports as test/proof.test.js (#809 review).
  for (const gate of ['.././test/proof.test.js', 'test/x/../proof.test.js']) {
    const box = specBox(t, { specSource: `${SPEC}- G9 [approved, must] A rule keeps its proof. | gate: ${gate}\n` });
    mkdirSync(join(box.root, 'test'));
    writeFileSync(join(box.root, 'test/proof.test.js'), 'export {};\n');
    box.git('add', '-A');
    box.git('commit', '-q', '-m', 'test: the proof');
    const config = configFromSource(readFileSync(join(box.root, 'pullboard.json'), 'utf8'));
    box.git('rm', '-q', 'test/proof.test.js');
    const refused = preCommitProblems({ approvedRowPorts, root: box.root, isMain: true, config, agent: null });
    assert.ok(refused.some((problem) => problem.includes('G9 names test/proof.test.js, which this commit deletes')), `${gate}: ${refused.join('\n')}`);
  }
});
