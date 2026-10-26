/** The pullboard resources command, in its own module so an item adding another command never edits these lines. */
import * as store from '../board.js';
import {
  listResources,
  memoryVerdict,
  readMachineMemory,
  runnerResourceStatus,
} from '../resources.js';
import { runnerDeadlineLine } from '../runner-wait.js';
import {
  gateQueueSettings,
  gateShortSlots,
  loadMachineSettings,
  memoryFloorMB,
} from '../settings.js';
import {
  agentDisplayName,
  context,
  resourceRunLabel,
  withBoard,
} from '../cli.js';

/** Run `pullboard resources` and return its exit code. */
export async function run(io) {
  const ctx = context(io);
  const agents = withBoard(ctx, (board) => store.listAgents(board));
  const browserSlots = loadMachineSettings().browserSlots;
  const floorMB = memoryFloorMB();
  // The memory hold is opt-in: with no floor set, nothing reads the machine's memory.
  const memory = floorMB === null ? null : memoryVerdict(await readMachineMemory({ processes: true }), floorMB * 1024 ** 2);
  const resources = [
    ...listResources({ scope: 'machine' }).map((resource) => ({ ...resource, scope: 'machine' })),
    ...listResources({ scope: 'repo', root: ctx.info.root }).map((resource) => ({ ...resource, scope: 'repo' })),
  ];
  const runners = runnerResourceStatus(loadMachineSettings().runners ?? []);
  const queue = gateQueueSettings();
  const shortSlots = gateShortSlots();
  io.result?.({ resources, runners, browserSlots, queue, memory, shortSlots });
  io.say(`browserSlots (machine setting): ${browserSlots}`);
  io.say(`machine queue order (gate.queue.reviewsFirst ${queue.reviewsFirst}): ${queue.reviewsFirst ? `landing, review, submit, other; a waiting run moves up one class every ${queue.agingMinutes} minutes` : 'landings first, then arrival'}`);
  if (shortSlots) io.say(`gate.shortSlots (machine setting): ${shortSlots}; runs that name their test files may use them while every gate slot is busy`);
  if (memory) io.say(memory.line);
  if (!resources.length) io.say('no resources have been used');
  for (const resource of resources) {
    io.say(`${resource.name} (${resource.scope}, capacity ${resource.capacity})${resource.order === 'arrival' ? '; an older pullboard is waiting, so this line is in arrival order, landings first' : ''}`);
    for (const holder of resource.holders) io.say(`  held by ${agentDisplayName(agents, ctx.config, holder.agent)}${holder.repo ? ` in ${holder.repo}` : ''}${resourceRunLabel(holder, shortSlots)} since ${holder.since}`);
    resource.line.forEach((waiter, index) => io.say(`  ${index + 1}. waiting: ${agentDisplayName(agents, ctx.config, waiter.agent)}${waiter.repo ? ` in ${waiter.repo}` : ''}${resourceRunLabel(waiter, shortSlots)}; class ${waiter.queueClass}${waiter.agedFrom ? `, aged up from ${waiter.agedFrom}` : ''}${waiter.memoryHeld ? '; held by local memory' : ''}`));
  }
  for (const runner of runners) io.say(`runner ${runner.host}: ${runner.inUse}/${runner.slots} slots, ${runner.browserInUse}/${runner.browser} browser, GUI ${runner.gui === true ? 'yes' : runner.gui === false ? 'no' : 'unknown'}${runner.unavailable ? ' (unavailable; re-register after checking the host)' : ''}`);
  for (const waiter of resources.find(resource => resource.name === 'gate' && resource.scope === 'machine')?.line ?? []) {
    if (waiter.runnerDeadline) io.say(`${waiter.agent}${waiter.item ? ` #${waiter.item}` : ''}: ${runnerDeadlineLine(waiter.runnerDeadline)}`);
  }
  return 0;
}
