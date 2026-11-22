import assert from 'node:assert/strict';
import { startFixtureChild as spawn } from '../../../fixtures/child.js';
import { once } from 'node:events';
import { chmodSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after } from 'node:test';
import { test } from 'node:test';
import { describe } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { oldSchema } from '../../../fixtures/admission/lease.js';
import { staleIdentity } from '../../../fixtures/admission/lease.js';
import { expireHeartbeat } from '../../../fixtures/admission/lease.js';
import { PERL_FORK } from '../../../fixtures/admission/pool.js';
import { acquired } from '../../../fixtures/admission/pool.js';
import { delay } from '../../../fixtures/admission/pool.js';
import { event } from '../../../fixtures/admission/pool.js';
import { fixture } from '../../../fixtures/admission/pool.js';
import { insertExpiredHolder } from '../../../fixtures/admission/pool.js';
import { memoryWorker } from '../../../fixtures/admission/pool.js';
import { privateList } from '../../../fixtures/admission/pool.js';
import { release } from '../../../fixtures/admission/pool.js';
import { waitForProcessState } from '../../../fixtures/admission/pool.js';
import { worker } from '../../../fixtures/admission/pool.js';
import { writeMemoryReading } from '../../../fixtures/admission/pool.js';
/** Real-process resource queue and lease coverage [Q1,Q2,Q3]. */
// Each process and memory case below also owns a distinct pool; no asynchronous parent environment override is shared.
describe('isolated resource process and memory scenarios [C7,Q1,Q2,Q3]', { concurrency: 4 }, () => {
test('gate.io-browser-admission-process.q1-q2-landing-priority-preserves-tickets: [Q1,Q2] landing priority preserves tickets while an older resource database migrates [Q1,Q2]', async () => {
  const box = fixture();
  oldSchema(box);
  const oldSince = new Date().toISOString();
  const db = new DatabaseSync(join(box.home, 'resources.sqlite'));
  try {
    db.prepare('INSERT INTO resource(name, capacity) VALUES (?, ?)').run('gate', 1);
    db.prepare('INSERT INTO holder(token, name, pid, agent, repo, since, heartbeat) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('old-holder', 'gate', process.pid, 'old-holder', realpathSync(box.first), oldSince, Date.now());
    for (const [ticket, agent] of [[4, 'old-first'], [9, 'old-second']]) {
      db.prepare('INSERT INTO waiter(ticket, token, name, pid, agent, repo, since, heartbeat) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(ticket, `old-${agent}`, 'gate', process.pid, agent, realpathSync(box.first), oldSince, Date.now());
    }
  } finally { db.close(); }

  let retainedLine;
  assert.doesNotThrow(() => { retainedLine = privateList(box)[0].line; }, 'the previous queue schema opens without losing its waiting runs');
  assert.deepEqual(retainedLine.map(({ agent, landing }) => [agent, landing]), [['old-first', false], ['old-second', false]]);
  const migrated = new DatabaseSync(join(box.home, 'resources.sqlite'));
  try {
    assert.deepEqual(migrated.prepare('SELECT ticket, landing FROM waiter ORDER BY ticket').all().map(({ ticket, landing }) => ({ ticket, landing })), [
      { ticket: 4, landing: 0 }, { ticket: 9, landing: 0 },
    ]);
  } finally { migrated.close(); }

  const landing = worker(box, { agent: 'new-landing', landing: true });
  assert.equal((await event(landing)).waiting, 1);
  assert.deepEqual(privateList(box)[0].line.map(({ agent, landing: isLanding }) => [agent, isLanding]), [
    ['new-landing', true], ['old-first', false], ['old-second', false],
  ]);
  const cleanup = new DatabaseSync(join(box.home, 'resources.sqlite'));
  try {
    cleanup.prepare('DELETE FROM waiter WHERE token IN (?, ?)').run('old-old-first', 'old-old-second');
    cleanup.prepare('DELETE FROM holder WHERE token = ?').run('old-holder');
  } finally { cleanup.close(); }
  assert.equal((await event(landing)).acquired, 'new-landing');
  await release(landing);
});

test('gate.io-browser-admission-process.q1-q2-capacity-two-admits-two: [Q1,Q2] capacity two admits two holders and serves the next waiter', async () => {
  const box = fixture();
  const first = worker(box, { name: 'two-slots', capacity: 2, agent: 'first-holder' });
  const second = worker(box, { name: 'two-slots', capacity: 2, agent: 'second-holder' });
  assert.equal((await acquired(first)).acquired, 'first-holder');
  assert.equal((await acquired(second)).acquired, 'second-holder');
  const next = worker(box, { name: 'two-slots', capacity: 2, agent: 'next-waiter' });
  assert.equal((await event(next)).waiting, 1);
  await release(first);
  assert.equal((await event(next)).acquired, 'next-waiter');
  await release(second);
  await release(next);
});

test('gate.io-browser-admission-process.q2-q3-a-stopped-head-waiter: [Q2,Q3] a stopped head waiter keeps its place ahead of the next process', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'holder' });
  assert.equal((await event(holder)).acquired, 'holder');
  const first = worker(box, { agent: 'stopped-first' });
  assert.equal((await event(first)).waiting, 1);
  first.kill('SIGSTOP');
  const second = worker(box, { agent: 'second' });
  assert.equal((await event(second)).waiting, 2);
  await release(holder);
  await assert.rejects(event(second, 800), /worker timed out/u, 'the second waiter cannot jump the stopped head'); // budget: declared negative observation window while the stopped queue head blocks this waiter.
  first.kill('SIGCONT');
  assert.equal((await event(first)).acquired, 'stopped-first');
  await release(first);
  assert.equal((await event(second)).acquired, 'second');
  await release(second);
});

test('gate.io-browser-admission-process.q2-q3-an-evicted-live-waiter: [Q2,Q3] an evicted live waiter rejoins the FIFO line after it resumes [Q2,Q3]', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'holder' });
  assert.equal((await event(holder)).acquired, 'holder');
  const waiter = worker(box, { agent: 'resumed-waiter' });
  assert.equal((await event(waiter)).waiting, 1);
  waiter.kill('SIGSTOP');
  staleIdentity(box, 'waiter', 'resumed-waiter');
  assert.deepEqual(privateList(box)[0].line, []);
  waiter.kill('SIGCONT');
  const rejoined = await event(waiter);
  assert.equal(rejoined.rejoined, true);
  assert.equal(rejoined.waiting, 1);
  await release(holder);
  assert.equal((await event(waiter)).acquired, 'resumed-waiter');
  await release(waiter);
});

test('gate.io-browser-admission-process.q3-concurrent-openers-serialize-migration-of: [Q3] concurrent openers serialize migration of a prior resource database', async () => {
  const box = fixture();
  oldSchema(box);
  const workers = Array.from({ length: 8 }, (_, index) => worker(box, { name: 'legacy', capacity: 8, agent: `migrator-${index}` }));
  const grants = await Promise.all(workers.map((child) => acquired(child)));
  assert.deepEqual(grants.map(({ acquired: agent }) => agent).sort(), workers.map((_, index) => `migrator-${index}`).sort());
  await Promise.all(workers.map(release));
});

test('gate.io-browser-admission-process.q3-a-held-lease-records-its: [Q3] a held lease records its OS process start identity', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'identity-recorded' });
  assert.equal((await acquired(holder)).acquired, 'identity-recorded');
  const db = new DatabaseSync(join(box.home, 'resources.sqlite'));
  try {
    const row = db.prepare('SELECT started FROM holder WHERE agent = ?').get('identity-recorded');
    assert.ok(row?.started, 'a readable process identity is stored with its lease');
  } finally { db.close(); }
  await release(holder);
});

test('gate.io-browser-admission-process.q3-process-identity-lookup-ignores-a: [Q3] process identity lookup ignores a misleading ps on PATH', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'path-spoof-holder' });
  assert.equal((await acquired(holder)).acquired, 'path-spoof-holder');
  expireHeartbeat(box, 'holder', 'path-spoof-holder');
  const fakeBin = join(box.dir, 'fake-bin');
  mkdirSync(fakeBin);
  const fakePs = join(fakeBin, 'ps');
  writeFileSync(fakePs, '#!/bin/sh\nprintf "Mon Jan 1 00:00:00 2001 S\\n"\n');
  chmodSync(fakePs, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = fakeBin;
  try {
    assert.equal(privateList(box)[0].holders[0]?.agent, 'path-spoof-holder', 'the stable absolute ps result keeps the lease');
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
  await release(holder);
});

test('gate.io-browser-admission-process.q3-cached-live-identities-expire-so: [Q3] cached live identities expire so an actual zombie holder is released', { skip: !PERL_FORK }, async () => {
  const box = fixture();
  privateList(box);
  const script = 'my $pid = fork(); die "fork failed" unless defined $pid; if ($pid == 0) { select undef, undef, undef, 1.2; exit 0; } print "$pid\\n"; $| = 1; select undef, undef, undef, 30; waitpid($pid, 0);';
  const reaper = spawn('/usr/bin/perl', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = createInterface({ input: reaper.stdout });
  try {
    const pidText = await new Promise((resolveLine, reject) => {
      lines.once('line', resolveLine);
      reaper.once('error', reject);
      reaper.once('exit', (code) => reject(new Error(`zombie parent exited early: ${code}`)));
    });
    const pid = Number(pidText);
    assert.ok(Number.isInteger(pid) && pid > 0, `Perl reports its child PID: ${pidText}`);
    insertExpiredHolder(box, { name: 'zombie-cache', pid, agent: 'zombie-holder' });
    const cached = privateList(box).find(({ name }) => name === 'zombie-cache');
    assert.equal(cached.holders[0]?.agent, 'zombie-holder', 'the live child with an empty stored identity is kept');
    const cacheAt = Date.now();
    await waitForProcessState(pid, 'Z');
    await delay(Math.max(0, cacheAt + 3_200 - Date.now()));
    const afterExpiry = privateList(box).find(({ name }) => name === 'zombie-cache');
    assert.deepEqual(afterExpiry.holders, [], 'the refreshed process state identifies and releases the zombie');
  } finally {
    lines.close();
    if (reaper.exitCode === null && reaper.signalCode === null) {
      reaper.kill('SIGKILL');
      await once(reaper, 'exit');
    }
  }
});

test('gate.io-browser-admission-process.q3-renew-refuses-after-an-os: [Q3] renew refuses after an OS start-identity mismatch evicts the holder', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'evicted-holder' });
  assert.equal((await event(holder)).acquired, 'evicted-holder');
  staleIdentity(box, 'holder', 'evicted-holder');
  assert.deepEqual(privateList(box)[0].holders, []);
  holder.stdin.write('renew\n');
  assert.equal((await event(holder)).renewError, 'RESOURCE_LEASE_LOST');
  holder.stdin.end('release\n');
  assert.equal((await holder.finished).code, 0, holder.errors);
});

test('gate.io-browser-admission-process.q3-sigkill-of-a-holder-frees: [Q3] SIGKILL of a holder frees its lease for the next process', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'doomed-holder' });
  assert.equal((await event(holder)).acquired, 'doomed-holder');
  const next = worker(box, { agent: 'successor' });
  const waiting = await event(next);
  assert.equal(waiting.waiting, 1);
  holder.kill('SIGKILL');
  await holder.finished;
  assert.equal((await event(next)).acquired, 'successor');
  await release(next);
});

test('gate.io-browser-admission-process.q2-q3-a-sigkilled-waiter-is: [Q2,Q3] a SIGKILLed waiter is skipped while the next live waiter advances', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'holder' });
  assert.equal((await event(holder)).acquired, 'holder');
  const dead = worker(box, { agent: 'dead-waiter' });
  assert.equal((await event(dead)).waiting, 1);
  const live = worker(box, { agent: 'live-waiter' });
  assert.equal((await event(live)).waiting, 2);
  dead.kill('SIGKILL');
  await dead.finished;
  await release(holder);
  assert.equal((await event(live)).acquired, 'live-waiter');
  await release(live);
});


test('gate.io-browser-admission-process.the-pool-holds-work-while-the: the pool holds work while the machine is out of memory and names the biggest process [C7]', async () => {
  const box = fixture();
  const reading = join(box.dir, 'memory.json');
  writeMemoryReading(reading, { availableMB: 100, fullAvg10: 99, someAvg10: 99 });
  // Off by default: with no floor set, even a critical machine is never read or held.
  const unset = memoryWorker(box, 'no-floor-run', reading);
  const unsetStart = await event(unset);
  assert.equal(unsetStart.acquired, 'no-floor-run', `with no floor set the pool admits by slots alone: ${JSON.stringify(unsetStart)}`);
  assert.equal(unsetStart.reads, 0, 'with no floor set the pool reads no memory');
  assert.equal(unsetStart.memory, undefined, 'with no floor set nothing is held or reported');
  await release(unset);

  mkdirSync(box.home, { recursive: true });
  writeFileSync(join(box.home, 'settings.json'), `${JSON.stringify({ gate: { memoryFloorMB: 512 } })}\n`);
  const biggest = 'biggest: pid 4242 python3 24.0 GB in /work/journal-reader; pid 4343 python3.12 23.0 GB in /work/other-reader; pid 5151 node 2.0 GB in /work/pullboard';
  writeMemoryReading(reading, { availableMB: 8192, fullAvg10: 42, someAvg10: 80 });
  const run = memoryWorker(box, 'held-run', reading);

  const critical = await event(run);
  assert.equal(critical.acquired, undefined, 'a critical reading must not admit the run');
  assert.equal(critical.waiting, 1, 'the held run keeps its place at the head of the line');
  assert.equal(critical.memory?.held, true, `the run is held for memory: ${JSON.stringify(critical)}`);
  assert.equal(critical.memory.line,
    `memory: holding local gate runs because pressure is critical: pressure critical, 8.0 GB free of 36.0 GB (floor 512 MB); ${biggest}`,
    'one line says why and names the three biggest processes with pid, size and working directory');
  assert.doesNotMatch(critical.memory.line, /\n/u, 'the hold is one line');
  const gate = privateList(box).find(({ name }) => name === 'gate');
  assert.equal(gate.holders.length, 0, 'no run holds a slot while memory is critical, though both slots are free');
  assert.deepEqual(gate.line.map(({ agent }) => agent), ['held-run'], 'the held run waits in the queue');
  await delay(300);
  assert.ok(!run.pendingLines.some((line) => JSON.parse(line).acquired), 'the run stays held while the reading stays critical');

  writeMemoryReading(reading, { availableMB: 400 });
  const low = await event(run);
  assert.equal(low.memory?.held, true, `free memory under the settings floor still holds: ${JSON.stringify(low)}`);
  assert.equal(low.memory.line,
    `memory: holding local gate runs because free memory is under the floor: pressure normal, 400 MB free of 36.0 GB (floor 512 MB); ${biggest}`,
    'the floor comes from gate.memoryFloorMB in pullboard settings');

  writeMemoryReading(reading, { availableMB: 8192 });
  const recovered = await acquired(run).catch((error) => assert.fail(`the held run is admitted once memory recovers: ${error.message.split('\n')[0]}`));
  assert.equal(recovered.acquired, 'held-run', 'the held run is admitted once memory recovers');
  await release(run);
});


});
