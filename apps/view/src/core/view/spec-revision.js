/** Render a core-projected revision without changing its person authority or approved source [P6,B23,N39]. */
export function specRevisionScript() {
  return `
/** Show the exact before/after row and only the proposal actions supplied by the core. */
function specRevisionRow(row) {
  const person = !snapshot && (!readOnly || requests);
  const allowed = verb => person && Array.isArray(row.actions) && row.actions.some(action => action.verb === verb && action.args?.ids === row.id);
  const button = (decision, label) => '<button type="button" data-row-kind="spec" data-row-id="' + esc(row.id) + '" data-row-decision="' + decision + '">' + label + '</button>';
  const controls = (allowed('spec-approve') ? button('approve', 'Approve') : '') + (allowed('spec-decline') ? button('decline', 'Decline') : '');
  const feedback = view.specFeedback?.root === view.root && view.specFeedback.kind === 'spec' && view.specFeedback.id === row.id ? view.specFeedback : null;
  return '<li class="row ask spec-revision" data-spec-revision="' + esc(row.id) + '"><div>'
    + '<div class="t">' + esc(row.ref ?? row.id) + '</div><div class="revision-columns">'
    + '<section data-revision-before><h3>Current row</h3><pre>' + esc(row.source ?? row.old?.text ?? '') + '</pre></section>'
    + '<section data-revision-after><h3>Proposed row</h3><pre>' + esc(row.replacement ?? row.proposed?.text ?? '') + '</pre></section></div>'
    + '<p class="revision-reason">Reason: ' + esc(row.reason ?? '') + '</p>' + (feedback ? specFeedback(feedback) : '')
    + '<div class="meta"><span class="why"><b>NEEDS YOU</b> ' + esc(row.what ?? 'approve or decline revision') + '</span></div>'
    + (controls ? '<div class="actions">' + controls + '</div>' : '') + '</div></li>';
}
`;
}
