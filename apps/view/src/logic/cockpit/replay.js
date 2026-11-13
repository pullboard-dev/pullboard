/** Return the original replay section of the self-contained cockpit document. */
export function cockpitReplay(sections) {
  return `/** Display the current event and make the replay's play, pause and end states explicit. */
function replayControls() {
  const r = snapshotReplay;
  $('replay-progress').textContent = 'event ' + r.index.toLocaleString('en-US') + ' of ' + r.events.length.toLocaleString('en-US');
  $('replay-play').disabled = r.playing || !r.final || !r.events.length;
  const playLabel = r.index === r.events.length ? 'Play from first event' : 'Play';
  $('replay-play').setAttribute('aria-label', playLabel);
  $('replay-play').title = playLabel;
  $('replay-pause').disabled = !r.playing;
}

/** Project only the events already played, using the same declared lifecycle as the live page. */
function replayProject(index) {
  const r = snapshotReplay;
  const p = structuredClone(r.final);
  // Accounting stays in the exported log and cursor, but is never a lifecycle row.
  for (const item of p.items) {
    item.history = (item.history || []).filter((entry) => !['usage', 'shared-usage'].includes(entry.kind));
    if (Array.isArray(item.thread)) item.thread = item.thread.filter((entry) => !['usage', 'shared-usage'].includes(entry.kind));
  }
  if (index === r.events.length) return p;
  const log = r.events.slice(0, index);
  p.items = p.items.flatMap((item) => {
    const history = log.filter((event) => event.item_id === item.id && !['usage', 'shared-usage'].includes(event.event_kind));
    if (!history.some((event) => event.event_kind === 'add')) return [];
    let state = FLOW.initial;
    item.owner = null;
    item.builtBy = null;
    item.verifiedBy = null;
    item.reviewer = null;
    item.reviewUntil = null;
    item.commit = null;
    item.merged = null;
    let verdicts = 0;
    for (const event of history) {
      const projectedEvent = lifecycleEvent(event);
      const verb = event.event_kind === 'renew' ? 'claim' : event.event_kind;
      /** Find a declared move, distinguishing a renewed claim from a new one. */
      const fits = at => lifecycleMove(FLOW, at, projectedEvent);
      const lapse = fits(state) ? null : FLOW.moves.find((move) => move.by.includes('clock') && move.from.includes(state) && fits(move.to));
      if (lapse) state = lapse.to;
      const move = fits(state);
      if (move) state = move.to;
      const detail = JSON.parse(event.event_detail);
      if (verb === 'claim') item.owner = event.event_by;
      if (verb === 'submit') { item.commit = detail.commit; item.builtBy = event.event_by; item.reviewer = null; item.reviewUntil = null; }
      if (verb === 'reserve') { item.reviewer = event.event_by; item.reviewUntil = detail.until; }
      if (verb === 'accept') { item.verifiedBy = event.event_by; verdicts += 1; }
      if (verb === 'reject') { item.owner = null; verdicts += 1; }
      if (verb === 'accept' || verb === 'reject' || verb === 'release' || verb === 'withdraw') { item.reviewer = null; item.reviewUntil = null; }
      if (verb === 'release' || verb === 'withdraw') item.owner = null;
      if (verb === 'merged') item.merged = detail.commit;
    }
    item.status = state;
    item.history = history.map(lifecycleEvent);
    item.updatedAt = history.at(-1).event_at;
    item.verdicts = item.verdicts.slice(0, verdicts);
    item.verdict = item.verdicts.at(-1) ?? null;
    return [item];
  });
  const statuses = new Map(p.items.map((item) => [item.id, item.status]));
  for (const item of p.items) {
    const added = log.find((event) => event.item_id === item.id && event.event_kind === 'add');
    item.blockedBy = (JSON.parse(added.event_detail).after || []).filter((id) => statuses.get(id) !== 'verified');
  }
  // A milestone lists only this board's items added by now; another repo's stay as the export read them.
  p.milestones = (p.milestones || []).map((milestone) => ({ ...milestone, items: milestone.items.filter((entry) => typeof entry.id !== 'number' || statuses.has(entry.id)) }));
  const shouted = new Set(log.map((event) => JSON.parse(event.event_detail).shout).filter(Boolean));
  p.shouts = p.shouts.filter((shout) => shouted.has(shout.shout_id));
  p.decisions = p.decisions.filter((shout) => shouted.has(shout.shout_id));
  p.asked = p.asked.filter((shout) => shouted.has(shout.shout_id)); p.decisionQueue = (p.decisionQueue || []).filter((shout) => shouted.has(shout.shout_id));
  const held = new Map();
  for (const event of log) {
    const detail = JSON.parse(event.event_detail);
    if (event.event_kind === 'hold') held.set(detail.lane, { hold_lane: detail.lane, hold_reason: detail.reason, hold_by: event.event_by, hold_at: event.event_at });
    if (event.event_kind === 'unhold') held.delete(detail.lane);
  }
  p.holds = [...held.values()].sort((a, b) => a.hold_lane.localeCompare(b.hold_lane));
  p.events = log.slice(-80).reverse();
  return p;
}

/** Draw a replay position without refreshing or changing the exported board. */
function replayPosition(index) {
  const r = snapshotReplay;
  r.index = index;
  view.root = r.final.root;
  view.state = 'all';
  const project = replayProject(index);
  data = store.set({ ...data, root: view.root, group: null, project, projects: data.projects.map((board) => board.root === view.root ? boardSummary(board, project) : board) });
  render();
  replayControls();
}

/** Pause before clearing the next callback, so no event advances after the control returns. */
function pauseReplay() {
  snapshotReplay.playing = false;
  clearTimeout(snapshotReplay.timer);
  replayControls();
}

/** Play one event per speed-adjusted interval, stopping exactly at the exported final state. */
function advanceReplay() {
  const r = snapshotReplay;
  if (!r.playing) return;
  replayPosition(r.index + 1);
  if (r.index === r.events.length) return pauseReplay();
  r.timer = setTimeout(advanceReplay, 1000 / Number($('replay-speed').value));
}

/** Resume a paused replay, or restart at the first event when the snapshot is at the end. */
function playReplay() {
  const r = snapshotReplay;
  if (!r.final || !r.events.length || r.playing) return;
  if (r.index === r.events.length) replayPosition(0);
  r.playing = true;
  advanceReplay();
}

`;
}
