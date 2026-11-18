/** Init writes only what it owns and leaves the person's repository rules alone, in its own file so the census runs it apart [I1,I2,I16]. */
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture } from '../../tests/fixtures/init/ignore-box.js';

test('cli.journeys-init-ignore-rules.setup-commits-use-repository-identity-despite: setup commits use repository identity despite inherited agent identity [I1,I2]', async t => {
  const box = fixture(t);
  rmSync(join(box.root, 'pullboard.json'));
  box.git('config', 'user.name', 'Repository Owner'); box.git('config', 'user.email', 'owner@example.invalid');
  Object.assign(box.env, { GIT_AUTHOR_NAME: 'Inherited Agent', GIT_AUTHOR_EMAIL: 'agent@example.invalid',
    GIT_COMMITTER_NAME: 'Inherited Agent', GIT_COMMITTER_EMAIL: 'agent@example.invalid', EMAIL: 'agent@example.invalid' });
  const configured = box.git('config', '--local', '--get-regexp', '^user\\.');
  const initialized = await box.invoke('init', '--yes');
  assert.equal(initialized.code, 0, initialized.stderr);
  assert.equal(box.git('log', '-1', '--format=%an <%ae> / %cn <%ce>'),
    'Repository Owner <owner@example.invalid> / Repository Owner <owner@example.invalid>', 'both identities come from this repository');
  assert.equal(box.git('config', '--local', '--get-regexp', '^user\\.'), configured, 'setup never changes repository identity settings');
});

test('cli.journeys-init-ignore-rules.a-fresh-init-tells-the-person: a fresh init tells the person and the agent how to start [I9,I1]', async t => {
  const box = fixture(t);
  rmSync(join(box.root, 'pullboard.json'));
  const initialized = await box.output('init', '--verbose');
  assert.equal(initialized.code, 0, initialized.stderr);
  assert.equal(JSON.parse(readFileSync(join(box.root, 'pullboard.json'), 'utf8')).worktrees, 'inside',
    'fresh init opts into worktrees inside the repository');
  assert.match(initialized.stdout, /new agent worktrees go in \.claude\/worktrees; dot-scanner tools such as eslint \. should ignore \.claude\/worktrees; set "worktrees": "beside" in pullboard\.json to use sibling folders/u,
    'init prints one-line location, scanner-ignore and switch guidance');
  assert.match(initialized.stdout, /^Next: ask your agent to set up Pullboard here; in Claude Code, start a new session first so it loads the Pullboard skills\.$/mu, 'init gives one setup instruction and preserves Claude Code skill loading');
  assert.match(initialized.stdout, /To commit Pullboard's files: pullboard init --yes/u, 'init gives one setup-only confirmation command');

  const agents = readFileSync(join(box.root, 'AGENTS.md'), 'utf8');
  assert.match(agents, /^## Pullboard$/mu, 'AGENTS.md carries the approved Pullboard section');
});

test('cli.journeys-init-ignore-rules.init-summarizes-setup-before-one-final: init summarizes setup before one final next step [I1,I2,B26]', async t => {
  const box = fixture(t);
  rmSync(join(box.root, 'pullboard.json'));
  const initialized = await box.output('init');
  assert.equal(initialized.code, 0, initialized.stderr);
  const lines = initialized.stdout.trimEnd().split(/\r?\n/u);
  assert.match(lines[0] ?? '', /^Set up Pullboard:/u, 'a newcomer sees what was installed');
  assert.match(lines.at(-1) ?? '', /^Next: ask your agent to run pullboard resume to finish setup\.$/u,
    'the one next step ends the compact summary');
  assert.equal(lines.filter(line => /^Next:/u.test(line)).length, 1);
  assert.ok(lines.length <= 12, 'setup details stay out of the compact report');
  assert.doesNotMatch(initialized.stdout, /sandbox_mode|--detach|To commit Pullboard's files:/u,
    'the detailed recipes remain behind --verbose');
});

test('cli.journeys-init-ignore-rules.init-appends-only-the-agent-worktree: init appends only the agent-worktree ignore rule and the second init writes nothing [I1,I2,I16]', async t => {
  for (const previous of [undefined, '', '# existing rules\r\nnode_modules/\r\n!keep-this', '.claude/worktrees/\n# already configured\n']) {
    const box = fixture(t, previous);
    const first = await box.invoke('init');
    assert.equal(first.code, 0, JSON.stringify(first.document));
    const file = join(box.root, '.gitignore');
    const expected = previous?.split(/\r?\n/u).includes('.claude/worktrees/') ? previous : (previous ?? '') + (previous && !previous.endsWith('\n') ? '\n' : '') + '.claude/worktrees/\n';
    assert.equal(readFileSync(file, 'utf8'), expected, 'every previous byte stays intact');
    assert.ok(first.document.notes.some(note => note.includes('.gitignore')));
    const setupFiles = ['.gitignore', '.git/config', 'AGENTS.md', '.githooks/pre-commit', '.githooks/pre-merge-commit', '.githooks/commit-msg', '.githooks/pre-push'];
    const before = setupFiles.map(name => statSync(join(box.root, name), { bigint: true }).mtimeNs);
    const second = await box.invoke('init');
    assert.equal(second.code, 0, second.stderr);
    assert.equal(readFileSync(file, 'utf8'), expected);
    assert.deepEqual(setupFiles.map(name => statSync(join(box.root, name), { bigint: true }).mtimeNs), before, 'setup files and hook configuration are never rewritten');
    assert.ok(second.document.notes.includes('kept .gitignore (already ignores .claude/worktrees/)'));
    assert.equal(second.document.notes.some(note => note.startsWith('git add ')), false, 'a second init writes no setup files: ' + JSON.stringify(second.document.notes));
  }
});

test('cli.journeys-init-ignore-rules.idempotent-setup-still-restores-executable-mode: idempotent setup still restores executable mode on its own managed hooks [I1,I2]', async t => {
  const box = fixture(t);
  assert.equal((await box.invoke('init')).code, 0);
  const hook = join(box.root, '.githooks/pre-commit');
  const source = readFileSync(hook, 'utf8');
  chmodSync(hook, 0o644);
  const repaired = await box.invoke('init');
  assert.equal(repaired.code, 0);
  assert.equal(statSync(hook).mode & 0o777, 0o755);
  assert.equal(readFileSync(hook, 'utf8'), source);
  assert.ok(repaired.document.notes.includes('restored executable mode for .githooks/pre-commit'));
});

test('cli.journeys-init-ignore-rules.a-real-worktree-under-claude-worktrees: a real worktree under .claude/worktrees leaves status clean and coordinator submit succeeds [I1,I16]', async t => {
  const box = fixture(t);
  assert.equal((await box.invoke('init')).code, 0);
  box.git('add', '-A'); box.git('commit', '-q', '-m', 'chore: initialize isolated board');
  const added = await box.invoke('add', 'coordinator', 'Proof with a nested agent worktree', '--criterion', 'the clean coordinator can submit');
  assert.equal(added.code, 0);
  const id = String(added.document.item.item_id);
  assert.equal((await box.invoke('claim', id)).code, 0);
  mkdirSync(join(box.root, 'docs'));
  writeFileSync(join(box.root, 'docs/proof.txt'), 'actual coordinator work\n');
  box.git('add', 'docs/proof.txt'); box.git('commit', '-q', '-m', 'chore: add the coordinator proof', '-m', `Pullboard-Item: #${id}`);
  box.git('worktree', 'add', '-q', '-b', 'agent/scratch', '.claude/worktrees/scratch', 'HEAD');
  assert.equal(box.git('status', '--porcelain'), '', 'the real nested checkout adds no untracked paths');
  const submitted = await box.invoke('submit', id);
  assert.equal(submitted.code, 0, JSON.stringify(submitted.document));
  assert.equal(submitted.document.id, Number(id));
  // A pulled submit returns queued at once; the gate settles on a runner, so a settled gate must be green [C7,#7932].
  assert.ok(submitted.document.queued === true || submitted.document.gate?.green === true, JSON.stringify(submitted.document));
});
