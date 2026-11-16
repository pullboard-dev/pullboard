/** The pullboard coordinate command: resume the coordinator, then say how the person adds agents; it writes nothing, so it is safe to run twice [C7,#8515]. */
import { Refused } from '../../../../../packages/kernel/index.js';
import { listItems } from '../../../../../packages/store/index.js';
import { context } from '../entry.js';
import { listenerLines } from '../coordinate/listener.js';
import { startLines } from '../coordinate/listener.js';
import { withBoardRead } from '../board/read.js';
import { resumeHere } from './resume.js';

/**
 * The lanes that have open work, in the order their first item appears.
 *
 * @param {any[]} items - Board items.
 * @returns {string[]}
 */
export function lanesWithWork(items) {
  return [...new Set(items.filter(item => item.item_status === 'open').map(item => item.item_lane))];
}

/**
 * The lines that tell the person how to add agents: one worktree opening line per lane with open work, then the loop each agent runs.
 *
 * @param {string[]} lanes - Lanes with open work.
 * @returns {string[]}
 */
export function addAgentLines(lanes) {
  return [
    'To add agents:',
    ...(lanes.length ? lanes.map(lane => `  pullboard worktree ${lane} --model "<model name>"   then start an agent with the lines it prints`) : ['  no lane has open work yet; file items with pullboard add, then open a worktree per lane']),
    '  each agent runs pullboard next, builds, commits, then pullboard submit',
  ];
}

/** Run `pullboard coordinate` and return its exit code. */
export async function run(io, { first }) {
  if (first !== undefined) throw new Refused('USAGE', 'pullboard coordinate takes no arguments; the coordinator checkout is where you run it');
  const code = await resumeHere(io, { state: 'off' }, false, {});
  if (code !== 0) return code;
  const ctx = context(io);
  const { lanes, listener } = await withBoardRead(ctx, board => ({ lanes: lanesWithWork(listItems(board, { all: true })), listener: listenerLines(board, 'coordinator') }));
  for (const line of [...listener, ...startLines(lanes), ...addAgentLines(lanes)]) io.say(line);
  return 0;
}
