/**
 * Older history still on its way (#956). After #903 a phone opens a relay board from its current state and
 * streams the older shouts, item threads and event log in the background. While that stream runs, Shouts,
 * Activity and an item's history end in one quiet line saying older entries are still loading, with how far
 * along it is when the transport knows. Reaching that line asks for the next page instead of stopping there.
 * Once the history is complete the line goes away. A board that holds all its history never shows it.
 */

/**
 * The line for one list, or '' when nothing is loading. The page embeds this function's source, so it reads
 * nothing outside itself, its own escaping included.
 *
 * @param {{loaded?: number, total?: number|null, complete?: boolean, error?: string}|null} progress - The transport's historyProgress(boardId).
 * @param {'shouts'|'activity'|'item'} kind - Which list the line ends.
 * @returns {string} The line's markup, or ''.
 */
export function historyNote(progress, kind) {
  if (!progress || progress.complete) return '';
  const escape = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const what = kind === 'shouts' ? 'Older shouts are' : kind === 'activity' ? 'Older activity is' : 'Older entries are';
  const known = Number.isFinite(progress.total) && progress.total > 0 && Number.isFinite(progress.loaded);
  const share = known ? Math.min(99, Math.floor(progress.loaded / progress.total * 100)) : null;
  const text = progress.error ? String(progress.error) : what + ' still loading' + (share === null ? '.' : ' (' + share + '%).');
  return '<p class="history-note' + (progress.error ? ' failed' : '') + '" role="status" data-history-note="' + kind + '">' + escape(text) + '</p>';
}

/**
 * The page's script for the line: where it goes, how it follows the transport's count, and the next page it
 * asks for at the end of a list. Shouts read the next ten older shouts by their addresses, which the relay
 * answers from its sealed pages; Activity and an item's history ask the transport for the board again, which
 * draws what has arrived and resumes a stream that stopped.
 *
 * @returns {string} Script text for the page, inside its template literal.
 */
export function historyLoadingScript() {
  return `const historyNote = (${historyNote.toString()});
// Older shouts read at the end of the feed while history streams, by board, newest first.
const olderShouts = new Map();
const HISTORY_PAGE = 10;
let historyWatch = null, historyTicker = null, historyAsking = false, historyAskedAt = 0;
// The lists whose end is in view: each tick asks for their next page while it stays there.
const historyAtEnd = new Set();

/** The shown board's history progress while it is still arriving, or null once complete or for a local board. */
function historyProgressFor(root = view.root) {
  const board = data?.projects?.find((entry) => entry.root === root && entry.ok);
  if (!board || !relayProject(root)) return null;
  const live = typeof transport?.historyProgress === 'function' ? transport.historyProgress(board.id) : null;
  const progress = live || (data.root === root ? data.project?.historyProgress : null);
  return progress && !progress.complete ? progress : null;
}

/** The older shouts already read for this board that its current forty do not hold. */
function olderShoutsOf(root, shouts) {
  const kept = olderShouts.get(root);
  if (!kept) return [];
  const held = new Set(shouts.map((shout) => shout.shout_id));
  return kept.shouts.filter((shout) => !held.has(shout.shout_id));
}

/** End Shouts, Activity and the open item's history with the loading line, and watch each end for the next page. */
function drawHistoryNotes() {
  const progress = historyProgressFor();
  if (!progress) { stopHistoryNotes(); return; }
  for (const old of document.querySelectorAll('[data-history-note]')) old.remove();
  const places = [['shouts', $('feed')], ['activity', $('activity')],
    ['item', $('detail').querySelector('[data-item-panel-panel=history]') ?? [...$('detail').querySelectorAll('h3')].find((head) => head.textContent === 'History')?.parentElement]];
  historyWatch?.disconnect(); historyAtEnd.clear();
  historyWatch = typeof IntersectionObserver === 'function' ? new IntersectionObserver((seen) => {
    for (const entry of seen) {
      const kind = entry.target.dataset.historyNote;
      if (entry.isIntersecting) { historyAtEnd.add(kind); void historyNextPage(kind); } else historyAtEnd.delete(kind);
    }
  }, { rootMargin: '0px 0px 200px 0px' }) : null;
  for (const [kind, place] of places) {
    if (!place) continue;
    place.insertAdjacentHTML('beforeend', historyNote(progress, kind));
    historyWatch?.observe(place.lastElementChild);
  }
  historyTicker ??= setInterval(tickHistoryNotes, 500);
}

/** Follow the transport's count in place and keep paging a list whose end stays in view; once complete, the lines go. */
function tickHistoryNotes() {
  const progress = historyProgressFor();
  if (!progress) { stopHistoryNotes(); return; }
  for (const note of document.querySelectorAll('[data-history-note]')) {
    const fresh = historyNote(progress, note.dataset.historyNote);
    if (fresh === note.outerHTML) continue;
    historyWatch?.unobserve(note);
    note.insertAdjacentHTML('afterend', fresh);
    historyWatch?.observe(note.nextElementSibling);
    note.remove();
  }
  for (const kind of historyAtEnd) void historyNextPage(kind);
}

/** Take the lines away and stop following the count. */
function stopHistoryNotes() {
  if (historyTicker === null && historyWatch === null) return;
  clearInterval(historyTicker); historyTicker = null;
  historyWatch?.disconnect(); historyWatch = null; historyAtEnd.clear();
  for (const note of document.querySelectorAll('[data-history-note]')) note.remove();
}

/**
 * The end of a list is in view while history streams: ask for its next page, one at a time. The relay
 * answers an addressed shout from its sealed pages, so the feed grows by ten older shouts; the board read
 * again at most every two seconds draws whatever older activity and threads have arrived.
 */
async function historyNextPage(kind) {
  const root = view.root;
  if (historyAsking || !historyProgressFor(root)) return;
  const kept = olderShouts.get(root) ?? { shouts: [], below: null };
  const shown = [...(data.project?.shouts ?? []), ...kept.shouts].map((shout) => shout.shout_id);
  const below = kept.below ?? (shown.length ? Math.min(...shown) : 0);
  if (kind === 'shouts' ? below <= 1 : Date.now() - historyAskedAt < 2000) return;
  historyAsking = true;
  try {
    if (kind === 'shouts') {
      const ids = Array.from({ length: Math.min(HISTORY_PAGE, below - 1) }, (_, n) => below - 1 - n);
      const read = await Promise.allSettled(ids.map((id) => api(boardPath(root) + '/shouts/' + id)));
      const found = read.filter((reply) => reply.status === 'fulfilled' && reply.value?.shout).map((reply) => reply.value.shout);
      olderShouts.set(root, { shouts: [...kept.shouts, ...found].sort((a, b) => b.shout_id - a.shout_id), below: ids.at(-1) });
      if (view.root === root) render();
    } else {
      historyAskedAt = Date.now();
      await refresh();
    }
  } catch (error) {
    $('live').textContent = 'offline: ' + (error.message || error);
  } finally { historyAsking = false; }
}
`;
}
