/** Compare authored scope with actual claim-to-submit intervals, never an inferred estimate [N2,B3]. */
import { proofEventDetail } from '../../../../kernel/browser.js';

/** Renewals retain the original claim; releases and returns end it, and missing boundaries remain unknown. */
export function buildCalibration(history, items, budgetMinutes = 30) {
  const claims = new Map(), completed = new Map();
  for (const event of [...history].sort((a, b) => a.event_id - b.event_id)) {
    const id = event.item_id;
    if (id == null) continue;
    const detail = proofEventDetail(event), at = Date.parse(event.event_at);
    if (event.event_kind === 'claim') claims.set(id, { at, expectedMinutes: detail.expectedBuildMinutes ?? null });
    if (['release', 'lapse', 'reject', 'reopen', 'withdraw'].includes(event.event_kind) && !detail.review) claims.delete(id);
    if (event.event_kind === 'submit') {
      const claim = claims.get(id);
      completed.set(id, { expectedMinutes: claim?.expectedMinutes ?? null,
        actualMinutes: claim && Number.isFinite(at) && Number.isFinite(claim.at) && at >= claim.at ? (at - claim.at) / 60_000 : null });
    }
  }
  const rows = items.filter(item => completed.has(item.item_id) || item.item_expected_build_minutes != null).map(item => {
    const sample = completed.get(item.item_id);
    const expectedMinutes = sample ? sample.expectedMinutes : item.item_expected_build_minutes;
    const actualMinutes = sample?.actualMinutes ?? null;
    return { item: item.item_id, title: item.item_title, expectedMinutes: expectedMinutes ?? null, actualMinutes,
      ratio: expectedMinutes > 0 && actualMinutes !== null ? actualMinutes / expectedMinutes : null };
  });
  const paired = rows.filter(row => row.ratio !== null);
  const expectedMinutes = paired.reduce((sum, row) => sum + row.expectedMinutes, 0);
  const actualMinutes = paired.reduce((sum, row) => sum + row.actualMinutes, 0);
  return { version: 1, budgetMinutes, items: rows, calibration: { samples: paired.length, expectedMinutes, actualMinutes,
    ratio: expectedMinutes > 0 ? actualMinutes / expectedMinutes : null } };
}
