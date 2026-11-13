/** A pulled gate red only in cases main fails by name stores its review packet, with those main-owned cases kept apart [V4,C7]. */
import '../../../../index.js'; // This test invokes the real CLI through its public executable.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cli } from '../../../../tests/fixtures/init/known-frozen.js';
import { fileMainRed } from '../../../../tests/fixtures/init/known-frozen.js';
import { fixture } from '../../../../tests/fixtures/init/known-frozen.js';
import { rows } from '../../../../tests/fixtures/init/known-frozen.js';
import { settledSubmit } from '../../../../tests/fixtures/init/known-frozen.js';

test("clause 1: a settled pulled red only on main's named reds gets a review packet naming the main-owned case and its receipt [V4,C7]", { timeout: 240_000 }, async t => { // budget: one pulled gate job and its main comparison on the fixture runner.
  const box = fixture(t);
  const repair = fileMainRed(box);
  const report = await settledSubmit(t, box, { submitted: true });
  assert.equal(report.submission?.gateGreen, true, 'the pulled settle records a red only in main-owned cases as green');
  const known = report.submission.submissionProof.knownMainFailures;
  assert.equal(known.main, box.main);
  const shown = cli(box, box.root, 'show', String(box.item), '--review');
  assert.equal(shown.status, 0, shown.stdout + shown.stderr);
  const packet = JSON.parse(shown.stdout);
  assert.equal(packet.gate, 'red only in main reds');
  assert.deepEqual(packet.failures, [], "main's named reds are not listed as the item's own failures");
  assert.equal(packet.excusedMainReds.length, 1, JSON.stringify(packet.excusedMainReds));
  const [red] = packet.excusedMainReds;
  assert.deepEqual({ file: red.file, name: red.name, main: red.main, repair: red.repair },
    { file: 'test/frozen.test.js', name: 'frozen case [G1]', main: box.main, repair });
  // On pull the main receipt is the main-test job's keyed receipt on the board, recorded beside the known failure.
  assert.equal(typeof red.mainReceipt, 'string', `the excused red names its main receipt: ${JSON.stringify(red)}`);
  assert.equal(red.mainReceipt, known.failures[0].receipt, 'the packet cites the receipt the settle recorded');
  const [keyed] = rows(box, "SELECT job_step_payload FROM job_step WHERE job_step_job = ? AND job_step_name = 'receipt' AND job_step_seq = 0", red.mainReceipt);
  assert.ok(keyed, `the cited main receipt is recorded on the board: ${red.mainReceipt}`);
  const receipt = JSON.parse(keyed.job_step_payload);
  assert.equal(receipt.verdict, 'red');
  assert.equal(receipt.main, box.main, 'the main receipt ran the known main commit');
  assert.equal(receipt.file, red.file);
  assert.ok(receipt.failing.includes(red.name), 'the main receipt records that exact case failing');
  assert.equal(rows(box, "SELECT item_id FROM item WHERE item_title LIKE 'Main red:%'").length, 1, 'the packet files no repair of its own');
});
