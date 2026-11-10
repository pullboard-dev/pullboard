import { itemCheckBaseline } from '../../../../store/index.js';
/** Durable sealed request intake and ordinary-move receipts; no replica executes CLI intent [H12,H16]. */
import { answerQuestion } from '../../../../spec/index.js';
import * as store from '../../../../store/index.js';
import { recordedRefusal } from '../../../../state/index.js';
import { Refused } from '../../../../kernel/light.js';

import { personSigning } from '../../../../person/index.js';
import { signedRowDecisionsMatch } from '../../../../person/index.js';
import { parseImplies } from '../../../../state/index.js';
import { PERSON_REQUESTS_INDEX } from '../../../../person/light.js';
import { personRequestRecords } from '../../../../person/light.js';
import { validatePersonRequest } from '../../../../person/light.js';
import { requestIntentDigest } from '../../../../person/index.js';
import { barDigest } from '../../../../verify/index.js';
import { barReadiness } from '../../../../verify/index.js';
import { barReadySetting } from '../../../../verify/index.js';
import { barEffectValues } from '../../../../person/light.js';
import { sameBarEffect } from '../../../../person/light.js';
import { PEOPLE_ENGINE } from '../../../../state/light.js';

const INDEX = PERSON_REQUESTS_INDEX;

export { personRequestRecords, requestIntentDigest };

/**
 * The GitHub login the relay stamped on a record from engine 73 on, or null: the person who made or tried it [E3].
 *
 * @param {any} sender
 * @returns {string | null}
 */
export function relayPerson(sender) {
  return typeof sender?.login === 'string' && sender.engine >= PEOPLE_ENGINE ? sender.login : null;
}

/**
 * The person whose phone asked for this move, when the move carries out a recorded phone request, or null. The
 * computer that carries the request out sends the move, but the move is the phone person's [E3].
 *
 * @param {any} board
 * @param {any} move
 * @returns {string | null}
 */
export function requestPerson(board, move) {
  if (!move?.personRequest || requestMoveProblem(board, move, { checkExecutorLease: false })) return null;
  const record = personRequestRecords(board).find((entry) => entry.id === move.personRequest.id && !entry.duplicateOf);
  try { return relayPerson(JSON.parse(record.received).sender); } catch { return null; }
}

/** Persist request receipts inside the caller's existing board transaction. */
function save(board, records) {
  board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value').run(INDEX, JSON.stringify(records));
}

/** Consume a request position atomically without running its command or touching a repository. */
export function receivePersonRequest(board, document, { sequence, at, sender }) {
  if (!Number.isSafeInteger(sequence) || sequence < 1 || !Number.isFinite(Date.parse(at))) throw new Refused('RELAY_MOVE', 'a request needs the relay sequence and timestamp; restore a consistent prefix');
  return store.atomic(board, () => {
    const cursor = Number(board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get('relay_applied_sequence')?.meta_value ?? 0);
    const records = personRequestRecords(board);
    const received = JSON.stringify({ document, sender });
    const existingPosition = records.find(record => record.sequence === sequence);
    if (sequence <= cursor) {
      if (!existingPosition || existingPosition.received !== received) throw new Refused('RELAY_CURSOR', 'the earlier request has no durable receipt; restore a consistent snapshot');
      return existingPosition;
    }
    if (sequence !== cursor + 1) throw new Refused('RELAY_ORDER', 'fetch the missing relay prefix before receiving this request');
    let request;
    let error;
    try {
      if (sender?.kind !== 'person' || typeof sender.userId !== 'string' || !sender.userId || sender.userId.length > 256) throw new Refused('RELAY_PERSON_ONLY', 'only the authenticated person can send a relay request; use the paired view with the person session');
      request = validatePersonRequest(document);
      // On a board that names approvers, a phone request that acts as the person must come from one [E4].
      // Adding or editing an item is a person move only where person moves are signed, since its bar is signed then.
      const barVerbs = personSigning(board, { strict: false }).signed ? ['add', 'edit'] : [];
      if (sender.approver === false && ['answer', 'hold', 'spec-approve', 'spec-decline', 'spec-answer', 'fact', 'sentinel-approve', 'sentinel-decline', 'bar-sign', ...barVerbs].includes(request.move?.verb)) {
        throw new Refused('NOT_APPROVER', `${sender.login ?? 'this person'} is not an approver of this board; ask an approver to answer, hold or decide rows and sentinels`);
      }
    } catch (cause) {
      if (!(cause instanceof Refused)) throw cause;
      error = recordedRefusal(cause);
    }
    const id = request?.id ?? (typeof document?.id === 'string' && /^[A-Za-z0-9_-]{1,80}$/u.test(document.id) ? document.id : 'refused-' + sequence);
    const previous = records.find(record => record.id === id);
    const encoded = JSON.stringify(request ?? document);
    let record;
    if (previous && !error && previous.encoded === encoded) {
      record = { ...previous, sequence, received, duplicateOf: previous.sequence };
    } else {
      if (previous) error = recordedRefusal(new Refused('PERSON_REQUEST_ID', 'this request id already names different intent; reload the paired view and send a new request'));
      record = { id: previous ? id + '-' + sequence : id, sequence, at, by: sender?.kind === 'person' ? 'person' : sender?.agent ?? '(unknown sender)', move: request?.move ?? null,
        encoded, received, status: error ? 'refused' : 'waiting', ...(error ? { error } : {}) };
      if (error) {
        const clock = board.clock;
        board.clock = { now: () => new Date(at) };
        try { store.recordRelayRefusal(board, { by: sender?.kind === 'agent' ? sender.agent : 'person', sequence, kind: 'request', operation: document?.operation ?? null, actor: board.enginePorts.relayMoveActor(document), code: error.code, person: relayPerson(sender) }); }
        finally { board.clock = clock; }
      }
    }
    save(board, [...records, record]);
    board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value').run('relay_applied_sequence', String(sequence));
    return record;
  });
}

/** Compare the requested literal arguments with the ordinary effect produced by the CLI. */
function fulfilsIntent(record, move, board) {
  const intent = record.move;
  const args = intent.args;
  const value = move.args[0];
  const options = move.args[1];
  const document = JSON.parse(record.encoded);
  if (document.effect && ['add', 'edit', 'bar-sign'].includes(intent.verb)) {
    const verb = intent.verb;
    const effect = document.effect;
    const fields = verb === 'add' ? value : options;
    if (verb !== 'add') {
      if (value !== intent.item) return false;
      const item = store.getItem(board, value);
      const before = { revision: barReadiness(board, item, { signature: false }, { itemCheckBaseline }).revision?.revision ?? 0, digest: barDigest(item) };
      if (!sameBarEffect(effect.before, before)) return false;
    }
    const expectedActor = barReadySetting(board).enabled ? { authority: 'person', session: null, parent: null } : null;
    return move.args.length === (verb === 'add' ? 1 : 2) && fields
      && (verb === 'bar-sign' ? fields.agentId === 'person' : (verb === 'add' ? fields.by : fields.agentId) === (verb === 'add' ? effect.value.by : effect.value.agentId))
      && sameBarEffect(fields.barActor, expectedActor)
      && sameBarEffect(barEffectValues(verb, fields), effect.value)
      && (!args.wait || !fields.checkBaseline || fields.checkBaseline.result !== 'pending')
      && Object.keys(fields).every(key => Object.hasOwn(effect.value, key) || ['by', 'agentId', 'barActor', 'checkBaseline'].includes(key));
  }
  if (personSigning(board).signed && ['add', 'edit', 'bar-sign'].includes(intent.verb)) return false;

  if (intent.verb === 'add') return value?.by === 'person' && value.lane === args.lane && value.title === args.title
    && value.criterion === (args.criterion ?? '') && value.brief === (args.brief ?? '')
    && value.route === (args.route ?? 'strong') && (value.check ?? '') === (args.check ?? '')
    && (value.parentId ?? null) === (args.parent ? Number(args.parent.replace(/^#/, '')) : null)
    && JSON.stringify(value.after ?? []) === JSON.stringify((args.after ?? '').split(',').map(id => id.trim()).filter(Boolean).map(id => Number(id.replace(/^#/, ''))))
    && (!args.wait || !value.checkBaseline || value.checkBaseline.result !== 'pending')
    && JSON.stringify(value.specIds) === JSON.stringify((args.specs ?? '').split(',').map(id => id.trim()).filter(Boolean));
  if (intent.verb === 'shout') return value?.from === 'person' && value.text === args.text
    && value.to === (args.to ?? (args.decision ? 'person' : args.text)) && Boolean(value.decision) === Boolean(args.decision)
    && !value.request && value.answers == null
    && (args.evidence === undefined ? value.evidence == null : value.evidence?.kind === args.evidence
      && value.evidence.outcome === (args.outcome ?? '') && value.evidence.item === Number(args.item)
      && /^[0-9a-f]{40,64}$/u.test(args.commit ?? '') && value.evidence.commit === args.commit);
  // Every effect an answer can carry is bound to the request, read as the CLI reads its flags: no implied
  // item or superseded answer the phone did not name, and none it named left out.
  if (intent.verb === 'answer') return value === intent.item && options?.asPerson === true && options.channel === 'view' && options.text === args.text
    && JSON.stringify(options.implies ?? []) === JSON.stringify(requestedImplies(args.implies)) && (options.supersedes ?? null) === requestedAnswer(args.supersedes);
  if (intent.verb === 'fact') return value === intent.item && options?.asPerson === true && options.channel === 'view'
    && options.kind === args.kind && options.text === args.text && (options.supersedes ?? null) === (args.supersedes ?? null)
    && (options.ref ?? null) === (args.ref ?? null) && (options.cause ?? null) === (args.cause ?? null)
    && Boolean(options.neverAgain) === Boolean(args['never-again'])
    && JSON.stringify(options.implies ?? []) === JSON.stringify(requestedImplies(args.implies));
  if (intent.verb === 'spec-answer') {
    let document;
    let text;
    try {
      document = JSON.parse(record.encoded);
      const shown = document.rows?.find(row => row.id === args.row);
      if (!shown) return false;
      text = answerQuestion(shown.text, args.answer, args.row).text;
    } catch { return false; }
    return value?.agentId === 'person' && value.channel === 'view' && value.decisions?.length === 1
      && value.decisions[0].id === args.row && value.decisions[0].kind === 'spec'
      && value.decisions[0].decision === 'approve' && value.decisions[0].text === text && value.decisions[0].by === 'person'
      && value.decisions[0].signature === undefined && signedRowDecisionsMatch(record, value.decisions);
  }
  if (intent.verb === 'hold') return value === args.lane && options?.asPerson === true && options.channel === 'view'
    && (args.off || options.reason === (args.reason ?? ''));
  if (['sentinel-approve', 'sentinel-decline'].includes(intent.verb)) {
    const decline = intent.verb === 'sentinel-decline';
    return move.args.length === 1 && value?.agentId === 'person' && value.channel === 'view'
      && value.name === args.name && value.digest === args.digest && value.decision === (decline ? 'decline' : 'approve')
      && (!decline || typeof args.reason === 'string' && Boolean(args.reason.trim()))
      && (value.reason ?? '') === (decline ? args.reason.trim() : '')
      && Object.keys(value).every(key => ['agentId', 'channel', 'name', 'digest', 'decision', 'reason'].includes(key));
  }
  // Signed person moves [E22]: the waiver and the signing switch carry exactly the request's values, and its id.
  if (intent.verb === 'land-waive') return value?.agentId === 'person' && value.channel === 'view' && value.test === args.waive
    && value.until === args.until && value.reason === args.reason;
  if (intent.verb === 'signing') return value?.signed === (args.signed === 'on') && (args.signed === 'on' || value.agentId === 'person' && value.request === record.id);
  const rows = value?.decisions;
  if (!['spec-approve', 'spec-decline', 'spec-answer'].includes(intent.verb) || typeof args.ids !== 'string') return false;
  const ids = args.ids.split(/[\s,]+/u).filter(Boolean);
  const requiresShown = personSigning(board, { strict: false }).signed || Array.isArray(rows) && rows.some(row => row.passkeyRequest !== undefined);
  let shown;
  try { shown = JSON.parse(record.encoded).rows; } catch { return false; }
  if (requiresShown && (!Array.isArray(shown) || shown.length !== ids.length)) return false;
  return value?.agentId === 'person' && value.channel === 'view' && Array.isArray(rows) && rows.length === ids.length
    && rows.every((row, index) => (move.operation === 'decideSpecRevisions' ? row.revision?.proposal : (row.kind === 'doctrine' ? 'doctrine:' : '') + row.id) === ids[index]
      && row.decision === (intent.verb === 'spec-approve' ? 'approve' : 'decline')
      && (intent.verb !== 'spec-decline' || row.reason === args.reason.trim())
      && (args.text === undefined ? !requiresShown || row.text === shown.find(entry => entry.id === ids[index])?.text : row.text === args.text.trim())
      && (!requiresShown || row.by === 'person' && row.signature === undefined))
    && (!requiresShown || signedRowDecisionsMatch(record, rows));
}

/** The item ids a request's `implies` text names, parsed as `--implies` is, or null when it names none validly. */
function requestedImplies(text) {
  try { return parseImplies(text) ?? []; } catch { return null; } // an unreadable value matches no move
}

/** The answer id a request's `supersedes` text names, read as `--supersedes` is, or null for none. */
function requestedAnswer(text) {
  if (text === undefined || text === null) return null;
  return /^#?[1-9]\d*$/u.test(String(text).trim()) ? Number(String(text).trim().replace(/^#/u, '')) : NaN;
}

/** Keep receipt shouts fixed so a valid request cannot authorize unrelated person text or flags. */
export function requestStageText(record, phase) {
  const text = phase === 'claim' ? 'Received a request from the paired view.'
    : phase === 'refuse' ? 'Could not fulfil this request. Read its recorded refusal and next step.'
    : 'Apply the person’s recorded row decision with pullboard spec apply, or decline this request with a reason. '
      + record.move.verb + ': ' + (record.move.args.ids ?? record.move.args.row);
  return 'View request ' + record.id + ': ' + text;
}

/** Match the receipt's entire effect, including the absence of decision, answer and evidence flags. */
function fulfilsStage(record, move, tag) {
  const value = move.args[0];
  return move.operation === 'shout' && move.args.length === 1 && value?.from === 'person' && value.to === 'coordinator'
    && value.text === requestStageText(record, tag.phase, tag.error) && !value.decision && value.answers == null && value.evidence == null
    && Boolean(value.request) === (tag.phase === 'repo-request')
    && (tag.phase !== 'repo-request' || ['spec-approve', 'spec-decline', 'spec-answer'].includes(record.move.verb))
    && Object.keys(value).every(key => ['from', 'to', 'text', 'lanes', 'request', 'decision', 'answers', 'evidence'].includes(key));
}

/** Bind a receipt to phone intent; executor takeover uses ordered relay time, not a local preflight clock. */
export function requestMoveProblem(board, move, { checkExecutorLease = true } = {}) {
  const tag = move.personRequest;
  if (!tag) return null;
  if (!tag || typeof tag !== 'object' || typeof tag.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/u.test(tag.id)
      || Object.keys(tag).some(key => !['id', 'executor', 'phase', 'error', 'digest'].includes(key)) || typeof tag.executor !== 'string'
      || !/^[A-Za-z0-9_-]{1,80}$/u.test(tag.executor) || !['claim', 'execute', 'repo-request', 'refuse'].includes(tag.phase)) {
    return new Refused('PERSON_REQUEST_RECEIPT', 'the request receipt is malformed; upgrade the linked machine before fulfilling requests');
  }
  const record = personRequestRecords(board).find(entry => entry.id === tag.id && !entry.duplicateOf);
  if (!record || record.status !== 'waiting') return new Refused('PERSON_REQUEST_CLOSED', 'this request is missing or already resolved; read its original receipt');
  if (move.engine >= 6) {
    let source;
    try { source = JSON.parse(record.received); } catch { /* Missing authenticated provenance refuses below. */ }
    const cursor = Number(board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get('relay_applied_sequence')?.meta_value ?? 0);
    if (source?.sender?.kind !== 'person' || typeof source.sender.userId !== 'string' || !source.sender.userId ||
        JSON.stringify(source.document) !== record.encoded || JSON.stringify(source.document?.move) !== JSON.stringify(record.move) ||
        !Number.isSafeInteger(record.sequence) || record.sequence < 1 || record.sequence > cursor ||
        tag.digest !== requestIntentDigest(record)) return new Refused('PERSON_REQUEST_RECEIPT', 'match the exact earlier authenticated phone request and its payload digest');
    if ((tag.phase === 'execute' && Object.hasOwn(record, 'resultSequence')) ||
        (tag.phase === 'repo-request' && Object.hasOwn(record, 'coordinatorRequest'))) return new Refused('PERSON_REQUEST_CLOSED', 'this phone request already has its execution receipt; read the original result');
  }
  const actor = board.enginePorts.relayMoveActor(move);
  if (!['coordinator', 'person'].includes(actor)) return new Refused('PERSON_REQUEST_RECEIPT', 'only the coordinator fulfils an authenticated person request');
  if (tag.phase === 'execute') {
    const expected = { add: 'addItem', shout: 'shout', answer: 'answerDecision', hold: record.move.args.off ? 'releaseLane' : 'holdLane', 'spec-approve': 'recordRowDecisions', 'spec-decline': 'recordRowDecisions', 'spec-answer': 'recordRowDecisions', fact: 'appendFact', 'sentinel-approve': 'decideSentinel', 'sentinel-decline': 'decideSentinel', 'land-waive': 'recordLandingWaiver', signing: 'setPersonSigning', edit: 'editItem', 'bar-sign': 'signBar' }[record.move.verb];
    const revision = ['spec-approve', 'spec-decline'].includes(record.move.verb) && move.operation === 'decideSpecRevisions';
    if ((!revision && move.operation !== expected) || !fulfilsIntent(record, move, board)) return new Refused('PERSON_REQUEST_RECEIPT', 'the ordinary move does not fulfil this request; execute its original CLI intent');
  }
  if (move.engine >= 6 && ['claim', 'repo-request', 'refuse'].includes(tag.phase) && !fulfilsStage(record, move, tag)) return new Refused('PERSON_REQUEST_RECEIPT', 'publish only the exact stage for this authenticated phone request');
  if (['claim', 'repo-request', 'refuse'].includes(tag.phase) && !(move.operation === 'shout' && move.args[0]?.from === 'person' && move.args[0]?.to === 'coordinator'
      && move.args[0]?.text?.startsWith('View request ' + tag.id + ': '))) return new Refused('PERSON_REQUEST_RECEIPT', 'publish the original person request stage with its matching id');
  if (tag.phase === 'refuse' && !['code', 'message', 'next'].every(key => typeof tag.error?.[key] === 'string' && tag.error[key])) return new Refused('PERSON_REQUEST_RECEIPT', 'publish the original CLI refusal code, reason and next step');
  if (tag.phase === 'repo-request' && !(move.args[0]?.from === 'person' && move.args[0]?.to === 'coordinator' && move.args[0]?.request)) return new Refused('PERSON_REQUEST_RECEIPT', 'repo changes must reach the coordinator as a person request');
  if (tag.phase === 'claim') {
    if (move.operation !== 'shout') return new Refused('PERSON_REQUEST_RECEIPT', 'claim a request with its ordinary coordinator receipt');
    if (checkExecutorLease && record.executor && record.executor !== tag.executor && Date.parse(record.executorUntil ?? record.at) > board.clock.now().getTime()) return new Refused('PERSON_REQUEST_TAKEN', 'another linked machine is fulfilling this request; wait for its receipt');
  } else if (record.executor !== tag.executor) {
    return new Refused('PERSON_REQUEST_TAKEN', 'this linked machine did not win the request; wait for its original receipt');
  }
  if (['claim', 'repo-request', 'refuse'].includes(tag.phase) && move.operation !== 'shout') return new Refused('PERSON_REQUEST_RECEIPT', 'publish this request stage with an ordinary coordinator receipt');
  return null;
}

/** Associate an ordinary move's committed outcome with its request in the same transaction. */
export function recordRequestMove(board, move, outcome, sequence, at) {
  const tag = move.personRequest;
  if (!tag || outcome.error?.code?.startsWith('PERSON_REQUEST_')) return;
  const records = personRequestRecords(board);
  const index = records.findIndex(entry => entry.id === tag.id && !entry.duplicateOf);
  if (index < 0) return;
  const record = { ...records[index] };
  if (tag.phase === 'claim') {
    if (!outcome.error) {
      record.executor = tag.executor;
      record.executorUntil = new Date(Date.parse(at) + 10 * 60 * 1000).toISOString();
    }
  } else if (outcome.error || tag.phase === 'refuse') {
    record.status = 'refused';
    record.error = outcome.error ?? tag.error;
  } else if (tag.phase === 'execute') {
    record.result = outcome.result;
    record.resultSequence = sequence;
    record.resultMove = move.id;
    if (!['spec-approve', 'spec-decline', 'spec-answer'].includes(record.move.verb)) record.status = 'done';
  } else if (tag.phase === 'repo-request') {
    record.coordinatorRequest = outcome.result;
  }
  records[index] = record;
  save(board, records);
}

/** Project the coordinator's final answer alongside direct CLI success or refusal receipts. */
export function personRequestStatuses(board) {
  return personRequestRecords(board).filter(record => !record.duplicateOf).map(record => {
    const { encoded, received, executor, executorUntil, ...publicRecord } = record;
    if (record.coordinatorRequest && record.status === 'waiting') {
      const answer = board.db.prepare("SELECT * FROM shout WHERE shout_answers=? AND shout_request_outcome != '' ORDER BY shout_id LIMIT 1").get(record.coordinatorRequest);
      if (answer) {
        publicRecord.status = answer.shout_request_outcome === 'done' ? 'done' : 'refused';
        if (publicRecord.status === 'refused') publicRecord.error = { code: 'REQUEST_DECLINED', message: answer.shout_text.replace(/^declined\s*/u, ''), next: 'Read the coordinator reason and send a revised request from the view.' };
      }
    }
    return publicRecord;
  });
}
