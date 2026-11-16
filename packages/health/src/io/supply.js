/** Health reports a submitted review no live seat can take once declared review limits are counted [C7,O2]. */

/**
 * One NO_REVIEWER_SUPPLY finding per unreserved submitted item whose every other seat declared a limit that excludes it,
 * naming the vendor family a reviewer must come from. Boards whose seats declare no limits never report it.
 * Why: seats under a not-same-family limit decline same-vendor reviews, so the queue waits though seats are counted (#2039).
 *
 * @param {any} board
 * @param {any[]} items
 * @param {any[]} seats - Every registered seat.
 * @param {number} now - Observation time in milliseconds.
 * @param {(cause: string, item: any, fields: object) => object} finding - The health finding builder.
 * @param {(item: any) => string} submittedAt - When the item was submitted, as an ISO time.
 * @param {{ limitProblem: (board: any, item: any, seat: string) => any, familyOf: (board: any, item: any) => string }} verify - The review rules, passed in so health takes on no verify edge here.
 * @returns {object[]}
 */
export function noReviewerSupplyFindings(board, items, seats, now, finding, submittedAt, verify) {
  const out = [];
  for (const item of items) {
    if (item.item_status !== 'submitted' || item.item_review_by) continue;
    const others = seats.filter(seat => seat.agent_id !== item.item_built_by && seat.agent_lane !== 'coordinator');
    const limited = others.filter(seat => verify.limitProblem(board, item, seat.agent_id));
    if (!limited.length || limited.length !== others.length) continue;
    const family = verify.familyOf(board, item);
    out.push(finding('NO_REVIEWER_SUPPLY', item, {
      since: submittedAt(item), now, title: 'no seat can review within its declared limits',
      why: `${limited.map(seat => seat.agent_id).join(', ')} declared not-same-family and #${item.item_id} was built by family ${family}; a reviewer from a family other than ${family} is needed`,
      next: `join a reviewer from a family other than ${family}: pullboard join <lane> --model "<model name>" --family "<vendor family>"`, command: `pullboard show ${item.item_id}`,
      owner: { role: 'coordinator', who: 'coordinator' }, detail: { familyNeeded: `not ${family}`, builderFamily: family, seats: limited.map(seat => seat.agent_id) },
    }));
  }
  return out;
}
