/** Select Spec or Doctrine rows from explicit observations, without navigation or DOM state [N26,B26,C7]. */
export function ruleListModel(rows, { kind, filter, selectedId = null, addressed = false, feedback = null } = {}) {
  const defaults = kind === 'doctrine' ? rows.filter(row => row.origin === 'standard') : [];
  /** Keep inherited and repository sections separate even when both use the same Markdown heading. */
  const sectionKey = row => kind === 'doctrine' ? row.origin === 'standard' ? 'standard:' + row.section : 'repo:' + row.section : row.section;
  /** Inherited defaults are reviewed in repository doctrine; only local proposals ask for decisions. */
  /** An Approved row never waits for a ruling here; rows approved in Git are confirmed from the Rulings panel. */
  const undecided = row => row.status !== 'approved' && (['pending', 'draft'].includes(row.status) && !row.decision || Boolean(row.staleDecision)) && !(kind === 'doctrine' && row.origin === 'standard');
  const undecidedIds = rows.filter(undecided).map(row => row.id);
  const labels = { decide: 'Rulings', ...(defaults.length ? { defaults: 'To review' } : {}),
    all: 'All rows', approved: 'Approved' };
  const counts = { decide: undecidedIds.length, defaults: defaults.length, all: rows.length,
    approved: rows.filter(row => row.status === 'approved').length };
  const shown = rows.filter(row => filter === 'all' || (filter === 'decide' ? undecided(row)
    : filter === 'defaults' ? row.origin === 'standard' : row.status === 'approved'));
  const nextSelectedId = addressed || shown.some(row => row.id === selectedId) ? selectedId : shown[0]?.id ?? null;
  const feedbackId = feedback && (shown.some(row => row.id === feedback.id) ? feedback.id
    : shown.some(row => row.id === feedback.next) ? feedback.next : shown[0]?.id);
  const sectionCounts = new Map();
  const sectionReviewCounts = new Map();
  for (const row of shown) {
    const key = sectionKey(row);
    sectionCounts.set(key, (sectionCounts.get(key) || 0) + 1);
  }
  for (const row of rows) {
    const key = sectionKey(row);
    if (kind === 'doctrine' && row.origin === 'standard' && ['pending', 'draft'].includes(row.status))
      sectionReviewCounts.set(key, (sectionReviewCounts.get(key) || 0) + 1);
  }
  const decisionTitle = undecidedIds.length + ' drafts';
  return { decisionTitle, labels, counts, shown, nextSelectedId, feedbackId, sectionCounts, sectionReviewCounts, sectionKey, undecidedIds };
}
