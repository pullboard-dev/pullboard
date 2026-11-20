/** @pullboard-test-input source-cell store */
// fixture-subject: createFileWriteQueue (real temp directories and real child processes)
/** The file write queue applies writes across processes in order and keeps each caller's result [C7,#8163]. */
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFileWriteQueue } from '../../src/io/write-queue-file.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { runModuleChild as child } from '../fixtures/module-child.js';

const MODULE = fileURLToPath(new URL('../../src/io/write-queue-file.js', import.meta.url));

const WORKER = `
import { appendFileSync } from 'node:fs';
const [dir, log, name, module] = process.argv.slice(1);
const { createFileWriteQueue } = await import(module);
const queue = createFileWriteQueue(dir);
const sleep = ms => new Promise(done => setTimeout(done, ms));
const writes = [];
for (let n = 0; n < 4; n++) {
  writes.push(queue.submit({ id: name + n, run: async () => {
    appendFileSync(log, 'start ' + name + n + '\\n');
    await sleep(30);
    appendFileSync(log, 'end ' + name + n + '\\n');
    return name + n;
  } }));
}
await Promise.all(writes);
`;

test('store.io-write-queue-file.writes-submitted-to-the-file-queue: clause 1: writes submitted to the file queue by two processes against one directory apply one at a time in submission order [C7,#8163]', async () => {
  const dir = privateFixtureFiles('pullboard-wqf-').root;
  const log = join(dir, 'log.txt');
  appendFileSync(log, '');
  const codes = await Promise.all([child(WORKER, dir, log, 'a', MODULE), child(WORKER, dir, log, 'b', MODULE)]);
  assert.deepEqual(codes, [0, 0]);
  const lines = readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(lines.length, 16);
  for (let at = 0; at < lines.length; at += 2) {
    const [, name] = lines[at].split(' ');
    assert.equal(lines[at], `start ${name}`);
    assert.equal(lines[at + 1], `end ${name}`, 'a write started while another was running');
  }
  for (const who of ['a', 'b']) {
    const order = lines.filter(line => line.startsWith('start ' + who)).map(line => line.slice(-1));
    assert.deepEqual(order, ['0', '1', '2', '3'], `${who} writes ran out of submission order`);
  }
  const queue = createFileWriteQueue(dir);
  assert.deepEqual(queue.result('a3'), { ok: true, value: 'a3' });
});

test('store.io-write-queue-file.a-caller-that-dies-after-submitting: clause 2: a caller that dies after submitting finds its write\'s result in the result file when it asks again with the same write id [C7,#8163]', async () => {
  const dir = privateFixtureFiles('pullboard-wqf-').root;
  const log = join(dir, 'log.txt');
  const dying = `
    import { appendFileSync } from 'node:fs';
    const [dir, log, module] = process.argv.slice(1);
    const { createFileWriteQueue } = await import(module);
    const queue = createFileWriteQueue(dir);
    queue.submit({ id: 'w1', run: () => { appendFileSync(log, 'ran\\n'); setImmediate(() => process.exit(3)); return 42; } });
    await new Promise(() => {});
  `;
  assert.equal(await child(dying, dir, log, MODULE), 3);
  const queue = createFileWriteQueue(dir);
  assert.deepEqual(queue.result('w1'), { ok: true, value: 42 });
  const again = await queue.submit({ id: 'w1', run: () => { appendFileSync(log, 'ran again\n'); return 7; } });
  assert.deepEqual(again, { ok: true, value: 42 });
  assert.equal(readFileSync(log, 'utf8'), 'ran\n');
  assert.equal(queue.result('missing'), null);
});

test('store.io-write-queue-file.a-failed-write-stores-its-error: clause 3: a failed write stores its error in its own result file and the writes behind it still apply [C7,#8163]', async () => {
  const dir = privateFixtureFiles('pullboard-wqf-').root;
  const queue = createFileWriteQueue(dir);
  const order = [];
  const first = queue.submit({ id: 'f1', run: () => { order.push('f1'); return 'one'; } });
  const bad = queue.submit({ id: 'f2', run: () => { order.push('f2'); throw Object.assign(new Error('boom'), { code: 'BOOM' }); } });
  const last = queue.submit({ id: 'f3', run: () => { order.push('f3'); return 'three'; } });
  assert.deepEqual(await first, { ok: true, value: 'one' });
  assert.deepEqual(await bad, { ok: false, error: { code: 'BOOM', message: 'boom' } });
  assert.deepEqual(await last, { ok: true, value: 'three' });
  assert.deepEqual(order, ['f1', 'f2', 'f3']);
  assert.ok(existsSync(join(dir, 'f2.result')));
  assert.deepEqual(queue.result('f2'), { ok: false, error: { code: 'BOOM', message: 'boom' } });
});

test('store.io-write-queue-file.prune-removes-results-and-marks-older: clause 4: prune removes results and marks older than the keep time and never a pending write [C7,#10089]', () => {
  const { root } = privateFixtureFiles('pullboard-wqf-prune-');
  const queue = createFileWriteQueue(root);
  const names = ['old.result', 'old.mark', 'old.pending', 'new.result'];
  for (const name of names) writeFileSync(join(root, name), '{}');
  const past = new Date(Date.now() - 5000);
  for (const name of names.slice(0, 3)) utimesSync(join(root, name), past, past);
  assert.equal(queue.prune(1000), 2);
  assert.deepEqual([existsSync(join(root, 'old.result')), existsSync(join(root, 'old.mark')), existsSync(join(root, 'old.pending')), existsSync(join(root, 'new.result'))], [false, false, true, true]);
  writeFileSync(join(root, 'again.result'), '{}');
  queue.forget('again');
  assert.equal(existsSync(join(root, 'again.result')), false, 'forget drops one stored outcome');
});

/** Transaction and savepoint ports over one sqlite connection, counting how many transactions committed. */
function sqlitePorts(db, counts) {
  let depth = 0;
  return {
    transaction: work => {
      db.exec('BEGIN');
      counts.transactions += 1;
      try { const value = work(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    savepoint: work => {
      const name = `sp${depth++}`;
      db.exec(`SAVEPOINT ${name}`);
      try { const value = work(); db.exec(`RELEASE ${name}`); return value; } catch (error) { db.exec(`ROLLBACK TO ${name}`); db.exec(`RELEASE ${name}`); throw error; } finally { depth -= 1; }
    },
  };
}

test('store.io-write-queue-file.with-transaction-ports-every-queued-write: clause 5: with transaction ports every queued write applies in queue order inside one transaction, and a refused write rolls back only itself [C7,#10798]', async () => {
  const dir = privateFixtureFiles('pullboard-wqf-group-').root;
  const db = new DatabaseSync(join(dir, 'board.sqlite'));
  db.exec('CREATE TABLE events (name TEXT)');
  const counts = { transactions: 0 };
  const queue = createFileWriteQueue(join(dir, 'queue'), sqlitePorts(db, counts));
  const write = (name, fail) => () => {
    db.prepare('INSERT INTO events (name) VALUES (?)').run(name);
    if (fail) throw Object.assign(new Error('refused'), { code: 'REFUSED' });
    return name;
  };
  const results = await Promise.all([
    queue.submit({ id: 'g1', run: write('g1') }),
    queue.submit({ id: 'g2', run: write('g2') }),
    queue.submit({ id: 'g3', run: write('g3', true) }),
    queue.submit({ id: 'g4', run: write('g4') }),
    queue.submit({ id: 'g5', run: write('g5') }),
  ]);
  assert.deepEqual(results.map(result => result.ok), [true, true, false, true, true]);
  assert.deepEqual(results[2].error, { code: 'REFUSED', message: 'refused' });
  assert.equal(counts.transactions, 1, 'five writes queued in one turn share one transaction');
  assert.deepEqual(db.prepare('SELECT name FROM events ORDER BY rowid').all().map(row => row.name), ['g1', 'g2', 'g4', 'g5']);
  assert.deepEqual(queue.result('g3'), { ok: false, error: { code: 'REFUSED', message: 'refused' } });
  db.close();
});

const CLAIMER = `
import { DatabaseSync } from 'node:sqlite';
const [dir, file, name, module] = process.argv.slice(1);
const { createFileWriteQueue } = await import(module);
const db = new DatabaseSync(file);
db.exec('PRAGMA busy_timeout = 5000');
const ports = {
  transaction: work => { db.exec('BEGIN'); try { const value = work(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } },
  savepoint: work => { db.exec('SAVEPOINT w'); try { const value = work(); db.exec('RELEASE w'); return value; } catch (error) { db.exec('ROLLBACK TO w'); db.exec('RELEASE w'); throw error; } },
};
const queue = createFileWriteQueue(dir, ports);
const claims = [];
for (let n = 0; n < 10; n++) {
  claims.push(queue.submit({ id: name + n, run: seq => { db.prepare('INSERT INTO events (seq, claim) VALUES (?, ?)').run(seq, name + n); return seq; } }));
}
await Promise.all(claims);
db.close();
`;

test('store.io-write-queue-file.fifty-claims-from-separate-processes-reach: clause 6: 50 claims queued from five separate processes reach the board in queue order, one event each [C7,#10798]', async () => {
  const dir = privateFixtureFiles('pullboard-wqf-claims-').root;
  const file = join(dir, 'board.sqlite');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE events (seq INTEGER, claim TEXT)');
  db.close();
  const codes = await Promise.all(['a', 'b', 'c', 'd', 'e'].map(name => child(CLAIMER, join(dir, 'queue'), file, name, MODULE)));
  assert.deepEqual(codes, [0, 0, 0, 0, 0]);
  const reader = new DatabaseSync(file);
  const rows = reader.prepare('SELECT seq, claim FROM events ORDER BY rowid').all();
  reader.close();
  assert.equal(rows.length, 50);
  assert.equal(new Set(rows.map(row => row.claim)).size, 50, 'every claim landed once');
  assert.deepEqual(rows.map(row => row.seq), rows.map(row => row.seq).slice().sort((a, b) => a - b), 'board event order equals queue order');
});

test('store.io-write-queue-file.scan-skips-stored-results: clause 1: a drain beside 500 stored results still applies three new writes in queue order and leaves no pending record [C7]', async () => {
  const dir = privateFixtureFiles('pullboard-wqf-scan-').root;
  for (let n = 0; n < 500; n++) writeFileSync(join(dir, `old${n}.result`), JSON.stringify({ ok: true, value: n }));
  const queue = createFileWriteQueue(dir);
  const order = [];
  const results = await Promise.all(['a', 'b', 'c'].map(id => queue.submit({ id, run: () => { order.push(id); return id; } })));
  assert.deepEqual(order, ['a', 'b', 'c'], 'the three writes applied in queue order');
  assert.deepEqual(results.map(result => result.value), ['a', 'b', 'c']);
  assert.deepEqual(readdirSync(join(dir, 'pending')), [], 'no pending record is left');
  assert.equal(readdirSync(dir).filter(name => name.endsWith('.pending')).length, 0, 'pending records never sit among the stored results');
});

test('store.io-write-queue-file.a-write-published-beside-a-far-ahead-record-takes-a-higher-number: clause 2: a write published while another record with a far-ahead sequence number is visible takes a sequence number above it [C7,#11021]', async () => {
  const dir = privateFixtureFiles('pullboard-wqf-').root;
  const far = (Date.now() + 3_600_000) * 1000;
  const queue = createFileWriteQueue(dir);
  writeFileSync(join(dir, 'pending', 'far.pending'), JSON.stringify({ seq: far, pid: 2_147_483_646 }));
  let taken = 0;
  const outcome = await queue.submit({ id: 'late', run: seq => { taken = seq; return seq; } });
  assert.equal(outcome.ok, true);
  assert.ok(taken > far, `the late write took ${taken}, not above the visible ${far}`);
});

test('store.io-write-queue-file.publish-order-with-three-hundred-pending: clause 1: with 300 writes already pending in one queue directory, each newly published write takes a sequence number above every visible record and the 300 writes apply in publish order [C7]', async () => {
  const dir = privateFixtureFiles('pullboard-wqf-pub-').root;
  const base = Date.now() * 1000;
  mkdirSync(join(dir, 'pending'), { recursive: true });
  for (let n = 0; n < 300; n++) writeFileSync(join(dir, 'pending', `seed${String(n).padStart(3, '0')}.pending`), JSON.stringify({ seq: base + 3_600_000_000 + n, pid: 2_147_483_646 }));
  const highestSeeded = base + 3_600_000_000 + 299;
  const timing = {};
  const queue = createFileWriteQueue(dir, { timing });
  const ids = Array.from({ length: 300 }, (_, n) => `p${String(n).padStart(3, '0')}`);
  const applied = [];
  const results = [];
  for (const id of ids) results.push(queue.submit({ id, run: seq => { applied.push({ id, seq }); return seq; } }));
  const settled = await Promise.all(results);
  assert.ok(settled.every(outcome => outcome.ok), 'every write succeeded');
  assert.deepEqual(applied.map(entry => entry.id), ids, 'the 300 writes applied in publish order');
  assert.ok(applied.every(entry => entry.seq > highestSeeded), 'every new write took a number above every visible record');
  assert.ok(applied.every((entry, n) => n === 0 || entry.seq > applied[n - 1].seq), 'sequence numbers rise in publish order');
  console.log(`publish-order-with-three-hundred-pending: publish ${Math.round(timing.publish ?? 0)} ms, drain ${Math.round(timing.drain ?? 0)} ms, waiter-settle ${Math.round(timing.settle ?? 0)} ms`);
});

test('store.io-write-queue-file.two-hundred-waiters-in-order: clause 1: 200 writes submitted in one turn by one process, with transaction ports, each return their own stored result and apply in queue order [C7]', async () => {
  const dir = privateFixtureFiles('pullboard-wqf-many-').root;
  const db = new DatabaseSync(join(dir, 'board.sqlite'));
  db.exec('CREATE TABLE events (name TEXT)');
  const counts = { transactions: 0 };
  const queue = createFileWriteQueue(join(dir, 'queue'), sqlitePorts(db, counts));
  const ids = Array.from({ length: 200 }, (_, n) => `w${String(n).padStart(3, '0')}`);
  const results = await Promise.all(ids.map(id => queue.submit({ id, run: () => { db.prepare('INSERT INTO events (name) VALUES (?)').run(id); return id; } })));
  assert.deepEqual(results.map(result => result.value), ids, 'each waiter returns its own stored result');
  assert.deepEqual(db.prepare('SELECT name FROM events ORDER BY rowid').all().map(row => row.name), ids, 'the writes applied in queue order');
});
