/** Render the Settings pane; its only controls navigate scopes or refresh a GET, or copy a command. */
export function settingsMarkup() {
  return '<section data-pane="settings" class="settings-pane" id="settings-pane" aria-label="Settings" hidden><div id="settings-content" aria-live="polite"></div></section>';
}

/**
 * Render a read-only API inventory as grouped cards of one-height rows, preserving false, zero, null
 * and masked values as distinct data [O5,O6,N26]. Self-contained: the page embeds this function's source.
 */
export function settingsContentHtml(entry, scope = 'machine') {
  /** Escape API labels and values before placing them in text or attributes. */
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const commas = number => String(number).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  /** A value as a person reads it: units, on/off and no raw milliseconds. */
  const human = (value, unit) => {
    if (value === null || value === undefined) return 'none';
    if (typeof value === 'boolean') return value ? 'on' : 'off';
    if (Array.isArray(value)) return !value.length ? 'none' : value.every(part => typeof part === 'string') && value.join(', ').length <= 40 ? value.join(', ') : value.length + (value.length === 1 ? ' item' : ' items');
    if (typeof value === 'object') return JSON.stringify(value);
    if (typeof value !== 'number') return value === '' ? 'empty' : String(value);
    if (unit === 'ms') return value >= 60000 && value % 60000 === 0 ? commas(value / 60000) + ' min' : value >= 1000 && value % 1000 === 0 ? commas(value / 1000) + ' s' : commas(value) + ' ms';
    const suffix = { minutes: ' min', MB: ' MB', bytes: ' bytes', lines: ' lines', characters: ' chars', seconds: ' s', 'seat-hours': ' seat-hours' }[unit] || '';
    return (unit === 'port' ? String(value) : commas(value)) + suffix;
  };
  /** Show the exact value on hover when the human form shortens it. */
  const exact = value => value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
  const about = { Capacity: 'How much this computer runs at once.', Order: 'What runs first when work is waiting.', Runners: 'Other machines that run checks for this one.',
    Background: 'What keeps running on this computer.', Landing: 'How finished work reaches main.', Checks: 'How work is tested and held to its criterion.',
    Relay: 'Sharing boards with your phone and other devices.', Project: 'Where the project keeps its files and how it names things.',
    Review: 'Who may review work and how reviews are scheduled.', Claims: 'How long work stays claimed.', Commits: 'What a commit message must look like.',
    Protection: 'Files and secrets no change may touch.', Line: 'How the board offers work to builders and reviewers.' };
  const order = ['Capacity', 'Order', 'Runners', 'Background'];
  const labels = { machine: 'This machine', repo: 'This repo', board: 'This board' };
  const scopes = Object.entries(labels).map(([key, label]) => '<button type="button" role="tab" class="' + (key === scope ? 'on' : '') + '" data-settings-scope="' + key + '" aria-selected="' + (key === scope) + '">' + label + '</button>').join('');
  const rows = entry.error || entry.loading ? [] : (entry.rows || []).filter(row => row.scope === scope);
  const changed = row => !row.error && JSON.stringify(row.value) !== JSON.stringify(row.default);
  const home = path => String(path).replace(/^\/(?:Users|home)\/[^/]+/, '~').replace(/^[A-Za-z]:[\\/]+Users[\\/]+[^\\/]+/, '~').replaceAll('\\', '/');
  const sources = new Map();
  for (const row of rows) sources.set(row.source, (sources.get(row.source) || 0) + 1);
  const source = [...sources].sort((a, b) => b[1] - a[1])[0]?.[0];
  const rowHtml = row => {
    const copyable = typeof row.cli === 'string' && row.cli && (typeof row.value === 'boolean' || typeof row.value === 'number');
    const command = copyable ? 'pullboard settings ' + row.cli + ' ' + (typeof row.value === 'boolean' ? (row.value ? 'on' : 'off') : row.value) : '';
    const label = row.label || row.key;
    const value = row.secret ? (row.value === 'set' ? 'set' : 'not set') : human(row.value, row.unit);
    const was = row.secret ? 'not set' : human(row.default, row.unit);
    const mark = changed(row);
    const what = row.error ? '<p class="setting-error" role="alert" title="' + esc(row.error.message + ' ' + row.error.fix) + '">' + esc(row.error.message) + ' ' + esc(row.error.fix) + '</p>'
      : '<p class="setting-description" title="' + esc(row.description) + '">' + esc(row.description) + '</p>';
    return '<div class="set' + (row.error ? ' setting-invalid' : '') + '" data-setting-key="' + esc(row.key) + '"><div class="name"><b>' + esc(label) + '</b><code class="k">' + esc(row.key) + '</code>'
      + (entry.all && row.root ? '<span class="setting-root">' + esc(String(row.root).replaceAll('\\', '/').split('/').at(-1)) + '</span>' : '') + what + '</div>'
      + '<div class="val"><span class="val-line">' + (mark ? '<span class="changed">changed</span>' : '') + '<b title="' + esc(row.secret ? value : exact(row.value)) + '">' + esc(row.error ? '' : value) + '</b></span><small>' + (mark ? 'default ' + esc(was) : 'default') + '</small></div>'
      + (copyable ? '<button type="button" class="copy" data-copy-command="' + esc(command) + '" aria-label="Copy command to change ' + esc(label) + '" title="Copy: ' + esc(command) + '"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="5" width="8.5" height="8.5" rx="1.5"/><path d="M3 10.5V3.5A1 1 0 0 1 4 2.5h6.5"/></svg></button>' : '<span class="copy none"></span>') + '</div>';
  };
  const groups = new Map();
  for (const row of rows) {
    const name = row.group || 'Other', key = (entry.all && row.root ? row.root + '\n' : '') + name;
    if (!groups.has(key)) groups.set(key, { name, root: entry.all ? row.root : '', rows: [] });
    groups.get(key).rows.push(row);
  }
  const ranked = [...groups.values()].sort((a, b) => (order.indexOf(a.name) < 0 ? 99 : order.indexOf(a.name)) - (order.indexOf(b.name) < 0 ? 99 : order.indexOf(b.name)));
  const cards = ranked.map(group => '<section class="set-group"><div class="ghead"><h3>' + esc(group.name) + (group.root ? ' · ' + esc(String(group.root).replaceAll('\\', '/').split('/').at(-1)) : '') + '</h3><p>' + esc(about[group.name] || '') + '</p><span>' + group.rows.filter(changed).length + ' changed</span></div>' + group.rows.map(rowHtml).join('') + '</section>').join('');
  const boards = scope === 'board' ? '<button class="ghost" type="button" data-settings-open aria-pressed="' + Boolean(entry.all) + '">All local boards</button>' : '';
  return '<section class="settings-head"><h2>Settings</h2><p>How Pullboard runs on this computer. Change a setting with the copy button beside it; this page shows what is in effect.</p>'
    + '<div class="settings-bar"><div class="seg settings-scopes" role="tablist" aria-label="Settings scope">' + scopes + '</div>' + boards + '<button class="ghost settings-refresh" type="button" data-settings-refresh>Refresh</button></div>'
    + (source && !entry.loading && !entry.error ? '<p class="settings-where">From <code>' + esc(home(source)) + '</code> · ' + rows.filter(changed).length + ' changed from the default</p>' : '') + '</section>'
    + (entry.error ? '<p class="setting-error" role="alert">' + esc(entry.error) + '</p>' : '')
    + (entry.loading ? '<p role="status">Loading settings…</p>' : '<div class="set-groups">' + cards + '</div>' + (!rows.length && !entry.error ? '<p>No settings in this scope.</p>' : ''));
}
