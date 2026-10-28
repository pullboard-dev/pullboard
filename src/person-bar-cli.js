import { itemCheckBaseline } from './board-query.js';
/** Native signed bar commands reuse sealed normalized values and recheck their displayed revision [E22,V1]. */
import { personMode } from './cli.js';
import { getItem } from './board.js';
import {
  barDigest,
  barReadiness,
} from './bar-readiness.js';
import { personRequestRecords } from './relay-requests.js';
import { requireSignedPerson } from './person-signing-cli.js';
import { personSigning } from './person-signing.js';
import {
  barEffectValues,
  normalizePersonBarEffect,
  sameBarEffect,
} from './person-bar-effect.js';
import { Refused } from './refused.js';

/** Capture the current author revision even for boards whose bar-ready setting is off. */
function beforeBar(board, id) {
  const item = getItem(board, id);
  return { revision: barReadiness(board, item, { signature: false }, { itemCheckBaseline }).revision?.revision ?? 0, digest: barDigest(item) };
}
/** Read only the exact current execution document; never accept caller-provided flags as signed provenance. */
export function executingBarEffect(ctx, board, verb, id) {
  if (!ctx.io.personRequest || !personSigning(board).signed) return null;
  const record = personRequestRecords(board).find(entry => entry.id === ctx.io.personRequest.id && !entry.duplicateOf);
  let document;
  try { document = JSON.parse(record?.encoded); } catch { /* Refuse malformed source below. */ }
  if (document?.move?.verb !== verb || (id !== undefined && document.move.item !== id) || !document.effect) {
    throw new Refused('PERSON_REQUEST_RECEIPT', 'this signed bar command has no exact normalized effect; show and confirm it again');
  }
  const effect = normalizePersonBarEffect(verb, document.effect);
  if (verb !== 'add' && !sameBarEffect(effect.before, beforeBar(board, id))) {
    throw new Refused('BAR_SIGN_STALE', 'the bar changed after it was shown; show and confirm its current revision again');
  }
  return effect.value;
}
/** Propose before any baseline runs; execution still goes through requireSignedPerson's strict presence check. */
export async function confirmBarEffect(ctx, board, me, intent, value, asPerson) {
  if (!personSigning(board).signed || !asPerson && !ctx.io.personRequest) return null;
  const author = !ctx.io.personRequest ? intent.verb === 'add' ? { by: 'coordinator' } : intent.verb === 'edit' ? { agentId: 'coordinator' } : {} : {};
  const effect = { version: 1, value: barEffectValues(intent.verb, { ...value, ...author }),
    ...(intent.verb === 'add' ? {} : { before: beforeBar(board, intent.item) }) };
  return requireSignedPerson(ctx, board, me, intent, undefined, effect);
}

/** Signed terminals propose from any checkout; the authenticated executor alone supplies person authority. */
export function personBarMode(ctx, board, me, values) {
  return personSigning(board).signed && (values.as === 'person' || ctx.io.personRequest?.phase === 'execute')
    ? true : personMode(ctx, me, values);
}
