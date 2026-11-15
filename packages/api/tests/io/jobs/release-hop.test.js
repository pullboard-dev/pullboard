/** @pullboard-test-input source-cell api */
/** With gate.fencedHop on, a runner that releases a gate job takes it back at once on its own live hop, and every other runner is still fenced out [C7,#8439]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { cellBoard } from '../../../../store/tests/fixtures/cell.js';
import { temporaryDirectory } from '../../../../../apps/cli/tests/fixtures/board.js';
import { readGateHop } from '../../../../store/index.js';
import { claimJob } from '../../../index.js';
import { gateClaimHop } from '../../../index.js';
import { provideGateHopTable } from '../../../index.js';
import { offerJob } from '../../../index.js';
import { releaseJob } from '../../../index.js';
import { renewJob } from '../../../index.js';

const ITEM = 7;
const LEASE = 120_000;
const CANDIDATE = 'c0ffee'.padEnd(40, '0');

/** A real board file with the gate jobs given offered for ITEM at CANDIDATE. */
function board(t, ids = ['gate:7:a']) {
  const root = temporaryDirectory('pullboard-release-hop-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { db } = cellBoard(t, join(root, 'board.sqlite'));
  ids.forEach((id, at) => offerJob(db, { id, kind: 'gate', needs: [], item: ITEM, candidate: CANDIDATE, now: 1000 + at }));
  return db;
}

/** The hop table's rows a claim needs, hand-written as serve provides them (a cell test may not import moves): create, acquire a queued or lapsed hop, step as the owner. */
provideGateHopTable(leaseMs => ({ hop, now }, { name, actor, epoch }) => {
  if (name === 'create') return { patch: { hop: { state: 'queued', owner: null, epoch: 0, leaseUntil: 0, attempts: 0, commit: CANDIDATE, digest: CANDIDATE } } };
  if (name === 'acquire') {
    return hop.state === 'queued' || hop.leaseUntil < now ? { patch: { hop: { ...hop, state: 'driven', owner: actor, epoch: hop.epoch + 1, leaseUntil: now + leaseMs } } }
      : { refused: { code: 'HOP_HELD', message: `the hop is driven by ${hop.owner} and its lease has not lapsed` } };
  }
  return hop.state === 'driven' && hop.owner === actor && hop.epoch === epoch ? { patch: { hop: { ...hop, leaseUntil: now + leaseMs } } }
    : { refused: { code: 'HOP_FENCED', message: `${actor} at epoch ${epoch} does not own this hop (owner ${hop.owner} at epoch ${hop.epoch})` } };
});

const claim = (db, runner, now) => claimJob(db, { runner, now, leaseMs: LEASE, hop: gateClaimHop(true) });

test('clause 1: a runner that releases a gate job claims it again at once with gate.fencedHop on, at its own hop epoch [C7,#8439]', t => {
  const db = board(t);
  const first = claim(db, 'r1', 5000);
  const { released, until } = releaseJob(db, { job: first.job, runner: 'r1', token: first.token, reason: 'busy', now: 6000 });
  assert.equal(released, true);
  assert.ok(until < 5000 + LEASE, 'the job comes back before r1\'s own hop lease would lapse');
  const again = claim(db, 'r1', until + 1);
  assert.equal(again?.job, first.job, 'r1 takes the job back without waiting out its own hop');
  assert.deepEqual([readGateHop(db, ITEM).owner, readGateHop(db, ITEM).epoch, readGateHop(db, ITEM).leaseUntil], ['r1', 1, until + 1 + LEASE], 'r1 keeps the hop at its epoch, with a fresh lease');
  assert.equal(renewJob(db, { job: again.job, runner: 'r1', token: again.token, now: until + 2, leaseMs: LEASE, hop: gateClaimHop(true) }).renewed, true, 'the new claim renews through the hop');
  assert.throws(() => renewJob(db, { job: first.job, runner: 'r1', token: first.token, now: until + 2, leaseMs: LEASE, hop: gateClaimHop(true) }), 'the released claim\'s token stays dead');
});

test('clause 2: while the first runner holds the hop, another runner is still refused the released gate job HOP_FENCED [C7,#8439]', t => {
  const db = board(t);
  const first = claim(db, 'r1', 5000);
  const { until } = releaseJob(db, { job: first.job, runner: 'r1', token: first.token, reason: 'busy', now: 6000 });
  assert.throws(() => claim(db, 'r2', until + 1), error => {
    assert.equal(error.code, 'HOP_FENCED');
    assert.match(error.message, /driven by r1/u);
    return true;
  });
  assert.deepEqual([readGateHop(db, ITEM).owner, readGateHop(db, ITEM).epoch], ['r1', 1], 'the refused claim left r1\'s hop as it was');
});

test('clause 2: a runner holding one live gate claim on the item is refused a second, so two claims never share an epoch [C7,#8439]', t => {
  const db = board(t, ['gate:7:a', 'gate:7:b']);
  claim(db, 'r1', 5000);
  assert.throws(() => claim(db, 'r1', 5001), { code: 'HOP_FENCED' });
});
