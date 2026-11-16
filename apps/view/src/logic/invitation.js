/** Browser presentation for the shared-board invitation and sign-in progress [N26,H5]. */

/** Return source embedded in the cockpit's existing browser scope, keeping its state and authority unchanged.
 * @returns {string}
 */
export function sharingPresentation() {
  return `/** Who is signed in, from one local read; the account control at the top right shows it, and no banner appears in the page. */
let account = { linked: Boolean(hosted.relaySession), login: '' };
/** Draw the control, and the menu when it is open, from what the last read said. */
function drawAccount() {
  const slot = $('account-slot'), menu = $('account-menu');
  if (!slot || !menu) return;
  const open = !menu.hidden;
  const button = slot.querySelector('[data-account]');
  const fresh = document.createElement('div');
  fresh.innerHTML = accountHtml({ signedIn: account.linked, login: account.login });
  if (button) button.replaceWith(fresh.firstChild); else slot.prepend(fresh.firstChild);
  if (open) { $('account').setAttribute('aria-expanded', 'true'); menu.innerHTML = accountMenuHtml({ signedIn: account.linked, login: account.login, theme: keep('pb.theme') || 'system' }); }
}
/** Read once after a real local read whether any board is linked and as whom; quiet boards do not acquire another polling loop. */
async function sharingInvitation() {
  if (snapshot || (hosted.local ? !localSession : pageReadOnly || configuredTransportModule)) return;
  try {
    const reply = await sharingApi();
    account = { linked: Boolean(reply.linked), login: String(reply.login || '') };
  } catch { /* the control stays as it was */ }
  drawAccount();
}

/** Render names and reasons as text, without exposing machine paths or private sign-in material. */
function sharingProgress(status) {
  sharing.state = status.state;
  sharing.boards = status.boards || [];
  const linked = sharing.boards.filter(board => board.outcome === 'linked');
  if (linked.length) {
    account = { ...account, linked: true };
    drawAccount();
  }
  const lines = sharing.boards.map(board => board.outcome === 'linked' ? 'Linked ' + board.name + '.'
    : 'Did not link ' + board.name + ': ' + board.reason);
  if (status.error) lines.push(status.error.message);
  else if (['cancelled', 'declined', 'expired'].includes(status.state)) lines.push('No boards were linked. You can sign in again whenever you want.');
  else if (status.state === 'pairing') lines.push('Your boards are linked. Pair a device to open them there, or close this step; the links stay in place.');
  else if (status.state === 'pairing-stopped') lines.push('Phone pairing stopped. Your boards remain linked.');
  else if (status.state === 'linking') lines.push('Linking every registered board…');
  else if (status.state === 'done' && !linked.length && !lines.length) lines.push('No boards were linked.');
  if (lines.length) $('share-status').textContent = lines.join('\\n');
  $('share-pair').hidden = status.state !== 'pairing';
  $('share-close').textContent = linked.length ? 'Close' : 'Cancel sign-in';
  if (status.state !== 'waiting') { sharing.popup?.close(); sharing.popup = null; }
}

`;
}
