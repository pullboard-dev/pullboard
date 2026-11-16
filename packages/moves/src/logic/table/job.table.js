/** The gate-job queue as one move table: offer, claim, renew, release, progress, receipt and shards over kind, step, owner, lease and claim token [C7,#8239]. */
import { Refused } from '../../../../kernel/light.js';
import { defineRules } from './rules.js';

/** The job kinds the queue serves. */
export const GATE_JOB_KINDS = Object.freeze(['gate', 'gate-shard', 'land', 'review']);

/** The moves the job table knows. `shards` is the land job's ask for its proof's shard jobs. */
export const JOB_QUEUE_MOVES = Object.freeze(['offer', 'claim', 'renew', 'release', 'progress', 'receipt', 'shards']);

/** Moves that act as the claim's runner and so are fenced by runner and token. */
const HELD_MOVES = ['renew', 'release', 'progress', 'receipt', 'shards'];

/** A released job waits 30 s, doubling per attempt, up to 5 minutes, so a failing handler never re-claims at once. */
const BACKOFF_FIRST_MS = 30_000;
const BACKOFF_MAX_MS = 300_000;

/** The wait before a job released on attempt n is offered again. */
export const releaseBackoff = (attempt) => Math.min(BACKOFF_FIRST_MS * 2 ** Math.max(0, Math.min(attempt, 20) - 1), BACKOFF_MAX_MS);

/** The event a step write leaves: `job.step` with the step's name and its attempt and runner when it has them. */
const step = (name, more = {}) => ({ kind: 'job.step', step: name, ...more });

/**
 * Snapshot: `{ job: null | { kind, step: 'queued'|'offered'|'claimed'|'done', attempt, owner, leaseUntil, claim: null | { runner, token } }, now }`.
 * `owner` and `leaseUntil` are the row's lease; `claim` is the current attempt's claimed step, which outlives a release.
 * Move: `{ name, runner, token, kind?, free? }`; `token` is the token the caller holds, or for a claim the one it is handed; `free` is a release that leaves no backoff.
 * Why: the facts are the job queue's rules in words, so a refusal and its explanation come from the same row.
 */
const jobRules = ({ maxAttempts }) => defineRules({
  knownMove: { says: 'the move is one the job queue knows', holds: (s, m) => JOB_QUEUE_MOVES.includes(m.name) },
  knownKind: { says: 'the move is not an offer, or it names a job kind the queue serves', holds: (s, m) => m.name !== 'offer' || GATE_JOB_KINDS.includes(m.kind) },
  exists: { says: 'the job exists on this board', holds: (s) => s.job !== null && s.job !== undefined },
  present: { says: 'the move is an offer, or the job exists', reads: ['exists'], holds: (s, m, fact) => m.name === 'offer' || fact('exists') },
  holdsClaim: { says: 'the caller is the runner and token of the job\'s current claim', reads: ['exists'], holds: (s, m, fact) => fact('exists') && Boolean(s.job.claim) && s.job.claim.runner === m.runner && s.job.claim.token === m.token },
  fenced: { says: 'the move is not made by a claim\'s runner, or the caller holds the current claim', reads: ['holdsClaim'], holds: (s, m, fact) => !HELD_MOVES.includes(m.name) || fact('holdsClaim') },
  over: { says: 'the job is done', reads: ['exists'], holds: (s, m, fact) => fact('exists') && s.job.step === 'done' },
  unfinished: { says: 'the move is not a claim or progress post, or the job is not done', reads: ['over'], holds: (s, m, fact) => !['claim', 'progress'].includes(m.name) || !fact('over') },
  offered: { says: 'the move is not a claim, or the job was offered', holds: (s, m) => m.name !== 'claim' || s.job.step === 'offered' || s.job.step === 'claimed' },
  free: { says: 'the move is not a claim, or no live lease holds the job', holds: (s, m) => m.name !== 'claim' || s.job.leaseUntil < s.now },
  landJob: { says: 'the move is not a shards ask, or the job is a land job', holds: (s, m) => m.name !== 'shards' || s.job.kind === 'land' },
  offering: { says: 'the move is an offer of a job that does not exist yet', reads: ['exists'], holds: (s, m, fact) => m.name === 'offer' && !fact('exists') },
  reoffering: { says: 'the move is an offer of a job that exists', reads: ['exists'], holds: (s, m, fact) => m.name === 'offer' && fact('exists') },
  runaway: { says: 'a claim of a job already claimed the most times a job may be', holds: (s, m) => m.name === 'claim' && s.job.attempt >= maxAttempts },
  claiming: { says: 'the move is a claim', holds: (s, m) => m.name === 'claim' },
  owner: { says: 'the caller holds the job\'s lease now', holds: (s, m) => s.job?.owner === m.runner },
  renewing: { says: 'the move is a renew by the lease owner', reads: ['owner'], holds: (s, m, fact) => m.name === 'renew' && fact('owner') },
  renewLost: { says: 'the move is a renew after the lease was released', reads: ['owner'], holds: (s, m, fact) => m.name === 'renew' && !fact('owner') },
  releasing: { says: 'the move is a release by the lease owner that backs off', reads: ['owner'], holds: (s, m, fact) => m.name === 'release' && fact('owner') && !m.free },
  releasingFree: { says: 'the move is a release by the lease owner that leaves no backoff', reads: ['owner'], holds: (s, m, fact) => m.name === 'release' && fact('owner') && Boolean(m.free) },
  releaseLost: { says: 'the move is a release by a claim that no longer owns the lease', reads: ['owner'], holds: (s, m, fact) => m.name === 'release' && !fact('owner') },
  progressing: { says: 'the move is a progress post', holds: (s, m) => m.name === 'progress' },
  receipting: { says: 'the move is a receipt for a job not yet done', reads: ['over'], holds: (s, m, fact) => m.name === 'receipt' && !fact('over') },
  receiptAgain: { says: 'the move is a receipt for a job already done', reads: ['over'], holds: (s, m, fact) => m.name === 'receipt' && fact('over') },
  sharding: { says: 'the move is a shards ask', holds: (s, m) => m.name === 'shards' },
});

const job = (s, more) => ({ job: { ...s.job, ...more } });

/**
 * The job table: guards in order, one row per move and outcome. A runner without the current claim is JOB_LEASE_MOVED, and nothing is written while refusing.
 * Why: the claim token is the only authority a runner has, so every move after a claim is fenced by it, and a lapsed lease needs no sweeper because the next claim takes it.
 */
const jobTable = ({ leaseMs }) => Object.freeze({
  name: 'job',
  guards: Object.freeze([
    { id: 'known', requires: 'knownMove', code: 'JOB_ACTION', message: (s, m) => `the job queue has no move ${m.name}`, next: `use one of: ${JOB_QUEUE_MOVES.join(', ')}` },
    { id: 'kind', requires: 'knownKind', code: 'JOB_KIND', message: (s, m) => `a job's kind is one of ${GATE_JOB_KINDS.join(', ')}, not ${m.kind}`, next: `offer a job of one of: ${GATE_JOB_KINDS.join(', ')}` },
    { id: 'present', requires: 'present', code: 'JOB_MISSING', message: 'no job with this id is on this board', next: 'claim a job first' },
    { id: 'fenced', requires: 'fenced', code: 'JOB_LEASE_MOVED', message: (s, m) => `runner ${m.runner} does not hold this job's current claim`, next: 'stop work on it and claim a new job' },
    { id: 'unfinished', requires: 'unfinished', code: 'JOB_DONE', message: 'this job already posted its receipt, so nothing more is taken for it', next: 'read the receipt; the job is over' },
    { id: 'land', requires: 'landJob', code: 'JOB_NOT_LAND', message: 'this is not a land job; only a land job\'s runner asks for its proof\'s shards', next: 'ask for shards on the land job you hold' },
    { id: 'offered', requires: 'offered', code: 'JOB_NOT_OFFERED', message: 'this job is not offered yet', next: 'offer the job before it is claimed' },
    { id: 'free', requires: 'free', code: 'JOB_HELD', message: 'a live claim holds this job', next: 'take the next open job; this one is open once its lease lapses' },
  ]),
  outcomes: Object.freeze([
    { id: 'offer', when: 'offering', patch: (s, m) => ({ job: { kind: m.kind, step: 'offered', attempt: 0, owner: null, leaseUntil: 0, claim: null } }), events: () => [step('offered')] },
    { id: 'offer-again', when: 'reoffering', patch: (s) => ({ job: s.job }), events: () => [] },
    { id: 'runaway', when: 'runaway', patch: (s) => job(s, { step: 'done', owner: null, leaseUntil: 0 }), events: (s) => [step('runaway', { attempt: s.job.attempt })] },
    { id: 'claim', when: 'claiming', patch: (s, m) => job(s, { step: 'claimed', attempt: s.job.attempt + 1, owner: m.runner, leaseUntil: s.now + leaseMs, claim: { runner: m.runner, token: m.token } }),
      events: (s, m) => [step('claimed', { attempt: s.job.attempt + 1, runner: m.runner })] },
    { id: 'renew', when: 'renewing', patch: (s) => job(s, { leaseUntil: s.now + leaseMs }), events: () => [] },
    { id: 'renew-lost', when: 'renewLost', patch: (s) => ({ job: s.job }), events: () => [] },
    { id: 'release', when: 'releasing', patch: (s) => job(s, { owner: null, leaseUntil: s.now + releaseBackoff(s.job.attempt) }), events: (s, m) => [step('released', { attempt: s.job.attempt, runner: m.runner })] },
    { id: 'release-free', when: 'releasingFree', patch: (s) => job(s, { owner: null, leaseUntil: 0 }), events: () => [] },
    { id: 'release-lost', when: 'releaseLost', patch: (s) => ({ job: s.job }), events: () => [] },
    { id: 'progress', when: 'progressing', patch: (s) => ({ job: s.job }), events: (s) => [step('progress', { attempt: s.job.attempt })] },
    { id: 'receipt', when: 'receipting', patch: (s) => job(s, { step: 'done', owner: null, leaseUntil: 0 }), events: (s, m) => [step('receipt', { attempt: s.job.attempt, runner: m.runner })] },
    { id: 'receipt-again', when: 'receiptAgain', patch: (s) => ({ job: s.job }), events: () => [] },
    { id: 'shards', when: 'sharding', patch: (s) => ({ job: s.job }), events: () => [] },
  ]),
});

/**
 * Build the job queue's rules and table over the lease length and the claim cap, handed in by the caller.
 * Why: moves may not import the jobs or api cells, and these two numbers must stay one source; the wiring passes `LEASE_MS` and `JOB_MAX_ATTEMPTS`, so there is no second copy to drift.
 *
 * @param {{ leaseMs: number, maxAttempts: number }} queue
 * @returns {{ rules: ReturnType<typeof defineRules>, table: Readonly<object> }}
 */
export function jobEngine(queue) {
  if (!Number.isFinite(queue?.leaseMs) || queue.leaseMs <= 0 || !Number.isSafeInteger(queue?.maxAttempts) || queue.maxAttempts < 1) {
    throw new Refused('JOB_RULE', 'the job queue needs its lease and claim cap: leaseMs and maxAttempts', "pass LEASE_MS and JOB_MAX_ATTEMPTS from the jobs and api cells' own rules");
  }
  return Object.freeze({ rules: jobRules(queue), table: jobTable(queue) });
}
