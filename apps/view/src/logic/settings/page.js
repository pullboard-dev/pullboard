/** Read-only Settings page markup and embedded API-only browser behavior [O5,O6,N26]. */

import { settingsContentHtml } from "./render.js";
export { settingsMarkup } from "./render.js";

/** Embed the scoped settings reader beside the existing page API and escaped-text renderer. */
function settingsReaderScript() {
  return `
const settingsPages = new Map();
let settingsScope = 'machine';
let settingsAllBoards = false;
const settingsContentHtml = (${settingsContentHtml.toString()});
/** Draw the pure presentation into the one live region. */
function drawSettings(entry) { $('settings-content').innerHTML = settingsContentHtml({ ...entry, all: settingsAllBoards }, settingsScope); }
/** Read only the selected local board; neither relay nor snapshot implies machine access. */
async function showSettings(force = false) {
  if (view.tab !== 'settings' || !data) return;
  const root = view.root;
  const allBoards = settingsAllBoards;
  const board = !settingsAllBoards && data.projects.find(entry => entry.root === root && entry.ok);
  const source = board && boardSources.get(board.id);
  const hasLocal = hosted.local ? Boolean(localSession && localConfirmed) : transportModule === null;
  if (snapshot || !hasLocal || (board && source?.kind !== 'local')) {
    drawSettings({ error: 'Settings are available from this computer’s local view. Relay views and snapshots do not include machine settings.' });
    return;
  }
  const key = localReadBase + ':' + (board?.id || 'machine');
  let entry = settingsPages.get(key);
  if (entry && !force) { drawSettings(entry); return; }
  entry = { loading: true, context: board ? 'Settings for ' + board.root : 'This computer and all authorized local repos and boards' };
  settingsPages.set(key, entry);
  drawSettings(entry);
  try {
    const reply = await jsonRequest('/api/v1/settings' + (board ? '?board=' + encodeURIComponent(board.id) : ''), undefined, localReadBase, localReadHeaders);
    if (!Array.isArray(reply.settings)) throw new Error('The settings API returned no inventory.');
    entry.rows = reply.settings;
  } catch (error) { entry.error = String(error.message || error); }
  entry.loading = false;
  if (view.root === root && settingsAllBoards === allBoards && view.tab === 'settings' && settingsPages.get(key) === entry) drawSettings(entry);
}
`;
}

/** Embed navigation-only controls after the API reader, without adding a write path. */
export function settingsPageScript() {
  return settingsReaderScript() + `
/** Settings controls only change the selected scope or issue another read. */
document.addEventListener('click', event => {
  // The page element itself carries data-tab (the current tab), so only a control inside it counts.
  if (event.target.closest('[data-tab]:not(html)') || event.target.closest('[data-root]')) settingsAllBoards = false;
  const open = event.target.closest('[data-settings-open]');
  if (open) {
    // The scope's own All local boards button toggles; the boardless sidebar entry only opens.
    settingsAllBoards = open.closest('#settings-content') ? !settingsAllBoards : true;
    openTab('settings');
    render();
  }
  const copy = event.target.closest('[data-copy-command]');
  if (copy) {
    try { navigator.clipboard.writeText(copy.dataset.copyCommand).then(() => { copy.dataset.copied = 'yes'; setTimeout(() => delete copy.dataset.copied, 1500); }, () => {}); } catch {}
  }
  const scope = event.target.closest('[data-settings-scope]');
  if (scope && ['machine', 'repo', 'board'].includes(scope.dataset.settingsScope)) {
    settingsScope = scope.dataset.settingsScope;
    void showSettings();
  }
  if (event.target.closest('[data-settings-refresh]')) void showSettings(true);
});
`;
}
