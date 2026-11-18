/** Board-scoped line controls use ordered moves; the existing settings command still owns machine controls. */
import { lineSettings } from '../../../../../state/light.js';
import { LINE_SETTING_DEFINITIONS } from '../../../../../queue/index.js';
import { Refused } from '../../../../../kernel/light.js';

/** Decode explicit triggering observations without confusing stats --window durations with this command's JSON. */
function parseWindow(value) {
  try { return JSON.parse(value); }
  catch { throw new Refused('LINE_SETTING_WINDOW', 'use --window with a JSON object of measured numbers, for example \'{"windowMinutes":60,"activeReviewers":2}\''); }
}

/**
 * Read all board controls or record one coordinator change; no controller enforcement is enabled here.
 * The settings command passes the CLI's context, board read and ordered-move helpers as `cli`, so seats never load the CLI.
 */
export function lineSettingsCommand(io, { second, rest, values = {} }, { actOn, context, ordered, withBoardRead }) {
  if (!second && !rest.length) {
    const ctx = context(io);
    const settings = withBoardRead(ctx, lineSettings);
    io.result?.({ lineSettings: settings, ranges: LINE_SETTING_DEFINITIONS });
    for (const [key, value] of Object.entries(settings)) io.say(`${key}: ${value === false ? 'off' : value}`);
    return 0;
  }
  if (!second || rest.length !== 1) throw new Refused('USAGE', 'pullboard settings line <name> <value> --reason "why" --window \'{"windowMinutes":60}\'');
  const value = second === 'focusMilestone' ? (rest[0] === 'off' ? false : rest[0]) : rest[0] === 'ab' ? 'ab' : rest[0] === 'on' ? true : rest[0] === 'off' ? false : Number(rest[0]);
  return actOn(io, async (ctx, board, me) => {
    const change = await ordered(ctx, board, 'setLineSetting', [{ agentId: me.id, key: second, value,
      reason: values.reason, window: parseWindow(values.window) }]);
    io.result?.({ lineSettings: lineSettings(board), change });
    io.say(`${second}: ${value === false ? 'off' : value}; recorded on this board`);
    return 0;
  });
}
