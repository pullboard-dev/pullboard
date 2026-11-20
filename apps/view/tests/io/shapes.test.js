/** @pullboard-test-input apps/view/src/io/main.css apps/view/src/io/item/rows.css apps/view/src/io/stage.css apps/view/src/io/dashboard.css apps/view/src/io/activity.css apps/view/src/io/project-menu.css apps/view/src/io/palette/palette.css apps/view/src/io/nav.css apps/view/src/io/shouts.css apps/view/src/io/notch.css apps/view/src/io/doctrine.css apps/view/src/io/item/panel.css apps/view/src/io/cost.css apps/view/src/io/no-link.css */
/** Every page takes the design sheet's shapes: 6 px cards, 4 px chips, round dots only, shadows only on floating panels [N26]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { composeViewStyles } from '../../index.js';

const SHELL = new URL('../../src/io/', import.meta.url);
/** Every stylesheet the view serves: the composed one plus the shared Doctrine, item-panel, Cost and no-link sheets. */
const sheets = () => [composeViewStyles(), ...['doctrine.css', 'item/panel.css', 'cost.css', 'no-link.css'].map(name => readFileSync(new URL(name, SHELL), 'utf8'))].join('\n');
/** The served stylesheets as [selector, declarations] pairs, comments removed. */
const rules = () => [...sheets().replace(/\/\*[\s\S]*?\*\//gu, '').matchAll(/([^{}]+)\{([^{}]*)\}/gu)].map(match => [match[1].trim(), match[2]]);
const decl = (body, property) => body.match(new RegExp(`(?:^|[;\\s])${property}: *([^;]+)`, 'u'))?.[1].trim();
const rule = selector => rules().filter(([sel]) => sel === selector).map(([, body]) => body).join(' ');
const root = () => rules().filter(([sel]) => sel === ':root').map(([, body]) => body).join(' ');

test('view.x-io-shapes.clause-1-the-shared-tokens-give-cards: clause 1: the shared tokens give cards 6 px corners and a 1 px #e5e5e5 border, and no card rule carries a shadow [N26]', () => {
  const tokens = root();
  assert.match(tokens, /--round: 1;/u, 'one is the sheet');
  assert.match(tokens, /--radius-card: calc\(6px \* var\(--round\)\)/u, 'cards are 6 px');
  assert.match(tokens, /--line: light-dark\(#e5e5e5,/u, 'the thin border is #e5e5e5');
  assert.match(tokens, /--shadow-float:/u, 'one shadow token, for floating panels');
  assert.doesNotMatch(tokens, /--shadow:/u, 'there is no card shadow token');
  for (const selector of ['.card-panel', '.settings-head', '.set-group', '.rulings-box', '.first-run-card', '.no-link', '.cost-card', '.floor-band', '.row', '.act-card', '.milestone-item']) {
    const body = rule(selector);
    assert.ok(body, `${selector} has a rule`);
    assert.doesNotMatch(decl(body, 'border-radius') ?? 'var(--radius-card)', /px|pill|50%/u, `${selector} takes its corners from a token`);
    assert.ok(/radius-card|radius-lg|radius-md/u.test(decl(body, 'border-radius') ?? 'var(--radius-card)'), `${selector} has card corners`);
    assert.equal(decl(body, 'box-shadow'), undefined, `${selector} has no shadow`);
  }
  assert.match(root(), /--radius-lg: calc\(6px/u, 'every card token reads 6 px');
  assert.match(root(), /--radius-md: calc\(6px/u);
  assert.doesNotMatch(rule('.dash-live'), /--dash-card: var\(--radius-(?:md|lg)\)/u, 'the Dashboard reads the shared card token');
  const shadows = rules().map(([selector, body]) => [selector, decl(body, 'box-shadow')]).filter(([, value]) => value);
  for (const [selector, value] of shadows.filter(([selector]) => !/^(?:from|to)$/u.test(selector))) assert.match(value, /^(?:none|var\(--shadow-float\)|var\(--(?:inset|ring)[\w-]*\)|inset .*|0 0 0 \d+px .*)$/u, `${selector}: ${value} is no card shadow`);
});

test('view.x-io-shapes.clause-2-chips-and-buttons-have-4: clause 2: chips and buttons have 4 px corners, only dots are round, and the selected Insights entry has no fill [N26]', () => {
  const css = sheets();
  assert.doesNotMatch(css, /radius-pill|999px/u, 'no pill radius is left');
  assert.match(root(), /--radius-chip: calc\(4px/u, 'chips are 4 px');
  for (const selector of ['.needs-action', '.chip.tier-pill', '.rule-source-chip', '.floor-chip', '.act-pill', '.act-chip', '.mark', '.window-change']) assert.match(rule(selector), /border-radius: var\(--radius-chip\)/u, `${selector} is a 4 px chip`);
  const stage = rules().filter(([selector]) => /\.stage-word|\.item-status/u.test(selector) && decl(selector && rules().find(r => r[0] === selector)[1], 'border-radius'));
  assert.ok(stage.length >= 2, 'the stage word rules set a radius');
  for (const [selector, body] of stage) assert.equal(decl(body, 'border-radius'), 'var(--radius-chip)', `${selector} is a 4 px chip`);
  for (const selector of ['.go', '.ghost', '.approve-row, .decline-row']) assert.ok(rules().some(([sel, body]) => sel.includes(selector.split(',')[0]) && decl(body, 'border-radius') === 'var(--radius-xs)'), `${selector} buttons are 4 px`);
  const ROUND = /(?:\.act-live \.m?dot|\.dot|\.dash-dot|\.dash-st|\.block-dot|\.notch-sp|\.acct|\.tl-marker|\.needs-kind|\.activity-verb|\.needs-quiet-badge|\.to-clear|\.item-panel-check-mark|-dot\b| i(?:,|$)|\.ob-spin|\.ob-live i|\.ob-steps li::before|\.status \.live::before|\.chip\.stale::before|\.rulings-box \.head i|\.activity-lines i|\.floor-live i|\.floor-agent > b > i|\.first-run-\S+( i| b| button)?|\.projpop \.row \.dot|\.roadmap-release-version::before|\.roadmap-(?:stage-swatch|summary-swatch|step)|\.on::before|::after)/u;
  for (const [selector, body] of rules()) if (/border-radius: *50%/u.test(body)) assert.match(selector, ROUND, `${selector} is a dot, an avatar or a spinner, the only round shapes`);
  const entry = rules().filter(([selector]) => selector.includes('.tab-menu .tab') && selector.includes('.on') && !selector.includes('::'));
  assert.ok(entry.length, 'the Insights menu entry you are on has a rule');
  for (const [selector, body] of entry) assert.match(decl(body, 'background') ?? '', /^none$/u, `${selector} has no fill`);
  assert.doesNotMatch(css, /\.tab-menu \.tab:hover, :root\[data-nav="top"\] \.tab-menu \.tab\.on/u, 'the entry is not filled together with hover');
});

test('view.x-io-shapes.clause-2-floating-panels-menus-palette-dialogs: clause 2: floating panels (menus, palette, dialogs, find results) keep the shadow and 8 px corners [N26]', () => {
  for (const selector of [':root[data-nav] .acct-menu', ':root[data-nav="top"] .tab-menu', '.projpop', '.pal-box', '.pal-help', '.find-results', '.spec-reason-dialog']) {
    const body = rule(selector);
    assert.equal(decl(body, 'box-shadow'), 'var(--shadow-float)', `${selector} floats`);
  }
  for (const selector of [':root[data-nav] .acct-menu', ':root[data-nav="top"] .tab-menu', '.projpop', '.pal-box', '.pal-help', '.spec-reason-dialog']) assert.equal(decl(rule(selector), 'border-radius'), 'var(--radius-float)', `${selector} has 8 px corners`);
});
