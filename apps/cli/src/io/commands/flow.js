/** The read-only replay bench: structural history in, deterministic scheduling predictions out [R1,R2,A1]. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  context,
  withBoard,
} from '../entry.js';
import { replayFlow } from '../../../../../packages/stats/index.js';
import { Refused } from '../../../../../packages/kernel/index.js';

/** Read explicit JSON data, never a script, with an actionable refusal for a malformed input. */
function readJson(root, file, label) {
  try { return JSON.parse(readFileSync(resolve(root, file), 'utf8')); }
  catch { throw new Refused('USAGE', `readable JSON is required for replay ${label}; correct the file and run pullboard flow replay again`); }
}

/** Run `pullboard flow replay`; exported history contains no detail, descriptions, paths or commit strings. */
export function run(io, { first, second, rest, values }) {
  if (first !== 'replay' || second || rest.length) throw new Refused('USAGE', 'run pullboard flow replay [--history <json>] [--policy <json>] --json');
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
