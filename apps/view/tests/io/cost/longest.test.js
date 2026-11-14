/** @pullboard-test-input apps/view/src/io/cost.css apps/view/src/io/cost/overview.js */
/** @pullboard-world-pin reads cost.css to prove the Took the longest rows sit one to a line, in two columns on a wide screen and one on a phone. */
/** Cost Took the longest is ten one-line rows in two columns, one column on a phone, with the click and All items kept [N26]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { costOverviewHtml } from '../../../src/io/cost/overview.js';

const css = readFileSync(new URL('../../../src/io/cost.css', import.meta.url), 'utf8');
const longest = Array.from({ length: 10 }, (_, index) => ({ id: index + 1, title: 'Item ' + (index + 1), agentMs: (10 - index) * 3_600_000, sentBack: index % 3, sessions: [{ label: 'Model A', count: 1, agentMs: 3_600_000, tokensIn: null }] }));
const data = { window: '7d', totals: { itemCount: 12 }, days: [], builders: { rows: [] }, verifiers: { rows: [] }, longest, allItems: 12 };
/** The last rule for a selector, which is the one the cascade uses. */
const rule = (source, selector) => [...source.matchAll(new RegExp('(?:^|\\n)' + selector.replace(/[.]/gu, '\\$&') + '\\s*\\{([^}]*)\\}', 'gu'))].at(-1)?.[1] ?? '';

test('clause 1: each Took the longest row is one line: id, title, model, bar, hours, with nothing stacked [N26]', () => {
  const row = /<button class="cost-row[^"]*"[^>]*>(.*?)<\/button>/su.exec(costOverviewHtml(data))?.[1] ?? '';
  assert.match(row, /^<span class="cost-row-title"><b class="id">#1<\/b><span class="cost-title">Item 1<\/span><\/span><span class="cost-row-models">.*Model A.*<\/span><span class="cost-time">.*<b>10 h<\/b><\/span>/su, 'id, title, model, bar and hours are the row\'s direct parts');
  assert.doesNotMatch(row, /cost-row-main/u, 'no stacked title-over-model block');
  assert.match(rule(css, '.cost-row'), /grid-template-columns: minmax\(0, 1fr\) minmax\(0, 150px\) 112px 54px/u, 'one grid line of four cells');
  assert.match(rule(css, '.cost-title'), /text-overflow: ellipsis/u, 'a long title ends in an ellipsis');
});

test('clause 2: ten items show in two columns that fill the panel, one column at phone width [N26]', () => {
  const html = costOverviewHtml(data);
  assert.equal(html.match(/data-cost-row="/gu)?.length, 10, 'ten rows');
  assert.match(html, /<div class="cost-longest-list">(?:<button class="cost-row.*?){10}<\/div><button class="cost-all"/su, 'the rows share one list');
  assert.match(rule(css, '.cost-longest-list'), /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/u, 'two columns filling the width');
  assert.match(css, /@media \(max-width: 700px\) \{[^\n]*\.cost-longest-list \{ grid-template-columns: minmax\(0, 1fr\); \}/u, 'one column at 390');
});

test('clause 3: a click still shows who worked on it and All items is still there [N26]', () => {
  const html = costOverviewHtml(data, 2);
  assert.match(html, /aria-expanded="true"[^]*?<div class="cost-detail">.*Model A/su, 'the opened row shows its sessions');
  assert.match(rule(css, '.cost-longest-list > .cost-detail'), /grid-column: 1 \/ -1/u, 'the detail spans both columns');
  assert.match(html, /data-cost-all type="button">All 12 items/u);
});
