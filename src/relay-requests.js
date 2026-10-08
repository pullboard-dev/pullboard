/** Durable sealed request intake and ordinary-move receipts; no replica executes CLI intent [H12,H16]. */
import * as store from './board.js';
import { refusalDocument } from './json.js';
import { Refused } from './refused.js';
import { validatePersonRequest } from './person-request.js';
import { relayMoveActor } from './relay-sender.js';

const INDEX = 'relay_person_requests';

/** Read all durable request receipts so an offline browser can still resolve an old request. */
export function personRequestRecords(board) {
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(INDEX);
  return row ? JSON.parse(row.meta_value) : [];
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
    } catch (cause) {
      if (!(cause instanceof Refused)) throw cause;
      error = refusalDocument(cause).error;
    }
    const id = request?.id ?? (typeof document?.id === 'string' && /^[A-Za-z0-9_-]{1,80}$/u.test(document.id) ? document.id : 'refused-' + sequence);
    const previous = records.find(record => record.id === id);
    const encoded = JSON.stringify(request ?? document);
    let record;
    if (previous && !error && previous.encoded === encoded) {
      record = { ...previous, sequence, received, duplicateOf: previous.sequence };
    } else {
      if (previous) error = refusalDocument(new Refused('PERSON_REQUEST_ID', 'this request id already names different intent; reload the paired view and send a new request')).error;
      record = { id: previous ? id + '-' + sequence : id, sequence, at, by: sender?.kind === 'person' ? 'person' : sender?.agent ?? '(unknown sender)', move: request?.move ?? null,
        encoded, received, status: error ? 'refused' : 'waiting', ...(error ? { error } : {}) };
      if (error) {
        const clock = board.clock;
        board.clock = { now: () => new Date(at) };
        try { store.recordRelayRefusal(board, { by: sender?.kind === 'agent' ? sender.agent : 'person', sequence, kind: 'request', operation: document?.operation ?? null, actor: relayMoveActor(document), code: error.code }); }
        finally { board.clock = clock; }
      }
    }
    save(board, [...records, record]);
    board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value').run('relay_applied_sequence', String(sequence));
    return record;
  });
}

/** Compare the requested literal arguments with the ordinary effect produced by the CLI. */
function fulfilsIntent(record, move) {
  const intent = record.move;
  const args = intent.args;
  const value = move.args[0];
  const options = move.args[1];
  if (intent.verb === 'add') return value?.by === 'person' && value.lane === args.lane && value.title === args.title
    && value.criterion === (args.criterion ?? '') && value.brief === (args.brief ?? '')
    && value.route === (args.route ?? 'strong')
    && JSON.stringify(value.specIds) === JSON.stringify((args.specs ?? '').split(',').map(id => id.trim()).filter(Boolean));
  if (intent.verb === 'shout') return value?.from === 'person' && value.text === args.text
    && (args.to === undefined || value.to === args.to) && Boolean(value.decision) === Boolean(args.decision);
  if (intent.verb === 'answer') return value === intent.item && options?.asPerson === true && options.channel === 'view' && options.text === args.text;
  if (intent.verb === 'hold') return value === args.lane && options?.asPerson === true && options.channel === 'view'
    && (args.off || options.reason === (args.reason ?? ''));
  const rows = value?.decisions;
  const ids = args.ids.split(/[\s,]+/u).filter(Boolean);
  return value?.agentId === 'person' && value.channel === 'view' && Array.isArray(rows) && rows.length === ids.length
    && rows.every((row, index) => (row.kind === 'doctrine' ? 'doctrine:' : '') + row.id === ids[index]
      && row.decision === (intent.verb === 'spec-approve' ? 'approve' : 'decline')
      && (intent.verb !== 'spec-decline' || row.reason === args.reason.trim())
      && (args.text === undefined || row.text === args.text.trim()));
}

/** Require an existing person intent and its first elected native executor before an ordinary move. */
export function requestMoveProblem(board, move) {
  const tag = move.personRequest;
  if (!tag) return null;
  if (!tag || typeof tag !== 'object' || typeof tag.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/u.test(tag.id)
      || Object.keys(tag).some(key => !['id', 'executor', 'phase', 'error'].includes(key)) || typeof tag.executor !== 'string'
      || !/^[A-Za-z0-9_-]{1,80}$/u.test(tag.executor) || !['claim', 'execute', 'repo-request', 'refuse'].includes(tag.phase)) {
    return new Refused('PERSON_REQUEST_RECEIPT', 'the request receipt is malformed; upgrade the linked machine before fulfilling requests');
  }
  const record = personRequestRecords(board).find(entry => entry.id === tag.id && !entry.duplicateOf);
  if (!record || record.status !== 'waiting') return new Refused('PERSON_REQUEST_CLOSED', 'this request is missing or already resolved; read its original receipt');
  const actor = relayMoveActor(move);
  if (!['coordinator', 'person'].includes(actor)) return new Refused('PERSON_REQUEST_RECEIPT', 'only the coordinator fulfils an authenticated person request');
  if (tag.phase === 'execute') {
    const expected = { add: 'addItem', shout: 'shout', answer: 'answerDecision', hold: record.move.args.off ? 'releaseLane' : 'holdLane', 'spec-approve': 'recordRowDecisions', 'spec-decline': 'recordRowDecisions' }[record.move.verb];
    if (move.operation !== expected || !fulfilsIntent(record, move)) return new Refused('PERSON_REQUEST_RECEIPT', 'the ordinary move does not fulfil this request; execute its original CLI intent');
  }
  if (['claim', 'repo-request', 'refuse'].includes(tag.phase) && !(move.operation === 'shout' && move.args[0]?.from === 'person' && move.args[0]?.to === 'coordinator'
      && move.args[0]?.text?.startsWith('View request ' + tag.id + ': '))) return new Refused('PERSON_REQUEST_RECEIPT', 'publish the original person request stage with its matching id');
  if (tag.phase === 'refuse' && !['code', 'message', 'next'].every(key => typeof tag.error?.[key] === 'string' && tag.error[key])) return new Refused('PERSON_REQUEST_RECEIPT', 'publish the original CLI refusal code, reason and next step');
  if (tag.phase === 'repo-request' && !(move.args[0]?.from === 'person' && move.args[0]?.to === 'coordinator' && move.args[0]?.request)) return new Refused('PERSON_REQUEST_RECEIPT', 'repo changes must reach the coordinator as a person request');
  if (tag.phase === 'claim') {
    if (move.operation !== 'shout') return new Refused('PERSON_REQUEST_RECEIPT', 'claim a request with its ordinary coordinator receipt');
    if (record.executor && record.executor !== tag.executor && Date.parse(record.executorUntil ?? record.at) > board.clock.now().getTime()) return new Refused('PERSON_REQUEST_TAKEN', 'another linked machine is fulfilling this request; wait for its receipt');
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
    if (!['spec-approve', 'spec-decline'].includes(record.move.verb)) record.status = 'done';
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
