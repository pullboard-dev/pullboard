/** A frozen-check case that fails identically on main at the base submits as a known main red, and verify judges it [V4,B3]. */
import '../../../../index.js'; // This test invokes the real CLI through its public executable.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { openBoard } from '../../../../../lib/index.js';
import { closeBoard } from '../../../../../../packages/store/index.js';
import { runFixtureGit } from '../../../../tests/fixtures/child.js';
import { submitFixture } from '../../../../tests/fixtures/board/submit.js';
import {
  cli,
  fileMainRed,
  fixture,
  reviewer,
  rows,
  settledSubmit,
} from '../../../../tests/fixtures/init/known-frozen.js';


test('verify accepts an identical owned main red and records its exact case [V4,B3]', async t => {
  const box = fixture(t), repair = fileMainRed(box);
  const settled = await settledSubmit(t, box, { submitted: true });
  assert.equal(settled.submission?.gateGreen, true, 'the pulled gate records green over the main-owned case: ' + JSON.stringify(settled.gate));
  const { independent, review } = reviewer(box);
  const accepted = cli(independent, review, 'verify', String(box.item), 'accept', '--note', 'checked the frozen case');
  assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
  const event = rows(box, "SELECT event_detail FROM event WHERE item_id=? AND event_kind='accept' ORDER BY event_id DESC LIMIT 1", box.item)[0];
  const detail = JSON.parse(event.event_detail);
  assert.match(detail.note, /test\/frozen\.test\.js :: frozen case \[G1\]/u);
  assert.equal(detail.knownMainFailures.failures[0].item, repair);
  assert.equal(detail.knownMainFailures.main, box.main);
});

test('verify refuses a frozen failure that is green on main [V4,B3]', t => {
  const box = fixture(t, { main: 1, candidate: 2 });
  fileMainRed(box, ['--accept-green', 'the case is green on main; this repair only proves a distractor does not excuse the head-only red']);
  // @pullboard-board-file journey: the real CLI in this fixture repo owns the board file; the test seeds or reads that same file.
  const board = openBoard(join(box.root, '.git/pullboard/board.sqlite'));
  try {
    const tree = runFixtureGit(['rev-parse', `${box.head}^{tree}`], { cwd: box.builder, env: box.env }).trim();
    submitFixture(board, box.item, { agentId: 'core-1', commit: box.head, tree });
  } finally { closeBoard(board); }
  const { independent, review } = reviewer(box);
  const refused = cli(independent, review, 'verify', String(box.item), 'accept', '--note', 'check the head-only failure');
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.equal(JSON.parse(refused.stdout).error.code, 'CHECK_RED');
});

test('verify refuses an identical main failure without an open repair owner [V4,B3]', async t => {
  const box = fixture(t);
  const settled = await settledSubmit(t, box, { submitted: true });
  assert.equal(settled.submission?.gateGreen, true, 'the pulled gate records green over the main-owned case: ' + JSON.stringify(settled.gate));
  const { independent, review } = reviewer(box);
  const refused = cli(independent, review, 'verify', String(box.item), 'accept', '--note', 'no repair owns the case');
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.equal(JSON.parse(refused.stdout).error.code, 'CHECK_RED');
});

test('a frozen case red identically on main with no owner records a green gate listing it main-owned, shouts, and files nothing [V4,B3,C7]', async t => {
  const box = fixture(t);
  const report = await settledSubmit(t, box, { submitted: true });
  // Since #3534 the gate records green over main's own reds and names them, instead of a builder fact.
  assert.equal(report.submission?.gateGreen, true, 'a red only in main\'s own case records green: ' + JSON.stringify(report.gate));
  const shown = JSON.parse(cli(box, box.root, 'show', String(box.item)).stdout);
  assert.ok(shown.thread.some(entry => entry.type === 'fact' && entry.text.includes('main-owned test/frozen.test.js (frozen case [G1])')), 'the gate names the main-owned file and case: ' + JSON.stringify(shown.thread));
  assert.equal(rows(box, "SELECT item_id FROM item WHERE item_title LIKE 'Main red:%'").length, 0, 'submit files no item');
  assert.ok(!shown.thread.some(entry => entry.type === 'fact' && entry.text.includes('unowned known main red')), 'no builder fact is written for a main-owned red');
  const shouts = rows(box, 'SELECT * FROM shout');
  const asked = shouts.filter(row => row.shout_to === 'coordinator' && row.shout_decision === 1 && String(row.shout_text).includes('test/frozen.test.js'));
  assert.equal(asked.length, 1, 'exactly one decision shout reaches the coordinator: ' + JSON.stringify(shouts));
});

test('an open Main red repair is linked, not duplicated [V4,B3]', async t => {
  const box = fixture(t);
  const repair = fileMainRed(box);
  const report = await settledSubmit(t, box, { submitted: true });
  assert.equal(report.submission?.gateGreen, true, JSON.stringify(report.gate));
  assert.deepEqual(report.submission.submissionProof.knownMainFailures.failures.map(row => row.item), [repair]);
  assert.equal(rows(box, "SELECT item_id FROM item WHERE item_title LIKE 'Main red:%'").length, 1);
});
