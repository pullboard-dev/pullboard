/**
 * The thin read door for `pullboard whoami`: the seat identity the full command prints, read through the light store
 * alone, never the board barrel or the relay client [C7,#9811]. Only a plain joined worktree is served here; every
 * other caller (the main checkout, a relay or served-API seat, an unjoined folder) takes the full path.
 * Wired behind read.thinCommands, default off.
 */
import { seatFamily } from '../../../../../packages/items/light.js';
import { displayAgentName } from '../../../../../packages/seats/browser.js';
import { seatAddress } from '../../../../../packages/seats/light.js';
import * as store from '../../../../../packages/store/light.js';
import { relayStateExists } from '../../../../../packages/store/light.js';
import { sessionRoute } from '../route.js';

/**
 * What `pullboard whoami` would report for the worktree in `ctx`, or null when the full path must run it: the main
 * checkout, a relay or remote seat, no readable board, a board a read must not open, or a worktree with no seat.
 *
 * @param {{ info: any, config: any, file: string, clock: any, io: any }} ctx the command context from `context(io)`
 * @returns {{ id: string, lane: string, route?: string, family: string | null, model: string, displayName: string, address: string } | null}
 */
export function thinWhoami(ctx) {
  if (ctx.info.isMain || ctx.io.remoteAgent || process.env.PULLBOARD_RELAY_TOKEN !== undefined || relayStateExists(ctx.info.commonDir)) return null;
  const board = store.openBoardForRead(ctx.file, ctx.clock);
  if (!board) return null;
  if (!board.current || board.drifted) { store.closeBoard(board); return null; }
  try {
    const agent = store.agentAt(board, ctx.info.root);
    if (!agent) return null;
    ctx.io.caller?.('seat', ctx.info.root);
    return { id: agent.agent_id, lane: agent.agent_lane, route: sessionRoute(agent.agent_route, agent.agent_model, process.env.PULLBOARD_MODEL, ctx.config.modelTiers),
      family: seatFamily(board, agent.agent_id), model: agent.agent_model ?? 'unknown', displayName: displayAgentName(agent, ctx.config.agents.names),
      address: seatAddress(store.boardId(board), agent.agent_id) };
  } catch (error) {
    if (error instanceof store.ReadNeedsWrite || store.writeRefused(error) || store.schemaMissing(error)) return null;
    throw error;
  } finally { store.closeBoard(board); }
}
