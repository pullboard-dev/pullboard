/** @pullboard-test-input source-tree */
/** One composer fills every @pullboard-*-styles marker of the view's stylesheet [C7,#3020]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { composeViewStyles } from '../../index.js';
import { composeViewStyles as composerModule } from '../../src/io/styles.js';

const SHELL = new URL('../../src/io/', import.meta.url);
const MARKER = /\/\* @pullboard-([\w-]+)-styles \*\//gu;
const STYLESHEETS = { activity: 'activity', dashboard: 'dashboard', 'items-row': 'item/rows', nav: 'nav', palette: 'palette/palette', 'project-menu': 'project-menu', stage: 'stage' };

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

