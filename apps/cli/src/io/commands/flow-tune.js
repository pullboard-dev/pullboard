/** The read-only flow tune report: the line controller's cycle clock and chosen change from two adjacent board windows [C7,#1099]. */
import {
  context,
  withBoard,
} from '../entry.js';
import {
  chooseTuning,
  flowStats,
  flowWindowMinutes,
  tuneCycleDue,
} from '../../../../../packages/stats/index.js';
import * as store from '../../../../../packages/store/index.js';

const MINUTE = 60_000;

/**
 * Run `pullboard flow tune [--window <duration>]`: print the cycle clock and the chooser's decision from two adjacent board windows.
 * Why read-only: it reports what the line controller would do and applies nothing, so a person can read it before any setting moves.
 */
export function runTune(io, { values }) {
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
