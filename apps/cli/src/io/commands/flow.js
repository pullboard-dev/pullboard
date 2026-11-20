/** The read-only replay bench: structural history in, deterministic scheduling predictions out [R1,R2,A1]. */
import { fileSystemAdapter } from '../../../../../packages/fs/index.js';
import { resolve } from 'node:path';
import {
  actOn,
  context,
  ordered,
  withBoard,
} from '../entry.js';
import {
  chooseTuning,
  flowStats,
  flowWindowMinutes,
  lastTuneChange,
  replayFlow,
  replayTuned,
  revertTuning,
  tuneCycleDue,
  tuneFixes,
  tuneRecord,
} from '../../../../../packages/stats/index.js';
import * as store from '../../../../../packages/store/index.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import { lineTuneEnabled } from '../../../../../packages/config/index.js';
import { lineSettings } from '../../../../../packages/state/light.js';
import { LINE_SETTING_DEFINITIONS } from '../../../../../packages/queue/light.js';

const fs = fileSystemAdapter();

const MINUTE = 60_000;

/** The two adjacent windows ending at `now - minutes` and `now`, and the cycle clock over them. */
function tuneWindows(board, minutes, now) {
  const history = store.events(board);
  // The windows read the event history alone; the submission counts only feed the all-time recommendation, which this report does not print.
  const counts = { submissions: 0, rejections: 0 };
  const [previous, current] = [now - minutes * MINUTE, now].map(at => flowStats(history, null, at, counts, { windowMinutes: minutes }).window);
  const stage = current.constraint.stage ? current.stages[current.constraint.stage] : null;
  // No change time is kept with the record yet, so the clock runs from the start of the earlier window.
  const cycle = tuneCycleDue({ landedSinceChange: previous.landedItems + current.landedItems, lastChangeAt: Date.parse(previous.since),
    oldestWait: stage ? { minutes: stage.worstMinutes, targetMinutes: stage.targetMinutes } : null }, now);
  return { history, previous, current, cycle };
}

/**
 * Run `pullboard flow tune [--window <duration>]`: print the cycle clock and the chooser's decision from two adjacent board windows.
 * Why read-only: it reports what the line controller would do and applies nothing, so a person can read it before any setting moves.
 */
function runTune(io, { values }) {
  const ctx = context(io);
  const minutes = flowWindowMinutes(values.window ?? '4h');
  const now = ctx.clock.now().getTime();
  const { previous, current, cycle } = withBoard(ctx, board => tuneWindows(board, minutes, now));
  // No line settings are passed in, so the chooser only names the constraint or reports none.
  const choice = chooseTuning([previous, current], {});
  io.result?.({ windowMinutes: minutes, cycle, choice, constraints: [previous.constraint, current.constraint] });
  io.say(`flow tune: ${cycle.due ? 'due' : 'not due'} (${cycle.reason}); constraint ${current.constraint.stage ?? 'none measured over target'}`);
  io.say(`choice: ${choice.kind}${choice.kind === 'setting' ? ` ${choice.key} ${choice.from} to ${choice.to}` : choice.kind === 'request' ? ` the person decides a ${choice.needs}` : ''}; no setting changed`);
  return 0;
}

/**
 * Run `pullboard flow tune --apply`: write the one line setting change a due cycle chooses, or revert the last one.
 * Why the setLineSetting move: it is the same ordered, coordinator-only writer `pullboard settings line` uses, so a tuned change is
 * recorded, replayed and refused exactly like a hand-made one. Nothing is written with line.tune off or a cycle not due.
 */
export function runTuneApply(io, { values }) {
  const minutes = flowWindowMinutes(values.window ?? '4h');
  return actOn(io, async (ctx, board, me) => {
    const now = ctx.clock.now().getTime();
    if (!lineTuneEnabled()) {
      io.result?.({ applied: false, reason: 'line.tune is off', windowMinutes: minutes, cycle: null, choice: null, constraints: [] });
      io.say('flow tune --apply: line.tune is off; no setting changed');
      return 0;
    }
    const { history, previous, current, cycle } = tuneWindows(board, minutes, now);
    if (!cycle.due) {
      io.result?.({ applied: false, reason: 'not due', windowMinutes: minutes, cycle, choice: null, constraints: [previous.constraint, current.constraint] });
      io.say(`flow tune --apply: not due (${cycle.reason}); no setting changed`);
      return 0;
    }
    const window = { windowMinutes: minutes, overTargetMinutes: current.constraint.overTargetMinutes, landed: current.landedItems };
    const last = lastTuneChange(history);
    let choice;
    if (last && revertTuning(last, last.before, window) === 'revert') choice = { kind: 'setting', stage: last.stage, key: last.key, from: last.to, to: last.from };
    else choice = chooseTuning([previous, current], tuneFixes(lineSettings(board), LINE_SETTING_DEFINITIONS));
    if (choice.kind !== 'setting') {
      io.result?.({ applied: false, windowMinutes: minutes, cycle, choice, constraints: [previous.constraint, current.constraint] });
      io.say(choice.kind === 'request' ? `flow tune --apply: the person decides a ${choice.needs} for ${choice.stage}; no setting changed` : 'flow tune --apply: no change chosen; no setting changed');
      return 0;
    }
    const record = tuneRecord(choice, window);
    const change = await ordered(ctx, board, 'setLineSetting', [{ agentId: me.id, key: choice.key, value: choice.to, reason: record.reason, window: record.window }]);
    io.result?.({ applied: true, windowMinutes: minutes, cycle, choice, constraints: [previous.constraint, current.constraint], change });
    io.say(`flow tune --apply: ${choice.key} ${choice.from} to ${choice.to} (${choice.stage}); recorded on this board`);
    return 0;
  });
}

/** Read explicit JSON data, never a script, with an actionable refusal for a malformed input. */
function readJson(root, file, label) {
  try { return JSON.parse(fs.readFile(resolve(root, file), 'utf8')); }
  catch { throw new Refused('USAGE', `readable JSON is required for replay ${label}; correct the file and run pullboard flow replay again`); }
}

/** The median minutes from claim to landing over a replay's measured items; null with none. */
function medianClaimToLanded(side) {
  const spans = side.replay.items.map(item => (Date.parse(item.landedAt) - Date.parse(item.claimAt)) / MINUTE).sort((a, b) => a - b);
  const middle = Math.floor(spans.length / 2);
  return spans.length ? (spans.length % 2 ? spans[middle] : (spans[middle - 1] + spans[middle]) / 2) : null;
}

/** Run `pullboard flow replay --tune`: replay the history with the line tuner closing cycles and print the tuned run beside the untuned run. */
function runReplayTuned(io, events, policy) {
  const result = replayTuned(events, policy);
  io.result?.(result);
  io.say(`flow replay --tune: ${result.changes.length} change${result.changes.length === 1 ? '' : 's'}; tuned rows after a change are predicted`);
  for (const [name, side] of [['untuned', result.untuned], ['tuned', result.tuned]]) {
    io.say(`${name}: ${side.replay.mode}; ${side.replay.items.length} measured; median claim to landed ${medianClaimToLanded(side) ?? 'unknown'} minutes`);
    for (const [stage, row] of Object.entries(side.replay.stages)) io.say(`${name} ${stage}: median ${row.medianMinutes ?? 'unknown'} minutes`);
  }
  for (const change of result.changes) io.say(`${change.at}: ${change.kind} ${change.key} ${change.from} to ${change.to} (${change.stage}, ${change.reason})`);
  return 0;
}

/** Run `pullboard flow replay`; exported history contains no detail, descriptions, paths or commit strings. */
export function run(io, { first, second, rest, values }) {
  if (first === 'tune' && !second && !rest.length) return values.apply ? runTuneApply(io, { values }) : runTune(io, { values });
  if (first !== 'replay' || second || rest.length) throw new Refused('USAGE', 'run pullboard flow replay [--history <json>] [--policy <json>] --json, or pullboard flow tune [--window <duration>] --json');
  const ctx = context(io);
  const input = values.history === undefined ? withBoard(ctx, board => ({ version: 1,
    // Do not fetch event_detail: replay/export never reads a title, message, note, path or commit.
    events: board.db.prepare('SELECT event_id, event_kind, event_at, item_id, event_by FROM event ORDER BY event_id').all() })) : readJson(ctx.info.root, values.history, 'history');
  if (input?.version !== 1) throw new Refused('USAGE', 'replay history needs version 1 and an events array exported by pullboard flow replay --json');
  const policy = values.policy === undefined ? undefined : readJson(ctx.info.root, values.policy, 'policy');
  if (values.tune) return runReplayTuned(io, input.events, policy);
  const result = replayFlow(input.events, policy);
  io.result?.(result);
  io.say(`flow replay: ${result.replay.mode}; ${result.replay.items.length} measured, ${result.replay.unmeasured.length} unmeasured`);
  io.say(`landing order: ${result.replay.landingOrder.map(id => `#${id}`).join(', ') || 'none'}`);
  for (const [stage, row] of Object.entries(result.replay.stages)) io.say(`${stage}: ${row.count} measured; fast ${row.fastQuarterMinutes ?? 'unknown'}, median ${row.medianMinutes ?? 'unknown'}, slow ${row.slowQuarterMinutes ?? 'unknown'} minutes`);
  return 0;
}
