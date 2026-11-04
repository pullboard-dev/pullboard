/** @pullboard-test-input source-tree */
/** Stage colors are one set of tokens, used the same way on every screen [N26]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const DIR = new URL('../../apps/view/src/shell/', import.meta.url);
const FILES = ['view.css', 'view/stage.css', 'view/item-rows.css', 'view/dashboard.css', 'view/cost.css'];
const css = Object.fromEntries(FILES.map((f) => [f, readFileSync(new URL(f, DIR), 'utf8')]));
const all = Object.values(css).join('\n');

const TOKENS = {
  'stage-merged': ['#067a50', '#30ad79'], 'stage-review': ['#d4a020', '#b38529'], 'stage-building': ['#285c99', '#3a6ab0'],
  'stage-ready': ['#a383e6', '#9d80e0'], 'stage-gated': ['#8a968f', '#5d6b64'], 'mark-back': ['#c4473a', '#d26059'],
};
const PLAIN = { surface: ['#fdfefd', '#121815'], ink: ['#121a17', '#e7ece9'] };

/** The rgb triple of a #rrggbb color. */
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
/** Mix a over b in sRGB, a at the given percent. */
const mix = (a, b, pct) => rgb(a).map((v, i) => v * pct / 100 + rgb(b)[i] * (100 - pct) / 100);
/** WCAG relative luminance of an rgb triple. */
const lum = (c) => { const [r, g, b] = c.map((v) => { const s = v / 255; return s <= .03928 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4; }); return .2126 * r + .7152 * g + .0722 * b; };
/** WCAG contrast ratio between two rgb triples. */
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + .05) / (y + .05); };
/** Hex string of an rgb triple, for the mixes handed back to mix(). */
const hex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

test('the stage tokens live in one place with the approved light and dark values [N26]', () => {
  for (const [name, [light, dark]] of Object.entries(TOKENS)) {
    const matches = [...all.matchAll(new RegExp(`--${name}:\\s*light-dark\\((#[0-9a-f]{6}),\\s*(#[0-9a-f]{6})\\)`, 'g'))];
    assert.equal(matches.length, 1, `--${name} is defined exactly once`);
    assert.deepEqual([matches[0][1], matches[0][2]], [light, dark], `--${name} holds the approved values`);
  }
  assert.match(css['view.css'], /--mark-held:/, '--mark-held is defined with the stage tokens');
});

test('every stage color in the view resolves to its token, never a literal or a screen-own color [N26]', () => {
  const expect = [
    [/\.roadmap-stage-swatch\.review\b[^{]*\{[^}]*\}/, 'stage-review'], [/\.roadmap-stage-swatch\.building\b[^{]*\{[^}]*\}/, 'stage-building'],
    [/\.roadmap-stage-swatch\.waiting\b[^{]*\{[^}]*\}/, 'stage-ready'], [/\.roadmap-stage-swatch\.landed\b[^{]*\{[^}]*\}/, 'stage-merged'],
    [/\.roadmap-summary \.review\b[^{]*\{[^}]*\}/, 'stage-review'], [/\.roadmap-summary \.building\b[^{]*\{[^}]*\}/, 'stage-building'],
    [/\.roadmap-summary \.waiting\b[^{]*\{[^}]*\}/, 'stage-ready'], [/\.roadmap-summary \.landed\b[^{]*\{[^}]*\}/, 'stage-merged'],
    [/\.roadmap-state\.review\b[^{]*\{[^}]*\}/, 'stage-review'], [/\.roadmap-state\.ready\b[^{]*\{[^}]*\}/, 'stage-ready'],
    [/\.roadmap-state\.building\b[^{]*\{[^}]*\}/, 'stage-building'], [/\.roadmap-state\.back\b[^{]*\{[^}]*\}/, 'mark-back'],
    [/\.chip\.busy\s*\{[^}]*\}/, 'stage-building'], [/\.chip\.free\s*\{[^}]*\}/, 'stage-ready'], [/\.chip\.warn\s*\{[^}]*\}/, 'stage-review'],
    [/\.chip\.ok\s*\{[^}]*\}/, 'stage-merged'], [/\.chip\.no\s*\{[^}]*\}/, 'mark-back'],
    [/\.dot\.building\b[^{]*\{[^}]*\}/, 'stage-building'], [/\.dot\.verify\b[^{]*\{[^}]*\}/, 'stage-review'],
    [/\.dot\.verified\b[^{]*\{[^}]*\}/, 'stage-merged'], [/\.dot\.back\b[^{]*\{[^}]*\}/, 'mark-back'],
    [/\.roadmap-step\.busy\s*\{[^}]*\}/, 'stage-building'], [/\.roadmap-step\.free\s*\{[^}]*\}/, 'stage-ready'],
    [/\.dash-agent rect\.review\b[^{]*\{[^}]*\}/, 'stage-review'], [/\.cost-split > \.back[^{]*\{[^}]*\}/, 'mark-back'],
  ];
  for (const [pattern, token] of expect) {
    const rule = all.match(pattern)?.[0];
    assert.ok(rule, `a rule matching ${pattern} exists`);
    assert.ok(rule.includes(`var(--${token})`), `${rule.slice(0, 60)} uses --${token}`);
    assert.ok(!/var\(--(blue|violet|warn|accent|reject|ink-faint)(-soft|-strong)?\)|#[0-9a-f]{3,6}\b/.test(rule), `${rule.slice(0, 60)} carries no literal or screen-own color`);
  }
  assert.match(all, /\.roadmap-stage-swatch\.held\b[^}]*dashed var\(--mark-held\)/, 'Held is a dashed outline, not a color');
  assert.ok(!/\.roadmap-(stage-swatch|summary)[^{]*\.held\b[^}]*var\(--warn\)/.test(all), 'Held is no longer brown');
});

test('chip text on its tint is at least 4.5:1 in light and dark [N26]', () => {
  const rule = /background:\s*color-mix\(in srgb, var\(--([\w-]+)\) (\d+)%, var\(--surface\)\);\s*color:\s*color-mix\(in srgb, var\(--\1\) (\d+)%, var\(--ink\)\)/g;
  let seen = 0;
  for (const m of all.matchAll(rule)) {
    seen++;
    for (const mode of [0, 1]) {
      const token = TOKENS[m[1]][mode];
      const bg = mix(token, PLAIN.surface[mode], Number(m[2]));
      const fg = mix(token, PLAIN.ink[mode], Number(m[3]));
      assert.ok(contrast(fg, bg) >= 4.5, `--${m[1]} chip ${mode ? 'dark' : 'light'} contrast ${contrast(fg, bg).toFixed(2)} is under 4.5`);
    }
  }
  assert.ok(seen >= 9, 'the stage chip tints were found');
  assert.ok(hex([0, 0, 0]) === '#000000');
});
