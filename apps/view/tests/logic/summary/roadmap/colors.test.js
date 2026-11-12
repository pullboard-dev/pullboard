/** @pullboard-test-input source-tree */
/** Stage colors are one set of tokens, used the same way on every screen [N26]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { roadmapSummary } from '../../../../src/logic/summary/roadmap.js';

const DIR = new URL('../../../../src/io/', import.meta.url);
const FILES = ['main.css', 'stage.css', 'item/rows.css', 'roadmap.css', 'dashboard.css', 'cost.css'];
const css = Object.fromEntries(FILES.map((f) => [f, readFileSync(new URL(f, DIR), 'utf8')]));
const all = Object.values(css).join('\n');

const TOKENS = {
  'stage-merged': ['#067a50', '#30ad79'], 'stage-review': ['#d4a020', '#b38529'], 'stage-building': ['#285c99', '#3a6ab0'],
  'stage-ready': ['#a383e6', '#9d80e0'], 'stage-gated': ['#8a968f', '#5d6b64'], 'mark-back': ['#c4473a', '#d26059'],
};
const PLAIN = { surface: ['#fdfefd', '#121815'], ink: ['#121a17', '#e7ece9'] };

/** Linear-light channels of a #rrggbb color. */
const linear = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((s) => s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4);
/** Oklab of a #rrggbb color, as color-mix(in oklab, ...) mixes it. */
const oklab = (hex) => {
  const [r, g, b] = linear(hex);
  const [l, m, s] = [.4122214708 * r + .5363325363 * g + .0514459929 * b, .2119034982 * r + .6806995451 * g + .1073969566 * b,
    .0883024619 * r + .2817188376 * g + .6299787005 * b].map(Math.cbrt);
  return [.2104542553 * l + .793617785 * m - .0040720468 * s, 1.9779984951 * l - 2.428592205 * m + .4505937099 * s, .0259040371 * l + .7827717662 * m - .808675766 * s];
};
/** Linear-light channels of an oklab color, clipped to sRGB. */
const fromOklab = ([L, a, b]) => {
  const [l, m, s] = [L + .3963377774 * a + .2158037573 * b, L - .1055613458 * a - .0638541728 * b, L - .0894841775 * a - 1.291485548 * b].map((v) => v ** 3);
  return [4.0767416621 * l - 3.3077115913 * m + .2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - .3413193965 * s,
    -.0041960863 * l - .7034186147 * m + 1.707614701 * s].map((v) => Math.min(1, Math.max(0, v)));
};
/** color-mix(in oklab, a pct%, b), in linear light. */
const mix = (a, b, pct) => { const [x, y] = [oklab(a), oklab(b)]; return fromOklab(x.map((v, i) => v * pct / 100 + y[i] * (100 - pct) / 100)); };
/** WCAG contrast ratio between two linear-light colors. */
const contrast = (a, b) => {
  const lum = ([r, g, b2]) => .2126 * r + .7152 * g + .0722 * b2;
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + .05) / (y + .05);
};

test('the stage tokens live in one place with the approved light and dark values (clause 1) [N26]', () => {
  for (const [name, [light, dark]] of Object.entries(TOKENS)) {
    const matches = [...all.matchAll(new RegExp(`--${name}:\\s*light-dark\\((#[0-9a-f]{6}),\\s*(#[0-9a-f]{6})\\)`, 'g'))];
    assert.equal(matches.length, 1, `--${name} is defined exactly once`);
    assert.deepEqual([matches[0][1], matches[0][2]], [light, dark], `--${name} holds the approved values`);
    for (const hex of [light, dark]) assert.equal(all.split(hex).length - 1, 1, `${hex} is written only in --${name}`);
  }
  assert.match(css['main.css'], /--mark-held:/, '--mark-held is defined with the stage tokens');
});

test('every stage color in the view resolves to its token, never a literal or a screen-own color (clause 1) [N26]', () => {
  const expect = [
    [/\.roadmap-stage-swatch\.review\b[^{]*\{[^}]*\}/, 'stage-review'], [/\.roadmap-stage-swatch\.building\b[^{]*\{[^}]*\}/, 'stage-building'],
    [/\.roadmap-stage-swatch\.open\b[^{]*\{[^}]*\}/, 'stage-ready'], [/\.roadmap-stage-swatch\.waiting\b[^{]*\{[^}]*\}/, 'stage-gated'],
    [/\.roadmap-stage-swatch\.landed\b[^{]*\{[^}]*\}/, 'stage-merged'],
    [/\.roadmap-summary \.review\b[^{]*\{[^}]*\}/, 'stage-review'], [/\.roadmap-summary \.building\b[^{]*\{[^}]*\}/, 'stage-building'],
    [/\.roadmap-summary \.waiting\b[^{]*\{[^}]*\}/, 'stage-gated'], [/\.roadmap-summary \.landed\b[^{]*\{[^}]*\}/, 'stage-merged'],
    [/\.roadmap-summary \.landing\b[^{]*\{[^}]*\}/, 'stage-stripe'], [/\.roadmap-summary-segment\.held\b[^{]*\{[^}]*\}/, 'stage-gated'],
    [/\.roadmap-state\.review\b[^{]*\{[^}]*\}/, 'stage-review'], [/\.roadmap-state\.ready\b[^{]*\{[^}]*\}/, 'stage-ready'],
    [/\.roadmap-state\.building\b[^{]*\{[^}]*\}/, 'stage-building'], [/\.roadmap-state\.gated\b[^{]*\{[^}]*\}/, 'stage-gated'],
    [/\.roadmap-state\.accepted\b[^{]*\{[^}]*\}/, 'stage-merged'],
    [/\.item-stage\[data-stage=in-review\][^{]*\{[^}]*\}/, 'stage-review'], [/\.item-stage\[data-stage=building\][^{]*\{[^}]*\}/, 'stage-building'],
    [/\.item-stage\[data-stage=ready\][^{]*\{[^}]*\}/, 'stage-ready'], [/\.item-stage\[data-stage=gated\][^{]*\{[^}]*\}/, 'stage-gated'],
    [/\.item-stage\[data-stage=merged\][^{]*\{[^}]*\}/, 'stage-merged'],
    [/\.chip\.busy\s*\{[^}]*\}/, 'stage-building'], [/\.chip\.free\s*\{[^}]*\}/, 'stage-ready'], [/\.chip\.warn\s*\{[^}]*\}/, 'stage-review'],
    [/\.chip\.ok\s*\{[^}]*\}/, 'stage-merged'], [/\.chip\.no\s*\{[^}]*\}/, 'mark-back'],
    [/\.dot\.building\b[^{]*\{[^}]*\}/, 'stage-building'], [/\.dot\.verify\b[^{]*\{[^}]*\}/, 'stage-review'],
    [/\.dot\.verified\b[^{]*\{[^}]*\}/, 'stage-merged'], [/\.dot\.back\b[^{]*\{[^}]*\}/, 'mark-back'],
    [/\.roadmap-step\.busy\s*\{[^}]*\}/, 'stage-building'], [/\.roadmap-step\.free\s*\{[^}]*\}/, 'stage-ready'],
    [/\.dash-agent rect\.review\b[^{]*\{[^}]*\}/, 'stage-review'], [/\.cost-split > \.back[^{]*\{[^}]*\}/, 'mark-back'],
    [/\.floor rect\.build\b[^{]*\{[^}]*\}/, 'stage-building'], [/\.floor rect\.review\b[^{]*\{[^}]*\}/, 'stage-review'],
    [/\.floor-chip\.build\s*\{[^}]*\}/, 'stage-building'], [/\.floor-chip\.review\s*\{[^}]*\}/, 'stage-review'],
    [/\.window-stage-build\s*\{[^}]*\}/, 'stage-building'], [/\.window-stage-review\s*\{[^}]*\}/, 'stage-review'], [/\.window-stage-land\s*\{[^}]*\}/, 'stage-merged'],
    [/\.tl-marker\.build\s*\{[^}]*\}/, 'stage-building'], [/\.tl-marker\.review\s*\{[^}]*\}/, 'stage-review'], [/\.tl-marker\.back\s*\{[^}]*\}/, 'mark-back'],
  ];
  for (const [pattern, token] of expect) {
    const rule = all.match(pattern)?.[0];
    assert.ok(rule, `a rule matching ${pattern} exists`);
    assert.ok(rule.includes(`var(--${token})`), `${rule.slice(0, 60)} uses --${token}`);
    assert.ok(!/var\(--(blue|violet|warn|accent|reject|ink-faint)(-soft|-strong)?\)|#[0-9a-f]{3,6}\b/.test(rule), `${rule.slice(0, 60)} carries no literal or screen-own color`);
  }
  assert.ok(!/\.roadmap-(stage-swatch|summary) ?\.waiting\b[^}]*--stage-ready/.test(all), 'waiting work is Gated grey, never Ready purple');
  assert.match(all, /\.roadmap-stage-swatch\.held\b[^}]*dashed var\(--mark-held\)/, 'Held is a dashed outline, not a color');
  assert.match(all, /\.roadmap-summary-swatch\.held\b[^}]*dashed var\(--mark-held\)/, 'the Roadmap legend draws Held as a dashed ring');
  assert.ok(!/\.roadmap-(stage-swatch|summary)[^{]*\.held\b[^}]*var\(--warn\)/.test(all), 'Held is no longer brown');
  assert.match(all, /\.stage-mark\.gate \{[^}]*background: none;[^}]*dashed/, 'the Held mark is dashed, with no fill');
  assert.match(all, /\.roadmap-summary-needs \{[^}]*color: var\(--ink\)/, 'Needs you is ink, not a color');
});

test('stage chip text on its tint is at least 4.5:1 in light and dark (clause 3) [N26]', () => {
  const pair = /background:\s*color-mix\(in oklab, var\(--([\w-]+)\) (\d+)%, var\(--surface\)\);\s*color:\s*color-mix\(in oklab, var\(--\1\) (\d+)%, var\(--ink\)\)/g;
  let seen = 0;
  for (const m of all.matchAll(pair)) {
    seen++;
    // The shared --stage chip is checked against every stage it can name.
    const names = m[1] === 'stage' ? Object.keys(TOKENS) : [m[1]];
    for (const name of names) for (const mode of [0, 1]) {
      const token = TOKENS[name][mode];
      const ratio = contrast(mix(token, PLAIN.ink[mode], Number(m[3])), mix(token, PLAIN.surface[mode], Number(m[2])));
      assert.ok(ratio >= 4.5, `--${name} chip ${mode ? 'dark' : 'light'} contrast ${ratio.toFixed(2)} is under 4.5`);
    }
  }
  assert.ok(seen >= 9, 'the stage chip tints were found');
  assert.ok(!/color-mix\(in srgb, var\(--(stage|mark)-/.test(all), 'every stage mix is in oklab, as the mockup mixes it');
});

test('the Roadmap bar paints Landing from a stripe pattern its rect references, and Merged solid (clause 2) [N26]', () => {
  const html = roadmapSummary({ name: 'M', summary: { total: 10, left: 6, landed: 4, landing: 2, review: 1, building: 1, waiting: 2, held: 0 } }).header;
  assert.ok(/<pattern id="roadmap-summary-stripe"/.test(html), 'the bar defines the stripe pattern');
  assert.match(html, /<rect class="roadmap-summary-segment landing"[^>]*fill="url\(#roadmap-summary-stripe\)"/, 'the landing rect fills from the pattern');
  assert.doesNotMatch(html, /roadmap-summary-segment landed"[^>]*fill=/, 'the merged rect keeps its solid CSS fill');
  assert.match(all, /\.roadmap-stripe-a \{[^}]*fill: var\(--stage-merged\)/, 'the stripe is the Merged green');
  assert.doesNotMatch(all, /\.roadmap-summary \.landing[^{]*\{[^}]*\bfill:/, 'no CSS fill overrides the rect pattern fill');
});
