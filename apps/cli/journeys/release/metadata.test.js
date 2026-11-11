/** Real hook metadata is generated from the board and conflicting author assertions are refused [C7]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from "../../tests/fixtures/e2e.js";
import * as store from "../../../../packages/store/src/io/board.js";
import { openCellBoard as openBoard } from "../../../../packages/store/tests/fixtures/cell.js";
import { submitFixture } from "../../tests/fixtures/board/submit.js";
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { joinFixtureSeat } from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** Establish a real seat claim, with its criterion and row frozen by the public CLI. */
function claimed() {
  const box = e2e.project('true');
  const added = fixtureAdd(box.run, box.repo, 'web', 'Generated metadata', '--criterion', 'the hook checks board state', '--specs', 'G1', '--json');
  assert.equal(added.code, 0, added.err);
  const id = JSON.parse(added.out).item.item_id;
  const claim = box.run(box.web, 'claim', String(id));
  assert.equal(claim.code, 0, claim.err);
  return { ...box, id };
}

/** Invoke the installed hook command on a real message file and retain its resulting bytes. */
function hook(box, message, cwd = box.web) {
  const path = join(box.dir, 'message');
  writeFileSync(path, message);
  const result = box.run(cwd, 'hook', 'commit-msg', path);
  return { ...result, message: readFileSync(path, 'utf8') };
}

test('every real commit under a claim gets generated item and frozen row trailers [C7]', () => {
  const box = claimed();
  const result = e2e.commitFile(box, box.web, 'web/metadata.txt', 'work\n', 'feat(web): retain context [G1]');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(box.git(box.web, 'log', '-1', '--format=%B').trim(), `feat(web): retain context [G1]\n\nPullboard-Item: #${box.id}\nPullboard-Rows: G1`);
});

test('agreed typed trailers are replaced canonically without duplicating them or losing the body [C7]', () => {
  const box = claimed();
  const result = hook(box, `test(web): retain context\n\nThe reason stays.\n\nPullboard-Item: #${box.id}\nPullboard-Rows: G1\n`);
  assert.equal(result.code, 0, result.err);
  assert.equal(result.message, `test(web): retain context\n\nThe reason stays.\n\nPullboard-Item: #${box.id}\nPullboard-Rows: G1\n`);
  assert.equal(hook(box, result.message).message, result.message, 'generating twice writes identical bytes');
});

test('a typed item trailer cannot substitute another item for the seat claim [C7]', () => {
  const box = claimed();
  const input = `test: wrong item\n\nPullboard-Item: #${box.id + 1}\n`;
  const result = hook(box, input);
  assert.notEqual(result.code, 0);
  assert.match(result.err, /Pullboard-Item/u);
  assert.equal(result.message, input, 'a refusal does not silently repair the author assertion');
});

test('typed rows must be the complete frozen set in board order [C7]', () => {
  const box = claimed();
  const result = hook(box, `test: wrong rows\n\nPullboard-Item: #${box.id}\nPullboard-Rows: G2\n`);
  assert.notEqual(result.code, 0);
  assert.match(result.err, /Pullboard-Rows/u);
});

test('an abbreviated header preview must count the actual frozen remainder [C7]', () => {
  const box = claimed();
  for (const preview of ['G1,+0', 'G1,+text', 'G1,+1,G2', 'G1,+2', '+1']) {
    const result = hook(box, `test: wrong preview [${preview}]\n`);
    assert.notEqual(result.code, 0, preview);
    assert.match(result.err, /preview/u);
  }
});

test('reserved, duplicate and non-final Pullboard trailers are refused [C7]', () => {
  const box = claimed();
  for (const trailers of [`Pullboard-Forged: yes`, `Pullboard-Item: #${box.id}\nPullboard-Item: #${box.id}`, `Pullboard-Item: #${box.id}\n\ntext after trailers`, `Signed-off-by: Fixture <fixture@example.com>\nPullboard-Item: #${box.id}`]) {
    const input = `test: bad trailer\n\n${trailers}\n`;
    const result = hook(box, input);
    assert.notEqual(result.code, 0, trailers);
    assert.equal(result.message, input);
  }
});

test('untyped fixup, revert and forged sync headers are refused [C7]', () => {
  const box = claimed();
  for (const header of ['missing type', 'fixup! test: old', 'Revert "old"', 'Merge branch fake']) {
    const result = hook(box, header + '\n');
    assert.notEqual(result.code, 0, header);
    assert.match(result.err, /header/u);
  }
});

test('a real Git sync merge remains exempt even while the seat holds a claim [C7]', () => {
  const box = claimed();
  assert.equal(e2e.commitFile(box, box.repo, 'docs/sync.txt', 'main\n', 'docs: update guide').status, 0);
  assert.equal(e2e.commitFile(box, box.web, 'web/local.txt', 'lane\n', 'test: prepare work').status, 0);
  const merged = box.tryGit(box.web, 'merge', '--no-edit', 'main');
  assert.equal(merged.status, 0, merged.stderr);
  const message = box.git(box.web, 'log', '-1', '--format=%B');
  assert.match(message, /^Merge /u);
  assert.doesNotMatch(message, /Pullboard-/u);
});

test('an unclaimed configuration commit stays typed and carries no item metadata [C7]', () => {
  const box = e2e.project('true');
  const plain = hook(box, 'chore: adjust configuration\n');
  assert.equal(plain.code, 0, plain.err);
  assert.equal(plain.message, 'chore: adjust configuration\n');
  assert.notEqual(hook(box, 'chore: fake attribution\n\nPullboard-Item: #1\n').code, 0);
});

/** Build B5's real two-live-claim state with native lifecycle moves, not direct database edits. */
function twoClaims() {
  const box = claimed();
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    const agentId = store.agentAt(board, box.web).agent_id;
    const reviewer = store.register(board, { lane: 'web', path: join(box.dir, 'metadata-reviewer') });
    const head = box.git(box.web, 'rev-parse', 'HEAD');
    const digest = store.getItem(board, box.id).item_frozen_digest;
    // Synthetic lifecycle input establishes rejection only; no gate execution or independent assurance is claimed.
    submitFixture(board, box.id, { agentId, commit: head, tree: box.git(box.web, 'rev-parse', 'HEAD^{tree}') });
    store.reserveReview(board, box.id, { agentId: reviewer, leaseMs: 3600000, policy: 'any' });
    store.verify(board, box.id, { agentId: reviewer, decision: 'REJECT', reason: 'TEST_FAILURE', clause: 'the hook checks board state',
      note: 'Synthetic rejected-item state for commit association only.', head, digest, policy: 'any', familyPolicy: 'off' });
  } finally { store.closeBoard(board); }
  assert.equal(box.run(box.web, 'claim', String(box.id)).code, 0, 'the builder reclaims its rejected item');
  const added = fixtureAdd(box.run, box.repo, 'web', 'Ordinary parallel claim', '--criterion', 'the second claim is real', '--specs', 'G1', '--json');
  assert.equal(added.code, 0, added.err);
  const other = JSON.parse(added.out).item.item_id;
  const claim = box.run(box.web, 'claim', String(other));
  assert.equal(claim.code, 0, claim.err);
  return { ...box, other };
}

test('two live claims in one checkout refuse typed selection until one is released [B5,C7]', () => {
  const box = twoClaims();
  const inputs = [box.id, box.other].map(id => `test: explicit work\n\nPullboard-Item: #${id}\n`);
  inputs.push('test: ambiguous work\n');
  for (const input of inputs) {
    const ambiguous = hook(box, input);
    assert.notEqual(ambiguous.code, 0, 'typed metadata cannot select either ambiguous live claim');
    for (const id of [box.id, box.other]) assert.ok(ambiguous.err.includes(`#${id}`), 'both live claims are named');
    assert.match(ambiguous.err, /worktree/u);
    assert.match(ambiguous.err, /release/u);
    assert.doesNotMatch(ambiguous.err, /explicit Pullboard-Item/u);
    assert.equal(ambiguous.message, input, 'refusal preserves the message');
  }
  assert.equal(box.run(box.web, 'release', String(box.other), '--reason', 'BLOCKED').code, 0);
  const remaining = hook(box, 'test: unambiguous work\n');
  assert.equal(remaining.code, 0, remaining.err);
  assert.equal(remaining.message, `test: unambiguous work\n\nPullboard-Item: #${box.id}\nPullboard-Rows: G1\n`);
});

test('the hook binds its claim to the current checkout rather than another session seat [B13,C7]', () => {
  const box = claimed();
  const otherRoot = join(box.dir, 'web-2');
  box.git(box.repo, 'worktree', 'add', '-q', otherRoot, '-b', 'web/two');
  const joined = joinFixtureSeat(box, otherRoot, 'web');
  assert.equal(joined.code, 0, joined.err);
  const added = fixtureAdd(box.run, box.repo, 'web', 'Other checkout claim', '--criterion', 'the checkout owns its metadata', '--specs', 'G1', '--json');
  assert.equal(added.code, 0, added.err);
  const other = JSON.parse(added.out).item.item_id;
  const claim = box.run(otherRoot, 'claim', String(other));
  assert.equal(claim.code, 0, claim.err);
  for (const [root, id, foreign] of [[box.web, box.id, other], [otherRoot, other, box.id]]) {
    const generated = hook(box, 'test: current checkout\n', root);
    assert.equal(generated.code, 0, generated.err);
    assert.equal(generated.message, `test: current checkout\n\nPullboard-Item: #${id}\nPullboard-Rows: G1\n`);
    const input = `test: foreign checkout\n\nPullboard-Item: #${foreign}\n`;
    const refused = hook(box, input, root);
    assert.notEqual(refused.code, 0, 'a trailer cannot borrow another checkout claim');
    assert.equal(refused.message, input);
  }
});
