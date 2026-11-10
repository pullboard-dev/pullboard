import { COORDINATOR } from '../../../../../config/index.js';
import { VERIFIER_STANDING_ENGINE } from '../../../io/machine.js';
import { Refused } from '../../../../../kernel/light.js';

/**
 * Bind an engine-48 registration to the relay's receipt (#579). A seat made by another seat names
 * itself in the move (`id`) and arrives with the receipt the relay issued its first token under:
 * same target, the authenticated creator, this position and these exact sealed bytes. A join no
 * seat made is machine-sent and carries no receipt; a receipt on any other move is refused.
 *
 * @param {any} board
 * @param {any} move
 * @param {{ sender: any, registration?: any, sequence: number, digest: string | null }} record
 * @returns {Refused | null}
 */
export function registrationProblem(board, move, { sender, registration, sequence, digest }, ports) {
  const store = ports.store;
  const refuse = (why) => new Refused('RELAY_REGISTRATION', `${why}; register the seat again from its creating seat's checkout`);
  const options = move?.operation === 'register' && move.engine >= VERIFIER_STANDING_ENGINE ? move.args?.[0] : null;
  if (!options || sender?.kind === 'person') return registration === undefined || registration === null ? null : refuse('the relay attached a seat receipt to a move that registers no seat');
  const existing = typeof options.path === 'string' ? store.agentAt(board, options.path) : null;
  if (sender.kind === 'machine' || existing) {
    if (registration !== undefined && registration !== null) return refuse('a machine join or a returning seat carries no seat receipt');
    if (existing && sender.kind === 'agent' && existing.agent_id !== sender.agent) return refuse(`agent ${sender.agent} cannot register another seat's worktree`);
    return null;
  }
  if (options.createdBy === COORDINATOR && sender.root !== true) {
    return refuse('only the coordinator credential the person set up creates seats; run pullboard relay on in the main checkout once');
  }
  const receipt = registration ?? {};
  if (typeof options.id !== 'string' || receipt.target !== options.id || receipt.creator !== sender.agent || receipt.creator !== options.createdBy ||
      receipt.sequence !== sequence || typeof digest !== 'string' || receipt.digest !== digest) {
    return refuse('a new seat needs the relay receipt its creator received for exactly this sealed move');
  }
  return null;
}

