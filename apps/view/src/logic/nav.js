/**
 * The view's navigation: one page list, drawn as the top strip, and the address each place in it has [N26,N38].
 *
 * Why: the approved prototype (nav-switch, 12 Nov) names the pages, their order and their groups once; the
 * strip, the crumb and the address all read this list, so a page can't be in one and missing from another. The page
 * embeds these functions' source, so each one reads only its arguments.
 */

/**
 * The pages this view shows, in order; Cost only where the view keeps private cost.
 *
 * @param {{ cost?: boolean }} [options]
 * @returns {{ id: string, name: string, what: string, group: string, groupId: string }[]}
 */
export function navPages({ cost = false } = {}) {
  const groups = [
    { group: 'Work', id: 'work', pages: [['items', 'Items', 'Every piece of work'], ['shouts', 'Shouts', 'Agents talking to the coordinator'], ['roadmap', 'Roadmap', 'What ships next, in order']] },
    { group: 'Rules', id: 'rules', pages: [['spec', 'Spec', 'What the product must do'], ['doctrine', 'Doctrine', 'How the work must be done']] },
    { group: 'Insights', id: 'insights', pages: [['dashboard', 'Dashboard', 'Every number on the board'], ['activity', 'Activity', 'What happened, in order'], ['cost', 'Cost', 'Time and tokens per item'], ['pipeline', 'Pipeline', 'Why work isn\'t moving']] },
  ];
  return groups.flatMap(entry => entry.pages.filter(([id]) => cost || id !== 'cost')
    .map(([id, name, what]) => ({ id, name, what, group: entry.group, groupId: entry.id })));
}

/**
 * The strip's markup: Work's pages as plain-text tabs, a rule, then one menu button per other group. Every page
 * is a `.tab[data-tab]` button, so one click handler and one active mark serve them all; a group's button names
 * its open page ("Rules · Spec") and carries the active mark while one of its pages is shown. Facts sit only in
 * the menus, beside each page's one line.
 *
 * @param {{ tab?: string|null, cost?: boolean, open?: string|null, facts?: Record<string, string|number|null> }} [state]
 * @returns {string}
 */
export function navStripHtml({ tab = null, cost = false, open = null, facts = {} } = {}) {
  const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const pages = navPages({ cost });
  const fact = (id) => facts[id] === null || facts[id] === undefined || facts[id] === '' ? '' : String(facts[id]);
  const work = pages.filter(page => page.groupId === 'work').map(page => '<button class="tab' + (page.id === tab ? ' on' : '') + '" data-tab="' + page.id + '" type="button"' + (page.id === tab ? ' aria-current="page"' : '') + '>' + page.name + '</button>').join('');
  const groups = ['rules', 'insights'].map(groupId => {
    const members = pages.filter(page => page.groupId === groupId);
    const name = members[0].group, current = members.find(page => page.id === tab);
    const shown = open === groupId;
    const menu = '<div class="tab-menu" id="nav-menu-' + groupId + '" data-nav-menu="' + groupId + '" role="menu" aria-label="' + name + '"' + (shown ? '' : ' hidden') + '>'
      + members.map(page => '<button class="tab' + (page.id === tab ? ' on' : '') + '" data-tab="' + page.id + '" role="menuitem" type="button"' + (page.id === tab ? ' aria-current="page"' : '') + '><span class="tab-name"><b>' + page.name + '</b><small>' + esc(page.what) + '</small></span><span class="f" data-nav-fact="' + page.id + '">' + esc(fact(page.id)) + '</span></button>').join('')
      + '</div>';
    return '<span class="tab-group"><button class="tab-group-btn' + (current ? ' on' : '') + '" data-nav-group="' + groupId + '" type="button" aria-haspopup="menu" aria-expanded="' + shown + '" aria-controls="nav-menu-' + groupId + '"><span class="group-label">' + name + (current ? ' · ' + current.name : '') + '</span><span class="chev" aria-hidden="true">▾</span></button>' + menu + '</span>';
  }).join('');
  return work + '<span class="tab-sep" aria-hidden="true"></span>' + groups;
}

/**
 * Which layout the navigation takes: the sidebar only when this device chose it with the pin and the screen is wide
 * enough; a phone, and anything the device never chose, gets the top tabs [N26].
 *
 * @param {{ stored?: string|null, wide?: boolean }} [state]
 * @returns {'top'|'side'}
 */
export function navLayout({ stored = null, wide = true } = {}) {
  return stored === 'side' && wide ? 'side' : 'top';
}

/**
 * The sidebar layout's page list: the same pages as the strip, under quiet group labels, each a 28 px row with its
 * one fact at the right (amber when it needs the person, muted otherwise). Every row is a `[data-tab]` button, so the
 * strip's click handler and active mark serve it too; the board fills each `[data-nav-fact]` in place.
 *
 * @param {{ tab?: string|null, cost?: boolean, facts?: Record<string, string|number|null>, amber?: string[] }} [state]
 * @returns {string}
 */
export function navSideHtml({ tab = null, cost = false, facts = {}, amber = [] } = {}) {
  const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const pages = navPages({ cost });
  const fact = (id) => facts[id] === null || facts[id] === undefined || facts[id] === '' ? '' : String(facts[id]);
  return ['work', 'rules', 'insights'].map(groupId => {
    const members = pages.filter(page => page.groupId === groupId);
    return '<div class="side-h">' + members[0].group + '</div>' + members.map(page => '<button class="side-row' + (page.id === tab ? ' on' : '') + '" data-tab="' + page.id + '" type="button"' + (page.id === tab ? ' aria-current="page"' : '') + '><span class="side-name">' + page.name + '</span><span class="f' + (amber.includes(page.id) ? ' a' : '') + '" data-nav-fact="' + page.id + '">' + esc(fact(page.id)) + '</span></button>').join('');
  }).join('');
}

/**
 * The notch's three numbers, in the rules' order (activity, pace, attention): agents at work, landed per hour and
 * rulings. One number and at most two words each; colour carries meaning (green pace, amber rulings). Each item
 * carries data-peek, the hook a hover preview attaches to, and opens its page on click.
 *
 * @param {{ agents?: number|null, perHour?: number|null, rulings?: number|null }} numbers
 * @returns {string}
 */
export function notchHtml({ agents = null, perHour = null, rulings = null } = {}) {
  const number = (value) => Number.isFinite(value) ? String(Math.max(0, Math.round(value))) : '—';
  const pace = Number.isFinite(perHour) ? number(perHour) + '/h' : '—/h';
  const shoulder = (path) => '<svg class="sh" viewBox="0 0 50 26" preserveAspectRatio="none" aria-hidden="true"><path d="' + path + '"/></svg>';
  return shoulder('M0 0 C20 0 27 26 50 26 L50 0 Z')
    + '<span class="notch-body">'
    + '<button class="notch-it" type="button" data-peek="agents" data-status="agents" title="Agents at work: open the Agents table"><b data-notch="agents">' + number(agents) + '</b> agents</button>'
    + '<span class="notch-sp" aria-hidden="true"></span>'
    + '<button class="notch-it" type="button" data-peek="perHour" data-status="dashboard" title="Items landed per hour, the last 6 hours: open the Dashboard"><b class="g" data-notch="perHour">' + pace + '</b></button>'
    + '<span class="notch-sp" aria-hidden="true"></span>'
    + '<button class="notch-it" type="button" data-peek="rulings" data-needs-list title="Calls only you can make: open them"><b class="' + (rulings ? 'a' : '') + '" data-notch="rulings">' + number(rulings) + '</b> rulings</button>'
    + '</span>'
    + shoulder('M50 0 C30 0 23 26 0 26 L0 0 Z');
}

/**
 * A place's filters and search as query pairs, leaving out each default so a plain tab keeps a plain address.
 * Items' Show and Lane, the search words, Spec and Doctrine's row filter, Shouts' filter, Activity's filter and person,
 * whether the Roadmap shows what shipped, Pipeline's window, and the items a Pipeline count opened Items on: each control
 * in a page's strip has its key here [N38].
 *
 * @param {{ tab: string, state?: string, stateDefault?: string, lane?: string|null, q?: string, rows?: string|null, rowsDefault?: string|null, shouts?: string, activity?: string, shipped?: boolean, by?: string|null, win?: number, window?: string, ids?: number[]|null }} place
 * @returns {[string, string][]}
 */
export function placeQuery({ tab, state = 'active', stateDefault = 'active', lane = null, q = '', rows = null, rowsDefault = null, shouts = 'all', activity = 'all', shipped = false, by = null, win = 24, window = '1h', ids = null, release = null, page = 1, per = 25 }) {
  const pairs = [];
  const words = String(q ?? '').trim();
  if (tab === 'items' && state && state !== stateDefault && !(words && state === 'all')) pairs.push(['state', state]);
  if (tab === 'items' && lane) pairs.push(['lane', lane]);
  if (words) pairs.push(['q', words]);
  if ((tab === 'spec' || tab === 'doctrine') && rows && rows !== rowsDefault) pairs.push(['rows', rows]);
  if (tab === 'shouts' && shouts && shouts !== 'all') pairs.push(['shouts', shouts]);
  if (tab === 'activity' && activity && activity !== 'all') pairs.push(['activity', activity]);
  if (tab === 'activity' && by) pairs.push(['by', by]);
  if (tab === 'activity' && win && Number(win) !== 24) pairs.push(['win', String(win)]);
  if (tab === 'roadmap' && shipped) pairs.push(['shipped', '1']);
  if (tab === 'roadmap' && release) { pairs.push(['release', release]); if (page > 1) pairs.push(['page', String(page)]); if (per !== 25) pairs.push(['per', String(per)]); }
  if (tab === 'pipeline' && window && window !== '1h') pairs.push(['w', window]);
  if (tab === 'items' && state === 'ids' && Array.isArray(ids) && ids.length) pairs.push(['ids', ids.join(',')]);
  return pairs;
}

/**
 * Read a place's filters and search back from a query string; a key the address leaves out reads as null.
 *
 * @param {string} search - "?a=b" or "a=b".
 * @returns {{ state: string|null, lane: string|null, q: string|null, rows: string|null, shouts: string|null, activity: string|null, shipped: string|null, by: string|null, win: string|null, window: string|null, ids: string|null }}
 */
export function readPlaceQuery(search) {
  const params = new URLSearchParams(String(search ?? '').replace(/^\?/u, ''));
  const value = (key) => { const read = params.get(key); return read === null || read === '' ? null : read; };
  return { state: value('state'), lane: value('lane'), q: value('q'), rows: value('rows'), shouts: value('shouts'), activity: value('activity'), shipped: value('shipped'), by: value('by'), win: value('win'), window: value('w'), ids: value('ids') };
}

/**
 * The open release and the page of its landed items, read from a query string: the release a person paged to and
 * its page number from 1 (a missing or bad page reads 1).
 *
 * @param {string} search - "?a=b" or "a=b".
 * Its per-page choice is 25, 50 or 100; anything else reads 25.
 *
 * @returns {{ release: string|null, page: number, per: number }}
 */
export function readRoadmapPlace(search) {
  const params = new URLSearchParams(String(search ?? '').replace(/^\?/u, ''));
  const page = Number.parseInt(params.get('page') ?? '', 10);
  return { release: params.get('release') || null, page: Number.isSafeInteger(page) && page > 1 ? page : 1, per: [50, 100].includes(Number(params.get('per'))) ? Number(params.get('per')) : 25 };
}

/**
 * Join a query string's other keys (the session's, say) with a place's pairs, in that order; the place keys are
 * state, lane, q, rows, shouts, activity, shipped, by, win, w and ids.
 *
 * @param {string} search - The current "?…" whose place keys are replaced.
 * @param {[string, string][]} pairs
 * @returns {string} "" or "?…".
 */
export function withPlaceQuery(search, pairs) {
  const keys = ['state', 'lane', 'q', 'rows', 'shouts', 'activity', 'shipped', 'by', 'win', 'w', 'ids', 'release', 'page', 'per'];
  const params = new URLSearchParams(String(search ?? '').replace(/^\?/u, ''));
  for (const key of keys) params.delete(key);
  for (const [key, value] of pairs) params.append(key, value);
  const text = params.toString();
  return text ? '?' + text : '';
}

/**
 * The controls a page puts at the right of the navigation strip (the sidebar layout puts them on the title row):
 * Items shows Open, Building, In review, All, a lane, List or Pipeline and New item; Shouts For you, Questions and All; Roadmap Show
 * shipped; Activity a person filter; Cost its Today, 7 days and 30 days window; Pipeline its 15m, 30m, 1h and 3h window. A page with nothing to control gets nothing. Each control carries data-page-ctl,
 * the hook the page's one handler reads, and the state each one shows is the state the address holds.
 *
 * @param {{ tab?: string|null, state?: string, shouts?: string, questions?: number, shoutCounts?: { you: number, all: number }|null, shipped?: boolean, by?: string|null, people?: string[], activity?: string, counts?: Record<string, number>|null, win?: number, writable?: boolean, costWindow?: string }} [place]
 * @returns {string}
 */
export function pageControlsHtml({ tab = null, state = 'active', lane = null, lanes = [], itemsView = 'list', shouts = 'all', questions = undefined, shoutCounts = null, shipped = false, by = null, people = [], activity = 'all', counts = null, win = 24, writable = true, costWindow = '7d', window = '1h' } = {}) {
  const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const seg = (label, kind, current, options) => '<span class="ctl-seg" role="group" aria-label="' + label + '">' + options.map(([value, name, count]) => '<button type="button" data-page-ctl="' + kind + '" data-value="' + value + '"' +  (value === current ? ' class="on" aria-pressed="true"' : ' aria-pressed="false"') + (kind === 'shouts' ? ' data-shout-filter="' + value + '"' : '') + '>' + name + (count === undefined ? '' : '<b>' + count + '</b>') + '</button>').join('') + '</span>';
  const select = (label, kind, current, options) => '<select class="sel" data-page-ctl="' + kind + '" aria-label="' + label + '">' + options.map(([value, name]) => '<option value="' + esc(value) + '"' + (value === current ? ' selected' : '') + '>' + esc(name) + '</option>').join('') + '</select>';
  if (tab === 'items') return seg('Show', 'state', state, [['active', 'Open'], ['building', 'Building'], ['verify', 'In review'], ['all', 'All'], ...(state === 'ids' ? [['ids', 'From Pipeline']] : [])])
    + (lanes.length > 1 ? select('Lane', 'lane', lane || '', lanes.map(({ value, label, count }) => [value, (value ? label : 'All lanes') + (count === null || count === undefined || !value ? '' : ' · ' + count)])) : '')
    + seg('View', 'view', itemsView === 'pipeline' ? 'pipeline' : 'list', [['list', 'List'], ['pipeline', 'Pipeline']]) + (writable ? '<button class="new" id="new-item" type="button" data-page-ctl="new" aria-label="New item">New item</button>' : '');
  if (tab === 'shouts') return seg('Shouts', 'shouts', ['you', 'questions', 'all'].includes(shouts) ? shouts : '', [['you', 'For you', shoutCounts?.you], ['questions', 'Questions', questions], ['all', 'All', shoutCounts?.all]]);
  if (tab === 'roadmap') return '<button class="sel" type="button" data-page-ctl="shipped" aria-pressed="' + Boolean(shipped) + '">' + (shipped ? 'Hide shipped' : 'Show shipped') + '</button>';
  if (tab === 'cost') return seg('Window', 'costwindow', costWindow, [['today', 'Today'], ['7d', '7 days'], ['30d', '30 days']]);
  if (tab === 'pipeline') return '<span class="ctl-lbl">Window</span>' + seg('Window', 'window', ['15m', '30m', '3h'].includes(window) ? window : '1h', [['15m', '15m'], ['30m', '30m'], ['1h', '1h'], ['3h', '3h']]);
  if (tab === 'activity') {
    // The Activity strip (#6916): the event filters with their counts, then Person and the window in hours.
    const filters = [['all', 'All'], ['landed', 'Landed'], ['sentback', 'Sent back'], ['held', 'Held'], ['blocked', 'Blocked'], ['pending', 'Pending review'], ['ruling', 'Rulings'], ['shout', 'Shouts']];
    const counted = (value) => counts && Number.isFinite(counts[value]) ? '<em>' + counts[value] + '</em>' : '';
    return '<span class="ctl-seg act-filters" role="group" aria-label="Events">' + filters.map(([value, name]) => '<button type="button" data-page-ctl="activity" data-value="' + value + '"' + (value === activity ? ' class="on" aria-pressed="true"' : ' aria-pressed="false"') + '>' + name + counted(value) + '</button>').join('') + '</span>'
      + select('Person', 'by', by || '', [['', 'Everyone'], ...people.map((name) => [name, name === 'person' ? 'You' : name === 'coordinator' ? 'The coordinator' : name])])
      + select('Window', 'win', String(win), [['6', '6 h'], ['12', '12 h'], ['24', '24 h']]);
  }
  return '';
}

/**
 * The account control at the top right (approved 12 Nov): the person's initial when signed in, "Sign in" when not.
 * One control, no banner in the page. The page embeds this function's source, so it uses only its argument.
 *
 * @param {{ signedIn?: boolean, login?: string }} [account]
 * @returns {string}
 */
export function accountHtml({ signedIn = false, login = '' } = {}) {
  const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const initial = (String(login).match(/[A-Za-z0-9]/u) || ['·'])[0].toUpperCase();
  return signedIn
    ? '<button class="acct" id="account" type="button" data-account aria-haspopup="menu" aria-expanded="false" aria-controls="account-menu" title="Account">' + esc(initial) + '</button>'
    : '<button class="signin" id="account" type="button" data-account aria-haspopup="menu" aria-expanded="false" aria-controls="account-menu">Sign in</button>';
}

/**
 * The account menu: who you are, Settings, Theme and Pair a phone; signed out it offers Sign in with GitHub in
 * place of a name. There is no Sign out row yet: the view has no real sign-out, and relay off is destructive. The page embeds this function's source, so it uses only its argument.
 *
 * @param {{ signedIn?: boolean, login?: string, theme?: string }} [account] - theme is what the person kept: light, dark or system.
 * @returns {string}
 */
export function accountMenuHtml({ signedIn = false, login = '', theme = 'system' } = {}) {
  const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const row = (attribute, label, hint = '') => '<button type="button" role="menuitem" ' + attribute + '>' + label + (hint ? '<span>' + hint + '</span>' : '') + '</button>';
  const who = signedIn
    ? '<div class="who"><b>' + (login ? '@' + esc(login) : 'Signed in') + '</b><small>GitHub</small></div>'
    : row('data-account-signin', 'Sign in with GitHub');
  return who + row('data-tab="settings"', 'Settings') + row('data-theme-flip', 'Theme', '<i data-theme-label>' + (theme === 'light' ? 'Light' : theme === 'dark' ? 'Dark' : 'System') + '</i>')
    + row('data-account-pair', 'Pair a phone');
}
