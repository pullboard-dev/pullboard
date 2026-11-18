/** Pure landing record shapes, kept apart from selection so landing by hand reaches no gate code [C7,#3775]. */

/** Keep the submitted identity and, when different, its sealed checked composition. */
export function landingEntry(item) {
  return { id: item.item_id, commit: item.item_commit,
    ...(item.item_landing_commit !== item.item_commit ? { reviewedCommit: item.item_landing_commit } : {}),
    ...(item.item_withdrawn_dependencies?.length ? { withdrawnDependencies: item.item_withdrawn_dependencies } : {}) };
}

/** The LAND_TEST_DEFECT refusal text for the defects holding a trunk, naming each repair item and its live status [C7]. */
export function testDefectHoldMessage(held) {
  return `this trunk is held by ${held.map(defect => `#${defect.item ?? '?'} (${defect.status ?? 'status unreadable'}; ${defect.test})`).join(', ')}; correct the committed test or ask an approver for an expiring waiver`;
}
