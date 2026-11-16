import { agentApprovalActionsHtml } from "../needs/actions.js";
import { specRevisionScript } from "../revision.js";
/** Render core-projected agent approval calls without inferring who approved a row [S1,B26,P6,N26]. */

/** Embed a Rulings row renderer that reuses the existing person decision pipeline. */
export function agentApprovalScript() {
  return `
const agentApprovalActionsHtml = (${agentApprovalActionsHtml.toString()});
/** Supply browser authority explicitly before rendering the snapshot's advertised actions. */
function agentApprovalActions(row, detail = false) {
  return agentApprovalActionsHtml(row, { person: !snapshot && (!readOnly || requests), detail });
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
    + '<p>Commit: ' + (commit ? '<button class="hash-copy" type="button" title="' + esc(commit) + '" aria-label="Copy full hash ' + esc(commit) + '" data-copy="' + esc(commit) + '"><code class="inline sha" title="' + esc(commit) + '">' + esc(commit.slice(0, 12)) + '</code></button>' : '<code>unavailable</code>') + '</p>'
    + (feedback ? specFeedback(feedback) : '')
    + '<div class="meta"><span class="why"><b>RULING</b> agent-approved; confirm or decline this row</span></div>' + agentApprovalActions(row) + '</div></li>';
}
${specRevisionScript()}
`;
}
