/** Render only the person controls advertised by the same snapshot [N26,B26,C7]. */

/** Agent approval buttons require an explicit person surface and exact row action identity. */
export function agentApprovalActionsHtml(row, { person = false, detail = false } = {}) {
  /** Escape row identities before using them in data attributes. */
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  /** A different row or a different verb grants no control on this row. */
  const allowed = verb => person && Array.isArray(row.actions) && row.actions.some(action => action.verb === verb && action.args?.ids === row.id);
  /** Keep existing person handlers and decision values unchanged. */
  const button = (decision, label) => '<button class="' + (decision === 'approve' ? 'approve-row' : 'decline-row') + '" type="button" data-row-kind="spec" data-row-id="' + esc(row.id) + '" data-row-decision="' + decision + '">' + label + '</button>';
  const controls = (allowed('spec-approve') ? button('approve', 'Confirm') : '') + (allowed('spec-decline') ? button('decline', 'Decline') : '');
  return controls ? '<div class="spec-decision-actions actions' + (detail ? ' detail-decision-actions' : '') + '">' + controls + '</div>' : '';
}

/** Render ordinary Needs controls using explicit authority and prepared special-purpose button HTML. */
export function needsActionsHtml(row, { person = false, approvalHtml = '', sentinelHtml = '' } = {}) {
  /** All ordinary targets and revision identities remain escaped plain data. */
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  if (!person) return '';
  if (row.kind === 'agent-approved') return approvalHtml;
  if (row.kind === 'sentinel-draft') return sentinelHtml;
  if (row.kind === 'relay-health' || row.kind === 'block') return '';
  if (row.kind === 'spec-revision') return '<div class="actions">' + (row.actions ?? []).filter(action => ['spec-approve', 'spec-decline'].includes(action.verb) && action.args?.ids === row.id).map(action => '<button type="button" class="' + (action.verb === 'spec-approve' ? 'approve-row' : 'decline-row') + '" data-row-kind="spec" data-row-id="' + esc(row.id) + '" data-row-decision="' + (action.verb === 'spec-approve' ? 'approve' : 'decline') + '">' + (action.verb === 'spec-approve' ? 'Approve' : 'Decline') + '</button>').join('') + '</div>';
  const target = row.kind === 'decision' ? 'decide:' + row.id : row.kind === 'pending' ? 'spec:' + row.id : row.kind === 'hold' ? 'tab:shouts' : row.target;
  if (!target || row.unproved && !row.materialized) return '';
  return '<div class="actions"><button type="button" class="approve-row" data-go="' + esc(target) + '">' + (row.kind === 'decision' ? 'Decide' : 'Review') + '</button></div>';
}
