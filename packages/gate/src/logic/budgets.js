/** Apply the person's fixed interaction budgets to the main CI harness report [N40,C7]. */
export const PERF_INTERACTIONS = Object.freeze([
  'firstLoad', 'switchProject', 'tab:shouts', 'tab:spec', 'tab:doctrine', 'tab:activity',
  'tab:roadmap', 'tab:items', 'openSmallItem', 'openLongestHistoryItem', 'search',
]);
export const PERF_BUDGETS = Object.freeze(Object.fromEntries(PERF_INTERACTIONS.map(name =>
  [name, Object.freeze({ medianMs: 100, worstMs: 250 })])));
const IDLE = 'idleWithLiveWrites';

/** Read JSON alone or the harness's JSON followed by its identical Markdown table. */
export function readPerfReport(output) {
  const marker = '\n\n| action |';
  const split = output.indexOf(marker);
  const report = JSON.parse(split < 0 ? output : output.slice(0, split));
  if (split >= 0 && output.slice(split + 2).trim() !== report.table) {
    throw new Error('the JSON and printed harness table disagree');
  }
  return report;
}

/** A measurement is a finite nonnegative number, including a real zero. */
function measured(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Report malformed or missing evidence as errors; exceeding a fixed interaction budget only warns. */
export function evaluatePerfBudgets(report, budgets = PERF_BUDGETS) {
  const errors = [], warnings = [], interactions = [], observations = [];
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    return { errors: ['the harness report must be an object'], warnings, interactions, observations };
  }
  if (report.version !== 1) errors.push('the harness report version must be 1');
  if (report.size !== 3000) errors.push('the measured stress board must have 3000 items');
  if (report.projects !== 8) errors.push('the measured home must have eight projects');
  if (!Number.isSafeInteger(report.runs) || report.runs < 1) errors.push('the harness run count is missing or invalid');
  if (report.idleMs !== 30_000) errors.push(IDLE + ' must record its fixed 30000 ms observation window');
  if (typeof report.table !== 'string' || !report.table.startsWith('| action |')) errors.push('the harness table is missing');
  if (!Array.isArray(report.actions)) {
    errors.push('the measured actions are missing');
    return { errors, warnings, interactions, observations };
  }
  const actions = new Map();
  for (const action of report.actions) {
    if (!action || typeof action.name !== 'string') { errors.push('a measured action has no name'); continue; }
    if (actions.has(action.name)) { errors.push('duplicate measured action ' + JSON.stringify(action.name)); continue; }
    actions.set(action.name, action);
    if (action.name !== IDLE && !Object.hasOwn(budgets, action.name)) {
      errors.push('measured action ' + JSON.stringify(action.name) + ' has no budget entry');
    }
    if (action.name !== IDLE && !PERF_INTERACTIONS.includes(action.name)) {
      errors.push('unknown measured interaction ' + JSON.stringify(action.name));
    }
    if (!measured(action.medianMs) || !measured(action.worstMs) || action.medianMs > action.worstMs) {
      errors.push('invalid median/worst measurement for ' + JSON.stringify(action.name));
    }
  }
  for (const name of PERF_INTERACTIONS) {
    if (!Object.hasOwn(budgets, name)) errors.push('required interaction ' + name + ' has no budget entry');
    if (!actions.has(name)) errors.push('budget entry ' + name + ' has no measured action');
  }
  for (const [name, budget] of Object.entries(budgets)) {
    if (!PERF_INTERACTIONS.includes(name)) errors.push('unknown budget entry ' + JSON.stringify(name));
    if (!actions.has(name) && !PERF_INTERACTIONS.includes(name)) errors.push('budget entry ' + JSON.stringify(name) + ' has no measured action');
    if (!budget || budget.medianMs !== 100 || budget.worstMs !== 250) {
      errors.push('budget for ' + JSON.stringify(name) + ' must remain median 100 ms and worst 250 ms');
      continue;
    }
    const action = actions.get(name);
    if (!action || !measured(action.medianMs) || !measured(action.worstMs) || action.medianMs > action.worstMs) continue;
    const over = action.medianMs > budget.medianMs || action.worstMs > budget.worstMs;
    const row = { name, medianMs: action.medianMs, worstMs: action.worstMs, budget, status: over ? 'warning' : 'within budget' };
    interactions.push(row);
    if (over) warnings.push(row);
  }
  const idle = actions.get(IDLE);
  if (!idle) errors.push('missing observation ' + IDLE);
  else if (!Array.isArray(idle.samples) || idle.samples.length !== report.runs) errors.push(IDLE + ' is missing per-run live-render observations');
  else {
    const runs = [];
    for (const [index, sample] of idle.samples.entries()) {
      if (!sample || !Number.isSafeInteger(sample.liveWrites) || sample.liveWrites < 0
        || !Array.isArray(sample.liveWriteOffsetsMs) || sample.liveWriteOffsetsMs.length !== sample.liveWrites
        || !sample.liveWriteOffsetsMs.every(measured)
        || !Array.isArray(sample.renderedAtMs) || sample.renderedAtMs.length !== sample.liveWrites
        || !sample.renderedAtMs.every(value => value === null || measured(value))) {
        errors.push(IDLE + ' run ' + (index + 1) + ' has malformed live-render times');
        continue;
      }
      runs.push({ run: index + 1, liveWriteOffsetsMs: sample.liveWriteOffsetsMs, renderedAtMs: sample.renderedAtMs });
    }
    observations.push({ name: IDLE, windowMs: report.idleMs, budget: null, runs });
  }
  return { errors, warnings, interactions, observations };
}

/** Render budgets separately from the unbudgeted idle window and its raw observed render offsets. */
export function perfBudgetTable(result) {
  const lines = [
    result.errors.length ? 'Report validation: invalid.' : 'Report validation: complete.',
    ...result.errors.map(error => 'Error: ' + error),
    '',
    '| action | median ms | worst ms | median budget ms | worst budget ms | result |',
    '|---|---:|---:|---:|---:|---|',
    ...result.interactions.map(row => '| ' + row.name + ' | ' + row.medianMs + ' | ' + row.worstMs
      + ' | ' + row.budget.medianMs + ' | ' + row.budget.worstMs + ' | ' + row.status + ' |'),
  ];
  for (const observation of result.observations) {
    lines.push('| ' + observation.name + ' | — | — | none | none | ' + observation.windowMs + ' ms observation; no latency budget |');
    lines.push('', '| idleWithLiveWrites run | live-write offsets ms | rendered offsets ms |',
      '|---:|---|---|');
    for (const run of observation.runs) {
      lines.push('| ' + run.run + ' | ' + run.liveWriteOffsetsMs.join(', ') + ' | '
        + run.renderedAtMs.map(value => value === null ? 'not observed' : value).join(', ') + ' |');
    }
  }
  return lines.join('\n');
}
