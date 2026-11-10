/** Preserve review wording and prepared note links without browser state [N26,C7]. */

/** Omit only a duplicated leading verdict code, preserving the rest of the recorded note. */
export function visibleVerdictNote(reason, note) {
  const text = String(note ?? ''), code = String(reason ?? ''), remainder = text.slice(code.length);
  return code && text.startsWith(code) && (!remainder || /^\s/u.test(remainder)) ? remainder.trimStart() : text;
}

/** Render a verdict with plain metadata and an explicitly prepared rich note. */
export function verdictHtml({ verdict, agentLabel, timeLabel, noteHtml, decisionLabel, reasonLabel }) {
  /** Only noteHtml is markup; metadata and the prepared time label remain plain text. */
  const esc = text => String(text ?? '').replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const { decision, reason, commit } = verdict;
  const shownReason = reasonLabel === undefined ? esc(reason) : '<span title="' + esc(reason) + '">' + esc(reasonLabel) + '</span>';
  return '<div class="verdict ' + (decision === 'ACCEPT' ? 'yes' : 'no') + '"><b>' + esc(decisionLabel ?? decision) + (reasonLabel === undefined ? ' ' : ' · ') + shownReason
    + '</b><span class="by">' + esc(agentLabel) + ' · ' + esc(timeLabel) + ' · at ' + (commit ? '<button class="hash-copy" type="button" title="' + esc(commit) + '" aria-label="Copy full hash ' + esc(commit) + '" data-copy="' + esc(commit) + '"><code class="inline sha" title="' + esc(commit) + '">' + esc(String(commit).slice(0, 12)) + '</code></button>' : '')
    + '</span><div class="note">' + noteHtml + '</div></div>';
}
