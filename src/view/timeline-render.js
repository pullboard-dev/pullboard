/** Render normalized timeline entries and explicit presentation values as HTML. */
export function timelineHtml({ entries, steps, flow }) {
  const esc = text => String(text ?? '').replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const span = ms => {
    const minutes = Math.max(0, Math.round(ms / 60000));
    return minutes < 1 ? 'under a minute' : minutes < 60 ? minutes + 'm' : minutes < 1440
      ? Math.floor(minutes / 60) + 'h' + (minutes % 60 ? ' ' + (minutes % 60) + 'm' : '')
      : Math.floor(minutes / 1440) + 'd' + (Math.floor((minutes % 1440) / 60) ? ' ' + Math.floor((minutes % 1440) / 60) + 'h' : '');
  };
  const facts = entries.filter(entry => entry.type === 'fact');
  const replacements = new Map(facts.filter(fact => fact.supersedes).map(fact => [fact.supersedes, fact]));
  const rows = [];
  let stepIndex = 0;
  const moveRow = (step, event, index) => {
    const enters = step.move ? step.move.to : step.kind === 'add' ? flow.initial : null;
    const state = enters || step.from;
    const final = flow.states.some(stateRow => stateRow.id === state && stateRow.final);
    const next = steps.slice(index + 1).find(row => row.move);
    const named = step.kind === 'reject' ? 'sent back' : state;
    const stay = !enters || (final && !next) ? ''
      : !step.at ? esc(named + (next ? ' after the ' : ' so far since the ') + step.kind + ', length not logged')
      : !next ? esc(named) + ' for ' + step.ageHtml + ' so far'
      : !next.at ? esc(named + ' until the ' + next.kind + ', length not logged')
      : esc(named + ' for ' + span(Date.parse(next.at) - Date.parse(step.at)));
    rows.push('<li class="tl-' + esc(state) + (step.kind === 'reject' ? ' tl-back' : '') + (enters ? '' : ' tl-quiet') + '"' + (event ? ' data-event-id="' + event.eventId + '"' : '') + '><time>' + step.timeLabel + '</time><span><b>' + esc(step.kind) + '</b> ' + esc(step.agentLabel) + '</span>' + (stay ? '<small>' + stay + '</small>' : '') + '</li>');
  };
  const factRow = fact => {
    const replacement = replacements.get(fact.id);
    const judgement = ['decision', 'rejection', 'supersession', 'root-cause'].includes(fact.kind);
    rows.push('<li id="fact-' + esc(fact.id) + '" class="tl-fact' + (judgement ? ' tl-judgement' : '') + (replacement ? ' tl-superseded' : '') + '" data-event-id="' + fact.eventId + '"><time>' + fact.timeLabel + '</time><span class="tl-fact-head"><span class="chip">' + esc(fact.kind) + '</span> <b>' + esc(fact.agentLabel) + '</b></span><span class="tl-body">' + esc(fact.text) + '</span><small>' + fact.ageHtml + (replacement ? ' · <a class="thread-replacement" href="#fact-' + esc(replacement.id) + '">replaced by ' + esc(replacement.kind) + '</a>' : '') + '</small>' + (fact.hasCodeRef ? '<div class="tl-code">' + (fact.codeHtml || '') + '</div>' : '') + '</li>');
  };
  for (const entry of entries) {
    if (entry.type === 'fact') { factRow(entry); continue; }
    while (stepIndex < steps.length && !(steps[stepIndex].kind === entry.kind && steps[stepIndex].by === entry.by && steps[stepIndex].at === entry.at)) {
      moveRow(steps[stepIndex], null, stepIndex);
      stepIndex += 1;
    }
    if (stepIndex < steps.length) { moveRow(steps[stepIndex], entry, stepIndex); stepIndex += 1; }
  }
  while (stepIndex < steps.length) { moveRow(steps[stepIndex], null, stepIndex); stepIndex += 1; }
  return '<ol class="tl">' + rows.join('') + '</ol>';
}
