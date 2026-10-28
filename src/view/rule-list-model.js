/** Select Spec or Doctrine rows from explicit observations, without navigation or DOM state [N26,B26,C7]. */
export function ruleListModel(rows, { kind, filter, selectedId = null, addressed = false, approvalIds = [], feedback = null } = {}) {
  const approvals = new Set(approvalIds);
  const defaults = kind === 'doctrine' ? rows.filter(row => row.origin === 'standard') : [];
  /** Inherited defaults are reviewed in repository doctrine; only local proposals ask for decisions. */
  const undecided = row => (['pending', 'draft'].includes(row.status) && !row.decision || Boolean(row.staleDecision)
    || kind === 'spec' && approvals.has(row.id)) && !(kind === 'doctrine' && row.origin === 'standard');
  const undecidedIds = rows.filter(undecided).map(row => row.id);
  const labels = { decide: 'Needs your decision', ...(defaults.length ? { defaults: 'Defaults to review' } : {}),
    all: 'All rows', approved: 'Approved' };
  const counts = { decide: undecidedIds.length, defaults: defaults.length, all: rows.length,
    approved: rows.filter(row => row.status === 'approved').length };
  const shown = rows.filter(row => filter === 'all' || (filter === 'decide' ? undecided(row)
    : filter === 'defaults' ? row.origin === 'standard' : row.status === 'approved'));
  const nextSelectedId = addressed || shown.some(row => row.id === selectedId) ? selectedId : shown[0]?.id ?? null;
  const feedbackId = feedback && (shown.some(row => row.id === feedback.id) ? feedback.id
    : shown.some(row => row.id === feedback.next) ? feedback.next : shown[0]?.id);
  const sectionCounts = new Map();
  for (const row of shown) sectionCounts.set(row.section, (sectionCounts.get(row.section) || 0) + 1);
  return { labels, counts, shown, nextSelectedId, feedbackId, sectionCounts, undecidedIds };
}
