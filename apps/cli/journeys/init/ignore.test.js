/** Setup preserves local ignore rules and excludes real nested agent worktrees [I1,I2,I16]. */
import assert from 'node:assert/strict';
import { startFixtureChild } from '../../tests/fixtures/child.js';
import {
  chmodSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import { test } from 'node:test';
import { fixture } from '../../tests/fixtures/init/ignore-box.js';
import { SETUP_COMMIT_QUESTION } from '../../index.js';
import { RELAY_OFFER_QUESTION } from '../../index.js';
import {
  AGENT_SHELL_MARKERS,
  SSH_SHELL_MARKERS,
} from '../../../../packages/kernel/index.js';

test('init commits its setup files before the first worktree [I1,I2]', async t => {
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
  const initialized = await box.invoke('init', '--blueprint', 'web-app', '--yes');
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
  const joined = await box.invoke('worktree', 'review', '--model', 'Setup fixture');
  assert.equal(joined.code, 0, joined.stderr);
  assert.equal(box.git('-C', joined.document.path, 'rev-parse', 'HEAD'), setup);
  const again = await box.invoke('init', '--yes');
  assert.equal(again.code, 0, again.stderr);
  assert.equal(box.git('rev-parse', 'HEAD'), setup, 'repeating init never creates an empty setup commit');
  assert.equal(box.git('diff', '--cached', '--binary'), staged);
});

test('setup confirmation keeps the index when Git identity is missing and retries after repair [I1,I2]', async t => {
  const box = fixture(t);
  rmSync(join(box.root, 'pullboard.json'));
  for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) delete box.env[key];
  box.git('config', '--unset', 'user.name'); box.git('config', '--unset', 'user.email');
  writeFileSync(join(box.root, 'README.md'), '# User staging\n');
  box.git('add', 'README.md');
  const staged = box.git('diff', '--cached', '--binary');
  const failed = await box.invoke('init', '--yes');
  assert.equal(failed.code, 1);
  assert.equal(failed.document.error.code, 'NOT_COMMITTED');
  assert.match(failed.document.error.next, /pullboard init --yes/u);
  assert.equal(box.git('diff', '--cached', '--binary'), staged, 'a refused commit leaves the existing index alone');
  box.git('config', 'user.name', 'Repaired Owner');
  box.git('config', 'user.email', 'repaired@example.invalid');
  const repaired = await box.invoke('init', '--yes');
  assert.equal(repaired.code, 0, repaired.stderr);
  assert.equal(box.git('diff', '--cached', '--binary'), staged, 'the first setup commit also leaves user staging alone');
  assert.equal(box.git('log', '-1', '--format=%an <%ae>'), 'Repaired Owner <repaired@example.invalid>');
  assert.doesNotMatch(box.git('ls-tree', '-r', '--name-only', 'HEAD'), /^README\.md$/mu);
  assert.equal((await box.invoke('worktree', 'review', '--model', 'Repaired fixture')).code, 0);
});

test('setup confirmation does not adopt a later user edit to a generated file [I1,I2]', async t => {
  const box = fixture(t);
  rmSync(join(box.root, 'pullboard.json'));
  assert.equal((await box.invoke('init')).code, 0);
  const file = join(box.root, 'SPEC.md');
  const edited = readFileSync(file, 'utf8') + '\nA later user note.\n';
  writeFileSync(file, edited);
  const confirmed = await box.invoke('init', '--yes');
  assert.equal(confirmed.code, 0, confirmed.stderr);
  assert.equal(readFileSync(file, 'utf8'), edited);
  assert.doesNotMatch(box.git('ls-tree', '-r', '--name-only', 'HEAD'), /^SPEC\.md$/mu,
    'the unchanged-write receipt cannot authorize a later user edit');
});

test('setup confirmation leaves a later executable-mode edit uncommitted [I1,I2]', async t => {
  const box = fixture(t);
  rmSync(join(box.root, 'pullboard.json'));
  assert.equal((await box.invoke('init', '--yes')).code, 0);
  const head = box.git('rev-parse', 'HEAD');
  const file = join(box.root, 'SPEC.md');
  chmodSync(file, 0o755);
  assert.match(box.git('diff', '--summary'), /mode change/u);
  const repeated = await box.invoke('init', '--yes');
  assert.equal(repeated.code, 0, repeated.stderr);
  assert.equal(box.git('rev-parse', 'HEAD'), head, 'setup must not commit the user permission change');
  assert.equal(statSync(file).mode & 0o111, 0o111, 'the user permission edit stays in the worktree');
  assert.match(box.git('diff', '--summary'), /mode change/u);
});

test('setup confirmation preserves a different version staged from its saved working bytes [I1,I2]', async t => {
  const box = fixture(t);
  rmSync(join(box.root, 'pullboard.json'));
  writeFileSync(join(box.root, 'README.md'), '# Existing repository\n');
  box.git('add', 'README.md'); box.git('commit', '-q', '-m', 'chore: initial repository');
  assert.equal((await box.invoke('init')).code, 0);
  const file = join(box.root, 'SPEC.md'), original = readFileSync(file, 'utf8');
  const staged = original + '\nA note held only in the index.\n';
  writeFileSync(file, staged); box.git('add', 'SPEC.md');
  writeFileSync(file, original);
  const before = box.git('diff', '--cached', '--binary', '--', 'SPEC.md');
  const confirmed = await box.invoke('init', '--yes');
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
  assert.equal((await box.output('init')).code, 0);
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
