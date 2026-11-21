/** Real command completion must take native next work, not merely print a suggestion [N2,V1,V4]. */
import assert from 'node:assert/strict';
import {
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { submitFixture } from '../board/submit.js';

/** Install real CLI controls while reusing the frozen suite's isolated Git and SQLite setup. */
export function installPostMoveHandoffCases({ fixture, cli }) {
  test('submit returns without claiming the next build for the seat [N2,V4,#12020]', async t => {
    const files = {
      'web/value.js': 'export const value = 0;\n',
      'web/handoff.test.js': `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
test('the actual submitted value is repaired', () => assert.equal(readFileSync(new URL('./value.js', import.meta.url), 'utf8'), 'export const value = 1;\\n'));
`,
      'package.json': '{"type":"module"}\n',
      'web/followup.js': 'export const followup = true;\n',
    };
    const box = await fixture(t, { files });
    const seat = box.seats.actor;
    const check = `env -u NODE_TEST_CONTEXT "${process.execPath}" --test --test-reporter=tap web/handoff.test.js`;
    const first = box.add('Repair the actual value', { check });
    const next = box.add('Continue in the same seat', { check,
      brief: 'Files: web/followup.js\nTest: continue independent work after the submitted value repair.' });
    const claimed = await cli(box, seat.path, ['claim', String(first)]);
    assert.equal(claimed.code, 0, claimed.out + claimed.err);
    writeFileSync(join(seat.path, 'web/value.js'), 'export const value = 1;\n');
    box.git(seat.path, 'add', 'web/value.js');
    box.git(seat.path, 'commit', '-q', '-m', 'fix(web): repair the actual fixture value [G1]');
    const result = await cli(box, seat.path, ['submit', String(first)]);
    assert.equal(result.code, 0, result.out + result.err);
    // The pulled gate keeps the claim until a runner posts its receipt, so the submitted item stays claimed here [C7].
    assert.equal(store.getItem(box.board, first).item_status, 'claimed', 'the original operation is retained');
    assert.equal(store.getItem(box.board, next).item_status, 'open', `submit claims nothing for the seat: ${result.out} ${result.err}`);
    assert.equal(result.document.id, first, 'the primary submission document remains authoritative');
    assert.equal(result.document.next.item, null);
    assert.deepEqual(result.document.next.reasons, ['run pullboard next']);
  });

  test('a verdict returns with the next threshold review reserved [N2,V1,V4]', async t => {
    const box = await fixture(t);
    // Synthetic submitted states establish a review queue; no setup gate execution is claimed.
    const first = box.add('Review currently in hand');
    /** Freeze a real claim base, then seed only the explicitly synthetic submitted receipt. */
    const publish = async id => {
      const claimed = await cli(box, box.seats.builder.path, ['claim', String(id)]);
      assert.equal(claimed.code, 0, claimed.out + claimed.err);
      const head = box.git(box.seats.builder.path, 'rev-parse', 'HEAD');
      submitFixture(box.board, id, { agentId: box.seats.builder.id, commit: head,
        tree: box.git(box.root, 'rev-parse', `${head}^{tree}`) });
    };
    await publish(first);
    const pending = [];
    for (const title of ['Oldest waiting review', 'Second waiting review', 'Third waiting review']) {
      const id = box.add(title); await publish(id); pending.push(id);
    }
    const seat = box.seats.outside;
    const reserved = await cli(box, seat.path, ['next', '--take']);
    assert.equal(reserved.code, 0, reserved.out + reserved.err);
    assert.equal(reserved.document.item.item_id, first);
    const result = await cli(box, seat.path, ['verify', String(first), 'reject', '--reason', 'TEST_FAILURE',
      '--clause', 'The real fixture succeeds.', '--note', 'Observed fixture defect; source must be repaired.']);
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
    const result = await cli(box, seat.path, ['release', String(first), '--reason', 'BLOCKED', '--no-next', '--note', 'Deliberate handoff opt-out']);
    assert.equal(result.code, 0, result.out + result.err);
    assert.equal(store.getItem(box.board, first).item_status, 'open');
    assert.equal(store.getItem(box.board, next).item_status, 'open');
    assert.equal(store.listItems(box.board).some(item => item.item_status === 'claimed' && item.item_owner === seat.id), false);
    assert.equal(result.document.id, first);
    assert.equal(result.document.next, undefined, 'opt-out makes no hidden reservation');
  });

  test('release ends without handing the seat different work or reclaiming its item [N2,V1,B3]', async t => {
    const box = await fixture(t);
    const seat = box.seats.actor;
    const first = box.add('Let another builder take the released task');
    const next = box.add('Take different ready work');
    box.claim(first, seat);
    const result = await cli(box, seat.path, ['release', String(first), '--reason', 'BLOCKED', '--note', 'Leave the original task available']);
    assert.equal(result.code, 0, result.out + result.err);
    assert.equal(store.getItem(box.board, first).item_status, 'open', 'handoff does not undo the release');
    assert.equal(store.getItem(box.board, next).item_status, 'open', 'release leaves claiming to an explicit next [B3]');
    assert.equal(result.document.next, undefined, 'release carries no handoff since d0cd793e7b');
  });

  test('an acknowledged release stays committed and never reads next [N2,V1,A1,B3]', async t => {
    const box = await fixture(t);
    const seat = box.seats.actor;
    const first = box.add('Keep the acknowledged release visible');
    box.claim(first, seat);
    const result = await cli(box, seat.path, ['release', String(first), '--reason', 'BLOCKED', '--note', 'Record the release without a next read']);
    assert.equal(result.code, 0, result.out + result.err);
    assert.equal(store.getItem(box.board, first).item_status, 'open', 'the actual release remains committed');
    assert.equal(result.document.id, first, 'the one JSON document retains the primary acknowledgment');
    assert.equal(result.document.next, undefined, 'release reads no next assignment since d0cd793e7b');
  });

  test('release of a held item stays successful without a handoff [N2,V1,B3]', async t => {
    const box = await fixture(t);
    const seat = box.seats.actor;
    const first = box.add('Only task is now coordinator-held');
    box.claim(first, seat);
    store.holdItem(box.board, first, { agentId: 'coordinator', reason: 'Do not immediately take it again' });
    const result = await cli(box, seat.path, ['release', String(first), '--reason', 'BLOCKED', '--note', 'Return the held task']);
    assert.equal(result.code, 0, result.out + result.err);
    assert.equal(store.getItem(box.board, first).item_status, 'open');
    assert.equal(result.document.id, first);
    assert.equal(result.document.next, undefined, 'release reports no handoff outcome since d0cd793e7b');
  });
}
