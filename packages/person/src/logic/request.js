/** Browser-sealed person intent is CLI input, never an executable engine move [H12,H16]. */
import { normalizePersonBarEffect } from "./effect.js";
import { Refused } from "../../../kernel/light.js";

export const PERSON_REQUEST_VERSION = 1;
const VERBS = Object.freeze(['add', 'shout', 'answer', 'hold', 'spec-approve', 'spec-decline', 'sentinel-approve', 'sentinel-decline', 'land-waive', 'signing', 'fact', 'spec-answer', 'edit', 'bar-sign']);

export const PERSON_REQUESTS_INDEX = 'relay_person_requests';

/** Read the durable person-request receipts from an already-open board. */
export function personRequestRecords(board) {
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(PERSON_REQUESTS_INDEX);
  return row ? JSON.parse(row.meta_value) : [];
}

/** Declarative CLI forms keep API calls on the same argument parser and engine as terminal moves. */
const MOVES = {
  'spec-approve': { prefix: ['spec', 'approve'], positions: ['ids'], flags: ['by', 'text'] },
  'spec-decline': { prefix: ['spec', 'decline'], positions: ['ids'], flags: ['reason'] },
  'sentinel-approve': { prefix: ['sentinel', 'approve'], positions: ['name'], flags: ['digest'] },
  'sentinel-decline': { prefix: ['sentinel', 'decline'], positions: ['name'], flags: ['digest', 'reason'] },
  'spec-answer': { prefix: ['spec', 'answer'], positions: ['row', 'answer'] },
  'check-accept': { prefix: ['check', 'accept'], item: true },
  'land-waive': { prefix: ['land'], flags: ['waive', 'until', 'reason'] },
  'bar-sign': { prefix: ['bar', 'sign'], item: true, flags: ['note'] },
  signing: { prefix: ['settings', 'person.signed'], positions: ['signed'] },
  add: { positions: ['lane', 'title'], flags: ['criterion', 'specs', 'parent', 'after', 'brief', 'route', 'check', 'as'], booleans: ['wait'] },
  edit: { item: true, flags: ['criterion', 'brief', 'route', 'check', 'reason', 'after', 'as', 'review-tier'], booleans: ['wait'] },
  fact: { item: true, positions: ['kind', 'text'], flags: ['answers', 'supersedes', 'ref', 'implies', 'as', 'cause'], booleans: ['never-again'] },
  claim: { item: true },
  release: { item: true, flags: ['note', 'reason'] },
  submit: { item: true },
  done: { item: true },
  verify: { item: true, positions: ['decision'], flags: ['reason', 'note', 'cause', 'clause', 'as', 'implies'] },
  merged: { item: true, positions: ['commit'] },
  withdraw: { item: true, positions: ['reason'] },
  refreeze: { item: true },
  reopen: { item: true, flags: ['note', 'cause'], lists: ['conflict'], booleans: ['withdraw-verdict'] },
  escalate: { item: true, flags: ['note'] },
  hold: { positions: ['lane'], flags: ['reason', 'as'], booleans: ['off'] },
  shout: { positions: ['to', 'text'], optional: ['to'], booleans: ['decision', 'news'], flags: ['kind', 'clause', 'evidence', 'outcome', 'item', 'commit', 'options'] },
  answer: { item: true, positions: ['text'], flags: ['as', 'implies', 'supersedes', 'origin', 'rationale'] },
  pass: { item: true, positions: ['note'] },
  next: { flags: ['as'], booleans: ['verify', 'build'] },
  // A seat joined by URL has no process of its own to beat, so it sends this move to stay present [P7].
  heartbeat: {},
};

/** Reject unsupported fields, then pass values as distinct argv entries, never a shell command. */
export function moveArgs({ verb, item, args = {} }) {
  if (verb === 'accept' || verb === 'reject') return moveArgs({ verb: 'verify', item, args: { ...args, decision: verb } });
  const form = Object.hasOwn(MOVES, verb) ? MOVES[verb] : null;
  if (!form) throw new Refused('BAD_REQUEST', `no API move ${String(verb)}; use a board move such as add, claim, submit, verify, shout or answer`);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Refused('BAD_REQUEST', 'args needs a JSON object containing this move\'s arguments');
  if (['sentinel-approve', 'sentinel-decline'].includes(verb)) {
    if (typeof args.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(args.digest)) {
      throw new Refused('BAD_REQUEST', 'a sentinel decision needs the exact proposal digest; refresh the pending watch before deciding');
    }
    if (verb === 'sentinel-decline' && (typeof args.reason !== 'string' || !args.reason.trim())) {
      throw new Refused('BAD_REQUEST', 'declining a sentinel needs a reason; say why this proposal should not run');
    }
  }
  const allowed = [...(form.positions ?? []), ...(form.flags ?? []), ...(form.lists ?? []), ...(form.booleans ?? [])];
  for (const key of Object.keys(args)) if (!allowed.includes(key)) throw new Refused('BAD_REQUEST', `${verb} does not take args.${key}; use only this CLI move's arguments`);
  const argv = form.prefix ? [...form.prefix] : [verb];
  if (form.item) {
    if (!Number.isSafeInteger(item) || item < 1) throw new Refused('BAD_REQUEST', `${verb} needs a positive integer item; use the item id from the board state`);
    argv.push(String(item));
  } else if (item !== undefined && item !== null) throw new Refused('BAD_REQUEST', `${verb} does not take item; put its arguments in args`);
  const positional = [];
  for (const key of form.positions ?? []) {
    if (args[key] === undefined && form.optional?.includes(key)) continue;
    const cliRefusesBlank = verb === 'shout' && key === 'text';
    if (typeof args[key] !== 'string' || (!args[key].trim() && !cliRefusesBlank)) throw new Refused('BAD_REQUEST', `${verb} needs args.${key} as nonempty text; supply the CLI move's argument`);
    positional.push(args[key]);
  }
  for (const key of form.flags ?? []) if (args[key] !== undefined) {
    if (typeof args[key] !== 'string') throw new Refused('BAD_REQUEST', `args.${key} needs text; supply the CLI flag's value`);
    argv.push(`--${key}=${args[key]}`);
  }
  // A list flag repeats once per value, so each value reaches the CLI exactly, never split or joined.
  for (const key of form.lists ?? []) if (args[key] !== undefined) {
    const values = [args[key]].flat();
    if (!values.length || values.some((value) => typeof value !== 'string')) throw new Refused('BAD_REQUEST', `args.${key} needs text or an array of text; supply one value per CLI flag`);
    for (const value of values) argv.push(`--${key}=${value}`);
  }
  for (const key of form.booleans ?? []) if (args[key] !== undefined) {
    if (typeof args[key] !== 'boolean') throw new Refused('BAD_REQUEST', `args.${key} needs true or false`);
    if (args[key]) argv.push(`--${key}`);
  }
  // Positionals follow -- so titles and notes beginning with a dash never become CLI flags.
  argv.push('--json', '--', ...positional);
  return argv;
}

/** Validate a narrow person intent while retaining literal arguments for the actual CLI parser. */
export function personRequestMove(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => !['verb', 'item', 'args'].includes(key))
      || !VERBS.includes(body.verb)) {
    throw new Refused('BAD_REQUEST', 'a person request takes add, shout, answer, hold, spec-approve, spec-decline, sentinel-approve, sentinel-decline, land-waive signing, fact or spec-answer with item and args; use the view controls');
  }
  const move = structuredClone(body);
  move.args ??= {};
  if (typeof move.args !== 'object' || Array.isArray(move.args)) throw new Refused('BAD_REQUEST', 'args needs the move arguments as a JSON object; use the view controls');
  if (['answer', 'fact'].includes(move.verb)) {
    if (move.args.as !== undefined && move.args.as !== 'person') throw new Refused('B26_PERSON_ANSWER', 'the relay person answers as person; use the view to answer the decision');
    move.args.as = 'person';
  }
  // A passkey turns signing on or off; nothing else rides on this verb [E22].
  if (move.verb === 'signing' && !['on', 'off'].includes(move.args.signed)) throw new Refused('BAD_REQUEST', 'signing takes args.signed "on" or "off"; use the view controls');
  moveArgs(move);
  return move;
}

/**
 * Create the distinct versioned request document before the browser seals it for request-kind AAD. A row decision on
 * a board that signs person moves also carries `rows`, the exact text of each row as the person saw it [E22].
 */
export function preparePersonRequest(body, id = crypto.randomUUID(), rows, effect) {
  const document = { version: PERSON_REQUEST_VERSION, type: 'person-request', id, move: personRequestMove(body), ...(rows ? { rows } : {}), ...(effect ? { effect } : {}) };
  return validatePersonRequest(document);
}

/** Keep shown rows to bounded `{id, text}` pairs, one per decided row. */
function shownRows(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 200 || rows.some((row) => !row || typeof row !== 'object' || Object.keys(row).some(key => !['id', 'text', 'source'].includes(key))
      || typeof row.id !== 'string' || !/^(?:doctrine:)?[A-Za-z][A-Za-z0-9._-]{0,79}$/u.test(row.id) || typeof row.text !== 'string' || row.text.length > 8000 || row.source !== undefined && (typeof row.source !== 'string' || row.source.length > 16000 || /[\r\n\0]/u.test(row.source)))) {
    throw new Refused('BAD_REQUEST', 'a signed row decision names each row it shows with its id and exact text; reload the paired view and retry');
  }
  return rows.map(({ id, text, source }) => ({ id, text, ...(source === undefined ? {} : { source }) }));
}

/** Refuse malformed or newer request formats before any CLI can interpret their intent. */
export function validatePersonRequest(document) {
  if (document?.version !== PERSON_REQUEST_VERSION || document?.type !== 'person-request') {
    throw new Refused('PERSON_REQUEST_VERSION', 'this person request format is unsupported; upgrade Pullboard on the browser and linked machine');
  }
  if (typeof document.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/u.test(document.id)
      || Object.keys(document).some(key => !['version', 'type', 'id', 'move', 'rows', 'effect'].includes(key))) {
    throw new Refused('BAD_REQUEST', 'a sealed person request needs its stable id and literal move; reload the paired view and retry');
  }
  const move = personRequestMove(document.move);
  if (document.rows !== undefined && !['spec-approve', 'spec-decline', 'spec-answer'].includes(move.verb)) throw new Refused('BAD_REQUEST', 'only a row decision carries the rows it shows');
  return { version: PERSON_REQUEST_VERSION, type: 'person-request', id: document.id, move, ...(document.rows === undefined ? {} : { rows: shownRows(document.rows) }),
    ...(document.effect === undefined ? {} : { effect: normalizePersonBarEffect(move.verb, document.effect) }) };
}
