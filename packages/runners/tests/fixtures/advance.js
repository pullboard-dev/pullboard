/** Real native source advancement supplies documentation contract rows, never fabricated receipts [C7,A5,H16]. */
import assert from 'node:assert/strict';
import { mainMovedFixture } from '../../../../apps/cli/tests/fixtures/main/moved.js';

/** Execute the actual checked native worker and retain its closed persisted event fields. */
export async function sourceAdvanceEventContract(t) {
  const box = await mainMovedFixture(t);
  box.trigger();
  const terminal = await box.settled();
  assert.equal(terminal.item.item_status, 'verified', JSON.stringify(terminal.rows));
  assert.ok(terminal.item.item_effective_head, 'the native worker checked a real merged source');
  const rows = box.board(board => box.store.events(board, { itemId: box.id })
    .filter(row => row.event_kind === 'source_advanced'));
  assert.equal(rows.length, 1, 'only the actual native checked event supplies documentation authority');
  return rows.map(row => ({ ...row, detail: JSON.parse(row.event_detail) }));
}
