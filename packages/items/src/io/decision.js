/** Local durable I-D contract; consumers supply their existing authority port and ordered mutation boundary. */
import { createHash } from 'node:crypto';
import { Refused } from "../../../kernel/index.js";

function binding() { return new Refused('DECISION_HANDOFF_BINDING', 'Use the exact versioned handoff, namespaced decision and original option set.'); }
function denied() { return new Refused('DECISION_HANDOFF_AUTH', 'Obtain authority for this exact disclosed question, answer or source query.'); }
function conflict() { return new Refused('DECISION_HANDOFF_CONFLICT', 'Use the recorded handoff and answer; create a new source decision to change its options or outcome.'); }

/** Board identifiers are opaque: only the composition boundary resolves names. */
function identifier(value) { return typeof value === 'string' && value.length > 0 && value.length <= 256; }
function fields(value, names) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === names.split(',').sort().join(',');
}
function reference(value) {
  if (!fields(value, 'boardId,decisionId') || !identifier(value.boardId) ||
      !(identifier(value.decisionId) || Number.isSafeInteger(value.decisionId) && value.decisionId > 0)) throw binding();
  return { boardId: value.boardId, decisionId: value.decisionId };
}

/** Hash the option set, not its presentation order; ambiguous duplicate options refuse. */
export function optionsDigest(options) {
  if (!Array.isArray(options) || options.length < 1 || options.length > 32 ||
      options.some(option => !identifier(option)) || new Set(options).size !== options.length) throw binding();
  return createHash('sha256').update(JSON.stringify([...options].sort())).digest('hex');
}

/** Snapshot bounded wire data before an asynchronous authority check can yield to its caller. */
function snapshot(input) {
  try {
    const text = JSON.stringify(input);
    if (!text || text.length > 16384) throw binding();
    return JSON.parse(text);
  } catch { throw binding(); }
}
function wire(input, options, local) {
  const value = snapshot(input);
  if (!fields(value, 'version,handoffId,source,destinationBoardId,requester,question,optionsDigest,authority,answer') ||
      value.version !== 1 || !identifier(value.handoffId) || !identifier(value.destinationBoardId) ||
      !identifier(value.requester) || typeof value.question !== 'string' || !value.question || value.question.length > 4096 ||
      value.authority == null || !['string', 'object'].includes(typeof value.authority) ||
      value.optionsDigest !== optionsDigest(options)) throw binding();
  value.source = reference(value.source);
  if (local !== value.source.boardId && local !== value.destinationBoardId) throw binding();
  if (value.answer !== null && (!fields(value.answer, 'boardId,option') ||
      value.answer.boardId !== value.destinationBoardId || !options.includes(value.answer.option))) throw binding();
  return { version: 1, handoffId: value.handoffId, source: value.source,
    destinationBoardId: value.destinationBoardId, requester: value.requester, question: value.question,
    optionsDigest: value.optionsDigest, authority: value.authority,
    answer: value.answer === null ? null : { boardId: value.answer.boardId, option: value.answer.option } };
}
function correlation(value) {
  const { authority, answer, ...body } = value;
  return JSON.stringify(body);
}

/** Each store owns only its supplied SQLite board; delivery is retried independently at the other board. */
export function decisionHandoffs(db, { boardId, authorize }) {
  if (!identifier(boardId) || typeof authorize !== 'function') throw binding();
  db.exec(`CREATE TABLE IF NOT EXISTS decision_handoff_v1 (
    handoff_id TEXT PRIMARY KEY, source_board TEXT NOT NULL, source_decision TEXT NOT NULL,
    destination TEXT NOT NULL, wire TEXT NOT NULL, UNIQUE(source_board,source_decision,destination))`);
  return {
    /** Repeated questions cannot erase answers; a second outcome or changed identity never overwrites the first. */
    async deliver(input, suppliedOptions) {
      const options = snapshot(suppliedOptions);
      const value = wire(input, options, boardId);
      if (!await authorize('disclose', snapshot(value)) ||
          value.answer && !await authorize('answer', snapshot(value))) throw denied();
      db.exec('SAVEPOINT decision_handoff_delivery');
      try {
        const row = db.prepare(`SELECT wire FROM decision_handoff_v1 WHERE handoff_id=? OR
          (source_board=? AND source_decision=? AND destination=?)`)
          .get(value.handoffId, value.source.boardId, JSON.stringify(value.source.decisionId), value.destinationBoardId);
        const prior = row ? JSON.parse(row.wire) : null;
        const sibling = db.prepare('SELECT wire FROM decision_handoff_v1 WHERE source_board=? AND source_decision=? LIMIT 1')
          .get(value.source.boardId, JSON.stringify(value.source.decisionId));
        const first = sibling ? JSON.parse(sibling.wire) : null;
        if (first && ['optionsDigest', 'requester', 'question'].some(key => first[key] !== value[key])) throw conflict();
        if (prior && (correlation(prior) !== correlation(value) ||
            prior.answer && value.answer && JSON.stringify(prior.answer) !== JSON.stringify(value.answer))) throw conflict();
        const result = prior && (prior.answer || !value.answer) ? prior : value;
        if (!prior) db.prepare('INSERT INTO decision_handoff_v1 VALUES(?,?,?,?,?)').run(value.handoffId,
          value.source.boardId, JSON.stringify(value.source.decisionId), value.destinationBoardId, JSON.stringify(result));
        else if (result !== prior) db.prepare('UPDATE decision_handoff_v1 SET wire=? WHERE handoff_id=?')
          .run(JSON.stringify(result), value.handoffId);
        db.exec('RELEASE decision_handoff_delivery');
        return snapshot(result);
      } catch (error) {
        db.exec('ROLLBACK TO decision_handoff_delivery');
        db.exec('RELEASE decision_handoff_delivery');
        throw error;
      }
    },
    /** Query is source-authorized independently of the capabilities used to disclose each destination question. */
    async query(input, requested, authority) {
      const source = reference(snapshot(input)), participants = snapshot(requested);
      if (source.boardId !== boardId || !Array.isArray(participants) || participants.length < 1 || participants.length > 32 ||
          participants.some(participant => !identifier(participant)) || new Set(participants).size !== participants.length) throw binding();
      participants.sort();
      if (!await authorize('read', snapshot({ version: 1, source, participants, authority }))) throw denied();
      const rows = db.prepare('SELECT wire FROM decision_handoff_v1 WHERE source_board=? AND source_decision=? ORDER BY destination')
        .all(source.boardId, JSON.stringify(source.decisionId)).map(row => JSON.parse(row.wire));
      if (rows.some(value => !participants.includes(value.destinationBoardId))) throw binding();
      const answers = rows.filter(value => value.answer).map(value => value.answer);
      const complete = rows.length === participants.length && answers.length === participants.length;
      const sameOptions = rows.every(value => value.optionsDigest === rows[0].optionsDigest);
      return { complete, agreed: complete && sameOptions && new Set(answers.map(answer => answer.option)).size === 1, answers };
    },
  };
}
