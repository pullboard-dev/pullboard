/**
 * The README's screenshots and timed tour recording (I11, I13) are reproducible demo artifacts,
 * and fit the size budgets so they stay useful in the README and the site.
 */
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { evaluationValue } from './devtools-evaluation.mjs';
import { renderTour } from './tour-renderer.mjs';

const ROOT = new URL('../../', import.meta.url);
const README = readFileSync(new URL('README.md', ROOT), 'utf8');
const files = ['desktop.png', 'phone.png', 'tour.svg'];
const shots = (name) => new URL(`docs/shots/${name}`, ROOT);

/** Assert that an image is embedded in a named README section with useful alt text. */
function linkedInSection(section, file, phrases) {
  const start = README.indexOf(`## ${section}`);
  assert.notEqual(start, -1, `README has the ${section} section`);
  const next = README.indexOf('\n## ', start + 1);
  const body = README.slice(start, next < 0 ? undefined : next);
  const match = new RegExp(`!\\[([^\\]]+)\\]\\(docs/shots/${file.replace('.', '\\.')}\\)`).exec(body);
  assert.ok(match, `${file} is embedded in ${section}`);
  for (const phrase of phrases) assert.ok(match[1].toLowerCase().includes(phrase), `${file} alt text says ${phrase}`);
}

test('the README links the desktop board and timed tour with descriptive alt text [I11,I13]', () => {
  linkedInSection('See every project at once', 'desktop.png', ['open', 'claimed', 'submitted', 'accepted']);
  linkedInSection('Try it', 'tour.svg', ['submitted', 'rejected', 'fixed', 'accepted']);
});

test('the demo assets exist and stay within their size budgets [I11,I13]', () => {
  for (const name of files) assert.ok(statSync(shots(name)).size > 0, `${name} exists`);
  assert.ok(statSync(shots('desktop.png')).size < 300_000, 'desktop PNG is under 300 KB');
  assert.ok(statSync(shots('phone.png')).size < 300_000, 'phone PNG is under 300 KB');
  assert.ok(statSync(shots('tour.svg')).size < 200_000, 'tour SVG is under 200 KB');
  const tour = readFileSync(shots('tour.svg'), 'utf8');
  assert.match(tour, /animation:light-step 16s linear infinite/, 'the SVG carries its own timed animation');
  assert.doesNotMatch(tour, /[\x00-\x08\x0b-\x1f]/, 'tour SVG contains no XML-invalid control characters');
});

test('the demo rebuild script uses a temporary repo and isolated home [I11,I13]', () => {
  const script = readFileSync(shots('demo.mjs'), 'utf8');
  assert.match(script, /mkdtemp\(join\(tmpdir\(\)/);
  assert.match(script, /, HOME: home, PULLBOARD_HOME: home/);
  assert.match(script, /process\.execPath, \[BIN, 'init'\]/);
});

test('a Chrome evaluation exception fails the screenshot capture [I11,I13]', () => {
  assert.equal(evaluationValue({ result: { value: 'ready' } }), 'ready');
  assert.throws(() => evaluationValue({ exceptionDetails: { text: 'Uncaught SyntaxError' } }), /Chrome evaluation failed: Uncaught SyntaxError/);
});

/** Decode the real transcript kept inside the card, with XML entities decoded only once. */
function capturedTour() {
  const svg = readFileSync(shots('tour.svg'), 'utf8');
  const metadata = /<metadata id="tour-transcript">([\s\S]*?)<\/metadata>/.exec(svg);
  assert.ok(metadata, 'the card keeps its actual recorded tour for reproducible rendering');
  return JSON.parse(metadata[1].replaceAll('&apos;', "'").replaceAll('&quot;', '"').replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&'));
}

/** Check the committed image as well as a fresh rendering of its real tour output. */
function cards() {
  return [readFileSync(shots('tour.svg'), 'utf8'), renderTour(capturedTour())];
}

test('the compact tour card holds eight ordered, single-line steps and both verdict tags [I13]', () => {
  for (const svg of cards()) {
    const [, width, height] = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
    assert.ok(Number(width) <= 640 && Number(height) <= 420, 'the tour is a compact card');
    const rows = [...svg.matchAll(/<g class="tour-step" data-step="(\d+)" data-actor="([^"]+)">([\s\S]*?)<\/g>/g)];
    assert.deepEqual(rows.map(([, number]) => Number(number)), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(rows.map(([, , actor]) => actor), ['you', 'coordinator', 'builder', 'verifier', 'builder', 'builder', 'verifier', 'coordinator']);
    for (const row of rows) {
      assert.equal([...row[3].matchAll(/class="description"/g)].length, 1, 'each step has one descriptive text line');
    }
    assert.match(rows[3][3], /class="verdict reject"[\s\S]*>REJECT<\/text>/);
    assert.match(rows[6][3], /class="verdict accept"[\s\S]*>ACCEPT<\/text>/);
    assert.match(svg, /BEHAVIOR_MISMATCH/);
    assert.match(svg, /CRITERION_MET/);
    assert.doesNotMatch(svg, /<script\b/);
  }
});

test('the card lights steps in turn and holds still for reduced motion [I13]', () => {
  for (const svg of cards()) {
    assert.match(svg, /animation:light-step 16s linear infinite/);
    assert.deepEqual([...svg.matchAll(/animation-delay:(\d+)s/g)].map(([, delay]) => Number(delay)), [0, 2, 4, 6, 8, 10, 12, 14]);
    assert.match(svg, /@media\(prefers-reduced-motion:reduce\)\{\.step-glow\{animation:none;fill:transparent\}\}/);
  }
});

test('the card carries distinct actor and verdict colours for light and dark readers [I13]', () => {
  for (const svg of cards()) {
    assert.match(svg, /@media\(prefers-color-scheme:dark\)/);
    for (const color of ['#101714', '#315f8f', '#6547bc', '#087546', '#e9eeeb', '#80bfff', '#c1aeff', '#61e6b1']) assert.ok(svg.includes(color), color);
    for (const [actor, color] of [['you', 'ink'], ['coordinator', 'blue'], ['builder', 'violet'], ['verifier', 'green']]) {
      assert.ok(svg.includes(`.${actor}{fill:var(--${color})}`), `${actor} has its own colour`);
    }
    assert.match(svg, /\.reject text\{fill:var\(--red\)\}/);
    assert.match(svg, /\.accept text\{fill:var\(--green\)\}/);
  }
});

test('the card changes when the real tour facts change and escapes its captured text [I13]', () => {
  const captured = capturedTour();
  const changed = captured.map(({ text, at }) => ({ text: text.replaceAll('greet', 'welcome').replaceAll('Hello, world!', 'Hello, earth!').replaceAll('Hello, !', 'Hello, <guest>!').replaceAll('not from memory', 'not from notes'), at }));
  const svg = renderTour(changed);
  assert.match(svg, /class="description"[^>]*>approve one spec row: welcome a blank name as &quot;earth&quot;<\/text>/);
  assert.match(svg, /class="description"[^>]*>claims it, builds welcome\(\), submits with tests green<\/text>/);
  assert.match(svg, /class="description"[^>]*>tries a blank name, gets &quot;Hello, &lt;guest&gt;!&quot;<\/text>/);
  assert.match(svg, /class="description"[^>]*>reads why from the board, not from notes\.<\/text>/);
  assert.doesNotMatch(svg, /<guest>/);
  assert.throws(() => renderTour(captured.filter(({ text }) => !text.startsWith('8  '))), /eight numbered tour steps/);
  assert.throws(() => renderTour(captured.filter(({ text }) => !text.includes('# fail 1'))), /deliberately failing test/);
  assert.match(readFileSync(shots('demo.mjs'), 'utf8'), /NO_COLOR: '1'/);
});
