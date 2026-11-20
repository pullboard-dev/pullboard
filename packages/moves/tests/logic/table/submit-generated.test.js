/** Tests generated from the five submit tables: each seeded submit, commit, outcome and hand-off move checked against the rules restated here, and metamorphic breaks that must refuse or must not matter [C7,#8264]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boardSubmitEngine } from '../../../index.js';
import { pipelineCause } from '../../../index.js';
import { runTable } from '../../../index.js';
import { seeded } from '../../../index.js';
import { SUBMIT_NEXT } from '../../../index.js';
import { submitEngine } from '../../../index.js';

/** The board's engine (the store's retry limit, 3) and a one-retry engine, each with the infrastructure codes this file draws that it holds. */
const ENGINES = [
  { limit: 3, infra: new Set(['RUNNER_UNAVAILABLE', 'GATE_INFRA_EXHAUSTED', 'BOARD_BUSY']), ...boardSubmitEngine() },
  { limit: 1, infra: new Set(['RUNNER_UNAVAILABLE', 'GATE_INFRA_EXHAUSTED']), ...submitEngine({ retryLimit: 1, infrastructureCodes: ['RUNNER_UNAVAILABLE', 'GATE_INFRA_EXHAUSTED'] }) },
];
const NAMES = ['SUBMIT', 'COMMIT', 'OUTCOME', 'START', 'COMPLETE', 'RECAPTURE'];
const IO = ['hosted', 'recovered', 'dirty', 'untracked', 'noCommit', 'mainMerge', 'empty', 'trunkMerge', 'provesNothing', 'kernelApproval', 'familyProblem',
  'itemPatches', 'handoffExecution', 'redLoop', 'composition', 'stack', 'hostName', 'infraNote', 'ownership', 'postGate'];
const PROBLEMS = ['barProblem', 'clauseProblem', 'reviewProblem', 'mergeOnlyProblem', 'hookProofProblem', 'ownershipWaitProblem'];
const RECOVERED = new Set(['GATE_INFRA_EXHAUSTED', 'SUBMIT_HANDOFF_DEAD']);
const CAUSES = { FLAKE: 'flake', MERGE_CONFLICT: 'conflict', BOARD_BUSY: 'host-busy' };
const SAYS = ['runner retry window', 'healthy-executor recovery retries', 'stopped on the machine', 'back to the board', 'stays claimed by you'];
const NOW = '2026-11-15T12:00:00.000Z';
const LONG = 'y'.repeat(4005);
const at = (ms) => new Date(Date.parse(NOW) + ms).toISOString();
const hex = (g, n) => Array.from({ length: n }, () => '0123456789abcdef'[g.int(16)]).join('');
const uuid = (g) => `${hex(g, 8)}-${hex(g, 4)}-4${hex(g, 3)}-${g.pick(['8', '9', 'a', 'b'])}${hex(g, 3)}-${hex(g, 12)}`;
const flip = (g, n) => g.int(n) === 0;
const bad = (code) => ({ code, message: `${code} said no`, next: `fix ${code}` });
const opt = (yes, fields) => (yes ? fields : {});

/** A board event for the refreeze history: edits naming fields, refreezes and claims that adopt a correction or not. */
function event(g, id) {
  const kind = g.pick(['edit', 'edit', 'refreeze', 'claim', 'renew', 'note']);
  if (kind !== 'edit') return { id, kind, detail: { adoptedCorrection: g.pick([undefined, null, 0, 'fix']) } };
  return { id, kind, detail: { pendingRefreeze: g.pick([undefined, ['criterion'], ['after', 'title'], ['check', 'criterion']]), ...opt(flip(g, 4), { correctedFrozen: true }) } };
}

/** A captured hand-off for the actor's claim, now and then for another seat, source, bar or companion digest. */
function job(g, s, actor, states) {
  const { head } = s.io, state = g.pick(states);
  return { version: 1, id: uuid(g), agentId: flip(g, 10) ? 'other' : actor, commit: flip(g, 8) ? hex(g, 40) : head.commit, tree: head.tree, main: head.main,
    executionCommit: head.executionCommit ?? head.commit, executionTree: head.executionTree ?? head.tree, digest: flip(g, 10) ? hex(g, 64) : s.item.frozenDigest,
    companionDigest: flip(g, 10) ? hex(g, 64) : s.io.companionDigest ?? null, leaseMs: 120_000, state, at: NOW, infrastructureRetries: g.pick([undefined, 0, 1, 2, 3, 4]),
    ...opt(flip(g, 3), { infrastructureNotified: true }), ...opt(flip(g, 3), { startedAt: NOW, completedAt: NOW, hookProjection: { at: NOW } }),
    ...opt(state === 'infrastructure', { error: { code: g.pick(['GATE_INFRA_EXHAUSTED', 'SUBMIT_HANDOFF_DEAD', 'RUNNER_UNAVAILABLE']), ...opt(flip(g, 2), { reason: g.pick(['runner gone', 5]) }) } }) };
}

/** A worker's lock waits, whole or broken in one field, with codes the record keeps and drops. */
const waitsOf = (g) => g.pick([undefined, { count: g.pick([1, 0, -1, 2.5, '3']), totalMs: g.pick([0, -1, 500, '20']),
  codes: g.pick([undefined, { BOARD_BUSY: 2, ['A'.repeat(40)]: 1, ['B'.repeat(41)]: 1, '': 1, lower: 1, ZERO: 0, NEG: -1, FRAC: 1.5 }]) }]);

/** One seeded case for one table: every guard breaks now and then, so each row is reached and about half the moves pass. */
function scenario(seed) {
  const g = seeded(seed), table = NAMES[seed % NAMES.length], engine = ENGINES[flip(g, 3) ? 1 : 0], r = table === 'SUBMIT' ? 70 : 30;
  const actor = g.pick(['tests-1', 'tests-1', 'coordinator']), frozen = flip(g, 12) ? null : hex(g, 64);
  const head = { commit: hex(g, 40), tree: hex(g, 40), main: hex(g, 40), ...opt(flip(g, 3), { executionCommit: hex(g, 40), executionTree: hex(g, 40) }) };
  const io = { ...Object.fromEntries(IO.map(f => [f, flip(g, r) ? bad(`IO_${f.toUpperCase()}`) : null])), head, companionDigest: g.pick([undefined, null, hex(g, 64), ...(flip(g, r) ? ['zz'] : [])]),
    currentDigest: flip(g, r) ? { digest: hex(g, 64), ...opt(flip(g, 2), { unusable: 'row gone' }) } : g.pick([null, { digest: frozen }]), folderItem: flip(g, r) ? 7 : g.pick([null, undefined, 42]),
    heldElsewhere: flip(g, r) ? { agent: 'tests-2', path: g.pick(['/w/a', "/w/it's"]) } : null, notJoinedGuidance: g.pick([undefined, { message: 'join first', next: 'pullboard join view' }]),
    mainMergeResult: g.pick([undefined, { merged: true, source: 's1', main: 'm1', commit: 'c1' }, { merged: false }, { merged: 'yes' }]) };
  const deferred = { ...Object.fromEntries(PROBLEMS.map(f => [f, flip(g, r) ? bad(`D_${f.toUpperCase()}`) : null])), correctedReopen: g.pick([undefined, true]),
    builderFamily: g.pick([undefined, 'anthropic']), proofRecord: g.pick([undefined, { proof: 1 }]), mergeOnly: g.pick([undefined, { from: 1 }]),
    barWarning: g.pick([undefined, '', 'bar is wide']), ownershipWait: table === 'COMPLETE' && flip(g, 6) ? { key: 'w1' } : null };
  const s = { now: NOW, actor: { joined: !flip(g, r) }, io, deferred, submits: [], receipts: [], handoff: null,
    history: flip(g, 5) ? Array.from({ length: 1 + g.int(4) }, (_, i) => event(g, i + 1)) : [],
    item: { status: flip(g, r) ? g.pick(['open', 'submitted']) : 'claimed', owner: flip(g, r) ? 'other' : actor, leaseUntil: g.pick([at(60_000), at(60_000), at(1), at(0), at(-1), null]),
      frozenDigest: frozen, outside: flip(g, r) ? 'pull-request' : null, verdict: g.pick([null, 'rejected']), commit: flip(g, r) ? head.commit : g.pick([null, hex(g, 40)]),
      files: g.pick([[], ['a.js'], ['a.js', 'b.js']]), builtBy: null },
    children: flip(g, r) ? [{ status: g.pick(['open', 'claimed', 'submitted']) }] : g.pick([[], [{ status: 'accepted' }], [{ status: 'withdrawn' }]]),
    rejects: flip(g, r) ? [{ commit: head.commit, digest: frozen }] : g.pick([[], [{ commit: hex(g, 40), digest: frozen }], [{ commit: head.commit, digest: hex(g, 64) }]]),
    config: { handoff: g.pick([true, true, false, 'yes']), leaseMs: flip(g, r) ? g.pick([0, 1, -1, 1.5, '120000']) : 120_000 } };
  let m = { id: 42, actor };
  if (table === 'SUBMIT') {
    if (flip(g, r)) head[g.pick(['commit', 'tree', 'main'])] = 'abc';
    s.handoff = g.pick([null, job(g, s, actor, ['queued', 'running', 'green'])]);
    m = { ...m, name: 'submit', worker: g.pick([undefined, undefined, true, false]), precheck: g.pick([undefined, undefined, true, 'yes']),
      job: flip(g, r) ? g.pick(['job-1', uuid(g).replace('-4', '-3'), `${uuid(g).slice(0, 19)}c${hex(g, 16)}`]) : uuid(g),
      ...(flip(g, r) ? { companion: g.pick([null, { key: 'k', author: 'a' }, { file: 'f', author: 'a' }, { file: 'f', key: 'k' }]) } : g.pick([{}, { companion: { file: 'f', key: 'k', author: 'a' } }])) };
    if (flip(g, r)) s.item = null;
  } else if (table === 'COMMIT') {
    s.gate = flip(g, r) ? { refusal: bad(g.pick(['GATE_RED', 'RUNNER_BUSY'])) } : { green: g.pick([true, false, undefined, 'yes']), size: g.pick([undefined, 0, 12]),
      tooling: g.pick([undefined, hex(g, 39), hex(g, 40), hex(g, 64), hex(g, 65), 'X'.repeat(40)]), policyCommit: g.pick([undefined, '', hex(g, 40)]) };
    m = { ...m, name: 'submit-commit', commit: g.pick([head.commit, head.commit, undefined]), tree: head.tree, files: g.pick([undefined, ['b.js', 'c.js']]),
      note: flip(g, r) ? g.pick(['', '  ', 'a\nb', 'a\u2028b', 'a\rb', 5]) : g.pick([undefined, ' fixed it ']), infra: g.pick([undefined, 'runner']),
      companionRecord: g.pick([undefined, { file: 'f' }]), quarantineProofIds: g.pick([undefined, [], [3]]) };
  } else if (table === 'OUTCOME') {
    m = { ...m, name: 'submit-outcome', digest: flip(g, 6) ? hex(g, 64) : frozen, stage: g.pick([undefined, 'fast', 'slow']),
      refusal: { code: flip(g, 8) ? g.pick(['', 'bad_code', '9X', undefined]) : g.pick(['FLAKE', 'MERGE_CONFLICT', 'GATE_RED', 'E9_X']), text: flip(g, 8) ? g.pick(['', ' ', 5]) : g.pick(['tests failed', LONG]) } };
  } else if (table === 'RECAPTURE') {
    const h = s.handoff = job(g, s, actor, ['queued', 'queued', 'running', 'green']);
    m = { ...m, name: 'recapture-submit-handoff', actor: flip(g, r) ? 'other' : h.agentId, job: flip(g, r) ? uuid(g) : h.id, main: flip(g, r) ? g.pick(['', 'abc', hex(g, 39), undefined]) : hex(g, 40) };
    if (flip(g, r)) s.handoff = null;
  } else {
    const h = s.handoff = job(g, s, actor, table === 'START' ? ['queued', 'running', 'infrastructure', 'infrastructure', 'green'] : ['queued', 'running', 'running', 'green']);
    m = { ...m, name: table === 'START' ? 'start-submit-handoff' : 'complete-submit-handoff', actor: flip(g, r) ? 'other' : h.agentId, job: flip(g, r) ? uuid(g) : h.id };
    if (table === 'START') {
      m = { ...m, ...g.pick([{}, {}, { hook: null }, { hook: { name: 'merge' } }, { unrecoverable: g.pick(['tools gone', null]) }, { retryJob: flip(g, 6) ? g.pick(['job-2', h.id, null]) : uuid(g) }]) };
    } else if (g.int(3) === 0) {
      Object.assign(s.item, { status: flip(g, 8) ? 'claimed' : 'submitted', builtBy: flip(g, 8) ? 'other' : h.agentId, commit: h.commit });
      m.result = { code: 0, commit: flip(g, 8) ? hex(g, 40) : h.commit, lockWaits: waitsOf(g) };
      const detail = { commit: flip(g, 10) ? 'x' : m.result.commit, criterionDigest: flip(g, 10) ? 'x' : h.digest, policyCommit: flip(g, 10) ? 'x' : h.main, gateGreen: g.pick([true, false, 'yes']) };
      s.submits = [...(flip(g, 3) ? [{ by: h.agentId, detail: { commit: 'old' } }] : []), { by: flip(g, 10) ? 'other' : h.agentId, detail }, ...(flip(g, 3) ? [{ by: 'other', detail: {} }] : [])];
      const receipt = { kind: 'submit', commit: h.executionCommit, tree: h.executionTree, seat: h.agentId, frozenDigest: h.digest, sourceClean: true };
      if (flip(g, 3)) receipt[g.pick(Object.keys(receipt))] = g.pick(['x', 'yes']);
      s.receipts = [{ ...receipt, kind: 'verify' }, receipt];
    } else {
      if (flip(g, 6)) s.item.status = 'submitted';
      const error = { code: g.pick(['GATE_RED', 'FLAKE', 'RUNNER_UNAVAILABLE', 'GATE_INFRA_EXHAUSTED', 'SUBMIT_HANDOFF_DEAD', 'SUBMIT_HANDOFF_EXIT', 'SUBMIT_HANDOFF_EXIT', 'BOARD_BUSY']),
        message: g.pick(['tests failed', '', '  ', 'killed by SIGKILL', 'got SIG9', LONG]), next: 'fix it', ...g.pick([{}, { signal: '' }, { signal: 'SIGTERM' }, { signal: 9 }]) };
      m.result = flip(g, 6) ? g.pick([undefined, { code: 2 }, { code: 2, error }, { code: 1 }, { code: 1, error: { ...error, code: '' } }, { code: 1, error: { ...error, code: 5 } },
        { code: 1, error: { ...error, message: undefined } }, { code: 1, error: { ...error, next: 3 } }]) : { code: 1, error, lockWaits: waitsOf(g) };
      m = { ...m, returnToBoard: g.pick([undefined, true, 'yes']), boardCodes: g.pick([undefined, true, false, 'yes']), windowSpent: g.pick([undefined, undefined, true, 'yes']) };
    }
    if (flip(g, r)) s.handoff = null;
  }
  return { seed, table, engine, s, m };
}

const CASES = 15_000;
const run = (c, s = c.s, m = c.m) => runTable(c.engine.tables[c.table], c.engine.rules, structuredClone(s), structuredClone(m));
const results = Array.from({ length: CASES }, (_, i) => { const c = scenario(i + 1); return { ...c, result: run(c) }; });
const ok = results.filter(c => !c.result.refused);

// ---- The rules, restated apart from the tables ----
const live = (s) => s.item.leaseUntil !== null && Date.parse(s.item.leaseUntil) > Date.parse(s.now);
const mine = (s, actor) => s.item.status === 'claimed' && s.item.owner === actor;
const serves = (s, h) => mine(s, h.agentId) && s.item.frozenDigest === h.digest;
const active = (h) => h.state === 'queued' || h.state === 'running';
const pending = (s) => (s.handoff && active(s.handoff) && serves(s, s.handoff) ? s.handoff : null);
const queued = (s, m) => s.config.handoff === true && m.worker !== true;
const said = (value) => Boolean(value?.code);
const isHex = (value, n) => typeof value === 'string' && value.length === n && /^[0-9a-f]+$/u.test(value);
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const hev = (h, state = h.state) => ({ kind: 'submit-handoff', by: h.agentId, detail: { state, commit: h.commit } });
const shout = (by, to, says) => ({ kind: 'shout', by, item: null, detail: { to, says } });
const heard = (events) => events.map(e => (e.kind === 'shout' ? { ...e, detail: { to: e.detail.to, says: SAYS.find(k => e.detail.text.includes(k)) } } : e));
const cause = (code, note) => (CAUSES[code] ? { type: CAUSES[code], code } : { type: 'other', text: note || code, code });

/** The unadopted correction fields: edits newer than the last refreeze or adopting claim, back to a corrected freeze. */
function refreeze(s) {
  const fields = new Set();
  for (const e of [...s.history].reverse()) {
    if (e.kind === 'refreeze' || (['claim', 'renew'].includes(e.kind) && e.detail.adoptedCorrection != null) || e.detail.correctedFrozen) break;
    for (const field of e.detail.pendingRefreeze ?? []) if (field !== 'title') fields.add(field);
  }
  return [...fields].sort();
}
const seen = (s, commit) => s.rejects.some(r => r.commit === commit && r.digest === s.item.frozenDigest) || (s.item.verdict === null && s.item.commit === commit && !s.deferred.correctedReopen);
const stops = (e, infra) => infra.has(e.code) || (e.code === 'SUBMIT_HANDOFF_EXIT' && ((typeof e.signal === 'string' && e.signal.length > 0) || /\bSIG[A-Z0-9]/u.test(e.message)));
function waits(m) {
  const w = m.result?.lockWaits, count = Number(w?.count), totalMs = Number(w?.totalMs);
  if (!(Number.isSafeInteger(count) && count >= 1 && Number.isSafeInteger(totalMs) && totalMs >= 0)) return {};
  return { lockWaits: { count, totalMs, codes: Object.fromEntries(Object.entries(w.codes ?? {}).filter(([k, n]) => /^[A-Z_]+$/u.test(k) && k.length <= 40 && Number.isSafeInteger(n) && n >= 1)) } };
}

/** The guard rows in order, each [row, refuses]. */
function guards(table, s, m) {
  const io = (id, field) => [id, () => said(s.io[field])], put = (id, field) => [id, () => said(s.deferred[field])], h = s.handoff;
  const board = (p) => [io(`${p}:builder-family`, 'familyProblem'), [`${p}:outside`, () => s.item.outside === 'pull-request'],
    [`${p}:children`, () => s.children.some(c => !['accepted', 'withdrawn'].includes(c.status))], [`${p}:head-new`, () => seen(s, m.commit ?? s.io.head.commit)]];
  const plain = () => !m.hook && m.unrecoverable === undefined && m.retryJob === undefined;
  const matching = () => !(h && h.id === m.job && h.agentId === m.actor), fresh = () => active(h) && !s.deferred.ownershipWait && m.result?.code === 0;
  const candidate = () => Number.isSafeInteger(s.config.leaseMs) && s.config.leaseMs > 0 && JOB_ID.test(m.job) && ['main', 'commit', 'tree'].every(k => isHex(s.io.head[k], 40))
    && isHex(s.item.frozenDigest, 64) && (s.io.companionDigest == null || isHex(s.io.companionDigest, 64));
  const e = m.result?.error, canonical = () => m.result?.code === 1 && Boolean(e) && typeof e.code === 'string' && e.code !== '' && typeof e.message === 'string' && typeof e.next === 'string';
  return {
    SUBMIT: [['companion-usage', () => m.companion !== undefined && !(m.companion?.file && m.companion.key && m.companion.author)], io('hosted-runner', 'hosted'), io('recovered', 'recovered'),
      ['joined', () => !s.actor.joined], ['item-exists', () => s.item === null], ['folder-item', () => s.io.folderItem != null && s.io.folderItem !== m.id],
      ['held-here', () => m.worker !== true && s.item.status === 'claimed' && s.io.heldElsewhere !== null], ['holder', () => !mine(s, m.actor)], put('bar-ready', 'barProblem'),
      put('clauses', 'clauseProblem'), ['correction-refrozen', () => refreeze(s).length > 0], io('tree-clean', 'dirty'), io('nothing-untracked', 'untracked'), io('has-commit', 'noCommit'),
      io('main-merge', 'mainMerge'), io('non-empty', 'empty'), io('trunk-merge', 'trunkMerge'), io('proves-something', 'provesNothing'), io('kernel-approval', 'kernelApproval'),
      ['criterion-unchanged', () => s.item.frozenDigest !== null && s.io.currentDigest !== null && s.io.currentDigest.digest !== s.item.frozenDigest], ...board('preflight'),
      put('reviewable', 'reviewProblem'), io('item-patches', 'itemPatches'), io('handoff-execution', 'handoffExecution'),
      ['red-progress', () => (m.worker === true || !pending(s)) && said(s.io.redLoop)], io('composition', 'composition'), io('stack', 'stack'), io('host-name', 'hostName'),
      io('infra-note', 'infraNote'), ['handoff-candidate', () => queued(s, m) && !candidate()], ['handoff-live-claim', () => queued(s, m) && !(mine(s, m.actor) && live(s))],
      ['handoff-pending', () => { const p = pending(s); return queued(s, m) && p !== null && !(p.commit === s.io.head.commit && p.tree === s.io.head.tree && p.companionDigest === (s.io.companionDigest ?? null)); }]],
    COMMIT: [['gate', () => Boolean(s.gate.refusal)], io('ownership', 'ownership'), io('post-gate', 'postGate'),
      ['note-one-line', () => m.note !== undefined && !(typeof m.note === 'string' && m.note.trim() !== '' && !/[\r\n\u2028\u2029]/u.test(m.note))], ['still-held', () => !mine(s, m.actor)],
      ...board('write'), ['write:correction-refrozen', () => refreeze(s).length > 0], put('write:bar-ready', 'barProblem'), put('write:clauses', 'clauseProblem'), put('write:merge-only', 'mergeOnlyProblem')],
    OUTCOME: [['outcome-shape', () => !/^[A-Z][A-Z0-9_]*$/u.test(m.refusal.code ?? '') || typeof m.refusal.text !== 'string' || m.refusal.text.trim() === '']],
    START: [['start-matching', matching], put('start-hook-proof', 'hookProofProblem'), ['start-retry-id', () => m.retryJob !== undefined && !(JOB_ID.test(m.retryJob) && m.retryJob !== m.job)],
      ['start-running-serves', () => plain() && h.state === 'running' && !serves(s, h)], ['start-queued-serves', () => plain() && h.state === 'queued' && !serves(s, h)]],
    RECAPTURE: [['recapture-main', () => !isHex(m.main, 40)], ['recapture-matching', matching], ['recapture-queued-serves', () => h.state !== 'queued' || !serves(s, h)]],
    COMPLETE: [['complete-matching', matching], put('ownership-wait', 'ownershipWaitProblem'),
      ['green-is-submitted', () => fresh() && !(s.item.status === 'submitted' && s.item.builtBy === h.agentId && s.item.commit === m.result.commit)],
      ['green-is-proved', () => fresh() && !proved(s, m)], ['refusal-document', () => active(h) && !s.deferred.ownershipWait && m.result?.code !== 0 && !canonical()]],
  }[table];
}
const latest = (s) => s.submits.filter(e => e.by === s.handoff.agentId).at(-1)?.detail;
function proved(s, m) {
  const sub = latest(s), h = s.handoff;
  return sub !== undefined && sub.commit === m.result.commit && sub.criterionDigest === h.digest && sub.policyCommit === h.main && s.receipts.some(r => r.kind === 'submit'
    && r.commit === h.executionCommit && r.tree === h.executionTree && r.seat === h.agentId && r.frozenDigest === h.digest && r.sourceClean === true);
}

/** What the move must do once no guard refuses: its rows, patch, shouts by gist, the hand-off record and the renewal. */
function outcome({ table, s, m, engine: { limit, infra } }) {
  const h = s.handoff, w = waits(m), now = { completedAt: NOW };
  if (table === 'SUBMIT') {
    const via = m.precheck === true ? 'precheck' : !queued(s, m) ? 'gate' : pending(s) ? 'queue-existing' : 'queue', hd = s.io.head;
    const notes = m.precheck === true ? [] : [s.io.mainMergeResult?.merged === true && ['main-merge-fact', `Builder ${s.item.owner} automatic main merge: source s1, main m1, merge c1.`],
      Boolean(s.deferred.barWarning) && ['bar-warning-fact', `bar.check warning: ${s.deferred.barWarning}`]].filter(Boolean);
    return { via: [via, ...notes.map(([id]) => id)], events: [...(via === 'queue' ? [hev({ agentId: m.actor, commit: hd.commit }, 'queued')] : []),
      ...notes.map(([, text]) => ({ kind: 'fact', by: s.item.owner, detail: { kind: 'note', text } }))],
    record: via === 'queue' ? { version: 1, id: m.job, agentId: m.actor, commit: hd.commit, tree: hd.tree, main: hd.main, executionCommit: hd.executionCommit ?? hd.commit,
      executionTree: hd.executionTree ?? hd.tree, digest: s.item.frozenDigest, companionDigest: s.io.companionDigest ?? null, leaseMs: s.config.leaseMs, state: 'queued', at: NOW } : undefined };
  }
  if (table === 'COMMIT') {
    const gate = s.gate, t = gate.tooling;
    const detail = { commit: m.commit, tree: m.tree, ...opt(gate.policyCommit, { policyCommit: gate.policyCommit }), ...opt(s.item.frozenDigest, { criterionDigest: s.item.frozenDigest }),
      ...opt(m.note !== undefined, { note: String(m.note).trim() }), ...opt(s.deferred.proofRecord, { submissionProof: s.deferred.proofRecord }), ...opt(m.infra, { infra: m.infra }),
      ...opt(gate.green !== undefined, { gateGreen: gate.green === true }), ...opt(s.deferred.mergeOnly, { mergeOnly: s.deferred.mergeOnly }), ...opt(gate.size, { submissionSize: gate.size }),
      ...opt(m.companionRecord, { companion: m.companionRecord }), ...opt(m.quarantineProofIds, { quarantineProofIds: m.quarantineProofIds }),
      ...opt(typeof t === 'string' && t.length >= 40 && t.length <= 64 && /^[0-9a-f]+$/u.test(t), { tooling: t }) };
    return { via: ['submit'], events: [{ kind: 'submit', by: m.actor, detail }], patch: { status: 'submitted', builtBy: m.actor, builderFamily: s.deferred.builderFamily ?? null,
      commit: m.commit, tree: m.tree, leaseUntil: null, reviewBy: null, reviewUntil: null, files: [...new Set([...s.item.files, ...(m.files ?? [])])] } };
  }
  if (table === 'OUTCOME') {
    const text = m.refusal.text.slice(0, 4000), renew = mine(s, m.actor) && s.item.frozenDigest === m.digest && live(s);
    return { via: [renew ? 'renew' : 'skip'], renewal: renew ? { code: m.refusal.code, text, digest: m.digest, ...opt(m.stage === 'fast', { stage: 'fast' }), pipelineCause: cause(m.refusal.code, text) } : undefined };
  }
  if (table === 'RECAPTURE') return { via: ['recapture'], events: [hev(h)], record: { ...h, main: m.main } };
  const retries = h.infrastructureRetries ?? 0, stopped = h.state === 'infrastructure';
  if (table === 'START') {
    if (m.hook) return { via: ['hook'], events: [hev(h)], record: { ...h, hookProjection: { ...m.hook, at: NOW } } };
    if (m.unrecoverable !== undefined) return stopped && retries < limit && !h.infrastructureNotified
      ? { via: ['spend'], events: [shout('sentinel', 'coordinator', SAYS[1]), hev(h)], record: { ...h, infrastructureRetries: limit, infrastructureNotified: true } } : { via: ['spend-nothing'] };
    if (m.retryJob === undefined) return h.state === 'queued' ? { via: ['start'], events: [hev(h, 'running')], record: { ...h, state: 'running', startedAt: NOW } } : { via: ['already-started'] };
    if (!(stopped && RECOVERED.has(h.error?.code) && retries < limit && serves(s, h) && live(s) && s.io.companionDigest === h.companionDigest)) return { via: ['retry-nothing'] };
    const { error, completedAt, startedAt, hookProjection, infrastructureNotified, ...kept } = h;
    return { via: ['retry'], events: [hev(h, 'queued')], record: { ...kept, id: m.retryJob, state: 'queued', at: NOW, infrastructureRetries: retries + 1, retryOf: h.id,
      ...opt(typeof error.reason === 'string', { requeuedFor: error.reason }) } };
  }
  if (!active(h)) return { via: ['already-done'] };
  if (s.deferred.ownershipWait) return { via: ['ownership-wait'], events: [hev(h, 'ownership-wait')], record: { ...h, ...w, state: 'ownership-wait', gateGreen: false, ownershipWait: 'w1', ...now } };
  if (m.result.code === 0) {
    const green = latest(s)?.gateGreen === true, state = green ? 'green' : 'submitted';
    return { via: ['green'], events: [hev(h, state)], record: { ...h, ...w, state, gateGreen: green, submitted: m.result.commit, ...now } };
  }
  const e = m.result.error, spent = m.windowSpent === true, out = spent || retries >= limit, red = (state) => ({ ...h, ...w, state, error: { ...e }, ...now });
  if (e.code === 'SUBMIT_HANDOFF_DEAD' || (stops(e, infra) && s.item.status !== 'submitted')) {
    const says = h.infrastructureNotified ? [] : out ? [spent ? SAYS[0] : SAYS[1]] : RECOVERED.has(e.code) ? [] : [SAYS[2]];
    return { via: ['infrastructure'], events: [...says.map(k => shout('sentinel', 'coordinator', k)), hev(h, 'infrastructure')],
      record: { ...red('infrastructure'), ...opt(spent, { infrastructureRetries: limit }), ...opt(out || !RECOVERED.has(e.code), { infrastructureNotified: true }) } };
  }
  const back = s.item.status !== 'submitted' && serves(s, h), by = h.agentId;
  if (back && m.returnToBoard === true) {
    return { via: ['red-to-board'], patch: { status: 'open', owner: null, leaseUntil: null }, record: red('red'), events: [{ kind: 'release', by, detail: { reasonCode: m.boardCodes === true ? 'GATE_REFUSED' : 'OTHER',
      reason: `the queued gate was refused (${e.code}); returned to the board for any free seat` } }, { kind: 'submit_handoff_returned', by, detail: { commit: h.commit, returnedToBoard: true } },
    shout('coordinator', by, SAYS[3]), hev(h, 'red')] };
  }
  if (!back) return { via: ['red-unreturned'], events: [hev(h, s.item.status === 'submitted' ? 'incomplete' : 'red')], record: red(s.item.status === 'submitted' ? 'incomplete' : 'red') };
  const until = at(h.leaseMs), text = e.message.slice(0, 4000);
  return { via: ['red-to-builder'], patch: { leaseUntil: until }, record: red('red'), events: [{ kind: 'renew', by, detail: { leaseUntil: until, digest: h.digest, queuedRedReturn: true,
    ...opt(text.trim(), { submitOutcome: { code: e.code, text, digest: h.digest, pipelineCause: cause(e.code, text) } }) } },
  { kind: 'submit_handoff_returned', by, detail: { commit: h.commit, leaseUntil: until } }, shout('coordinator', by, SAYS[4]), hev(h, 'red')] };
}
const expect = (c) => { const first = guards(c.table, c.s, c.m).find(([, refuses]) => refuses()); return first ? { row: first[0] } : outcome(c); };

test('moves.submit.rows-fire: generated: every guard, outcome and follow-up row of the five submit tables fires on some seeded case [C7,#8264]', () => {
  const fired = new Set(results.flatMap(c => (c.result.refused ? [c.result.refused.row] : c.result.via).map(row => `${c.table}:${row}`)));
  const rows = NAMES.flatMap(name => ['guards', 'outcomes', 'followups'].flatMap(kind => ENGINES[0].tables[name][kind].map(row => `${name}:${row.id}`)));
  assert.deepEqual(rows.filter(row => !fired.has(row)), []);
  for (const name of NAMES) assert.ok(ok.filter(c => c.table === name).length > CASES / 25, `${name}: too few accepted moves`);
});

test('moves.submit.rule-restated: generated: each move does what the rules restated here say: the first broken guard refuses, else the outcome row, patch, events, record and renewal [C7,#8264]', () => {
  for (const c of results) {
    const want = expect(c);
    if (want.row) { assert.equal(c.result.refused?.row, want.row, `seed ${c.seed} ${c.table}`); continue; }
    assert.deepEqual([c.result.refused, c.result.via, c.result.patch, heard(c.result.events)], [undefined, want.via, want.patch ?? {}, want.events ?? []], `seed ${c.seed} ${c.table}`);
    const row = c.engine.tables[c.table].outcomes.find(o => o.id === want.via[0]);
    assert.deepEqual([row.record?.(c.s, c.m), row.submitOutcome?.(c.s, c.m)], [want.record, want.renewal], `seed ${c.seed} ${c.table}`);
  }
});

test('moves.submit.refusal-writes-nothing: generated: a refusal writes nothing and carries its row\'s code, the shell\'s or its own words, and the next step SUBMIT_NEXT gives [C7,#8264]', () => {
  for (const c of results.filter(each => each.result.refused)) {
    const { refused } = c.result, row = c.engine.tables[c.table].guards.find(each => each.id === refused.row);
    assert.ok(!('patch' in c.result) && !('events' in c.result), `seed ${c.seed}`);
    const [kind, field] = row.code.split(':'), shell = { io: c.s.io, deferred: c.s.deferred }[kind]?.[field] ?? (row.id === 'gate' ? c.s.gate.refusal : null);
    if (shell) { assert.deepEqual([refused.code, refused.message, refused.next], [row.id === 'gate' ? shell.code : row.code, shell.message, shell.next], `seed ${c.seed}`); continue; }
    assert.equal(refused.code, row.code, `seed ${c.seed}`);
    const next = { joined: c.s.io.notJoinedGuidance?.next ?? SUBMIT_NEXT.NOT_JOINED, 'held-here': `submit it from that seat's checkout: cd ${c.s.io.heldElsewhere?.path === '/w/a' ? '/w/a' : "'/w/it'\\''s'"} && pullboard submit 42` }[row.id];
    assert.equal(refused.next, next ?? SUBMIT_NEXT[refused.code], `seed ${c.seed} ${row.id}`);
    assert.ok(typeof refused.message === 'string' && refused.message.length > 0, `seed ${c.seed}`);
    if (refused.code === 'PENDING_REFREEZE') assert.ok(refused.message.includes(`pending ${refreeze(c.s).join(' and ')} correction`), `seed ${c.seed}`);
    if (row.id === 'criterion-unchanged') assert.equal(refused.message.includes('the coordinator runs'), !c.s.io.currentDigest.unusable && c.m.actor !== 'coordinator', `seed ${c.seed}`);
  }
});

test('moves.submit.row-marks: generated: the rows mark io, deferred and outcome-recording rules as the command reads them [C7,#8264]', () => {
  const { tables } = ENGINES[0], cut = tables.SUBMIT.guards.findIndex(row => row.id === 'correction-refrozen');
  for (const name of NAMES) {
    for (const [i, row] of tables[name].guards.entries()) {
      const flags = [row.io === true, row.deferred === true, row.recordsOutcome === true];
      assert.deepEqual(flags, [row.code.startsWith('io:'), row.code.startsWith('deferred:'), name === 'COMMIT' || (name === 'SUBMIT' && i > cut)], `${name} ${row.id}`);
    }
  }
});

test('moves.submit.deterministic: generated: the tables are deterministic and read the snapshot and move without changing them [C7,#8264]', () => {
  for (const c of results.slice(0, 2000)) {
    const snapshot = structuredClone(c.s), move = structuredClone(c.m);
    assert.deepEqual(runTable(c.engine.tables[c.table], c.engine.rules, snapshot, move), c.result, `seed ${c.seed}`);
    assert.deepEqual([snapshot, move], [c.s, c.m], `seed ${c.seed}`);
  }
});

test('moves.submit.table-inputs: generated: the engine refuses SUBMIT_TABLE_INPUTS without a whole retry limit and iterable codes, and a cause keeps its code or bounded words [C7,#8264]', () => {
  for (const board of [{ retryLimit: 0, infrastructureCodes: [] }, { retryLimit: 1.5, infrastructureCodes: [] }, { retryLimit: '2', infrastructureCodes: [] }, { retryLimit: 2 }, { retryLimit: 2, infrastructureCodes: 7 }, null]) {
    assert.throws(() => submitEngine(board), { code: 'SUBMIT_TABLE_INPUTS' }, JSON.stringify(board));
  }
  assert.equal(typeof submitEngine({ retryLimit: 1, infrastructureCodes: new Set() }).tables.COMPLETE, 'object');
  assert.deepEqual([pipelineCause({ code: 'FLAKE', note: 'x' }), pipelineCause({ code: 'GATE_RED' }), pipelineCause({}), pipelineCause({ code: 'X', note: LONG })],
    [{ type: 'flake', code: 'FLAKE' }, { type: 'other', text: 'GATE_RED', code: 'GATE_RED' }, { type: 'other', text: 'No structured cause was supplied' }, { type: 'other', text: LONG.slice(0, 4000), code: 'X' }]);
});

test('moves.submit.fact-breaks: metamorphic: break one fact of an accepted submit, commit, outcome or hand-off move and it refuses with that fact\'s code [C7,#8264]', () => {
  const item = (c, fields) => ({ s: { ...c.s, item: { ...c.s.item, ...fields } } }), edit = { id: 99, kind: 'edit', detail: { pendingRefreeze: ['check'] } };
  const heads = (c) => ({ s: { ...c.s, rejects: [{ commit: c.m.commit ?? c.s.io.head.commit, digest: c.s.item.frozenDigest }] } });
  const common = { HEAD_NOT_NEW: heads, CHILDREN_OPEN: c => ({ s: { ...c.s, children: [{ status: 'claimed' }] } }), OUTSIDE_NATIVE_BUILD: c => item(c, { outside: 'pull-request' }),
    PENDING_REFREEZE: c => ({ s: { ...c.s, history: [...c.s.history, edit] } }), NOT_YOURS: c => item(c, { owner: 'stranger' }) };
  const BREAKS = { SUBMIT: { ...common, NOT_JOINED: c => ({ s: { ...c.s, actor: { joined: false } } }), NO_ITEM: c => ({ s: { ...c.s, item: null } }),
    USAGE: c => ({ m: { ...c.m, companion: { file: 'f', key: 'k' } } }), CRITERIA_CHANGED: c => (c.s.item.frozenDigest ? { s: { ...c.s, io: { ...c.s.io, currentDigest: { digest: 'f'.repeat(64) } } } } : null) },
  COMMIT: { ...common, USAGE: c => ({ m: { ...c.m, note: 'two\nlines' } }), GATE_RED: c => ({ s: { ...c.s, gate: { refusal: bad('GATE_RED') } } }) },
  OUTCOME: { USAGE: c => ({ m: { ...c.m, refusal: { ...c.m.refusal, text: ' ' } } }) },
  START: { SUBMIT_HANDOFF_CHANGED: c => ({ m: { ...c.m, job: 'gone' } }) }, COMPLETE: { SUBMIT_HANDOFF_CHANGED: c => ({ m: { ...c.m, actor: 'stranger' } }) },
  RECAPTURE: { SUBMIT_HANDOFF_CHANGED: c => ({ m: { ...c.m, job: 'gone' } }), BAD_SUBMIT_HANDOFF: c => ({ m: { ...c.m, main: 'abc' } }) } };
  for (const c of ok) {
    for (const [code, apply] of Object.entries(BREAKS[c.table])) {
      const broken = apply(c);
      if (broken) assert.equal(run(c, broken.s ?? c.s, broken.m ?? c.m).refused?.code, code, `seed ${c.seed} ${c.table}: breaking ${code}`);
    }
  }
});

test('moves.submit.gate-red-code: clause 1: a submit refused by a red gate carries the code GATE_RED, not io:gate [C7,#8329]', () => {
  const reds = results.filter(c => c.table === 'COMMIT' && !c.result.refused && c.s.item);
  assert.ok(reds.length > 0);
  for (const c of reds) {
    const refused = run(c, { ...c.s, gate: { refusal: bad('GATE_RED') } }, c.m).refused;
    assert.deepEqual([refused?.row, refused?.code], ['gate', 'GATE_RED'], `seed ${c.seed}`);
  }
});

test('moves.submit.recapture-table: clause 1: the RECAPTURE table refuses a bad main, then a foreign job or sender, then a job not queued or not serving its claim, and otherwise records the job with main replaced [C7,#9548]', () => {
  const { tables, rules } = ENGINES[0], table = tables.RECAPTURE, main = 'a'.repeat(40);
  const s = { now: NOW, item: { status: 'claimed', owner: 'tests-1', frozenDigest: 'b'.repeat(64) }, handoff: { id: uuid(seeded(1)), agentId: 'tests-1', state: 'queued', digest: 'b'.repeat(64), commit: 'c'.repeat(40), main: 'd'.repeat(40) } };
  const m = { name: 'recapture-submit-handoff', actor: 'tests-1', job: s.handoff.id, main };
  const refuse = (state, move) => runTable(table, rules, structuredClone(state), structuredClone(move)).refused;
  assert.deepEqual(['abc', undefined, 'A'.repeat(40)].map(bad => refuse(s, { ...m, main: bad })?.code), ['BAD_SUBMIT_HANDOFF', 'BAD_SUBMIT_HANDOFF', 'BAD_SUBMIT_HANDOFF']);
  assert.equal(refuse(s, { ...m, job: 'gone' })?.code, 'SUBMIT_HANDOFF_CHANGED');
  assert.equal(refuse(s, { ...m, actor: 'stranger' })?.code, 'SUBMIT_HANDOFF_CHANGED');
  assert.equal(refuse({ ...s, handoff: { ...s.handoff, state: 'running' } }, m)?.code, 'SUBMIT_HANDOFF_CHANGED');
  assert.equal(refuse({ ...s, item: { ...s.item, frozenDigest: 'e'.repeat(64) } }, m)?.code, 'SUBMIT_HANDOFF_CHANGED');
  assert.equal(refuse({ ...s, item: { ...s.item, owner: 'other' } }, m)?.code, 'SUBMIT_HANDOFF_CHANGED');
  assert.equal(refuse({ ...s, item: { ...s.item, status: 'submitted' } }, m)?.code, 'SUBMIT_HANDOFF_CHANGED');
  const done = runTable(table, rules, structuredClone(s), structuredClone(m));
  assert.deepEqual([done.refused, done.via, done.events], [undefined, ['recapture'], [{ kind: 'submit-handoff', by: 'tests-1', detail: { state: 'queued', commit: 'c'.repeat(40) } }]]);
  assert.deepEqual(table.outcomes[0].record(s, m), { ...s.handoff, main });
});

test('moves.submit.unrelated-events: metamorphic: an unrelated board event, reject, receipt or done child changes no outcome or refusal [C7,#8264]', () => {
  for (const c of results.filter(each => each.s.item).slice(0, 6000)) {
    const s = { ...c.s, history: [...c.s.history, { id: 100, kind: 'note', detail: {} }], rejects: [...c.s.rejects, { commit: 'f'.repeat(40), digest: c.s.item.frozenDigest }],
      receipts: [...c.s.receipts, { kind: 'verify', seat: 'other' }], children: [...c.s.children, { status: 'accepted' }] };
    assert.deepEqual(run(c, s), c.result, `seed ${c.seed} ${c.table}`);
  }
});

test('moves.table.red-to-board-code: clause 1: a red-to-board release carries GATE_REFUSED when the move carries boardCodes and OTHER otherwise, with the same prose reason [C7,#12222]', () => {
  const sample = results.filter(c => !c.result.refused && c.result.via?.includes('red-to-board'));
  assert.ok(sample.some(c => c.m.boardCodes === true) && sample.some(c => c.m.boardCodes !== true), 'the generated cases cover both settings');
  for (const c of sample) {
    const release = c.result.events.find(event => event.kind === 'release');
    assert.equal(release.detail.reasonCode, c.m.boardCodes === true ? 'GATE_REFUSED' : 'OTHER');
    assert.match(release.detail.reason, /^the queued gate was refused \(.*\); returned to the board for any free seat$/u);
  }
});
