/** Real command completion must take native next work, not merely print a suggestion [N2,V1,V4]. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../src/board.js';

/** Install real CLI controls while reusing the frozen suite's isolated Git and SQLite setup. */
export function installPostMoveHandoffCases({ fixture, cli }) {
  test('submit returns with the next build claimed by the same seat [N2,V4]', async t => {
    const files = {
      'web/value.js': 'export const value = 0;\n',
      'web/handoff.test.js': `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
test('the actual submitted value is repaired', () => assert.equal(readFileSync(new URL('./value.js', import.meta.url), 'utf8'), 'export const value = 1;\\n'));
`,
      'package.json': '{"type":"module"}\n',
    };
    const box = await fixture(t, { files });
    const seat = box.seats.actor;
    const check = `"${process.execPath}" --test --test-reporter=tap web/handoff.test.js`;
    const first = box.add('Repair the actual value', { check });
    const next = box.add('Continue in the same seat', { check });
    const claimed = await cli(box, seat.path, ['claim', String(first)]);
    assert.equal(claimed.code, 0, claimed.out + claimed.err);
    writeFileSync(join(seat.path, 'web/value.js'), 'export const value = 1;\n');
    box.git(seat.path, 'add', 'web/value.js');
    box.git(seat.path, 'commit', '-q', '-m', 'fix(web): repair the actual fixture value [G1]');
    const result = await cli(box, seat.path, ['submit', String(first)]);
    assert.equal(result.code, 0, result.out + result.err);
    assert.equal(store.getItem(box.board, first).item_status, 'submitted', 'the original operation is retained');
    assert.equal(store.getItem(box.board, next).item_owner, seat.id, 'the same command takes its next build');
    assert.equal(store.getItem(box.board, next).item_status, 'claimed');
    assert.equal(result.document.id, first, 'the primary submission document remains authoritative');
    assert.equal(result.document.next.item.item_id, next);
    assert.equal(result.document.next.review, false);
  });

  test('a verdict returns with the next threshold review reserved [N2,V1,V4]', async t => {
    const box = await fixture(t);
    // Synthetic submitted states establish a review queue; no setup gate execution is claimed.
    const first = box.add('Review currently in hand');
    box.submit(first);
    const pending = ['Oldest waiting review', 'Second waiting review', 'Third waiting review'].map(title => {
      const id = box.add(title); box.submit(id); return id;
    });
    const seat = box.seats.outside;
    const reserved = await cli(box, seat.path, ['next', '--take']);
    assert.equal(reserved.code, 0, reserved.out + reserved.err);
    assert.equal(reserved.document.item.item_id, first);
    const result = await cli(box, seat.path, ['verify', String(first), 'reject', '--reason', 'TEST_FAILURE', '--note', 'Observed fixture defect; source must be repaired.']);
    assert.equal(result.code, 0, result.out + result.err);
    assert.equal(store.getItem(box.board, first).item_verdict, 'REJECT');
    assert.equal(store.getItem(box.board, pending[0]).item_review_by, seat.id, 'the actual eligible waiting review is reserved');
    assert.equal(result.document.id, first, 'the original verdict is not overwritten by dispatch');
    assert.equal(result.document.next.item.item_id, pending[0]);
    assert.equal(result.document.next.review, true);
  });

  test('--no-next releases work and leaves the seat empty [N2,V1]', async t => {
    const box = await fixture(t);
    const seat = box.seats.actor;
    const first = box.add('Explicitly finish without another assignment');
    const next = box.add('Leave this eligible work untouched');
    box.claim(first, seat);
    const result = await cli(box, seat.path, ['release', String(first), '--no-next', '--note', 'Deliberate handoff opt-out']);
    assert.equal(result.code, 0, result.out + result.err);
    assert.equal(store.getItem(box.board, first).item_status, 'open');
    assert.equal(store.getItem(box.board, next).item_status, 'open');
    assert.equal(store.listItems(box.board).some(item => item.item_status === 'claimed' && item.item_owner === seat.id), false);
    assert.equal(result.document.id, first);
    assert.equal(result.document.next, undefined, 'opt-out makes no hidden reservation');
  });

  test('release with no eligible work stays successful and names the native reasons [N2,V1]', async t => {
    const box = await fixture(t);
    const seat = box.seats.actor;
    const first = box.add('Only task is now coordinator-held');
    box.claim(first, seat);
    store.holdItem(box.board, first, { agentId: 'coordinator', reason: 'Do not immediately take it again' });
    const result = await cli(box, seat.path, ['release', String(first), '--note', 'Return the held task']);
    assert.equal(result.code, 0, result.out + result.err);
    assert.equal(store.getItem(box.board, first).item_status, 'open');
    assert.equal(result.document.id, first);
    assert.equal(result.document.next.item, null);
    assert.ok(result.document.next.reasons.length, 'empty assignment is explained rather than fabricated');
  });
}
