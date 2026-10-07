/**
 * The README's figures (I10): the README links each one, each is committed exactly as
 * docs/img/draw.mjs draws it, each carries its own light and dark colors on a card that holds its
 * text, and the lifecycle is drawn from the declaration itself (M1), refusing what it cannot place.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { FIGURES, drawLifecycle } from '../docs/img/draw.mjs';
import { MACHINE } from '../src/machine.js';

const ROOT = resolve(import.meta.dirname, '..');
const README = readFileSync(join(ROOT, 'README.md'), 'utf8');
const drawn = Object.keys(FIGURES).map((name) => `docs/img/${name}.svg`).sort();

/** Average glyph width, in ems, generous enough for the widest system font each figure may get. */
const EM = { sans: 0.56, mono: 0.62 };
const SIZE = { head: 14, t1: 14, t2: 12, label: 12, aside: 12, code: 11.5 };

/**
 * Every text in a figure with the box it may take up, from its anchor, font size and length.
 *
 * @param {string} svg
 */
function texts(svg) {
  return [...svg.matchAll(/<text class="([^"]+)" x="([\d.]+)" y="([\d.]+)"(?: text-anchor="(\w+)")?>([^<]*)<\/text>/g)].map(([, cls, x, y, anchor, words]) => {
    const classes = cls.split(' ');
    const size = Math.max(...classes.map((name) => SIZE[name] ?? 0));
    const plain = words.replaceAll(/&(amp|lt|gt|quot);/g, '.');
    const width = plain.length * size * (classes.includes('mono') ? EM.mono : EM.sans);
    const left = Number(x) - (anchor === 'middle' ? width / 2 : anchor === 'end' ? width : 0);
    return { words: plain, left, right: left + width, top: Number(y) - size, bottom: Number(y) + 4 };
  });
}

/**
 * The tags left open, or closed out of order, in an XML text: empty when it is well formed.
 *
 * @param {string} xml
 * @returns {string[]}
 */
function unbalanced(xml) {
  const open = [];
  const wrong = [];
  for (const [, closing, name, selfClosing] of xml.matchAll(/<(\/?)([a-zA-Z][\w:-]*)\b[^>]*?(\/?)>/g)) {
    if (selfClosing) continue;
    if (!closing) open.push(name);
    else if (open.pop() !== name) wrong.push(`</${name}>`);
  }
  return [...wrong, ...open.map((name) => `<${name}>`)];
}

test('the README links every figure draw.mjs draws, each committed exactly as drawn [I10]', () => {
  const links = [...README.matchAll(/!\[([^\]]*)\]\((docs\/img\/[^)\s]+)\)/g)].map(([, alt, path]) => ({ alt, path }));
  assert.deepEqual(links.map((link) => link.path).sort(), drawn, 'the README links each drawn figure once, and nothing else under docs/img');
  for (const { alt, path } of links) assert.ok(alt.trim().length >= 40, `${path} has alt text that says what it shows`);
  const committed = readdirSync(join(ROOT, 'docs', 'img')).filter((file) => file.endsWith('.svg')).map((file) => `docs/img/${file}`).sort();
  assert.deepEqual(committed, drawn, 'docs/img holds exactly the figures draw.mjs draws');
  for (const [name, draw] of Object.entries(FIGURES)) {
    assert.ok(readFileSync(join(ROOT, 'docs', 'img', `${name}.svg`), 'utf8') === draw(), `docs/img/${name}.svg differs from what draw.mjs draws: run node docs/img/draw.mjs`);
  }
});

test('each figure carries its own light and dark colors, on a card that holds all its text [I10]', () => {
  for (const [name, draw] of Object.entries(FIGURES)) {
    const svg = draw();
    const [, width, height] = /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 (\d+) (\d+)"[^>]* role="img"/.exec(svg) ?? [];
    assert.ok(width, `${name} is an svg with a viewBox and role="img"`);
    assert.match(svg, /<title id="title">[^<]{3,}<\/title><desc id="desc">[^<]{40,}<\/desc>/, `${name} says what it shows`);
    assert.match(svg, /<style>[^<]*\ntext \{[^}]*fill: #1f2328;[^<]*@media \(prefers-color-scheme: dark\) \{\n {2}text \{ fill: #f0f6fc; \}/, `${name} has light colors and a dark block`);
    assert.ok(svg.includes(`</defs>\n<rect class="card" x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="12"/>`), `${name} draws its card first, over the whole figure`);
    assert.deepEqual(unbalanced(svg), [], `${name} is well formed`);
    const words = texts(svg);
    assert.ok(words.length >= 8, `${name} has its words as text`);
    for (const text of words) {
      assert.ok(text.left >= 8 && text.right <= width - 8 && text.top >= 8 && text.bottom <= height - 8, `${name}: "${text.words}" stays on the card`);
    }
  }
});

test('the lifecycle figure is drawn from the declaration, and refuses a state or a pair it has no place for [I10, M1]', () => {
  const svg = drawLifecycle();
  const shown = texts(svg).map((text) => text.words).join(' \n ');
  for (const state of MACHINE.states) {
    assert.ok(svg.includes(`>${state.id}</text>`), `the state ${state.id} is drawn`);
    assert.equal(svg.includes(`data-final="${state.id}"`), Boolean(state.final), `${state.id} is marked final only if it is`);
  }
  for (const move of MACHINE.moves) assert.match(shown, new RegExp(`\\b${move.verb}\\b`), `the move ${move.verb} is named`);
  for (const [state, guards] of Object.entries(MACHINE.exitGuards)) {
    for (const guard of guards) assert.ok(shown.includes(MACHINE.guards.find((each) => each.id === guard).refuse), `a refusal into ${state}: ${guard}`);
  }
  const parked = { ...MACHINE, states: [...MACHINE.states, { id: 'parked', means: 'set aside', requires: [] }] };
  assert.throws(() => drawLifecycle(parked), /no place for state parked/);
  const reopen = { ...MACHINE, moves: [...MACHINE.moves, { verb: 'reopen', from: ['verified'], to: 'open', by: ['coordinator'], guards: [] }] };
  assert.throws(() => drawLifecycle(reopen), /no route for verified > open/);
  const bench = { ...MACHINE, moves: [...MACHINE.moves, { verb: 'bench', from: ['claimed'], to: 'open', by: ['coordinator'], guards: [] }] };
  assert.match(texts(drawLifecycle(bench)).map((text) => text.words).join(' '), /\bbench\b/, 'a new move between drawn states is named without touching draw.mjs');
});

test('README shows JSON output for spec check and view [S13]', () => {
  assert.match(README, /`pullboard spec check --json`/);
  assert.match(README, /`pullboard spec view --json`/);
  assert.match(README, /\[CLI JSON API\]\(docs\/api\.md\)/);
});

test('README shows the signers field and setup command [S18]', () => {
  assert.match(README, /```markdown\n- R1 \[approved, must\] A release is tested\. \| gate: npm test\n- R2 \[approved, must\] A release is signed\. \| gate: npm test \| signers: alice@workstation, bob@workstation\n```/);
  assert.match(README, /`pullboard spec signers add`/);
});
