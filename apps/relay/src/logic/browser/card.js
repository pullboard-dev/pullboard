/** The words on a paired phone's approval card: which computer asks, which board, and until when [H17,H5]. */

/** The transport owns these live nodes even while the View replaces its current board children. */
const APPROVAL_PANELS = new WeakMap();

/** Keep one sealed display name only when it is a short single line; otherwise the card falls back. */
function displayName(value) {
  return typeof value === 'string' && value.trim() && value.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(value) ? value.trim() : null;
}

/**
 * Read the computer and board names a native request sealed with its intent.
 * Why fall back: a request queued by an older pullboard carries no names, and the card must still read as words.
 */
export function approvalNames(intent, context) {
  const names = intent?.names ?? {};
  const repository = context.action === 'link' ? context.target.split('/').pop() : null;
  return { computer: displayName(names.computer) ?? 'your computer', board: displayName(names.board) ?? repository ?? 'this board' };
}

/** Show an expiry as a time in this phone's own time zone. */
export function localExpiry(expires) {
  return new Date(expires).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** Write the card's question and its one line of detail, naming the computer and the board. */
export function approvalCardText(context, names) {
  const expires = 'expires ' + localExpiry(context.expires);
  if (context.action === 'link') return { title: 'Link ' + names.board + ' from ' + names.computer + '?', detail: context.target + ' · ' + expires };
  if (context.action === 'delete-board') return { title: 'Delete ' + names.board + ' from the relay?', detail: 'Asked from ' + names.computer + ' · ' + expires };
  return { title: context.command, detail: 'Asked from ' + names.computer + ' · ' + expires };
}

/** Confirm a finished delete in words once the relay reports the board gone. */
export function deletedText(names) {
  return names.board + ' was deleted from the relay.';
}

/** Card spacing for the relay page; served after the shared view styles. */
export const APPROVAL_CARD_STYLES = `
#phone-approvals:empty { display: none; }
.relay-panel #phone-approvals { margin-top: 20px; text-align: left; }
.phone-approval-status { margin: 0; padding: 14px 16px; color: var(--ink-muted); }
.phone-approval { display: grid; gap: 10px; padding: 14px 16px; }
.phone-approval p { margin: 0; overflow-wrap: anywhere; }
.phone-approval-title { font-weight: 600; }
.phone-approval-detail { color: var(--ink-muted); }
.phone-approval button { justify-self: start; }
`;

/** Show the requests feed's own progress without making it a prerequisite for reading a board. */
export function phoneApprovalStatus(doc, message) {
  let panel = doc.getElementById('phone-approvals') ?? APPROVAL_PANELS.get(doc);
  if (!panel && message) {
    const main = doc.querySelector('main');
    if (!main) return null;
    panel = doc.createElement('section');
    panel.id = 'phone-approvals'; panel.className = 'card-panel';
    panel.setAttribute('aria-label', 'Requests from your computer');
    main.prepend(panel);
  }
  if (!panel) return null;
  APPROVAL_PANELS.set(doc, panel);
  placePhoneApprovals(doc);
  let status = panel.querySelector('.phone-approval-status');
  if (!message) { status?.remove(); return panel; }
  if (!status) {
    status = doc.createElement('p'); status.className = 'phone-approval-status';
    status.setAttribute('role', 'status'); panel.prepend(status);
  }
  status.textContent = message;
  return panel;
}

/** Keep the same authenticated cards and live handlers on the phone's visible screen until a board can draw. */
export function placePhoneApprovals(doc) {
  const panel = doc.getElementById('phone-approvals') ?? APPROVAL_PANELS.get(doc);
  if (!panel) return null;
  const root = doc.documentElement;
  const frame = root?.dataset.relayDevice === 'phone' && root.dataset.relayScreen === 'share'
    ? doc.querySelector('#relay-screen .relay-panel[data-screen="share"]') : null;
  const host = frame ?? doc.querySelector('main');
  if (!host || panel.parentElement === host) return panel;
  const mark = frame?.querySelector('.relay-mark');
  if (mark) mark.after(panel);
  else host.prepend(panel);
  return panel;
}

/** Release retained cards, handlers and progress when this document loses access or leaves the page. */
export function forgetPhoneApprovals(doc) {
  const panel = APPROVAL_PANELS.get(doc) ?? doc.getElementById('phone-approvals');
  APPROVAL_PANELS.delete(doc);
  panel?.replaceChildren();
  panel?.remove();
}
