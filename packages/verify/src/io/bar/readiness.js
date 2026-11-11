import {
  readBarState as read,
  barReadySetting,
} from '../../logic/bar/corrections.js';
export { barReadySetting };
import { normalizeBarActor } from './actor.js';
import {
  normalizeBarCoverage,
  barCoverageDigest,
} from './coverage.js';
/** Readiness is a revision-bound peer judgement, with mechanical prerequisites [B4,V1,V2,H16]. */
import { createHash } from 'node:crypto';
import { agentParent } from '../../../../seats/index.js';
import { ENGINE_VERSION } from '../../../../state/index.js';
import { BAR_READY_ENGINE } from '../../../../state/light.js';
import { Refused } from '../../../../kernel/index.js';

const FIELDS = ['item_title', 'item_criterion', 'item_check', 'item_brief', 'item_spec_ids', 'item_after', 'item_route'];
/** Write within the caller's atomic move. */
function save(board, key, value) {
  board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value').run(key, JSON.stringify(value));
}
/** A primary session's own recorded identity is known; a seat-name fallback is not. */
function parent(board, agent) {
  return agentParent(board, agent) ?? board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`agent_session:${agent}`)?.meta_value ?? null;
}
/** Bind the entire author-written bar, including coverage and measurement notes in the brief. */
export function barDigest(item) {
  return createHash('sha256').update(JSON.stringify(FIELDS.map(key => [key, item[key] ?? '']))).digest('hex');
}
/** Make activation an ordered boundary; repeating on does not erase earlier obligations. */
export function setBarReady(board, { agentId, enabled }) {
  const { atomic, logEvent } = board.nativePorts;
  if (agentId !== 'coordinator') throw new Refused('COORDINATOR_ONLY', 'only the coordinator changes bar readiness; shout coordinator');
  if (typeof enabled !== 'boolean') throw new Refused('USAGE', 'pullboard bar ready on|off');
  return atomic(board, () => {
    const prior = barReadySetting(board);
    if (prior.enabled === enabled) return prior;
    const grandfathered = enabled ? board.db.prepare('SELECT * FROM item WHERE item_frozen_digest IS NOT NULL').all().map(item => ({ id: item.item_id, digest: barDigest(item), frozen: item.item_frozen_digest, revision: read(board, `bar_revision:${item.item_id}`)?.revision ?? 0 })) : [];
    logEvent(board, agentId, 'bar-ready', null, { enabled, grandfathered });
    const setting = { enabled, since: board.lastEvent.event_id };
    for (const bar of grandfathered) save(board, `bar_grandfather:${bar.id}`, { ...bar, since: setting.since });
    save(board, 'bar_ready_setting', setting);
    return setting;
  });
}
/** Retain every field's prior author when readiness is enabled on an existing open item. */
function historicalAuthors(board, item) {
  const fields = Object.fromEntries(FIELDS.map(field => [field, item.item_created_by]));
  for (const event of board.db.prepare("SELECT event_by,event_detail FROM event WHERE item_id=? AND event_kind='edit' ORDER BY event_id").all(item.item_id)) {
    const detail = JSON.parse(event.event_detail);
    for (const [key, field] of Object.entries({ brief: 'item_brief', criterion: 'item_criterion', check: 'item_check', after: 'item_after', route: 'item_route' })) {
      if (Object.hasOwn(detail, key)) fields[field] = event.event_by;
    }
  }
  return Object.fromEntries(Object.entries(fields).map(([field, agent]) => [field, { agent, parent: parent(board, agent) }]));
}
/** Snapshot authors on semantic edits, never retroactively upgrading an unknown historical parent. */
export function recordBarRevision(board, item, by, before = null, actor = null) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < BAR_READY_ENGINE || !barReadySetting(board).enabled) return;
  const { logEvent } = board.nativePorts;
  const previous = read(board, `bar_revision:${item.item_id}`);
  const changed = FIELDS.filter(key => !before || before[key] !== item[key]);
  if (!changed.length && previous) return;
  const authors = previous?.authors ?? historicalAuthors(board, item);
  const currentActor = normalizeBarActor(actor);
  for (const field of FIELDS) {
    if (changed.includes(field)) authors[field] = { agent: by, ...currentActor };
    else if (!authors[field]) authors[field] = { agent: item.item_created_by, parent: parent(board, item.item_created_by) };
  }
  const revision = { digest: barDigest(item), authors };
  logEvent(board, by, 'bar-revision', item.item_id, revision);
  save(board, `bar_revision:${item.item_id}`, { ...revision, revision: board.lastEvent.event_id });
}
/** Parse explicit notes without pretending a regular expression can grade their adequacy. */
export function barNotes(brief) {
  const sections = {};
  let key = '';
  for (const line of String(brief).split(/\r?\n/u)) {
    const label = /^([a-z][a-z ]*):\s*(.*)$/iu.exec(line.trim());
    if (label) { key = label[1].toLowerCase(); sections[key] = label[2].trim(); }
    else if (key && line.trim()) sections[key] += `\n${line.trim()}`;
  }
  return sections;
}
/** An already-frozen bar predating activation needs no backfill until its words change. */
export function barReadinessRequired(board, item) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < BAR_READY_ENGINE) return false;
  const setting = barReadySetting(board);
  if (!setting.enabled) return false;
  if (!item.item_frozen_digest) return true;
  const old = read(board, `bar_grandfather:${item.item_id}`);
  const revision = read(board, `bar_revision:${item.item_id}`)?.revision ?? 0;
  return !old || old.since !== setting.since || old.digest !== barDigest(item)
    || old.frozen !== item.item_frozen_digest || old.revision !== revision;
}
/** Mechanical omissions are aggregated, so the coordinator can repair the bar in one pass. */
export function barReadiness(board, item, { signature = true } = {}, { itemCheckBaseline }) {
  const revision = read(board, `bar_revision:${item.item_id}`);
  const notes = barNotes(item.item_brief);
  const baseline = itemCheckBaseline(board, item);
  const missing = [];
  if (!notes['named test']) missing.push('Named test: the case this check proves');
  const witness = notes['named test'];
  const evidence = baseline?.testEvidence;
  const namedRed = witness && evidence && !evidence.passed.some(name => name.includes(witness))
    && (evidence.failed.some(name => name.includes(witness)) || evidence.noTestsMatched && item.item_check.includes(witness));
  if (!baseline || baseline.result !== 'red' || baseline.command !== item.item_check || !baseline.main || !namedRed) missing.push('a recorded red check baseline at main for the Named test (emit named TAP/JUnit cases with timing; an absent named case counts, unrelated shell failures do not)');
  if (!notes.measurements) missing.push('Measurements: a method beside each quantitative bound, or an explicit statement that there are none');
  if (!notes['reviewer edges']) missing.push('Reviewer edges: cases a reviewer should try');
  if (!revision || revision.digest !== barDigest(item)) missing.push('a recorded current bar revision (edit the brief)');
  const signed = read(board, `bar_sign:${item.item_id}`);
  const baselineDigest = createHash('sha256').update(JSON.stringify(baseline)).digest('hex');
  if (signature && (!signed || signed.revision !== revision?.revision || signed.digest !== revision?.digest || signed.baselineDigest !== baselineDigest || !signed.coverage || signed.coverageDigest !== barCoverageDigest(signed.coverage))) missing.push('sign-off by another parent session: pullboard bar sign '+item.item_id);
  return { revision, notes, baseline, baselineDigest, signed, missing };
}
/** The same board guard protects explicit claim, next, run, renew and submit. */
export function barReadyProblem(board, item) {
  if (!barReadinessRequired(board, item)) return null;
  const status = barReadiness(board, item, {}, board.runtimePorts.verification);
  return status.missing.length ? new Refused('BAR_NOT_READY', `#${item.item_id}'s bar needs ${status.missing.join('; ')}; ask its author to edit the brief, then another session runs pullboard bar sign ${item.item_id}`) : null;
}
/** Record the peer's judgement against exact words, author identities and baseline observation. */
export function signBar(board, id, { agentId, revision, digest, note, coverage, barActor }) {
  const { atomic, logEvent } = board.nativePorts;
  const { itemById } = board.runtimePorts.verification;
  return atomic(board, () => {
    const item = itemById(board, id);
    if (['verified','withdrawn'].includes(item.item_status)) throw new Refused('CLOSED', `#${id} is ${item.item_status}; sign an open bar`);
    const status = barReadiness(board, item, { signature: false }, board.runtimePorts.verification);
    if (status.missing.length) throw new Refused('BAR_NOT_READY', `#${id} needs ${status.missing.join('; ')}; edit the brief or wait for its baseline before signing`);
    if (status.revision.revision !== revision || status.revision.digest !== digest) throw new Refused('BAR_SIGN_STALE', `#${id}'s bar changed; read it again before pullboard bar sign ${id}`);
    const signerActor = normalizeBarActor(barActor);
    const signerParent = signerActor.parent;
    const signerPerson = signerActor.authority === 'person';
    const authors = Object.values(status.revision.authors);
    const agentAuthors = authors.filter(author => author.authority !== 'person');
    if (agentAuthors.some(author => !author.parent) || !signerPerson && agentAuthors.length && !signerParent) throw new Refused('BAR_PARENT_UNKNOWN', `#${id} needs known agent author and signer session identities; join from the real runtime session, then author a new bar revision`);
    const selfSign = signerPerson ? authors.some(author => author.authority === 'person')
      : agentAuthors.some(author => author.agent === agentId || author.parent === signerParent);
    if (selfSign) throw new Refused('BAR_SELF_SIGN', `#${id}'s author and its helpers cannot sign their own bar; ask another authority or parent session`);
    if (typeof note !== 'string' || !note.trim()) throw new Refused('NOTE_REQUIRED', 'say whether a builder can meet this bar and two reviewers would grade it the same: --note "..."');
    const plan = normalizeBarCoverage(coverage, item);
    const signed = { revision, digest, coverage: plan, coverageDigest: barCoverageDigest(plan), baselineDigest: status.baselineDigest, authorParents: authors, signerParent, signerSession: signerActor.session, signerAuthority: signerPerson ? 'person' : 'agent', note: note.trim() };
    logEvent(board, agentId, 'bar-sign', id, signed);
    save(board, `bar_sign:${id}`, { ...signed, by: agentId, event: board.lastEvent.event_id });
    return { id, ...signed };
  });
}
