/** Setup preserves local ignore rules and excludes real nested agent worktrees [I1,I2,I16]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture } from '../../tests/fixtures/init/ignore-box.js';

test('cli.journeys-init-ignore.init-commits-its-setup-files-before: init commits its setup files before the first worktree [I1,I2]', async t => {
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

test('cli.journeys-init-ignore.setup-confirmation-keeps-the-index-when: setup confirmation keeps the index when Git identity is missing and retries after repair [I1,I2]', async t => {
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
