/**
 * The view's stale mark on a verdict (N26, #726). Core (#409) decides staleness and publishes it as an
 * item's verdictState, {code: "STALE_VERDICT", file, commit, main, reason?, legacy?}; the view only
 * draws what it is given, so it never re-derives which files main moved.
 */

/**
 * A quiet "stale" chip for a verified item whose verdict main has moved under, or '' for any other
 * item. The status stays verified and the ACCEPT stays in the history: this is a mark beside them.
 * The title and the accessible name say why in full, the file and the commit, since the short word
 * alone cannot tell the person what moved.
 *
 * The page embeds this function's source, so it reads nothing outside itself, its own escaping
 * included.
 *
 * @param {{status?: string, merged?: string|null, stage?: string, verdictState?: {code?: string, file?: string|null, commit?: string|null, reason?: string, legacy?: boolean}|null}|null} item
 * @returns {string} The chip's markup, or ''.
 */
export function staleChip(item) {
  const state = item && item.verdictState;
  // A merged item's verdict is final whatever main does next; only a verified item waiting to land can go stale.
  // A summary row names a merge by its stage, an item's detail by its merged commit.
  if (!state || state.code !== 'STALE_VERDICT' || item.status !== 'verified' || item.merged || item.stage === 'merged') return '';
  const escape = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const why = state.file && state.commit
    ? 'main changed ' + state.file + ' in ' + state.commit + ' after this verdict checked it'
    : state.reason || 'main changed files this verdict checked';
  // A legacy receipt sealed no reviewed trunk, so Core judged it from the claim's base instead.
  const title = 'Stale verdict: ' + why + (state.legacy ? ' (an older receipt, judged from where the claim began)' : '') + '. Re-review it before it lands.';
  return '<span class="chip stale" role="img" title="' + escape(title) + '" aria-label="' + escape(title) + '">stale</span>';
}
