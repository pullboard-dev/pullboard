/** @pullboard-test-input apps/view/src/io/palette/client.js apps/view/src/io/palette/palette.css apps/view/src/io/palette/index.js apps/view/src/logic/cockpit/prose.js apps/view/src/io/cockpit/page.js apps/view/src/io/page/actions.js */
/** @pullboard-world-pin reads the palette module and the page hook sources to prove what the hosted page loads. */
/** The view's search box, command palette and hotkeys behave as the approved nav prototype does [U94 item 6, #6616]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Script } from 'node:vm';
import { paletteScript } from '../../../src/io/palette/index.js';

const CLIENT = readFileSync(new URL('../../../src/io/palette/client.js', import.meta.url), 'utf8');
const pbPalette = new Function(`${CLIENT}; return pbPalette;`)();

/** A stand-in page: the tabs, a board in memory, and every place go(), the theme and the navigation were sent. */
function page(options = {}) {
  const calls = { go: [], theme: 0, move: 0, fetch: 0 };
  const listeners = {};
  const parts = new Map();
  const part = (selector) => parts.get(selector) || parts.set(selector, { innerHTML: '', classList: { toggle() {} }, setAttribute() {}, focus() {}, setSelectionRange() {}, scrollIntoView() {} }).get(selector);
  const overlay = {
    innerHTML: '', addEventListener() {}, setAttribute() {}, querySelector: part, querySelectorAll: () => [],
  };
  const doc = {
    body: { appendChild() {} }, activeElement: null,
    createElement: () => overlay,
    addEventListener: (type, fn) => { listeners[type] = fn; },
  };
  const box = { placeholder: 'Search', parentNode: { appendChild() {} }, addEventListener(type, fn) { this[type] = fn; } };
  const items = options.items ?? [
    { id: 6616, title: 'View search box, command palette and hotkeys', updatedAt: '2026-11-12T10:00', state: 'building' },
    { id: 2225, title: 'A plain-language progress view', updatedAt: '2026-11-11T10:00', state: 'open' },
    { id: 3186, title: 'Landing ends a batch that makes no progress', updatedAt: '2026-11-12T11:00', state: 'verified' },
  ];
  const palette = pbPalette({
    document: doc, mac: true, box,
    pages: () => ['items', 'shouts', 'roadmap', 'spec', 'doctrine', 'dashboard', 'activity', 'cost'].map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1) })),
    hasTab: () => true,
    items: () => { calls.fetch += 0; return items; },
    go: (target) => calls.go.push(target),
    theme: () => { calls.theme += 1; },
    movePlace: () => { calls.move += 1; },
  });
  const press = (key, target = { closest: () => null }, extra = {}) => {
    const event = { key, target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...extra };
    listeners.keydown(event);
    return event;
  };
  return { palette, press, calls, overlay, box, results: part('.pal-res') };
}
const field = { closest: (selector) => (/input/.test(selector) ? {} : null) };

test('clause 1: the search box reads "Search or jump to…" and a press on it opens the palette [U94,#6616]', () => {
  const { palette, box, overlay } = page();
  assert.equal(box.placeholder, 'Search or jump to…');
  let prevented = false;
  box.mousedown({ button: 0, preventDefault() { prevented = true; } });
  assert.ok(prevented && palette.isOpen(), 'pressing the box opens the palette instead of focusing the field');
  assert.match(overlay.innerHTML, /placeholder="Search items, or jump to a page…"/);
});

test('clause 1: Cmd+K or Ctrl+K and / open the palette, and Cmd+K again closes it [U94,#6616]', () => {
  for (const extra of [{ metaKey: true }, { ctrlKey: true }]) {
    const { palette, press } = page();
    press('k', undefined, extra);
    assert.ok(palette.isOpen(), 'the chord opens it');
    press('k', undefined, extra);
    assert.ok(!palette.isOpen(), 'and closes it');
  }
  const { palette, press } = page();
  const event = press('/');
  assert.ok(palette.isOpen() && event.defaultPrevented, '/ opens it and is not typed into the page');
});

test('clause 1: the palette finds pages, items by id and by title, and actions, from the board in memory [U94,#6616]', () => {
  const { palette } = page();
  const kinds = (q) => palette.results(q).map((r) => r.kind + ':' + r.label);
  assert.deepEqual(kinds('').filter((k) => k.startsWith('Go to')).length, 8, 'an empty query lists every page');
  assert.ok(kinds('').some((k) => k === 'Actions:Move the navigation'), 'and the actions');
  assert.deepEqual(kinds('road'), ['Go to:Roadmap'], 'a page by its name');
  assert.deepEqual(kinds('#2225'), ['Items:#2225 A plain-language progress view'], 'an item by its id, with or without the #');
  assert.deepEqual(kinds('2225'), ['Items:#2225 A plain-language progress view']);
  assert.deepEqual(kinds('landing'), ['Items:#3186 Landing ends a batch that makes no progress'], 'an item by its title');
  assert.deepEqual(kinds('shortcuts'), ['Actions:Show keyboard shortcuts'], 'an action by its words');
  const both = kinds('pro').filter((k) => k.startsWith('Items'));
  assert.deepEqual(both, ['Items:#3186 Landing ends a batch that makes no progress', 'Items:#2225 A plain-language progress view'], 'items newest first');
  assert.deepEqual(kinds('zzzz'), [], 'nothing matches nothing');
});

test('clause 1: arrow keys move the pick, Enter opens it, and a pick goes where it names [U94,#6616]', () => {
  const { palette, press, calls, results } = page();
  press('/');
  press('ArrowDown');
  press('ArrowDown');
  assert.equal(palette.state().sel, 2);
  press('ArrowUp');
  assert.equal(palette.state().sel, 1);
  assert.match(results.innerHTML, /pal-r on" type="button" role="option" aria-selected="true" data-res="1"><span>Shouts/, 'the picked row is marked');
  press('Enter');
  assert.deepEqual(calls.go, ['tab:shouts']);
  assert.ok(!palette.isOpen(), 'choosing closes it');
  press('/');
  palette.state().q = 'landing';
  palette.state().list = palette.results('landing');
  press('Enter');
  assert.deepEqual(calls.go, ['tab:shouts', 'item:3186'], 'an item opens by its id');
});

test('clause 2: g then a page letter jumps to that page, and a late or unknown second key does nothing [U94,#6616]', () => {
  const letters = { i: 'items', s: 'shouts', r: 'roadmap', e: 'spec', o: 'doctrine', d: 'dashboard', a: 'activity', c: 'cost' };
  for (const [letter, tab] of Object.entries(letters)) {
    const { press, calls } = page();
    press('g'); press(letter);
    assert.deepEqual(calls.go, ['tab:' + tab], `g ${letter} opens ${tab}`);
  }
  const { press, calls } = page();
  press('g'); press('x');
  press('i');
  assert.deepEqual(calls.go, [], 'g then an unknown letter, then a lone letter, goes nowhere');
  const realNow = Date.now;
  try {
    press('g');
    Date.now = () => realNow() + 2000;
    press('i');
  } finally { Date.now = realNow; }
  assert.deepEqual(calls.go, [], 'g then a letter after the pause goes nowhere');
});

test('clause 2: ? lists the shortcuts, \\ moves the navigation, Esc closes [U94,#6616]', () => {
  const { palette, press, calls, overlay } = page();
  press('?');
  assert.ok(palette.isHelp());
  for (const text of ['Keyboard shortcuts', 'g i', 'g s', 'g r', 'g e', 'g o', 'g d', 'g a', 'g c', 'Search or jump anywhere', '⌘K', 'Move the navigation', 'Esc']) assert.ok(overlay.innerHTML.includes(text), `the list has ${text}`);
  press('Escape');
  assert.ok(!palette.isHelp() && overlay.innerHTML === '', 'Esc closes the list');
  press('?');
  press('?');
  assert.ok(!palette.isHelp(), '? again closes it');
  press('\\');
  assert.equal(calls.move, 1, '\\ moves the navigation');
  press('/');
  const esc = press('Escape');
  assert.ok(!palette.isOpen() && esc.defaultPrevented, 'Esc closes the palette');
  const none = press('Escape');
  assert.ok(!none.defaultPrevented, 'Esc with nothing open is left to the page');
});

test('clause 2: typing in a field never triggers a shortcut [U94,#6616]', () => {
  const { palette, press, calls } = page();
  for (const key of ['/', '?', '\\', 'g']) press(key, field);
  press('i', field);
  assert.ok(!palette.isOpen() && !palette.isHelp() && calls.move === 0 && calls.go.length === 0, 'nothing happened');
  press('k', field, { metaKey: true });
  assert.ok(palette.isOpen(), 'only Cmd+K works from a field');
  press('g'); press('i');
  assert.deepEqual(calls.go, [], 'and letters typed in the palette are only letters');
});

test('clause 1: the hosted page mounts it with one hook and the palette reads the board in memory, fetching nothing [U94,#6616]', () => {
  const script = paletteScript();
  assert.doesNotThrow(() => new Script(script), 'the mounted script parses');
  assert.ok(script.includes('function pbPalette(env)') && script.includes('pbPalette({'), 'the page script holds the module and mounts it');
  assert.doesNotMatch(script, /\bfetch\(|\bapi\(|XMLHttpRequest/u, 'it makes no request');
  assert.match(script, /data\?\.project\?\.items/u, 'items come from the page\'s board state');
  assert.doesNotMatch(script.replace(/<\/?script/gu, ''), /<\/script/iu, 'it cannot end the page script early');
  const prose = readFileSync(new URL('../../../src/logic/cockpit/prose.js', import.meta.url), 'utf8');
  assert.match(prose, /\$\{historyLoadingScript\(\)\}\$\{paletteScript\(\)\}<\/script>/u, 'the page script ends with the one hook');
  const actions = readFileSync(new URL('../../../src/io/page/actions.js', import.meta.url), 'utf8');
  assert.doesNotMatch(actions, /event\.key !== '\/'/u, 'the old "/" focus handler is gone, so "/" opens the palette only');
});
