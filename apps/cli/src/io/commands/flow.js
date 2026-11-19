/** The read-only replay bench: structural history in, deterministic scheduling predictions out [R1,R2,A1]. */
import { fileSystemAdapter } from '../../../../../packages/fs/index.js';
import { resolve } from 'node:path';
import {
  context,
  withBoard,
} from '../entry.js';
import {
  chooseTuning,
  flowStats,
  flowWindowMinutes,
  replayFlow,
  tuneCycleDue,
} from '../../../../../packages/stats/index.js';
import * as store from '../../../../../packages/store/index.js';
import { Refused } from '../../../../../packages/kernel/index.js';

const fs = fileSystemAdapter();

const MINUTE = 60_000;

/**
 * Run `pullboard flow tune [--window <duration>]`: print the cycle clock and the chooser's decision from two adjacent board windows.
 * Why read-only: it reports what the line controller would do and applies nothing, so a person can read it before any setting moves.
 */
function runTune(io, { values }) {
  const ctx = context(io);
  const minutes = flowWindowMinutes(values.window ?? '4h');
  const now = ctx.clock.now().getTime();
  const [previous, current] = withBoard(ctx, board => {
    const history = store.events(board);
    // The windows read the event history alone; the submission counts only feed the all-time recommendation, which this report does not print.
    const counts = { submissions: 0, rejections: 0 };
    return [now - minutes * MINUTE, now].map(at => flowStats(history, null, at, counts, { windowMinutes: minutes }).window);
  });
  const stage = current.constraint.stage ? current.stages[current.constraint.stage] : null;
  // No change is recorded yet, so the clock runs from the start of the earlier window.
  const cycle = tuneCycleDue({ landedSinceChange: previous.landedItems + current.landedItems, lastChangeAt: Date.parse(previous.since),
    oldestWait: stage ? { minutes: stage.worstMinutes, targetMinutes: stage.targetMinutes } : null }, now);
  // No line settings are passed in, so the chooser only names the constraint or reports none.
  const choice = chooseTuning([previous, current], {});
  io.result?.({ windowMinutes: minutes, cycle, choice, constraints: [previous.constraint, current.constraint] });
  io.say(`flow tune: ${cycle.due ? 'due' : 'not due'} (${cycle.reason}); constraint ${current.constraint.stage ?? 'none measured over target'}`);
  io.say(`choice: ${choice.kind}${choice.kind === 'setting' ? ` ${choice.key} ${choice.from} to ${choice.to}` : choice.kind === 'request' ? ` the person decides a ${choice.needs}` : ''}; no setting changed`);
  return 0;
}

/** Read explicit JSON data, never a script, with an actionable refusal for a malformed input. */
function readJson(root, file, label) {
  try { return JSON.parse(fs.readFile(resolve(root, file), 'utf8')); }
  catch { throw new Refused('USAGE', `readable JSON is required for replay ${label}; correct the file and run pullboard flow replay again`); }
}

/** Run `pullboard flow replay`; exported history contains no detail, descriptions, paths or commit strings. */
export function run(io, { first, second, rest, values }) {
  if (first === 'tune' && !second && !rest.length) return runTune(io, { values });
  if (first !== 'replay' || second || rest.length) throw new Refused('USAGE', 'run pullboard flow replay [--history <json>] [--policy <json>] --json, or pullboard flow tune [--window <duration>] --json');
  const ctx = context(io);
  const input = values.history === undefined ? withBoard(ctx, board => ({ version: 1,
    // Do not fetch event_detail: replay/export never reads a title, message, note, path or commit.
    events: board.db.prepare('SELECT event_id, event_kind, event_at, item_id, event_by FROM event ORDER BY event_id').all() })) : readJson(ctx.info.root, values.history, 'history');
  if (input?.version !== 1) throw new Refused('USAGE', 'replay history needs version 1 and an events array exported by pullboard flow replay --json');
  const policy = values.policy === undefined ? undefined : readJson(ctx.info.root, values.policy, 'policy');
  const result = replayFlow(input.events, policy);
  io.result?.(result);
  io.say(`flow replay: ${result.replay.mode}; ${result.replay.items.length} measured, ${result.replay.unmeasured.length} unmeasured`);
  io.say(`landing order: ${result.replay.landingOrder.map(id => `#${id}`).join(', ') || 'none'}`);
  for (const [stage, row] of Object.entries(result.replay.stages)) io.say(`${stage}: ${row.count} measured; fast ${row.fastQuarterMinutes ?? 'unknown'}, median ${row.medianMinutes ?? 'unknown'}, slow ${row.slowQuarterMinutes ?? 'unknown'} minutes`);
  return 0;
}
