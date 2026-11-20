/** The /live runners widget is dense: per runner CPU, RAM, fire and its item with test progress, in fixed columns [N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderRunnersWidget } from '../../../src/logic/live/widget.js';
import { RUNNER_COLUMNS } from '../../../src/logic/live/widget.js';
import { TASK_COLUMNS } from '../../../src/logic/live/widget.js';
import { RUNNERS_WIDGET_CSS } from '../../../src/logic/live/widget.js';
import { progressPercent } from '../../../src/logic/live/widget.js';

/** A public live snapshot: runner 1 on a landing, runner 2 idle, runner 3 on the same landing, runner 4 on a gate. */
const quiet = {
  runners: [
    { runner: 1, state: 'busy', busy: true, cpu: 92, ram: 61, jobs: [{ kind: 'landing', item: 1196, selected: 1579, done: 400, failing: 0, minutesLeft: 31 }] },
    { runner: 2, state: 'idle', busy: false, cpu: 3, ram: 20, jobs: [] },
    { runner: 3, state: 'busy', busy: true, cpu: null, ram: null, jobs: [{ kind: 'landing', item: 1196, selected: 1579, done: 400, failing: 0, minutesLeft: 31 }] },
    { runner: 4, state: 'busy', busy: true, cpu: 40, ram: 35, jobs: [{ kind: 'gate', item: 52, selected: 3, done: null, failing: null, minutesLeft: null }] },
  ],
  runs: [
    { kind: 'landing', item: 1196, items: [1196, 1197], runners: [1, 3], selected: 1579, done: 400, failing: 0, minutesLeft: 31 },
    { kind: 'gate', item: 52, items: [52], runners: [4], selected: 3, done: null, failing: null, minutesLeft: null },
  ],
};

/** A later refresh with longer numbers, a red test, an added runner and a run with a long item id. */
const busier = {
  runners: [...quiet.runners.map(runner => ({ ...runner, cpu: 100, ram: 100 })),
    { runner: 5, state: 'busy', busy: true, cpu: 7, ram: 8, jobs: [{ kind: 'test run', item: 123456, selected: 12, done: 6, failing: 2, minutesLeft: 120 }, { kind: 'gate', item: 9, selected: 1, done: 0, failing: 0, minutesLeft: 1 }] }],
  runs: [{ ...quiet.runs[0], done: 1578, failing: 12 }, { kind: 'test run', item: 123456, items: [123456], runners: [5], selected: 12, done: 6, failing: 2, minutesLeft: 120 }],
};

/** The rows of one table in the widget, each as its list of cell contents. */
function rows(html, table) {
  const body = new RegExp(`<table class="lr lr-${table}">[\\s\\S]*?<tbody>([\\s\\S]*?)</tbody>`, 'u').exec(html)[1];
  return [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gu)].map(([, cells]) => [...cells.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gu)].map(([, cell]) => cell));
}

/** A table's colgroup markup. */
const colgroupOf = (html, table) => new RegExp(`<table class="lr lr-${table}">(<colgroup>[\\s\\S]*?</colgroup>)`, 'u').exec(html)[1];

test('view.live-widget.n-5885-clause-2-each-runner-row-renders: #5885 clause 2: each runner row renders cpu, ram, fire and item progress in fixed-width columns that do not change size between refreshes [N26]', () => {
  const first = renderRunnersWidget(quiet), second = renderRunnersWidget(busier);
  const runnerRows = rows(first, 'runners');
  assert.equal(runnerRows.length, 4);
  for (const cells of [...runnerRows, ...rows(second, 'runners')]) assert.equal(cells.length, RUNNER_COLUMNS.length, 'every runner row fills every column');
  const [one, two, three, four] = runnerRows;
  assert.deepEqual([one[0], one[2], one[3], one[4], one[5], one[7]], ['#1', '92%', '61%', 'landing #1196', '400/1579', '31m']);
  assert.match(one[1], /&#x1F525;/u, 'a busy runner shows a fire');
  assert.match(one[6], /aria-valuenow="25"/u, 'the item progress bar shows 400 of 1579 tests');
  assert.equal(two[1], '', 'an idle runner shows no fire');
  assert.deepEqual([three[2], three[3]], ['–', '–'], 'an unsampled runner shows dashes, never a blank that shifts the row');
  assert.deepEqual([four[4], four[5]], ['gate #52', '–/3']);
  assert.equal(first.match(/<table class="lr lr-(?:runners|tasks)">/gu).length, 2, 'both tables lay columns out by the colgroup, never by their contents');
  assert.doesNotMatch(first, /style=/u, 'the widget sets no inline style: widths and fills are classes');
  for (const [key, , width] of [...RUNNER_COLUMNS, ...TASK_COLUMNS].filter(([, , width]) => width)) assert.ok(RUNNERS_WIDGET_CSS.includes(`.lr-c-${key}{width:${width + 2}ch}`), `the ${key} column width is a class`);
  assert.match(RUNNERS_WIDGET_CSS, /\.lr\{[^}]*table-layout:fixed/u);
  assert.equal(/gradient|border-left|border-right/u.test(RUNNERS_WIDGET_CSS), false, 'the styles hold no gradient and no accent edge');
  assert.equal(colgroupOf(first, 'runners'), colgroupOf(second, 'runners'), 'the runner columns keep their widths when every number changes');
  assert.equal(colgroupOf(first, 'tasks'), colgroupOf(second, 'tasks'), 'the task columns keep their widths');
  assert.equal(RUNNER_COLUMNS.filter(([, , width]) => width === null).length, 1, 'only the bar column takes the rest of the width');
  assert.equal(/gradient|border-left|border-right/u.test(first), false, 'no gradients and no accent edge');
});

test('view.live-widget.n-5885-clause-3-the-widget-counts-agents: #5885 clause 3: the widget counts agents per task and shows a progress bar that fills with test progress [N26]', () => {
  const first = rows(renderRunnersWidget(quiet), 'tasks'), second = rows(renderRunnersWidget(busier), 'tasks');
  for (const cells of [...first, ...second]) assert.equal(cells.length, TASK_COLUMNS.length);
  const agents = TASK_COLUMNS.findIndex(([key]) => key === 'agents'), barAt = TASK_COLUMNS.findIndex(([key]) => key === 'bar');
  assert.deepEqual(first.map(cells => [cells[0], cells[agents]]), [['landing #1196', '2'], ['gate #52', '1']], 'two agents on the landing, one on the gate');
  const fill = cells => Number(/lr-w-(\d+)/u.exec(cells[barAt])[1]);
  assert.deepEqual(first.map(fill), [25, 0], 'the bar fills to the finished share and stays empty while nothing is counted');
  assert.equal(fill(second[0]), 100, 'the same landing at 1578 of 1579 fills the bar');
  assert.match(second[0][barAt], /lr-fill lr-red/u, 'a run with red tests fills red');
  assert.doesNotMatch(first[0][barAt], /lr-red/u);
  assert.deepEqual([progressPercent({ done: 6, selected: 12 }), progressPercent({ done: 3, selected: 0 }), progressPercent(null)], [50, 0, 0]);
  assert.match(renderRunnersWidget(quiet), /Runners 3\/4 busy[\s\S]*Tasks 2/u);
});
