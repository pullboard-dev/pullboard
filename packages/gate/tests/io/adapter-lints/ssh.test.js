/** @pullboard-test-input source-cell gate */
/** The ssh lint names a direct ssh spawn outside the SSH runner adapter and holds today's offenders at a ceiling [C7,#11374]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../fixtures/child.js';
import {
  SSH_CEILING_FILE,
  sshLintRows,
} from '../../../src/io/adapter-lints/ssh.js';

/** A scratch repo holding `files`, with an optional ceilings file. */
function repo(files, ceilings) {
  const tree = privateFixtureFiles('pb-sshlint-');
  for (const [path, text] of Object.entries(files)) tree.write(path, text);
  if (ceilings) tree.write(SSH_CEILING_FILE, JSON.stringify({ version: 1, files: ceilings }));
  return tree.root;
}

test('gate.io-adapter-lints-ssh.with-the-setting-on-a-spawn: clause 1: with the setting on, a file outside the SSH runner adapter spawning ssh fails naming file, line and adapter [C7,#11374]', () => {
  const root = repo({
    'packages/a/src/x.js': "export const a = 1;\nconst child = spawn('ssh', ['-T', host]);\nconst viaParameter = (ssh = 'ssh') => spawnFn(ssh, args);\n",
    'packages/runners/src/io/adapter/ssh.js': "const child = spawn('ssh', args);\n",
  });
  const rows = sshLintRows(root, { enabled: true });
  assert.equal(rows.length, 2);
  assert.match(rows[0], /^packages\/a\/src\/x\.js:2: spawn\('ssh' spawns ssh outside the SSH runner adapter/u);
  assert.match(rows[1], /^packages\/a\/src\/x\.js:3: spawnFn\(ssh spawns ssh outside the SSH runner adapter/u);
  assert.ok(rows.every(row => row.includes('use the SSH runner adapter in packages/runners/src/io/adapter/ssh.js')));
  assert.ok(rows.every(row => !row.startsWith('packages/runners/src/io/adapter/ssh.js')), 'the SSH runner adapter is exempt');
});

test('gate.io-adapter-lints-ssh.comments-tests-and-other-commands-are: clause 1: comments, tests and spawns of other commands are not ssh spawns [C7,#11374]', () => {
  const root = repo({
    'packages/a/src/x.js': "// spawn('ssh', args);\nconst a = spawn('ssh-keygen', args);\nconst b = spawn('git', ['status']);\nconst c = /x/u.exec('ssh');\nconst d = spawn(ssh, args);\n",
    'packages/a/tests/x.test.js': "spawn('ssh', args);\n",
  });
  assert.deepEqual(sshLintRows(root, { enabled: true }), []);
});

test('gate.io-adapter-lints-ssh.offenders-at-their-ceiling-pass-and: clause 2: offenders at their ceiling pass and one more ssh spawn in the same file fails; the ceiling never rises [C7,#11374]', () => {
  const files = { 'packages/a/src/x.js': "spawn('ssh', a);\nexecFile('ssh', b);\n", 'packages/b/src/y.js': "exec('ssh', a);\n" };
  const root = repo(files, { 'packages/a/src/x.js': 2 });
  const rows = sshLintRows(root, { enabled: true });
  assert.deepEqual(rows.map(row => row.split(':')[0]), ['packages/b/src/y.js'], 'a file past its ceiling (zero for an unlisted file) fails');
  const grown = repo({ 'packages/a/src/x.js': "spawn('ssh', a);\nexecFile('ssh', b);\nspawnSync('ssh', c);\n" }, { 'packages/a/src/x.js': 2 });
  assert.equal(sshLintRows(grown, { enabled: true }).length, 3);
});

test('gate.io-adapter-lints-ssh.with-the-setting-off-which-is: clause 2: with the setting off, which is the default, the lint reports nothing [C7,#11374]', () => {
  const root = repo({ 'packages/a/src/x.js': "spawn('ssh', a);\n" });
  assert.deepEqual(sshLintRows(root), []);
  assert.deepEqual(sshLintRows(root, { enabled: false }), []);
  assert.deepEqual(sshLintRows(root, { enabled: 'yes' }), []);
});
