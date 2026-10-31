/** Read-only projection shared with move floor declarations [H16,C7]. */
/** Read the latest defect for each trunk and test, without rewriting its prior evidence. */
export function landingTestDefects(board) {
  const defects = new Map();
  for (const row of board.db.prepare("SELECT event_detail FROM event WHERE event_kind = 'landing-test-defect' ORDER BY event_id").all()) {
    const { defect } = JSON.parse(row.event_detail);
    defects.set(`${defect.branch}\0${defect.test}`, defect);
  }
  return [...defects.values()];
}
