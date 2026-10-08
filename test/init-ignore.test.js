/** Setup preserves local ignore rules and excludes real nested agent worktrees [I1,I2,I16]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

/** Create a private Git repo whose installed hooks invoke this candidate CLI only. */
function fixture(t, ignore) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-init-ignore-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'repo'); const bin = join(directory, 'bin');
  mkdirSync(root); mkdirSync(bin);
  const cliPath = resolve(import.meta.dirname, '../bin/pullboard.js');
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec "${process.execPath}" "${cliPath}" "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const env = { ...process.env, HOME: join(directory, 'home'), PULLBOARD_HOME: join(directory, 'board-home'), PULLBOARD_MACHINE_HOME: join(directory, 'machine-home'), PATH: bin + ':' + process.env.PATH };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  delete env.PULLBOARD_RELAY_TOKEN;
  Object.assign(env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Init Fixture', GIT_AUTHOR_EMAIL: 'init@example.com', GIT_COMMITTER_NAME: 'Init Fixture', GIT_COMMITTER_EMAIL: 'init@example.com' });
  /** Run actual Git and its installed hooks, requiring success. */
  function git(...args) {
    const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  }
  /** Invoke the real command and retain its typed result, including refusals. */
  function cli(...args) {
    const result = spawnSync(process.execPath, [cliPath, ...args, '--json'], { cwd: root, env, encoding: 'utf8' });
    return { code: result.status, document: JSON.parse(result.stdout), stderr: result.stderr };
  }
  git('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ gate: 'true', lanes: { web: { owns: ['web/'], specs: [] } } }));
  if (ignore !== undefined) writeFileSync(join(root, '.gitignore'), ignore);
  return { root, git, cli };
}

test('init appends only the agent-worktree ignore rule and the second init writes nothing [I1,I2,I16]', t => {
  for (const previous of [undefined, '', '# existing rules\r\nnode_modules/\r\n!keep-this', '.claude/worktrees/\n# already configured\n']) {
    const box = fixture(t, previous);
    const first = box.cli('init');
    assert.equal(first.code, 0, JSON.stringify(first.document));
    const file = join(box.root, '.gitignore');
    const expected = previous?.split(/\r?\n/u).includes('.claude/worktrees/') ? previous : (previous ?? '') + (previous && !previous.endsWith('\n') ? '\n' : '') + '.claude/worktrees/\n';
    assert.equal(readFileSync(file, 'utf8'), expected, 'every previous byte stays intact');
    assert.ok(first.document.notes.some(note => note.includes('.gitignore')));
    const setupFiles = ['.gitignore', '.git/config', 'AGENTS.md', '.githooks/pre-commit', '.githooks/commit-msg', '.githooks/pre-push'];
    const before = setupFiles.map(name => statSync(join(box.root, name), { bigint: true }).mtimeNs);
    const second = box.cli('init');
    assert.equal(second.code, 0, second.stderr);
    assert.equal(readFileSync(file, 'utf8'), expected);
    assert.deepEqual(setupFiles.map(name => statSync(join(box.root, name), { bigint: true }).mtimeNs), before, 'setup files and hook configuration are never rewritten');
    assert.ok(second.document.notes.includes('kept .gitignore (already ignores .claude/worktrees/)'));
    assert.equal(second.document.notes.some(note => note.startsWith('git add ')), false, 'a second init writes no setup files: ' + JSON.stringify(second.document.notes));
  }
});

test('idempotent setup still restores executable mode on its own managed hooks [I1,I2]', t => {
  const box = fixture(t);
  assert.equal(box.cli('init').code, 0);
  const hook = join(box.root, '.githooks/pre-commit');
  const source = readFileSync(hook, 'utf8');
  chmodSync(hook, 0o644);
  const repaired = box.cli('init');
  assert.equal(repaired.code, 0);
  assert.equal(statSync(hook).mode & 0o777, 0o755);
  assert.equal(readFileSync(hook, 'utf8'), source);
  assert.ok(repaired.document.notes.includes('restored executable mode for .githooks/pre-commit'));
});

test('a real worktree under .claude/worktrees leaves status clean and coordinator submit succeeds [I1,I16]', t => {
  const box = fixture(t);
  assert.equal(box.cli('init').code, 0);
  box.git('add', '-A'); box.git('commit', '-q', '-m', 'chore: initialize isolated board');
  const added = box.cli('add', 'coordinator', 'Proof with a nested agent worktree', '--criterion', 'the clean coordinator can submit');
  assert.equal(added.code, 0);
  const id = String(added.document.item.item_id);
  assert.equal(box.cli('claim', id).code, 0);
  mkdirSync(join(box.root, 'docs'));
  writeFileSync(join(box.root, 'docs/proof.txt'), 'actual coordinator work\n');
  box.git('add', 'docs/proof.txt'); box.git('commit', '-q', '-m', 'chore: add the coordinator proof');
  box.git('worktree', 'add', '-q', '-b', 'agent/scratch', '.claude/worktrees/scratch', 'HEAD');
  assert.equal(box.git('status', '--porcelain'), '', 'the real nested checkout adds no untracked paths');
  const submitted = box.cli('submit', id);
  assert.equal(submitted.code, 0, JSON.stringify(submitted.document));
  assert.equal(submitted.document.id, Number(id));
  assert.equal(submitted.document.gate.green, true);
});
