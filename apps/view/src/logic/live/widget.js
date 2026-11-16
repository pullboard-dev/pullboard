/**
 * The /live runners widget [N26]: one dense row per runner with its CPU, RAM, a fire when it is busy and its item with
 * test progress, then one row per running task with how many agents work it and a bar that fills with its tests.
 *
 * Why: on 11 Nov the person said the widget was not dense enough, its columns moved, and its bar did not show progress.
 * Every column has a width set in the table's colgroup, so no refresh can resize one; this file only reads the public
 * snapshot (publicRunners), so it never sees a host, address or user name.
 */
import { esc } from '../main.js';

/** The runner table's columns: key, header and fixed width in characters; the bar column takes the rest. */
export const RUNNER_COLUMNS = Object.freeze([
  ['runner', 'Runner', 7], ['fire', '', 3], ['cpu', 'CPU', 5], ['ram', 'RAM', 5],
  ['task', 'Item', 14], ['tests', 'Tests', 11], ['bar', 'Progress', null], ['left', 'Left', 6],
]);

/** The task table's columns, fixed the same way. */
export const TASK_COLUMNS = Object.freeze([
  ['task', 'Item', 14], ['agents', 'Agents', 7], ['tests', 'Tests', 11], ['failing', 'Red', 5], ['bar', 'Progress', null], ['left', 'Left', 6],
]);

/** One class per fixed column, so a width comes from the stylesheet and never from a style attribute. */
const COLUMN_WIDTH_RULES = [...new Map([...RUNNER_COLUMNS, ...TASK_COLUMNS].filter(([, , width]) => width).map(([key, , width]) => [key, width])).entries()]
  .map(([key, width]) => `.lr-c-${key}{width:${width + 2}ch}`).join('\n');

/** One class per whole percent, so a bar's fill comes from the stylesheet and never from a style attribute. */
const FILL_WIDTH_RULES = Array.from({ length: 101 }, (_, percent) => `.lr-w-${percent}{width:${percent}%}`).join('');

/** The widget's styles: solid fills, tabular figures and a fixed table layout. */
export const RUNNERS_WIDGET_CSS = `.lr{width:100%;table-layout:fixed;border-collapse:collapse;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums}
.lr th,.lr td{padding:1px 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:right}
.lr th{font-weight:600;color:var(--muted,#6b7280)}
.lr .lr-l{text-align:left}
.lr tr.lr-idle td{color:var(--muted,#6b7280)}
.lr-bar{height:8px;background:var(--track,#e5e7eb);border-radius:2px;overflow:hidden}
.lr-fill{height:100%;background:var(--ok,#16a34a)}
.lr-fill.lr-red{background:var(--bad,#dc2626)}
.lr-cap{margin:10px 0 2px;font:600 12px/1.4 system-ui,sans-serif}
${COLUMN_WIDTH_RULES}
${FILL_WIDTH_RULES}`;

/** The colgroup that fixes a table's column widths, the same for every snapshot. */
const colgroup = columns => `<colgroup>${columns.map(([key]) => `<col class="lr-c-${key}">`).join('')}</colgroup>`;

/** The left-aligned class for the text columns, nothing for the right-aligned figures. */
const align = key => ['task', 'bar'].includes(key) ? ' class="lr-l"' : '';

/** A table header row. */
const head = columns => `<thead><tr>${columns.map(([key, label]) => `<th${align(key)}>${esc(label)}</th>`).join('')}</tr></thead>`;

/** A whole percent or a dash. */
const pct = value => Number.isFinite(value) ? `${value}%` : '–';

/** A count or a dash. */
const num = value => Number.isFinite(value) ? String(value) : '–';

/** "gate #52" for a job or run, or a dash when it names no item. */
const taskLabel = job => job ? `${job.kind ?? 'work'}${job.item ? ` #${job.item}` : ''}` : '–';

/** "done/selected", or what is known of it. */
const testsLabel = job => job ? `${num(job.done)}/${num(job.selected)}` : '–';

/** Minutes left as "4m", or a dash. */
const leftLabel = job => job && Number.isFinite(job.minutesLeft) ? `${job.minutesLeft}m` : '–';

/** The share of selected tests finished, 0 to 100, or 0 when either count is unknown. */
export function progressPercent(job) {
  if (!job || !Number.isFinite(job.done) || !Number.isFinite(job.selected) || job.selected <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round(job.done / job.selected * 100)));
}

/** A bar whose solid fill is the finished share of the tests; it turns red once any test fails. */
function bar(job) {
  const filled = progressPercent(job);
  const red = Number.isFinite(job?.failing) && job.failing > 0;
  return `<div class="lr-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${filled}"><div class="lr-fill${red ? ' lr-red' : ''} lr-w-${filled}"></div></div>`;
}

/** One table row from cells keyed by column. */
const row = (columns, cells, className = '') => `<tr${className ? ` class="${className}"` : ''}>${columns.map(([key]) =>
  `<td${align(key)}>${cells[key] ?? ''}</td>`).join('')}</tr>`;

/**
 * The widget's HTML from the public live snapshot: a runner table and a task table, both in fixed-width columns.
 *
 * @param {{ runners?: { runner: number, busy?: boolean, state?: string, cpu?: number | null, ram?: number | null, jobs?: object[] }[], runs?: object[] } | null} live
 * @returns {string}
 */
export function renderRunnersWidget(live) {
  const runners = Array.isArray(live?.runners) ? live.runners : [];
  const runs = Array.isArray(live?.runs) ? live.runs : [];
  const runnerRows = runners.map(runner => {
    const busy = runner.busy ?? runner.state === 'busy';
    const job = runner.jobs?.[0] ?? null;
    const more = (runner.jobs?.length ?? 0) > 1 ? ` +${runner.jobs.length - 1}` : '';
    return row(RUNNER_COLUMNS, { runner: `#${esc(runner.runner)}`, fire: busy ? '<span class="lr-fire" title="busy" aria-label="busy">&#x1F525;</span>' : '',
      cpu: pct(runner.cpu), ram: pct(runner.ram), task: esc(taskLabel(job) + more), tests: testsLabel(job), bar: job ? bar(job) : '', left: leftLabel(job) }, busy ? '' : 'lr-idle');
  });
  const taskRows = runs.map(run => row(TASK_COLUMNS, { task: esc(taskLabel(run)), agents: String(Array.isArray(run.runners) ? run.runners.length : 0),
    tests: testsLabel(run), failing: num(run.failing), bar: bar(run), left: leftLabel(run) }));
  const busyCount = runners.filter(runner => runner.busy ?? runner.state === 'busy').length;
  return `<section class="lr-w"><div class="lr-cap">Runners ${busyCount}/${runners.length} busy</div>`
    + `<table class="lr lr-runners">${colgroup(RUNNER_COLUMNS)}${head(RUNNER_COLUMNS)}<tbody>${runnerRows.join('')}</tbody></table>`
    + `<div class="lr-cap">Tasks ${runs.length}</div>`
    + `<table class="lr lr-tasks">${colgroup(TASK_COLUMNS)}${head(TASK_COLUMNS)}<tbody>${taskRows.join('')}</tbody></table></section>`;
}
