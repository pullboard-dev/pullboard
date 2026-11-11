import { repointLandingGates } from '../../../../packages/spec/index.js';
import { missingGateFindings } from '../../../../packages/spec/index.js';
/**
 * The spec (S1–S5): parsing SPEC.md rows, the lint, the frozen criterion and sign-offs.
 */
import { boardBusyError } from '../../../../packages/store/index.js';
import { openBoardReadOnly } from '../../../../packages/store/index.js';
import { rowDecisions } from '../../../../packages/spec/index.js';
import { checkLoosening } from '../../../../packages/doctrine/index.js';

const approvedRowPorts = { boardBusyError, openBoardReadOnly, rowDecisions, checkLoosening };
import assert from 'node:assert/strict';
import * as store from '../../../../packages/store/index.js';
import {
  openBoard,
  draftSpecRow,
  recordRowVerification,
} from '../../../lib/index.js';
import { fixtureBoard } from '../../tests/fixtures/board.js';
import {
  applyEngineMove,
  prepareEngineMove,
} from '../../../../packages/state/index.js';
import {
  exportBoard,
  importBoard,
} from '../../../../packages/store/index.js';
import { SPEC_VERDICT_ENGINE } from '../../../../packages/state/light.js';
import { ENGINE_VERSION } from '../../../../packages/state/index.js';
import { minimumMoveEngine } from '../../../../packages/moves/index.js';
import {
  runFixtureExecFile as execFileSync,
  runFixtureChild as spawnSync,
  runFixtureChild,
  runFixtureGit,
} from '../../tests/fixtures/child.js';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { configFromSource } from '../../../../packages/config/index.js';
import { preCommitProblems } from '../../../../packages/commits/index.js';
import { standardDoctrine } from '../../../../packages/doctrine/index.js';
import {
  AGENT_SHELL_MARKERS,
  SSH_SHELL_MARKERS,
} from '../../../../packages/kernel/index.js';
import { requireRelayOnChannel } from '../../../../packages/person/index.js';
import { RECORDED_GENERIC_NEXT } from '../../../../packages/state/index.js';
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
  SPEC_GRAMMAR_VERSION,
  signOff,
  standings,
  unmetRows,
} from '../../../../packages/spec/index.js';

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

/**
 * A real repo and board with an isolated registry, so JSON exercises the command's lint and history
 * checks rather than just serializing the parser. Its files may use the configured names.
 */
function specBox(t, { specName = 'SPEC.md', practiceName = 'PRACTICE.md', practice, specSource = SPEC, freshInit = false, separateGitDir = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-spec-json-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, '.bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec "${process.execPath}" "${resolve(import.meta.dirname, '../../pullboard.js')}" "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Agent', GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent', GIT_COMMITTER_EMAIL: 'agent@example.com',
    // Beside the repo, not in it: the board write log lives in the machine home and must not dirty the committed tree.
    PULLBOARD_HOME: `${root}-home`,
    PULLBOARD_MACHINE_HOME: `${root}-home`,
  };
  t.after(() => rmSync(`${root}-home`, { recursive: true, force: true }));
  delete env.PULLBOARD_RELAY_TOKEN;
  // These isolated signoff fixtures model the same person terminal as the suite runner.
  for (const marker of [...AGENT_SHELL_MARKERS, ...SSH_SHELL_MARKERS]) delete env[marker];
  const git = (...args) => runFixtureGit(args, { cwd: root, env, stdio: 'pipe', encoding: 'utf8' });
  const command = (...args) => runFixtureChild(process.execPath, [resolve(import.meta.dirname, '../../pullboard.js'), ...args], { cwd: root, env, encoding: 'utf8' });
  const run = (...args) => command('spec', ...args);
  // A --separate-git-dir repository keeps its Git metadata in another folder (#915).
  const metadata = separateGitDir ? realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-spec-git-'))) : null;
  if (metadata) t.after(() => rmSync(metadata, { recursive: true, force: true }));
  git('init', '-q', '-b', 'main', ...(metadata ? ['--separate-git-dir', join(metadata, 'repo.git')] : []));
  git('config', 'user.name', 'Test Agent');
  git('config', 'user.email', 'agent@example.com');
  const init = spawnSync(process.execPath, [resolve(import.meta.dirname, '../../pullboard.js'), 'init'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const config = JSON.parse(readFileSync(join(root, 'pullboard.json'), 'utf8'));
  if (freshInit) {
    git('add', '-A');
    git('commit', '-q', '-m', 'chore: fresh pullboard init');
    return { root, run, command, env, git, specName: config.spec, practiceName: config.practice };
  }
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ ...config, spec: specName, practice: practiceName, gate: 'true', lanes: { review: { owns: [] } } }));
  rmSync(join(root, 'SPEC.md'), { force: true });
  rmSync(join(root, 'PRACTICE.md'), { force: true });
  rmSync(join(root, 'DOCTRINE.md'), { force: true });
  writeFileSync(join(root, specName), specSource);
  if (practice !== undefined) writeFileSync(join(root, practiceName), practice);
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: a spec');
  return { root, run, command, env, git, specName, practiceName };
}

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

/** Blueprint questions as blueprint add writes them: the default answer, then every choice; B5 lists 13 parts. */
const QUESTION_SPEC = `${SPEC}
## B · Blueprint
- B1 [pending, must] Which store holds the data: SQLite. Choices: SQLite, Postgres. | gate: review
- B2 [pending, must] Which store holds the cache: SQLite. Choices: SQLite, Postgres. | gate: review
- B3 [pending, must] Which store holds the logs: SQLite. Choices: SQLite, Postgres. | gate: review
- B4 [pending, must] Which store holds the files: SQLite. Choices: SQLite, Postgres. | gate: review
- B5 [pending, must] Which region hosts it: r1. Choices: r1, r2, r3, r4, r5, r6, r7, r8, r9, r10, r11, r12, r13. | gate: review
`;

/** Run one CLI command in a box with an environment of the test's choosing. */
function runIn(box, cwd, args, env = box.env) {
  return runFixtureChild(process.execPath, [resolve(import.meta.dirname, '../../pullboard.js'), ...args], { cwd, env, encoding: 'utf8' });
}

/** Send one move through the view's own API adapter, executeMove, on the channel named. */
function viewMove(box, move, channel, env) {
  const apiModule = pathToFileURL(resolve(import.meta.dirname, '../../../../packages/api/src/io/main.js')).href;
  const cliModule = pathToFileURL(resolve(import.meta.dirname, '../../tests/fixtures/native.js')).href;
  const source = `
    const { executeMove } = await import(${JSON.stringify(apiModule)});
    const { main } = await import(${JSON.stringify(cliModule)});
    const { openBoard, openBoardForRead } = await import(${JSON.stringify(new URL('../../../lib/src/logic/native.js', import.meta.url).href)});
    const { moveArgs } = await import(${JSON.stringify(new URL('../../../../packages/person/index.js', import.meta.url).href)});
    const apiBoardOpeners = { openBoard, openBoardForRead, moveArgs };
    const response = await executeMove(process.cwd(), ${JSON.stringify(move)}, main, undefined, ${JSON.stringify(channel)}, undefined, apiBoardOpeners);
    process.stdout.write(JSON.stringify(response));
  `;
  const child = runFixtureChild(process.execPath, ['--input-type=module', '-e', source], { cwd: box.root, env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  return JSON.parse(child.stdout);
}

/** The board's person row decisions, read without opening its migrator. */
function boardRowDecisions(box) {
  const db = new DatabaseSync(join(box.root, '.git', 'pullboard', 'board.sqlite'), { readOnly: true });
  try { return db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='row_decisions'").get()?.meta_value ?? '[]'; }
  finally { db.close(); }
}

test("spec answer records the person's choice [S1,E3,P6]", (t) => {
  const box = specBox(t, { specSource: QUESTION_SPEC });
  const file = join(box.root, box.specName);
  const line = (id) => readFileSync(file, 'utf8').split('\n').find((text) => text.startsWith(`- ${id} `));
  const before = readFileSync(file, 'utf8');

  const listed = box.run('answer', 'B1', 'postgres', '--json');
  assert.equal(listed.status, 0, listed.stdout + listed.stderr);
  const [record] = JSON.parse(listed.stdout).decisions;
  assert.deepEqual([record.id, record.decision, record.answer, record.text],
    ['B1', 'approve', 'Postgres', 'Which store holds the data: Postgres. Choices: SQLite, Postgres.'],
    'a listed choice matches in any case and keeps its listed spelling');
  assert.equal(record.by, 'person');
  assert.equal(readFileSync(file, 'utf8'), before, 'the answer waits for the coordinator apply, as an approval does');
  assert.match(box.run('show', 'B1').stdout, /answered Postgres, pending apply/u);
  const board = new DatabaseSync(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  try {
    const stored = JSON.parse(board.prepare("SELECT meta_value FROM board_meta WHERE meta_key='row_decisions'").get().meta_value);
    board.prepare("UPDATE board_meta SET meta_value=? WHERE meta_key='row_decisions'")
      .run(JSON.stringify(stored.map((entry) => (entry.id === 'B1' ? { ...entry, answer: 'Tampered' } : entry))));
  } finally { board.close(); }
  const tampered = box.run('show', 'B1');
  assert.match(tampered.stdout, /answered Postgres, pending apply/u, 'the answer shown is read back from the signed text');
  assert.doesNotMatch(tampered.stdout, /Tampered/u, 'an unsigned answer field never changes what is shown');

  const oversized = box.run('answer', 'B5', 'r2', '--json');
  assert.equal(oversized.status, 1, oversized.stdout + oversized.stderr);
  const bound = JSON.parse(oversized.stdout).error;
  assert.equal(bound.code, 'SPEC_ANSWER_CHOICES', 'more than 12 choice parts is refused by name');
  assert.match(bound.message, /B5 lists 13 choice parts, more than the 12/u);
  assert.match(bound.next, /pullboard spec approve B5 --text/u);

  const free = box.run('answer', 'B2', 'Redis on the host');
  assert.equal(free.status, 0, free.stdout + free.stderr);
  assert.match(free.stdout, /^B2: answered Redis on the host, pending apply$/mu);

  const applied = box.run('apply');
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  assert.equal(line('B1'), '- B1 [approved, must] Which store holds the data: Postgres. Choices: SQLite, Postgres. | gate: review',
    'the row leaves pending with the chosen answer');
  assert.equal(line('B2'), '- B2 [approved, must] Which store holds the cache: Redis on the host. Choices: SQLite, Postgres, Redis on the host. | gate: review',
    'an answer outside the choices is kept and joins them as the last choice');

  const view = viewMove(box, { verb: 'spec-answer', args: { row: 'B3', answer: 'SQLite' } }, 'view', { ...box.env, CLAUDECODE: '1' });
  assert.equal(view.status, 200, JSON.stringify(view));
  assert.equal(view.body.event.event_by, 'person');
  assert.equal(JSON.parse(view.body.event.event_detail).channel, 'view');
  assert.equal(view.body.result.decisions[0].answer, 'SQLite');
  assert.equal(box.run('apply').status, 0);
  assert.equal(line('B3'), '- B3 [approved, must] Which store holds the logs: SQLite. Choices: SQLite, Postgres. | gate: review',
    'the person answers from the view as well as the main checkout');

  const checked = box.run('check');
  assert.equal(checked.status, 0, `answers through the person path pass spec check: ${checked.stdout}${checked.stderr}`);

  const again = box.run('answer', 'B1', 'SQLite', '--json');
  assert.equal(again.status, 1);
  const error = JSON.parse(again.stdout).error;
  assert.equal(error.code, 'SPEC_ANSWER');
  assert.match(error.message, /B1 is approved, not a pending question/u);
  assert.match(error.next, /pullboard spec/u);
  assert.notEqual(error.next, RECORDED_GENERIC_NEXT);
});

test('approving an answered row keeps the answer [S1,E3]', (t) => {
  const box = specBox(t, { specSource: QUESTION_SPEC });
  const line = (id) => readFileSync(join(box.root, box.specName), 'utf8').split('\n').find((text) => text.startsWith(`- ${id} `));
  assert.equal(box.run('answer', 'B1', 'Postgres').status, 0);
  assert.equal(box.run('answer', 'B2', 'Redis on the host').status, 0);
  const agent = runIn(box, box.root, ['spec', 'approve', 'B1', '--json'], { ...box.env, CLAUDECODE: '1' });
  assert.equal(JSON.parse(agent.stdout).error.code, 'B26_PERSON_CHANNEL', 'an agent still cannot approve an answered row');
  const approved = box.run('approve', 'B1', 'B2', 'B3');
  assert.equal(approved.status, 0, approved.stdout + approved.stderr);
  const shown = box.run('show', 'B1').stdout;
  const applied = box.run('apply');
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  assert.equal(line('B1'), '- B1 [approved, must] Which store holds the data: Postgres. Choices: SQLite, Postgres. | gate: review',
    'apply writes the answered choice');
  assert.doesNotMatch(line('B1'), /data: SQLite\./u, 'the original default is gone');
  assert.equal(line('B2'), '- B2 [approved, must] Which store holds the cache: Redis on the host. Choices: SQLite, Postgres, Redis on the host. | gate: review');
  assert.equal(line('B3'), '- B3 [approved, must] Which store holds the logs: SQLite. Choices: SQLite, Postgres. | gate: review');
  assert.match(shown, /answered Postgres, pending apply/u, 'spec show still names the pending answer');
  assert.match(approved.stdout, /^B1: approved with the answer Postgres, pending apply$/mu, 'the approve names the answer it keeps');
  assert.match(approved.stdout, /^B2: approved with the answer Redis on the host, pending apply$/mu);
  assert.match(approved.stdout, /^B3: approved, pending apply$/mu, 'a row with no answer approves as it reads');
});

test('approve --text names the answer it replaces [S1,E3]', (t) => {
  const box = specBox(t, { specSource: QUESTION_SPEC });
  const line = (id) => readFileSync(join(box.root, box.specName), 'utf8').split('\n').find((text) => text.startsWith(`- ${id} `));
  assert.equal(box.run('answer', 'B1', 'Postgres').status, 0);
  assert.equal(box.run('answer', 'B2', 'Postgres').status, 0);
  const choice = box.run('approve', 'B1', '--text', 'Which store holds the data: SQLite. Choices: SQLite, Postgres.');
  assert.equal(choice.status, 0, choice.stdout + choice.stderr);
  assert.match(choice.stdout, /^B1: this text replaces the pending answer Postgres with the answer SQLite$/mu, 'both answers are named');
  const free = box.run('approve', 'B2', '--text', 'The cache lives in memory.');
  assert.equal(free.status, 0, free.stdout + free.stderr);
  assert.match(free.stdout, /^B2: this text replaces the pending answer Postgres with "The cache lives in memory\."$/mu, 'a text that is no answer is named whole');
  assert.equal(box.run('answer', 'B3', 'Postgres').status, 0);
  const same = box.run('approve', 'B3', '--text', 'Which store holds the logs: Postgres. Choices: SQLite, Postgres.');
  assert.doesNotMatch(same.stdout, /replaces/u, 'the same text as the answer replaces nothing');
  assert.equal(box.run('apply').status, 0);
  assert.equal(line('B1'), '- B1 [approved, must] Which store holds the data: SQLite. Choices: SQLite, Postgres. | gate: review', 'the --text wins');
  assert.equal(line('B2'), '- B2 [approved, must] The cache lives in memory. | gate: review');
});

test('an agent cannot answer a pending row [P6,B26,E3]', (t) => {
  const box = specBox(t, { specSource: QUESTION_SPEC });
  const file = join(box.root, box.specName);
  const before = readFileSync(file, 'utf8');
  const decisions = boardRowDecisions(box);
  const spoofs = { PULLBOARD_PERSON: '1', PULLBOARD_AS: 'person', PULLBOARD_AGENT: 'person', PULLBOARD_CHANNEL: 'view',
    PULLBOARD_PERSON_CHANNEL: 'view', PULLBOARD_VIEW_FOREGROUND: '1', USER: 'person', LOGNAME: 'person' };
  const shells = [...AGENT_SHELL_MARKERS.map((marker) => ({ [marker]: 'agent-fixture', ...spoofs })),
    { CLAUDECODE: '1' }, { SSH_CONNECTION: '10.0.0.1 22 10.0.0.2 22', ...spoofs }, { SSH_TTY: '/dev/ttys009' }];
  for (const shell of shells) {
    const name = Object.keys(shell).join('+');
    const refused = runIn(box, box.root, ['spec', 'answer', 'B1', 'Postgres', '--json'], { ...box.env, ...shell });
    assert.equal(refused.status, 1, `${name}: ${refused.stdout}${refused.stderr}`);
    const error = JSON.parse(refused.stdout).error;
    assert.equal(error.code, 'B26_PERSON_CHANNEL', name);
    assert.match(error.message, /the person/u, `${name}: the refusal names the person`);
    assert.match(error.next, /pullboard view/u, name);
    assert.notEqual(error.next, RECORDED_GENERIC_NEXT, name);
  }
  const flagged = runIn(box, box.root, ['spec', 'answer', 'B1', 'Postgres', '--as', 'person', '--json'], { ...box.env, CLAUDECODE: '1' });
  assert.equal(flagged.status, 1);
  assert.equal(JSON.parse(flagged.stdout).error.code, 'B26_PERSON_CHANNEL', 'no flag makes an agent the person: --as person is refused first');

  const api = viewMove(box, { verb: 'spec-answer', args: { row: 'B1', answer: 'Postgres' } }, 'api', box.env);
  assert.equal(api.status, 409, JSON.stringify(api));
  assert.equal(api.body.error.code, 'B26_PERSON_CHANNEL', 'the agent API is not the person channel');

  const made = box.command('worktree', 'review');
  assert.equal(made.status, 0, made.stdout + made.stderr);
  const worktree = /^made (.+) on branch/mu.exec(made.stdout)[1];
  const agent = runIn(box, worktree, ['spec', 'answer', 'B1', 'Postgres', '--json']);
  assert.equal(agent.status, 1, agent.stdout + agent.stderr);
  const agentError = JSON.parse(agent.stdout).error;
  assert.equal(agentError.code, 'B26_PERSON_APPROVAL', 'an agent worktree is refused even from a clean terminal');
  assert.match(agentError.message, /only the person answers/u);
  assert.match(agentError.next, /pullboard shout coordinator.*--decision/u);
  assert.doesNotMatch(agentError.next, /ask the person|pullboard view/u);
  assert.equal(readFileSync(file, 'utf8'), before, 'refused answers leave the spec bytes alone');
  assert.equal(boardRowDecisions(box), decisions, 'refused answers record no row decision');

  writeFileSync(file, before
    .replace('[pending, must] Which store holds the data: SQLite.', '[approved, must] Which store holds the data: Postgres.')
    .replace('holds the cache: SQLite.', 'holds the cache: Postgres.'));
  const handEdited = box.run('check');
  assert.equal(handEdited.status, 1, handEdited.stdout + handEdited.stderr);
  assert.match(handEdited.stdout, /B1 error: pending question answered by hand; ask the person to run pullboard spec answer B1/u,
    'a hand edit that approves the question is flagged');
  assert.match(handEdited.stdout, /B2 error: pending question answered by hand; ask the person to run pullboard spec answer B2/u,
    'a hand edit that changes the answer of a still-pending question is flagged');
  assert.doesNotMatch(handEdited.stdout, /B3 error|B4 error/u, 'untouched questions stay quiet');
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

test('signoff prints cited tests, preserves its note and escapes that note in the spec view [S14, S15]', (t) => {
  const box = specBox(t);
  mkdirSync(join(box.root, 'test'));
  writeFileSync(join(box.root, 'test/greeting.test.js'), "import { test } from 'node:test';\ntest('greeting [G1]', () => {});\n");
  box.git('add', 'test/greeting.test.js');
  box.git('commit', '-q', '-m', 'test: cite the greeting');
  const note = 'checked <img> & empty names\nwith the local greeting test';
  const signed = box.run('signoff', 'G1', '--by', 'CO', '--note', note);
  assert.equal(signed.status, 0, signed.stderr);
  assert.match(signed.stdout, /evidence for G1:\n  cited by tests \(none run by pullboard\):\n    test\/greeting.test.js/);
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
  writeFileSync(join(box.root, 'test/greeting.test.js'), "import { test } from 'node:test';\ntest('greeting [G1]', () => {});\n");
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

test('spec view emits JSON and refuses an unsupported flag before writing [S13, P4]', (t) => {
  const box = specBox(t);
  const htmlFile = join(box.root, 'requested-spec.html');
  const result = box.run('view', '--json', '--out', htmlFile);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const document = JSON.parse(result.stdout);
  assert.equal(document.version, 1);
  assert.equal(document.path, htmlFile);
  assert.ok(existsSync(htmlFile));

  const refusedFile = join(box.root, 'refused-spec.html');
  const refused = box.run('view', '--json', '--must', '--out', refusedFile);
  assert.equal(refused.status, 1);
  assert.equal(refused.stderr, '');
  const refusal = JSON.parse(refused.stdout);
  assert.equal(refusal.version, 1);
  assert.equal(refusal.error.code, 'FLAG_NOT_ALLOWED');
  assert.match(refusal.error.message, /spec view does not take --must/);
  assert.equal(existsSync(refusedFile), false, 'refusal happens before creating the HTML output');
});

test('spec unmet and signoff do not create a board when reading a repo without one [S14, P4]', (t) => {
  const box = specBox(t);
  const boardDir = join(box.root, '.git', 'pullboard');
  rmSync(boardDir, { recursive: true, force: true });
  const boardFile = join(boardDir, 'board.sqlite');
  assert.equal(existsSync(boardFile), false);

  const unmet = box.run('unmet');
  assert.equal(unmet.status, 0, unmet.stderr);
  assert.equal(existsSync(boardFile), false, 'only the run trace may appear beside a missing board (faad62a688)');

  const signoff = box.run('signoff', 'G1', '--by', 'CO');
  assert.equal(signoff.status, 1);
  assert.match(signoff.stderr, /NO_EVIDENCE/);
  assert.equal(existsSync(boardFile), false, 'only the run trace may appear beside a missing board (faad62a688)');
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
  // A submit with no change against the claim head is refused (EMPTY_SUBMIT), so the claim gets a commit.
  writeFileSync(join(box.root, 'greeting.txt'), 'hello\n');
  box.git('add', 'greeting.txt'); box.git('commit', '-q', '-m', 'chore: add the greeting [G1]');
  const submitted = box.command('submit', '1', '--wait', '--no-next');
  assert.equal(submitted.status, 0, submitted.stderr);
  assert.match(box.run('unmet').stdout, /G1 \[must\].*— awaiting a verdict/);
  const made = box.command('worktree', 'review');
  assert.equal(made.status, 0, made.stderr);
  const review = /^made (.+) on branch/m.exec(made.stdout)[1];
  const acceptedNote = 'checked greeting in the private fixture\nsecond line stays in the receipt';
  const accepted = spawnSync(process.execPath, [resolve(import.meta.dirname, '../../pullboard.js'), 'verify', '1', 'accept', '--note', acceptedNote], { cwd: review, env: box.env, encoding: 'utf8' });
  assert.equal(accepted.status, 0, `${accepted.stdout}${accepted.stderr}`);
  assert.match(box.run('unmet').stdout, /G1 \[must\].*— verified and ready to sign/);
  assert.equal(JSON.parse(box.run('unmet', '--json').stdout).rows.find(row => row.id === 'G1').stage, 'verified and ready to sign');
  const signed = box.run('signoff', 'G1', '--by', 'CO', '--note', 'checked the accepting verdict');
  assert.equal(signed.status, 0, signed.stderr);
  assert.match(signed.stdout, /verified #1: checked greeting in the private fixture/);
  assert.doesNotMatch(signed.stdout, /second line stays in the receipt/);
  assert.doesNotMatch(box.run('unmet').stdout, /G1 \[must\]/);
  writeFileSync(join(box.root, box.specName), SPEC.replace('Same file twice is a no-op.', 'Same file twice stays a no-op.'));
  assert.match(box.run('unmet').stdout, /G1 \[must\].*— stale/);
  assert.match(box.run('show', 'G1').stdout, /checked the accepting verdict/);
});

test('a failing never-run test citation is not verified, and signoff says no tests were run [S15,S16]', (t) => {
  const specSource = SPEC.replace('## K · Constraints', '- G3 [approved, must] A ghost test is only a citation. | gate: true\n\n## K · Constraints');
  const box = specBox(t, { specSource });
  mkdirSync(join(box.root, 'test'));
  writeFileSync(join(box.root, 'test/ghost.test.js'), '// [G3]\nimport { writeFileSync } from "node:fs";\nwriteFileSync(new URL("./ghost-ran", import.meta.url), "ran");\nthrow new Error("this ghost test fails if run");\n');
  box.git('add', 'test/ghost.test.js');
  box.git('commit', '-q', '-m', 'test: cite a never-run ghost');
  const unmet = box.run('unmet');
  assert.equal(unmet.status, 0, unmet.stderr);
  assert.match(unmet.stdout, /G3 \[must\].*— cited by tests, not verified/);
  const json = box.run('unmet', '--json');
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).rows.find(row => row.id === 'G3').stage, 'cited by tests, not verified');
  assert.equal(existsSync(join(box.root, 'test/ghost-ran')), false, 'the citation scan never executes the failing test');
  const signed = box.run('signoff', 'G3', '--by', 'CO', '--note', 'the fixture person read the unverified citation');
  assert.equal(signed.status, 0, signed.stderr);
  assert.match(signed.stdout, /cited by tests \(none run by pullboard\):\n    test\/ghost.test.js/);
  assert.doesNotMatch(signed.stdout, /verified #/);
  assert.equal(existsSync(join(box.root, 'test/ghost-ran')), false, 'signoff does not execute the test either');
  assert.ok(readSignoffs(box.root).some(row => row.id === 'G3'), 'S15 still permits the fixture person to sign');
});

const SETUP_SPEC = `# Spec

## A · Setup
- A1 [draft, must] Every page works at phone width. | gate: review
- A2 [pending, must] It deploys to: Vercel. Choices: Vercel, Netlify. | gate: review
`;

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

/** Refuse a spec answer in an agent shell, then paste the returned command as the person would. */
function answerCommandCase(t, separateGitDir) {
  const box = specBox(t, { specSource: QUESTION_SPEC, separateGitDir });
  const before = readFileSync(join(box.root, box.specName), 'utf8');
  const refused = runIn(box, box.root, ['spec', 'answer', 'B2', "Redis on the host's port", '--json'], { ...box.env, CLAUDECODE: '1' });
  assert.notEqual(refused.status, 0, 'an agent shell never records a person answer');
  const error = JSON.parse(refused.stdout).error;
  assert.equal(error.code, 'B26_PERSON_CHANNEL');
  assert.match(error.message, /relay the command below to the person verbatim/u);
  const pasted = error.next.slice(error.next.lastIndexOf(': cd ') + 2);
  assert.equal(pasted, `cd ${box.root} && pullboard spec answer B2 'Redis on the host'\\''s port'`, 'the id and the proposed choice, quoted, with no placeholder');
  assert.equal(readFileSync(join(box.root, box.specName), 'utf8'), before);
  // The person pastes it into their own terminal and it is recorded.
  const person = runFixtureChild('/bin/sh', ['-c', pasted.replace(/^cd \S+ && pullboard/u, `cd '${box.root}' && "${process.execPath}" "${resolve(import.meta.dirname, '../../pullboard.js')}"`) + ' --json'], { cwd: box.root, env: box.env, encoding: 'utf8' });
  assert.equal(person.status, 0, person.stdout + person.stderr);
  assert.equal(JSON.parse(person.stdout).decisions[0].answer, "Redis on the host's port");
}

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
  for (const gate of ['./test/proof.test.js', 'test/x/../proof.test.js']) {
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


test('a verdict on a spec row is recorded by an outside verifier [S1,V4,H16]', t => {
  const line = '- G1 [draft, must] Keep the original row. | gate: review';
  const reason = 'The stated behavior is supported by the cited proof.';
  const formatted = `${line} | verify: accepted by review-2 | ${reason}`;
  const parsed = parseSpec(`## G · Goals\n${formatted}\n`);
  assert.deepEqual(parsed.rows[0].verify, { decision: 'accepted', by: 'review-2', reason },
    'the row grammar preserves a structured verifier verdict');
  assert.deepEqual(lintSpec(parsed), []);
  const box = specBox(t, { specSource: '# Demo\n\n## G · Goals\n' });
  const board = openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  t.after(() => store.closeBoard(board));
  const author = store.register(board, { lane: 'core', path: join(box.root, 'author'), parentDigest: 'a'.repeat(64) });
  const sibling = store.register(board, { lane: 'review', path: join(box.root, 'sibling'), parentDigest: 'a'.repeat(64) });
  const verifier = store.register(board, { lane: 'review', path: join(box.root, 'outside'), parentDigest: 'b'.repeat(64) });
  draftSpecRow(board, { agentId: author, row: { id: 'G1', text: 'Keep the original row.',
    gate: 'review', tier: 'must', section: 'G · Goals', target: 'spec' } });
  assert.equal(box.run('apply').status, 0);
  const source = readFileSync(join(box.root, box.specName), 'utf8').split('\n').find(value => value.startsWith('- G1 '));
  const before = store.events(board).length;
  for (const agentId of [author, sibling]) assert.throws(() => recordRowVerification(board,
    { agentId, source, decision: 'accepted', reason }), { code: 'ROW_VERIFY_SELF' });
  assert.equal(store.events(board).length, before, 'refused self and sibling verdicts leave the board unchanged');
  recordRowVerification(board, { agentId: verifier, source, decision: 'accepted', reason });
  assert.equal(box.run('apply').status, 0);
  const check = box.run('check');
  assert.equal(check.status, 0, check.stdout + check.stderr);
  const shown = box.run('show', 'G1');
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, new RegExp(`verify: accepted by ${verifier}`));
  assert.ok(shown.stdout.includes(reason));
  const json = JSON.parse(box.run('show', 'G1', '--json').stdout);
  assert.deepEqual(json.row.verify, { decision: 'accepted', by: verifier, reason });
  assert.equal(json.row.status, 'draft', 'a verifier verdict does not approve normative text');
  recordRowVerification(board, { agentId: verifier, source, decision: 'rejected', reason: 'A counterexample remains.' });
  assert.equal(box.run('apply').status, 0);
  assert.match(box.run('show', 'G1').stdout, /verify: rejected by/u);
  const valid = readFileSync(join(box.root, box.specName), 'utf8');
  writeFileSync(join(box.root, box.specName), valid.replace('A counterexample remains.', 'A forged reason.'));
  const forged = box.run('check');
  assert.equal(forged.status, 1);
  assert.match(forged.stdout, /ROW_VERIFY_RECEIPT/u);
  writeFileSync(join(box.root, box.specName), valid);
  for (const changed of [source.replace('G1', 'G99'), source.replace('original row', 'different row')]) {
    assert.throws(() => recordRowVerification(board, { agentId: verifier, source: changed, decision: 'accepted', reason }),
      { code: 'ROW_VERIFY_PROVENANCE' });
  }
  const unknown = store.register(board, { lane: 'review', path: join(box.root, 'unknown') });
  assert.throws(() => recordRowVerification(board, { agentId: unknown, source, decision: 'accepted', reason }),
    { code: 'ROW_VERIFY_PROVENANCE' });
  writeFileSync(join(box.root, box.specName), valid.replace(/\n/gu, '\r\n'));
  recordRowVerification(board, { agentId: verifier, source, decision: 'accepted', reason });
  assert.equal(box.run('apply').status, 0);
  const windowsSource = readFileSync(join(box.root, box.specName), 'utf8');
  assert.ok(!/(?<!\r)\n/u.test(windowsSource), 'applying a new verdict preserves CRLF source endings');
  assert.equal(box.run('check').status, 0);
});


test('verifier fields reject duplicate and malformed annotations without swallowing check pipelines [S1,V4]', () => {
  const base = '- G1 [draft, must] A row. | gate: check printf yes | grep yes | count: 0';
  assert.equal(parseSpec(`## G\n${base}\n`).rows[0].gate, 'check printf yes | grep yes');
  const valid = parseSpec(`## G\n${base} | verify: rejected by tests-2 | Missing evidence.\n`);
  assert.equal(valid.rows[0].gate, 'check printf yes | grep yes');
  assert.deepEqual(lintSpec(valid), []);
  for (const suffix of ['verify: maybe by tests-2 | Why.', 'verify: accepted by tests-2',
    'verify: rejected by tests-2 | ', 'verify: accepted by tests-2 | Why. | verify: rejected by tests-3 | Why.']) {
    assert.ok(lintSpec(parseSpec(`## G\n${base} | ${suffix}\n`)).some(finding => finding.level === 'error'), suffix);
  }
});


test('spec verify binds the real caller and preserves a pending person decision [S1,V4,P6]', t => {
  const box = specBox(t, { specSource: '# Demo\n\n## G · Goals\n' });
  const board = openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  t.after(() => store.closeBoard(board));
  store.register(board, { lane: 'coordinator', path: box.root, parentDigest: 'c'.repeat(64) });
  const author = store.register(board, { lane: 'core', path: join(box.root, 'author'), parentDigest: 'a'.repeat(64) });
  draftSpecRow(board, { agentId: author, row: { id: 'G1', text: 'Keep the actual requirement.',
    gate: 'review', tier: 'must', section: 'G · Goals' } });
  assert.equal(box.run('apply').status, 0);
  const original = readFileSync(join(box.root, box.specName), 'utf8');
  const result = box.run('verify', 'G1', 'accepted', '--reason', 'The exact draft was reviewed.', '--json');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const record = JSON.parse(result.stdout).verification;
  assert.equal(record.by, 'coordinator', 'the actual joined caller is the verifier; the CLI takes no claimed seat');
  assert.equal(readFileSync(join(box.root, box.specName), 'utf8'), original, 'recording a verdict changes no spec file');
  assert.equal(box.run('approve', 'G1').status, 0);
  const pending = box.run('verify', 'G1', 'rejected', '--reason', 'A newer opinion.');
  assert.equal(pending.status, 1);
  assert.match(pending.stderr, /ROW_VERIFY_PENDING/u);
  assert.equal(store.rowVerifications(board)[0].decision, 'accepted', 'the pending signed source cannot be superseded');
  assert.equal(readFileSync(join(box.root, box.specName), 'utf8'), original);
  assert.equal(box.run('apply').status, 0);
  const applied = readFileSync(join(box.root, box.specName), 'utf8');
  assert.match(applied, /G1 \[approved, must\]/u);
  assert.ok(!applied.includes('verify:'), 'the stale draft verdict does not overwrite the person-approved replacement');
  assert.equal(box.run('check').status, 0);
});


test('row verifier reads need an exact receipt and never create a missing board [S1,V4]', t => {
  const box = specBox(t, { specSource: '# Demo\n\n## G · Goals\n- G1 [draft] A row. | verify: accepted by review-2 | A claimed reason.\n' });
  const file = join(box.root, '.git', 'pullboard', 'board.sqlite');
  rmSync(file, { force: true });
  for (const suffix of ['-shm', '-wal']) rmSync(file + suffix, { force: true });
  const checked = box.run('check');
  assert.equal(checked.status, 1);
  assert.match(checked.stdout, /ROW_VERIFY_RECEIPT/u);
  assert.equal(existsSync(file), false, 'checking a forged field initializes no board');
  const shown = box.run('show', 'G1');
  assert.equal(shown.status, 1);
  assert.match(shown.stderr, /ROW_VERIFY_RECEIPT/u);
  assert.equal(existsSync(file), false, 'show refuses the unproved field before opening a writer');
});

test('an exact row verifier receipt replays once with its engine floor and native snapshot [S1,V4,H16]', t => {
  const root = '/fixture/spec-verdict';
  const board = fixtureBoard(t);
  const replica = fixtureBoard(t);
  const author = store.register(board, { lane: 'core', path: join(root, 'author'), parentDigest: 'a'.repeat(64) });
  const verifier = store.register(board, { lane: 'review', path: join(root, 'verifier'), parentDigest: 'b'.repeat(64) });
  draftSpecRow(board, { agentId: author, row: { id: 'G1', text: 'An exact requirement.',
    gate: 'review', tier: 'must', section: 'G · Goals' } });
  const move = prepareEngineMove(board, 'recordRowVerification', [{ agentId: verifier,
    source: '- G1 [draft, must] An exact requirement. | gate: review', decision: 'accepted', reason: 'Reviewed exactly.' }]);
  assert.equal(move.engine, ENGINE_VERSION, 'the native writer stamps its current version');
  assert.equal(minimumMoveEngine(move.operation, move.args, board), SPEC_VERDICT_ENGINE, 'the historical reader floor remains fixed');
  const options = { sequence: 1, at: new Date().toISOString() };
  const before = store.events(board).length;
  assert.throws(() => applyEngineMove(board, { ...move, engine: SPEC_VERDICT_ENGINE - 1 }, options), { code: 'RELAY_MOVE' });
  assert.equal(store.events(board).length, before, 'an older engine records no verdict');
  const result = applyEngineMove(board, move, options);
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.equal(store.rowVerifications(board)[0].by, verifier);
  const count = store.events(board).length;
  assert.deepEqual(applyEngineMove(board, move, options), result);
  assert.equal(store.events(board).length, count, 'same-position retry adds no receipt or event');
  importBoard(replica, exportBoard(board));
  assert.deepEqual(store.rowVerifications(replica), store.rowVerifications(board), 'native restore retains the verdict and parent-bearing source board');
});
