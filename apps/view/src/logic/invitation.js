/** Browser presentation for the shared-board invitation and sign-in progress [N26,H5]. */

/** Return source embedded in the cockpit's existing browser scope, keeping its state and authority unchanged.
 * @returns {string}
 */
export function sharingPresentation() {
  return `/** Show the opt-in once after a real local read; quiet boards do not acquire another polling loop. */
async function sharingInvitation() {
  if (!$('share-note') || snapshot || (hosted.local ? !localSession : pageReadOnly || configuredTransportModule)) return;
  let available = false;
  try { available = Boolean((await sharingApi()).available); } catch { available = false; }
  const hiddenByPerson = keep('pb.share') === 'hidden';
  $('share-note').hidden = !available || hiddenByPerson;
  if ($('share-again')) $('share-again').hidden = !available || !hiddenByPerson;
}
$('share-hide')?.addEventListener('click', () => { keep('pb.share', 'hidden'); $('share-note').hidden = true; if ($('share-again')) $('share-again').hidden = false; });
$('share-again')?.addEventListener('click', () => { keep('pb.share', 'shown'); $('share-again').hidden = true; $('share-note').hidden = false; });

/** Render names and reasons as text, without exposing machine paths or private sign-in material. */
function sharingProgress(status) {
  sharing.state = status.state;
  sharing.boards = status.boards || [];
  const linked = sharing.boards.filter(board => board.outcome === 'linked');
  if (linked.length) {
    $('share-note').hidden = true;
    if ($('share-again')) $('share-again').hidden = true;
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
