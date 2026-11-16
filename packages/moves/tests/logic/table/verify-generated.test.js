/** Tests generated from the verify table: invariants every guard, outcome and follow-up keeps over thousands of seeded verdicts, and metamorphic breaks that must refuse or must not matter [C7,#8264]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VERIFY_NEXT } from '../../../index.js';
import { boardVerifyEngine } from '../../../index.js';
import { runTable } from '../../../index.js';
import { seeded } from '../../../index.js';
import { stepInMessage } from '../../../index.js';
import { verifyEngine } from '../../../index.js';

const { rules: RULES, table: TABLE } = boardVerifyEngine();
const run = (snapshot, move) => runTable(TABLE, RULES, structuredClone(snapshot), structuredClone(move));
const ROUTES = ['light', 'mid', 'strong'];
const UP = { light: 'mid', mid: 'strong', strong: 'strong' };
const REASONS = ['TEST_FAILURE', 'BEHAVIOR_MISMATCH', 'INSUFFICIENT_EVIDENCE', 'STALE_HEAD', 'OTHER'];
const EXTRA = { USAGE: 'run pullboard help', SUBMISSION_PROOF: 'retain native source-matched proof receipts and submit again before verification',
  PROOF_RUN_UNBOUND: 'restore the native gate receipt; do not supply provenance by hand',
  SOURCE_ADVANCE_STALE: 'read the current item, bar, patches and main, then let the worker check the new exact composition' };
const [NOW, PAST, LATER, DIGEST] = ['2026-11-15T12:00:00.000Z', '2026-11-15T11:00:00.000Z', '2026-11-15T13:00:00.000Z', 'd'.repeat(64)];

/** The frozen bar: Gamma's sharpen shout is exactly 400 characters, Deltas is longer than any quote may be. */
const [ALPHA, BETA, GAMMA] = ['Alpha keeps the queue whole [test].', 'Beta names every refusal [test].', `Gamma ${'g'.repeat(251)} [test].`];
const DELTA = `Deltas ${Array.from({ length: 850 }, (_, i) => `d${i}`).join(' ')} [test].`;
const CRITERION = `1. ${ALPHA} 2. ${BETA} 3. ${GAMMA} 4. ${DELTA}`;
const words = (quote) => quote.trim().replace(/\s+/gu, ' ');
const CLAUSE = new Map([['Alpha keeps', ALPHA], ['Alpha keeps the queue', ALPHA], ['Beta', BETA], ['Gamma', GAMMA], ['Deltas d0', DELTA], [DELTA.slice(0, 4096), DELTA], [DELTA.slice(0, 4098), DELTA]]);
const QUOTES = ['Alpha keeps', 'Alpha keeps', ' Alpha\nkeeps the queue ', 'Beta', 'Beta', 'Gamma', 'Deltas d0', DELTA.slice(0, 4096)];
const hex = (g, n) => Array.from({ length: n }, () => '0123456789abcdef'[g.int(16)]).join('');
const frozen = (over = {}, commit = 'c0ffee9'.padEnd(40, '0')) => JSON.stringify({ criterion: CRITERION, policy: { version: 1, commit, verify: { policy: 'any', family: 'off' }, ...over } });
const shell = (g) => ({ message: 'the shell refused it', ...(g.int(2) ? { code: 'SHELL_CODE' } : {}), ...(g.int(2) ? { next: 'do the shell step' } : {}) });
const learnt = { barKey: 'unset', engine: -1 };

/** One way to break each guard's fact, applied to a copy; the oracle below, not this list, decides which guard refuses first. */
const SPOILERS = {
  'decision-known': (g, s, m) => { m.decision = g.pick(['MAYBE', 'accept', undefined]); },
  'as-coordinator-only': (g, s, m) => { m.as = g.pick(['person', '']); },
  'as-main-only': (g, s, m) => { s.io.isMain = false; m.as = 'coordinator'; },
  'main-is-coordinator': (g, s, m) => { s.io.isMain = true; m.as = undefined; s.io.mainRefusal = { message: 'answer from the main checkout as coordinator', next: g.pick([undefined, 'start a reviewer']) }; },
  joined: (g, s) => { s.actor.joined = false; s.io.notJoined = g.pick([undefined, { message: 'not joined here', next: 'join it' }]); }, 'item-exists': (g, s) => { s.item = null; },
  'self-session': (g, s) => { s.io.selfSession = true; },
  submitted: (g, s) => { s.item.status = g.pick(['open', 'claimed', 'verified']); s.io.staleAcceptance = false; }, 'implied-items-exist': (g, s, m) => { m.implies = [7, 99]; },
  'item-policy': (g, s) => { s.io.policyRefused = { message: 'pullboard.json does not parse', ...(g.int(2) ? { code: 'BAD_CONFIG' } : {}) }; },
  'at-submitted-commit': (g, s) => { s.io.commitInHead = false; s.io.root = g.pick(['/repo', "/my 'repo"]); },
  'companions-present': (g, s) => { s.io.missingCompanions = { keys: ['p1', 'p2'], digest: 'p0' }; },
  'accept-criterion-current': (g, s, m) => { m.digest = 'moved'; },
  'accept-check': (g, s) => { s.io.checkRefused = shell(g); },
  'frozen-policy': (g, s) => { s.item.frozen = g.pick(['{', null, JSON.stringify({ criterion: CRITERION }), frozen({ version: 2 }), frozen({}, 'c'.repeat(39)), frozen({}, 'c'.repeat(65)),
    frozen({}, 'g'.repeat(40)), frozen({ verify: { policy: 'all', family: 'off' } }), frozen({ verify: { policy: 'any', family: 'on' } })]); },
  'known-main-binds': (g, s, m) => { m.knownMainFailures = { main: yes(m) ? 'f'.repeat(40) : m.review.trunk }; },
  'quarantine-accept-only': (g, s, m) => { m.quarantineProofId = 3; },
  'source-advance-current': (g, s, m) => { m.sourceAdvanceHead = s.item.effectiveHead === null ? m.head : g.pick([undefined, 'e'.repeat(40)]); },
  'not-merged': (g, s) => { Object.assign(s.item, { status: 'submitted', merged: true }); },
  'review-recorded': (g, s, m) => { const r = m.review; m.review = g.pick([null, 'r', [r], { ...r, extra: 1 }, { commit: r.commit, head: r.head, trunk: r.trunk }, { ...r, head: 'h' }, { ...r, head: r.head.slice(1) },
    { ...r, commit: 'f'.repeat(40) }, { ...r, trunk: 'T' }, { ...r, paths: 'a.js' }, { ...r, paths: ['a.js', 5] }, { ...r, paths: ['a\0b'] }, { ...r, paths: ['./a'] }, { ...r, paths: ['a/../b'] },
    { ...r, paths: ['a//b'] }, { ...r, paths: [''] }, { ...r, paths: ['b.js', 'a.js'] }, { ...r, paths: ['a.js', 'a.js'] }]); },
  'not-builder': (g, s, m) => { m.actor = s.item.builtBy ?? authors(s)[0] ?? (s.item.builtBy = 'core-1'); },
  'route-allows': (g, s) => { s.item.route = 'strong'; s.actor.route = g.pick(['light', 'mid']); },
  'policy-allows': (g, s, m) => { s.item.frozen = frozen({ verify: { policy: 'coordinator', family: 'off' } }); s.item.lane = 'core'; m.actor = 'core-7'; },
  'review-free': (g, s) => { Object.assign(s.item, { status: 'submitted', reviewBy: 'core-9', reviewUntil: LATER }); s.io.reviewHolderFresh = g.pick([true, undefined]); },
  'criterion-unchanged': (g, s, m) => { m.digest = 'moved'; },
  'reason-is-met': (g, s, m) => { m.reason = 'OTHER'; },
  'proof-noted': (g, s, m) => { m.note = g.pick(['', '  ', undefined]); },
  'reason-coded': (g, s, m) => { m.reason = g.pick(['NOPE', undefined, 'CRITERION_MET']); },
  'note-given': (g, s, m) => { m.note = g.pick(['', ' \n']); },
  'cause-well-formed': (g, s, m) => { m.cause = 'because'; },
  'clause-given': (g, s, m) => { m.clause = g.pick(['', '  ', undefined, 5]); },
  'clause-known': (g, s, m) => { m.clause = g.pick(['alpha keeps', 'Epsilon', DELTA.slice(0, 4098)]); },
};
const DEFERRED = { 'environment-shape': 'environmentProblem', 'known-main-owned': 'knownMainProblem', 'quarantine-bound': 'quarantineProblem', 'gate-receipt': 'gateReceipt',
  'companion-window': 'companionWindow', 'author-independence': 'authorProblem', 'required-family': 'requiredFamily', 'family-allows': 'familyProblem', 'patch-review': 'patchProblem', 'outside-sandbox': 'sandboxProblem' };
for (const [row, key] of Object.entries(DEFERRED)) SPOILERS[row] = (g, s) => { s.deferred[key] = shell(g); };
const ONLY = { ACCEPT: ['accept-criterion-current', 'accept-check', 'reason-is-met', 'proof-noted'],
  REJECT: ['quarantine-accept-only', 'criterion-unchanged', 'reason-coded', 'note-given', 'cause-well-formed', 'clause-given', 'clause-known'] };

/** One seeded verdict: prior rounds of rejects, accepts, route changes and sharpens, authors, review holders, flake records, and zero to two spoiled facts. */
function scenario(seed) {
  const g = seeded(seed), p = g.pick, one = (n) => g.int(n) === 0;
  const commit = hex(g, p([40, 64])), head = p([commit, hex(g, 40)]), route = p(ROUTES), actor = p(['core-7', 'core-7', 'core-7', 'coordinator', 'core-3']);
  const history = [], verdicts = [];
  let id = 100;
  const push = (kind, by, detail) => history.push({ id: id++, kind, by, detail });
  const verdict = (decision) => {
    push(decision === 'ACCEPT' ? 'accept' : 'reject', 'core-8', { clause: p(['Alpha keeps', 'Beta', 'Gamma', 'Epsilon', 'Deltas d0']), barKey: p([learnt.barKey, learnt.barKey, 'old']) });
    verdicts.push({ id: 900 + verdicts.length, item: 42, by: 'core-8', decision, reason: decision === 'ACCEPT' ? 'CRITERION_MET' : p(REASONS), note: `round ${verdicts.length}`, commit, digest: DIGEST, head: commit, family: null, at: PAST });
  };
  const steps = [() => verdict('REJECT'), () => verdict('REJECT'), () => verdict('REJECT'), () => verdict('ACCEPT'), () => push('escalate', 'coordinator', { from: 'light', to: 'mid' }),
    () => push('strong-rejection-notice', 'coordinator', { engine: p([learnt.engine, learnt.engine - 1]) }), () => push('edit', 'coordinator', p([{ route: 'mid' }, { title: 'x' }])),
    () => push('bar-sharpen', 'coordinator', { clause: p(['Alpha keeps', 'Beta']), barKey: learnt.barKey }), () => push('submit', 'core-2', { commit }), () => push('submit', 'core-3', { commit: 'pending' }),
    () => push('reserve', actor, {})];
  const count = g.int(5), at = g.int(count + 1);
  const lost = one(12); // a board that never recorded the submit
  for (let i = 0; i <= count; i++) (i === at ? () => !lost && push('submit', 'core-1', { commit }) : p(steps))();
  const since = history.findLast(e => e.kind === 'submit')?.id ?? 0;
  const observations = Array.from({ length: g.int(3) }, (_, i) => ({ id: p([since - 1, since, since + 1 + i, since + 1 + i]), detail: { engine: p([61, 61, 60]),
    observation: { kind: p(['verify', 'verify', 'submit']), head: p([commit, commit, 'e'.repeat(40)]), original: { green: p([false, false, true]) }, file: p(['test/a.test.js', 'test/a.test.js', 7]), name: p([' keeps order ', 'names it', 3]) } } }));
  const s = { now: NOW, actor: { id: actor, joined: true, route: p(ROUTES.slice(ROUTES.indexOf(route))), family: p(['OpenAI', null, undefined]) },
    item: { id: 42, status: one(8) ? 'verified' : 'submitted', merged: false, commit, frozenDigest: DIGEST, route, lane: p(['core', 'core', 'coordinator']), builtBy: p(['core-1', 'core-1', null]), owner: 'core-1',
      frozen: frozen({ verify: { policy: one(6) ? 'coordinator' : 'any', family: p(['off', 'prefer', 'require']) } }, `c0ffee9${hex(g, p([33, 57, 45]))}`),
      reviewBy: p([null, null, actor, 'core-9']), reviewUntil: p([PAST, NOW, LATER]), effectiveHead: p([null, null, head]), outside: null },
    history, verdicts, knownItems: [7, 8], actorFlakeObservations: observations, nativeFlakeEngine: 61, lineSettings: { sharpenToPerson: p([true, false, 'yes']) }, nextEventId: id + g.int(3), nextVerdictId: 900 + verdicts.length,
    io: { isMain: false, mainRefusal: null, selfSession: false, staleAcceptance: true, policyRefused: null, commitInHead: p([true, undefined]), root: '/repo', missingCompanions: p([null, null, { keys: [], digest: 'p0' }]),
      checkRefused: null, selectorGap: one(6), reviewHolderFresh: p([true, false, undefined]) },
    deferred: { ...Object.fromEntries(Object.values(DEFERRED).map(key => [key, null])), relaxation: p([null, 'relaxed after 5 minutes']), assurance: p([null, { level: 'two-tier' }]),
      impliedFacts: p([null, [], [{ kind: 'fact', item: 7, by: actor, detail: { implied: true } }]]) } };
  const accept = one(2);
  const m = { id: 42, actor, decision: accept ? 'ACCEPT' : 'REJECT', head, digest: DIGEST, review: { commit, head, trunk: hex(g, p([40, 64])), paths: p([['a.js', 'b/c.js'], [], ['z.js']]) },
    sourceAdvanceHead: s.item.effectiveHead ?? p([undefined, null]), reason: accept ? p([undefined, 'CRITERION_MET']) : p(['TEST_FAILURE', ...REASONS]),
    note: p(['broke the order; it refused', ' tried an edge \n', 'the queue lost a waiter']), clause: p(QUOTES), cause: p([undefined, undefined, null, 'refusal:FLAKE', 'test:x.js::y']),
    check: p([undefined, { ran: 1 }]), companionDigest: p([undefined, 'cd1']), itemReviewPolicy: p([undefined, 'strict']), environment: p([undefined, null, { platform: 'darwin' }]),
    sandbox: p([undefined, { receipt: 'r' }]), implies: p([undefined, [], [7, 8]]) };
  if (accept) Object.assign(m, { knownMainFailures: p([undefined, { main: m.review.trunk }]), quarantineProofId: p([undefined, 5]) });
  if (one(10)) [s.io.isMain, s.io.mainRefusal, m.as] = [true, { message: 'unused' }, 'coordinator'];
  for (const row of Array.from({ length: p([0, 0, 0, 1, 1, 2]) }, () => p(Object.keys(SPOILERS)))) if (s.item) SPOILERS[row](g, s, m);
  return { s, move: m };
}

/** The guards restated apart from the table, in the order the command checks them: [row, code, refuses, shell answer]. */
const isSha = (x) => typeof x === 'string' && /^[0-9a-f]*$/u.test(x) && (x.length === 40 || x.length === 64);
const yes = (m) => m.decision === 'ACCEPT';
const noteOf = (m) => String(m.note ?? '');
function policyOf(s) {
  let p;
  try { p = JSON.parse(s.item.frozen ?? 'null')?.policy; } catch { return null; }
  const commitOk = /^[0-9a-f]+$/u.test(p?.commit ?? '') && p.commit.length >= 40 && p.commit.length <= 64;
  return p?.version === 1 && commitOk && ['any', 'coordinator'].includes(p.verify?.policy) && ['off', 'prefer', 'require'].includes(p.verify?.family) ? p.verify : null;
}
function reviewOk(r, commit) {
  if (!r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).sort().join() !== 'commit,head,paths,trunk') return false;
  const fine = (path) => typeof path === 'string' && !path.includes('\0') && path.split('/').every(part => !['', '.', '..'].includes(part));
  return [r.head, r.commit, r.trunk].every(isSha) && r.commit === commit && Array.isArray(r.paths) && r.paths.every(fine) && r.paths.every((path, i) => i === 0 || r.paths[i - 1] < path);
}
const authors = (s) => [s.item.builtBy, ...s.history.filter(e => e.kind === 'submit' && isSha(e.detail.commit)).map(e => e.by)].filter(Boolean);
const holder = (s) => (s.item.status === 'submitted' && s.item.reviewBy && s.item.reviewUntil > s.now && s.io.reviewHolderFresh !== false ? s.item.reviewBy : null);
const fromShell = (row, code, key, applies = () => true) => [row, code, (s, m) => applies(m) && Boolean(s.deferred[key] ?? s.io[key]), (s) => s.deferred[key] ?? s.io[key]];
const GUARDS = [
  ['decision-known', 'USAGE', (s, m) => m.decision !== 'ACCEPT' && m.decision !== 'REJECT'], ['as-coordinator-only', 'USAGE', (s, m) => m.as !== undefined && m.as !== 'coordinator'],
  ['as-main-only', 'USAGE', (s, m) => Boolean(m.as) && !s.io.isMain], ['main-is-coordinator', 'MAIN_IS_COORDINATOR', (s, m) => s.io.isMain && m.as !== 'coordinator'],
  ['joined', 'NOT_JOINED', (s) => !s.actor.joined], ['item-exists', 'NO_ITEM', (s) => !s.item], ['self-session', 'SELF_SESSION_VERIFY', (s) => s.io.selfSession],
  ['submitted', 'NOT_SUBMITTED', (s) => !(s.item.status === 'submitted' || (s.item.status === 'verified' && !s.item.merged && s.io.staleAcceptance))],
  ['implied-items-exist', 'NO_ITEM', (s, m) => (m.implies ?? []).some(n => !s.knownItems.includes(n))], fromShell('item-policy', 'NO_POLICY', 'policyRefused'),
  ['at-submitted-commit', 'NOT_AT_COMMIT', (s) => s.io.commitInHead === false], ['companions-present', 'NOT_AT_COMMIT', (s) => s.io.missingCompanions?.keys.length > 0],
  ['accept-criterion-current', 'CRITERIA_CHANGED', (s, m) => yes(m) && m.digest !== s.item.frozenDigest], fromShell('accept-check', 'CHECK_RED', 'checkRefused', yes),
  ['frozen-policy', 'NO_POLICY', (s) => !policyOf(s)], fromShell('environment-shape', 'VERDICT_ENVIRONMENT', 'environmentProblem'),
  ['known-main-binds', 'SUBMISSION_PROOF', (s, m) => m.knownMainFailures !== undefined && !(yes(m) && m.review && m.knownMainFailures.main === m.review.trunk)],
  fromShell('known-main-owned', 'SUBMISSION_PROOF', 'knownMainProblem'), ['quarantine-accept-only', 'PROOF_RUN_UNBOUND', (s, m) => m.quarantineProofId !== undefined && !yes(m)],
  fromShell('quarantine-bound', 'PROOF_RUN_UNBOUND', 'quarantineProblem'), fromShell('gate-receipt', 'GATE_PENDING', 'gateReceipt'),
  ['source-advance-current', 'SOURCE_ADVANCE_STALE', (s, m) => (s.item.effectiveHead ?? null) !== (m.sourceAdvanceHead ?? null)], ['not-merged', 'ALREADY_MERGED', (s) => s.item.merged],
  ['review-recorded', 'BAD_VERDICT_REVIEW', (s, m) => !reviewOk(m.review, s.item.commit)], fromShell('companion-window', 'COMPANION_WINDOW', 'companionWindow'),
  ['not-builder', 'SELF_VERIFY', (s, m) => authors(s).includes(m.actor)], fromShell('author-independence', 'SELF_SESSION_VERIFY', 'authorProblem'),
  ['route-allows', 'ROUTE', (s) => ROUTES.indexOf(s.item.route) > ROUTES.indexOf(s.actor.route)],
  ['policy-allows', 'COORDINATOR_VERIFIES', (s, m) => policyOf(s).policy === 'coordinator' && s.item.lane !== 'coordinator' && m.actor !== 'coordinator'],
  fromShell('required-family', 'REQUIRED_REVIEW_FAMILY', 'requiredFamily'), fromShell('family-allows', 'O2_FAMILY_MATCH', 'familyProblem'),
  ['review-free', 'REVIEW_HELD', (s, m) => holder(s) !== null && holder(s) !== m.actor], ['criterion-unchanged', 'CRITERIA_CHANGED', (s, m) => m.digest !== s.item.frozenDigest],
  fromShell('patch-review', 'ITEM_PATCH_CHANGED', 'patchProblem'), ['reason-is-met', 'BAD_REASON', (s, m) => yes(m) && Boolean(m.reason) && m.reason !== 'CRITERION_MET'],
  fromShell('outside-sandbox', 'CHECK_RED', 'sandboxProblem'), ['proof-noted', 'PROOF_REQUIRED', (s, m) => yes(m) && !noteOf(m).trim()],
  ['reason-coded', 'BAD_REASON', (s, m) => !yes(m) && !REASONS.includes(m.reason)], ['note-given', 'NOTE_REQUIRED', (s, m) => !yes(m) && !noteOf(m).trim()],
  ['cause-well-formed', 'BAD_CAUSE', (s, m) => !yes(m) && m.cause != null && !/^[a-z]+:./u.test(String(m.cause))],
  ['clause-given', 'BAR_CLAUSE_REQUIRED', (s, m) => !yes(m) && !(typeof m.clause === 'string' && m.clause.trim())],
  ['clause-known', 'BAR_CLAUSE_UNKNOWN', (s, m) => !yes(m) && (words(m.clause).length > 4096 || !CLAUSE.has(words(m.clause)))],
];
const fallback = (code) => VERIFY_NEXT[code] ?? EXTRA[code] ?? 'run pullboard help';
const NEXTS = { 'main-is-coordinator': (s) => s.io.mainRefusal?.next, joined: (s) => s.io.notJoined?.next ?? VERIFY_NEXT.NOT_JOINED, 'self-session': () => VERIFY_NEXT.SELF_SESSION_VERIFY,
  'clause-given': () => VERIFY_NEXT.BAR_CLAUSE_REQUIRED, 'clause-known': (s, m) => `read pullboard show ${m.id}, then quote the failing requirement with --clause` };

/** The shout a bar-sharpen sends, restated: the whole clause when it fits 400 characters, else its start and how much was cut. */
function shoutText(clause) {
  const say = (quoted) => `#42 needs a sharper bar after two rejects of “${quoted}”. Clarify the criterion, refreeze it, and lift the item hold before another build round.`;
  if (say(clause).length <= 400) return say(clause);
  const keep = 400 - say('').length - `… (+${clause.length} characters; pullboard show 42)`.length;
  return say(`${clause.slice(0, keep)}… (+${clause.length - keep} characters; pullboard show 42)`);
}

/** What an accepted verdict writes, restated from the rule in words: the verdict, its cause, and every follow-up it triggers. */
function expected(s, m, pipelineCause) {
  const accept = yes(m), note = noteOf(m) + (s.deferred.relaxation ? `\n${s.deferred.relaxation}` : '');
  const row = { id: s.nextVerdictId, item: 42, by: m.actor, decision: m.decision, reason: accept ? 'CRITERION_MET' : m.reason, note: note.trim(), commit: s.item.commit, digest: m.digest, head: m.head, family: s.actor.family ?? null, at: NOW };
  let out = { patch: { status: accept ? 'verified' : 'open', verdict: m.decision, verifiedBy: accept ? m.actor : null, owner: accept ? 'core-1' : null, verdictRow: row,
    ...(s.deferred.assurance ? { meta: { [`verdict_assurance:${row.id}`]: s.deferred.assurance } } : {}) }, events: [], via: [accept ? 'accept' : 'reject'] };
  const given = (keys) => Object.fromEntries(keys.filter(key => m[key] !== undefined).map(key => [key, m[key]]));
  const detail = { reason: row.reason, commit: s.item.commit, ...(m.companionDigest ? { companionDigest: m.companionDigest } : {}), ...(m.itemReviewPolicy ? { policy: m.itemReviewPolicy } : {}),
    ...given(accept ? ['check', 'knownMainFailures', 'quarantineProofId', 'environment', 'sandbox'] : ['environment', 'sandbox']), review: { ...m.review }, ...(m.implies?.length ? { implies: m.implies } : {}) };
  const clauseText = accept ? null : CLAUSE.get(words(m.clause));
  if (accept) detail.note = note.trim();
  else Object.assign(detail, { pipelineCause, clause: words(m.clause), clauseText, barKey: learnt.barKey }, causeOf(s, m));
  out.events.push({ kind: m.decision.toLowerCase(), by: m.actor, detail });
  if (accept && s.io.selectorGap) out = { patch: {}, events: [], via: ['selector-gap'] };
  const add = (via, patch, events) => { out = { patch: { ...out.patch, ...patch }, events: [...out.events, ...events], via: [...out.via, via] }; };
  const same = (e) => e.detail.barKey === learnt.barKey && CLAUSE.get(e.detail.clause) === clauseText;
  if (!accept && s.history.filter(e => e.kind === 'reject' && same(e)).length === 1 && !s.history.some(e => e.kind === 'bar-sharpen' && same(e))) {
    const to = s.lineSettings.sharpenToPerson === true ? 'person' : 'coordinator', reason = `The bar needs sharpening after two rejects of: ${clauseText}`;
    add('bar-sharpen', { holdReason: reason }, [{ kind: 'hold_item', by: 'coordinator', detail: { reason } }, { kind: 'bar-sharpen', by: 'coordinator', detail: { clause: words(m.clause), clauseText, barKey: learnt.barKey, to, digest: DIGEST } },
      { kind: 'shout', item: null, by: to === 'person' ? 'coordinator' : 'sentinel', detail: { to, lanes: ['coordinator'], decision: to === 'person', text: shoutText(clauseText) } }]);
  }
  const lift = (from, note, extra = {}) => [{ route: UP[from], owner: null, leaseUntil: null }, [{ kind: 'escalate', by: 'coordinator', detail: { from, to: UP[from], note, ...extra } }]];
  const calibrates = !accept && m.reason === 'TEST_FAILURE' && s.actor.route === s.item.route;
  if (calibrates) add('route-calibration', ...lift(s.item.route, `${m.actor} rejected at the ${s.actor.route} route: ${m.reason} (${note.trim()})`));
  const all = [...s.history, { id: s.nextEventId, kind: 'reject', detail: {} }], rows = [...s.verdicts, row];
  const start = all.findLastIndex(e => e.kind === 'escalate' || (e.kind === 'strong-rejection-notice' && e.detail.engine === learnt.engine) || (e.kind === 'edit' && 'route' in e.detail)) + 1;
  const verdictOf = new Map(all.filter(e => e.kind === 'accept' || e.kind === 'reject').map((e, i) => [e.id, rows[i]]));
  const since = all.slice(start).filter(e => e.kind === 'reject' && verdictOf.get(e.id).decision === 'REJECT');
  const rejections = since.slice(-2).map(({ id }) => [id, verdictOf.get(id)]).map(([id, v]) => ({ eventId: id, verdictId: v.id, by: v.by, reason: v.reason, note: v.note, commit: v.commit, digest: v.digest, head: v.head, at: v.at }));
  const twice = !accept && !calibrates && since.length >= 2;
  if (twice && s.item.route !== 'strong') add('two-rejects', ...lift(s.item.route, `Two REJECT verdicts at the ${s.item.route} route`, { rejections }));
  if (twice && s.item.route === 'strong') {
    const builder = s.item.builtBy ?? s.item.owner;
    add('two-rejects', {}, [{ kind: 'strong-rejection-notice', by: 'coordinator', detail: { engine: learnt.engine, route: 'strong', builder, rejections } }, { kind: 'shout', item: null, by: 'sentinel',
      detail: { to: 'coordinator', lanes: ['coordinator'], text: `#42 has two send-backs at the strongest route; ${builder} built it. Rejections: ${rejections.map(r => `#${r.verdictId} (${r.reason})`).join(', ')}.` } }]);
  }
  if (s.deferred.impliedFacts?.length) add('implied-facts', {}, s.deferred.impliedFacts);
  return out;
}
/** A reject's cause: the one given, else the reviewer's last recorded failing test since the submit, else its reason, marked coarse. */
function causeOf(s, m) {
  if (m.cause !== undefined && m.cause !== null) return { cause: m.cause };
  const since = s.history.filter(e => e.kind === 'submit').at(-1)?.id ?? 0;
  const seen = s.actorFlakeObservations.filter(({ id, detail: { engine, observation: o } }) => id > since && engine === s.nativeFlakeEngine && o.kind === 'verify' && o.head === s.item.commit
    && o.original.green === false && typeof o.file === 'string' && typeof o.name === 'string').at(-1);
  if (seen) return { cause: `test:${seen.detail.observation.file}::${seen.detail.observation.name.trim()}`, causeDerivation: { kind: 'recorded-failure', event: seen.id } };
  return { cause: `refusal:${m.reason}`, causeDerivation: { kind: 'verdict-reason', coarse: true } };
}

const BOOT = Array.from({ length: 300 }, (_, i) => scenario(i + 1)).flatMap(c => run(c.s, c.move).events ?? []);
learnt.barKey = BOOT.find(e => e.kind === 'reject').detail.barKey;
learnt.engine = BOOT.find(e => e.kind === 'strong-rejection-notice').detail.engine;
const CASES = 8_000;
const results = Array.from({ length: CASES }, (_, i) => { const { s, move } = scenario(i + 1); return { seed: i + 1, s, move, result: run(s, move) }; });
const ok = results.filter(c => !c.result.refused);

test('moves.verify.rows-fire: generated: every guard, outcome and follow-up row of the verify table fires on some seeded case [C7,#8264]', () => {
  const fired = new Set(results.flatMap(c => (c.result.refused ? [c.result.refused.row] : c.result.via)));
  // The seeds run steady, so the rows tagged for other paces are left out here; verify-sprint.test.js fires those [#8868].
  const steady = (row) => !row.paces || row.paces.includes('steady');
  const rows = [...TABLE.guards, ...TABLE.outcomes, ...TABLE.followups].filter(steady).map(row => row.id);
  assert.deepEqual(rows.filter(row => !fired.has(row)), []);
  assert.deepEqual(GUARDS.map(([row]) => row), TABLE.guards.filter(steady).map(row => row.id));
  assert.ok(ok.length > CASES / 4, `only ${ok.length} accepted verdicts`);
  assert.match(learnt.barKey, /^[0-9a-f]{64}$/u);
});

test('moves.verify.refusal-rows: generated: a refusal writes nothing and carries the first failing guard, its code, its message and the next step VERIFY_NEXT gives [C7,#8264]', () => {
  for (const c of results) {
    const guard = GUARDS.find(([, , refuses]) => refuses(c.s, c.move));
    assert.equal(c.result.refused?.row, guard?.[0], `seed ${c.seed}`);
    if (!guard) continue;
    const { refused } = c.result, answer = guard[3]?.(c.s), code = answer?.code ?? guard[1];
    assert.ok(!('patch' in c.result) && !('events' in c.result), `seed ${c.seed}`);
    assert.equal(refused.code, code, `seed ${c.seed}`);
    const next = answer ? answer.next ?? fallback(code) : guard[0] in NEXTS ? NEXTS[guard[0]](c.s, c.move) : stepInMessage(refused.message) ?? fallback(code);
    assert.equal(refused.next, next, `seed ${c.seed}: ${guard[0]}`);
    if (answer) assert.equal(refused.message, answer.message, `seed ${c.seed}`);
    else assert.ok(typeof refused.message === 'string' && refused.message.length > 0, `seed ${c.seed}`);
    if (guard[0] === 'implied-items-exist') assert.match(refused.message, /^no item #99 to imply/u);
  }
});

test('moves.verify.accepted-verdict: generated: each accepted verdict writes the verdict, cause and follow-ups the rule in words gives, and no one verifies their own work [C7,#8264]', () => {
  for (const c of ok) {
    const pipelineCause = c.result.events[0]?.detail.pipelineCause;
    if (c.result.via[0] === 'reject') assert.deepEqual([pipelineCause.cause, pipelineCause.reason], [c.result.events[0].detail.cause, c.move.reason], `seed ${c.seed}`);
    assert.deepEqual(c.result, expected(c.s, c.move, pipelineCause), `seed ${c.seed}`);
    assert.ok(!authors(c.s).includes(c.move.actor), `seed ${c.seed}: an author verified`);
    for (const shout of c.result.events.filter(e => e.kind === 'shout')) assert.ok(shout.detail.text.length <= 400, `seed ${c.seed}`);
  }
});

test('moves.verify.deterministic: generated: the same snapshot and move give the same answer, and the run never mutates them [C7,#8264]', () => {
  for (const c of results.slice(0, 1500)) {
    const snapshot = structuredClone(c.s), move = structuredClone(c.move);
    assert.deepEqual(runTable(TABLE, RULES, snapshot, move), c.result, `seed ${c.seed}`);
    assert.deepEqual([snapshot, move], [c.s, c.move], `seed ${c.seed}`);
  }
});

test('moves.verify.step-in-message: generated: stepInMessage reads the step a first line spells out after a separator, never a --reason CODE usage line [C7,#8264]', () => {
  const g = seeded(8264);
  const VERBS = ['run', 'Install', 'upgrade', 'fix', 'restore', 'commit', 'merge', 'test', 'check out', 'set', 'give', 'use', 'reject', 'ask your coordinator', 'the coordinator runs', 'to keep looking', 'never work around'];
  for (let i = 0; i < 2000; i++) {
    const [sep, verb, tail, rest] = [g.pick(['', '; ', '. ', ': ', ', ', ' - ']), g.pick([...VERBS, 'see', 'running', 'the coordinator waits']), g.pick(['pullboard doctor', 'it --reason CODE now', 'it']), g.pick(['', '\nrun the other'])];
    const message = `${sep ? 'the gate stopped' : ''}${sep}${verb} ${tail}${rest}`;
    const step = ['', '; ', '. ', ': '].includes(sep) && VERBS.includes(verb) && !tail.includes('CODE') ? `${verb} ${tail}` : undefined;
    assert.equal(stepInMessage(message), step, JSON.stringify(message));
  }
});

test('moves.verify.table-inputs: generated: the verify engine refuses VERIFY_TABLE_INPUTS when any board input is missing or the wrong kind [C7,#8264]', () => {
  const board = { acceptReason: 'CRITERION_MET', rejectReasons: ['OTHER'], wording: String, frozenBar: () => ({}), namedClause: () => null, causeProblem: () => null, pipelineCause: () => ({}), strongNoticeEngine: 54 };
  assert.equal(typeof verifyEngine(board).table, 'object');
  const breaks = [{ acceptReason: 7 }, { rejectReasons: 'OTHER' }, { rejectReasons: [] }, { strongNoticeEngine: 1.5 }, { strongNoticeEngine: '54' },
    ...['wording', 'frozenBar', 'namedClause', 'causeProblem', 'pipelineCause'].map(name => ({ [name]: 'x' }))];
  for (const change of [...breaks, null]) assert.throws(() => verifyEngine(change && { ...board, ...change }), { code: 'VERIFY_TABLE_INPUTS' }, JSON.stringify(change));
});

test('moves.verify.fact-breaks: metamorphic: break any one fact of an accepted verdict and it refuses at that guard with its code [C7,#8264]', () => {
  for (const c of ok.slice(0, 250)) {
    for (const [row, spoil] of Object.entries(SPOILERS)) {
      if (ONLY[c.move.decision === 'ACCEPT' ? 'REJECT' : 'ACCEPT'].includes(row) || (row === 'review-recorded' && c.move.knownMainFailures)) continue;
      const s = structuredClone(c.s), move = structuredClone(c.move);
      spoil(seeded(c.seed), s, move);
      const { refused } = run(s, move);
      assert.equal(refused?.row, row, `seed ${c.seed}: breaking ${row}`);
      assert.equal(refused.code, GUARDS.find(each => each[0] === row)[3]?.(s)?.code ?? GUARDS.find(each => each[0] === row)[1], `seed ${c.seed}`);
    }
  }
});

test('moves.verify.unrelated-facts: metamorphic: a new note, trunk, checkout root or unrelated history keeps the outcome of an accepted verdict [C7,#8264]', () => {
  for (const c of ok.filter(each => each.move.knownMainFailures === undefined).slice(0, 800)) {
    const s = structuredClone(c.s), move = { ...structuredClone(c.move), note: `${c.move.note} again`, review: { ...c.move.review, trunk: 'a'.repeat(40) } };
    s.io.root = '/elsewhere';
    s.knownItems.push(9);
    s.history.splice(1, 0, { id: 99, kind: 'renew', by: c.move.actor, detail: {} });
    const again = run(s, move);
    assert.deepEqual([again.via, again.patch.status, again.patch.route], [c.result.via, c.result.patch.status, c.result.patch.route], `seed ${c.seed}`);
  }
});
