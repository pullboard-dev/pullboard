import { sharedRowHtml } from "../component.js";

/** Render normalized timeline entries and explicit presentation values as HTML. */
export function timelineHtml({ entries, steps, flow, open = [], newestFirst = false, folded = [] }) {
  /** Escape board text before joining it to trusted renderer markup. */
  const esc = text => String(text ?? '').replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  /** Describe a lifecycle stay without inventing a time for an inferred lapse. */
  const span = ms => {
    const minutes = Math.max(0, Math.round(ms / 60000));
    return minutes < 1 ? 'under a minute' : minutes < 60 ? minutes + 'm' : minutes < 1440
      ? Math.floor(minutes / 60) + 'h' + (minutes % 60 ? ' ' + (minutes % 60) + 'm' : '')
      : Math.floor(minutes / 1440) + 'd' + (Math.floor((minutes % 1440) / 60) ? ' ' + Math.floor((minutes % 1440) / 60) + 'h' : '');
  };
  const facts = entries.filter(entry => entry.type === 'fact');
  const replacements = new Map(facts.filter(fact => fact.supersedes).map(fact => [fact.supersedes, fact]));
  const rows = [];
  const verbs = { add: 'added this work', claim: 'claimed it', reserve: 'started reviewing', 'proof-run': 'ran the proof',
    submit: 'submitted it for review', accept: 'passed it', reject: 'sent it back', reopen: 'sent it back',
    merged: 'landed it', withdraw: 'withdrew it', milestone_placed: 'placed it in a milestone', renew: 'continued building', release: 'let go of it',
    lapse: 'released an expired lease', refreeze: 'refreshed the frozen bar', edit: 'updated this work',
    'health-resolved': 'found this item passing again', 'health-failure': 'found this item failing' };
  /** Retain real model metadata only on hover; a seat's address remains the visible identity. */
  const who = entry => '<b class="tl-who"' + (entry.model ? ' title="' + esc(entry.model) + '"' : '') + '>'
    + esc(['health-resolved', 'health-failure'].includes(entry.kind) ? 'Sentinels' : entry.by || 'The board') + '</b>';
  /** Use the same verb glyph and tone for every instance of one native move. */
  const icon = kind => {
    const paths = { build: 'm9.5 2.5 4 4-1.5 1.5-4-4zM8 4 2.5 9.5l4 4L12 8', sentinel: 'M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8 M6 8a2 2 0 1 0 4 0a2 2 0 1 0-4 0', proof: 'M6 2.5h4M7 2.5v4L3.5 12.5h9L9 6.5v-4', pass: 'm3 8 3.5 3.5L13 5',
      review: 'M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8',
      note: 'M4 4h8M4 8h8M4 12h5', back: 'm6 4-3.5 3.5L6 11M2.5 7.5H10', measure: 'M2.5 11a5.5 5.5 0 1 1 11 0M8 11l2.5-3' };
    return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="' + paths[kind] + '"/></svg>';
  };
  let stepIndex = 0;
  /** Retain replay state, original event identity and stay evidence beside a plain sentence. */
  const moveRow = (step, event, index) => {
    const enters = step.move ? step.move.to : step.kind === 'add' ? flow.initial : null;
    const state = enters || step.from;
    const final = flow.states.some(stateRow => stateRow.id === state && stateRow.final);
    const next = steps.slice(index + 1).find(row => row.move);
    const named = step.kind === 'reject' ? 'sent back' : state;
    const stay = !enters || (final && !next) ? ''
      : !step.at ? esc(named + (next ? ' after the ' : ' so far since the ') + (step.momentLabel || step.kind) + ', length not logged')
      : !next ? esc(named) + ' for ' + step.ageHtml + ' so far'
      : !next.at ? esc(named + ' until the ' + (next.momentLabel || next.kind) + ', length not logged')
      : esc(named + ' for ' + span(Date.parse(next.at) - Date.parse(step.at)));
    const previous = steps.slice(0, index).findLast(row => row.move);
    const waited = step.kind === 'reserve' && previous?.at && step.at
      ? 'it had waited ' + Math.max(0, Math.round((Date.parse(step.at) - Date.parse(previous.at)) / 60000)) + ' minutes for a reviewer' : '';
    rows.push({ type: 'move', kind: step.kind, by: step.by, model: step.model, state, enters, from: step.from,
      classes: 'tl-' + state + (step.kind === 'reject' ? ' tl-back' : '') + (enters ? '' : ' tl-quiet'),
      eventIds: event ? [event.eventId] : [], time: step.timeLabel, lastTime: step.timeLabel,
      sentence: who(step) + ' ' + esc(verbs[step.kind] ?? step.kindLabel ?? step.kind.replaceAll('-', ' ')),
      label: step.kind === 'proof-run' ? '<span class="tl-kind tl-kind-proof">proof</span>' : '',
      stay: waited || stay, count: 1 });
  };
  /** Render an append-only native fact and retain its supersession/code binding. */
  const factRow = fact => {
    const replacement = replacements.get(fact.id);
    const judgement = ['decision', 'rejection', 'supersession', 'root-cause'].includes(fact.kind);
    const key = 'fact-' + fact.id, expanded = open.includes(key);
    const kind = ['note', 'measurement', 'fact', 'proof'].includes(fact.kind) ? fact.kind : 'fact';
    const verb = kind === 'measurement' ? 'recorded a measurement' : kind === 'proof' ? 'recorded proof' : kind === 'note' ? 'added a note' : 'recorded a fact';
    const body = '<div class="tl-note' + (expanded ? ' expanded' : '') + '"><div class="tl-body">' + (fact.bodyHtml ?? esc(fact.text))
      + '</div><button type="button" data-timeline-more="' + esc(key) + '" aria-expanded="' + expanded + '">' + (expanded ? 'Show less' : 'Show all') + '</button></div>';
    rows.push({ type: 'fact', kind, by: fact.by, state: judgement ? 'back' : kind === 'measurement' ? 'measure' : kind === 'proof' ? 'proof' : 'note',
      classes: 'tl-fact' + (judgement ? ' tl-judgement' : '') + (replacement ? ' tl-superseded' : ''),
      id: key, eventIds: [fact.eventId], time: fact.timeLabel,
      sentence: who(fact) + ' ' + esc(fact.kindLabel || verb) + ' <span class="tl-kind tl-kind-' + kind + '">' + esc(fact.kindLabel ? fact.kind.replaceAll('-', ' ') : fact.kind) + '</span>' + (kind === 'fact' ? ' <span class="tl-kind-type">fact</span>' : ''),
      stay: fact.ageHtml + (replacement ? ' · <a class="thread-replacement" href="#fact-' + esc(replacement.id) + '">replaced by ' + esc(replacement.kindLabel || replacement.kind) + '</a>' : ''),
      body: body + (fact.hasCodeRef ? '<div class="tl-code">' + (fact.codeHtml || '') + '</div>' : '') });
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
  const grouped = [];
  for (const row of rows) {
    const previous = grouped.at(-1);
    if (row.type === 'move' && previous?.type === 'move' && row.from === previous.from && row.enters === previous.enters
      && row.kind === previous.kind && row.by === previous.by && row.state === previous.state && row.model === previous.model) {
      previous.count += 1; previous.lastTime = row.time; previous.eventIds.push(...row.eventIds);
    } else grouped.push({ ...row, eventIds: [...row.eventIds] });
  }
  // An event the history leaves out of view (a rule's milestone placement) rides on the row of the event before it.
  for (const { eventId, after } of folded) (grouped.find(row => row.eventIds.includes(after)) ?? grouped[0])?.eventIds.push(eventId);
  const ordered = newestFirst ? grouped.toReversed() : grouped;
  return '<ol class="tl">' + ordered.map(row => {
    const tone = ['health-failure', 'health-resolved'].includes(row.kind) ? 'sentinel' : ['claim', 'renew', 'submit'].includes(row.kind) ? 'build' : row.type === 'fact' ? row.state : row.kind === 'accept' ? 'pass' : row.kind === 'proof-run' ? 'proof'
      : ['reject', 'reopen'].includes(row.kind) ? 'back' : row.kind === 'reserve' ? 'review' : 'note';
    const kindLabel = row.type === 'move' && row.kind !== 'proof-run' ? '<span class="tl-kind tl-kind-move ' + tone + '">' + esc(({ build: 'build', review: 'review', back: 'sent back', sentinel: 'sentinel', pass: 'passed', note: 'note' })[tone]) + '</span>' : '';
    const mainHtml = row.sentence + (row.count > 1 ? row.count === 2 ? ' twice' : ' ' + row.count + ' times' : '') + (row.label ? ' ' + row.label : '') + (kindLabel ? ' ' + kindLabel : '');
    return sharedRowHtml({ variant: 'timeline', state: tone, className: row.classes,
      attributes: { id: row.id, 'data-event-id': row.eventIds[0], 'data-event-ids': row.eventIds.join(' '), 'data-timeline-kind': row.kind },
      iconHtml: icon(tone), mainHtml, time: row.count > 1 ? row.time + '–' + row.lastTime : row.time,
      metaHtml: row.stay, bodyHtml: row.body });
  }).join('') + '</ol>';
}
