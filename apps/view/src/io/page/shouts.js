/** The Shouts page's own script: this viewer's read marks, opening and closing a thread in place, and the reply box inside it [N26]. */

/**
 * The script text for Shouts. It runs inside the page's own script, so it reads the page's `view`, `data`, `keep`, `act`, `address`,
 * `render` and `$` directly, and fetches nothing.
 *
 * @returns {string} Script text to place after the page's other parts.
 */
export function shoutsScript() {
  return `/**
 * One viewer's read marks for a board's Shouts, kept in this browser only and never written to the board: the time they last had
 * Shouts open (the base every newer shout counts as unread from) and the threads they opened since. A browser that refuses storage
 * keeps the marks for the page's life; with no mark yet nothing counts as unread.
 */
function shoutSeen(root) {
  if (!shoutMarks.has(root)) {
    let kept = null;
    try { kept = JSON.parse(keep('pb.shouts.' + root) || 'null'); } catch { kept = null; }
    shoutMarks.set(root, { base: Number.isFinite(kept?.seen) ? kept.seen : null, read: kept?.read && typeof kept.read === 'object' ? kept.read : {} });
  }
  return shoutMarks.get(root);
}

/** Keep this viewer's marks for a board. */
function writeShoutSeen(root) {
  const marks = shoutSeen(root);
  keep('pb.shouts.' + root, JSON.stringify({ seen: marks.base, read: marks.read }));
}

/** Read one thread: every shout it holds so far. */
function markShoutRead(root, key) {
  shoutSeen(root).read[key] = Date.now();
  writeShoutSeen(root);
}

/** Leaving Shouts moves the base to now, so the next visit counts only what came after. */
function leaveShouts() {
  if (!view.root) return;
  const marks = shoutSeen(view.root);
  marks.base = Date.now();
  marks.read = {};
  writeShoutSeen(view.root);
}

/** Mark every thread read, as of now. */
function markAllShoutsRead() {
  const marks = shoutSeen(view.root);
  marks.base = Date.now();
  marks.read = {};
  writeShoutSeen(view.root);
  render();
}

/** Open one thread in place, or close the open one: the address carries the open thread as its newest shout. */
function openShoutThread(key) {
  const closing = key === null || key === shoutOpenKey;
  view.shoutThread = closing ? null : key;
  view.shout = null;
  const newest = closing ? undefined : shoutThreadIds.get(key);
  view.addressDetail = newest === undefined ? null : String(newest);
  if (!closing) markShoutRead(view.root, key);
  address(false);
  render();
}

/** Put each thread's unsent reply back after a draw, and the cursor where it was. */
function restoreShoutDrafts(focusKey, caret) {
  for (const form of $('feed').querySelectorAll?.('[data-reply]') ?? []) {
    const input = form.querySelector('input'), draft = shoutDrafts.get(form.dataset.reply);
    if (draft && input.value !== draft) input.value = draft;
    if (focusKey === form.dataset.reply) { input.focus({ preventScroll: true }); if (caret !== null) try { input.setSelectionRange(caret, caret); } catch { /* a field that refuses a caret keeps its end */ } }
  }
}
// An open thread closes with Escape; a reply is kept as it is typed so a redraw never loses it, and sent from the thread's own box.
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !event.defaultPrevented && view.tab === 'shouts' && shoutOpenKey) openShoutThread(null); });
globalThis.addEventListener?.('pagehide', () => { if (view.tab === 'shouts') leaveShouts(); });
$('feed').addEventListener('input', (event) => {
  const form = event.target.closest?.('[data-reply]');
  if (form) shoutDrafts.set(form.dataset.reply, event.target.value);
});
$('feed').addEventListener('submit', async (event) => {
  const form = event.target.closest?.('[data-reply]');
  if (!form) return;
  event.preventDefault();
  const input = form.querySelector('input'), text = input.value.trim(), key = form.dataset.reply, ask = form.dataset.ask;
  if (!text) return;
  // The move's result line lives beside the (folded) composer, never inside the feed a redraw replaces; a refusal opens the composer so it shows.
  const anchor = $('shout-form');
  const lane = key.startsWith('item:') ? data.project.items.find((entry) => String(entry.id) === key.slice(5))?.lane : null;
  const sent = await (ask ? act(form.hasAttribute('data-ordinary') ? 'coordinator-answer' : 'answer', { id: Number(ask), text }, anchor)
    : lane ? act('shout', { to: lane, text: '#' + key.slice(5) + ': ' + text }, anchor) : act('request', { text: key.startsWith('item:') ? '#' + key.slice(5) + ': ' + text : text }, anchor));
  if (!sent) $('shouts-pane').dataset.compose = 'open';
  if (sent && ask && view.answering) answer(null);
  if (sent && input.isConnected && input.value.trim() === text) { input.value = ''; shoutDrafts.delete(key); }
  else if (sent) shoutDrafts.delete(key);
});
`;
}
