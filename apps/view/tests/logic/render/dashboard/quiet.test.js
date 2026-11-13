/** @pullboard-test-input apps/view/src/io/dashboard.css */
/** @pullboard-world-pin reads the shipped Dashboard stylesheet to prove the ETA tile carries no shadow at any width; no browser is needed for the rule text. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { dashboardHtml } from '../../../../src/logic/render/dashboard.js';
import { dashboardModel } from '../../../../src/io/dashboard/model.js';
import { board } from './fixture.js';
import { now } from './fixture.js';

const css = readFileSync(new URL('../../../../src/io/dashboard.css', import.meta.url), 'utf8');
const render = (mutate = project => project) => { const { project, events } = board(); return dashboardHtml(dashboardModel(mutate(project), events, { now, complete: true })); };
const section = (html, name) => { const start = html.indexOf(`aria-label="${name}"`); assert.notEqual(start, -1, name); return html.slice(start, html.indexOf('</section>', start)); };

test('clause 1: an empty gate, review or landing list is one quiet line, with no card and no placeholder box [N26,#7309]', () => {
  const empty = dashboardHtml(dashboardModel({ ...board().project, items: [] }, [], { now, complete: true }));
  for (const name of ['In the gate', 'In review', 'Landing']) {
    const one = section(empty, name);
    assert.match(empty, new RegExp('dash-qquiet' + '" aria-label="' + name), name + ' is the quiet kind');
    assert.doesNotMatch(one, /dash-card|dash-q"/u, name + ' draws no card');
    assert.match(one, new RegExp('Nothing ' + name.toLowerCase().replace('landing', 'landing') + '\\.', 'u'), name + ' says so in one line');
  }
  assert.match(section(empty, 'Landed · 4 h'), /dash-card/u, 'the landed list keeps its card');
  assert.match(css, /\.dash-qquiet/u);
});

test('clause 2: the ETA tile has a border and no shadow at any width [N26,#7309]', () => {
  const rules = css.split('\n').filter(line => /dash-stat\.eta/u.test(line)).join('\n');
  assert.match(rules, /border: var\(--border\)/u);
  assert.doesNotMatch(rules, /shadow|inset-line/u, 'no shadow on the ETA tile');
  const widths = [...css.matchAll(/@media[^{]*\{([^@]*?)\n\}/gu)].map(match => match[1]).join('\n');
  assert.doesNotMatch(widths.split('\n').filter(line => /dash-stat/u.test(line)).join('\n'), /shadow/u, 'no width brings one back');
});

test('clause 3: a test run with no item leaves the id empty and reads files done of total, never a dash [N26,#7309,#7403]', () => {
  const html = render(project => ({ ...project, dashboardRunners: { runners: [{ runner: 1, busy: true, cpu: 40, ram: 50, jobs: [{ kind: 'test run', item: null, selected: 1, done: 0 }] }],
    runs: [{ kind: 'test run', item: null, items: [], runners: [1], selected: 3, done: 1 }] } }));
  const runners = section(html, 'Runners');
  assert.match(runners, /<span class="dash-id"><\/span><span class="dash-t">test run <small>· 0 of 1 file<\/small>/u);
  assert.match(runners, /<small>· 1 of 3 files<\/small>/u);
  assert.doesNotMatch(runners, /<span class="dash-id">—<\/span>/u, 'no dash in an id cell');
});
