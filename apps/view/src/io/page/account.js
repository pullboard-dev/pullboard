/** The account menu's page script: it opens on its control, flips Theme in place, closes on any other press; "," opens Settings [N26,#6648]. */

/**
 * The script text that wires the top-right account menu. It runs inside the page's own script, so it reads the page's
 * `account`, `keep`, `flipTheme`, `openTab` and `render` directly, and fetches nothing.
 *
 * @returns {string} Script text to place after the page's other parts.
 */
export function accountScript() {
  return `const closeAccount = () => { $('account-menu').hidden = true; $('account')?.setAttribute('aria-expanded', 'false'); };
// The account menu opens on its control, flips Theme in place, and closes on any other press; "," opens Settings from anywhere but a field.
document.addEventListener('click', (event) => {
  const menu = $('account-menu'), row = event.target.closest('#account-menu [role="menuitem"]');
  if (event.target.closest('[data-account]')) { if (!menu.hidden) return closeAccount(); menu.innerHTML = accountMenuHtml({ signedIn: account.linked, login: account.login, theme: keep('pb.theme') || 'system' }); menu.hidden = false; $('account').setAttribute('aria-expanded', 'true'); return; }
  if (row?.hasAttribute('data-theme-flip')) return flipTheme();
  closeAccount();
  if (row?.matches('[data-account-signin], [data-account-pair]')) $('share-start')?.click();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('account-menu').hidden) { closeAccount(); $('account')?.focus({ preventScroll: true }); return; }
  if (event.key !== ',' || event.metaKey || event.ctrlKey || event.altKey || event.target.closest('input, textarea, select, [contenteditable]')) return;
  event.preventDefault(); openTab('settings'); render();
});
`;
}
