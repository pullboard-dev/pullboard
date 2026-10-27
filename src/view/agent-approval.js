import { specRevisionScript } from './spec-revision.js';
/** Render core-projected agent approval calls without inferring who approved a row [S1,B26,P6,N26]. */

/** Embed a Needs-you row renderer that reuses the existing person decision pipeline. */
export function agentApprovalScript() {
  return `
/** Reuse only core-advertised person moves on either approval surface. */
function agentApprovalActions(row, detail = false) {
  const person = !snapshot && (!readOnly || requests);
  const allowed = verb => person && Array.isArray(row.actions) && row.actions.some(action => action.verb === verb && action.args?.ids === row.id);
  const button = (decision, label) => '<button class="' + (decision === 'approve' ? 'approve-row' : 'decline-row') + '" type="button" data-row-kind="spec" data-row-id="' + esc(row.id) + '" data-row-decision="' + decision + '">' + label + '</button>';
  const controls = (allowed('spec-approve') ? button('approve', 'Confirm') : '') + (allowed('spec-decline') ? button('decline', 'Decline') : '');
  return controls ? '<div class="spec-decision-actions actions' + (detail ? ' detail-decision-actions' : '') + '">' + controls + '</div>' : '';
}
/** Show Git provenance plainly without treating a Git author as a confirmed person. */
function agentApprovalAttribution(approval) {
  const at = approval?.approvedAt;
  const date = typeof at === 'string' && Number.isFinite(Date.parse(at)) ? '<time datetime="' + esc(at) + '">' + esc(new Date(at).toLocaleString()) + '</time>' : 'Date unknown';
  return '<p class="approval-attribution">Approved in Git by ' + esc(approval?.agent ?? 'unknown author') + ' · ' + date + '. Person confirmation pending.</p>';
}
/** Render the complete current row from this same board snapshot, plus literal provenance. */
function agentApprovalRow(row) {
  const source = data.project.spec.find(entry => entry.id === row.id);
  const approval = source?.agentApproval ?? row;
  const commit = approval.commit;
  const feedback = view.specFeedback?.root === view.root && view.specFeedback.kind === 'spec' && view.specFeedback.id === row.id ? view.specFeedback : null;
  return '<li class="row ask agent-approval" data-agent-approved="' + esc(row.id) + '"><span class="dot ask"></span><div><div class="t"><span>' + esc(row.ref ?? row.id) + '</span>' + esc(source?.text ?? 'Row text unavailable') + '</div>'
    + '<p class="approval-gate">Gate: ' + esc(source?.gate || 'No gate recorded') + '</p>' + agentApprovalAttribution(approval)
    + '<p>Commit: <code title="' + esc(commit ?? '') + '">' + esc(commit ? commit.slice(0, 12) : 'unavailable') + '</code></p>'
    + (feedback ? specFeedback(feedback) : '')
    + '<div class="meta"><span class="why"><b>NEEDS YOU</b> agent-approved; confirm or decline this row</span></div>' + agentApprovalActions(row) + '</div></li>';
}
${specRevisionScript()}
`;
}
