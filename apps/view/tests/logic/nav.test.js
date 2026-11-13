/** @pullboard-test-input source-tree */
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
import { placeQuery } from '../../src/logic/nav.js';
import { readPlaceQuery } from '../../src/logic/nav.js';
import { withPlaceQuery } from '../../src/logic/nav.js';
import { progressHtml } from '../../src/logic/nav.js';

/** The served shell, with the sections it embeds stubbed to empty markup. */
const shell = (privateCost) => cockpitMarkup({ repositoryAttribute: 'https://example.test/repo', cssAttribute: '/view.css', hostedLocal: false, snapshot: false, readOnly: false,
  requestMode: false, privateCost, hostedMarkup: () => '', signIn: null, settingsMarkup: () => '', starMarkup: () => '' });
/** The data-tab pages in markup order, and the label of every strip control in order. */
const tabsIn = (html) => [...html.matchAll(/class="tab[^"]*" data-tab="([a-z]+)"/gu)].map(match => match[1]);
const stripLabels = (html) => [...html.matchAll(/<button class="(tab|tab-group-btn)[^"]*" data-(?:tab|nav-group)="[a-z]+"[^>]*>(?:<span class="group-label">)?([^<]+)/gu)].filter(match => !/role="menuitem"/u.test(match[0])).map(match => match[2]);

test('clause 1: the pages are Progress, Items, Shouts, Roadmap, then Rules (Spec, Doctrine) and Insights (Dashboard, Activity, Cost), as in the prototype [N26]', () => {
  assert.deepEqual(navPages({ cost: true }).map(page => [page.group, page.name]), [
    ['Work', 'Progress'], ['Work', 'Items'], ['Work', 'Shouts'], ['Work', 'Roadmap'],
    ['Rules', 'Spec'], ['Rules', 'Doctrine'],
    ['Insights', 'Dashboard'], ['Insights', 'Activity'], ['Insights', 'Cost'],
  ]);
  assert.deepEqual(navPages().map(page => page.id), ['progress', 'items', 'shouts', 'roadmap', 'spec', 'doctrine', 'dashboard', 'activity'], 'Cost shows only where the view keeps private cost');
  // The prototype's one line under each menu page.
  assert.deepEqual(Object.fromEntries(navPages({ cost: true }).map(page => [page.id, page.what])), {
    progress: 'What is happening, in plain words', items: 'Every piece of work', shouts: 'Agents talking to the coordinator', roadmap: 'What ships next, in order',
    spec: 'What the product must do', doctrine: 'How the work must be done', dashboard: 'Every number on the board', activity: 'What happened, in order', cost: 'Time and tokens per item',
  });

  const strip = navStripHtml({ cost: true });
  assert.deepEqual(stripLabels(strip), ['Progress', 'Items', 'Shouts', 'Roadmap', 'Rules', 'Insights'], 'Work as plain tabs, then a menu each for Rules and Insights');
  assert.deepEqual(tabsIn(strip), ['progress', 'items', 'shouts', 'roadmap', 'spec', 'doctrine', 'dashboard', 'activity', 'cost'], 'every page is one data-tab button, in order');
  assert.match(strip, /data-tab="roadmap"[^>]*>Roadmap<\/button><span class="tab-sep" aria-hidden="true"><\/span><span class="tab-group"><button class="tab-group-btn" data-nav-group="rules"/u, 'a rule separates Work from the menus');
  for (const [group, pages] of [['rules', ['spec', 'doctrine']], ['insights', ['dashboard', 'activity', 'cost']]]) {
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

  // The served shell: the top tier, then the strip, then the pages; a Progress pane beside the rest.
  for (const privateCost of [true, false]) {
    const html = shell(privateCost);
    assert.match(html, /<html lang="en" data-nav="top" data-side="collapsed">/u, 'the navigation sits at the top from the first paint');
    const tier = html.slice(html.indexOf('<div class="top-tier">'), html.indexOf('<div class="strip"'));
    const order = ['id="side-toggle"', 'id="proj-switch"', 'id="proj-rulings"', 'class="pin"', 'class="crumb">/ <b id="crumb-page">', 'class="notch" id="notch"', 'id="q"', '⌘K', 'id="account-slot"'].map(part => tier.indexOf(part));
    assert.ok(order.every(at => at >= 0) && order.every((at, n) => !n || at > order[n - 1]), `the top tier: mark, switcher with its rulings, pin, crumb, notch, search with ⌘K, account: ${order}`);
    assert.deepEqual(tabsIn(html.slice(html.indexOf('<nav class="tabs" id="tabs"'), html.indexOf('</nav>', html.indexOf('<nav class="tabs" id="tabs"')))), navPages({ cost: privateCost }).map(page => page.id));
    assert.match(html, /<nav class="tabs" id="tabs" aria-label="Board">.*<\/nav>\n {4}<span class="pagectl" id="page-controls"><\/span>/u, 'the right of the strip is the page controls slot');
    assert.match(html, /<section data-pane="progress" id="progress" class="progress-pane" aria-label="Progress"><\/section>/u);
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
  for (const part of ['width: 5px', 'height: 5px', 'border-radius: 50%', 'background: var(--accent)']) assert.ok(dot.includes(part), `the active mark is a small green dot: ${part}`);
  const navRules = css.slice(css.indexOf(':root[data-nav="top"] {'));
  assert.doesNotMatch(navRules.match(/:root\[data-nav="top"\] \.tabs > \.tab[^{]*\{[^}]*\}/gu).join('\n'), /underline|border-bottom|box-shadow|radius-pill/u, 'no underline, inset block or pill on a tab');
  // The prototype's neutral ground, the notch's grey and the two tiers' heights.
  assert.match(navRules, /--ground: light-dark\(#f2f2f2, #0c110f\); --surface: light-dark\(#ffffff, #121815\)/u);
  assert.match(rule(':root[data-nav="top"] .top-tier'), /height: 40px/u);
  assert.match(rule(':root[data-nav="top"] .strip'), /height: 34px/u);
  assert.match(rule(':root[data-nav="top"] .status'), /height: 26px/u);
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

test('clause 1: Progress says the board in plain words [N26]', () => {
  const html = progressHtml({ agents: 1, perHour: 12.6, landedDay: 300, rulings: 2, building: 4, review: 1 });
  assert.equal(html.replace(/<[^>]+>/gu, '|').split('|').filter(Boolean).join(''), 'Progress1 agent is at work.4 building and 1 in review.Work lands at about 13 an hour, 300 in the last 24 hours.2 rulings wait for you.');
  assert.match(progressHtml({ agents: 0, rulings: 0 }), /Nothing is building or in review\.<\/p><p>Nothing waits for you\./u);
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
  assert.equal(withPlaceQuery('?k=secret&state=verify&q=old', []), '?k=secret', 'leaving a place drops its keys and keeps the rest');
  assert.equal(withPlaceQuery('', []), '');
  assert.deepEqual(readPlaceQuery('?k=secret&state=verify&lane=web&q=greeting+card&rows=all&shouts=mine&activity=landed'),
    { state: 'verify', lane: 'web', q: 'greeting card', rows: 'all', shouts: 'mine', activity: 'landed' });
  assert.deepEqual(readPlaceQuery(''), { state: null, lane: null, q: null, rows: null, shouts: null, activity: null });
  for (const place of [{ tab: 'items', state: 'gated', lane: 'core' }, { tab: 'items', state: 'all', q: '#12' }, { tab: 'doctrine', rows: 'repo', rowsDefault: 'all' }, { tab: 'shouts', shouts: 'mine' }]) {
    const read = readPlaceQuery(at(place));
    assert.deepEqual(placeQuery({ ...place, ...Object.fromEntries(Object.entries(read).filter(([, value]) => value !== null)) }), placeQuery(place), `${JSON.stringify(place)} reads back as itself`);
  }
});

test('clause 1: the top right is one account control, the person\'s initial when signed in and Sign in when not, and its menu holds who they are, Settings, Theme, Pair a phone and Sign out [N26,#6648]', () => {
  assert.match(accountHtml({ signedIn: true, login: 'coreyolson' }), />C<\/button>$/u, 'the initial, upper-cased');
  assert.match(accountHtml({ signedIn: false }), />Sign in<\/button>$/u);
  const text = (html) => [...html.matchAll(/<(?:b|small|button)[^>]*>(.*?)<\/(?:b|small|button)>/gu)].map((m) => m[1].replace(/<[^>]+>/gu, ''));
  const signedIn = accountMenuHtml({ signedIn: true, login: 'coreyolson', theme: 'dark' });
  assert.deepEqual(text(signedIn), ['@coreyolson', 'GitHub', 'Settings,', 'ThemeDark', 'Pair a phone', 'Sign out']);
  const signedOut = accountMenuHtml({ signedIn: false });
  assert.match(signedOut, /Not signed in/u);
  assert.match(signedOut, /data-account-signin>Sign in with GitHub</u);
  assert.doesNotMatch(signedOut, /Sign out/u, 'a signed-out menu has no Sign out');
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
