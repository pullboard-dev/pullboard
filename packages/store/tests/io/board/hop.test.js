/** @pullboard-test-input source-cell store */
/** Gate and gate-drive are one fenced row: writers racing on one gate hop over real SQLite cannot both win, and the loser is refused naming the owner [C7,#8269]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { gateHopMove } from '../../../src/io/board/hop.js';
import { readGateHop } from '../../../src/io/board/hop.js';
import { temporaryDirectory } from '../../fixtures/tmp.js';

const HOP = new URL('../../../src/io/board/hop.js', import.meta.url).href;
const NOW = 1_000_000;
const LEASE_MS = 120_000;

/**
 * The hop table's ownership rows the race touches, as a decision over the read row: create a queued hop, acquire a queued or
 * lapsed one at the next epoch, and step only as the owner at its epoch. The store fences whatever the table decides.
 */
const DECIDE = `(hop, move, now) => {
  if (move.name === 'create') return hop ? { refused: { code: 'HOP_EXISTS', message: 'a hop already exists' } }
    : { hop: { state: 'queued', owner: null, epoch: 0, leaseUntil: 0, attempts: 0, commit: 'c0ffee', digest: 'd1' } };
  if (move.name === 'acquire') return hop.state === 'queued' || hop.leaseUntil < now ? { hop: { ...hop, state: 'driven', owner: move.actor, epoch: hop.epoch + 1, leaseUntil: now + ${LEASE_MS} } }
    : { refused: { code: 'HOP_HELD', message: 'the hop is driven by ' + hop.owner + ' and its lease has not lapsed' } };
  return hop.owner === move.actor && hop.epoch === move.epoch ? { hop: { ...hop, leaseUntil: now + ${LEASE_MS} } }
    : { refused: { code: 'HOP_FENCED', message: move.actor + ' at epoch ' + move.epoch + ' does not own this hop (owner ' + hop.owner + ' at epoch ' + hop.epoch + ')' } };
}`;
const decide = (0, eval)(DECIDE);

/** A connection to the shared board file, in WAL with a busy wait, as every board writer opens it. */
function connect(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000');
  return db;
}

/** A real SQLite board file holding one queued hop for item 7, and a way to open more connections to it. */
function fixture(t) {
  const dir = temporaryDirectory('pullboard-gate-hop-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'board.sqlite');
  const open = () => { const db = connect(file); t.after(() => db.close()); return db; };
  const db = open();
  gateHopMove(db, { item: 7, decide: hop => decide(hop, { name: 'create' }, NOW), enabled: true });
  return { file, db, open };
}

/** Run a move and answer its refusal code and message, or the written hop. */
function attempt(db, { move, now = NOW, beforeWrite }) {
  try { return { hop: gateHopMove(db, { item: 7, actor: move.actor, decide: hop => decide(hop, move, now), enabled: true, beforeWrite }).hop }; }
  catch (error) { return { code: error.code, message: error.message }; }
}

test('clause 1: two writers that both read the queued gate hop cannot both win; the loser is refused HOP_FENCED naming the owner [C7,#8269]', t => {
  const f = fixture(t);
  const a = f.open();
  const b = f.open();
  let second;
  // Writer a reads the queued hop; before it writes, writer b reads the same queued hop and writes first.
  const first = attempt(a, { move: { name: 'acquire', actor: 'driver-a' }, beforeWrite: () => {
    second = attempt(b, { move: { name: 'acquire', actor: 'driver-b' } });
  } });
  assert.equal(second.hop?.owner, 'driver-b', 'the writer that wrote first owns the hop');
  assert.equal(first.code, 'HOP_FENCED', 'the writer whose read went stale is fenced');
  assert.match(first.message, /driver-a lost the race for the hop on #7: owner driver-b at epoch 1/u);
  const row = readGateHop(f.db, 7);
  assert.deepEqual([row.owner, row.epoch, row.state], ['driver-b', 1, 'driven'], 'one owner at one epoch');
});

test('clause 1: concurrent writers on separate threads racing one gate hop leave exactly one owner, and every loser names it [C7,#8269]', async t => {
  const f = fixture(t);
  const writers = 6;
  const gate = new Int32Array(new SharedArrayBuffer(4));
  const source = `import { workerData, parentPort } from 'node:worker_threads';
const decide = ${DECIDE};
import { DatabaseSync } from 'node:sqlite';
import { gateHopMove } from ${JSON.stringify(HOP)};
const db = new DatabaseSync(workerData.file);
db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000');
Atomics.add(workerData.gate, 0, 1);
while (Atomics.load(workerData.gate, 0) < workerData.writers) Atomics.wait(workerData.gate, 0, Atomics.load(workerData.gate, 0), 5);
let answer;
try { answer = { actor: workerData.actor, owner: gateHopMove(db, { item: 7, actor: workerData.actor, decide: hop => decide(hop, { name: 'acquire', actor: workerData.actor }, workerData.now), enabled: true }).hop.owner }; }
catch (error) { answer = { actor: workerData.actor, code: error.code, message: error.message }; }
db.close();
parentPort.postMessage(answer);
`;
  const url = new URL('data:text/javascript,' + encodeURIComponent(source));
  const answers = await Promise.all(Array.from({ length: writers }, (_, n) => new Promise((resolve, reject) => {
    const worker = new Worker(url, { workerData: { file: f.file, gate, writers, actor: `driver-${n}`, now: NOW } });
    t.after(() => worker.terminate());
    worker.once('message', resolve);
    worker.once('error', reject);
  })));
  const winners = answers.filter(answer => answer.owner);
  assert.equal(winners.length, 1, `exactly one writer wins: ${JSON.stringify(answers)}`);
  const owner = winners[0].actor;
  for (const loser of answers.filter(answer => !answer.owner)) {
    // A loser that read before the win lost the compare-and-set (HOP_FENCED); one that read after it is refused by the table (HOP_HELD).
    assert.ok(['HOP_FENCED', 'HOP_HELD'].includes(loser.code), `${loser.actor} is refused as fenced: ${loser.code}`);
    assert.ok(loser.message.includes(owner), `${loser.actor}'s refusal names the owner ${owner}: ${loser.message}`);
  }
  assert.deepEqual([readGateHop(f.db, 7).owner, readGateHop(f.db, 7).epoch], [owner, 1]);
});

test('clause 1: a driver whose lease lapsed and was retaken is fenced on its next step at the old epoch [C7,#8269]', t => {
  const f = fixture(t);
  assert.equal(attempt(f.db, { move: { name: 'acquire', actor: 'driver-a' } }).hop.epoch, 1);
  const later = NOW + 10 * 60_000;
  assert.equal(attempt(f.db, { move: { name: 'acquire', actor: 'driver-b' }, now: later }).hop.owner, 'driver-b');
  const stale = attempt(f.open(), { move: { name: 'step', actor: 'driver-a', epoch: 1 }, now: later });
  assert.equal(stale.code, 'HOP_FENCED');
  assert.match(stale.message, /owner driver-b at epoch 2/u);
});

test('clause 1: with gate.fencedHop off, a hop move writes nothing [C7,#8269]', t => {
  const f = fixture(t);
  const fresh = f.open();
  assert.deepEqual(gateHopMove(fresh, { item: 8, decide: hop => decide(hop, { name: 'create' }, NOW), enabled: false }), { off: true });
  assert.equal(readGateHop(fresh, 8), null);
});
