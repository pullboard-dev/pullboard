/** Browser-sealed person intent is CLI input, never an executable engine move [H12,H16]. */
import { moveArgs } from './api-moves.js';
import { Refused } from './refused.js';

export const PERSON_REQUEST_VERSION = 1;
const VERBS = Object.freeze(['add', 'shout', 'answer', 'hold', 'spec-approve', 'spec-decline']);

/** Validate a narrow person intent while retaining literal arguments for the actual CLI parser. */
export function personRequestMove(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => !['verb', 'item', 'args'].includes(key))
      || !VERBS.includes(body.verb)) {
    throw new Refused('BAD_REQUEST', 'a person request takes add, shout, answer, hold, spec-approve or spec-decline with item and args; use the view controls');
  }
  const move = structuredClone(body);
  move.args ??= {};
  if (typeof move.args !== 'object' || Array.isArray(move.args)) throw new Refused('BAD_REQUEST', 'args needs the move arguments as a JSON object; use the view controls');
  if (move.verb === 'answer') {
    if (move.args.as !== undefined && move.args.as !== 'person') throw new Refused('B26_PERSON_ANSWER', 'the relay person answers as person; use the view to answer the decision');
    move.args.as = 'person';
  }
  moveArgs(move);
  return move;
}

/** Create the distinct versioned request document before the browser seals it for request-kind AAD. */
export function preparePersonRequest(body, id = crypto.randomUUID()) {
  const document = { version: PERSON_REQUEST_VERSION, type: 'person-request', id, move: personRequestMove(body) };
  return validatePersonRequest(document);
}

/** Refuse malformed or newer request formats before any CLI can interpret their intent. */
export function validatePersonRequest(document) {
  if (document?.version !== PERSON_REQUEST_VERSION || document?.type !== 'person-request') {
    throw new Refused('PERSON_REQUEST_VERSION', 'this person request format is unsupported; upgrade Pullboard on the browser and linked machine');
  }
  if (typeof document.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/u.test(document.id)
      || Object.keys(document).some(key => !['version', 'type', 'id', 'move'].includes(key))) {
    throw new Refused('BAD_REQUEST', 'a sealed person request needs its stable id and literal move; reload the paired view and retry');
  }
  return { version: PERSON_REQUEST_VERSION, type: 'person-request', id: document.id, move: personRequestMove(document.move) };
}
