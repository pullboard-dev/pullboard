/** The project menu tells boards apart: owner / name, kind and one fact each, and ends with All projects and Add a project [N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cockpitProjectMenu } from '../../../src/logic/cockpit/project-menu.js';
import { projectMenuHtml } from '../../../src/logic/cockpit/project-menu.js';
import { projectMenuRows } from '../../../src/logic/cockpit/project-menu.js';

const esc = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const listed = [
  { ok: true, root: 'a', id: 'a', name: 'pullboard', owner: 'pullboard-dev', kind: 'team', decisions: 5 },
  { ok: true, root: 'b', id: 'b', name: 'pullboard', owner: 'pullboard-dev', kind: 'private', decisions: 0 },
  { ok: true, root: 'c', id: 'c', name: 'pullboard-next', owner: '', handle: 'coreyolson', source: 'local', decisions: 0 },
  { ok: true, root: 'd', id: 'd', name: 'website', source: 'relay', owner: 'pullboard-dev', decisions: 0 },
  { ok: false, root: 'e', name: 'gone' },
];
const needs = (board) => board.decisions;

test('view.cockpit-project-menu.each-board-shows-owner-name-kind-and: each board shows owner, name, kind and one fact, the current one marked [N26]', () => {
  const rows = projectMenuRows(listed, 'b', needs);
  assert.equal(rows.length, 4, 'an unreadable board is not a choice');
  assert.deepEqual(rows.map((row) => [row.owner, row.name, row.kindLabel, row.fact, row.amber, row.current]), [
    ['pullboard-dev', 'pullboard', 'Team board', '5', true, false],
    ['pullboard-dev', 'pullboard', 'Your private board', 'quiet', false, true],
    ['coreyolson', 'pullboard-next', 'Local board', 'quiet', false, false],
    ['pullboard-dev', 'website', 'Team board', 'quiet', false, false],
  ]);
  const html = projectMenuHtml(rows, esc);
  assert.equal(html.match(/<button class="row/g).length, 4);
  assert.match(html, /<button class="row cur"[^>]*data-root="b" aria-current="true"><span class="dot"[^>]*><\/span><b><span>pullboard-dev \/ <\/span>pullboard<\/b><em>quiet<\/em><small>Your private board<\/small>/);
  assert.match(html, /<em class="a">5<\/em><small>Team board<\/small>/, 'the count to answer is amber');
});

test('view.cockpit-project-menu.the-menu-ends-with-all-projects-and: the menu ends with All projects and Add a project; a board is chosen by its root [N26]', () => {
  const html = projectMenuHtml(projectMenuRows(listed, 'a', needs), esc);
  assert.match(html, /<div class="foot"><button[^>]*data-proj-all>All projects<\/button><button[^>]*data-proj-add>Add a project…<\/button><\/div><\/div>$/);
  for (const root of ['a', 'b', 'c', 'd']) assert.ok(html.includes('data-root="' + root + '"'), 'the page switches by data-root, which changes its address');
  assert.doesNotMatch(html, /pullboard init/, 'Add a project says nothing until asked');
  assert.match(projectMenuHtml([], esc, true), /<code>pullboard init<\/code>/);
});

test('view.cockpit-project-menu.the-page-script-carries-the-menu-and: the page script carries the menu and the switcher hook [N26]', () => {
  const script = cockpitProjectMenu();
  assert.match(script, /function projectMenuToggle\(\)/);
  assert.match(script, /const projectMenuRows = function projectMenuRows\(/);
  // The page runs the text of these functions alone, so they must hold everything they read.
  const run = new Function('document', '$', 'data', 'view', 'needCount', 'esc', script + '; return projectMenuHtml(projectMenuRows(data.projects, view.root, needCount), esc);');
  const html = run({ addEventListener() {} }, () => null, { projects: listed }, { root: 'b' }, needs, esc);
  assert.match(html, /Your private board/);
});
