/** Read-only projection shared with move floor declarations [H16,C7]. */
/**
 * Read the latest open defect for each trunk and test, without rewriting its prior evidence. A closing event for that
 * defect's repair item removes it, so a defect whose cases passed at a trunk commit no longer holds later landings;
 * a later defect for the same test is filed by its own event and holds again [C7].
 */
export function landingTestDefects(board) {
  const defects = new Map();
  for (const row of board.db.prepare("SELECT event_kind, event_detail FROM event WHERE event_kind IN ('landing-test-defect', 'landing-test-defect-closed') ORDER BY event_id").all()) {
    const detail = JSON.parse(row.event_detail);
    if (row.event_kind === 'landing-test-defect-closed') {
      const key = `${detail.closed?.branch}\0${detail.closed?.test}`;
      if (defects.get(key)?.item === detail.closed?.item) defects.delete(key);
      continue;
    }
    const { defect } = detail;
    defects.set(`${defect.branch}\0${defect.test}`, defect);
  }
  return [...defects.values()];
}
