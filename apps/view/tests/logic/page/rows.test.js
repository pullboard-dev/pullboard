/** @pullboard-test-input source-tree */
/** The Roadmap patches by row key: rows that did not change keep their DOM nodes, and changed rows show the new values [N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { patchKeyedRows } from '../../../src/logic/page/rows.js';
import { roadmapCardsHtml } from '../../../src/io/roadmap/render.js';

/** A small stand-in for the parts of the DOM the patch uses: li nodes that know their parent, and templates that parse them. */
function fakeDocument() {
  const parse = (html) => {
    const parts = [];
    let last = 0;
    for (const match of html.matchAll(/<li data-slot="([^"]*)"[^>]*>(.*?)<\/li>/gsu)) {
      if (match.index > last) parts.push(html.slice(last, match.index));
      parts.push(node(match[1], match[0]));
      last = match.index + match[0].length;
    }
    if (last < html.length) parts.push(html.slice(last));
    return parts;
  };
  const node = (slot, html) => ({ dataset: { slot }, html, parent: null,
    get parentNode() { return this.parent; },
    replaceWith(next) { const list = this.parent.parts; list[list.indexOf(this)] = next; next.parent = this.parent; this.parent = null; } });
  const template = () => {
    const content = { parts: [], get children() { return this.parts.filter((part) => typeof part !== 'string'); },
      querySelectorAll() { return this.parts.filter((part) => typeof part !== 'string'); } };
    return { content, set innerHTML(html) { content.parts = parse(html); for (const part of content.parts) if (typeof part !== 'string') part.parent = content; } };
  };
  const host = { parts: [], replaceChildren(content) { this.parts = content.parts; for (const part of this.parts) if (typeof part !== 'string') part.parent = this; } };
  return { doc: { createElement: () => template() }, host };
}

const row = (key, text) => '<li data-slot="' + key + '"><div>' + text + '</div></li>';
const slots = (keys) => '<section>' + keys.map((key) => '<li data-slot="' + key + '"></li>').join('') + '</section>';
const draw = (state, keys, texts, note = '', scope = 'board') => patchKeyedRows({ ...state, html: '<h2>' + note + '</h2>' + slots(keys),
  rows: new Map(keys.map((key, n) => [key, row(key, texts[n])])), scope });
const nodesOf = (host) => host.parts.filter((part) => typeof part !== 'string');

test('clause 2: an update replaces only the rows that changed; the rest keep their nodes and a changed row shows its new value [N26]', () => {
  const { doc, host } = fakeDocument();
  let state = draw({ host, doc, nodes: new Map(), drawn: null }, ['a', 'b', 'c'], ['one', 'two', 'three']);
  const first = nodesOf(host);
  assert.equal(first.length, 3, 'every row is drawn the first time');
  state = draw({ host, doc, ...state }, ['a', 'b', 'c'], ['one', 'two, renamed', 'three']);
  const second = nodesOf(host);
  assert.equal(second[0], first[0], 'an unchanged row keeps its node');
  assert.equal(second[2], first[2], 'so does the row after the changed one');
  assert.notEqual(second[1], first[1], 'the changed row is a new node');
  assert.match(second[1].html, /two, renamed/u, 'and shows the new value');
  assert.equal(first[1].parent, null, 'the old node is gone from the page');
  state = draw({ host, doc, ...state }, ['a', 'b', 'c'], ['one', 'two, renamed', 'three']);
  assert.deepEqual(nodesOf(host), second, 'an update that changes nothing keeps every node');
});

test('clause 2: the cards around the rows can change while every row keeps its node, and a row that leaves is dropped [N26]', () => {
  const { doc, host } = fakeDocument();
  let state = draw({ host, doc, nodes: new Map(), drawn: null }, ['a', 'b', 'c'], ['one', 'two', 'three']);
  const first = nodesOf(host);
  state = draw({ host, doc, ...state }, ['a', 'b', 'c'], ['one', 'two', 'three'], 'a new note');
  assert.deepEqual(nodesOf(host), first, 'the card changed and the rows are the nodes they were');
  assert.match(host.parts.join(''), /a new note/u, 'the card shows its new words');
  state = draw({ host, doc, ...state }, ['a', 'c'], ['one', 'three'], 'a new note');
  assert.deepEqual(nodesOf(host), [first[0], first[2]], 'the row that left is gone and the others keep their nodes');
  assert.deepEqual([...state.nodes.keys()], ['a', 'c'], 'its node is not kept');
  const other = draw({ host, doc, ...state }, ['a', 'c'], ['one', 'three'], 'a new note', 'another board');
  assert.notEqual(nodesOf(host)[0], first[0], 'another board starts over');
  assert.equal(other.nodes.size, 2);
});

test('clause 2: the Roadmap hands each row to place by a key that is its release and item, told apart if one repeats [N26]', () => {
  const kept = new Map();
  const slotted = [];
  const reads = [{ milestone: { name: 'Capacity', items: [1, 2] }, done: 0, total: 2, shipped: false,
    rows: [{ label: '#1', state: 'open', stage: 'open', why: 'one', word: 'x' }, { label: '#1', state: 'open', stage: 'open', why: 'again', word: 'x' }] }];
  const html = roadmapCardsHtml(reads, { root: '/r', slotKey: (milestone, rowRead) => { const key = JSON.stringify([milestone.name, rowRead.label]) + (slotted.length ? 2 : ''); slotted.push(key); return key; },
    place: (key, markup) => { kept.set(key, markup); return '<li data-slot="' + key.replaceAll('"', '&quot;') + '"></li>'; } });
  assert.equal(kept.size, 2, 'each row is handed over once');
  assert.ok([...kept.values()].every((markup) => markup.startsWith('<li data-slot="') && markup.includes('milestone-item')), 'a handed row is its whole li, marked with its key');
  assert.equal((html.match(/<li data-slot="[^"]*"><\/li>/gu) || []).length, 2, 'the cards hold an empty slot for each row');
  assert.doesNotMatch(html, /milestone-item/u, 'and none of the rows themselves');
});
