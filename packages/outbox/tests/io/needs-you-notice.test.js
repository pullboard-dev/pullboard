/** @pullboard-test-input source-cell outbox */
/** Uploads waiting in the outbox show one plain Needs-you notice with a single fix, cleared when the outbox drains [C7,#9412]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { outboxSummaryFile } from '../../src/io/relay.js';
import {
  OUTBOX_NOTICE_ID,
  outboxNeedsYou,
  outboxNoticeRows,
} from '../../src/io/notice.js';

/** A link file in a scratch folder whose summary holds `count` queued moves. */
function link(count, parked = false) {
  const tree = privateFixtureFiles('pb-outbox-notice-');
  const linkFile = join(tree.root, 'relay-link.json');
  const moves = Array.from({ length: count }, (_, index) => ({ id: index, parked: parked ? { engine: 1 } : undefined }));
  tree.write('relay-outbox.summary.json', JSON.stringify({ moves }));
  return linkFile;
}

test('clause 1: uploads waiting on a relay failure show exactly one notice naming the cause and one command [C7,#9412]', () => {
  const rows = outboxNeedsYou(link(1), { cause: { cause: 'relay_off', machine: 'm', fix: 'On that computer, run pullboard relay on.' } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, OUTBOX_NOTICE_ID);
  assert.match(rows[0].text, /1 upload waiting: the relay is turned off/u);
  assert.equal(rows[0].fix, 'pullboard relay on');
  assert.equal(rows[0].text.match(/pullboard /gu).length, 1, 'one command only');
});

test('clause 1: a plain connection failure still names a cause and a command [C7,#9412]', () => {
  const [notice] = outboxNoticeRows({ count: 1, cause: { cause: 'connection', machine: null, fix: null } });
  assert.match(notice.text, /cannot reach the relay/u);
  assert.equal(notice.fix, 'pullboard relay');
});

test('clause 1: the notice clears when the outbox drains [C7,#9412]', () => {
  const linkFile = link(3);
  assert.equal(outboxNeedsYou(linkFile).length, 1);
  rmSync(outboxSummaryFile(linkFile));
  assert.deepEqual(outboxNeedsYou(linkFile), []);
});

test('clause 2: ten queued moves still show one notice [C7,#9412]', () => {
  const rows = outboxNeedsYou(link(10), { cause: { cause: 'connection', fix: null } });
  assert.equal(rows.length, 1);
  assert.match(rows[0].text, /^10 uploads waiting/u);
});

test('clause 2: moves all parked behind a recovery show one notice with the recover command [C7,#9412]', () => {
  const rows = outboxNeedsYou(link(4, true));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fix, 'pullboard relay recover');
});
