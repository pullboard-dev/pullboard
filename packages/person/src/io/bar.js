import { itemCheckBaseline } from "../../../store/index.js";
/** Native signed bar commands reuse sealed normalized values and recheck their displayed revision [E22,V1]. */
import { getItem } from "../../../store/index.js";
import {
  barDigest,
  barReadiness,
} from "../../../verify/index.js";
import { personRequestRecords } from "../logic/request.js";
import { requireSignedPerson } from "./signing/cli.js";
import { personSigning } from "./signing.js";
import {
  barEffectValues,
  normalizePersonBarEffect,
  sameBarEffect,
} from "../logic/effect.js";
import { Refused } from "../../../kernel/index.js";

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

/** Signed terminals propose from any checkout; the caller supplies person-mode authority and the executor supplies the authenticated action. */
export function personBarMode(ctx, board, me, values, personMode) {
  return personSigning(board).signed && (values.as === 'person' || ctx.io.personRequest?.phase === 'execute')
    ? true : personMode(ctx, me, values);
}
