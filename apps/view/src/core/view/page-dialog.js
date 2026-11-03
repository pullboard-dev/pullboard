/**
 * A page dialog shows over an inert page: nothing behind it takes a click or focus while it is open. The page
 * also does not redraw while one is open (#668): a redraw can shorten the page and clamp its scroll under the
 * dialog, which moves the control the person is aiming at. The functions are copied into the page as text, so
 * they stay self-contained and take their state as arguments.
 */

/**
 * Show a page dialog and mark it open, so the page holds its redraws until it closes.
 *
 * @param {HTMLElement} dialog the dialog to show
 * @param {HTMLElement} focus the control that takes focus first
 * @param {Set<HTMLElement>} open the page's open dialogs
 */
export function openPageDialog(dialog, focus, open) {
  dialog.hidden = false;
  open.add(dialog);
  for (const element of document.body.children || []) if (element !== dialog && element.tagName !== 'SCRIPT') element.inert = true;
  focus.focus();
}

/**
 * Hide a page dialog, give the page back its clicks and focus, and report whether any dialog is still open.
 * The caller draws the held page only when none is, so a closing dialog never draws over another one.
 *
 * @param {HTMLElement} dialog the dialog to hide
 * @param {Set<HTMLElement>} open the page's open dialogs
 * @returns {boolean} true when no page dialog is open any more
 */
export function closePageDialog(dialog, open) {
  dialog.hidden = true;
  open.delete(dialog);
  for (const element of document.body.children || []) element.inert = false;
  return open.size === 0;
}
