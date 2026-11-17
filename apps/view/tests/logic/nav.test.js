/** The view's navigation matches the approved nav-switch prototype: one page list as top tabs, and an address per place [N26,N38]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cockpitMarkup } from '../../index.js';
import { composeViewStyles } from '../../src/io/styles.js';
import { accountHtml } from '../../src/logic/nav.js';
import { accountMenuHtml } from '../../src/logic/nav.js';
import { navPages } from '../../src/logic/nav.js';
import { navStripHtml } from '../../src/logic/nav.js';
import { notchHtml } from '../../src/logic/nav.js';
import { navLayout } from '../../src/logic/nav.js';
import { navSideHtml } from '../../src/logic/nav.js';
import { pageControlsHtml } from '../../src/logic/nav.js';
import { sharedRowHtml } from '../../src/logic/component.js';
import { pageRenderScript } from '../../src/io/page/render.js';
import { pageScriptPart2 } from '../../index.js';
import { pageScriptPart4 } from '../../index.js';
import { menuScript } from '../../src/io/page/menu.js';
import { runInNewContext } from 'node:vm';
import { placeQuery } from '../../src/logic/nav.js';
import { readPlaceQuery } from '../../src/logic/nav.js';
import { withPlaceQuery } from '../../src/logic/nav.js';

/** The served shell, with the sections it embeds stubbed to empty markup. */
const shell = (privateCost) => cockpitMarkup({ repositoryAttribute: 'https://example.test/repo', cssAttribute: '/view.css', hostedLocal: false, snapshot: false, readOnly: false,
  requestMode: false, privateCost, hostedMarkup: () => '', signIn: null, settingsMarkup: () => '', starMarkup: () => '' });
/** The data-tab pages in markup order, and the label of every strip control in order. */
const tabsIn = (html) => [...html.matchAll(/class="tab[^"]*" data-tab="([a-z]+)"/gu)].map(match => match[1]);
const stripLabels = (html) => [...html.matchAll(/<button class="(tab|tab-group-btn)[^"]*" data-(?:tab|nav-group)="[a-z]+"[^>]*>(?:<span class="group-label">)?([^<]+)/gu)].filter(match => !/role="menuitem"/u.test(match[0])).map(match => match[2]);

test('clause 1: the pages are Items, Shouts, Roadmap, then Rules (Spec, Doctrine) and Insights (Dashboard, Activity, Cost, Pipeline), as in the prototype [N26]', () => {
  assert.deepEqual(navPages({ cost: true }).map(page => [page.group, page.name]), [
    ['Work', 'Items'], ['Work', 'Shouts'], ['Work', 'Roadmap'],
    ['Rules', 'Spec'], ['Rules', 'Doctrine'],
    ['Insights', 'Dashboard'], ['Insights', 'Activity'], ['Insights', 'Cost'], ['Insights', 'Pipeline'],
  ]);
  assert.deepEqual(navPages().map(page => page.id), ['items', 'shouts', 'roadmap', 'spec', 'doctrine', 'dashboard', 'activity', 'pipeline'], 'Cost shows only where the view keeps private cost');
  // The prototype's one line under each menu page.
  assert.deepEqual(Object.fromEntries(navPages({ cost: true }).map(page => [page.id, page.what])), {
    items: 'Every piece of work', shouts: 'Agents talking to the coordinator', roadmap: 'What ships next, in order',
    spec: 'What the product must do', doctrine: 'How the work must be done', dashboard: 'Every number on the board', activity: 'What happened, in order', cost: 'Time and tokens per item', pipeline: 'Why work isn\'t moving',
  });

  const strip = navStripHtml({ cost: true });
  assert.deepEqual(stripLabels(strip), ['Items', 'Shouts', 'Roadmap', 'Rules', 'Insights'], 'Work as plain tabs, then a menu each for Rules and Insights');
  assert.deepEqual(tabsIn(strip), ['items', 'shouts', 'roadmap', 'spec', 'doctrine', 'dashboard', 'activity', 'cost', 'pipeline'], 'every page is one data-tab button, in order');
  assert.match(strip, /data-tab="roadmap"[^>]*>Roadmap<\/button><span class="tab-sep" aria-hidden="true"><\/span><span class="tab-group"><button class="tab-group-btn" data-nav-group="rules"/u, 'a rule separates Work from the menus');
  for (const [group, pages] of [['rules', ['spec', 'doctrine']], ['insights', ['dashboard', 'activity', 'cost', 'pipeline']]]) {
    const menu = new RegExp(`<div class="tab-menu" id="nav-menu-${group}" data-nav-menu="${group}" role="menu" aria-label="[A-Za-z]+" hidden>(.*?)</div>`, 'u').exec(strip);
    assert.ok(menu, `${group}: a closed menu the button controls`);
    assert.match(strip, new RegExp(`data-nav-group="${group}" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="nav-menu-${group}"`, 'u'));
    assert.deepEqual(tabsIn(menu[1]), pages, `${group}: its pages, in order`);
    assert.ok(pages.every(page => menu[1].includes(`data-tab="${page}" role="menuitem"`)), `${group}: each page a menu item`);
  }
  assert.doesNotMatch(strip, /class="f"[^>]*>[^<]/u, 'a fact shows only once the board gives one');

  // The active page: its tab, or its group's button naming it, carries the mark; the menu row says which is current.
  const onSpec = navStripHtml({ tab: 'spec', facts: { spec: 314, doctrine: 46 } });
  assert.match(onSpec, /<button class="tab-group-btn on" data-nav-group="rules"[^>]*><span class="group-label">Rules · Spec<\/span><span class="chev" aria-hidden="true">▾<\/span><\/button>/u);
  assert.match(onSpec, /<button class="tab-group-btn" data-nav-group="insights"[^>]*><span class="group-label">Insights<\/span>/u);
  assert.match(onSpec, /<button class="tab on" data-tab="spec" role="menuitem" type="button" aria-current="page"><span class="tab-name"><b>Spec<\/b><small>What the product must do<\/small><\/span><span class="f" data-nav-fact="spec">314<\/span><\/button>/u);
  assert.match(onSpec, /data-nav-fact="doctrine">46</u);
  const onItems = navStripHtml({ tab: 'items', open: 'insights' });
  assert.match(onItems, /<button class="tab on" data-tab="items" type="button" aria-current="page">Items<\/button>/u);
  assert.doesNotMatch(onItems, /tab-group-btn on/u, 'no group is active while a Work page is');
  assert.match(onItems, /aria-expanded="true" aria-controls="nav-menu-insights"/u);
  assert.match(onItems, /id="nav-menu-insights" data-nav-menu="insights" role="menu" aria-label="Insights">/u, 'the open menu is not hidden');

  // The served shell: the top tier, then the strip, then the pages; no Progress pane.
  for (const privateCost of [true, false]) {
    const html = shell(privateCost);
    assert.match(html, /<html lang="en" data-nav="top" data-side="collapsed">/u, 'the navigation sits at the top from the first paint');
    const tier = html.slice(html.indexOf('<div class="top-tier">'), html.indexOf('<div class="strip"'));
    const order = ['id="side-toggle"', 'id="proj-switch"', 'id="proj-rulings"', 'class="pin"', 'class="crumb">/ <b id="crumb-page">', 'class="notch" id="notch"', 'id="q"', '⌘K', 'id="account-slot"'].map(part => tier.indexOf(part));
    assert.ok(order.every(at => at >= 0) && order.every((at, n) => !n || at > order[n - 1]), `the top tier: mark, switcher with its rulings, pin, crumb, notch, search with ⌘K, account: ${order}`);
    assert.deepEqual(tabsIn(html.slice(html.indexOf('<nav class="tabs" id="tabs"'), html.indexOf('</nav>', html.indexOf('<nav class="tabs" id="tabs"')))), navPages({ cost: privateCost }).map(page => page.id));
    assert.match(html, /<nav class="tabs" id="tabs" aria-label="Board">.*<\/nav>\n {4}<span class="pagectl" id="page-controls"><\/span>/u, 'the right of the strip is the page controls slot');
    assert.doesNotMatch(html, /data-pane="progress"|data-tab="progress"/u, 'no Progress page or pane');
    assert.ok(html.indexOf('class="side-top"') > html.indexOf('</aside>') && html.indexOf('class="side-top"') > html.indexOf('<div class="top-tier">'), 'the project corner left the sidebar for the top tier');
  }
});

test('clause 1: the strip is plain text: active ink, bold and a green dot; hover darkens the text only, never a fill, underline or pill [N26]', () => {
  const css = composeViewStyles();
  const rule = (selector) => {
    const at = css.indexOf(selector + ' {');
    assert.ok(at >= 0, `the stylesheet has ${selector}`);
    return css.slice(at + selector.length + 2, css.indexOf('}', at));
  };
  const strip = ':root[data-nav="top"] .tabs > .tab';
  const plain = rule(`${strip}, :root[data-nav="top"] .tab-group-btn`);
  for (const part of ['padding: 0', 'border: 0', 'border-radius: 0', 'background: none', 'text-decoration: none', 'color: var(--ink-muted)']) assert.ok(plain.includes(part), `a tab is plain text: ${part}`);
  const hover = rule(`${strip}:hover, :root[data-nav="top"] .tab-group-btn:hover`);
  assert.deepEqual(hover.split(';').map(part => part.trim()).filter(Boolean).sort(), ['background: none', 'color: var(--ink)'], 'hover darkens the text and nothing else');
  const on = rule(`${strip}.on, :root[data-nav="top"] .tab-group-btn.on`);
  assert.deepEqual(on.split(';').map(part => part.trim()).filter(Boolean).sort(), ['background: none', 'color: var(--ink)', 'font-weight: 600'], 'active is ink and bold, with no fill');
  const dot = rule(`${strip}.on::before, :root[data-nav="top"] .tab-group-btn.on::before`);
  for (const part of ['width: 5px', 'height: 5px', 'border-radius: var(--radius-dot)', 'background: var(--accent)']) assert.ok(dot.includes(part), `the active mark is a small green dot: ${part}`);
  const navRules = css.slice(css.indexOf(':root[data-nav] {'));
  assert.doesNotMatch(navRules.match(/:root\[data-nav="top"\] \.tabs > \.tab[^{]*\{[^}]*\}/gu).join('\n'), /underline|border-bottom|box-shadow|radius-pill/u, 'no underline, inset block or pill on a tab');
  // The prototype's neutral ground, the notch's grey and the two tiers' heights.
  assert.match(navRules, /--ground: light-dark\(#f2f2f2, #0c110f\); --surface: light-dark\(#ffffff, #121815\)/u);
  assert.match(rule(':root[data-nav] .top-tier'), /height: 40px/u);
  assert.match(rule(':root[data-nav="top"] .strip'), /height: 34px/u);
  assert.match(rule(':root[data-nav] .status'), /height: 26px/u);
});

test('clause 1: the notch holds agents, per hour and rulings, in that order, with steady figures and click hooks [N26]', () => {
  const html = notchHtml({ agents: 62, perHour: 34.4, rulings: 5 });
  assert.deepEqual([...html.matchAll(/<button class="notch-it"[^>]*data-peek="([A-Za-z]+)"[^>]*>(.*?)<\/button>/gu)].map(match => [match[1], match[2].replace(/<[^>]+>/gu, '')]),
    [['agents', '62 agents'], ['perHour', '34/h'], ['rulings', '5 rulings']]);
  assert.match(html, /<b class="g" data-notch="perHour">34\/h<\/b>/u, 'pace is green');
  assert.match(html, /<b class="a" data-notch="rulings">5<\/b> rulings/u, 'rulings are amber: they need the person');
  assert.match(notchHtml({ agents: 0, perHour: null, rulings: 0 }), /<b class="" data-notch="rulings">0<\/b>/u, 'no rulings: plain, not amber');
  assert.match(notchHtml(), /data-notch="agents">—<\/b>.*data-notch="perHour">—\/h<\/b>/u, 'before the board answers, a dash');
  assert.match(html, /data-status="agents"/u, 'agents opens the agent floor');
  assert.match(html, /data-peek="rulings" data-needs-list/u, 'rulings opens what needs the person');
  assert.equal((html.match(/<svg class="sh"/gu) || []).length, 2, 'the two S-curve shoulders');
  assert.doesNotMatch(html, /release|0\.9/u, 'no release widget');
});

test('clause 2: every filter and search has its own address, a default leaves none, and the address reads back the same place [N38]', () => {
  const at = (place) => withPlaceQuery('?k=secret', placeQuery(place));
  assert.equal(at({ tab: 'items' }), '?k=secret', 'a plain tab keeps a plain address, the session key untouched');
  assert.equal(at({ tab: 'items', state: 'verify', lane: 'web' }), '?k=secret&state=verify&lane=web');
  assert.equal(at({ tab: 'items', state: 'all', q: 'greeting card' }), '?k=secret&q=greeting+card', 'a search shows every state, so its address needs only the words');
  assert.equal(at({ tab: 'spec', rows: 'all', rowsDefault: 'decide' }), '?k=secret&rows=all');
  assert.equal(at({ tab: 'spec', rows: 'decide', rowsDefault: 'decide' }), '?k=secret');
  assert.equal(at({ tab: 'shouts', shouts: 'mine' }), '?k=secret&shouts=mine');
  assert.equal(at({ tab: 'activity', activity: 'landed' }), '?k=secret&activity=landed');
  assert.equal(at({ tab: 'roadmap', state: 'verify', lane: 'web' }), '?k=secret', 'Items\' filters belong to Items only');
  assert.equal(at({ tab: 'roadmap', shipped: true }), '?k=secret&shipped=1');
  assert.equal(at({ tab: 'roadmap', shipped: false }), '?k=secret');
  assert.equal(at({ tab: 'activity', by: 'coordinator' }), '?k=secret&by=coordinator');
  assert.equal(at({ tab: 'items', by: 'coordinator', shipped: true }), '?k=secret', 'each page keeps only its own controls\' keys');
  assert.equal(withPlaceQuery('?k=secret&state=verify&q=old', []), '?k=secret', 'leaving a place drops its keys and keeps the rest');
  assert.equal(withPlaceQuery('', []), '');
  assert.deepEqual(readPlaceQuery('?k=secret&state=verify&lane=web&q=greeting+card&rows=all&shouts=mine&activity=landed&shipped=1&by=coordinator'),
    { state: 'verify', lane: 'web', q: 'greeting card', rows: 'all', shouts: 'mine', activity: 'landed', shipped: '1', by: 'coordinator', win: null, window: null, ids: null });
  assert.deepEqual(readPlaceQuery(''), { state: null, lane: null, q: null, rows: null, shouts: null, activity: null, shipped: null, by: null, win: null, window: null, ids: null });
  for (const place of [{ tab: 'items', state: 'gated', lane: 'core' }, { tab: 'items', state: 'all', q: '#12' }, { tab: 'doctrine', rows: 'repo', rowsDefault: 'all' }, { tab: 'shouts', shouts: 'mine' }]) {
    const read = readPlaceQuery(at(place));
    assert.deepEqual(placeQuery({ ...place, ...Object.fromEntries(Object.entries(read).filter(([, value]) => value !== null)) }), placeQuery(place), `${JSON.stringify(place)} reads back as itself`);
  }
});

test('clause 1: the sidebar lists the same pages in 28 px rows, each with its one fact, under quiet group labels, below the project switcher at the top left [N26]', () => {
  const html = navSideHtml({ tab: 'items', cost: true, facts: { items: 653, shouts: 4, roadmap: '60 to go', spec: 314, doctrine: 46 }, amber: ['shouts'] });
  assert.deepEqual([...html.matchAll(/<div class="side-h">([A-Za-z]+)<\/div>/gu)].map(match => match[1]), ['Work', 'Rules', 'Insights'], 'quiet group labels, as in the strip');
  const rows = [...html.matchAll(/<button class="side-row( on)?" data-tab="([a-z]+)" type="button"[^>]*><span class="side-name">([A-Za-z]+)<\/span><span class="f( a)?" data-nav-fact="([a-z]+)">([^<]*)<\/span><\/button>/gu)];
  assert.deepEqual(rows.map(match => match[2]), navPages({ cost: true }).map(page => page.id), 'the same pages in the same order as the strip');
  assert.deepEqual(rows.map(match => [match[2], match[6]]), [['items', '653'], ['shouts', '4'], ['roadmap', '60 to go'], ['spec', '314'], ['doctrine', '46'], ['dashboard', ''], ['activity', ''], ['cost', ''], ['pipeline', '']], 'one fact a row, left empty until the board gives it');
  assert.deepEqual(rows.filter(match => match[4]).map(match => match[2]), ['shouts'], 'amber only where it needs the person; the rest are muted');
  assert.deepEqual(rows.filter(match => match[1]).map(match => match[2]), ['items'], 'one active row');
  assert.match(html, /data-tab="items" type="button" aria-current="page"/u);
  assert.equal(navSideHtml({ tab: 'x' }).includes('data-tab="cost"'), false, 'Cost shows only where the view keeps private cost');

  const css = composeViewStyles();
  const rule = (selector) => { const at = css.indexOf(selector + ' {'); assert.ok(at >= 0, `the stylesheet has ${selector}`); return css.slice(at + selector.length + 2, css.indexOf('}', at)); };
  assert.match(rule(':root[data-nav="side"] .side-row'), /height: 28px/u, '28 px rows');
  assert.match(rule(':root[data-nav="side"] .side-row.on'), /color: var\(--ink\); font-weight: 600/u, 'active is ink and bold');
  assert.match(rule(':root[data-nav="side"] .side-row.on::before'), /width: 5px; height: 5px; border-radius: var\(--radius-dot\); background: var\(--accent\)/u, 'with the small green dot');
  assert.doesNotMatch(rule(':root[data-nav="side"] .side-row') + rule(':root[data-nav="side"] .side-row:hover') + rule(':root[data-nav="side"] .side-row.on'), /underline|box-shadow|radius-pill|background: var\(--(?!accent)/u, 'no fill, underline or pill on a row');
  assert.match(rule(':root[data-nav="side"] .side-row .f.a'), /color: var\(--warn\)/u, 'amber when it needs the person');
  assert.match(rule(':root[data-nav="side"] .side-row .f'), /color: var\(--ink-faint\)/u, 'muted otherwise');
  assert.match(rule(':root[data-nav="side"] .sidenav'), /position: sticky/u);
  assert.match(rule(':root[data-nav="side"] .strip'), /display: none/u, 'the strip gives way to the sidebar');
  assert.match(rule(':root[data-nav="top"] .sidenav'), /display: none/u, 'the sidebar gives way to the strip');
  assert.match(rule(':root[data-nav="side"] header.top'), /grid-column: 1 \/ -1/u, 'the top tier, with the switcher, spans the page above the sidebar');

  const served = shell(false);
  assert.match(served, /<nav class="sidenav" id="sidenav" aria-label="Pages"><div class="side-h">Work<\/div>/u, 'the shell carries the sidebar list');
  assert.match(served, /data-nav-fact="shouts"/u);
  assert.ok(served.indexOf('id="proj-switch"') < served.indexOf('class="notch"') && served.indexOf('id="proj-rulings"') < served.indexOf('class="pin"'), 'the switcher with its decisions badge is the top left');
  assert.ok(served.indexOf('id="sidenav"') > served.indexOf('</main>'), 'the sidebar follows the page in the markup, so the strip\'s tabs are the first of each page [data-tab]');
});

test('clause 2: the pin flips the navigation between the top tabs and the sidebar, this device remembers it, and a phone always gets the top [N26]', () => {
  assert.equal(navLayout({ stored: 'side', wide: true }), 'side');
  assert.equal(navLayout({ stored: 'side', wide: false }), 'top', 'a phone always gets the top tabs');
  assert.equal(navLayout({ stored: 'top', wide: true }), 'top');
  assert.equal(navLayout({ stored: null, wide: true }), 'top', 'the top until the pin says otherwise');
  assert.equal(navLayout({ stored: 'sideways', wide: true }), 'top');
  assert.match(shell(false), /<button class="pin" id="nav-pin" type="button" aria-pressed="false" aria-label="Move the navigation to the sidebar" title="Move the navigation to the sidebar \(\\\)"><span class="pg">⇤<\/span><\/button>/u, 'the pin is a button, not a decoration');

  // The page's own script: run the pin's code against a fake page, as the browser would.
  const script = pageScriptPart2(new Proxy({}, { get: () => function stub() { return {}; } }));
  const start = script.indexOf('const widePage'), end = script.indexOf("widePage.addEventListener?.('change'");
  assert.ok(start >= 0 && end > start, 'the page script carries the pin');
  const run = ({ stored, wide }) => {
    const kept = new Map(stored ? [['pb.nav', stored]] : []), attributes = {}, classes = new Set();
    const pin = { setAttribute: (name, value) => { attributes[name] = value; }, title: '', querySelector: () => ({ classList: { toggle: (name, on) => { if (on) classes.add(name); else classes.delete(name); } } }) };
    const listeners = [];
    const root = { dataset: {} };
    const context = { navLayout, placeControls: () => {}, keep: (key, value) => value === undefined ? kept.get(key) ?? null : kept.set(key, value),
      matchMedia: () => ({ matches: wide, addEventListener: (type, listener) => listeners.push(listener) }),
      document: { documentElement: root, getElementById: () => pin } };
    runInNewContext(script.slice(start, end) + '; placeNav; flipNav; this.flip = flipNav;', context);
    return { root, kept, attributes, classes, pin, flip: context.flip };
  };
  const side = run({ stored: 'side', wide: true });
  assert.equal(side.root.dataset.nav, 'side', 'a device that chose the sidebar gets it');
  assert.equal(side.attributes['aria-pressed'], 'true');
  assert.ok(side.classes.has('up'), 'the glyph turns a quarter');
  assert.match(side.pin.title, /Move the navigation to the top \(\\\)/u);
  side.flip();
  assert.equal(side.kept.get('pb.nav'), 'top', 'a press flips it and the device keeps it');
  assert.equal(side.root.dataset.nav, 'top');
  const top = run({ stored: null, wide: true });
  assert.equal(top.root.dataset.nav, 'top');
  top.flip();
  assert.equal(top.kept.get('pb.nav'), 'side');
  assert.equal(top.root.dataset.nav, 'side');
  assert.equal(run({ stored: 'side', wide: false }).root.dataset.nav, 'top', 'a phone keeps the top tabs whatever the device chose');
});

test('clause 1: each page puts its own controls at the right of the strip, and the sidebar layout puts them on the title row [N26]', () => {
  const labels = (html) => [...html.matchAll(/<(?:button|option)[^>]*>([^<]+)<\/(?:button|option)>/gu)].map(match => match[1]);
  assert.deepEqual(labels(pageControlsHtml({ tab: 'items' })), ['Open', 'Building', 'In review', 'All', 'List', 'Pipeline', 'New item'], 'Items: Open, Building, In review, All, List, Pipeline and New item');
  assert.match(pageControlsHtml({ tab: 'items', state: 'verify' }), /<button type="button" data-page-ctl="state" data-value="verify" class="on" aria-pressed="true">In review<\/button>/u, 'the shown state is the pressed one');
  assert.equal((pageControlsHtml({ tab: 'items', state: 'building' }).match(/data-page-ctl="state"[^>]* class="on"/gu) || []).length, 1, 'one state at a time');
  assert.doesNotMatch(pageControlsHtml({ tab: 'items', writable: false }), /New item/u, 'a read-only view offers no New item');
  assert.deepEqual(labels(pageControlsHtml({ tab: 'items', state: 'ids' })), ['Open', 'Building', 'In review', 'All', 'From Pipeline', 'List', 'Pipeline', 'New item'], 'Items opened from a Pipeline count says so, and only then');
  assert.match(pageControlsHtml({ tab: 'items', state: 'ids' }), /data-value="ids" class="on"/u);
  assert.equal(pageControlsHtml({ tab: 'progress' }), '', 'Progress is gone: no controls');
  assert.deepEqual(labels(pageControlsHtml({ tab: 'shouts' })), ['For you', 'Questions', 'All'], 'Shouts: For you, Questions and All');
  assert.match(pageControlsHtml({ tab: 'shouts', shouts: 'you' }), /data-value="you" class="on"/u);
  assert.deepEqual(labels(pageControlsHtml({ tab: 'roadmap' })), ['Show shipped'], 'Roadmap: Show shipped');
  assert.deepEqual(labels(pageControlsHtml({ tab: 'cost' })), ['Today', '7 days', '30 days'], 'Cost: its window sits in the strip');
  assert.match(pageControlsHtml({ tab: 'cost', costWindow: '30d' }), /data-page-ctl="costwindow" data-value="30d" class="on" aria-pressed="true">30 days</u, 'the shown window is the pressed one');
  assert.match(pageControlsHtml({ tab: 'roadmap', shipped: true }), /aria-pressed="true">Hide shipped</u);
  assert.deepEqual(labels(pageControlsHtml({ tab: 'activity', people: ['agent-1', 'coordinator', 'person'] })), ['All', 'Landed', 'Sent back', 'Held', 'Blocked', 'Pending review', 'Rulings', 'Shouts', 'Everyone', 'agent-1', 'The coordinator', 'You', '6 h', '12 h', '24 h'], 'Activity: the event filters, a person filter and the window');
  assert.match(pageControlsHtml({ tab: 'activity', by: 'coordinator', people: ['coordinator'] }), /<option value="coordinator" selected>/u);
  assert.deepEqual(labels(pageControlsHtml({ tab: 'pipeline' })), ['15m', '30m', '1h', '3h'], 'Pipeline: the 15m, 30m, 1h and 3h window');
  assert.match(pageControlsHtml({ tab: 'pipeline' }), /data-page-ctl="window" data-value="1h" class="on" aria-pressed="true">1h</u, 'one hour is the default window');
  assert.match(pageControlsHtml({ tab: 'pipeline', window: '3h' }), /data-value="3h" class="on"/u);
  for (const tab of ['spec', 'doctrine', 'dashboard', 'settings', null]) assert.equal(pageControlsHtml({ tab }), '', `${tab}: nothing to control shows nothing`);

  // The served shell: the controls live in the strip, and the sidebar layout's title row waits to take them.
  const html = shell(false);
  assert.match(html, /<main>\n {2}<div class="page-title" id="page-title"><h2 id="page-title-text"><\/h2><\/div>/u, 'the title row opens the page');
  const css = composeViewStyles();
  const rule = (selector) => { const at = css.indexOf(selector + ' {'); assert.ok(at >= 0, `the stylesheet has ${selector}`); return css.slice(at + selector.length + 2, css.indexOf('}', at)); };
  assert.match(rule(':root[data-nav] .pagectl'), /margin-left: auto/u, 'right-aligned in the strip and on the title row');
  assert.match(rule(':root[data-nav="side"] .page-title'), /display: flex/u, 'the title row shows in the sidebar layout');
  assert.match(rule(':root[data-nav="top"] .page-title'), /display: none/u, 'and not in the top layout');
  assert.match(rule(':root[data-nav] .pagectl .new'), /color: var\(--accent\)/u);

  // The page's script draws them from the shared render script and moves them with the layout.
  assert.ok(pageRenderScript().includes('function pageControlsHtml(') && pageRenderScript().includes('function navLayout('), 'the render script carries both');
});

test('clause 2: each control\'s state is in the page address, and the address puts it back [N38]', () => {
  const states = [
    [{ tab: 'items', state: 'building' }, '?state=building'], [{ tab: 'items', state: 'verify' }, '?state=verify'], [{ tab: 'items', state: 'all' }, '?state=all'],
    [{ tab: 'shouts', shouts: 'you' }, '?shouts=you'], [{ tab: 'roadmap', shipped: true }, '?shipped=1'], [{ tab: 'activity', by: 'person' }, '?by=person'],
  ];
  const back = (search) => Object.fromEntries(Object.entries(readPlaceQuery(search)).filter(([, value]) => value !== null).map(([key, value]) => [key, key === 'shipped' ? value === '1' : value]));
  for (const [place, search] of states) {
    assert.equal(withPlaceQuery('', placeQuery(place)), search, `${place.tab}: the control's state is in the address`);
    assert.deepEqual(placeQuery({ tab: place.tab, ...back(search) }), placeQuery(place), `${place.tab}: refresh, back and forward read it back`);
  }
  assert.equal(withPlaceQuery('', placeQuery({ tab: 'items' })), '', 'Open, the default, leaves the address plain');
  // Pipeline's window and the items a Pipeline count opened Items on (#6869).
  assert.equal(withPlaceQuery('', placeQuery({ tab: 'pipeline', window: '3h' })), '?w=3h', 'a window other than the default is in the address');
  assert.equal(withPlaceQuery('', placeQuery({ tab: 'pipeline', window: '1h' })), '', 'one hour, the default, leaves it plain');
  assert.equal(withPlaceQuery('', placeQuery({ tab: 'items', state: 'ids', ids: [6579, 6580, 5994] })), '?state=ids&ids=6579%2C6580%2C5994', 'Items opened from a count names its items');
  assert.equal(withPlaceQuery('', placeQuery({ tab: 'activity', window: '3h', ids: [1] })), '', 'each page keeps only its own keys');
  const opened = readPlaceQuery('?state=ids&ids=6579%2C6580%2C5994&w=15m');
  assert.deepEqual([opened.state, opened.ids, opened.window], ['ids', '6579,6580,5994', '15m'], 'the address reads the items and the window back');
  assert.deepEqual(opened.ids.split(',').map(Number), [6579, 6580, 5994]);
});

test('clause 1: at 900 px or less the top bar is Menu with its rulings, the project name, Search and the account, with no notch or strip [N26]', () => {
  const html = shell(false);
  const tier = html.slice(html.indexOf('<div class="top-tier">'), html.indexOf('<div class="strip"'));
  const order = ['id="menu-btn"', '>Menu<', 'id="menu-rulings"', 'id="proj-title"', 'id="q"', 'id="account-slot"'].map(part => tier.indexOf(part));
  assert.ok(order.every(at => at >= 0) && order.every((at, n) => !n || at > order[n - 1]), `the compact bar: Menu, its rulings, the project name, Search, the account: ${order}`);
  assert.match(tier, /<button class="menubtn" id="menu-btn" type="button" aria-expanded="false" aria-controls="mdrawer">/u, 'Menu is a button that says what it controls');
  const css = composeViewStyles();
  const narrow = css.slice(css.indexOf('@media (max-width: 900px) {\n  :root[data-nav] { --top: 48px; }'));
  const block = narrow.slice(0, narrow.indexOf('\n}\n') + 3);
  assert.ok(block.length > 100, 'the stylesheet has the compact block');
  assert.match(block, /:root\[data-nav\] \.notch, :root\[data-nav\] \.crumb, :root\[data-nav\] \.pin, :root\[data-nav\]\[data-side\] \.side-top, :root\[data-nav="top"\] \.strip \{ display: none; \}/u, 'the notch and the strip give way');
  assert.match(block, /:root\[data-nav\] \.menubtn \{ display: inline-flex;/u, 'Menu shows');
  assert.match(block, /:root\[data-nav\] \.ptitle \{ display: block;/u, 'the project name shows');
  assert.match(block, /:root\[data-nav="top"\] \.page-title \.pagectl \{ width: 100%;/u, 'the page controls sit under the page title');
  assert.doesNotMatch(css.slice(0, css.indexOf('@media (max-width: 900px) {\n  :root[data-nav] { --top: 48px; }')), /\.menubtn \{ display: inline-flex/u, 'wider pages never show Menu');
  assert.ok(pageScriptPart4(new Proxy({}, { get: () => function stub() { return {}; } })).includes("matchMedia('(max-width: 900px)').matches ? $('page-title')"), 'the page controls move to the title row');
});

test('clause 2: Menu opens a drawer from the left with the project, agents and pace, Rulings and every page with its fact; a page picked closes it [N26]', () => {
  for (const privateCost of [true, false]) {
    const html = shell(privateCost);
    const drawer = html.slice(html.indexOf('<aside class="mdrawer"'), html.indexOf('</aside>', html.indexOf('<aside class="mdrawer"')));
    assert.match(html, /<div class="mveil" id="mveil" hidden><\/div>\n<aside class="mdrawer" id="mdrawer" aria-label="Menu" hidden>/u, 'a dimmed veil, then the drawer, both closed at first');
    const order = ['id="mdrawer-proj"', 'data-notch="agents"', 'data-notch="perHour"', 'data-needs-list', '>Rulings<', 'data-tab="items"'].map(part => drawer.indexOf(part));
    assert.ok(order.every(at => at >= 0) && order.every((at, n) => !n || at > order[n - 1]), `the drawer: project, agents, pace, Rulings, pages: ${order}`);
    assert.deepEqual([...drawer.matchAll(/data-tab="([a-z]+)"/gu)].map(match => match[1]), navPages({ cost: privateCost }).map(page => page.id), 'every page, in the strip\'s order');
    assert.equal((drawer.match(/data-nav-fact="/gu) || []).length, navPages({ cost: privateCost }).length, 'each page carries its fact slot');
  }
  const css = composeViewStyles();
  assert.match(css, /:root\[data-nav\] \.mdrawer \.side-row \{[^}]*min-height: 40px; height: 40px/u, 'pages are 40 px rows');
  assert.match(css, /:root\[data-nav\] \.mdrawer \{ position: fixed; top: 0; bottom: 0; left: 0;[^}]*animation: mslide/u, 'the drawer slides in from the left');

  // The page's script: Menu opens it and the pick closes it.
  const script = menuScript();
  const start = script.indexOf('const setMenu'), end = script.indexOf("document.addEventListener('click'");
  assert.ok(start >= 0 && end > start, 'the page script carries the drawer');
  const nodes = { mveil: { hidden: true }, mdrawer: { hidden: true }, 'menu-btn': { expanded: null, setAttribute(name, value) { this.expanded = value; } } };
  const context = { $: (id) => nodes[id] };
  runInNewContext(script.slice(start, end) + '; this.setMenu = setMenu;', context);
  context.setMenu(true);
  assert.deepEqual([nodes.mveil.hidden, nodes.mdrawer.hidden, nodes['menu-btn'].expanded], [false, false, 'true'], 'Menu shows the veil and the drawer');
  context.setMenu(false);
  assert.deepEqual([nodes.mveil.hidden, nodes.mdrawer.hidden, nodes['menu-btn'].expanded], [true, true, 'false'], 'closing hides both');
  assert.ok(script.includes("if (event.target.closest('#menu-btn')) { event.stopPropagation(); setMenu($('mdrawer').hidden); return; }"), 'Menu toggles the drawer');
  assert.ok(script.includes("const picked = event.target.closest('#mdrawer [data-tab], #mdrawer [data-needs-list]');") && script.includes("event.stopPropagation(); setMenu(false); picked.dataset.later = '1';"), 'a page or Rulings picked in the drawer closes it at once, and the pick follows on the next turn');
  assert.ok(script.includes("if (event.target.closest('#mveil')) { event.stopPropagation(); setMenu(false); return; }"), 'the dimmed page closes it');
});

test('clause 2: Items has no sign-in banner, summary panel or in-page toolbar above its list; filters and New item live in the strip [N26]', () => {
  const html = shell(false);
  const items = html.slice(html.indexOf('<section data-pane="items"'), html.indexOf('<section data-pane="shouts"'));
  for (const id of ['proof-stats', 'items-toolbar', 'items-view-switch', 'filter-toggle', 'filter-menu', 'new-item']) assert.ok(!items.includes('id="' + id + '"'), `${id} is not on the Items page`);
  assert.doesNotMatch(items, /class="card-panel toolbar"|local-note|share-note/u, 'nothing but the list card leads the page');
  assert.ok(items.indexOf('id="chain"') < items.indexOf('id="needs"'), 'questions and sentinels fold below the items');
  const css = composeViewStyles();
  assert.match(css, /:root\[data-tab="items"\] #local-note\[data-kind="note"\][^{]*\{ display: none; \}/u, 'the sign-in note is hidden while Items shows');
  const lanes = [{ value: '', label: 'All lanes', count: null }, { value: 'core', label: 'core', count: 605 }, { value: 'view', label: 'view', count: 52 }];
  const strip = pageControlsHtml({ tab: 'items', lane: 'core', lanes, itemsView: 'pipeline' });
  assert.match(strip, /<select class="sel" data-page-ctl="lane" aria-label="Lane">.*<option value="core" selected>core · 605<\/option>/u, 'the lane filter is in the strip, with its counts');
  assert.match(strip, /data-page-ctl="view" data-value="pipeline" class="on" aria-pressed="true">Pipeline/u, 'List and Pipeline are in the strip');
  assert.match(strip, /data-page-ctl="new" aria-label="New item">New item/u, 'New item is in the strip');
});

test('clause 1: the strip\'s #new-item is the only New item on the page, and Shouts and Activity draw no in-page filter the strip holds [N26,#6721]', () => {
  const html = shell(false);
  assert.equal([...html.matchAll(/id="new-item"/gu)].length, 0, 'the shell draws no New item of its own; the strip fills it in');
  assert.equal([...pageControlsHtml({ tab: 'items' }).matchAll(/id="new-item"/gu)].length, 1, 'the strip draws one #new-item');
  assert.equal([...pageControlsHtml({ tab: 'items' }).matchAll(/New item/gu)].length, 2, 'its one control, with the accessible name');
  assert.match(pageControlsHtml({ tab: 'items' }), /<button class="new" id="new-item" type="button" data-page-ctl="new" aria-label="New item">/u);
  const css = composeViewStyles();
  for (const [name, wide] of [['.sx-mfilters', '#shouts-pane #feed > .sx-mfilters'], ['.act-mfilters', null]]) {
    assert.ok(css.includes(name + ' { display: none; }'), `${name} is hidden at every width the strip shows`);
    const shown = [...css.matchAll(new RegExp('@media \\(max-width: (\\d+)px\\) \\{[^@]*?' + name.replace('.', '\\.') + '[^{]*\\{ display: (?:flex|inline-flex)', 'gu'))].map((m) => Number(m[1]));
    assert.ok(shown.length > 0 && shown.every((width) => width <= 900), `${name} shows only at 900 px and narrower, where the strip is hidden or cut off: ${shown}`);
    if (wide) assert.ok(css.includes(wide + ' { display: none; }'), `${wide} is hidden on wide pages`);
  }
  assert.match(pageControlsHtml({ tab: 'shouts' }), /data-shout-filter="you"/u, 'the strip holds the Shouts filter');
  assert.match(pageControlsHtml({ tab: 'activity' }), /data-value="landed"/u, 'the strip holds the Activity filters');
});

test('clause 1: Items rows are one card of mockup-shaped rows at the mockup\'s fixed row height [N26]', () => {
  const css = composeViewStyles();
  const rule = (selector) => { const at = css.indexOf(selector + ' {'); assert.ok(at >= 0, `the stylesheet has ${selector}`); return css.slice(at + selector.length + 2, css.indexOf('}', at)); };
  assert.match(rule('#chain'), /--item-row-h: 55px/u, 'the mockup\'s row: 55 px and a 2 px gap, 57 px a row, kept fixed for the windowing');
  const row = sharedRowHtml({ className: 'on ', attributes: { 'data-item': 7 }, title: 'A title', state: 'building', primaryHtml: '<span>#7</span>A title', timeHtml: '<time>1h</time>', chipHtml: '<span class="chip">core-7</span>', metaHtml: '<span>core</span>' });
  const order = ['class="dot', 'class="row-copy"', 'class="t srow-text"><span>#7</span>A title', 'class="meta"><span>core</span>', 'class="row-side"', '<time', 'class="chip">core-7'].map(part => row.indexOf(part));
  assert.ok(order.every((at, n) => at >= 0 && (!n || at > order[n - 1])), `state circle, #id and title, then lane, then time and the holder chip at the right: ${order}`);
});

test('clause 1: the top right is one account control, the person\'s initial when signed in and Sign in when not, and its menu holds who they are, Settings, Theme, and Pair a phone; the Sign out row stays hidden until the view has a real sign-out [N26,#6648]', () => {
  assert.match(accountHtml({ signedIn: true, login: 'coreyolson' }), />C<\/button>$/u, 'the initial, upper-cased');
  assert.match(accountHtml({ signedIn: false }), />Sign in<\/button>$/u);
  const text = (html) => [...html.matchAll(/<(?:b|small|button)[^>]*>(.*?)<\/(?:b|small|button)>/gu)].map((m) => m[1].replace(/<[^>]+>/gu, ''));
  const signedIn = accountMenuHtml({ signedIn: true, login: 'coreyolson', theme: 'dark' });
  assert.deepEqual(text(signedIn), ['@coreyolson', 'GitHub', 'Settings', 'ThemeDark', 'Pair a phone']);
  const signedOut = accountMenuHtml({ signedIn: false });
  assert.doesNotMatch(signedOut, /Not signed in|class="who"|<small>/u, 'signed out is one quiet row, no banner block');
  assert.equal(text(signedOut)[0], 'Sign in with GitHub');
  assert.doesNotMatch(signedIn + signedOut, /Settings<span>/u, 'no stray comma after Settings');
  assert.match(signedOut, /data-account-signin>Sign in with GitHub</u);
  assert.doesNotMatch(signedIn + signedOut, /Sign out/u, 'no Sign out row: the view has no real sign-out yet, and relay off is destructive');
  for (const html of [signedIn, signedOut]) for (const word of ['Settings', 'Theme', 'Pair a phone']) assert.match(html, new RegExp(word, 'u'));
  assert.match(accountHtml({ signedIn: true, login: '<b>' }), /&lt;|>B</u, 'a login is text, never markup');
});

test('clause 2: the page carries no sign-in banner, and Settings is reached from the account menu only [N26,#6648]', () => {
  const html = cockpitMarkup({ repositoryAttribute: 'https://example.test', cssAttribute: 'view.css', hostedLocal: true, snapshot: false, readOnly: false, requestMode: false, privateCost: false, hostedMarkup: () => '', signIn: '', settingsMarkup: () => '', starMarkup: () => '' });
  assert.doesNotMatch(html, /Open your boards on any device|share-note|share-again/u, 'no banner and no second invitation');
  assert.doesNotMatch(html, /id="theme"|machine-settings-entry/u, 'the bare theme button and the machine Settings entry are gone');
  assert.equal([...html.matchAll(/data-tab="settings"/gu)].length, 0, 'Settings is not a fixed button anywhere in the page shell; the menu draws it');
  assert.match(html, /id="account-slot">.*id="account"[^>]*data-account/su, 'the account control sits in its slot');
  assert.match(accountMenuHtml({}), /data-tab="settings"/u, 'the menu holds Settings');
});
