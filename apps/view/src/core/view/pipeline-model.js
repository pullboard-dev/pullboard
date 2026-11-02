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

/** Recover the native stage immediately before an item's final withdrawal [U120]. */
export function withdrawnFromStatus(item) {
  if (item.withdrawnFrom) return item.withdrawnFrom;
  let status = 'open';
  for (const event of item.history || []) {
    if (event.kind === 'withdraw') break;
    if (event.kind === 'claim' || event.kind === 'renew') status = 'claimed';
    else if (event.kind === 'submit' || event.kind === 'submit-merge' || event.kind === 'intake') status = 'submitted';
    else if (event.kind === 'accept') status = 'verified';
    else if (event.kind === 'merged') status = 'merged';
    else if (['reject', 'reopen', 'release', 'lapse', 'add'].includes(event.kind)) status = 'open';
  }
  return status;
}

/** Map a native item state to the approved person-facing stage and its short detail [U120]. */
export function itemStagePresentation(item, { gated = false, landingBatchAt = null, withdrawnFrom = null, gateDetail = '' } = {}) {
  const status = item.status === 'withdrawn' ? withdrawnFrom || withdrawnFromStatus(item) : item.status;
  let stage;
  let detail;
  if (item.merged || item.stage === 'merged' || status === 'merged') {
    stage = 'Merged';
    detail = 'landed';
  } else if (status === 'verified') {
    if (landingBatchAt) {
      stage = 'Landing';
      detail = 'in the ' + landingBatchAt + ' batch';
    } else {
      stage = 'Verified';
      detail = 'queued for the train';
    }
  } else if (status === 'submitted') {
    stage = 'In review';
    const reviewer = item.claim?.by || item.reviewer;
    detail = reviewer ? reviewer + ' verifying' : 'awaiting a verdict';
  } else if (status === 'claimed') {
    stage = 'Building';
    const builder = item.claim?.by || item.owner;
    detail = builder ? 'by ' + builder : 'under a build lease';
  } else if (status === 'open' && gated) {
    stage = 'Gated';
    detail = item.blockedBy?.length ? 'by #' + item.blockedBy[0] : gateDetail || 'waiting on a gate';
  } else if (status === 'open') {
    stage = 'Ready';
    detail = item.route ? item.route + ' route' : 'ready for a builder';
  } else {
    stage = 'Ready';
    detail = 'stage unavailable';
  }
  return { stage, detail };
}

/** Return the stable machine key for an approved display stage [U120]. */
export function itemStageKey(stage) {
  return String(stage).toLowerCase().replace(/\s+/gu, '-');
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

