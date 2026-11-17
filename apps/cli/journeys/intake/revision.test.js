/** @pullboard-test-input packages/kernel/src/logic/seal.js */
/** Outside pull request revision and owner-hold intake cases split from main.test.js [V1,V3,B26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import {
  advanceOutsideFixture,
  fixtureJSON,
  intakeFixture,
} from "../../tests/fixtures/intake.js";

/** Parse a private native refusal without treating transport stand-ins as execution evidence. */
function refusal(result, expected) {
  assert.notEqual(result.code, 0, 'the unsafe operation must refuse');
  assert.equal(JSON.parse(result.out || result.err).error.code, expected, result.out + result.err);
}

test('a returned outside pull request cannot be claimed as native build work [V1,V3]', async t => {
  // The bar's test path must exist on trusted main, or the claim refuses BAR_PATH_MISSING first.
  const box = intakeFixture(t, { baseFiles: { 'test/contribution.test.js': "import { test } from 'node:test';\ntest('trusted placeholder', () => {});\n" } });
  const filed = fixtureJSON(box, box.repo, 'intake', box.pull.html_url, '--criterion', 'the fixture behavior works', '--check', 'node --test test/contribution.test.js');
  const id = String(filed.item.item_id);
  fixtureJSON(box, box.repo, 'reopen', id, '--note', 'outside author must revise its pull request');
  refusal(await runCliInProcess(['claim', id, '--json'], { cwd: box.web, env: box.env }), 'OUTSIDE_NATIVE_BUILD');
  const item = fixtureJSON(box, box.repo, 'show', id);
  assert.equal(item.item_status, 'open');
  assert.equal(item.item_built_by, 'outside:github:outside-contributor');
});

test('an outside author revision is re-intaken only after normal return and clears exact-commit approval [V1,V3,B26]', async t => {
  const box = intakeFixture(t);
  const filed = fixtureJSON(box, box.repo, 'intake', box.pull.html_url, '--criterion', 'the fixture behavior works', '--check', 'node --test test/contribution.test.js');
  const id = String(filed.item.item_id);
  fixtureJSON(box, box.repo, 'intake', 'approve', id);
  const next = advanceOutsideFixture(box, 'apps/relay/src/io/deploy/outside.js', 'export const outside = "revised owned fixture";\n');
  refusal(await runCliInProcess(['intake', box.pull.html_url, '--criterion', 'the fixture behavior works', '--check', 'node --test test/contribution.test.js', '--json'], { cwd: box.repo, env: box.env }), 'OUTSIDE_HEAD_CHANGED');
  assert.equal(fixtureJSON(box, box.repo, 'show', id).item_commit, box.commit, 'source refresh cannot replace an active submission');
  fixtureJSON(box, box.repo, 'reopen', id, '--note', 'outside author supplied a new exact head');
  const refreshed = fixtureJSON(box, box.repo, 'intake', box.pull.html_url, '--criterion', 'the fixture behavior works', '--check', 'node --test test/contribution.test.js');
  assert.equal(refreshed.item.item_id, Number(id));
  assert.equal(refreshed.item.item_status, 'submitted');
  assert.equal(refreshed.item.item_commit, next.commit);
  assert.equal(refreshed.item.item_tree, next.tree);
  assert.equal(refreshed.item.outside.ownerApproval, null, 'the old owner approval never authorizes the new source commit');
  assert.equal(refreshed.item.outside.sandbox, null, 'the new outside head must be executed in the sandbox again');
});


test('outside process-execution detection and unreadable files explain their owner holds [B26,V3]', t => {
  const box = intakeFixture(t);
  advanceOutsideFixture(box, 'lib/plain.js', "import { execFile } from 'node:child_process'; export const run = () => execFile('true');\n", ['apps/relay/src/io/deploy/outside.js']);
  advanceOutsideFixture(box, 'assets/opaque.bin', Buffer.from([0, 255, 254]));
  const filed = fixtureJSON(box, box.repo, 'intake', box.pull.html_url, '--criterion', 'the fixture behavior works', '--check', 'node --test test/contribution.test.js');
  const reasons = filed.item.outside.sensitivity;
  assert.ok(reasons.some(reason => reason.path === 'lib/plain.js' && reason.rule === 'new-process-execution'));
  assert.ok(reasons.some(reason => reason.path === 'assets/opaque.bin' && reason.rule === 'unreadable-changed-file'));
});
