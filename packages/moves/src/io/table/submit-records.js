/** Rebuild every recorded submit-family write from a board, read-only, as replay records for the submit tables [C7,#8247]. */
import { openBoardReadOnly } from '../../../../store/index.js';

const LEASE_MS = 7_200_000;
const HISTORY = new Set(['add', 'edit', 'claim', 'renew', 'release', 'submit', 'accept', 'reject', 'reopen', 'withdraw', 'merged', 'escalate',
  'hold_item', 'unhold_item', 'refreeze', 'reserve', 'reject_returned', 'submit_handoff_returned', 'submit-handoff']);
/** As the board stores it, without the actor's model, which the event writer stamps on every event and no move decides. */
const strip = ({ model, ...rest }) => JSON.parse(JSON.stringify(rest));
const CONFIG = { handoff: true, leaseMs: LEASE_MS };

/**
 * Read every submit-family write recorded at or after `since`, each as `{ table, path, event, snapshot, move, recorded }`.
 * One forward fold over the whole event log (and the gate job records the hand-off keeps) rebuilds each item's state; just before each write
 * the fold is snapshotted and the move rebuilt. Paths whose inputs history cannot rebuild are listed with why.
 * Why: a table is trusted only once it reproduces what the board really decided, write by write.
 *
 * @param {string | { db: object }} board - A board file path, or an open board (only SELECTed).
 * @param {{ since: string }} options - ISO time; writes at or after it are read.
 * @returns {{ records: object[], unreplayable: { event: number, path: string, why: string }[] }}
 */
export function readSubmitRecords(board, { since }) {
  const opened = typeof board === 'string' ? openBoardReadOnly(board) : null;
  try {
    return rebuild(opened ?? board.db, since);
  } finally {
    if (opened) opened.close();
  }
}

/** The rebuild itself, over an open connection. */
function rebuild(db, since) {
  const records_out = [], unreplayable = [];
  const agents = Object.fromEntries(db.prepare('SELECT agent_id, agent_lane, agent_route FROM agent').all().map(a => [a.agent_id, { lane: a.agent_lane, route: a.agent_route, joined: false }]));
  const parents = Object.fromEntries(db.prepare('SELECT item_id, item_parent_id FROM item').all().map(r => [r.item_id, r.item_parent_id]));
  const childrenOf = new Map();
  for (const [id, p] of Object.entries(parents)) if (p != null) (childrenOf.get(p) ?? childrenOf.set(p, []).get(p)).push(Number(id));
  const outside = new Set(db.prepare("SELECT meta_key, meta_value FROM board_meta WHERE meta_key LIKE 'outside_source:%'").all().filter(r => r.meta_value.includes('pull-request')).map(r => Number(r.meta_key.split(':')[1])));
  const shouts = new Map(db.prepare('SELECT shout_id, shout_from, shout_to, shout_text FROM shout').all().map(r => [r.shout_id, r]));
  const records = new Map();
  for (const r of db.prepare("SELECT j.job_item item, s.job_step_payload p FROM job_step s JOIN job j ON j.job_id = s.job_step_job WHERE j.job_kind='gate' AND j.job_item IS NOT NULL ORDER BY s.job_step_id").all()) {
    if (!r.p.includes('"record"')) continue;
    let rec; try { rec = JSON.parse(r.p).record; } catch { continue; }
    if (rec) (records.get(r.item) ?? records.set(r.item, []).get(r.item)).push(rec);
  }
  const cursor = new Map();
  function matchRecord(item, state, commit) {
    const list = records.get(item) ?? [];
    for (let i = cursor.get(item) ?? 0; i < list.length; i++) if (list[i].state === state && list[i].commit === commit) { cursor.set(item, i + 1); return list[i]; }
    return null;
  }
const items = new Map();
const byOwner = new Map();
const setOwner = (it, owner) => { if (it.owner) byOwner.get(it.owner)?.delete(it.id); it.owner = owner; if (owner) (byOwner.get(owner) ?? byOwner.set(owner, new Set()).get(owner)).add(it.id); };

/** Apply one event to the fold (claim replay's fold, plus submits, rejects, receipts and the hand-off record). */
function apply(e) {
  if (e.kind === 'join' && agents[e.by]) { agents[e.by].joined = true; if (e.detail.route) agents[e.by].route = e.detail.route; if (e.detail.lane) agents[e.by].lane = e.detail.lane; return; }
  if (e.item == null) return;
  let it = items.get(e.item);
  if (e.kind === 'add') {
    it = { id: e.item, status: 'open', owner: null, leaseUntil: null, lane: e.detail.lane, route: e.detail.route, after: (e.detail.after ?? []).filter(Number.isInteger),
      parentId: parents[e.item] ?? null, holdReason: null, frozenDigest: null, expectedMinutes: e.detail.expectedBuildMinutes ?? null, builtBy: null, verdict: null, commit: null,
      merged: false, handoff: null, history: [], claimWaiting: [], rejects: [], submits: [], receipts: [], diagnosed: false };
    items.set(e.item, it);
  }
  if (!it) return;
  if (HISTORY.has(e.kind)) it.history.push(e);
  const d = e.detail;
  switch (e.kind) {
    case 'claim': case 'renew': it.status = 'claimed'; setOwner(it, e.by); it.leaseUntil = d.leaseUntil; if (d.digest) it.frozenDigest = d.digest; break;
    case 'submit_handoff_returned': if (d.leaseUntil) { it.status = 'claimed'; setOwner(it, e.by); it.leaseUntil = d.leaseUntil; } break;
    case 'release': if (!d.review) { it.status = 'open'; setOwner(it, null); it.leaseUntil = null; } if (d.idleClaim?.waitingOn?.length) it.claimWaiting = d.idleClaim.waitingOn; if (d.reasonCode === 'DIAGNOSIS_WRONG') { it.route = 'mid'; it.diagnosed = false; } break;
    case 'submit': it.status = 'submitted'; it.builtBy = e.by; it.commit = d.commit; it.leaseUntil = null; it.verdict = d.mergeOnly ? 'ACCEPT' : null; it.submits.push(e); break;
    case 'merge-only-accept': break;
    case 'accept': it.status = 'verified'; it.verdict = 'ACCEPT'; break;
    case 'reject': it.status = 'open'; it.verdict = 'REJECT'; setOwner(it, null); it.leaseUntil = null; it.rejects.push({ commit: d.commit ?? it.commit, digest: d.digest ?? it.frozenDigest }); break;
    case 'reopen': it.status = 'open'; setOwner(it, null); it.leaseUntil = null; it.verdict = null; break;
    case 'withdraw': it.status = 'withdrawn'; setOwner(it, null); it.leaseUntil = null; break;
    case 'merged': it.status = 'verified'; it.merged = true; setOwner(it, null); it.leaseUntil = null; break;
    case 'escalate': if (d.to) it.route = d.to; break;
    case 'fact': if (d.kind === 'diagnosis') { it.route = 'light'; it.diagnosed = true; } break;
    case 'hold_item': it.holdReason = d.reason ?? 'held'; break;
    case 'unhold_item': it.holdReason = null; break;
    case 'refreeze': if (d.after) it.frozenDigest = d.after; if (!d.retainedClaim && !d.unchanged) { setOwner(it, null); it.leaseUntil = null; if (it.status === 'claimed') it.status = 'open'; } break;
    case 'proof-run': if (d.receipt) it.receipts.push(d.receipt); break;
    case 'submit-handoff': { const rec = matchRecord(e.item, d.state, d.commit); it.handoff = rec ?? synthetic(it, e); break; }
    case 'edit':
      if (typeof d.route === 'string') it.route = d.route;
      if ('criterion' in d || 'check' in d || 'brief' in d) it.diagnosed = false;
      if (Array.isArray(d.after)) { it.after = d.after.filter(Number.isInteger); it.claimWaiting = it.claimWaiting.filter(x => d.after.includes(x)); }
      if ('expectedBuildMinutes' in d) it.expectedMinutes = d.expectedBuildMinutes;
      if (d.correctedFrozen) it.frozenDigest = d.correctedFrozen;
      if (d.unfrozen || d.machineVerification) it.frozenDigest = null;
      if (d.expiredHolder) { it.status = 'open'; setOwner(it, null); it.leaseUntil = null; }
      break;
  }
}

/**
 * A hand-off record rebuilt from events alone, for gates whose job steps were pruned: a queue starts a new job at the
 * item's frozen bar; every later event moves the same job. Fields the events never carry (tree, main) stay unknown.
 */
function synthetic(it, e) {
  const prior = it.handoff;
  if (e.detail.state === 'queued') return { version: 1, id: `ev-${e.id}`, agentId: e.by, commit: e.detail.commit, digest: it.frozenDigest, companionDigest: null,
    leaseMs: LEASE_MS, state: 'queued', at: e.at, synthetic: true, ...(prior?.state === 'infrastructure' && prior.commit === e.detail.commit ? { retryOf: prior.id, infrastructureRetries: (prior.infrastructureRetries ?? 0) + 1 } : {}) };
  return { ...(prior ?? { version: 1, id: `ev-${e.id}`, agentId: e.by, commit: e.detail.commit, digest: it.frozenDigest, companionDigest: null, leaseMs: LEASE_MS }), state: e.detail.state, synthetic: true };
}
/** The record a hand-off write produced, rebuilt from events when its job steps were pruned. */
function syntheticAfter(it, e) { const saved = it.handoff; const r = synthetic(it, e); it.handoff = saved; return r; }

/** The snapshot the submit tables read, from the fold. */
function snapshot(itemId, actor, now) {
  const it = items.get(itemId);
  return {
    now, config: CONFIG, actor: { id: actor, joined: true, lane: agents[actor]?.lane },
    item: { id: it.id, status: it.status, owner: it.owner, leaseUntil: it.leaseUntil, frozenDigest: it.frozenDigest, lane: it.lane, parentId: it.parentId,
      verdict: it.verdict, commit: it.commit, builtBy: it.builtBy, files: [], outside: outside.has(it.id) ? 'pull-request' : null },
    children: (childrenOf.get(it.id) ?? []).filter(id => items.has(id)).map(id => ({ id, status: items.get(id).status })),
    rejects: it.rejects, history: it.history, submits: it.submits, receipts: it.receipts,
    handoff: it.handoff,
    io: { head: null }, deferred: {}, gate: null,
  };
}

  const skip = (e, path, why) => unreplayable.push({ event: e.id, path, why });
  /** The written event as the table writes it: shouts by recipient and text, everything else by kind, writer and detail. */
  const written = e => e.kind === 'shout'
    ? { kind: 'shout', by: e.by, item: null, detail: { to: e.detail.to, text: e.detail.text ?? shouts.get(e.detail.shout)?.shout_text } }
    : { kind: e.kind, by: e.by, detail: strip(e.detail) };
  const push = (table, path, e, s, m, members, via) => records_out.push({ table, path, via, event: { id: e.id, at: e.at }, snapshot: structuredClone(s), move: structuredClone(m), recorded: { events: members.map(written) } });
// ---- Group the writes of one completion transaction: the returns, release, renew and shouts written before its record. ----
const all = db.prepare('SELECT event_id id, event_at at, event_kind kind, event_by by, item_id item, event_detail d FROM event ORDER BY event_id').all()
  .map(r => { return { id: r.id, at: r.at, kind: r.kind, by: r.by, item: r.item, detail: JSON.parse(r.d || '{}') }; });
const groupOf = new Map(); // first event id -> { lead: terminal event, members }
const member = new Set();
for (let i = 0; i < all.length; i++) {
  const e = all[i];
  if (e.kind !== 'submit-handoff' || !['red', 'incomplete', 'infrastructure', 'green', 'submitted', 'queued', 'running'].includes(e.detail.state)) continue;
  const terminal = ['red', 'incomplete', 'infrastructure'].includes(e.detail.state);
  const members = [];
  for (let j = i - 1; terminal && j >= 0 && members.length < 4; j--) {
    const p = all[j];
    const companion = (p.item === e.item && p.by === e.by && (p.kind === 'submit_handoff_returned' || (p.kind === 'renew' && p.detail.queuedRedReturn) || (p.kind === 'release' && /^the queued gate was refused/u.test(p.detail.reason ?? ''))))
      || (p.kind === 'shout' && ['coordinator', 'sentinel'].includes(p.by) && /^Queued (gate|submit) #(\d+)/u.exec(shouts.get(p.detail.shout)?.shout_text ?? '')?.[2] === String(e.item));
    if (!companion) break;
    members.unshift(p);
  }
  for (const p of members) member.add(p.id);
  groupOf.set(members[0]?.id ?? e.id, { lead: e, members: [...members, e] });
}


for (const e of all) {
  const group = groupOf.get(e.id);
  if (e.at >= since && group && group.lead.item != null && items.has(group.lead.item)) replayHandoff(group);
  else if (e.at >= since && !member.has(e.id) && e.kind === 'submit' && items.has(e.item)) replaySubmit(e);
  else if (e.at >= since && !member.has(e.id) && e.kind === 'renew' && e.detail.submitOutcome && items.has(e.item)) replayOutcome(e);
  else if (e.at >= since && !member.has(e.id) && e.kind === 'submit_handoff_returned') skip(e, 'submit_handoff_returned outside a completion', 'ungrouped');
  apply(e);
}

/** A submit event: the post-gate COMMIT move, with the gate's result as the shell input. */
function replaySubmit(e) {
  const d = e.detail, it = items.get(e.item);
  const worker = it.handoff && it.handoff.state === 'running' && it.handoff.commit === d.commit;
  const path = `submit (${worker ? 'queued gate worker' : 'synchronous gate'})${d.mergeOnly ? ' merge-only' : ''}`;
  if (d.mergeOnly) return skip(e, path, 'merge-only carry is deferred');
  const s = snapshot(e.item, e.by, e.at);
  s.gate = { green: d.gateGreen, size: d.submissionSize, tooling: d.tooling, policyCommit: d.policyCommit };
  s.deferred = { proofRecord: d.submissionProof ?? null, builderFamily: null };
  const m = { id: e.item, actor: e.by, commit: d.commit, tree: d.tree, note: d.note, infra: d.infra, worker, companionRecord: d.companion, quarantineProofIds: d.quarantineProofIds };
  push('COMMIT', path, e, s, m, [e], 'submit');
}

/** A CLI refusal renewal: OUTCOME decides and shapes the submitOutcome the renewal records. */
function replayOutcome(e) {
  const d = e.detail, o = d.submitOutcome;
  const path = `renew with submitOutcome (command refusal ${o.stage === 'fast' ? 'fast' : 'late'})`;
  const now = new Date(Date.parse(d.leaseUntil) - LEASE_MS).toISOString();
  const s = snapshot(e.item, e.by, now);
  const m = { id: e.item, actor: e.by, digest: o.digest, stage: o.stage, refusal: { code: o.code, text: o.text } };
  records_out.push({ table: 'OUTCOME', path, event: { id: e.id, at: e.at }, snapshot: structuredClone(s), move: m, recorded: { events: [] }, renewal: strip(d.submitOutcome) });
}

/** One hand-off write (queue, start, retry, hook, completion) with the events written in its transaction. */
function replayHandoff({ lead: e, members }) {
  const it = items.get(e.item);
  const rec = (records.get(e.item) ?? []).slice(cursor.get(e.item) ?? 0).find(r => r.state === e.detail.state && r.commit === e.detail.commit);
  const prior = it.handoff;
  const pruned = !rec;
  const r = rec ?? syntheticAfter(it, e);
  if (pruned) { const code = members.map(x => x.detail?.submitOutcome?.code ?? /refused \(([A-Z_]+)\)/u.exec(x.detail?.reason ?? shouts.get(x.detail?.shout)?.shout_text ?? '')?.[1]
      ?? /\(([A-Z_]+)\)/u.exec(shouts.get(x.detail?.shout)?.shout_text ?? '')?.[1]).find(Boolean);
    r.error = { code: code ?? 'UNKNOWN', message: members.find(x => x.detail?.submitOutcome)?.detail.submitOutcome.text ?? '', next: '-' }; r.submitted = e.detail.commit; }
  return replayHandoffWith(e, members, it, prior, r, pruned);
}
function replayHandoffWith(e, members, it, prior, rec, pruned) {
  if (!pruned && prior?.synthetic && prior.id !== rec.id && !rec.retryOf && rec.state !== 'queued') {
    const { error, completedAt, gateGreen, submitted, lockWaits, startedAt, hookProjection, ...base } = rec;
    it.handoff = prior = { ...base, state: prior.state, ...(prior.state === 'running' && startedAt ? { startedAt } : {}) };
  }
  if (pruned && ['green', 'submitted'].includes(e.detail.state)) return skip(e, `${e.detail.state} (gate result stored)`, 'proof clause needs the pruned job record');
  if (pruned && e.detail.state === 'infrastructure' && rec.error.code === 'UNKNOWN') return skip(e, 'infrastructure', 'the stop code lived only in the pruned job record');
  const tag = pruned ? ' [job record pruned]' : '';
  const judgeR = (path, table, s, m, out, want) => push(table, path + tag, e, s, m, members, want);
  const st = e.detail.state;
  if (st === 'queued' && rec.retryOf) {
    const s = snapshot(e.item, e.by, rec.at ?? e.at); s.io.companionDigest = rec.companionDigest;
    const m = { id: e.item, actor: e.by, job: pruned ? prior?.id : rec.retryOf, retryJob: pruned ? '11111111-1111-4111-8111-111111111111' : rec.id };
    return judgeR('queued (requeue of a stopped gate)', 'START', s, m, null, 'retry');
  }
  if (st === 'queued') {
    const s = snapshot(e.item, e.by, rec.at ?? e.at);
    s.io.head = { commit: rec.commit, tree: rec.tree ?? rec.commit, main: rec.main ?? rec.commit, executionCommit: rec.executionCommit ?? rec.commit, executionTree: rec.executionTree ?? rec.tree ?? rec.commit };
    s.io.companionDigest = rec.companionDigest;
    const m = { id: e.item, actor: e.by, job: pruned ? '00000000-0000-4000-8000-000000000000' : rec.id };
    return judgeR('queued (submit queues its gate)', 'SUBMIT', s, m, null, 'queue');
  }
  if (st === 'running') {
    const hook = prior?.state === 'running' && rec.hookProjection;
    const s = snapshot(e.item, e.by, rec.startedAt ?? rec.hookProjection?.at ?? e.at);
    const m = { id: e.item, actor: e.by, job: pruned ? prior?.id : rec.id, ...(hook ? { hook: (({ at, ...p }) => p)(rec.hookProjection) } : {}) };
    return judgeR(hook ? 'running (merge-hook projection)' : 'running (worker starts the gate)', 'START', s, m, null, hook ? 'hook' : 'start');
  }
  if (st === 'infrastructure' && prior?.state === 'infrastructure') {
    const s = snapshot(e.item, e.by, e.at);
    const m = { id: e.item, actor: e.by, job: rec.id, unrecoverable: /captured tools cannot be recovered \((.*)\)\. Restore/u.exec(members.map(written).find(x => x.kind === 'shout')?.detail.text ?? '')?.[1] ?? 'unknown' };
    return judgeR('infrastructure (retries spent, tools unrecoverable)', 'START', s, m, null, 'spend');
  }
  const renewed = members.find(x => x.kind === 'renew' && x.detail.leaseUntil);
  const s = snapshot(e.item, e.by, renewed ? new Date(Date.parse(renewed.detail.leaseUntil) - LEASE_MS).toISOString() : rec.completedAt ?? e.at);
  if (['green', 'submitted'].includes(st)) {
    
    const m = { id: e.item, actor: e.by, job: rec.id, result: { code: 0, commit: rec.submitted, ...(rec.lockWaits ? { lockWaits: rec.lockWaits } : {}) } };
    return judgeR(`${st} (gate result stored)`, 'COMPLETE', s, m, null, 'green');
  }
  const toBoard = members.some(x => x.kind === 'submit_handoff_returned' && x.detail.returnedToBoard);
  const windowSpent = rec.infrastructureRetries === 3 && (prior?.infrastructureRetries ?? 0) < 3;
  
  
  const m = { id: e.item, actor: e.by, job: rec.id, result: { code: 1, error: rec.error, ...(rec.lockWaits ? { lockWaits: rec.lockWaits } : {}) }, ...(toBoard ? { returnToBoard: true } : {}), ...(windowSpent ? { windowSpent: true } : {}) };
  const want = st === 'infrastructure' ? 'infrastructure' : toBoard ? 'red-to-board' : members.some(x => x.kind === 'submit_handoff_returned') ? 'red-to-builder' : 'red-unreturned';
  const path = st === 'infrastructure' ? `infrastructure (${INFRA(rec.error?.code)})` : `${st} (${want})`;
  judgeR(path, 'COMPLETE', s, m, null, want);
}
  function INFRA(code) { return code === 'SUBMIT_HANDOFF_DEAD' ? 'dead worker' : 'machine stop'; }
  return { records: records_out, unreplayable };
}
