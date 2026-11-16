/** The project menu: tells boards apart by owner, name, kind and one fact each, and ends with All projects and Add a project (#6650). */

/**
 * One menu row per readable board, as the board listing gives it: its owner, name and kind, and one fact. A board
 * with calls waiting for the person shows their count to be answered; every other board is quiet.
 *
 * @param {Array<Record<string, any>>} projects - The page's listed boards.
 * @param {string} root - The board shown now.
 * @param {(board: Record<string, any>) => number} needs - How many calls wait for the person on a board.
 * @returns {Array<{root: string, owner: string, name: string, kind: string, kindLabel: string, fact: string, amber: boolean, current: boolean}>}
 */
export function projectMenuRows(projects, root, needs) {
  // Inside the function, so the page script that carries its text carries these words with it.
  const KINDS = { team: 'Team board', private: 'Your private board', local: 'Local board' };
  return projects.filter((board) => board.ok).map((board) => {
    const named = String(board.kind ?? '').toLowerCase();
    const kind = named.startsWith('team') ? 'team' : named.startsWith('private') || named.startsWith('your') ? 'private'
      : named.startsWith('local') ? 'local' : board.source === 'relay' ? 'team' : 'local';
    const waiting = board.loading ? 0 : needs(board);
    return {
      root: board.root, owner: String(board.owner || board.handle || ''), name: String(board.name || ''), kind, kindLabel: KINDS[kind],
      fact: board.loading ? '' : waiting ? String(waiting) : 'quiet', amber: waiting > 0, current: board.root === root,
    };
  });
}

/**
 * The menu's markup. Each board is a button carrying its root, so choosing it takes the page's own switch and its
 * address change; the footer's two buttons are for the page to answer.
 *
 * @param {ReturnType<typeof projectMenuRows>} rows - What projectMenuRows returned.
 * @param {(text: unknown) => string} esc - The page's HTML escaper.
 * @param {boolean} [adding] - Whether Add a project shows its instruction.
 * @returns {string}
 */
export function projectMenuHtml(rows, esc, adding = false) {
  const list = rows.map((row) => '<button class="row' + (row.current ? ' cur' : '') + '" type="button" role="menuitem" data-root="' + esc(row.root) + '"'
    + (row.current ? ' aria-current="true"' : '') + '><span class="dot" aria-hidden="true"></span><b>' + (row.owner ? '<span>' + esc(row.owner) + ' / </span>' : '') + esc(row.name)
    + '</b><em' + (row.amber ? ' class="a"' : '') + '>' + esc(row.fact) + '</em><small>' + esc(row.kindLabel) + '</small></button>').join('');
  const add = adding ? '<p class="add-note">In the project folder, run <code>pullboard init</code>.</p>' : '';
  return '<div class="projpop" id="proj-menu" role="menu" aria-label="Projects">' + list
    + '<div class="foot"><button type="button" role="menuitem" data-proj-all>All projects</button><button type="button" role="menuitem" data-proj-add>Add a project…</button></div>' + add + '</div>';
}

/** Return the page's project menu section: the two pure parts above, and the open, close and toggle the switcher hooks into. */
export function cockpitProjectMenu() {
  return `const projectMenuRows = ${projectMenuRows.toString()};
const projectMenuHtml = ${projectMenuHtml.toString()};
const projectMenu = { adding: false, node: null };
/** Take the menu away. */
function projectMenuClose() {
  projectMenu.node?.remove();
  projectMenu.node = null;
  projectMenu.adding = false;
  $('proj-switch').setAttribute('aria-expanded', 'false');
}
/** Draw the menu under the switcher, from what the page already holds. */
function projectMenuDraw() {
  const switcher = $('proj-switch');
  projectMenu.node?.remove();
  const rows = projectMenuRows(data?.projects ?? [], view.root, needCount);
  document.body.insertAdjacentHTML('beforeend', projectMenuHtml(rows, esc, projectMenu.adding));
  const box = switcher.getBoundingClientRect();
  const menu = projectMenu.node = document.getElementById('proj-menu');
  menu.dataset.geo = 'project-menu';
  geometry('project-menu', { top: Math.round(box.bottom + 4) + 'px', left: Math.round(box.left) + 'px' });
  switcher.setAttribute('aria-expanded', 'true');
}
/** The switcher's hook: open or close the menu, in the top and the sidebar layout alike; it always answers the press. */
function projectMenuToggle() {
  if (projectMenu.node) projectMenuClose(); else projectMenuDraw();
  return true;
}
document.addEventListener('click', (event) => {
  if (!projectMenu.node) return;
  if (event.target.closest('[data-proj-add]')) { projectMenu.adding = !projectMenu.adding; projectMenuDraw(); return; }
  if (event.target.closest('[data-proj-all]')) { projectMenuClose(); fold(true); return; }
  if (event.target.closest('#proj-switch')) return;
  if (event.target.closest('#proj-menu') && !event.target.closest('[data-root]')) return;
  projectMenuClose();
});
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && projectMenu.node) { projectMenuClose(); $('proj-switch').focus(); } });
`;
}
