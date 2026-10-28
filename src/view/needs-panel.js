import { sharedRowHtml } from './row-component.js';

/** One presentation for the person's calls, shared by the full list and Dashboard [N26,B26]. */
export function needsPanelHtml(calls, project, { compact = false, person = false, expanded = [], controls = () => '', feedback = () => '', rich = null, age = () => '' } = {}) {
  /** Board text is escaped independently of the page's trusted action renderers. */
  function escape(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
  /** Match the approved month/day and minute display while the time element retains the full instant. */
  const approvalDate = value => {
    const date = new Date(value), hour = date.getHours();
    return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][date.getMonth()] + ' ' + date.getDate() + ', ' + (hour % 12 || 12) + ':' + String(date.getMinutes()).padStart(2, '0') + ' ' + (hour < 12 ? 'AM' : 'PM');
  };
  const glyphs = { question: '?', sentinel: '◉', approval: '✓', draft: '≡' };
  /** Native summary elements supply keyboard, expanded-state and focus behavior without another listener. */
  const icon = kind => '<span class="needs-kind needs-kind-' + kind + '" aria-hidden="true">' + glyphs[kind] + '</span>';
  const drafts = calls.find(row => row.kind === 'draft')?.count ?? 0;
  const sorted = calls.filter(row => row.kind !== 'draft').map(row => row.kind === 'hold' ? { ...row, at: row.at ?? project.holds?.find(hold => hold.hold_lane === row.id)?.hold_at } : row).toSorted((a, b) => (Date.parse(a.at ?? a.approvedAt) || 0) - (Date.parse(b.at ?? b.approvedAt) || 0));
  const approvals = sorted.filter(row => row.kind === 'agent-approved');
  const questions = sorted.filter(row => row.kind !== 'agent-approved');
  /** Retain the recorded repeat and red/green provenance when a watch or Rigor draft cites it. */
  const evidenceFields = row => {
    const evidence = row.evidence;
    if (!evidence) return [];
    const fields = [['Repeated cause', evidence.key], ['Cited items', (evidence.items ?? []).map(item => '#'+item.id).join(', ') || 'None recorded']];
    if (evidence.proof) fields.push(['Proof command', evidence.proof.check, true],
      ['Red proof', String(evidence.proof.red?.commit ?? 'Unavailable').slice(0,12)+' · exit '+evidence.proof.red?.exit, true],
      ['Green proof', String(evidence.proof.green?.commit ?? 'Unavailable').slice(0,12)+' · exit '+evidence.proof.green?.exit, true]);
    return fields;
  };
  /** Keep the original row, including its advertised actions, attached to its presentation. */
  const describe = row => {
    const source = row.kind === 'agent-approved' ? project.spec?.find(entry => entry.id === row.id) : null;
    const approval = source?.agentApproval ?? row;
    if (row.kind === 'agent-approved') return { kind: 'approval', id: row.id, title: source?.text ?? 'Row text unavailable', context: 'Approved in Git · gate ' + (source?.gate || 'not recorded'), action: 'Confirm', fields: [
      ['Gate', source?.gate || 'Not recorded', true], ['Approved in Git', approval.agent || 'Unknown author', false, { date: approval.approvedAt }], ['Commit', approval.commit ? approval.commit.slice(0, 12) : 'Unavailable', true, { title: approval.commit }]], body: source?.text ?? '' };
    if (row.kind === 'sentinel-draft') return { kind: 'sentinel', id: row.ref, title: 'Run ' + row.check + ' ' + row.every + ', reporting to ' + row.owner, context: 'Sentinel draft · not watching until you approve', action: 'Approve or decline', fields: [
      ['Command', row.check, true], ['Directory', row.directory, true], ['Schedule', row.every], ['Owner', row.owner], ['Proposed by', row.evidence ? 'An agent · ' + row.evidence.occurrences + ' repeats' : 'An agent, with no repeat cited'], ...evidenceFields(row)], body: '' };
    if (row.kind === 'rigor-draft') return { kind: 'question', id: row.ref, title: row.text, context: (row.unproved ? 'an unproved Rigor proposal' : 'a proved Rigor draft') + (row.evidence ? ', repeated ' + row.evidence.occurrences + ' times' : ''), action: 'Review', fields: [['Next step', row.what], ...evidenceFields(row)], body: row.text };
    if (row.kind === 'spec-revision') return { kind: 'question', id: row.ref ?? row.id, title: row.reason || 'Review the proposed row revision', context: 'Proposed spec revision · ' + (row.what || 'approve or decline'), action: 'Review', fields: [['Current row', row.source], ['Proposed row', row.replacement]], body: row.reason };
    return { kind: 'question', id: row.kind === 'decision' ? '#' + row.id : row.ref, title: String(row.text ?? '').split(/\n/u)[0], context: row.kind === 'decision' ? 'Asked by ' + row.ref : row.what, action: row.kind === 'decision' ? 'Decide' : row.kind === 'relay-health' ? 'Inspect' : row.kind === 'block' ? 'Next step' : 'Review', fields: [...(row.kind === 'decision' ? [['Asked by', row.ref]] : row.what ? [['Next step', row.what]] : []), ...evidenceFields(row)], body: row.text };
  };
  /** Render every kind through the same two-line summary and in-place details. */
  const rowHtml = row => {
    // Blocks use only their public reference and timestamp; their internal id contains the refused command.
    const d = describe(row), key = row.kind + ':' + (row.kind === 'block' ? row.ref + ':' + row.at : row.id);
    const attributes = row.kind === 'agent-approved' ? { 'data-agent-approved': row.id } : row.kind === 'sentinel-draft' ? { 'data-sentinel-draft': row.ref } : row.kind === 'spec-revision' ? { 'data-spec-revision': row.id } : {};
    const detailHtml = '<div class="needs-detail">' + (d.body ? '<p>' + (rich ?? escape)(d.body) + '</p>' : '') + (d.fields.length ? '<dl>' + d.fields.map(([label, value, code, meta]) => '<dt>' + escape(label) + '</dt><dd data-needs-field="' + escape(label.toLowerCase().replace(/ /g,'-')) + '">' + (code ? '<code'+(meta?.title?' title="'+escape(meta.title)+'"':'')+'>' + escape(value) + '</code>' : escape(value)) + (label==='Approved in Git' ? ' · '+(Number.isFinite(Date.parse(meta?.date))?'<time datetime="'+escape(meta.date)+'" title="'+escape(meta.date)+'">'+escape(approvalDate(meta.date))+'</time>':'Date unknown'):'') + '</dd>').join('') + '</dl>' : '')
      + feedback(row) + controls(row) + '</div>';
    return sharedRowHtml({ variant: 'needs', state: d.kind, id: d.id, title: d.title, meta: d.context, chip: d.action,
      iconHtml: glyphs[d.kind], timeHtml: row.at || row.approvedAt ? age(row.at ?? row.approvedAt) : '',
      className: row.kind === 'agent-approved' ? 'agent-approval' : '', attributes,
      detailsAttributes: { 'data-needs-key': key, 'data-dashboard-disclosure': 'needs:' + key }, open: expanded.includes(key), detailHtml });
  };
  const draftCopy = icon('draft') + '<span class="needs-copy"><b>' + drafts + ' draft spec rows to approve or drop</b><small>In the Spec tab, one by one or a section at a time</small></span><span class="needs-action">Review</span>';
  const draftRow = drafts ? '<li class="needs-call needs-drafts">' + (person
    ? '<button type="button" data-go="tab:spec">' + draftCopy + '</button>'
    : '<span>' + draftCopy + '</span>') + '</li>' : '';
  if (compact) {
    const shown = [...questions, ...approvals].slice(0, 3), more = sorted.length - shown.length;
    return shown.map(rowHtml).join('') + (more || drafts ? '<li class="needs-more"><button type="button" data-needs-list>' + more + ' more' + (drafts ? ' and ' + drafts + ' draft rows' : '') + ' in Needs you</button></li>' : '');
  }
  const confirmable = approvals.filter(row => row.actions?.some(action => action.verb === 'spec-approve' && action.args?.ids === row.id));
  const group = (label, rows, extra = '') => rows.length ? '<li class="needs-group"><div class="needs-group-head"><h3>' + label + ' · ' + rows.length + '</h3>' + extra + '</div><ol>' + rows.map(rowHtml).join('') + '</ol></li>' : '';
  return group('Questions and sentinels', questions) + group('Rows approved in Git, waiting for you', approvals, person && confirmable.length ? '<button type="button" class="needs-confirm-all" data-needs-confirm="' + escape(confirmable.map(row => row.id).join(' ')) + '">Confirm all ' + confirmable.length + '</button>' : '') + (drafts ? '<li class="needs-group"><h3>Draft spec rows</h3><ol>' + draftRow + '</ol></li>' : '');
}
