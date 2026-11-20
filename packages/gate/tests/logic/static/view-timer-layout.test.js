/** @pullboard-test-input source-cell gate */
/** @pullboard-world-pin reads the seeded view-timer ceilings file in the gate cell to prove it holds one site in boards.js [C7,#9523]. */
/** The view-timer-layout check refuses a timer over 1 s that hides, removes or re-renders, holds today's sites at a ceiling that only falls, and reports nothing when off [C7,#9523]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  VIEW_TIMER_CEILING_FILE,
  timerSites,
  viewTimerLayoutRows,
} from '../../../src/io/adapter-lints/view-timer-layout.js';

const FILE = 'apps/view/src/io/page/one.js';
const rowsOf = source => [{ file: FILE, source }];
const ON = { enabled: true };

test('gate.logic-static-view-timer-layout.with-the-setting-on-a-timer: clause 1: with the setting on, a timer over 1 s whose callback sets hidden, removes a node or calls render() fails naming the file and line [C7,#9523]', () => {
  const hides = 'function a() {\n  setTimeout(() => { panel.hidden = true; }, 1500);\n}\n';
  const removes = 'setTimeout(() => { note.remove(); }, 2_000);\n';
  const renders = 'setTimeout(() => { if (open) render(); }, 3000);\n';
  const attribute = "setInterval(() => { box.setAttribute('hidden', ''); }, 4000);\n";
  assert.deepEqual(viewTimerLayoutRows(rowsOf(hides), ON).map(row => row.split(': ')[0]), [`${FILE}:2`]);
  for (const source of [removes, renders, attribute]) assert.equal(viewTimerLayoutRows(rowsOf(source), ON).length, 1, source);
  assert.match(viewTimerLayoutRows(rowsOf(hides), ON)[0], /^apps\/view\/src\/io\/page\/one\.js:2: timer over 1000 ms hides, removes or re-renders/u);
});

test('gate.logic-static-view-timer-layout.a-timer-of-1-s-or: clause 1: a timer of 1 s or less, one that only changes a class, and a named callback are not sites; a stays line is accepted [C7,#9523]', () => {
  assert.deepEqual(viewTimerLayoutRows(rowsOf('setTimeout(() => { render(); }, 1000);\n'), ON), [], 'exactly 1 s is allowed');
  assert.deepEqual(viewTimerLayoutRows(rowsOf("setTimeout(() => { el.classList.remove('on'); }, 1300);\n"), ON), [], 'a class change is not a layout shift');
  assert.deepEqual(viewTimerLayoutRows(rowsOf('setInterval(refreshAges, 60000);\n'), ON), [], 'a named callback is not read');
  assert.deepEqual(viewTimerLayoutRows(rowsOf('// setTimeout(() => { render(); }, 5000);\n'), ON), [], 'a comment is not a timer');
  assert.deepEqual(timerSites('setTimeout(() => { render(); }, 5000); // stays: the person asked for the delay\n'), [{ line: 1, stays: true }]);
  assert.deepEqual(viewTimerLayoutRows(rowsOf('setTimeout(() => { render(); }, 5000); // stays: the person asked for the delay\n'), ON), []);
});

test('gate.logic-static-view-timer-layout.the-one-site-that-exists-today: clause 2: the one site that exists today is held at a per-file ceiling; a new site fails and a ceiling above the sites left must fall [C7,#9523]', () => {
  const ceilings = readFileSync(join(import.meta.dirname, '../../../data/ceilings/view-timer-layout.json'), 'utf8');
  assert.equal(VIEW_TIMER_CEILING_FILE, 'packages/gate/data/ceilings/view-timer-layout.json');
  assert.deepEqual(JSON.parse(ceilings).sites, { 'apps/view/src/io/page/boards.js': 1 });
  const held = 'setTimeout(() => { render(); }, 3000);\n';
  const boards = { file: 'apps/view/src/io/page/boards.js', source: held };
  assert.deepEqual(viewTimerLayoutRows([boards], { enabled: true, ceilings }), [], 'the held site passes');
  const grown = { file: boards.file, source: held + held };
  assert.equal(viewTimerLayoutRows([grown], { enabled: true, ceilings }).length, 2, 'a second site fails and names both');
  const fresh = viewTimerLayoutRows(rowsOf(held), { enabled: true, ceilings });
  assert.equal(fresh.filter(row => row.startsWith(`${FILE}:`)).length, 1, 'a new file has a ceiling of 0');
  const fallen = viewTimerLayoutRows([{ file: boards.file, source: 'export const x = 1;\n' }], { enabled: true, ceilings });
  assert.match(fallen[0], /holds 1 sites but 0 remain; lower the ceiling, it only falls/u);
  assert.match(viewTimerLayoutRows([], { enabled: true, ceilings })[0], /for a file that is gone; delete its row/u);
});

test('gate.logic-static-view-timer-layout.with-the-setting-off-or-not: clause 3: with the setting off or not exactly true, the check reports nothing [C7,#9523]', () => {
  const source = 'setTimeout(() => { render(); }, 5000);\n';
  assert.deepEqual(viewTimerLayoutRows(rowsOf(source)), []);
  assert.deepEqual(viewTimerLayoutRows(rowsOf(source), { enabled: false }), []);
  assert.deepEqual(viewTimerLayoutRows(rowsOf(source), { enabled: 'true' }), []);
  assert.deepEqual(viewTimerLayoutRows(rowsOf(source), { enabled: 1 }), []);
});
