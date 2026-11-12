import { sharedRowHtml } from "../component.js";

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
    // A full hash stays whole for the copy button, which shows its first 12; any other recorded commit is cut to 12 as before #1602.
    const shown = commit => /^[a-f0-9]{40,64}$/u.test(commit ?? '') ? commit : String(commit ?? 'Unavailable').slice(0, 12);
    if (evidence.proof) fields.push(['Proof command', evidence.proof.check, true],
      ['Red proof', shown(evidence.proof.red?.commit)+' · exit '+evidence.proof.red?.exit, true,
        { title: evidence.proof.red?.commit, copy: evidence.proof.red?.commit }],
      ['Green proof', shown(evidence.proof.green?.commit)+' · exit '+evidence.proof.green?.exit, true,
        { title: evidence.proof.green?.commit, copy: evidence.proof.green?.commit }]);
    return fields;
  };
  /** Describe each call once for both browser presentation and HTML. */
  const describe = row => {
    const source = row.kind === 'agent-approved' ? project.spec?.find(entry => entry.id === row.id) : null;
    const approval = source?.agentApproval ?? row;
    if (row.kind === 'agent-approved') return { kind: 'approval', id: row.id, title: source?.text ?? 'Row text unavailable', context: 'Approved in Git · gate ' + (source?.gate || 'not recorded'), action: 'Confirm', fields: [
      ['Gate', source?.gate || 'Not recorded', true], ['Approved in Git', approval.agent || 'Unknown author', false, { date: approval.approvedAt }], ['Commit', approval.commit ? approval.commit.slice(0, 12) : 'Unavailable', true, { title: approval.commit, copy: approval.commit }]], body: source?.text ?? '' };
    if (row.kind === 'sentinel-draft') return { kind: 'sentinel', id: row.ref, title: 'Run ' + row.check + ' ' + row.every + ', reporting to ' + row.owner, context: 'Sentinel draft · not watching until you approve', action: 'Approve or decline', fields: [
      ['Command', row.check, true], ['Directory', row.directory, true], ['Schedule', row.every], ['Owner', row.owner], ['Proposed by', row.evidence ? 'An agent · ' + row.evidence.occurrences + ' repeats' : 'An agent, with no repeat cited'], ...evidenceFields(row)], body: '' };
    if (row.kind === 'rigor-draft') return { kind: 'question', id: row.ref, title: row.text, context: (row.unproved ? 'an unproved Rigor proposal' : 'a proved Rigor draft') + (row.evidence ? ', repeated ' + row.evidence.occurrences + ' times' : ''), action: 'Review', fields: [['Next step', row.what], ...evidenceFields(row)], body: row.text };
    if (row.kind === 'focus-approval-batch') return { kind: 'approval', id: row.ref, title: row.text || 'Approve the rows the focused release rests on', context: 'Focus approval · ' + (row.rows ?? []).length + ' draft rows', action: 'Review', fields: [], body: '', batch: row.rows ?? [] };
    if (row.kind === 'spec-revision') return { kind: 'question', id: row.ref ?? row.id, title: row.reason || 'Review the proposed row revision', context: 'Proposed spec revision · ' + (row.what || 'approve or decline'), action: 'Review', fields: [['Current row', row.source], ['Proposed row', row.replacement]], body: row.reason };
    if (row.kind === 'decision' && compact) {
      const cited = [...String(row.text ?? '').matchAll(/#(\d+)/gu)].map(match => (project.items || []).find(item => String(item.id) === match[1])).find(Boolean);
      return { kind: 'question', id: cited ? '#' + cited.id : '', title: cited ? 'Decide: ' + cited.title : 'Decision from ' + row.ref,
        context: 'Asked by ' + row.ref, action: 'Decide', fields: [['Asked by', row.ref]], body: row.text };
    }
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
    const revision = row.source.kind === 'spec-revision';
    const comparison = revision ? '<div class="revision-columns"><section data-revision-before><h3>Current row</h3><pre>'
      + escape(row.source.source) + '</pre></section><section data-revision-after><h3>Proposed row</h3><pre>'
      + escape(row.source.replacement) + '</pre></section></div><p class="revision-reason">' + escape(row.source.reason) + '</p>' : '';
    /** Render a code field with its short hash and full-value copy action when it carries a commit. */
    const fieldHtml = ([label, value, code, meta]) => {
      const hash = meta?.copy && /^[a-f0-9]{40,64}$/u.test(meta.copy) ? meta.copy : '';
      const suffix = hash && String(value).startsWith(hash) ? String(value).slice(hash.length) : '';
      const codeHtml = hash ? '<button class="hash-copy" type="button" title="' + escape(hash) + '" aria-label="Copy full hash ' + escape(hash) + '" data-copy="' + escape(hash) + '"><code class="inline sha" title="' + escape(hash) + '">' + escape(hash.slice(0, 12)) + '</code></button>' + escape(suffix)
        : '<code'+(meta?.title?' title="'+escape(meta.title)+'"':'')+'>' + escape(value) + '</code>';
      return '<dt>' + escape(label) + '</dt><dd data-needs-field="' + escape(label.toLowerCase().replace(/ /g,'-')) + '">' + (code ? codeHtml : escape(value)) + (label==='Approved in Git' ? ' · '+(Number.isFinite(Date.parse(meta?.date))?'<time datetime="'+escape(meta.date)+'" title="'+escape(meta.date)+'">'+escape(shown.approvalDateLabel || 'Date unknown')+'</time>':'Date unknown'):'') + '</dd>';
    };
    /** List each draft row of a focus approval with its kind, text and the items resting on it. */
    const batchHtml = rows => '<ul class="focus-batch">' + rows.map(entry => '<li data-batch-row="' + escape(entry.id) + '"><b>' + escape(entry.id) + '</b> <span class="focus-kind">' + escape(entry.kind) + '</span><p>' + escape(entry.text) + '</p><small>Items: '
      + ((entry.items ?? []).map(id => '#' + escape(id)).join(', ') || 'none') + '</small></li>').join('') + '</ul>';
    const detailHtml = '<div class="needs-detail">' + (row.batch ? batchHtml(row.batch) : '') + (revision ? comparison : (row.body ? '<p>' + (shown.bodyHtml ?? escape(row.body)) + '</p>' : '') + (row.fields.length ? '<dl>' + row.fields.map(fieldHtml).join('') + '</dl>' : ''))
      + (shown.feedbackHtml || '') + (shown.controlsHtml || '') + '</div>';
    return sharedRowHtml({ variant: 'needs', state: row.kind, id: row.id, title: row.title, meta: row.context, chip: row.action,
      iconHtml: ({ question: '?', sentinel: '◉', approval: '✓', draft: '≡' })[row.kind], timeHtml: row.ageAt ? shown.ageHtml || '' : '',
      className: row.source.kind === 'agent-approved' ? 'agent-approval' : row.batch ? 'focus-approval' : revision ? 'spec-revision' : '', attributes,
      detailsAttributes: { 'data-needs-key': row.key, 'data-dashboard-disclosure': 'needs:' + row.key },
      open: model.expanded.includes(row.key) || Boolean(row.batch), detailHtml });
  };
  const draftCopy = icon('draft') + '<span class="needs-copy"><b>' + model.drafts + ' draft spec rows to approve or drop</b><small>In the Spec tab, one by one or a section at a time</small></span><span class="needs-action">Review</span>';
  const draftRow = model.drafts ? '<li class="needs-call needs-drafts">' + (model.person
    ? '<button type="button" data-go="tab:spec">' + draftCopy + '</button>'
    : '<span>' + draftCopy + '</span>') + '</li>' : '';
  if (model.compact) {
    const shown = [...model.questions, ...model.approvals].slice(0, 3), more = model.sortedCount - shown.length;
    const text = more + ' more' + (model.drafts ? ' and ' + model.drafts + ' draft rows' : '');
    if (model.headerOnly) return more || model.drafts ? '<button class="needs-more" type="button" data-needs-list>' + text + ' →</button>' : '';
    return shown.map(rowHtml).join('') + (model.headerSeparately ? '' : more || model.drafts ? '<li class="needs-more"><button type="button" data-needs-list>' + text + ' in Needs you</button></li>' : '');
  }
  const confirmable = model.approvals.filter(row => row.confirmable);
  const group = (label, rows, extra = '') => rows.length ? '<li class="needs-group"><div class="needs-group-head"><h3>' + label + ' · ' + rows.length + '</h3>' + extra + '</div><ol>' + rows.map(rowHtml).join('') + '</ol></li>' : '';
  return group('Questions and sentinels', model.questions) + group('Rows approved in Git, waiting for you', model.approvals, model.person && confirmable.length ? '<button type="button" class="needs-confirm-all" data-needs-confirm="' + escape(confirmable.map(row => row.source.id).join(' ')) + '">Confirm all ' + confirmable.length + '</button>' : '') + (model.drafts ? '<li class="needs-group"><h3>Draft spec rows</h3><ol>' + draftRow + '</ol></li>' : '');
}
