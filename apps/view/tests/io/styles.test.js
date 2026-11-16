/** @pullboard-test-input source-tree */
/** One composer fills every @pullboard-*-styles marker of the view's stylesheet [C7,#3020]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { test } from 'node:test';
import { composeViewStyles } from '../../index.js';
import { composeViewStyles as composerModule } from '../../src/io/styles.js';

const SHELL = new URL('../../src/io/', import.meta.url);
const MARKER = /\/\* @pullboard-([\w-]+)-styles \*\//gu;
const STYLESHEETS = { activity: 'activity', dashboard: 'dashboard', 'items-row': 'item/rows', nav: 'nav', palette: 'palette/palette', 'project-menu': 'project-menu', shouts: 'shouts', stage: 'stage' };

/** The notch's and Shouts' stylesheets join the map here, so the line above stays one edit for everyone [#6651]. */
Object.assign(STYLESHEETS, { notch: 'notch', shouts: 'shouts' });

test('clause 1: composeViewStyles(), re-exported by apps/view/index.js, returns view.css with every @pullboard-*-styles marker replaced by its stylesheet [C7,#3020]', () => {
  assert.equal(composeViewStyles, composerModule, 'apps/view/index.js re-exports the composer from src/io/styles.js');
  const source = readFileSync(new URL('main.css', SHELL), 'utf8');
  const markers = [...source.matchAll(MARKER)].map(match => match[1]);
  assert.deepEqual([...markers].sort(), Object.keys(STYLESHEETS).sort(), 'view.css holds one marker for each stylesheet');
  const expected = source.replace(MARKER, (_marker, name) => readFileSync(new URL(`${STYLESHEETS[name]}.css`, SHELL), 'utf8').trimEnd());
  assert.equal(composeViewStyles(), expected, 'each marker is replaced in place by its stylesheet, nothing else changes');
});

test('clause 2: serve.js builds SHARED_VIEW_CSS only through composeViewStyles(), whose output has no marker and has the item-row, stage and roadmap rules [C7,#3020]', () => {
  const serve = readFileSync(new URL('serve.js', SHELL), 'utf8');
  assert.match(serve, /^const SHARED_VIEW_CSS = composeViewStyles\(\);$/mu, 'SHARED_VIEW_CSS is the composer output');
  assert.doesNotMatch(serve, /@pullboard-[\w-]+-styles/u, 'serve.js fills no marker of its own');
  assert.doesNotMatch(serve, /new URL\("\.\/view\.css"/u, 'serve.js reads view.css only through the composer');
  const css = composeViewStyles();
  assert.doesNotMatch(css, /@pullboard-[\w-]+-styles/u, 'no marker is left unfilled');
  for (const selector of ['.row.item-row', '.stage-word', '.roadmap-status']) assert.ok(css.includes(selector), `${selector} reaches the shared stylesheet`);
});

test('clause 1: row titles never wrap, end in an ellipsis, and show inline code as plain monospace with no box [test,N26,#6840]', () => {
  const css = composeViewStyles();
  const rule = selector => [...css.matchAll(/([^{}]+)\{([^}]*)\}/gu)].filter(match => match[1].split(',').some(part => part.trim() === selector)).map(match => match[2]).join(' ');
  for (const selector of ['.row .t', '.milestone-item .t']) assert.match(rule(selector), /overflow: hidden; text-overflow: ellipsis; white-space: nowrap;/u, `${selector} is one line that ends in an ellipsis`);
  assert.ok(css.indexOf('.row .t, .milestone-item .t, .milestone-item.blocked .t {') > css.indexOf('.milestone-item .t { display: flex'), 'the one-line rule comes after the roadmap row\'s flex rule, so it wins');
  const code = rule('.row .t code.inline') + rule('.milestone-item .t code.inline');
  assert.match(code, /background: none;/u, 'inline code in a title has no grey box');
  assert.match(code, /padding: 0;/u);
  assert.match(code, /white-space: nowrap;/u);
});

test('clause 2: state chips in rows are compact text chips with 4px corners, not tall pills [test,N26,#6840]', () => {
  const css = composeViewStyles();
  const chips = ['.row.item-row .row-side .chip', '.milestone-item .stage-word', '.milestone-item .stage-mark', '.item-stage[data-stage] > .stage-line > .stage-word, .item-stage[data-stage] .chip.item-status .stage-word'];
  for (const selector of chips) {
    const at = css.indexOf(`${selector} {`);
    assert.ok(at >= 0, `${selector} is styled`);
    const body = css.slice(at, css.indexOf('}', at));
    assert.match(body, /border-radius: var\(--radius-chip\)/u, `${selector} has 4px corners`);
    assert.match(body, /\/18px/u, `${selector} is 18px tall`);
    assert.doesNotMatch(body, /min-width: 84px|radius-pill/u, `${selector} is not a pill`);
  }
});

test('Items never cuts a question id off: the folded group shows each id whole [N26]', () => {
  const css = composeViewStyles();
  assert.match(css, /\.needs-fold \.needs-id \{ max-width: none; overflow: visible; \}/u, 'Items shows doctrine:RG4901 whole');
  assert.match(css, /\.needs-fold-questions \.needs-group-head \{ display: none; \}/u, 'the folded group names itself once');
});

test('clause 1: the Dashboard Rulings show each reference whole and cut a title only at the row\'s width [N26]', () => {
  const css = composeViewStyles();
  const card = [...css.matchAll(/\.needs-card \.needs-id \{([^}]*)\}/gu)].map(match => match[1]);
  assert.ok(card.some(rule => /max-width: none; overflow: visible;/u.test(rule)), 'no fixed width or clip on the reference in the Dashboard card');
  assert.ok(card.some(rule => /display: block;/u.test(rule) && /overflow-wrap: anywhere;/u.test(rule)), 'on a phone the reference has its own line and wraps rather than clipping');
  const title = /\.needs-copy b, \.needs-copy small \{([^}]*)\}/u.exec(css)?.[1] ?? '';
  assert.match(title, /overflow: hidden; text-overflow: ellipsis; white-space: nowrap;/u, 'a title is cut with an ellipsis where its row ends');
  assert.doesNotMatch(title + ([...css.matchAll(/\.needs-copy b \{([^}]*)\}/gu)].map(match => match[1]).join(' ')), /(?:^|[ {;])(?:max-)?width:/u, 'no fixed width on the title');
});

test('clause 1: the tokens set cards to 6px, controls and chips to 4px, dots stay round, and cards carry a thin border and no shadow [test,N26,#6836]', () => {
  const css = composeViewStyles() + ['cost', 'no-link'].map(file => readFileSync(new URL(`${file}.css`, SHELL), 'utf8')).join('\n');
  const token = name => new RegExp(`${name}: ([^;]+);`, 'u').exec(css)?.[1];
  assert.equal(token('--round'), '1');
  assert.equal(token('--radius-card'), 'calc(6px * var(--round))');
  assert.equal(token('--radius-lg'), 'calc(6px * var(--round))');
  assert.equal(token('--radius-sm'), 'calc(4px * var(--round))');
  assert.equal(token('--radius-xs'), 'calc(4px * var(--round))');
  assert.equal(token('--radius-chip'), 'calc(4px * var(--round))', 'chips are 4px; only dots are round');
  assert.equal(token('--radius-float'), 'calc(8px * var(--round))', 'floating panels have 8px corners');
  assert.equal(token('--radius-dot'), '50%');
  for (const selector of ['.card-panel', '.dash-card', '.cost-card', '.set-group', '.no-link']) {
    const rule = new RegExp(`(?:^|\\n)${selector.replace('.', '\\.')} \\{([^}]*)\\}`, 'u').exec(css)?.[1] ?? '';
    assert.match(rule, /border: var\(--border\)/u, `${selector} has a thin border`);
    assert.match(rule, /border-radius: var\(--radius-card\)/u, `${selector} has the card corner`);
    assert.doesNotMatch(rule, /box-shadow/u, `${selector} has no shadow`);
  }
  for (const selector of ['.pal-box', '.projpop', '.find-results']) assert.match(css, new RegExp(`${selector.replace('.', '\\.')} \\{[^}]*border-radius: var\\(--radius-float\\)[^}]*box-shadow: var\\(--shadow-float\\)`, 'u'), `${selector} floats on the shadow token with 8px corners`);
});

test('clause 2: no stylesheet sets its own pixel corner radius or a card shadow outside the tokens [test,N26,#6836]', () => {
  const sheets = readdirSync(SHELL, { recursive: true }).filter(file => String(file).endsWith('.css'));
  assert.ok(sheets.length >= 12, 'every stylesheet under src/io is read');
  for (const file of sheets) {
    const css = readFileSync(new URL(file, SHELL), 'utf8');
    const own = [...css.matchAll(/border-radius: *([^;}]+)/gu)].map(match => match[1]).filter(value => /\d(?:\.\d+)?(?:px|rem|em)/u.test(value.replace(/var\([^)]*\)/gu, '')));
    assert.deepEqual(own, [], `${file} sets no corner radius of its own`);
    const shadows = [...css.matchAll(/box-shadow: *([^;}]+)/gu)].map(match => match[1]).filter(value => !/^(?:none|var\(--(?:shadow-float|shadow-modal|inset-line|inset-line-strong|ring-[a-z]+)\))$/u.test(value.trim()));
    assert.deepEqual(shadows, [], `${file} sets no shadow outside the tokens`);
  }
});
