/** Render the Settings pane; its only controls navigate scopes or refresh a GET. */
export function settingsMarkup() {
  return '<section data-pane="settings" class="card-panel" id="settings-pane" aria-label="Settings" hidden><h2>Settings</h2><p>Read-only settings from this computer. Change settings through the supported commands.</p><button type="button" data-settings-open>All local boards</button><div id="settings-content" aria-live="polite"></div></section>';
}

/** Render a read-only API inventory, preserving false, zero, null and masked values as distinct data [O5,O6,N26]. */
export function settingsContentHtml(entry, scope = 'machine') {
  /** Escape API labels and values before placing them in text or attributes. */
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  /** Keep the API's value type visible instead of treating false or zero as absent. */
  const settingText = value => value === null ? 'null' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  const labels = { machine: 'This machine', repo: 'This repo', board: 'This board' };
  const scopes = Object.entries(labels).map(([key, label]) => '<button type="button" role="tab" data-settings-scope="' + key + '" aria-selected="' + (key === scope) + '">' + label + '</button>').join('');
  const rows = (entry.rows || []).filter(row => row.scope === scope);
  const cells = rows.map(row => '<tr data-setting-key="' + esc(row.key) + '"><th scope="row">' + esc(row.key) + (row.root ? '<br><small>' + esc(row.root) + '</small>' : '') + '</th><td>' + esc(row.secret ? (row.value === 'set' ? 'set' : 'not set') : settingText(row.value)) + '</td><td>' + esc(row.secret ? 'not set' : settingText(row.default)) + '</td><td>' + esc(row.source) + (row.origin ? ' (' + esc(row.origin) + ')' : '') + '</td></tr>').join('');
  return '<p>' + esc(entry.context || 'This computer') + '</p><div role="tablist" aria-label="Settings scope">' + scopes + '</div><button type="button" data-settings-refresh>Refresh settings</button>'
    + (entry.error ? '<p role="alert">' + esc(entry.error) + '</p>' : entry.loading ? '<p role="status">Loading settings…</p>' : '<div class="settings-table"><table><thead><tr><th>Setting</th><th>Value</th><th>Default</th><th>Source</th></tr></thead><tbody>' + cells + '</tbody></table></div>' + (!rows.length ? '<p>No settings in this scope.</p>' : ''));
}

