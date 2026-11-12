/** The CLI's explicit ports into the seats cell's checkout routing, so seats never load the CLI, board or person cells [C7,B13]. */
import * as store from '../../../../../packages/store/index.js';
import { agentSessionDigest } from '../../../../../packages/person/index.js';

/** Open a fresh lane seat only when no matching seat is free, loading the worktree command on demand as before. */
async function openWorktree(...args) {
  const { worktreeFor } = await import('../commands/worktree.js');
  return worktreeFor(...args);
}

/** The board readers, session digest and worktree opener laneSeatContext routes a claim with. */
export const seatRoutingPorts = Object.freeze({ store, sessionDigest: agentSessionDigest, openWorktree });

/** The agent reader and session digest nextSessionSeats finds this session's seats with. */
export const sessionSeatReaders = Object.freeze({ listAgents: store.listAgents, sessionDigest: agentSessionDigest });
