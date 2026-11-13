/**
 * The view's navigation: one page list, drawn as the top strip, and the address each place in it has [N26,N38].
 *
 * Why: the approved prototype (nav-switch, Corey 12 Nov) names the pages, their order and their groups once; the
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
    { group: 'Work', id: 'work', pages: [['progress', 'Progress', 'What is happening, in plain words'], ['items', 'Items', 'Every piece of work'], ['shouts', 'Shouts', 'Agents talking to the coordinator'], ['roadmap', 'Roadmap', 'What ships next, in order']] },
    { group: 'Rules', id: 'rules', pages: [['spec', 'Spec', 'What the product must do'], ['doctrine', 'Doctrine', 'How the work must be done']] },
    { group: 'Insights', id: 'insights', pages: [['dashboard', 'Dashboard', 'Every number on the board'], ['activity', 'Activity', 'What happened, in order'], ['cost', 'Cost', 'Time and tokens per item']] },
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
    + '<button class="notch-it" type="button" data-peek="agents" data-status="agents" title="Agents at work: open the agent floor"><b data-notch="agents">' + number(agents) + '</b> agents</button>'
    + '<span class="notch-sp" aria-hidden="true"></span>'
    + '<button class="notch-it" type="button" data-peek="perHour" data-status="dashboard" title="Items landed per hour, the last 6 hours: open the Dashboard"><b class="g" data-notch="perHour">' + pace + '</b></button>'
    + '<span class="notch-sp" aria-hidden="true"></span>'
    + '<button class="notch-it" type="button" data-peek="rulings" data-needs-list title="Calls only you can make: open them"><b class="' + (rulings ? 'a' : '') + '" data-notch="rulings">' + number(rulings) + '</b> rulings</button>'
    + '</span>'
    + shoulder('M50 0 C30 0 23 26 0 26 L0 0 Z');
}

/**
 * A place's filters and search as query pairs, leaving out each default so a plain tab keeps a plain address.
 * Items' Show and Lane, the search words, Spec and Doctrine's row filter, Shouts' filter and Activity's filter.
 *
 * @param {{ tab: string, state?: string, stateDefault?: string, lane?: string|null, q?: string, rows?: string|null, rowsDefault?: string|null, shouts?: string, activity?: string }} place
 * @returns {[string, string][]}
 */
export function placeQuery({ tab, state = 'active', stateDefault = 'active', lane = null, q = '', rows = null, rowsDefault = null, shouts = 'all', activity = 'all' }) {
  const pairs = [];
  const words = String(q ?? '').trim();
  if (tab === 'items' && state && state !== stateDefault && !(words && state === 'all')) pairs.push(['state', state]);
  if (tab === 'items' && lane) pairs.push(['lane', lane]);
  if (words) pairs.push(['q', words]);
  if ((tab === 'spec' || tab === 'doctrine') && rows && rows !== rowsDefault) pairs.push(['rows', rows]);
  if (tab === 'shouts' && shouts && shouts !== 'all') pairs.push(['shouts', shouts]);
  if (tab === 'activity' && activity && activity !== 'all') pairs.push(['activity', activity]);
  return pairs;
}

/**
 * Read a place's filters and search back from a query string; a key the address leaves out reads as null.
 *
 * @param {string} search - "?a=b" or "a=b".
 * @returns {{ state: string|null, lane: string|null, q: string|null, rows: string|null, shouts: string|null, activity: string|null }}
 */
export function readPlaceQuery(search) {
  const params = new URLSearchParams(String(search ?? '').replace(/^\?/u, ''));
  const value = (key) => { const read = params.get(key); return read === null || read === '' ? null : read; };
  return { state: value('state'), lane: value('lane'), q: value('q'), rows: value('rows'), shouts: value('shouts'), activity: value('activity') };
}

/**
 * Join a query string's other keys (the session's, say) with a place's pairs, in that order; the place keys are
 * state, lane, q, rows, shouts and activity.
 *
 * @param {string} search - The current "?…" whose place keys are replaced.
 * @param {[string, string][]} pairs
 * @returns {string} "" or "?…".
 */
export function withPlaceQuery(search, pairs) {
  const keys = ['state', 'lane', 'q', 'rows', 'shouts', 'activity'];
  const params = new URLSearchParams(String(search ?? '').replace(/^\?/u, ''));
  for (const key of keys) params.delete(key);
  for (const [key, value] of pairs) params.append(key, value);
  const text = params.toString();
  return text ? '?' + text : '';
}

/**
 * Progress in plain words until its own page lands: who is at work, the pace, and what waits for the person.
 *
 * @param {{ agents?: number|null, perHour?: number|null, landedDay?: number|null, rulings?: number, building?: number, review?: number }} numbers
 * @returns {string}
 */
export function progressHtml({ agents = null, perHour = null, landedDay = null, rulings = 0, building = 0, review = 0 } = {}) {
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
  const lines = [
    Number.isFinite(agents) ? '<b>' + plural(agents, 'agent is', 'agents are') + '</b> at work.' : '',
    building || review ? '<b>' + building + '</b> building and <b>' + review + '</b> in review.' : 'Nothing is building or in review.',
    Number.isFinite(perHour) ? 'Work lands at about <b class="g">' + Math.round(perHour) + ' an hour</b>' + (Number.isFinite(landedDay) ? ', <b>' + landedDay + '</b> in the last 24 hours.' : '.') : '',
    rulings ? '<b class="a">' + plural(rulings, 'ruling waits', 'rulings wait') + '</b> for you.' : 'Nothing waits for you.',
  ].filter(Boolean);
  return '<section class="card-panel progress-words"><h1>Progress</h1>' + lines.map(line => '<p>' + line + '</p>').join('') + '</section>';
}
