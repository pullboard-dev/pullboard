/** A trunk test-defect hold lifts when the named cases pass in a recorded run at the trunk tip [C7]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../../apps/cli/tests/fixtures/child.js';
import { runFixtureChild } from '../../../../../apps/cli/tests/fixtures/child.js';
import { fixtureOpenBoard } from '../../../../../apps/cli/tests/fixtures/testkit.js';
import { closeBoard } from '../../../../store/index.js';
import { heldTestDefects } from '../../../src/io/step/selection.js';

const TEST = 'test/held.test.js';

/** A repository where the code is fixed at trunk B and the held test file is never touched. */
function repo() {
  const fixture = privateFixtureFiles('pullboard-defect-release-'), root = fixture.root;
  const vcs = (...args) => runFixtureChild('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, encoding: 'utf8' }).stdout.trim();
  vcs('init', '-q', '-b', 'main');
  fixture.write(TEST, "test('case one', () => {});\n");
  fixture.write('code.js', 'export const broken = true;\n');
  vcs('add', '.'); vcs('commit', '-qm', 'trunk A');
  const blob = vcs('rev-parse', `HEAD:${TEST}`), trunkA = vcs('rev-parse', 'HEAD');
  fixture.write(TEST, "test('case one', () => {});\n// candidate-only edit\n");
  const candidateBlob = vcs('hash-object', '-w', TEST);
  fixture.write(TEST, "test('case one', () => {});\n");
  fixture.write('code.js', 'export const broken = false;\n');
  vcs('commit', '-qam', 'trunk B: code fix only');
  return { root, blob, candidateBlob, trunkA, trunkB: vcs('rev-parse', 'HEAD') };
}

test('clause 1: a defect is released by a recorded green run of its test at the trunk tip, and only by a run naming its cases passing [C7]', t => {
  const { root, blob, trunkB } = repo();
  const board = fixtureOpenBoard({ boardFile: join(privateFixtureFiles('pullboard-defect-release-board-').root, 'board.sqlite') });
  t.after(() => closeBoard(board));
  const ports = { quarantineWaivers: () => [] };
  const trunk = { branch: 'refs/heads/main', commit: trunkB };
  const defect = { branch: trunk.branch, test: TEST, blob, trunkBlob: blob, names: ['case one'] };
  const held = comparison => heldTestDefects(root, board, trunk, ports, { defects: () => [defect], comparison }).length;
  const signed = name => ({ file: TEST, name, signature: 'a'.repeat(64) });
  assert.equal(held(() => ({ files: [] })), 1, 'no recorded run leaves the hold');
  assert.equal(held(() => ({ files: [{ file: TEST, result: 'green' }] })), 0, 'a green run at the trunk tip lifts it');
  assert.equal(held(() => ({ files: [{ file: TEST, result: 'red', signatureVersion: 1, failures: [signed('case one')] }] })), 1, 'a run still failing the case keeps it');
  assert.equal(held(() => ({ files: [{ file: TEST, result: 'red', signatureVersion: 1, failures: [signed('another case')] }] })), 1, 'a red run whose failures use an unreadable version keeps it');
  assert.equal(held(() => { throw new Error('cache unreadable'); }), 1, 'an unreadable cache keeps it');
});

test('clause 2: defect recorded at trunk A, code fix lands as trunk B without touching the test: a green run at B lifts the hold, none keeps it [C7]', async t => {
  const { root, blob, trunkA, trunkB } = repo();
  const { MAIN_FAILURE_SIGNATURE_VERSION } = await import('../../../src/io/main/matches.js');
  const board = fixtureOpenBoard({ boardFile: join(privateFixtureFiles('pullboard-defect-release-board-').root, 'board.sqlite') });
  t.after(() => closeBoard(board));
  const ports = { quarantineWaivers: () => [] };
  const defect = { branch: 'refs/heads/main', test: TEST, blob, trunkBlob: blob, names: ['case one'] };
  const at = (commit, files) => heldTestDefects(root, board, { branch: defect.branch, commit }, ports,
    { defects: () => [defect], comparison: (_, asked) => ({ files: asked === commit ? files : [] }) }).length;
  const failing = [{ file: TEST, result: 'red', signatureVersion: MAIN_FAILURE_SIGNATURE_VERSION, failures: [{ file: TEST, name: 'case one', signature: 'b'.repeat(64) }] }];
  assert.equal(at(trunkA, failing), 1, 'at trunk A the recorded red run keeps the hold');
  assert.equal(at(trunkB, []), 1, 'at trunk B with no recorded run the hold stays although the test blob is unchanged');
  assert.equal(at(trunkB, [{ file: TEST, result: 'green' }]), 0, 'a recorded green run of the test at trunk B lifts the hold');
  const otherCase = [{ file: TEST, result: 'red', signatureVersion: MAIN_FAILURE_SIGNATURE_VERSION, failures: [{ file: TEST, name: 'another case', signature: 'c'.repeat(64) }] }];
  assert.equal(at(trunkB, otherCase), 0, 'a run in which only a different case fails shows the defect cases passing');
});

test('a green trunk receipt cannot clear a defect in different candidate-only test bytes [C7]', t => {
  const { root, blob, candidateBlob, trunkB } = repo();
  const board = fixtureOpenBoard({ boardFile: join(privateFixtureFiles('pullboard-defect-candidate-board-').root, 'board.sqlite') });
  t.after(() => closeBoard(board));
  const trunk = { branch: 'refs/heads/main', commit: trunkB };
  const defect = { branch: trunk.branch, test: TEST, blob: candidateBlob, trunkBlob: blob, names: ['case one'] };
  const green = () => ({ files: [{ file: TEST, result: 'green' }] });
  assert.equal(heldTestDefects(root, board, trunk, { quarantineWaivers: () => [] }, { defects: () => [defect], comparison: green }).length, 1,
    'passing the original trunk test does not prove the different candidate test');
});
