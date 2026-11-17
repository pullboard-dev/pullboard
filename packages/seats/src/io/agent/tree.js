import { seatAddress } from '../../logic/address.js';
/** The agents view: each agent with its seats, helpers and holds, from the board and this machine's parent notes [N2,B13]. */
import { dirname } from 'node:path';
import { COORDINATOR } from '../../../../config/index.js';
import { displayAgentName } from '../../logic/agent/names.js';
import { seatLinks } from './session.js';

/**
 * Every joined agent with its seats, its helpers and what each holds, helpers nested under the agent that opened them
 * [N2,B13]. The parent links are read from this machine's checkouts; the coordinator is listed like any agent, and a helper whose parent is gone is listed on its own.
 *
 * @param {any} info - the checkout's repository info
 * @param {any} config
 * @param {any} board
 * @param {{ listAgents: Function, boardId: Function, listItems: Function }} store the caller's board readers, so seats never load the board
 * @returns {any[]}
 */
export function agentTree(info, config, board, store) {
  const agents = store.listAgents(board);
  const boardId = store.boardId(board);
  const { parents, digests } = seatLinks(info, agents);
  // The coordinator is the main checkout; a board that never declared its seat still shows it once it has opened a helper.
  if (!agents.some((agent) => agent.agent_id === COORDINATOR) && [...parents.values()].includes(COORDINATOR)) {
    agents.unshift({ agent_id: COORDINATOR, agent_lane: COORDINATOR, agent_path: dirname(info.commonDir) });
  }
  const held = new Map();
  for (const item of store.listItems(board)) {
    if (!item.item_owner || !['claimed', 'submitted'].includes(item.item_status)) continue;
    held.set(item.item_owner, [...(held.get(item.item_owner) ?? []), { item: item.item_id, status: item.item_status }]);
  }
  const known = new Set(agents.map((agent) => agent.agent_id));
  const row = (agent, seen) => ({
    id: agent.agent_id, address: seatAddress(boardId, agent.agent_id), parentSession: agent.agent_parent_session ?? null, displayName: displayAgentName(agent, config.agents.names), lane: agent.agent_lane, path: agent.agent_path,
    seats: agents.filter((seat) => seat.agent_id === agent.agent_id || (digests.has(agent.agent_id) && digests.get(seat.agent_id) === digests.get(agent.agent_id)))
      .map((seat) => ({ id: seat.agent_id, address: seatAddress(boardId, seat.agent_id), path: seat.agent_path })),
    holds: held.get(agent.agent_id) ?? [],
    helpers: agents.filter((helper) => parents.get(helper.agent_id) === agent.agent_id && !seen.has(helper.agent_id))
      .map((helper) => row(helper, new Set([...seen, helper.agent_id]))),
  });
  const parentId = (agent) => parents.get(agent.agent_id);
  return agents.filter((agent) => !known.has(parentId(agent))).map((agent) => row(agent, new Set([agent.agent_id])));
}

/**
 * The text view of an agent tree: one line per agent, helpers indented beneath their parent.
 *
 * @param {any[]} tree
 * @returns {string[]}
 */
export function agentTreeLines(tree, indent = '', { detail = true } = {}) {
  if (!indent && !tree.length) return ['no agents have joined'];
  return tree.flatMap((agent) => {
    const held = agent.holds.map((hold) => `#${hold.item} (${hold.status})`).join(', ');
    const parent = ` parent ${agent.parentSession ?? (detail ? 'unknown' : '?')}`;
    return [`${indent}${agent.displayName} (${agent.lane})${parent} ${agent.path} ${agent.address}${held ? `: ${held}` : ''}`, ...agentTreeLines(agent.helpers, indent + '  ', { detail })];
  });
}

/**
 * The seats that hold nothing: no claimed or submitted item, whatever their helpers hold; the coordinator never builds, so it is not one.
 *
 * @param {any[]} tree
 * @returns {{ id: string, address: string, path: string }[]}
 */
export function idleSeats(tree) {
  return tree.flatMap((agent) => [
    ...(agent.holds.length || agent.id === COORDINATOR ? [] : [{ id: agent.id, address: agent.address, path: agent.path }]),
    ...idleSeats(agent.helpers),
  ]);
}

/** Print the agents view, in text and as the stable agents:array JSON field. */
export function agentsReport(io, tree, { detail = false, consumers } = {}) {
  const idle = consumers ? idleSeats(tree) : undefined;
  io.result?.(consumers ? { agents: tree, consumers, idleSeats: idle } : { agents: tree });
  for (const line of agentTreeLines(tree, '', { detail })) io.say(line);
  if (consumers) {
    io.say(consumers.length ? `top local consumers: ${consumers.map(entry => `${entry.kind} ${entry.cpu}% (${entry.processes})`).join(', ')}` : 'top local consumers: none read');
    if (idle.length) io.say(`seats holding nothing: ${idle.map(seat => seat.id).join(', ')}`);
  }
  return 0;
}
