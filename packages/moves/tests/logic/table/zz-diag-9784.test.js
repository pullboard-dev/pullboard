/** diag */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claimJob } from '../../../../api/index.js';
import { offerJob } from '../../../../api/index.js';
import { postReceipt } from '../../../../api/index.js';
import { releaseJob } from '../../../../api/index.js';
import { renewJob } from '../../../../api/index.js';
import { gateClaimHop } from '../../../../api/index.js';
import { provideGateHopTable } from '../../../../api/index.js';
import { cellBoard } from '../../../../store/tests/fixtures/cell.js';
import { jobEngine } from '../../../index.js';
import { runTable } from '../../../index.js';

const T0 = Date.parse('2026-11-15T12:00:00.000Z');
const L = 120_000;
const { rules, table } = jobEngine({ leaseMs: L, maxAttempts: 12 });
const CAND = 'c0ffee'.padEnd(40, '0');
provideGateHopTable(leaseMs => ({ hop, now }, { name, actor, epoch }) => {
  if (name === 'create') return { patch: { hop: { state: 'queued', owner: null, epoch: 0, leaseUntil: 0, attempts: 0, commit: CAND, digest: CAND } } };
  if (name === 'acquire') return hop.state === 'queued' || hop.leaseUntil < now ? { patch: { hop: { ...hop, state: 'driven', owner: actor, epoch: hop.epoch + 1, leaseUntil: now + leaseMs } } } : { refused: { code: 'HOP_HELD', message: 'held' } };
  if (hop.state === 'done') return { refused: { code: 'HOP_OVER', message: 'over' } };
  if (name === 'finish') return hop.owner === actor && hop.epoch === epoch ? { patch: { hop: { ...hop, state: 'done', leaseUntil: now } } } : { refused: { code: 'HOP_FENCED', message: 'fenced' } };
  return hop.owner === actor && hop.epoch === epoch ? { patch: { hop: { ...hop, leaseUntil: now + leaseMs } } } : { refused: { code: 'HOP_FENCED', message: 'fenced' } };
});

function setup(t, kind, hopOn) {
  const db = cellBoard(t, ':memory:').db;
  const seen = [];
  offerJob(db, { id: 'j:1', kind, needs: [], item: hopOn ? 7 : null, candidate: hopOn ? CAND : null, now: T0 });
  const hop = hopOn ? gateClaimHop(true) : null;
  const claim = claimJob(db, { runner: 'r1', now: T0, leaseMs: L, hop });
  db.jobQueueShadow = { decide: (s, m) => runTable(table, rules, s, m), seen: c => seen.push(c) };
  return { db, seen, token: claim.token, hop };
}
const tries = fn => { try { fn(); return 'ok'; } catch (e) { return e.code ?? e.message; } };

test('clause 1: diag [C7]', t => {
  const out = [];
  for (const [kind, hopOn] of [['gate', true], ['gate', false], ['gate-shard', false], ['test', false]]) {
    const scenarios = {
      'renew-after-receipt': (x, a) => { postReceipt(x.db, { ...a, receipt: { status: 0 }, now: T0 + 1000 }); return tries(() => renewJob(x.db, { ...a, now: T0 + 2000, leaseMs: L, hop: x.hop })); },
      'release-after-receipt': (x, a) => { postReceipt(x.db, { ...a, receipt: { status: 0 }, now: T0 + 1000 }); return tries(() => releaseJob(x.db, { ...a, reason: 'x', now: T0 + 2000, hop: x.hop })); },
      'free-release-after-receipt': (x, a) => { postReceipt(x.db, { ...a, receipt: { status: 0 }, now: T0 + 1000 }); return tries(() => releaseJob(x.db, { ...a, backoff: false, draining: true, now: T0 + 2000, hop: x.hop })); },
      'receipt-lapsed': (x, a) => tries(() => postReceipt(x.db, { ...a, receipt: { status: 1 }, now: T0 + L * 3, hop: x.hop })),
      'receipt-twice': (x, a) => { postReceipt(x.db, { ...a, receipt: { status: 0 }, now: T0 + 1000, hop: x.hop }); return tries(() => postReceipt(x.db, { ...a, receipt: { status: 0 }, now: T0 + 1500, hop: x.hop })); },
      'renew-lapsed': (x, a) => tries(() => renewJob(x.db, { ...a, now: T0 + L * 3, leaseMs: L, hop: x.hop })),
      'release-then-receipt': (x, a) => { releaseJob(x.db, { ...a, reason: 'x', now: T0 + 1000, hop: x.hop }); return tries(() => postReceipt(x.db, { ...a, receipt: { status: 0 }, now: T0 + 2000, hop: x.hop })); },
      'free-release-then-receipt': (x, a) => { releaseJob(x.db, { ...a, backoff: false, draining: true, now: T0 + 1000, hop: x.hop }); return tries(() => postReceipt(x.db, { ...a, receipt: { status: 0 }, now: T0 + 2000, hop: x.hop })); },
      'release-then-renew': (x, a) => { releaseJob(x.db, { ...a, reason: 'x', now: T0 + 1000, hop: x.hop }); return tries(() => renewJob(x.db, { ...a, now: T0 + 2000, leaseMs: L, hop: x.hop })); },
      'receipt-no-hop-param': (x, a) => tries(() => postReceipt(x.db, { ...a, receipt: { status: 0 }, now: T0 + 1000 })),
    };
    for (const [name, run] of Object.entries(scenarios)) {
      const x = setup(t, kind, hopOn);
      const a = { job: 'j:1', runner: 'r1', token: x.token };
      let result;
      try { result = run(x, a); } catch (e) { result = `THROW ${e.code ?? e.message}`; }
      const bad = x.seen.filter(c => { try { assert.deepEqual(c.wrote, c.decided); return false; } catch { return true; } }).map(c => `${c.move}:${JSON.stringify(c.decided)}|${JSON.stringify(c.wrote)}`);
      out.push(`${kind}/${hopOn}/${name} -> ${result} compares=${x.seen.length} DIFF=${bad.join(' ; ')}`);
    }
  }
  assert.fail('\n' + out.join('\n'));
});
