/** Coordinator flow alerts reuse the real Git/SQLite statistics and documented thresholds [N32,R1,R2]. */
import { submitFixture } from './board-submit-fixture.js';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { main } from '../src/cli.js';
import { spawn } from 'node:child_process';
import { AGENT_SHELL_MARKERS, SSH_SHELL_MARKERS } from '../src/person.js';
import { RESUME_HOOK } from '../src/init.js';
import { proofStats } from '../src/stats.js';
import { runFixtureChild, runFixtureGit } from './fixture-child.js';
import { takeDefaultViewPort } from './view-port-fixture.js';

const PRIVATE_CHANGELOG = `# Changelog\n\n## [0.8.7] - 2026-10-12\n\n### A new session\n\nThe latest headline paragraph.\n\n### Added\n\n- The detailed release list is not part of the resume.\n\n## [0.8.6] - 2026-10-11\n\n### See the flow\n\nThe middle headline paragraph.\n\n### Fixed\n\n- A detailed fix.\n\n## [0.8.5] - 2026-10-10\n\n### A prettier board\n\nThe previous release.\n`;
const LONG_CHANGELOG = `# Changelog\n\n## [0.8.9] - 2026-10-14\n\n### Nine\n\nNine paragraph.\n\n## [0.8.8] - 2026-10-13\n\n### Eight\n\nEight paragraph.\n\n## [0.8.7] - 2026-10-12\n\n### Seven\n\nSeven paragraph.\n\n## [0.8.6] - 2026-10-11\n\n### Six\n\nSix paragraph.\n\n## [0.8.5] - 2026-10-10\n\n### Five\n\nFive paragraph.\n\n## [0.8.4] - 2026-10-09\n\n### Added\n\nThis category heading is not a release headline.\n`;

/** Build an isolated copy of the production CLI at a chosen release version. */
function releaseFixture(t, { previous = null, version = '0.8.7', changelog = PRIVATE_CHANGELOG, freshSetup = false, historyBeforeInit = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-resume-release-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = join(root, 'cli');
  const repo = join(root, 'repo');
  mkdirSync(cli);
  mkdirSync(repo);
  if (!freshSetup) writeFileSync(join(repo, 'SPEC.md'), '# Release fixture\n\n## N · Resume\n- N19 [approved, must] Resume announces released headlines once per checkout. | gate: review\n');
  cpSync(join(import.meta.dirname, '../src'), join(cli, 'src'), { recursive: true });
  cpSync(join(import.meta.dirname, '../bin'), join(cli, 'bin'), { recursive: true });
  cpSync(join(import.meta.dirname, '../skills'), join(cli, 'skills'), { recursive: true });
  symlinkSync(join(cli, 'bin/pullboard.js'), join(cli, 'bin/pullboard'));
  const packageData = JSON.parse(readFileSync(join(import.meta.dirname, '../package.json'), 'utf8'));
  writeFileSync(join(cli, 'package.json'), JSON.stringify({ ...packageData, version }));
  writeFileSync(join(cli, 'CHANGELOG.md'), changelog);
  const env = { ...process.env, PATH: `${join(cli, 'bin')}:${process.env.PATH}`, PULLBOARD_HOME: join(root, 'home'), PULLBOARD_MACHINE_HOME: join(root, 'machine-home'),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com' };
  delete env.PULLBOARD_RELAY_TOKEN;
  for (const name of [...AGENT_SHELL_MARKERS, ...SSH_SHELL_MARKERS]) delete env[name];
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: repo, env });
  if (historyBeforeInit) {
    writeFileSync(join(repo, 'README.md'), '# Existing repository\n');
    runFixtureGit(['add', 'README.md'], { cwd: repo, env });
    runFixtureGit(['commit', '-q', '-m', 'chore: create existing repository'], { cwd: repo, env });
  }
  /** Run the copied production CLI in the selected real checkout. */
  const run = (cwd, ...args) => runFixtureChild(process.execPath, [join(cli, 'bin/pullboard.js'), ...args], { cwd, env, encoding: 'utf8' });
  /** Run Git with this fixture's private identity and configuration. */
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env });
  const initialized = run(repo, 'init');
  assert.equal(initialized.status, 0, initialized.failure || initialized.stderr || initialized.stdout);
  if (previous) {
    const record = join(repo, '.git', 'pullboard-checkout', 'resume-version');
    mkdirSync(join(repo, '.git', 'pullboard-checkout'), { recursive: true });
    writeFileSync(record, `${previous}\n`);
  }
  return { root, repo, run, git, env };
}

/** Prove an older agent worktree gets the exact commit-first instruction from its main checkout. */
test('a worktree names its main checkout\'s uncommitted init files [I1,I2]', (t) => {
  const box = releaseFixture(t, { freshSetup: true, historyBeforeInit: true });
  const oldHead = box.git(box.repo, 'rev-parse', 'HEAD');
  const worktree = join(box.root, 'old-agent-worktree');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', worktree, oldHead);

  const fromWorktree = box.run(worktree, 'status');
  assert.equal(fromWorktree.status, 1, fromWorktree.failure || fromWorktree.stderr || fromWorktree.stdout);
  assert.match(fromWorktree.stderr, /main checkout has uncommitted Pullboard setup files/u);
  assert.ok(fromWorktree.stderr.includes(`cd ${box.repo} && git add`), fromWorktree.stderr);
  for (const path of ['pullboard.json', 'SPEC.md', 'DOCTRINE.md']) assert.ok(fromWorktree.stderr.includes(path), fromWorktree.stderr);
  assert.doesNotMatch(fromWorktree.stderr, /worktree <lane>/u);

  const fromMain = box.run(box.repo, 'resume', '--diagnostics');
  assert.equal(fromMain.status, 0, fromMain.failure || fromMain.stderr || fromMain.stdout);
  assert.match(fromMain.stdout, /The person must commit Pullboard's setup files before agents can use worktrees/u);
  assert.ok(fromMain.stdout.includes(`cd ${box.repo} && git add`), fromMain.stdout);
  for (const path of ['pullboard.json', 'SPEC.md', 'DOCTRINE.md']) assert.ok(fromMain.stdout.includes(path), fromMain.stdout);
});

/**
 * Prove the coordinator's resume names a person's row decision that awaits `pullboard spec apply`,
 * and puts the apply ahead of every other step [N19]. The local view records the decision silently,
 * so a coordinator that reads only `needs the person` sees an approved row as still pending.
 */
test('resume names row decisions awaiting spec apply [N19]', t => {
  const APPLY_LINE = "The coordinator must apply the person's recorded row decision: ";
  const box = releaseFixture(t, { freshSetup: true, historyBeforeInit: true });
  const drafted = box.run(box.repo, 'spec', 'draft', 'The person can name the project.');
  assert.equal(drafted.status, 0, drafted.failure || drafted.stderr || drafted.stdout);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: set up pullboard');
  const approved = box.run(box.repo, 'spec', 'approve', 'G1');
  assert.equal(approved.status, 0, approved.failure || approved.stderr || approved.stdout);
  /** Resume's text and JSON from the main checkout, without diagnostics: the session-start form. */
  const resume = () => {
    const text = box.run(box.repo, 'resume');
    assert.equal(text.status, 0, text.failure || text.stderr || text.stdout);
    const json = box.run(box.repo, 'resume', '--json');
    assert.equal(json.status, 0, json.failure || json.stderr || json.stdout);
    return { lines: text.stdout.split('\n'), card: JSON.parse(json.stdout) };
  };
  const before = resume();
  assert.deepEqual(before.card.pendingApply, [{ id: 'G1', kind: 'spec', decision: 'approve' }], JSON.stringify(before.card.pendingApply ?? null));
  assert.ok(before.lines.includes(`${APPLY_LINE}G1 approved, pending apply: cd ${box.repo} && pullboard spec apply`), before.lines.join('\n'));
  assert.match(before.card.next, /^apply the person's recorded row decisions first: cd .+ && pullboard spec apply \(G1 approved\); then /u);
  const applied = box.run(box.repo, 'spec', 'apply');
  assert.equal(applied.status, 0, applied.failure || applied.stderr || applied.stdout);
  const after = resume();
  assert.deepEqual(after.card.pendingApply, [], 'an applied decision is no longer pending');
  assert.equal(after.lines.some((line) => line.startsWith(APPLY_LINE)), false, after.lines.join('\n'));
  assert.doesNotMatch(after.card.next, /^apply the person's recorded row decisions first/u);
});

/**
 * Prove resume gives each uncommitted file its right owner: the row file `spec apply` changed goes
 * to the coordinator, the setup files init wrote go to the person, and nothing else is named [I1,L3].
 * The blueprint trial found resume blaming the person for the coordinator's own applied SPEC.md
 * and handing them a commit of every setup file.
 */
test('resume asks the coordinator to commit an applied row file [I1,L3]', t => {
  const PERSON_LINE = "The person must commit Pullboard's setup files before agents can use worktrees: ";
  const ROW_LINE = 'The coordinator must commit the row file spec apply changed: ';
  /** Resume's text and JSON from the main checkout, both passing, and neither naming an unrelated dirty file. */
  const resume = (box) => {
    const text = box.run(box.repo, 'resume', '--diagnostics');
    assert.equal(text.status, 0, text.failure || text.stderr || text.stdout);
    const json = box.run(box.repo, 'resume', '--diagnostics', '--json');
    assert.equal(json.status, 0, json.failure || json.stderr || json.stdout);
    const lines = text.stdout.split('\n');
    const card = JSON.parse(json.stdout);
    for (const named of [...lines.filter((line) => line.startsWith(PERSON_LINE) || line.startsWith(ROW_LINE)), JSON.stringify(card.commits ?? null)]) {
      assert.doesNotMatch(named, /README\.md|notes\.txt/u, `an unrelated dirty file is never named: ${named}`);
    }
    return { lines, card };
  };
  /** The exact commands resume should print for one owner's files. */
  const add = (box, files) => `cd ${box.repo} && git add -- ${files.join(' ')}`;
  const commit = (box, files) => `${add(box, files)} && git commit -q -m "docs(spec): apply row decisions" -- ${files.join(' ')}`;
  /** A board whose init files are committed, with a drafted row the person approved and the coordinator applied. */
  const applied = () => {
    const box = releaseFixture(t, { freshSetup: true, historyBeforeInit: true });
    const drafted = box.run(box.repo, 'spec', 'draft', 'The person can name the project.');
    assert.equal(drafted.status, 0, drafted.failure || drafted.stderr || drafted.stdout);
    box.git(box.repo, 'add', '-A');
    box.git(box.repo, 'commit', '-q', '-m', 'chore: set up pullboard');
    for (const args of [['spec', 'approve', 'G1'], ['spec', 'apply']]) {
      const ran = box.run(box.repo, ...args);
      assert.equal(ran.status, 0, ran.failure || ran.stderr || ran.stdout);
    }
    writeFileSync(join(box.repo, 'README.md'), '# Existing repository\n\nAn unrelated edit.\n');
    writeFileSync(join(box.repo, 'notes.txt'), 'an unrelated new file\n');
    return box;
  };

  // Committed setup plus an applied SPEC.md: the coordinator commits it; the person is not asked.
  const clean = applied();
  const after = resume(clean);
  assert.ok(after.lines.includes(`${ROW_LINE}${commit(clean, ['SPEC.md'])}`), after.lines.join('\n'));
  assert.equal(after.lines.some((line) => line.startsWith(PERSON_LINE)), false, `the person commits nothing:\n${after.lines.join('\n')}`);
  assert.match(after.card.next, /^commit the applied row file first: cd .+ && git add -- SPEC\.md && git commit .+; then /u);
  assert.deepEqual(after.card.commits, { coordinator: { files: ['SPEC.md'], command: commit(clean, ['SPEC.md']) }, person: null });
  const committed = runFixtureChild('sh', ['-c', after.card.commits.coordinator.command], { cwd: clean.repo, env: clean.env, encoding: 'utf8' });
  assert.equal(committed.status, 0, committed.failure || committed.stderr || committed.stdout);
  assert.deepEqual(resume(clean).card.commits, { coordinator: null, person: null }, 'the command resume names commits the row file, and only it');

  // Uncommitted setup files: the person commits exactly those, and the coordinator is not asked.
  const fresh = releaseFixture(t, { freshSetup: true, historyBeforeInit: true });
  writeFileSync(join(fresh.repo, 'notes.txt'), 'an unrelated new file\n');
  const setup = resume(fresh);
  const initFiles = ['.githooks/commit-msg', '.githooks/pre-commit', '.githooks/pre-merge-commit', '.githooks/pre-push', 'AGENTS.md', 'DOCTRINE.md', 'SPEC.md', 'pullboard.json'];
  assert.ok(setup.lines.includes(`${PERSON_LINE}${add(fresh, initFiles)}`), setup.lines.join('\n'));
  assert.equal(setup.lines.some((line) => line.startsWith(ROW_LINE)), false, `the coordinator commits nothing:\n${setup.lines.join('\n')}`);
  assert.deepEqual(setup.card.commits, { coordinator: null, person: { files: initFiles, command: add(fresh, initFiles) } });

  // Both at once: each owner gets exactly its own files, and an unrelated dirty file is never setup.
  const mixed = applied();
  const config = JSON.parse(readFileSync(join(mixed.repo, 'pullboard.json'), 'utf8'));
  writeFileSync(join(mixed.repo, 'pullboard.json'), JSON.stringify({ ...config, gate: 'npm test' }, null, 2) + '\n');
  const both = resume(mixed);
  assert.ok(both.lines.includes(`${ROW_LINE}${commit(mixed, ['SPEC.md'])}`), both.lines.join('\n'));
  assert.ok(both.lines.includes(`${PERSON_LINE}${add(mixed, ['pullboard.json'])}`), both.lines.join('\n'));
  assert.deepEqual(both.card.commits, {
    coordinator: { files: ['SPEC.md'], command: commit(mixed, ['SPEC.md']) },
    person: { files: ['pullboard.json'], command: add(mixed, ['pullboard.json']) },
  });

  // A signed apply: the receipt spec apply appended goes in the coordinator's commit with the row.
  const signed = releaseFixture(t, { freshSetup: true, historyBeforeInit: true });
  const keyPath = join(signed.root, 'co-signing-key');
  const keyed = runFixtureChild('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'resume@example.invalid', '-f', keyPath], { encoding: 'utf8' });
  assert.equal(keyed.status, 0, keyed.failure || keyed.stderr);
  signed.git(signed.repo, 'config', 'user.signingkey', keyPath);
  const signer = signed.run(signed.repo, 'spec', 'signers', 'add', '--key', `${keyPath}.pub`, '--by', 'CO');
  assert.equal(signer.status, 0, signer.failure || signer.stderr || signer.stdout);
  writeFileSync(join(signed.repo, 'SPEC.md'), `${readFileSync(join(signed.repo, 'SPEC.md'), 'utf8').trimEnd()}\n\n## G · Goals\n- G1 [draft, must] The person signs this row. | gate: true | signers: CO\n`);
  signed.git(signed.repo, 'add', '-A');
  signed.git(signed.repo, 'add', '-f', '--', ...['.pullboard/signers', '.pullboard/signers.initial', '.pullboard/first-commit'].filter((file) => existsSync(join(signed.repo, file))));
  signed.git(signed.repo, 'commit', '-q', '-m', 'chore: set up pullboard');
  for (const args of [['spec', 'approve', 'G1', '--by', 'CO'], ['spec', 'apply']]) {
    const ran = signed.run(signed.repo, ...args);
    assert.equal(ran.status, 0, ran.failure || ran.stderr || ran.stdout);
  }
  const receipted = resume(signed);
  assert.deepEqual(receipted.card.commits.coordinator?.files, ['SPEC.md', '.pullboard/signoffs.jsonl'], 'the receipt spec apply appended is the coordinator\'s to commit with the row');
  assert.ok(receipted.lines.some((line) => line.startsWith('The coordinator must commit the row file spec apply changed and its sign-off receipt: ')), receipted.lines.join('\n'));
  const landed = runFixtureChild('sh', ['-c', receipted.card.commits.coordinator.command], { cwd: signed.repo, env: signed.env, encoding: 'utf8' });
  assert.equal(landed.status, 0, landed.failure || landed.stderr || landed.stdout);
  assert.equal(signed.git(signed.repo, 'cat-file', '-t', 'HEAD:.pullboard/signoffs.jsonl').trim(), 'blob', 'the printed command commits the receipt, so the next worktree or clone has it');
  assert.deepEqual(resume(signed).card.commits, { coordinator: null, person: null }, 'nothing is left for either owner');
});

test('resume says what is new once after an upgrade [N19]', t => {
  const box = releaseFixture(t, { previous: '0.8.5' });
  const otherCheckout = join(box.root, 'other-checkout');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: initialize resume release fixture [N19]');
  box.git(box.repo, 'worktree', 'add', '-q', '-b', 'other', otherCheckout);
  const lane = Object.keys(JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8')).lanes)[0];
  const joined = box.run(otherCheckout, 'join', lane, '--model', 'Fixture');
  assert.equal(joined.status, 0, joined.failure || joined.stderr || joined.stdout);
  const firstCheckoutRun = box.run(otherCheckout, 'resume');
  assert.equal(firstCheckoutRun.status, 0, firstCheckoutRun.failure || firstCheckoutRun.stderr || firstCheckoutRun.stdout);
  assert.doesNotMatch(firstCheckoutRun.stdout, /new in 0\.8\.[67]|Full release notes/u);
  const first = box.run(box.repo, 'resume');
  assert.equal(first.status, 0, first.failure || first.stderr || first.stdout);
  const text = first.stdout;
  const latest = text.indexOf('new in 0.8.7 — A new session: The latest headline paragraph.');
  const middle = text.indexOf('new in 0.8.6 — See the flow: The middle headline paragraph.');
  assert.ok(latest >= 0 && middle > latest, text);
  const fullNotes = text.indexOf('Full release notes: CHANGELOG.md');
  assert.ok(fullNotes >= 0 && fullNotes < text.indexOf('resume:'), text);
  assert.doesNotMatch(text, /detailed release list|A detailed fix|new in 0\.8\.5/u);
  const second = box.run(box.repo, 'resume');
  assert.equal(second.status, 0, second.failure || second.stderr || second.stdout);
  assert.doesNotMatch(second.stdout, /new in 0\.8\.[67]/u);
});

test('resume --json carries what is new [N19]', t => {
  const box = releaseFixture(t, { previous: '0.8.5' });
  const first = box.run(box.repo, 'resume', '--json');
  assert.equal(first.status, 0, first.failure || first.stderr || first.stdout);
  assert.deepEqual(JSON.parse(first.stdout).whatsNew, {
    releases: [
      { version: '0.8.7', headline: 'A new session', paragraph: 'The latest headline paragraph.' },
      { version: '0.8.6', headline: 'See the flow', paragraph: 'The middle headline paragraph.' },
    ], omitted: 0, notes: 'CHANGELOG.md',
  });
  const second = box.run(box.repo, 'resume', '--json');
  assert.equal(second.status, 0, second.failure || second.stderr || second.stdout);
  assert.equal(JSON.parse(second.stdout).whatsNew, null, 'JSON notes are shown once');
  const text = box.run(box.repo, 'resume');
  assert.equal(text.status, 0, text.failure || text.stderr || text.stdout);
  assert.doesNotMatch(text.stdout, /new in 0\.8\.[67]/u, 'JSON resume records the displayed notes');
  const fresh = releaseFixture(t);
  const quiet = fresh.run(fresh.repo, 'resume', '--json');
  assert.equal(quiet.status, 0, quiet.failure || quiet.stderr || quiet.stdout);
  assert.equal(JSON.parse(quiet.stdout).whatsNew, null, 'first-ever JSON resume stays quiet');
  const long = releaseFixture(t, { previous: '0.8.3', version: '0.8.9', changelog: LONG_CHANGELOG });
  const trimmed = long.run(long.repo, 'resume', '--json');
  assert.equal(trimmed.status, 0, trimmed.failure || trimmed.stderr || trimmed.stdout);
  const notes = JSON.parse(trimmed.stdout).whatsNew;
  assert.deepEqual(notes.releases.map(release => release.version), ['0.8.9', '0.8.8', '0.8.7']);
  assert.equal(notes.omitted, 2);
  assert.equal(notes.notes, 'CHANGELOG.md');
});

test('a first run records the version quietly [N19]', t => {
  const box = releaseFixture(t);
  const result = box.run(box.repo, 'resume');
  assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
  assert.doesNotMatch(result.stdout, /new in 0\.8\.[67]|Full release notes/u);
  assert.equal(readFileSync(join(box.repo, '.git', 'pullboard-checkout', 'resume-version'), 'utf8'), '0.8.7\n');
});

test('resume limits long upgrade notes and skips changelog categories as headlines [N19]', t => {
  const box = releaseFixture(t, { previous: '0.8.3', version: '0.8.9', changelog: LONG_CHANGELOG });
  const result = box.run(box.repo, 'resume');
  assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
  const text = result.stdout;
  assert.match(text, /new in 0\.8\.9 — Nine: Nine paragraph\./u);
  assert.match(text, /new in 0\.8\.8 — Eight: Eight paragraph\./u);
  assert.match(text, /new in 0\.8\.7 — Seven: Seven paragraph\./u);
  assert.doesNotMatch(text, /new in 0\.8\.6|new in 0\.8\.5|new in 0\.8\.4/u);
  assert.match(text, /2 earlier releases omitted; see the full notes in CHANGELOG\.md/u);
  assert.doesNotMatch(text, /new in 0\.8\.4 — Added/u);
});

const BASE = Date.parse('2026-10-10T00:00:00Z');
const MINUTE = 60_000;

/** Build native lifecycle moves on a private real board with a deterministic observation clock. */
function fixture(t, { wait = null, age = null, reservation = null, otherAge = null } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-resume-flow-')));
  /** Run Git with a private fixture identity and no user configuration. */
  const git = (...args) => runFixtureGit(args, { cwd: root, stdio: 'pipe', env: {
    ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com',
  } });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ gate: 'true', verify: 'any', lanes: { web: { owns: ['web/'] } } }));
  writeFileSync(join(root, 'SPEC.md'), '# Flow fixture\n\n## G · Goals\n- G1 [approved, must] The fixture works. | gate: test\n');
  writeFileSync(join(root, 'DOCTRINE.md'), '# Doctrine\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: create flow fixture');
  const web = join(root, 'builder');
  git('worktree', 'add', '-q', '-b', 'web/one', web);
  let at = 0;
  const clock = { now: () => new Date(BASE + at * MINUTE) };
  const board = store.openBoard(join(root, '.git', 'pullboard', 'board.sqlite'), clock);
  t.after(() => { store.closeBoard(board); rmSync(root, { recursive: true, force: true }); });
  store.register(board, { lane: 'coordinator', path: root });
  const builder = store.register(board, { lane: 'web', path: web });
  const reviewer = store.register(board, { lane: 'review', path: join(root, 'reviewer') });
  const freeze = () => ({ text: JSON.stringify({ rows: [] }), digest: 'frozen' });
  /** Add and submit an item at exact recorded minute offsets. */
  function submit(start, submitted) {
    at = start;
    const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Flow fixture' });
    store.claim(board, id, { agentId: builder, lane: 'web', leaseMs: 1000 * MINUTE, freeze });
    at = submitted;
    submitFixture(board, id, { agentId: builder, commit: 'a'.repeat(40), tree: 'b'.repeat(40) });
    return id;
  }
  if (wait !== null) {
    const id = submit(0, 200);
    at = 200 + wait;
    store.reserveReview(board, id, { agentId: reviewer, leaseMs: 1000 * MINUTE, policy: 'any' });
    at += 20;
    store.verify(board, id, { agentId: reviewer, decision: 'ACCEPT', note: 'Fixture meets its bar.', head: 'a'.repeat(40), digest: 'frozen', policy: 'any' });
    at = 300;
    store.merged(board, id, { agentId: 'coordinator', commit: 'c'.repeat(40) });
  }
  let waiting = null;
  if (age !== null) {
    waiting = submit(301, 500 - age);
    if (otherAge !== null) submit(311, 500 - otherAge);
    if (reservation !== null) {
      at = 350;
      store.reserveReview(board, waiting, { agentId: reviewer, leaseMs: (reservation === 'live' ? 151 : 150) * MINUTE, policy: 'any' });
      if (reservation === 'released') {
        at = 450;
        store.release(board, waiting, reviewer, 'Fixture releases its review.');
      } else if (reservation === 'verdict') {
        at = 450;
        store.verify(board, waiting, { agentId: reviewer, decision: 'REJECT', reason: 'TEST_FAILURE', note: 'Fixture rejection.', head: 'a'.repeat(40), digest: 'frozen', policy: 'any' });
      }
    }
  }
  at = 500;
  /** Run the real command against its native board and capture exact text or JSON. */
  async function run(args, cwd = root) {
    let stdout = '', stderr = '';
    const code = await main(args, { cwd, clock,
      stdout: { isTTY: false, write: text => { stdout += text; } },
      stderr: { write: text => { stderr += text; } } });
    assert.equal(code, 0, stderr || stdout);
    return args.includes('--json') ? JSON.parse(stdout) : stdout.trimEnd();
  }
  return { root, web, waiting, run, board, builder, reviewer, stats: () => proofStats(board, { now: clock.now().getTime() }) };
}

/** Require exactly one final line while preserving the ordinary next-step line immediately before it. */
function alert(text, expected) {
  const lines = text.split('\n');
  assert.deepEqual(lines.filter(line => line.startsWith('flow:')), [expected]);
  assert.equal(lines.at(-1), expected);
  assert.match(lines.at(-2), /^next: /u);
}

test('coordinator resume ends with the exact measured-average flow alert [N32,R1,R2]', async t => {
  const box = fixture(t, { wait: 61 });
  alert(await box.run(['resume']), 'flow: review wait average 1 h 1 min (1 measured; > 1 h 0 min); bottleneck: build (66.67% of 5 h 0 min measured cycle time); next: add a builder when open work is available');
  const json = await box.run(['resume', '--json']);
  assert.deepEqual(json.flow, box.stats().flow, 'resume uses precisely the stats observation, stage and action');
  const stats = await box.run(['stats', '--json']);
  assert.deepEqual(json.flow.stages, stats.stats.flow.stages);
  assert.deepEqual(json.flow.bottleneck, stats.stats.flow.bottleneck);
});

test('coordinator resume alerts for the oldest unreviewed submission alone [N32,R1,R2]', async t => {
  const box = fixture(t, { wait: 10, age: 181 });
  alert(await box.run(['resume']), 'flow: unreviewed #2 waiting 3 h 1 min (> 3 h 0 min); bottleneck: build (66.67% of 5 h 0 min measured cycle time); next: add a builder when open work is available');
  assert.deepEqual(box.stats().flow.unreviewed, { size: 1, oldest: { id: 2, since: '2026-10-10T05:19:00.000Z', ageMinutes: 181 } });
});

test('coordinator resume keeps both threshold trips in one final flow line [N32,R1,R2]', async t => {
  const box = fixture(t, { wait: 61, age: 181 });
  const text = await box.run(['resume']);
  alert(text, 'flow: review wait average 1 h 1 min (1 measured; > 1 h 0 min); unreviewed #2 waiting 3 h 1 min (> 3 h 0 min); bottleneck: build (66.67% of 5 h 0 min measured cycle time); next: add a builder when open work is available');
  const flowLine = text.split('\n').find(line => line.startsWith('flow:'));
  const minuteValues = [...flowLine.matchAll(/(\d+(?:\.\d+)?) min\b/gu)].map(match => Number(match[1]));
  assert.ok(minuteValues.length > 0 && minuteValues.every(value => Number.isInteger(value) && value >= 0 && value < 60),
    `every displayed minute unit is a rounded remainder below 60: ${flowLine}`);
});

test('coordinator resume adds no alert at exact healthy threshold boundaries [N32,R1,R2]', async t => {
  const box = fixture(t, { wait: 60, age: 180 });
  const text = await box.run(['resume']);
  assert.doesNotMatch(text, /^flow:/mu);
  assert.match(text.split('\n').at(-1), /^next: /u);
});

test('coordinator resume adds no alert to an unmeasured healthy board [N32,R1,R2]', async t => {
  const box = fixture(t);
  assert.equal(box.stats().flow.bottleneck.stage, null);
  assert.doesNotMatch(await box.run(['resume']), /^flow:/mu);
});

test('coordinator resume names an old waiting item without inventing a measured bottleneck [N32,R1,R2]', async t => {
  const box = fixture(t, { age: 181 });
  alert(await box.run(['resume']), 'flow: unreviewed #1 waiting 3 h 1 min (> 3 h 0 min); bottleneck: not measured yet');
});

for (const reservation of ['expired', 'released']) {
  test(`coordinator resume counts an ${reservation} review as unreserved from final submit [N32,R1,R2]`, async t => {
    const box = fixture(t, { age: 181, reservation });
    alert(await box.run(['resume']), 'flow: unreviewed #1 waiting 3 h 1 min (> 3 h 0 min); bottleneck: not measured yet');
  });
}

for (const reservation of ['live', 'verdict']) {
  test(`coordinator resume excludes a ${reservation} review from the unreviewed alert [N32,R1,R2]`, async t => {
    const box = fixture(t, { age: 181, reservation });
    assert.deepEqual(box.stats().flow.unreviewed, { size: 0, oldest: null });
    assert.doesNotMatch(await box.run(['resume']), /^flow:/mu);
  });
}

test('agent resume keeps its next step without a coordinator flow alert [N32,R1,R2]', async t => {
  const box = fixture(t, { wait: 61, age: 181 });
  const text = await box.run(['resume'], box.web);
  assert.doesNotMatch(text, /^flow:/mu);
  assert.match(text.split('\n').at(-1), /^next: /u);
  assert.equal(Object.hasOwn(await box.run(['resume', '--json'], box.web), 'flow'), false);
});

/** Prove the coordinator's resume counts and names its waiting inbox, privately and read-only. */
test('resume shows the coordinator its unread shouts [I1,A9]', async t => {
  const box = fixture(t);
  const none = await box.run(['resume']);
  assert.ok(none.split('\n').includes('inbox: 0 unread shouts, 0 open decisions for you'), none);
  assert.match(none.split('\n').at(-1), /^next: (?!read your)/u, 'nothing waiting puts no inbox step first');
  assert.deepEqual((await box.run(['resume', '--json'])).inbox,
    { unread: 0, decisions: 0, newest: [], more: 0, read: 'pullboard inbox' });
  const say = (from, to, text, decision = false) => store.shout(box.board, { from, to, text, lanes: ['web'], decision });
  const first = say(box.builder, 'coordinator', 'Builder asks the coordinator something');
  say(box.builder, box.reviewer, 'Private note for the reviewer alone');
  say(box.reviewer, 'web', 'A note for the web lane alone');
  const second = say(box.reviewer, 'coordinator', 'Which lane owns the docs?\nMore detail below.', true);
  const text = await box.run(['resume']);
  assert.equal(store.unreadCount(box.board, 'coordinator'), 2, 'resume marks nothing read');
  const lines = text.split('\n');
  const at = lines.indexOf('inbox: 2 unread shouts, 1 open decision for you; read them with pullboard inbox');
  assert.ok(at > 0 && lines[at - 1].startsWith('resume: '), `the count opens the card, after its header:\n${text}`);
  assert.doesNotMatch(text, /Private note|for the web lane/u, 'another seat\'s private and lane shouts stay out');
  assert.doesNotMatch(text, /\d+ unread shouts?; newest from/u, 'the old line at the end of the card is not repeated');
  assert.deepEqual(lines.slice(at + 1, at + 3), [
    `  newest #${second} from ${box.reviewer} (unknown) (0m ago): Which lane owns the docs?`,
    `  newest #${first} from ${box.builder} (unknown) (0m ago): Builder asks the coordinator something`,
  ], text);
  assert.equal(lines.at(-1), `next: read your 2 unread shouts first: pullboard inbox; then ${none.split('\n').at(-1).slice('next: '.length)}`);
  const json = await box.run(['resume', '--json']);
  assert.deepEqual(json.inbox, { unread: 2, decisions: 1, more: 0, read: 'pullboard inbox', newest: [
    { id: first, from: box.builder, at: '2026-10-10T08:20:00.000Z', text: 'Builder asks the coordinator something' },
    { id: second, from: box.reviewer, at: '2026-10-10T08:20:00.000Z', text: 'Which lane owns the docs?\nMore detail below.' },
  ] });
  const builderCard = await box.run(['resume', '--json'], box.web);
  assert.equal(Object.hasOwn(builderCard, 'inbox'), false, 'an agent keeps its own unread line');
  assert.equal(builderCard.unread, 1, 'the builder sees its lane, never the coordinator or reviewer shouts');
  assert.equal(builderCard.newest[0].shout_text, 'A note for the web lane alone');
  for (let n = 0; n < 3; n += 1) say(box.builder, 'all', `Board-wide note ${n}`);
  const busy = (await box.run(['resume'])).split('\n');
  const top = busy.findIndex(line => line.startsWith('inbox: '));
  assert.equal(busy[top], 'inbox: 5 unread shouts, 1 open decision for you; read them with pullboard inbox');
  assert.deepEqual(busy.slice(top + 1, top + 5).map(line => line.replace(/#\d+ /u, '')), [
    `  newest from ${box.builder} (unknown) (0m ago): Board-wide note 2`,
    `  newest from ${box.builder} (unknown) (0m ago): Board-wide note 1`,
    `  newest from ${box.builder} (unknown) (0m ago): Board-wide note 0`,
    '  2 more; read them all with pullboard inbox',
  ], 'the newest three by name, then the rest as a count and the command');
  assert.equal(store.inbox(box.board, 'coordinator').length, 5, 'inbox still reads every shout resume showed');
  const read = await box.run(['resume']);
  assert.ok(read.split('\n').includes('inbox: 0 unread shouts, 1 open decision for you; read them with pullboard inbox'), read);
  assert.match(read.split('\n').at(-1), /^next: (?!read your)/u, 'a read inbox no longer goes first');
});

/** Prove the SessionStart hook prints the same inbox count, since it runs pullboard resume. */
test('resume shows the coordinator its unread shouts through the SessionStart hook [I1,A9]', t => {
  const box = releaseFixture(t);
  const other = join(box.root, 'other-checkout');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: initialize hook inbox fixture [N19]');
  box.git(box.repo, 'worktree', 'add', '-q', '-b', 'other', other);
  const lane = Object.keys(JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8')).lanes)[0];
  const joined = box.run(other, 'join', lane, '--model', 'Fixture');
  assert.equal(joined.status, 0, joined.failure || joined.stderr || joined.stdout);
  const shouted = box.run(other, 'shout', 'coordinator', 'The hook shows this shout');
  assert.equal(shouted.status, 0, shouted.failure || shouted.stderr || shouted.stdout);
  const hook = runFixtureChild('sh', ['-c', RESUME_HOOK], { cwd: box.repo, env: box.env, encoding: 'utf8' });
  assert.equal(hook.status, 0, hook.failure || hook.stderr || hook.stdout);
  assert.match(hook.stdout, /^inbox: 1 unread shout, 0 open decisions for you; read them with pullboard inbox$/mu, hook.stdout);
  assert.match(hook.stdout, /^ {2}newest #\d+ from .+ \(\d+m ago\): The hook shows this shout$/mu, hook.stdout);
});

test('spec draft adds draft rows and resume names them [N32]', t => {
  const box = releaseFixture(t, { freshSetup: true });
  const initial = JSON.parse(box.run(box.repo, 'resume', '--diagnostics', '--json').stdout);
  assert.equal(initial.setup.step, 1);
  assert.match(initial.setup.command, /^pullboard spec draft/u);
  assert.doesNotMatch(initial.setup.command, /node -e|appendFileSync/u);
  assert.match(initial.setup.afterAnswer, /record each answer with pullboard spec draft/iu);

  const help = box.run(box.repo, 'help', 'spec', '--json');
  assert.equal(help.status, 0, help.failure || help.stderr);
  assert.match(JSON.parse(help.stdout).help, /spec draft <text>.*any agent: append a draft row/u);

  const first = box.run(box.repo, 'spec', 'draft', 'Describe the first requirement', '--json');
  const second = box.run(box.repo, 'spec', 'draft', 'Describe the second requirement', '--aim', '--gate', 'node --test', '--json');
  assert.equal(first.status, 0, first.failure || first.stderr);
  assert.equal(second.status, 0, second.failure || second.stderr);
  const rows = JSON.parse(box.run(box.repo, 'spec', '--json').stdout).rows;
  assert.deepEqual(rows.filter(row => ['G1', 'G2'].includes(row.id)).map(({ id, status, tier, text, gate }) => ({ id, status, tier, text, gate })), [
    { id: 'G1', status: 'draft', tier: 'must', text: 'Describe the first requirement', gate: 'review' },
    { id: 'G2', status: 'draft', tier: 'aim', text: 'Describe the second requirement', gate: 'node --test' },
  ], 'draft appends two sequential draft rows with the requested defaults');
  assert.equal(JSON.parse(first.stdout).id, 'G1');
  assert.equal(JSON.parse(second.stdout).id, 'G2');
  const beforeEmpty = readFileSync(join(box.repo, 'SPEC.md'), 'utf8');
  const empty = box.run(box.repo, 'spec', 'draft', '   ', '--json');
  assert.notEqual(empty.status, 0);
  assert.equal(JSON.parse(empty.stdout).error.code, 'USAGE');
  assert.equal(readFileSync(join(box.repo, 'SPEC.md'), 'utf8'), beforeEmpty, 'an empty draft does not change the spec');

  const next = JSON.parse(box.run(box.repo, 'resume', '--diagnostics', '--json').stdout);
  assert.equal(next.setup.step, 1);
  assert.match(next.setup.question, /waiting.*person.*approv/iu);
  assert.deepEqual(next.setup.rowIds, ['G1', 'G2']);

  const custom = releaseFixture(t, { freshSetup: true });
  const customSpec = [
    '# Existing requirements', '', '## G · Goals',
    '- G1 [approved, must] Keep the approved row. | gate: existing',
    '- G3 [retired, aim] Keep the retired row. | gate: archive',
    '- G5 [draft, must] Keep the draft row. | gate: review',
    '- G6 [wont, aim] Keep the declined row. | gate: closed', '',
    '## N · Notes', '- G2 [approved, must] Another section owns this id. | gate: existing', '',
  ].join('\r\n');
  writeFileSync(join(custom.repo, 'SPEC.md'), customSpec);
  const customDraft = custom.run(custom.repo, 'spec', 'draft', 'Keep line endings intact', '--json');
  assert.equal(customDraft.status, 0, customDraft.failure || customDraft.stderr);
  assert.equal(JSON.parse(customDraft.stdout).id, 'G7');
  const updatedSpec = readFileSync(join(custom.repo, 'SPEC.md'), 'utf8');
  assert.equal(updatedSpec.replaceAll('\r\n', '').includes('\n'), false, 'draft preserves the source newline style');
  assert.equal(updatedSpec, customSpec.replace('\r\n\r\n## N · Notes', '\r\n- G7 [draft, must] Keep line endings intact | gate: review\r\n\r\n## N · Notes'),
    'draft preserves every existing status row and inserts in the first section');
});

test('setup lets agents build starter items while rows wait [S1,B26]', t => {
  const box = releaseFixture(t, { freshSetup: true, historyBeforeInit: true });
  const initialized = box.run(box.repo, 'init', '--blueprint', 'web-app');
  assert.equal(initialized.status, 0, initialized.failure || initialized.stderr);
  const rows = JSON.parse(box.run(box.repo, 'spec', '--json').stdout).rows;
  const starters = JSON.parse(box.run(box.repo, 'list', '--all', '--json').stdout).items.sort((a, b) => a.item_id - b.item_id);
  const first = starters.find(item => !item.item_after);
  assert.ok(first, 'the bundled blueprint files a starter with no dependency');
  const initial = JSON.parse(box.run(box.repo, 'resume', '--diagnostics', '--json').stdout);
  assert.equal(initial.setup.waitingOn, 'person-approval');
  assert.equal(initial.setup.buildNow?.item, first.item_id, 'setup names the first starter while rows are undecided');
  assert.match(initial.setup.meanwhile, /claimed and built now.*person.*parallel/iu);
  assert.equal(initial.setup.buildNow.command, `pullboard lane add ${first.item_lane} --owns ${first.item_lane}/`,
    'a proposed lane is declared before an agent tries to join it');
  const lane = box.run(box.repo, 'lane', 'add', first.item_lane, '--owns', `${first.item_lane}/`);
  assert.equal(lane.status, 0, lane.failure || lane.stderr);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: commit blueprint setup');
  const coordinator = box.run(box.repo, 'resume', '--diagnostics');
  assert.match(coordinator.stdout, /claimed and built now.*person.*parallel/iu);
  assert.ok(coordinator.stdout.includes(`#${first.item_id}`), 'prose names the same first starter');
  const prepared = JSON.parse(box.run(box.repo, 'resume', '--diagnostics', '--json').stdout);
  assert.equal(prepared.setup.buildNow.command, `pullboard worktree ${first.item_lane} --model "<model name>"`);
  box.env.CODEX_THREAD_ID = 'starter-builder-session';
  const opened = box.run(box.repo, 'worktree', first.item_lane, '--model', 'Starter fixture', '--json');
  assert.equal(opened.status, 0, opened.failure || opened.stderr);
  const worktree = JSON.parse(opened.stdout).path;
  const ready = JSON.parse(box.run(worktree, 'resume', '--diagnostics', '--json').stdout);
  assert.equal(ready.setup.waitingOn, 'person-approval', 'approval remains a separate person decision');
  assert.equal(ready.setup.buildNow.item, first.item_id);
  assert.equal(ready.setup.buildNow.command, `pullboard claim ${first.item_id}`);
  assert.equal(ready.next, `pullboard claim ${first.item_id}`, 'the agent is sent to build rather than wait for approval');
  const claimed = box.run(worktree, 'claim', String(first.item_id));
  assert.equal(claimed.status, 0, claimed.failure || claimed.stderr);
  mkdirSync(join(worktree, first.item_lane));
  writeFileSync(join(worktree, first.item_lane, 'starter.js'), 'export const started = true;\n');
  box.git(worktree, 'add', `${first.item_lane}/starter.js`);
  box.git(worktree, 'commit', '-q', '-m', `feat(app): start the requested runner [${first.item_spec_ids}]`);
  const denied = box.run(worktree, 'spec', 'approve', first.item_spec_ids.split(',')[0]);
  assert.equal(denied.status, 1, 'building does not give the agent approval rights');
  assert.match(denied.stderr, /B26_PERSON/u);
  assert.deepEqual(JSON.parse(box.run(worktree, 'spec', '--json').stdout).rows, rows,
    'the real claim and build neither approve nor apply any row');
});

test("resume says setup waits on the person's approval [I1,I2]", async t => {
  const box = releaseFixture(t, { freshSetup: true });
  box.env.AI_AGENT = 'fixture-agent';
  const drafted = [
    box.run(box.repo, 'spec', 'draft', 'The person can choose a project name.', '--json'),
    box.run(box.repo, 'spec', 'draft', 'The person can choose a project color.', '--json'),
  ];
  for (const result of drafted) assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
  const ids = drafted.map(result => JSON.parse(result.stdout).id);
  assert.deepEqual(ids, ['G1', 'G2']);

  const waiting = box.run(box.repo, 'resume', '--diagnostics');
  assert.equal(waiting.status, 0, waiting.failure || waiting.stderr || waiting.stdout);
  assert.match(waiting.stdout, /waiting.*person.*approv/iu, 'setup waits for the person after the rows are drafted');
  for (const id of ids) assert.match(waiting.stdout, new RegExp(`\\b${id}\\b`, 'u'));
  assert.match(waiting.stdout, /agent[^\n]*may[^\n]*review[^\n]*independent approved work/iu,
    'resume names permissible independent work while approval is pending');
  assert.doesNotMatch(waiting.stdout, /^next: .*spec (?:draft|approve)/mu,
    'the agent is not told to draft again or perform the person-only approval');
  const waitingJson = box.run(box.repo, 'resume', '--diagnostics', '--json');
  assert.equal(waitingJson.status, 0, waitingJson.failure || waitingJson.stderr || waitingJson.stdout);
  const card = JSON.parse(waitingJson.stdout);
  assert.equal(card.setup?.step, 1);
  assert.equal(card.setup.waitingOn, 'person-approval');
  assert.deepEqual(card.setup.rowIds, ids);
  assert.match(card.next, /^wait for the person to approve G1, G2; meanwhile pullboard spec show G1$/u);

  // Opening the real view to approve these rows cannot stand in for completing setup.
  await openSetupView(box);

  delete box.env.AI_AGENT;
  const approval = box.run(box.repo, 'spec', 'approve', ids[0]);
  assert.equal(approval.status, 0, approval.failure || approval.stderr || approval.stdout);
  const applied = box.run(box.repo, 'spec', 'apply');
  assert.equal(applied.status, 0, applied.failure || applied.stderr || applied.stdout);
  const partial = box.run(box.repo, 'resume', '--diagnostics', '--json');
  assert.equal(partial.status, 0, partial.failure || partial.stderr || partial.stdout);
  const pending = JSON.parse(partial.stdout);
  assert.equal(pending.setup?.step, 1, 'one approved row does not stand in for the remaining setup draft');
  assert.deepEqual(pending.setup.rowIds, [ids[1]]);
  assert.match(pending.setup.question, /Waiting for the person to approve G2/u);
  const finalApproval = box.run(box.repo, 'spec', 'approve', ids[1]);
  assert.equal(finalApproval.status, 0, finalApproval.failure || finalApproval.stderr || finalApproval.stdout);
  const finalApply = box.run(box.repo, 'spec', 'apply');
  assert.equal(finalApply.status, 0, finalApply.failure || finalApply.stderr || finalApply.stdout);
  const resumed = box.run(box.repo, 'resume', '--diagnostics', '--json');
  assert.equal(resumed.status, 0, resumed.failure || resumed.stderr || resumed.stdout);
  const next = JSON.parse(resumed.stdout);
  assert.equal(next.setup?.step, 2, 'person approval advances setup to its next unanswered step');
  assert.equal(next.setup.waitingOn, undefined);
});

test('coordinator resume finds the oldest unreserved item behind an older live review [N32,R1,R2]', async t => {
  const box = fixture(t, { age: 190, otherAge: 181, reservation: 'live' });
  alert(await box.run(['resume']), 'flow: unreviewed #2 waiting 3 h 1 min (> 3 h 0 min); bottleneck: not measured yet');
  assert.deepEqual(box.stats().flow.unreviewed, { size: 1, oldest: { id: 2, since: '2026-10-10T05:19:00.000Z', ageMinutes: 181 } });
});

/** Execute the exact record-answer command offered by resume inside its private repository. */
function recordSetupAnswer(box, command) {
  const result = runFixtureChild('sh', ['-c', command], { cwd: box.repo, env: box.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
}

/** Open the real local view and wait for its ready line before stopping its owned child. */
async function openSetupView(box) {
  const child = spawn(process.execPath, [join(box.root, 'cli/bin/pullboard.js'), 'view', '--no-open', '--port', '0'],
    { cwd: box.repo, env: { ...box.env, PULLBOARD_VIEW_FOREGROUND: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', () => reject(new Error(errors || output || 'view closed before ready')));
      child.stderr.on('data', bytes => { errors += bytes; });
      child.stdout.on('data', bytes => { output += bytes; if (output.includes('Pullboard view: http://')) resolve(); });
    });
    assert.match(output, /Pullboard view: http:\/\/127\.0\.0\.1:/u);
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
}

/** Reject stale or foreign receipt data while preserving the view's exact successful receipt. */
function assertViewReceipt(box) {
  const receiptPath = join(box.repo, '.git/pullboard/view-bind.json');
  const receiptBytes = readFileSync(receiptPath);
  const receipt = JSON.parse(receiptBytes);
  assert.equal(receipt.type, 'pullboard.view.bound');
  for (const invalid of [{ ...receipt, boardId: 'another-board' },
    { ...receipt, setupStartedAt: '2000-01-01T00:00:00.000Z' },
    { ...receipt, boundAt: '2000-01-01T00:00:00.000Z' }]) {
    writeFileSync(receiptPath, JSON.stringify(invalid));
    assert.equal(JSON.parse(box.run(box.repo, 'resume', '--diagnostics', '--json').stdout).setup?.step, 5,
      'a receipt for another board or before this setup cannot complete it');
  }
  writeFileSync(receiptPath, receiptBytes);
}

test('a reused authenticated view completes setup for its new board [N26,N32]', async t => {
  const firstBoard = releaseFixture(t);
  const lease = await takeDefaultViewPort(firstBoard.root);
  t.after(() => lease.release());
  /** Prepare a real board through the first four setup steps, leaving only its view unopened. */
  function awaitingView(box) {
    box.env.PULLBOARD_HOME = firstBoard.env.PULLBOARD_HOME;
    box.env.PULLBOARD_MACHINE_HOME = firstBoard.env.PULLBOARD_MACHINE_HOME;
    box.env.PULLBOARD_VIEW_PORT = String(lease.port);
    delete box.env.PULLBOARD_VIEW_FOREGROUND;
    const file = join(box.repo, 'pullboard.json');
    const config = JSON.parse(readFileSync(file, 'utf8'));
    config.gate = 'true';
    config.lanes = { app: { owns: ['app/'] } };
    writeFileSync(file, JSON.stringify(config));
    const added = box.run(box.repo, 'add', 'app', 'First setup item', '--specs', 'N19', '--criterion', 'The fixture has work.');
    assert.equal(added.status, 0, added.failure || added.stderr || added.stdout);
    assert.equal(JSON.parse(box.run(box.repo, 'resume', '--diagnostics', '--json').stdout).setup?.step, 5);
  }
  awaitingView(firstBoard);
  const child = spawn(process.execPath, [join(firstBoard.root, 'cli/bin/pullboard.js'), 'view', '--no-open', '--json'],
    { cwd: firstBoard.repo, env: { ...firstBoard.env, PULLBOARD_VIEW_FOREGROUND: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise(resolve => child.once('close', resolve));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await closed;
  });
  const first = await new Promise((resolve, reject) => {
    let output = '', errors = '';
    child.once('error', reject);
    child.once('close', code => reject(new Error(`owned view exited ${code}: ${errors}`)));
    child.stderr.on('data', bytes => { errors += bytes; });
    child.stdout.on('data', bytes => {
      output += bytes;
      try { resolve(JSON.parse(output)); } catch { /* Wait for the complete ready document. */ }
    });
  });
  assert.equal(first.port, lease.port);
  assert.equal(JSON.parse(firstBoard.run(firstBoard.repo, 'resume', '--diagnostics', '--json').stdout).setup, null);
  const secondBoard = releaseFixture(t);
  const refusedBoard = releaseFixture(t);
  awaitingView(secondBoard);
  awaitingView(refusedBoard);
  const reused = secondBoard.run(secondBoard.repo, 'view', '--no-open', '--json');
  assert.equal(reused.status, 0, reused.failure || reused.stderr || reused.stdout);
  const second = JSON.parse(reused.stdout);
  assert.equal(second.reused, true);
  assert.equal(second.url, first.url);
  assert.equal(JSON.parse(secondBoard.run(secondBoard.repo, 'resume', '--diagnostics', '--json').stdout).setup, null,
    'the exact offered view command completes setup on the second board');
  const receiptPath = join(secondBoard.repo, '.git/pullboard/view-reuse.json');
  const bytes = readFileSync(receiptPath);
  const receipt = JSON.parse(bytes);
  assert.equal(receipt.type, 'pullboard.view.reused');
  assert.equal(receipt.boundAt, first.boundAt, 'reuse retains the original bind time');
  assert.equal(receipt.pid, first.pid);
  assert.equal(receipt.port, first.port);
  assert.equal(statSync(receiptPath).mode & 0o077, 0);
  assert.equal(Object.hasOwn(receipt, 'url'), false, 'the setup receipt never copies the session secret');
  for (const invalid of [{ ...receipt, boardId: 'another-board' },
    { ...receipt, setupStartedAt: '2000-01-01T00:00:00.000Z' },
    { ...receipt, openedAt: '2000-01-01T00:00:00.000Z' }]) {
    writeFileSync(receiptPath, JSON.stringify(invalid));
    assert.equal(JSON.parse(secondBoard.run(secondBoard.repo, 'resume', '--diagnostics', '--json').stdout).setup?.step, 5,
      'another board or an observation before this setup cannot complete it');
  }
  writeFileSync(receiptPath, bytes);
  const sessionPath = join(firstBoard.env.PULLBOARD_HOME, `view-${lease.port}.json`);
  const sessionBytes = readFileSync(sessionPath);
  try {
    writeFileSync(sessionPath, JSON.stringify({ ...JSON.parse(sessionBytes), secret: 'wrong' }));
    const refused = refusedBoard.run(refusedBoard.repo, 'view', '--no-open', '--json');
    assert.equal(refused.status, 1, refused.failure || refused.stderr || refused.stdout);
    assert.equal(JSON.parse(refused.stdout).error.code, 'PORT_BUSY');
    assert.equal(JSON.parse(refusedBoard.run(refusedBoard.repo, 'resume', '--diagnostics', '--json').stdout).setup?.step, 5,
      'an unauthenticated listener cannot complete setup');
  } finally { writeFileSync(sessionPath, sessionBytes); }
});

/** Drive the same actual commands a newcomer receives, with a private fixture person approval. */
async function finishSetup(box, observe = () => {}) {
  // Exercise an explicitly unconfigured gate even when init supplies a safe starter default.
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config, gate: '' }));
  /** Assert the next setup block in both the actual text and JSON CLI output. */
  function step(number) {
    const text = box.run(box.repo, 'resume', '--diagnostics');
    assert.equal(text.status, 0, text.failure || text.stderr);
    assert.match(text.stdout, new RegExp(`Setting up: step ${number} of 5`));
    const json = box.run(box.repo, 'resume', '--diagnostics', '--json');
    assert.equal(json.status, 0, json.failure || json.stderr);
    const setup = JSON.parse(json.stdout).setup;
    assert.equal(setup.step, number);
    assert.equal(setup.total, 5);
    assert.ok(setup.question.startsWith('Ask the person:'));
    assert.ok(text.stdout.includes(setup.command));
    observe(number, setup);
    return setup;
  }
  const requirements = step(1);
  assert.match(requirements.afterAnswer, /person approves the returned ids in Pullboard View or runs pullboard spec approve <ids> in their own terminal/u);
  assert.match(requirements.afterAnswer, /coordinator runs pullboard spec apply/u);
  const drafted = ['Describe the first thing the person wants.', 'Describe how the person will know it works.']
    .map(text => box.run(box.repo, 'spec', 'draft', text, '--json'));
  for (const result of drafted) assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
  const requirementIds = drafted.map(result => JSON.parse(result.stdout).id).join(',');
  // The person decision is recorded through the real CLI in a synthetic, private person environment.
  for (const args of [['spec', 'approve', requirementIds], ['spec', 'apply']]) {
    const result = box.run(box.repo, ...args);
    assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
  }
  recordSetupAnswer(box, step(2).command);
  writeFileSync(join(box.repo, 'package.json'), JSON.stringify({ scripts: { test: 'node -e ""' } }));
  const gate = step(3);
  assert.match(gate.question, /Suggested: npm test/u);
  recordSetupAnswer(box, gate.command);
  recordSetupAnswer(box, step(4).command);
  const view = step(5);
  assert.equal(view.command, 'pullboard view');
  assert.match(view.afterAnswer, /person’s own terminal, or start it in the background as the agent/u);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: set up private fixture');
  const builder = box.run(box.repo, 'worktree', 'app', '--model', 'Fixture');
  assert.equal(builder.status, 0, builder.failure || builder.stderr);
  const stillWaiting = JSON.parse(box.run(box.repo, 'resume', '--diagnostics', '--json').stdout);
  assert.equal(stillWaiting.setup?.step, 5, 'registering a builder does not stand in for the view’s own bind receipt');
  const shouted = box.run(box.repo, 'shout', 'all', 'Opened Pullboard view for this board.');
  assert.equal(shouted.status, 0, shouted.failure || shouted.stderr);
  assert.equal(JSON.parse(box.run(box.repo, 'resume', '--diagnostics', '--json').stdout).setup?.step, 5,
    'an ordinary same-text shout cannot impersonate a successful view bind');
  await openSetupView(box);
  assertViewReceipt(box);
}

test('resume walks a new board through setup one step at a time [N32,N19]', async t => {
  const box = releaseFixture(t, { freshSetup: true });
  mkdirSync(join(box.repo, 'app'));
  const seen = [];
  await finishSetup(box, (number, setup) => {
    seen.push(number);
    if (number === 2) assert.match(setup.question, /Suggested folders: app/u);
  });
  assert.deepEqual(seen, [1, 2, 3, 4, 5]);
  const result = box.run(box.repo, 'resume', '--diagnostics', '--json');
  assert.equal(result.status, 0, result.failure || result.stderr);
  assert.equal(JSON.parse(result.stdout).setup, null, 'actual successful view bind completes the board setup');
});

test('resume names lane add to make a lane [I1,N32]', t => {
  const box = releaseFixture(t, { freshSetup: true });
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config, gate: '' }, null, 2));
  mkdirSync(join(box.repo, 'app'));
  const drafted = box.run(box.repo, 'spec', 'draft', 'Describe the first thing the person wants.', '--json');
  assert.equal(drafted.status, 0, drafted.failure || drafted.stderr || drafted.stdout);
  for (const args of [['spec', 'approve', JSON.parse(drafted.stdout).id], ['spec', 'apply']]) {
    const result = box.run(box.repo, ...args);
    assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
  }
  const text = box.run(box.repo, 'resume', '--diagnostics');
  assert.equal(text.status, 0, text.failure || text.stderr);
  const setup = JSON.parse(box.run(box.repo, 'resume', '--diagnostics', '--json').stdout).setup;
  assert.equal(setup.step, 2);
  assert.equal(setup.command, 'pullboard lane add app --owns app/');
  assert.ok(text.stdout.includes(setup.command), text.stdout);
  assert.doesNotMatch(text.stdout, /node -e/u);

  // The printed command, run exactly as written, declares the lane and moves setup on.
  recordSetupAnswer(box, setup.command);
  const lanes = box.run(box.repo, 'lanes');
  assert.equal(lanes.status, 0, lanes.failure || lanes.stderr);
  assert.match(lanes.stdout, /^app\s+app\/(?:\s|$)/mu);
  assert.equal(JSON.parse(box.run(box.repo, 'resume', '--diagnostics', '--json').stdout).setup?.step, 3);
});

test("a set-up board's resume prints no setup steps [N32,N19]", async t => {
  const box = releaseFixture(t, { freshSetup: true });
  await finishSetup(box);
  const result = box.run(box.repo, 'resume', '--diagnostics');
  assert.equal(result.status, 0, result.failure || result.stderr);
  assert.doesNotMatch(result.stdout, /Setting up: step/u);
  const json = box.run(box.repo, 'resume', '--diagnostics', '--json');
  assert.equal(JSON.parse(json.stdout).setup, null);
  const proposed = box.run(box.repo, 'spec', 'draft', 'A later proposal for the person', '--json');
  assert.equal(proposed.status, 0, proposed.failure || proposed.stderr || proposed.stdout);
  const later = box.run(box.repo, 'resume', '--diagnostics', '--json');
  assert.equal(later.status, 0, later.failure || later.stderr || later.stdout);
  assert.equal(JSON.parse(later.stdout).setup, null, 'a later proposal does not reopen completed setup');
});


test('a new preconfigured board waits for every initial approval [I1,I2]', async t => {
  const box = releaseFixture(t, { freshSetup: true });
  const marker = join(box.repo, '.git/pullboard/setup-started.json');
  const started = JSON.parse(readFileSync(marker, 'utf8'));
  assert.equal(started.type, 'pullboard.setup.started');
  assert.equal(started.version, 1);
  assert.equal(statSync(marker).mode & 0o077, 0);
  const board = store.openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  try {
    assert.equal(started.boardId, store.boardId(board));
    assert.equal(started.setupStartedAt, store.listAgents(board).find(agent => agent.agent_id === 'coordinator').agent_created_at);
  } finally { store.closeBoard(board); }
  const configPath = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  writeFileSync(configPath, JSON.stringify({ ...config, gate: 'true', lanes: { app: { owns: ['app/'] } } }));
  for (const text of ['The person chooses the name.', 'The person chooses the color.']) {
    const draft = box.run(box.repo, 'spec', 'draft', text);
    assert.equal(draft.status, 0, draft.failure || draft.stderr || draft.stdout);
  }
  for (const args of [['spec', 'approve', 'G1'], ['spec', 'apply'],
    ['add', 'app', 'First setup item', '--specs', 'G1', '--criterion', 'The fixture has work.']]) {
    const result = box.run(box.repo, ...args);
    assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
  }
  await openSetupView(box);
  const result = box.run(box.repo, 'resume', '--diagnostics', '--json');
  assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
  const setup = JSON.parse(result.stdout).setup;
  assert.equal(setup?.step, 1, 'an early view and preconfigured answers cannot bypass the remaining initial approval');
  assert.deepEqual(setup.rowIds, ['G2']);
  const startedBytes = readFileSync(marker);
  for (const invalid of ['{', JSON.stringify({ ...started, boardId: 'another-board' }),
    JSON.stringify({ ...started, setupStartedAt: '2000-01-01T00:00:00.000Z' })]) {
    writeFileSync(marker, invalid);
    const resumed = box.run(box.repo, 'resume', '--diagnostics', '--json');
    assert.equal(resumed.status, 0, resumed.failure || resumed.stderr || resumed.stdout);
    assert.deepEqual(JSON.parse(resumed.stdout).setup?.rowIds, ['G2'],
      'an invalid progress receipt is not evidence of a completed legacy setup');
  }
  writeFileSync(marker, startedBytes);
});

test('an upgraded configured board stays set up before its first resume [I1,I2]', async t => {
  const box = releaseFixture(t, { freshSetup: true });
  await finishSetup(box);
  // Legacy installations have these actual completed setup facts, but neither new lifecycle receipt.
  const stateDirectory = join(box.repo, '.git/pullboard');
  for (const name of ['setup-started.json', 'setup-complete.json']) rmSync(join(stateDirectory, name), { force: true });
  const reinitialized = box.run(box.repo, 'init');
  assert.equal(reinitialized.status, 0, reinitialized.failure || reinitialized.stderr || reinitialized.stdout);
  assert.throws(() => readFileSync(join(stateDirectory, 'setup-started.json')), { code: 'ENOENT' },
    'idempotent init does not classify an existing coordinator as a new enrollment');
  const proposed = box.run(box.repo, 'spec', 'draft', 'A proposal drafted before the first upgraded resume', '--json');
  assert.equal(proposed.status, 0, proposed.failure || proposed.stderr || proposed.stdout);
  const result = box.run(box.repo, 'resume', '--diagnostics', '--json');
  assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).setup, null, 'a later draft does not reopen a legacy completed setup');
  const complete = JSON.parse(readFileSync(join(stateDirectory, 'setup-complete.json'), 'utf8'));
  const view = JSON.parse(readFileSync(join(stateDirectory, 'view-bind.json'), 'utf8'));
  assert.equal(complete.type, 'pullboard.setup.completed');
  assert.equal(complete.version, 1);
  assert.equal(complete.boardId, view.boardId);
  assert.equal(complete.setupStartedAt, view.setupStartedAt);
  assert.equal(statSync(join(stateDirectory, 'setup-complete.json')).mode & 0o077, 0);
});

test('a board building without spec rows is not told to draft the spec first [I10,B26]', async t => {
  const box = releaseFixture(t, { freshSetup: true, historyBeforeInit: true });
  const file = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  config.gate = 'true';
  config.lanes = { app: { owns: ['app/'] } };
  writeFileSync(file, JSON.stringify(config));
  mkdirSync(join(box.repo, 'app'));
  writeFileSync(join(box.repo, 'app/first.txt'), 'first working item\n');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: initialize the private board');
  const spec = box.run(box.repo, 'spec', '--json');
  assert.equal(spec.status, 0, spec.failure || spec.stderr);
  assert.deepEqual(JSON.parse(spec.stdout).rows.filter(row => row.file === 'SPEC.md'), []);
  const added = box.run(box.repo, 'add', 'app', 'Build the first useful thing', '--criterion', 'The first useful thing works.', '--json');
  assert.equal(added.status, 0, added.failure || added.stderr || added.stdout);
  assert.equal(JSON.parse(added.stdout).item.item_spec_ids, '', 'real board items need no spec rows');
  for (let repeat = 0; repeat < 2; repeat++) {
    const resumed = box.run(box.repo, 'resume', '--diagnostics', '--json');
    assert.equal(resumed.status, 0, resumed.failure || resumed.stderr || resumed.stdout);
    const card = JSON.parse(resumed.stdout);
    assert.notEqual(card.setup?.step, 1, 'an active rowless board skips the required spec step');
    assert.doesNotMatch(card.next, /spec draft|decompose|person.*approv/iu,
      'the work has an actionable next step without spec approval');
    if (card.setup) {
      const specStep = card.setup.steps.find(step => step.number === 1);
      assert.equal(specStep.done, true);
      assert.match(specStep.question, /optional/iu);
      assert.match(specStep.command, /pullboard spec draft/u);
    }
    const text = box.run(box.repo, 'resume', '--diagnostics');
    assert.equal(text.status, 0, text.failure || text.stderr || text.stdout);
    assert.match(text.stdout, /spec rows are optional[^\n]*pullboard spec draft/iu,
      'resume offers the way to add rows without making it the work prerequisite');
    assert.doesNotMatch(text.stdout, /^next: .*spec draft/mu);
  }
  await openSetupView(box);
  for (let repeat = 0; repeat < 2; repeat++) {
    const resumed = box.run(box.repo, 'resume', '--diagnostics', '--json');
    assert.equal(resumed.status, 0, resumed.failure || resumed.stderr || resumed.stdout);
    const card = JSON.parse(resumed.stdout);
    assert.equal(card.setup, null, 'the working board can finish setup without adding rows');
    assert.doesNotMatch(card.next, /spec draft|decompose|person.*approv/iu,
      'completed setup keeps directing the coordinator to the actual work');
  }
});
