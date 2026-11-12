import { safePauseMessage } from './pause.js';
import { Refused } from '../../../../kernel/light.js';
import { saveLink } from './link.js';

const AUTH_NOTICES = new WeakSet();

/** Give a local read a single safe explanation when its signed relay read is refused. */
export function reportExpiredSignIn(state, io) {
  if (AUTH_NOTICES.has(io)) return;
  AUTH_NOTICES.add(io);
  const fix = process.env.PULLBOARD_RELAY_TOKEN !== undefined
    ? 'unset PULLBOARD_RELAY_TOKEN to use this machine credential or supply a current PULLBOARD_RELAY_TOKEN'
    : 'run pullboard relay on to sign in again or pullboard relay off to stop syncing';
  io.err(`pullboard: [AUTH_REQUIRED] relay sign-in expired or was revoked for board ${state.board}; ${fix}`);
}

/** Preserve the ordered-move refusal while naming this board and both recovery choices. */
export function expiredSignInMoveRefusal(state, error) {
  const reason = safePauseMessage(error);
  if (process.env.PULLBOARD_RELAY_TOKEN !== undefined) {
    return new Refused('AUTH_REQUIRED', `the supplied PULLBOARD_RELAY_TOKEN was refused for board ${state.board}: ${reason}; unset PULLBOARD_RELAY_TOKEN to use this machine credential or supply a current PULLBOARD_RELAY_TOKEN`);
  }
  return new Refused('AUTH_REQUIRED', `relay sign-in expired or was revoked for board ${state.board}: ${reason}; run pullboard relay on to give this machine a credential or pullboard relay off to stop syncing`);
}

/**
 * Keep why a move's reply was lost on its durable send record, then return the original refusal.
 * Why: the command that gave up exits here, so only the saved cause lets whichever later command
 * recovers the move say what the earlier request failed with (#642). It holds the cause name only.
 */
export function rememberLostReply(file, state, id, error) {
  const held = [state.pending, state.recovered].find((record) => record?.move?.id === id);
  if (held) {
    held.lostReply = error.transportFailure ?? error.code;
    saveLink(file, state);
  }
  return error;
}

/**
 * Say once that catch-up recovered a move whose earlier reply was lost, with that request's cause.
 * Why: any later command, a read included, may be the one that recovers it; the saved cause is
 * cleared here so the repeated command does not say it again (#642).
 */
export function reportRecoveredReply(record, io) {
  if (!record?.lostReply) return;
  io?.err?.(`pullboard: recovered move ${record.sequence} (${record.move.operation}) whose earlier reply was lost: ${record.lostReply}`);
  delete record.lostReply;
}
