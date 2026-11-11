/** Setup preserves local ignore rules and excludes real nested agent worktrees [I1,I2,I16]. */
import assert from 'node:assert/strict';
import {
  runFixtureChild,
  runFixtureGit,
  startFixtureChild,
} from '../../tests/fixtures/child.js';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import { test } from 'node:test';
import { SETUP_COMMIT_QUESTION } from '../../index.js';
import { RELAY_OFFER_QUESTION } from '../../index.js';
import {
  AGENT_SHELL_MARKERS,
  SSH_SHELL_MARKERS,
} from '../../../../packages/kernel/index.js';

/** Create a private Git repo whose installed hooks invoke this candidate CLI only. */
function fixture(t, ignore) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-init-ignore-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'repo'); const bin = join(directory, 'bin');
  mkdirSync(root); mkdirSync(bin);
  const cliPath = resolve(import.meta.dirname, '../../pullboard.js');
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec "${process.execPath}" "${cliPath}" "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const env = { ...process.env, HOME: join(directory, 'home'), PULLBOARD_HOME: join(directory, 'board-home'), PULLBOARD_MACHINE_HOME: join(directory, 'machine-home'), PATH: bin + ':' + process.env.PATH };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  delete env.PULLBOARD_RELAY_TOKEN;
  Object.assign(env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Init Fixture', GIT_AUTHOR_EMAIL: 'init@example.com', GIT_COMMITTER_NAME: 'Init Fixture', GIT_COMMITTER_EMAIL: 'init@example.com' });
  /** Run actual Git and its installed hooks, requiring success. */
  function git(...args) {
    return runFixtureGit(args, { cwd: root, env, encoding: 'utf8' });
  }
  /** Invoke the real command and retain its typed result, including refusals. */
  function cli(...args) {
    const result = runFixtureChild(process.execPath, [cliPath, ...args, '--json'], { cwd: root, env, encoding: 'utf8' });
    return { code: result.status, document: JSON.parse(result.stdout), stderr: result.failure ?? result.stderr, failure: result.failure };
  }
  /** Run the real CLI in its person-facing output mode. */
  function output(...args) {
    const personEnv = { ...env };
    for (const marker of AGENT_SHELL_MARKERS) delete personEnv[marker];
    const result = runFixtureChild(process.execPath, [cliPath, ...args], { cwd: root, env: personEnv, encoding: 'utf8' });
    return { code: result.status, stdout: result.stdout, stderr: result.failure ?? result.stderr, failure: result.failure };
  }
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Init Fixture'); git('config', 'user.email', 'init@example.com');
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ gate: 'true', lanes: { web: { owns: ['web/'], specs: [] } } }));
  if (ignore !== undefined) writeFileSync(join(root, '.gitignore'), ignore);
  return { root, git, cli, output, env };
}

test('init commits its setup files before the first worktree [I1,I2]', t => {
  const box = fixture(t);
  rmSync(join(box.root, 'pullboard.json'));
  for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) delete box.env[key];
  box.git('config', 'user.name', 'Repository Owner');
  box.git('config', 'user.email', 'owner@example.invalid');
  writeFileSync(join(box.root, 'README.md'), '# Existing repository\n');
  box.git('add', 'README.md');
  box.git('commit', '-q', '-m', 'chore: create the repository');
  const original = box.git('rev-parse', 'HEAD');
  writeFileSync(join(box.root, 'README.md'), '# Existing repository\nA separate staged change.\n');
  box.git('add', 'README.md');
  writeFileSync(join(box.root, 'unrelated.txt'), 'A local note, outside setup.\n');
  const staged = box.git('diff', '--cached', '--binary');
  const initialized = box.cli('init', '--blueprint', 'web-app', '--yes');
  assert.equal(initialized.code, 0, initialized.stderr);
  const setup = box.git('rev-parse', 'HEAD');
  assert.notEqual(setup, original, 'the single confirmation commits setup before an agent opens its worktree');
  assert.equal(box.git('show', 'HEAD:README.md'), '# Existing repository', 'the commit excludes the staged user change');
  assert.equal(box.git('diff', '--cached', '--binary'), staged, 'the existing index stays exactly as the user left it');
  assert.equal(readFileSync(join(box.root, 'unrelated.txt'), 'utf8'), 'A local note, outside setup.\n');
  assert.doesNotMatch(box.git('ls-tree', '-r', '--name-only', 'HEAD'), /^unrelated\.txt$/mu);
  assert.equal(box.git('log', '-1', '--format=%an <%ae>'), 'Repository Owner <owner@example.invalid>');
  assert.equal(box.git('show', 'HEAD:SPEC.md'), readFileSync(join(box.root, 'SPEC.md'), 'utf8').trimEnd(),
    'the setup commit includes the blueprint rows written after the initial setup files');
  const joined = box.cli('worktree', 'review', '--model', 'Setup fixture');
  assert.equal(joined.code, 0, joined.stderr);
  assert.equal(box.git('-C', joined.document.path, 'rev-parse', 'HEAD'), setup);
  const again = box.cli('init', '--yes');
  assert.equal(again.code, 0, again.stderr);
  assert.equal(box.git('rev-parse', 'HEAD'), setup, 'repeating init never creates an empty setup commit');
  assert.equal(box.git('diff', '--cached', '--binary'), staged);
});

test('setup confirmation keeps the index when Git identity is missing and retries after repair [I1,I2]', t => {
  const box = fixture(t);
  rmSync(join(box.root, 'pullboard.json'));
  for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) delete box.env[key];
  box.git('config', '--unset', 'user.name'); box.git('config', '--unset', 'user.email');
  writeFileSync(join(box.root, 'README.md'), '# User staging\n');
  box.git('add', 'README.md');
  const staged = box.git('diff', '--cached', '--binary');
  const failed = box.cli('init', '--yes');
  assert.equal(failed.code, 1);
  assert.equal(failed.document.error.code, 'NOT_COMMITTED');
  assert.match(failed.document.error.next, /pullboard init --yes/u);
  assert.equal(box.git('diff', '--cached', '--binary'), staged, 'a refused commit leaves the existing index alone');
  box.git('config', 'user.name', 'Repaired Owner');
  box.git('config', 'user.email', 'repaired@example.invalid');
  const repaired = box.cli('init', '--yes');
  assert.equal(repaired.code, 0, repaired.stderr);
  assert.equal(box.git('diff', '--cached', '--binary'), staged, 'the first setup commit also leaves user staging alone');
  assert.equal(box.git('log', '-1', '--format=%an <%ae>'), 'Repaired Owner <repaired@example.invalid>');
  assert.doesNotMatch(box.git('ls-tree', '-r', '--name-only', 'HEAD'), /^README\.md$/mu);
  assert.equal(box.cli('worktree', 'review', '--model', 'Repaired fixture').code, 0);
});

test('setup confirmation does not adopt a later user edit to a generated file [I1,I2]', t => {
  const box = fixture(t);
  rmSync(join(box.root, 'pullboard.json'));
  assert.equal(box.cli('init').code, 0);
  const file = join(box.root, 'SPEC.md');
  const edited = readFileSync(file, 'utf8') + '\nA later user note.\n';
  writeFileSync(file, edited);
  const confirmed = box.cli('init', '--yes');
  assert.equal(confirmed.code, 0, confirmed.stderr);
  assert.equal(readFileSync(file, 'utf8'), edited);
  assert.doesNotMatch(box.git('ls-tree', '-r', '--name-only', 'HEAD'), /^SPEC\.md$/mu,
    'the unchanged-write receipt cannot authorize a later user edit');
});

test('setup confirmation leaves a later executable-mode edit uncommitted [I1,I2]', t => {
  const box = fixture(t);
  rmSync(join(box.root, 'pullboard.json'));
  assert.equal(box.cli('init', '--yes').code, 0);
  const head = box.git('rev-parse', 'HEAD');
  const file = join(box.root, 'SPEC.md');
  chmodSync(file, 0o755);
  assert.match(box.git('diff', '--summary'), /mode change/u);
  const repeated = box.cli('init', '--yes');
  assert.equal(repeated.code, 0, repeated.stderr);
  assert.equal(box.git('rev-parse', 'HEAD'), head, 'setup must not commit the user permission change');
  assert.equal(statSync(file).mode & 0o111, 0o111, 'the user permission edit stays in the worktree');
  assert.match(box.git('diff', '--summary'), /mode change/u);
});

test('setup confirmation preserves a different version staged from its saved working bytes [I1,I2]', t => {
  const box = fixture(t);
  rmSync(join(box.root, 'pullboard.json'));
  writeFileSync(join(box.root, 'README.md'), '# Existing repository\n');
  box.git('add', 'README.md'); box.git('commit', '-q', '-m', 'chore: initial repository');
  assert.equal(box.cli('init').code, 0);
  const file = join(box.root, 'SPEC.md'), original = readFileSync(file, 'utf8');
  const staged = original + '\nA note held only in the index.\n';
  writeFileSync(file, staged); box.git('add', 'SPEC.md');
  writeFileSync(file, original);
  const before = box.git('diff', '--cached', '--binary', '--', 'SPEC.md');
  const confirmed = box.cli('init', '--yes');
  assert.equal(confirmed.code, 0, confirmed.stderr);
  assert.equal(box.git('show', ':SPEC.md'), staged.trimEnd(), 'the distinct staged version survives');
  assert.equal(box.git('diff', '--cached', '--binary', '--', 'SPEC.md'), before, 'the staged patch remains exact');
  assert.equal(readFileSync(file, 'utf8'), original, 'the working version remains exact too');
});

/** Run a real terminal confirmation, staging the caller's change only after the question appears. */
async function confirmSetupAfter(t, box, beforeEnter) {
  const env = { ...box.env, SHELL: '/bin/sh', PULLBOARD_VIEW_BACKGROUND: '0' };
  for (const marker of [...AGENT_SHELL_MARKERS, ...SSH_SHELL_MARKERS, 'CI']) delete env[marker];
  const word = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const cli = resolve(import.meta.dirname, '../../pullboard.js');
  const inner = `${word(process.execPath)} ${word(cli)} init; echo "pty-exit:$?"`;
  const script = process.platform === 'darwin' ? ['-q', '/dev/null', '/bin/sh', '-c', inner] : ['-qec', inner, '/dev/null'];
  const child = startFixtureChild('/bin/sh', ['-c', '/bin/cat | /usr/bin/script "$@"', 'sh', ...script],
    { cwd: box.root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
  let output = '', entered = false, closed = false;
  child.stdout.setEncoding('utf8').on('data', part => {
    output += part;
    if (!entered && output.includes(SETUP_COMMIT_QUESTION.trim())) {
      entered = true; beforeEnter(); child.stdin.write('\r');
    }
    if (!closed && (output.includes(RELAY_OFFER_QUESTION.trim()) || /pty-exit:\d+/u.test(output))) {
      closed = true; child.stdin.end();
    }
  });
  await new Promise((resolveRun, reject) => { child.once('error', reject); child.once('close', resolveRun); });
  return { entered, output, code: Number(/pty-exit:(\d+)/u.exec(output)?.[1]) };
}

test('setup confirmation preserves an index-only edit made while the prompt is open [I1,I2]', { timeout: 30_000 }, async t => {
  const box = fixture(t);
  rmSync(join(box.root, 'pullboard.json'));
  writeFileSync(join(box.root, 'README.md'), '# Existing repository\n');
  box.git('add', 'README.md'); box.git('commit', '-q', '-m', 'chore: initial repository');
  assert.equal(box.output('init').code, 0);
  const head = box.git('rev-parse', 'HEAD'), file = join(box.root, 'SPEC.md');
  const original = readFileSync(file, 'utf8'), staged = original + '\nA note staged during confirmation.\n';
  let before;
  const confirmed = await confirmSetupAfter(t, box, () => {
    writeFileSync(file, staged); box.git('add', 'SPEC.md'); writeFileSync(file, original);
    before = box.git('diff', '--cached', '--binary');
  });
  assert.equal(confirmed.entered, true, 'the actual human question appeared before the index changed');
  assert.equal(box.git('show', ':SPEC.md'), staged.trimEnd(), 'the new index-only version survives Enter');
  assert.equal(box.git('diff', '--cached', '--binary'), before, 'the whole staged patch remains exact');
  assert.equal(readFileSync(file, 'utf8'), original, 'the working version remains exact too');
  assert.equal(box.git('rev-parse', 'HEAD'), head, 'a stale confirmation commits nothing');
  assert.equal(confirmed.code, 1, confirmed.output);
  assert.match(confirmed.output, /\[NOT_COMMITTED\].*staged differently while confirmation was open/u);
});

test('setup commits use repository identity despite inherited agent identity [I1,I2]', t => {
  const box = fixture(t);
  rmSync(join(box.root, 'pullboard.json'));
  box.git('config', 'user.name', 'Repository Owner'); box.git('config', 'user.email', 'owner@example.invalid');
  Object.assign(box.env, { GIT_AUTHOR_NAME: 'Inherited Agent', GIT_AUTHOR_EMAIL: 'agent@example.invalid',
    GIT_COMMITTER_NAME: 'Inherited Agent', GIT_COMMITTER_EMAIL: 'agent@example.invalid', EMAIL: 'agent@example.invalid' });
  const configured = box.git('config', '--local', '--get-regexp', '^user\\.');
  const initialized = box.cli('init', '--yes');
  assert.equal(initialized.code, 0, initialized.stderr);
  assert.equal(box.git('log', '-1', '--format=%an <%ae> / %cn <%ce>'),
    'Repository Owner <owner@example.invalid> / Repository Owner <owner@example.invalid>', 'both identities come from this repository');
  assert.equal(box.git('config', '--local', '--get-regexp', '^user\\.'), configured, 'setup never changes repository identity settings');
});

test('a fresh init tells the person and the agent how to start [I9,I1]', t => {
  const box = fixture(t);
  rmSync(join(box.root, 'pullboard.json'));
  const initialized = box.output('init', '--verbose');
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

test('init summarizes setup before one final next step [I1,I2,B26]', t => {
  const box = fixture(t);
  rmSync(join(box.root, 'pullboard.json'));
  const initialized = box.output('init');
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

test('init appends only the agent-worktree ignore rule and the second init writes nothing [I1,I2,I16]', t => {
  for (const previous of [undefined, '', '# existing rules\r\nnode_modules/\r\n!keep-this', '.claude/worktrees/\n# already configured\n']) {
    const box = fixture(t, previous);
    const first = box.cli('init');
    assert.equal(first.code, 0, JSON.stringify(first.document));
    const file = join(box.root, '.gitignore');
    const expected = previous?.split(/\r?\n/u).includes('.claude/worktrees/') ? previous : (previous ?? '') + (previous && !previous.endsWith('\n') ? '\n' : '') + '.claude/worktrees/\n';
    assert.equal(readFileSync(file, 'utf8'), expected, 'every previous byte stays intact');
    assert.ok(first.document.notes.some(note => note.includes('.gitignore')));
    const setupFiles = ['.gitignore', '.git/config', 'AGENTS.md', '.githooks/pre-commit', '.githooks/pre-merge-commit', '.githooks/commit-msg', '.githooks/pre-push'];
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
  box.git('add', 'docs/proof.txt'); box.git('commit', '-q', '-m', 'chore: add the coordinator proof', '-m', `Pullboard-Item: #${id}`);
  box.git('worktree', 'add', '-q', '-b', 'agent/scratch', '.claude/worktrees/scratch', 'HEAD');
  assert.equal(box.git('status', '--porcelain'), '', 'the real nested checkout adds no untracked paths');
  const submitted = box.cli('submit', id);
  assert.equal(submitted.code, 0, JSON.stringify(submitted.document));
  assert.equal(submitted.document.id, Number(id));
  assert.equal(submitted.document.gate.green, true);
});
