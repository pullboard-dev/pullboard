/** @pullboard-test-input source-cell packages/spec */
/** With spec.commitOnApply on, applying a decided row commits only the spec file and signoff receipts under the person; dirty or off, nothing is committed [C7,#1310,#9346]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../../gate/tests/fixtures/child.js';
import { fixtureCommitAll } from '../../../gate/tests/fixtures/testkit.js';
import { commitAppliedRows } from '../../index.js';

const BEFORE = '# Spec\n\n## G · Goals\n\n- G1 [draft, must] Existing row. | gate: review\n';
const AFTER = BEFORE.replace('[draft, must]', '[approved, must]');
const PERSON = { name: 'Pat Person', email: 'pat@example.test' };
const ROW = { id: 'G1', decision: 'approve' };
const PLAN = () => ({ files: [{ file: 'SPEC.md', before: BEFORE, after: AFTER }], signoffs: { before: null, receipts: [{ id: 'G1', signature: 'sig-1' }] } });

/** A clean real checkout with SPEC.md committed. */
function checkout() {
  const files = privateFixtureFiles('pullboard-apply-commit-');
  files.write('SPEC.md', BEFORE);
  fixtureCommitAll(files.root);
  const git = (...args) => runFixtureGit(args, { cwd: files.root });
  /** The injected git: the committer identity rides on the command, as a caller's own git config would supply it. */
  const io = { git: (args) => runFixtureGit(['-c', 'user.name=Coordinator', '-c', 'user.email=coordinator@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd: files.root }) };
  return { files, git, io };
}

test('clause 1: with spec.commitOnApply on and a clean checkout, an approved row is written and committed once by the person with only the spec file and signoff receipts [C7,#9346]', () => {
  const { files, git, io } = checkout();
  const result = commitAppliedRows(files.root, PLAN(), { enabled: true, row: ROW, person: PERSON }, io);
  assert.equal(result.committed, true);
  assert.equal(readFileSync(join(files.root, 'SPEC.md'), 'utf8'), AFTER);
  assert.equal(git('rev-list', '--count', 'HEAD'), '2', 'exactly one new commit');
  assert.equal(git('log', '-1', '--format=%an <%ae>'), 'Pat Person <pat@example.test>');
  assert.equal(git('log', '-1', '--format=%s'), 'spec: approve G1');
  assert.deepEqual(git('show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['.pullboard/signoffs.jsonl', 'SPEC.md']);
  assert.equal(git('status', '--porcelain'), '', 'the checkout is clean again');
});

test('clause 2: with a dirty checkout nothing is written or committed and the refusal names the one command left [C7,#9346]', () => {
  const { files, git, io } = checkout();
  files.write('notes.txt', 'unrelated work');
  assert.throws(() => commitAppliedRows(files.root, PLAN(), { enabled: true, row: ROW, person: PERSON }, io), (error) => {
    assert.equal(error.code, 'APPLY_NOT_COMMITTED');
    assert.match(error.message, /uncommitted changes/u);
    assert.match(error.next ?? '', /^pullboard spec apply/u);
    return true;
  });
  assert.equal(readFileSync(join(files.root, 'SPEC.md'), 'utf8'), BEFORE, 'SPEC.md is unchanged');
  assert.equal(git('rev-list', '--count', 'HEAD'), '1', 'no commit');
});

test('clause 2: with the setting off, nothing is written and nothing is committed [C7,#9346]', () => {
  const { files, git, io } = checkout();
  assert.deepEqual(commitAppliedRows(files.root, PLAN(), { enabled: false, row: ROW, person: PERSON }, io), { committed: false });
  assert.equal(readFileSync(join(files.root, 'SPEC.md'), 'utf8'), BEFORE);
  assert.equal(git('rev-list', '--count', 'HEAD'), '1');
});
