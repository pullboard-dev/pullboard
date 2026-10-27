/**
 * The README's figures (I10): the README links each one, each is committed exactly as
 * docs/img/draw.mjs draws it, each carries its own light and dark colors on a card that holds its
 * text, and the lifecycle is drawn from the declaration itself (M1), refusing what it cannot place.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { FIGURES, drawLifecycle } from '../docs/img/draw.mjs';
import { themeVariants } from '../docs/img/theme.mjs';
import { HELP, commandPhrases } from '../src/help.js';
import { MACHINE } from '../src/machine.js';
import { agentsBlock } from '../src/templates.js';
import { createE2eHelpers } from './e2e-helpers.js';

const ROOT = resolve(import.meta.dirname, '..');
const e2e = createE2eHelpers();
after(e2e.cleanup);
const README = readFileSync(join(ROOT, 'README.md'), 'utf8');
const CONTRIBUTING = readFileSync(join(ROOT, 'CONTRIBUTING.md'), 'utf8');
const drawn = Object.keys(FIGURES).map((name) => `docs/img/${name}.svg`).sort();
const SHOT_FIGURES = [
  { path: 'docs/shots/tour.svg', alt: 'The timed Pullboard tour shows a change submitted, rejected for a missed edge, fixed and accepted.' },
  { path: 'docs/shots/desktop-light.png', alt: "The desktop board shows open, claimed, submitted and accepted work, a Needs you row for a held lane, search in the top bar, the status bar, an accepted item's review history, and a stats line with merged work, sent-back share and the bottleneck recommendation." },
];

test('CONTRIBUTING explains issue clarification and the seven-day reply aim [I1]', () => {
  assert.match(CONTRIBUTING, /^## Issues and pull requests$/mu, 'the contribution section is present');
  assert.match(CONTRIBUTING, /- `clarify`: closes after 14 days without a reply\. Reply to reopen\./u, 'the clarify rule says when issues close and how to reopen them');
  assert.match(CONTRIBUTING, /- Confirmed issues move to our board and close; the changelog may acknowledge them\./u, 'the brief keeps the confirmed-issue closing sentence exact');
  assert.match(CONTRIBUTING, /1\. \*\*We aim to reply within 7 days\.\*\*/u, 'the first reply step has the new seven-day aim');
});

/**
 * The dark file a README picture pairs with its light file: a PNG's `-light` becomes `-dark`, and an SVG gains `-dark`.
 *
 * @param {string} light the light file's path under the repo
 * @returns {string} the dark file's path
 */
function darkTwin(light) {
  return light.endsWith('-light.png') ? light.replace(/-light\.png$/u, '-dark.png') : light.replace(/\.svg$/u, '-dark.svg');
}

/**
 * The markup a README figure uses: a picture whose dark source GitHub shows to dark readers, then the light image.
 *
 * @param {string} light the light file's path under the repo
 * @param {string} alt the figure's alt text, as the README writes it
 * @returns {string} the picture markup, exactly as the README holds it
 */
function figureMarkup(light, alt) {
  return `<picture>\n  <source media="(prefers-color-scheme: dark)" srcset="${darkTwin(light)}">\n  <img src="${light}" alt="${alt}">\n</picture>`;
}

/**
 * Every local image the README shows: its light file, the dark file its picture gives (null when none),
 * and its alt text. Pictures come first, then images written as plain Markdown, which have no dark file.
 *
 * @param {string} markdown the README text
 * @returns {{ light: string, dark: string | null, alt: string }[]}
 */
function localImages(markdown) {
  const pictures = [...markdown.matchAll(/<picture>([\s\S]*?)<\/picture>/gu)].map(([, body]) => {
    const img = /<img\b[^>]*>/u.exec(body)?.[0] ?? '';
    return {
      light: /\ssrc="([^"]+)"/u.exec(img)?.[1] ?? '',
      dark: /<source\b[^>]*media="\(prefers-color-scheme: dark\)"[^>]*srcset="([^"]+)"/u.exec(body)?.[1] ?? null,
      alt: /\salt="([^"]*)"/u.exec(img)?.[1] ?? '',
    };
  });
  const bare = [...markdown.replace(/<picture>[\s\S]*?<\/picture>/gu, '').matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/gu)].map(([, alt, light]) => ({ light, dark: null, alt }));
  return [...pictures, ...bare].filter(({ light }) => light.startsWith('docs/'));
}

test("Pullboard's doctrine carries its four checks [D1,D3]", () => {
  const box = e2e.project();
  const checkout = join(box.dir, 'doctrine-checkout');
  box.git(box.dir, 'clone', '--shared', ROOT, checkout);
  writeFileSync(join(checkout, 'DOCTRINE.md'), readFileSync(join(ROOT, 'DOCTRINE.md'), 'utf8'));
  box.git(checkout, 'add', 'DOCTRINE.md');
  const staged = box.tryGit(checkout, 'diff', '--cached', '--quiet');
  assert.ok(staged.status === 0 || staged.status === 1, staged.stderr);
  if (staged.status === 1) box.git(checkout, 'commit', '-q', '-m', 'docs: exercise doctrine checks [D1,D3]');

  const spec = box.run(checkout, 'spec', 'check');
  assert.equal(spec.code, 0, spec.out + spec.err);
  const report = box.run(checkout, 'doctrine', 'check');
  assert.equal(report.code, 0, report.err);
  const lines = report.out.trim().split(/\r?\n/u);
  assert.equal(lines.length, 4, 'doctrine check prints exactly four Rigor rules');
  assert.deepEqual(lines.map((line) => line.slice(0, line.indexOf(' '))), ['C9', 'C8', 'T5', 'T6']);
  for (const line of lines) {
    const result = / · (\d+), was (\d+) · holding$/u.exec(line);
    assert.ok(result, `${line} is holding at a committed count`);
    assert.ok(Number(result[1]) <= Number(result[2]), `${line} stays at or below its committed count`);
  }
});

/** Average glyph width, in ems, generous enough for the widest system font each figure may get. */
const EM = { sans: 0.56, mono: 0.62 };
const SIZE = { head: 14, t1: 14, t2: 12, label: 12, aside: 12, code: 11.5 };

/** Count reader-facing words, ignoring Markdown punctuation. */
function wordCount(text) {
  return text.match(/[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

test('README has the approved centered header, logo and one-line facts [I10,I12]', () => {
  assert.match(README, /^<p align="center">\n  <picture>\n    <source media="\(prefers-color-scheme: dark\)" srcset="docs\/img\/logo-dark\.svg">\n    <img src="docs\/img\/logo\.svg" alt="" width="72">\n  <\/picture>\n<\/p>\n\n<h1 align="center">Pullboard<\/h1>/u);
  assert.match(README, /<p align="center"><a href="https:\/\/pullboard\.dev"><b>pullboard\.dev<\/b><\/a> · lives in your git repo · no dependencies · <b>Walk away, and it builds\.<\/b><\/p>/u, 'the centered header pins the product facts and the tagline in one line');
  for (const badge of ['pullboard', 'npm', 'MIT license']) assert.match(README, new RegExp(`alt="${badge}(?:: [^"]+)?"`), `${badge} badge remains in the header`);
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
  const links = localImages(README).filter(({ light }) => light.startsWith('docs/img/') && light.endsWith('.svg') && light !== 'docs/img/logo.svg').map(({ alt, light }) => ({ alt, path: light }));
  assert.deepEqual(links.map((link) => link.path).sort(), drawn, 'the README links each drawn figure once, and nothing else under docs/img');
  for (const { alt, path } of links) assert.ok(alt.trim().length >= 40, `${path} has alt text that says what it shows`);
  assert.ok(README.includes(figureMarkup('docs/img/chain.svg', 'An agent asks its coordinator. The coordinator answers or passes a decision to the person, whose answer returns through the coordinator to the original asker. Agents send decision requests to their coordinator first.')), 'the chain figure says decision requests go through the coordinator');
  for (const { alt, path } of SHOT_FIGURES) assert.ok(README.includes(figureMarkup(path, alt)), `${path} and its alt text remain in the README`);
  const committed = readdirSync(join(ROOT, 'docs', 'img')).filter((file) => file.endsWith('.svg') && !file.endsWith('-dark.svg') && file !== 'logo.svg').map((file) => `docs/img/${file}`).sort();
  assert.deepEqual(committed, drawn, 'docs/img holds exactly the figures draw.mjs draws');
  for (const [name, draw] of Object.entries(FIGURES)) {
    const { light, dark } = themeVariants(draw());
    assert.ok(readFileSync(join(ROOT, 'docs', 'img', `${name}.svg`), 'utf8') === light, `docs/img/${name}.svg differs from what draw.mjs draws: run node docs/img/draw.mjs`);
    assert.ok(readFileSync(join(ROOT, 'docs', 'img', `${name}-dark.svg`), 'utf8') === dark, `docs/img/${name}-dark.svg differs from what draw.mjs draws: run node docs/img/draw.mjs`);
  }
});

test('every local README image has a dark file that a picture gives the reader, and both files exist [I10,I11,I13]', () => {
  const images = localImages(README);
  assert.ok(images.length >= 15, `the README shows ${images.length} local images; expected at least the 15 pictures`);
  for (const { light, dark } of images) {
    assert.ok(dark, `${light} is inside a picture with a dark source, so it follows the reader's theme; an image with one theme fails here`);
    assert.equal(dark, darkTwin(light), `${light} pairs with ${darkTwin(light)}`);
    assert.ok(existsSync(join(ROOT, light)), `${light} is committed`);
    assert.ok(existsSync(join(ROOT, dark)), `${dark} is committed`);
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
  const unsupported = { ...MACHINE, moves: [...MACHINE.moves, { verb: 'restore', from: ['withdrawn'], to: 'open', by: ['coordinator'], guards: [] }] };
  assert.throws(() => drawLifecycle(unsupported), /no route for withdrawn > open/);
  const reopen = { ...MACHINE,
    states: MACHINE.states.map((state) => state.id === 'verified' ? { ...state, final: false } : state),
    // Give this fixture one synthetic verified return even when the real declaration adds others.
    // The original label geometry and collision assertions below still exercise that route.
    moves: [...MACHINE.moves.map((move) => move.to === 'open'
      ? { ...move, from: move.from.filter((state) => state !== 'verified') } : move).filter((move) => move.from.length),
    { verb: 'reopen', from: ['verified'], to: 'open', by: ['coordinator'], guards: [] }],
  };
  let reopenedSvg;
  assert.doesNotThrow(() => { reopenedSvg = drawLifecycle(reopen); }, 'the synthetic verified reopen has a declared drawing route');
  assert.ok(texts(reopenedSvg).some((text) => text.words === 'reopen'), 'the synthetic verified reopen is named');
  assert.ok(reopenedSvg.includes('class="edge back" d="M 815 179 L 830 179 L 830 8 L 15 8 L 15 179 L 25 179" marker-end="url(#tip-back)"'),
    'verified-to-open uses the dashed return route');
  const reopenTexts = texts(reopenedSvg);
  const reopenLabel = reopenTexts.find((text) => text.words === 'reopen');
  assert.ok(reopenLabel, 'the synthetic reopen label has a measurable text box');
  for (const other of reopenTexts.filter((text) => text !== reopenLabel)) {
    const separated = reopenLabel.right <= other.left || other.right <= reopenLabel.left || reopenLabel.bottom <= other.top || other.bottom <= reopenLabel.top;
    assert.ok(separated, `the reopen label does not overlap “${other.words}”`);
  }
  const drawing = reopenedSvg.slice(reopenedSvg.indexOf('</defs>') + '</defs>'.length);
  for (const [, x, y, width, height] of drawing.matchAll(/<rect(?! class="card")\b[^>]*\bx="([\d.]+)"\s+y="([\d.]+)"\s+width="([\d.]+)"\s+height="([\d.]+)"/gu)) {
    const box = { left: Number(x), right: Number(x) + Number(width), top: Number(y), bottom: Number(y) + Number(height) };
    const separated = reopenLabel.right <= box.left || box.right <= reopenLabel.left || reopenLabel.bottom <= box.top || box.bottom <= reopenLabel.top;
    assert.ok(separated, `the reopen label does not overlap the box at ${x},${y}`);
  }
  for (const [, path] of drawing.matchAll(/<path\b[^>]*\bd="([^"]+)"/gu)) {
    const points = [...path.matchAll(/[ML]\s*([\d.]+)\s+([\d.]+)/gu)].map(([, x, y]) => ({ x: Number(x), y: Number(y) }));
    for (let index = 1; index < points.length; index++) {
      const first = points[index - 1];
      const second = points[index];
      const segment = { left: Math.min(first.x, second.x), right: Math.max(first.x, second.x), top: Math.min(first.y, second.y), bottom: Math.max(first.y, second.y) };
      const separated = reopenLabel.right <= segment.left || segment.right <= reopenLabel.left || reopenLabel.bottom <= segment.top || segment.bottom <= reopenLabel.top;
      assert.ok(separated, `the reopen label does not overlap path segment ${index}: ${path}`);
    }
  }
  const bench = { ...MACHINE, moves: [...MACHINE.moves, { verb: 'bench', from: ['claimed'], to: 'open', by: ['coordinator'], guards: [] }] };
  assert.match(texts(drawLifecycle(bench)).map((text) => text.words).join(' '), /\bbench\b/, 'a new move between drawn states is named without touching draw.mjs');
});

test('the lifecycle figure keeps the guards into a state that is not final [I10, M1]', () => {
  const fixture = {
    ...MACHINE,
    states: MACHINE.states.map((state) => state.id === 'verified' ? { ...state, final: false } : state),
    moves: [...MACHINE.moves, { verb: 'reopen', from: ['verified'], to: 'open', by: ['coordinator'], guards: [] }],
  };
  const svg = drawLifecycle(fixture);
  const shown = texts(svg).map((text) => text.words).join(' \n ');
  assert.ok(shown.includes('every way into verified'), 'the non-final guarded state has its entry note');
  for (const guard of MACHINE.exitGuards.verified) {
    assert.ok(shown.includes(MACHINE.guards.find((each) => each.id === guard).refuse), `the non-final verified note includes refusal ${guard}`);
  }
  assert.match(shown, /\breopen\b/, 'the verified-to-open move remains visible');
  assert.ok(shown.includes('starts open; ends withdrawn'), 'the caption names only the declared final state');
  assert.equal(svg.includes('data-final="verified"'), false, 'verified is not marked final in the fixture');
});

test('README pins its approved Philosophy, Key concepts and Why structure [I10,I12]', () => {
  const philosophy = README.indexOf('## Philosophy');
  const concepts = README.indexOf('### Key concepts', philosophy);
  const whyStart = README.indexOf('### Why', concepts);
  const nextTopLevel = README.indexOf('\n## ', philosophy + 1);
  assert.ok(philosophy >= 0 && philosophy < concepts && concepts < whyStart && whyStart < nextTopLevel, 'Philosophy contains Key concepts and Why before the next top-level section');
  const approvedOpening = 'Pullboard keeps agents building **true to your intent**, with a second agent checking every change. Your judgement carries across every agent and every session, so a complex project stays coherent for months. It\'s a coordination queue for serious software: you decide what matters once, and many agents build, check and land the work.';
  const openingWithFigure = `${approvedOpening}\n\n${figureMarkup('docs/img/holds.svg', 'How it holds. Your decision becomes a bar each piece of work is frozen against; a second agent checks the exact commit; the board keeps what passed, what failed and why; the next agent starts from there.')}\n\n**Vibe code a real product.**`;
  assert.ok(README.includes(openingWithFigure), 'the approved opening, then the holds figure, then the lead');
  assert.equal(README.split(approvedOpening).length - 1, 1, 'the approved opening appears exactly once');
  assert.doesNotMatch(`${approvedOpening} ${FIGURES.holds()}`, /\b(?:memory|remember)\b/iu, 'the opening and its figure avoid those terms');
  const section = README.slice(philosophy, nextTopLevel);
  assert.ok(section.includes('### Why\n\nPast the demo, the same things break.\n\n<picture>\n  <source media="(prefers-color-scheme: dark)" srcset="docs/img/why-dark.svg">\n  <img src="docs/img/why.svg" alt="Where vibe coding breaks, and what holds instead.'), 'Why opens with the approved line, then the figure of what breaks and what holds');
  for (const text of [
    'You do not explain twice. You rule the agents. Hierarchy is enforced. Judgement is yours. Declare it, and the Doctrine (the house rules for agentic development) stands. **You speak the constraints, agents fill in the blanks.** The Spec is canon. Then code. Then proof.',
    'Five primitives. Everything else is built on them.',
    '**Items.**', '**Shouts.**', '**Spec.**', '**Doctrine.**', '**Activity.**',
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

test("the README's worktree command names a model [I1]", () => {
  const shellBlocks = [...README.matchAll(/```(?:sh|shell|bash)\n([\s\S]*?)```/gu)].map(([, body]) => body);
  const commandPattern = /\bpullboard\s+(?:worktree|join)\s+[^\s;&|`]+[^\r\n`]*/gu;
  const commands = [
    ...shellBlocks.flatMap((body) => [...body.matchAll(commandPattern)].map(([command]) => command.trim())),
    ...[...README.matchAll(/`([^`\r\n]+)`/gu)].flatMap(([, inline]) => [...inline.matchAll(commandPattern)].map(([command]) => command.trim())),
  ];
  assert.ok(commands.length > 0, 'the README includes a runnable worktree or join example');
  for (const command of commands) {
    assert.match(command, /(?:^|\s)--model(?:\s|$)/u, `${command} names the model explicitly`);
  }
});

test('the README starts setup with your agent [I1]', () => {
  const start = README.indexOf('### Project setup\n');
  const end = README.indexOf('\n### Manual workflow\n', start);
  assert.ok(start >= 0 && end > start, 'the setup section precedes the manual workflow');
  const setup = README.slice(start, end);
  const prompt = "Install Pullboard and set it up here; it's for <what you are building>.";
  const promptAt = setup.indexOf(prompt);
  const commands = '```sh\npullboard init\ngit add -A && git commit -m "chore(repo): set up pullboard"\n```';
  const commandsAt = setup.indexOf(commands);
  assert.ok(promptAt >= 0 && commandsAt > promptAt, 'the agent instruction comes before the unchanged manual commands');
  assert.ok(setup.includes('Your agent installs Pullboard, runs `pullboard init` and commits the setup.'), 'the agent does the setup work');
  assert.ok(setup.includes('You approve your requirements and answer its questions.'), 'the person supplies decisions');
  assert.ok(setup.includes('in the view it opens'), 'the agent opens the view for those decisions');
  assert.ok(setup.includes(figureMarkup('docs/img/agent-start.svg', "Starting with an agent. You ask your agent to install Pullboard and set it up for what you're building. It runs the install and pullboard init, commits the setup, then walks you through your requirements and questions in the view it opens for you.")), 'the figure describes the complete agent path');
  assert.ok(setup.indexOf('You can also run it yourself.') > promptAt, 'running setup yourself is the second path');
  assert.ok(setup.includes('`init` writes your spec, doctrine and agent instructions, and installs the hooks and the board. Commit what it wrote, then open Claude Code in the repo and say what to build. That agent becomes your coordinator.'), 'the manual explanation remains unchanged');
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
    } else if (opening === '<picture>') {
      const img = lines.slice(next, next + 4).find((line) => line.includes('<img')) ?? '';
      assert.match(img, /\salt="[^"]+[.!?]"/u, `${proseLines[index]} opens with a descriptive figure`);
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
  let inPicture = false;
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
    } else if (!inCode && line === '<picture>') {
      flush();
      inPicture = true;
    } else if (inPicture) {
      if (line === '</picture>') inPicture = false;
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

test('the README shows a demo Roadmap with an expanded item in both themes [I10,I13]', () => {
  const light = 'docs/img/roadmap-light.png', dark = 'docs/img/roadmap-dark.png';
  for (const name of [light, dark]) {
    const png = readFileSync(join(ROOT, name));
    assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), name + ' is a real PNG screenshot');
  }
  const picture = [...README.matchAll(/<picture>[\s\S]*?<\/picture>/gu)].map(match => match[0])
    .find(block => block.includes(light) && block.includes(dark));
  assert.ok(picture, 'one picture references both Roadmap screenshots');
  const darkSource = [...picture.matchAll(/<source\b[^>]*>/gu)].map(match => match[0]).find(tag => tag.includes(dark));
  assert.match(darkSource ?? '', /media="\(prefers-color-scheme:\s*dark\)"/u, 'the dark image follows the reader theme');
  assert.match(picture, /<img\b[^>]*src="docs\/img\/roadmap-light\.png"/u, 'light is the fallback image');
  const alt = /<img\b[^>]*alt="([^"]+)"/u.exec(picture)?.[1] ?? '';
  for (const word of ['demo', 'roadmap', 'expanded', 'criterion', 'agents', 'history', 'release']) {
    assert.ok(alt.toLowerCase().includes(word), 'alt text describes ' + word);
  }
  assert.ok(README.indexOf(picture) < README.indexOf('The full plan lives in the Roadmap tab'),
    'the picture sits beside the Roadmap explanation');
});

test("what's next lists only unbuilt work [I11]", () => {
  const spec = readFileSync(join(ROOT, 'SPEC.md'), 'utf8');
  const sectionStart = README.indexOf("### What's next\n");
  assert.notEqual(sectionStart, -1, "the README replaces 'Planned features' with What's next");
  const sectionEnd = README.indexOf('\n### Docs\n', sectionStart);
  assert.notEqual(sectionEnd, -1, "What's next ends before the Docs section");
  const section = README.slice(sectionStart, sectionEnd);
  const lines = section.split(/\r?\n/u).slice(1).map((line) => line.trim()).filter(Boolean);
  const bullets = lines.filter((line) => line.startsWith('- '));
  assert.ok(bullets.length > 0, "What's next contains cited work");

  const specRows = new Set([...spec.matchAll(/^- ([A-Za-z]+\d+(?:\.\d+)*) \[/gmu)].map(([, id]) => id));
  for (const bullet of bullets) {
    const citations = [...bullet.matchAll(/\[([^\]]+)\]/gu)];
    assert.ok(citations.length > 0, `each bullet cites a SPEC row: ${bullet}`);
    for (const [, group] of citations) {
      for (const id of group.split(/,\s*/u)) assert.ok(specRows.has(id), `${bullet} cites existing row ${id}`);
    }
  }

  assert.doesNotMatch(bullets.join('\n'), /\b(?:relay|roadmap)\b/iu, 'shipped relay and roadmap work do not remain in the upcoming bullets');
  assert.equal(lines.at(-1), 'The full plan lives in the Roadmap tab in Pullboard View and `pullboard roadmap`.', 'the section ends by pointing to the full plan');
});

test('every command in help is taught to agents [I11]', () => {
  const skillFiles = readdirSync(join(ROOT, 'skills'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(ROOT, 'skills', entry.name, 'SKILL.md'));
  const instructionLines = `${skillFiles.map((file) => readFileSync(file, 'utf8')).join('\n')}\n${agentsBlock()}`.split(/\r?\n/u);
  const phrases = new Set(commandPhrases({ all: HELP.all, commands: {} }));
  for (const declaration of Object.values(HELP.commands)) {
    for (const usage of declaration.usages) {
      for (const phrase of commandPhrases({ all: `  ${usage}`, commands: {} })) phrases.add(phrase);
    }
  }
  const personOnly = new Map([
    ['spec approve', 'Only the person approves a SPEC row.'],
    ['intake approve', 'Only the owner approves an outside commit that touches a sensitive path.'],
    ['spec decline', 'Only the person declines a SPEC row.'],
    ['relay recover', 'The command is explicitly reserved for person-only recovery.'],
  ]);
  assert.ok(personOnly.size <= 4, 'the person-only exception list stays short');
  for (const [phrase, reason] of personOnly) {
    assert.ok(phrases.has(phrase), `${phrase} is still a command in help`);
    assert.ok(reason.trim(), `${phrase} has a reason agents must not run it`);
  }
  const untaught = [...phrases].filter((phrase) => {
    const command = phrase.split(' ').map((word) => word.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('\\s+');
    const taught = instructionLines.some((line) => new RegExp(`(?:^|[^A-Za-z0-9_-])pullboard\\s+${command}(?=$|[^A-Za-z0-9_-])`, 'u').test(line));
    return !taught && !personOnly.has(phrase);
  });
  assert.deepEqual(untaught, [], `teach each command where agents need it, or explain a person-only exception:\n${untaught.join('\n')}`);
});
