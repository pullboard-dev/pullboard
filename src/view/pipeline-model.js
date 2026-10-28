/** Pure snapshot pipeline projection; event matching remains the canonical lifecycle helper [N26,N38,C7]. */

/** Replay supplied history and declared clock transitions without reading a page or live clock. */
export function replayItem(item, flow, match) {
  const clock = flow.moves.filter((m) => m.by.includes('clock'));
  const steps = [];
  let at = flow.initial;
  const step = (move, e) => {
    steps.push({ from: at, move, at: e ? e.at : null, by: e ? e.by : 'the clock', kind: e ? e.kind : move.verb });
    if (move) at = move.to;
  };
  for (const e of item.history) {
    // The native matcher distinguishes retained refreezes, renewals and state-specific aliases.
    const fits = s => match(flow, s, e);
    const lapse = fits(at) ? null : clock.find((m) => m.from.includes(at) && fits(m.to));
    if (lapse) step(lapse, null);
    step(fits(at) || null, e);
  }
  const lapse = at === item.status ? null : clock.find((m) => m.from.includes(at) && m.to === item.status);
  if (lapse) step(lapse, null);
  return steps;
}

/** A recorded merge, rather than an accept, is the end of the shipping pipeline. */
export function pipelineStage(item) {
  if (item.stage !== undefined) return item.stage;
  if (item.merged) return 'merged';
  return item.status === 'verified' ? 'accepted' : item.status;
}

/** The last arrival in this stage; edits, review reservations and renewals do not restart its age. */
export function pipelineSince(item, flow, match) {
  if (item.since !== undefined) return item.since;
  if (item.merged) return item.history.findLast((event) => event.kind === 'merged')?.at || item.updatedAt;
  const arrival = replayItem(item, flow, match).findLast((step) => step.move && step.from !== step.move.to);
  // Lapses are inferred, but the native claim receipt records the deadline that caused them.
  if (arrival?.move?.verb === 'lapse') {
    const claim = item.thread?.findLast((entry) => entry.type === 'move' && ['claim', 'renew'].includes(entry.kind));
    if (claim?.detail?.leaseUntil) return claim.detail.leaseUntil;
  }
  return arrival ? arrival.at || item.updatedAt : item.history.find((event) => event.kind === 'add')?.at || item.updatedAt;
}

/** Add the list and pipeline fields omitted from full snapshots, while leaving API summaries intact. */
export function itemListFields(item, flow, { fresh = false, match } = {}) {
  if (!fresh && item.stage !== undefined) return item;
  const claim = item.status === 'claimed' && item.owner ? { by: item.owner, until: null }
    : item.status === 'submitted' && item.reviewer ? { by: item.reviewer, until: item.reviewUntil ?? null } : null;
  return { ...item, stage: pipelineStage(item), since: pipelineSince(item, flow, match), claim,
    counts: { verdicts: item.verdicts.length, facts: (item.thread || []).filter((entry) => entry.type === 'fact').length } };
}

