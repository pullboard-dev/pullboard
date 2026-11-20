/** The lines `pullboard status` prints for a collected summary, as a pure function so the full door and a thin door print the same text. */

/**
 * Return the status lines for a collected summary. The caller binds the readers that need the board or an async import and passes them in `options.format`.
 * @param {object} summary what status collected inside its board read, plus the receipts, holds and disk it adds after
 * @param {object} options all: show gone seats; reviewQueue and landing: the already-built lines; originHint: print the origin hint; format: the line formatters
 * @returns {string[]} the lines, in print order
 */
export function statusLines(summary, options) {
  const { all = false, reviewQueue, landing, originHint = false, format } = options;
  const lines = [];
  const { stages, accepted, rejected } = summary.stats;
  lines.push(`${summary.me.displayName}: ${summary.unread} unread shouts; holding ${summary.mine.map((item) => `#${item.item_id}`).join(', ') || 'nothing'}`);
  for (const id of summary.noRunnerGates) lines.push(`top blocker: #${id} (in the gate, no runner); next: pullboard runner local, or pullboard submit ${id} again`);
  lines.push(`board: ${Object.entries(stages).map(([stage, total]) => `${total} ${stage}`).join(', ')}`);
  lines.push(`verdicts: ${accepted} accepted, ${rejected} rejected`);
  if (summary.specApprovalBaseline?.pending) lines.push('approval baseline pending: the next coordinator or person command in the main checkout records the existing approved rows; lane work may continue and none are flagged until then');
  if (summary.specApprovalBaseline?.invalid) lines.push('approval baseline unreadable: existing rows need approval evidence; restore a known-good board export to recover the original baseline');
  lines.push(reviewQueue);
  lines.push(landing);
  if (summary.landingBatch) lines.push(summary.landingBatch);
  lines.push(...format.capacityLines(summary.capacityForecast));
  if (summary.staffing) lines.push(format.staffingLines(summary.staffing));
  if (summary.usefulBuilders) lines.push(...format.usefulBuilderLines(summary.usefulBuilders));
  lines.push(format.signingLine(summary.person));
  for (const entry of [...summary.staleState.holds, ...summary.staleState.claims, ...summary.staleState.reviews]) {
    const incomplete = entry.evidence?.complete !== true;
    const classification = entry.classificationUnknown ? '; blocker classification unknown; shown at shortest possible half-limit' : '';
    lines.push(`past half limit: ${format.staleStateLine(incomplete ? { ...entry, expired: false } : entry)}${incomplete ? '; inactivity unproven (evidence unknown)' : ''}${classification}`);
  }
  for (const entry of summary.needsRescope ?? []) lines.push(`needs re-scope: #${entry.id} is not offered to ${entry.lane} at the ${entry.route} route; ${entry.reasons.join('; ')}; edit, refreeze or re-route it`);
  for (const entry of summary.staleState.claimHealth ?? []) {
    lines.push(entry.health === 'waiting' ? `waiting: #${entry.id} (${entry.actor}) waits on ${entry.waitingOn.map(id => `#${id}`).join(', ')} to land; the claim is released and the item returns when it lands`
      : `stalled: #${entry.id} (${entry.actor}) idle ${Math.floor(entry.idleMs / 60_000)}m with no commit, file change, running check or item move; released automatically at 30m`);
  }
  for (const gate of summary.stalledGates) lines.push(`gate job ${gate.id}${gate.item ? ` (#${gate.item})` : ''}: ${gate.text}`);
  for (const warning of summary.runnerUtilization.warnings) lines.push(warning);
  lines.push(`seats: ${summary.presenceCounts.live} live, ${summary.presenceCounts.idle} idle, ${summary.presenceCounts.gone} gone`);
  lines.push(`capacity: ${summary.capacity.liveAgents} live, ${summary.capacity.idleAgents} idle, ${summary.capacity.readyItems} ready item${summary.capacity.readyItems === 1 ? '' : 's'}`);
  for (const [route, ready] of Object.entries(summary.capacity.readyByRoute ?? {})) {
    const builders = summary.capacity.buildersByRoute?.[route] ?? 0;
    lines.push(`ready buffer: ${route} ${ready} ready, ${builders > 0 ? `${builders} builders = ${(ready / builders).toFixed(1)}x` : 'no builders'}`);
  }
  for (const seat of summary.agents.filter(seat => all || seat.presence !== 'gone')) lines.push(`${seat.agent_id}: ${seat.presence}${seat.heartbeatAt ? ` (heartbeat ${seat.heartbeatAt})` : ' (no local heartbeat)'}`);
  if (summary.memoryHeld === null) lines.push('local memory hold status unavailable; pullboard resources shows the queue');
  else for (const run of summary.memoryHeld) lines.push(`local memory holds ${run.agent}${run.item ? ` #${run.item}` : ''}${run.kind ? ` (${run.kind})` : ''}${run.repo ? ` in ${run.repo}` : ''}`);
  if (summary.runnerDeadlines === null) lines.push('runner wait deadline status unavailable; pullboard resources shows the queue');
  else for (const run of summary.runnerDeadlines) lines.push(`${run.agent}${run.item ? ` #${run.item}` : ''}${run.repo ? ` in ${run.repo}` : ''}: ${format.runnerDeadlineLine(run)}`);
  for (const hold of summary.longestHolds ?? []) lines.push(`board hold ${hold.at}: ${hold.heldMs} ms in ${hold.move ?? 'unknown move'}${hold.step ? `, slowest step ${hold.step} ${hold.stepMs ?? '?'} ms` : ''}`);
  lines.push(...format.diskLines(summary.disk));
  for (const proposal of summary.submitInvariantProposals) lines.push(format.submitInvariantLine(proposal));
  for (const need of summary.needs.filter(need => need.kind === 'agent-approved')) lines.push(`${need.text}; ${need.what}`);
  if (originHint) lines.push('optional: add a GitHub origin and run pullboard relay on to link this board');
  return lines;
}
