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
const SHOT_FIGURES = [
  { path: 'docs/shots/tour.svg', alt: 'The timed Pullboard tour shows a change submitted, rejected for a missed edge, fixed and accepted.' },
  { path: 'docs/shots/desktop.png', alt: "The desktop board shows open, claimed, submitted and accepted work, a Needs you row for a held lane, search in the top bar, the status bar and an accepted item's review history." },
];

/** Average glyph width, in ems, generous enough for the widest system font each figure may get. */
const EM = { sans: 0.56, mono: 0.62 };
const SIZE = { head: 14, t1: 14, t2: 12, label: 12, aside: 12, code: 11.5 };

/** Count reader-facing words, ignoring Markdown punctuation. */
function wordCount(text) {
  return text.match(/[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

test('README has the approved centered header, logo and one-line facts [I10,I12]', () => {
  assert.match(README, /^<p align="center">\n  <picture>\n    <source media="\(prefers-color-scheme: dark\)" srcset="docs\/img\/logo-dark\.svg">\n    <img src="docs\/img\/logo\.svg" alt="" width="72">\n  <\/picture>\n<\/p>\n\n<h1 align="center">Pullboard<\/h1>/u);
  assert.match(README, /<p align="center"><a href="https:\/\/pullboard\.dev"><b>pullboard\.dev<\/b><\/a> · lives in your git repo · no account · no dependencies · never calls a model<\/p>/u, 'the centered header pins the product facts in one line');
  for (const badge of ['gate', 'npm', 'node', 'MIT license']) assert.match(README, new RegExp(`alt="${badge}"`), `${badge} badge remains in the header`);
  assert.ok(readFileSync(join(ROOT, 'docs/img/logo.svg'), 'utf8').startsWith('<svg '), 'the approved light logo is present');
  assert.ok(readFileSync(join(ROOT, 'docs/img/logo-dark.svg'), 'utf8').startsWith('<svg '), 'the approved dark logo is present');
});

test('README names DOCTRINE.md and explains doctrine once [I12]', () => {
  const gloss = 'the house rules for agentic development';
  const layout = FIGURES.layout();
  const firstDoctrine = README.indexOf('Doctrine');
  const firstGloss = README.indexOf(gloss);
  assert.ok(firstDoctrine >= 0, 'the README introduces Doctrine');
  assert.equal(README.slice(firstDoctrine, firstGloss), 'Doctrine (', 'the first doctrine mention carries its gloss');
  assert.equal(README.split(gloss).length - 1, 1, 'the README glosses doctrine once, at its first mention');
  assert.match(README, /`DOCTRINE\.md`/u, 'the README names the current doctrine file');
  assert.doesNotMatch(README, /PRACTICE\.md/u, 'the README uses the current doctrine filename');
  assert.match(layout, /<text class="mono label"[^>]*>DOCTRINE\.md<\/text>/u, 'the location figure names the current doctrine file');
  assert.doesNotMatch(layout, /PRACTICE\.md/u, 'the location figure leaves the legacy filename to migration guidance');
});

test('current docs pages and shipped skills use DOCTRINE.md, reserving PRACTICE.md for history or fallback [I12]', () => {
  /**
   * List the current Markdown contracts recursively so newly added docs and shipped skills join the audit.
   * @param {string} directory
   * @returns {string[]}
   */
  function markdownFiles(directory) {
    return readdirSync(join(ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return markdownFiles(path);
      return entry.isFile() && (entry.name.endsWith('.md') || entry.name === 'SKILL.md') ? [path] : [];
    });
  }

  const files = [...markdownFiles('docs'), ...markdownFiles('skills')].sort();
  assert.ok(files.includes('docs/rfcs/0001-standard-doctrine.md'));
  const specProof = readFileSync(join(ROOT, 'docs/proof/spec.md'), 'utf8');
  assert.match(specProof, /this repo's `DOCTRINE\.md`\. This audit's S6 proof row records the earlier root `PRACTICE\.md`; other repos that still have only `PRACTICE\.md` keep it as a compatibility fallback/u, 'the proof table labels the old filename as historical while preserving its fallback for other repos');
  for (const file of files) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    for (const [index, line] of text.split('\n').entries()) {
      if (!line.includes('PRACTICE.md')) continue;
      if (file === 'docs/proof/spec.md' && line.startsWith('| S')) continue; // historical proof rows follow the page's legacy-fallback introduction
      assert.match(line, /legacy|fallback|histor|at the time/i, `${file}:${index + 1} labels PRACTICE.md as legacy, fallback or history`);
    }
  }

  const rfc = readFileSync(join(ROOT, 'docs/rfcs/0001-standard-doctrine.md'), 'utf8');
  assert.match(rfc, /`DOCTRINE\.md`/u, 'the accepted RFC names the current file');
  assert.match(rfc, /legacy `PRACTICE\.md` remains a compatibility fallback/u, 'the accepted RFC labels the old name only as a fallback');
  assert.match(rfc, /At the time of this RFC, `pullboard init` copied/u, 'the RFC keeps its old filename in clearly historical context');
});

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
  assert.ok(README.includes('![An agent asks its coordinator. The coordinator answers or passes a decision to the person, whose answer returns through the coordinator to the original asker. Agents send decision requests to their coordinator first.](docs/img/chain.svg)'), 'the chain figure says decision requests go through the coordinator');
  for (const { alt, path } of SHOT_FIGURES) assert.ok(README.includes(`![${alt}](${path})`), `${path} and its alt text remain in the README`);
  const committed = readdirSync(join(ROOT, 'docs', 'img')).filter((file) => file.endsWith('.svg') && !['logo.svg', 'logo-dark.svg'].includes(file)).map((file) => `docs/img/${file}`).sort();
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

test('README pins its approved Philosophy, Key concepts and Why structure [I10,I12]', () => {
  const philosophy = README.indexOf('## Philosophy');
  const concepts = README.indexOf('### Key concepts', philosophy);
  const whyStart = README.indexOf('### Why', concepts);
  const nextTopLevel = README.indexOf('\n## ', philosophy + 1);
  assert.ok(philosophy >= 0 && philosophy < concepts && concepts < whyStart && whyStart < nextTopLevel, 'Philosophy contains Key concepts and Why before the next top-level section');
  const section = README.slice(philosophy, nextTopLevel);
  for (const text of [
    'You do not explain twice. You rule the agents. Hierarchy is enforced. Judgement is yours. Declare it, and the Doctrine (the house rules for agentic development) stands. **You speak the constraints, agents fill in the blanks.** The Spec is canon. Then code. Then proof.',
    'Five primitives. Everything else is built on them.',
    '**Items.**', '**Shouts.**', '**Spec.**', '**Doctrine.**', '**Activity.**',
    "**It said done. It wasn't.**", '**It forgot what you decided.**',
    '**Two agents, one file.**', '**A fix broke something.**',
  ]) assert.ok(section.includes(text), `Philosophy keeps ${text}`);
});

test('README has a manual workflow and shell examples without inline comments [I10,I12]', () => {
  assert.match(README, /^### (?:By hand|Manual workflow)$/mu);
  const shellBlocks = [...README.matchAll(/```(?:sh|shell|bash)\n([\s\S]*?)```/gu)].map(([, body]) => body);
  assert.ok(shellBlocks.length > 0, 'the README includes shell examples');
  for (const [index, block] of shellBlocks.entries()) {
    assert.doesNotMatch(block, /(?:^|\s)#(?:\s|$)/mu, `shell example ${index + 1} has no inline comment`);
  }
  for (const command of ['pullboard tour', 'pullboard init', 'pullboard add web', 'pullboard worktree web', 'pullboard next --verify', 'pullboard verify 1 accept']) {
    assert.ok(README.includes(command), `the working workflow still shows ${command}`);
  }
});

test('README is concise and skimmable without removing its instructions or figures [I10,I12]', () => {
  const lines = README.split(/\r?\n/u);
  let insideFence = false;
  const proseLines = lines.map((line) => {
    if (line.startsWith('```')) {
      insideFence = !insideFence;
      return '';
    }
    return insideFence ? '' : line;
  });
  const firstSection = proseLines.findIndex((line) => /^##\s/u.test(line));
  assert.ok(firstSection > 0, 'the README has a section after its lead');

  const headings = proseLines.filter((line) => /^#{1,6}\s/u.test(line)).map((line) => line.replace(/^#{1,6}\s+/u, '').trim().toLocaleLowerCase());
  assert.equal(new Set(headings).size, headings.length, 'headings are unique');

  for (let index = 0; index < proseLines.length; index += 1) {
    const heading = /^(#{1,6})\s/u.exec(proseLines[index]);
    if (!heading) continue;
    let next = index + 1;
    while (next < lines.length && !lines[next].trim()) next += 1;
    assert.ok(next < proseLines.length, `${proseLines[index]} has an opening element`);
    const opening = lines[next];
    const nestedHeading = /^(#{1,6})\s/u.exec(opening);
    if (nestedHeading) {
      assert.ok(nestedHeading[1].length > heading[1].length, `${proseLines[index]} only opens with a nested heading`);
    } else if (opening.startsWith('![')) {
      assert.match(opening, /^!\[[^\]]+[.!?]\]\(/u, `${proseLines[index]} opens with a descriptive figure`);
    } else if (opening.startsWith('```')) {
      assert.match(opening, /^```(?:sh|shell|bash)$/u, `${proseLines[index]} opens with a runnable shell example`);
      assert.ok(lines[next + 1]?.trim(), `${proseLines[index]} shell example has a command`);
    } else if (opening.startsWith('[')) {
      assert.match(opening, /\]\(docs\/[^)]+\)/u, `${proseLines[index]} opens with document links`);
    } else if (opening.endsWith(':')) {
      const following = lines.slice(next + 1).find((line) => line.trim());
      assert.match(following ?? '', /^```/u, `${proseLines[index]} introduces a code example`);
    } else {
      assert.match(opening.replace(/\*+$/u, ''), /[.!?]$/u, `${proseLines[index]} opens with its point`);
    }
  }

  const paragraphs = [];
  let paragraph = [];
  let inCode = false;
  let inCenteredHeader = false;
  const flush = () => {
    if (paragraph.length) paragraphs.push(paragraph.join(' '));
    paragraph = [];
  };
  for (const line of lines) {
    if (line.startsWith('```')) {
      flush();
      inCode = !inCode;
    } else if (line === '<p align="center">') {
      flush();
      inCenteredHeader = true;
    } else if (inCenteredHeader) {
      if (line === '</p>') inCenteredHeader = false;
    } else if (inCode || !line.trim() || /^#{1,6}\s|^!\[|^\|/u.test(line)) {
      flush();
    } else if (/^\s*[-*]\s/u.test(line)) {
      flush();
      paragraphs.push(line.replace(/^\s*[-*]\s+/u, ''));
    } else {
      paragraph.push(line);
    }
  }
  flush();
  for (const text of paragraphs) assert.ok(wordCount(text) <= 70, `paragraph has ${wordCount(text)} words: ${text}`);

  for (let index = 0; index < proseLines.length - 1; index += 1) {
    if (!/^\|/u.test(proseLines[index]) || !/^\|\s*:?-{3,}/u.test(proseLines[index + 1])) continue;
    const cells = proseLines[index].replace(/^\||\|$/gu, '').split('|').map((cell) => cell.trim());
    assert.ok(cells.length > 0 && cells.every(Boolean), 'tables have no empty header cells');
  }
});
