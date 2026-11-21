/** pullboard status prints the clock line from the one stored health document and carries it in --json [B4,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeBoardMeta } from '../../../../../packages/store/index.js';
import { cli } from '../../fixtures/next/take.js';
import { fixture } from '../../fixtures/next/take.js';
import { main } from '../../fixtures/native.js';

/** The text of the real status command at the fixture's clock. */
async function statusText(box) {
  let out = '';
  const code = await main(['status'], { cwd: box.root, clock: box.clock, stdout: { isTTY: false, write: (part) => { out += part; } }, stderr: { write: () => {} } });
  assert.equal(code, 0, out);
  return out.split('\n');
}

test('cli.io-status-clock.prints-invariant: clause 1: [B4,C7] status prints the clock line from the stored health document with the oldest overdue age and the pass age', async (t) => {
  const box = await fixture(t);
  const document = { version: 1, at: new Date(box.clock.now().getTime() - 30_000).toISOString(), withoutOwnerDeadline: 0, overdue: 2, oldestOverdueMinutes: 7, byRule: {} };
  writeBoardMeta(box.board.db, 'clock.health', JSON.stringify(document));
  const lines = await statusText(box);
  assert.ok(lines.includes('clock: items without owner+deadline 0; overdue 2 (oldest 7 min); last pass 30 s ago'), lines.join('\n'));
  box.advance(5 * 60_000);
  const stale = await statusText(box);
  assert.ok(stale.includes('clock: items without owner+deadline 0; overdue 2 (oldest 7 min); last pass 330 s ago (stale)'), stale.join('\n'));
});

test('cli.io-status-clock.absent-and-json: clause 2: [B4,C7] with no stored document status prints no pass yet, and status --json carries the stored document as clock, null when absent', async (t) => {
  const box = await fixture(t);
  assert.ok((await statusText(box)).includes('clock: no pass yet'));
  assert.equal((await cli(box, box.root, ['status'])).document.clock, null);
  const document = { version: 1, at: box.clock.now().toISOString(), withoutOwnerDeadline: 1, overdue: 0, oldestOverdueMinutes: 0, byRule: {} };
  writeBoardMeta(box.board.db, 'clock.health', JSON.stringify(document));
  assert.deepEqual((await cli(box, box.root, ['status'])).document.clock, document);
});
