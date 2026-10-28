import { sharedRowHtml } from './row-component.js';

/** Project the person's calls into grouped presentation rows without browser state [N26,B26]. */
export function needsPanelModel(calls, project, { compact = false, person = false, expanded = [] } = {}) {
  const drafts = calls.find(row => row.kind === 'draft')?.count ?? 0;
  const sorted = calls.filter(row => row.kind !== 'draft').map(row => row.kind === 'hold'
    ? { ...row, at: row.at ?? project.holds?.find(hold => hold.hold_lane === row.id)?.hold_at } : row)
    .toSorted((a, b) => (Date.parse(a.at ?? a.approvedAt) || 0) - (Date.parse(b.at ?? b.approvedAt) || 0));
  /** Retain repeated causes and recorded proof references in the row model. */
  const evidenceFields = row => {
    const evidence = row.evidence;
    if (!evidence) return [];
    const fields = [['Repeated cause', evidence.key], ['Cited items', (evidence.items ?? []).map(item => '#'+item.id).join(', ') || 'None recorded']];
    if (evidence.proof) fields.push(['Proof command', evidence.proof.check, true],
      ['Red proof', String(evidence.proof.red?.commit ?? 'Unavailable').slice(0,12)+' · exit '+evidence.proof.red?.exit, true],
      ['Green proof', String(evidence.proof.green?.commit ?? 'Unavailable').slice(0,12)+' · exit '+evidence.proof.green?.exit, true]);
    return fields;
  };
  /** Describe each call once for both browser presentation and HTML. */
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
  const rows = sorted.map(row => {
    const described = describe(row), key = row.kind + ':' + (row.kind === 'block' ? row.ref + ':' + row.at : row.id);
    const attribute = row.kind === 'agent-approved' ? ['data-agent-approved', row.id]
      : row.kind === 'sentinel-draft' ? ['data-sentinel-draft', row.ref]
      : row.kind === 'spec-revision' ? ['data-spec-revision', row.id] : null;
    return { ...described, key, attribute, source: row, ageAt: row.at || row.approvedAt ? row.at ?? row.approvedAt : null,
      confirmable: row.kind === 'agent-approved' && row.actions?.some(action => action.verb === 'spec-approve' && action.args?.ids === row.id) };
  });
  const approvals = rows.filter(row => row.source.kind === 'agent-approved');
  const questions = rows.filter(row => row.source.kind !== 'agent-approved');
  return { questions, approvals, sortedCount: rows.length, drafts, compact, person, expanded };
}

/** Render a needsPanelModel and explicit trusted, escaped or localized presentation values [N26,C7]. */
export function needsPanelHtml(model, presentation = new Map()) {
  function escape(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
  const icon = kind => '<span class="needs-kind needs-kind-' + kind + '" aria-hidden="true">' + ({ question: '?', sentinel: '◉', approval: '✓', draft: '≡' })[kind] + '</span>';
  /** Render one model row from its prepared browser presentation values. */
  const rowHtml = row => {
    const shown = presentation.get(row.key) || {};
    const attributes = row.attribute ? { [row.attribute[0]]: row.attribute[1] } : {};
    const detailHtml = '<div class="needs-detail">' + (row.body ? '<p>' + (shown.bodyHtml ?? escape(row.body)) + '</p>' : '') + (row.fields.length ? '<dl>' + row.fields.map(([label, value, code, meta]) => '<dt>' + escape(label) + '</dt><dd data-needs-field="' + escape(label.toLowerCase().replace(/ /g,'-')) + '">' + (code ? '<code'+(meta?.title?' title="'+escape(meta.title)+'"':'')+'>' + escape(value) + '</code>' : escape(value)) + (label==='Approved in Git' ? ' · '+(Number.isFinite(Date.parse(meta?.date))?'<time datetime="'+escape(meta.date)+'" title="'+escape(meta.date)+'">'+escape(shown.approvalDateLabel || 'Date unknown')+'</time>':'Date unknown'):'') + '</dd>').join('') + '</dl>' : '')
      + (shown.feedbackHtml || '') + (shown.controlsHtml || '') + '</div>';
    return sharedRowHtml({ variant: 'needs', state: row.kind, id: row.id, title: row.title, meta: row.context, chip: row.action,
      iconHtml: ({ question: '?', sentinel: '◉', approval: '✓', draft: '≡' })[row.kind], timeHtml: row.ageAt ? shown.ageHtml || '' : '',
      className: row.source.kind === 'agent-approved' ? 'agent-approval' : '', attributes,
      detailsAttributes: { 'data-needs-key': row.key, 'data-dashboard-disclosure': 'needs:' + row.key },
      open: model.expanded.includes(row.key), detailHtml });
  };
  const draftCopy = icon('draft') + '<span class="needs-copy"><b>' + model.drafts + ' draft spec rows to approve or drop</b><small>In the Spec tab, one by one or a section at a time</small></span><span class="needs-action">Review</span>';
  const draftRow = model.drafts ? '<li class="needs-call needs-drafts">' + (model.person
    ? '<button type="button" data-go="tab:spec">' + draftCopy + '</button>'
    : '<span>' + draftCopy + '</span>') + '</li>' : '';
  if (model.compact) {
    const shown = [...model.questions, ...model.approvals].slice(0, 3), more = model.sortedCount - shown.length;
    return shown.map(rowHtml).join('') + (more || model.drafts ? '<li class="needs-more"><button type="button" data-needs-list>' + more + ' more' + (model.drafts ? ' and ' + model.drafts + ' draft rows' : '') + ' in Needs you</button></li>' : '');
  }
  const confirmable = model.approvals.filter(row => row.confirmable);
  const group = (label, rows, extra = '') => rows.length ? '<li class="needs-group"><div class="needs-group-head"><h3>' + label + ' · ' + rows.length + '</h3>' + extra + '</div><ol>' + rows.map(rowHtml).join('') + '</ol></li>' : '';
  return group('Questions and sentinels', model.questions) + group('Rows approved in Git, waiting for you', model.approvals, model.person && confirmable.length ? '<button type="button" class="needs-confirm-all" data-needs-confirm="' + escape(confirmable.map(row => row.source.id).join(' ')) + '">Confirm all ' + confirmable.length + '</button>' : '') + (model.drafts ? '<li class="needs-group"><h3>Draft spec rows</h3><ol>' + draftRow + '</ol></li>' : '');
}
