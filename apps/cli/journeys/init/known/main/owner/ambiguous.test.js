/** A case no single repair names is ambiguous but red on main, at the pulled gate [V4,B3,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from '../../../../../tests/fixtures/affected.js';
import { cli } from '../../../../../tests/fixtures/affected.js';
import { rows } from '../../../../../tests/fixtures/affected.js';
import { settledSubmit } from '../../../../../tests/fixtures/affected.js';
import { SHARED } from '../../../../../tests/fixtures/affected.js';
import { fileCaseRepair as fileMainRed } from '../../../../../tests/fixtures/affected.js';

test('a case no single repair names is ambiguous but red on main, so submit accepts it and names the candidates [V4,B3,C7]', async t => {
  const box = fixture(t, { affected: SHARED });
  const alpha = fileMainRed(box, "The case 'alpha case' passes on main.");
  const other = fileMainRed(box, 'The shared file passes on main.');
  const report = await settledSubmit(t, box);
  assert.equal(report.submission?.gateGreen, true, JSON.stringify(report.gate));
  assert.deepEqual(report.submission.submissionProof.knownMainFailures.failures.map(row => [row.name, row.item]), [['alpha case [G1]', alpha]]);
  const shown = JSON.parse(cli(box, box.root, 'show', String(box.item)).stdout);
  const named = `main-owned test/affected.test.js (beta case [G1]): several candidate owners: #${alpha}, #${other}`;
  assert.ok(shown.thread.some(entry => entry.type === 'fact' && entry.text.includes(named)), JSON.stringify(shown.thread.slice(-4)));
  assert.equal(rows(box, "SELECT event_id FROM event WHERE item_id=? AND event_kind='submit'", box.item).length, 1);
});
