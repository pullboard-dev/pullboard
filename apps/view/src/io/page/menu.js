/** The menu drawer's page script: Menu opens it under 900 px, the veil, Esc or a pick closes it [N26,#6725]. */

/**
 * The script text that wires the Menu button and its drawer. It runs inside the page's own script, so it reads the page's
 * `$` and `fold` directly, and fetches nothing. Its click listener runs first (capture), so a pick closes the drawer on the
 * tap and paints shut before the page it opens follows on the next turn.
 *
 * @returns {string} Script text to place after the page's other parts.
 */
export function menuScript() {
  return `const setMenu = (open) => {
  if ($('mveil')) $('mveil').hidden = !open;
  if ($('mdrawer')) $('mdrawer').hidden = !open;
  $('menu-btn')?.setAttribute('aria-expanded', String(open));
};
document.addEventListener('click', (event) => {
  if (event.target.closest('#menu-btn')) { event.stopPropagation(); setMenu($('mdrawer').hidden); return; }
  if (event.target.closest('#mveil')) { event.stopPropagation(); setMenu(false); return; }
  if (event.target.closest('#mdrawer-proj')) { event.stopPropagation(); setMenu(false); fold(true); return; }
  const picked = event.target.closest('#mdrawer [data-tab], #mdrawer [data-needs-list]');
  if (picked && !picked.dataset.later) {
    event.stopPropagation(); setMenu(false); picked.dataset.later = '1';
    requestAnimationFrame(() => setTimeout(() => { picked.click(); delete picked.dataset.later; }, 0));
  }
}, true);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && $('mdrawer') && !$('mdrawer').hidden) { setMenu(false); $('menu-btn').focus({ preventScroll: true }); }
});
`;
}
