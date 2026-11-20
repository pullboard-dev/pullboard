/** Process-identity queue cases split from resources.test.js: a stalled or unreadable-identity holder keeps its place, a dead one is released [Q3]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SANDBOX_EXEC } from '../../../fixtures/admission/pool.js';
import { acquired } from '../../../fixtures/admission/pool.js';
import { event } from '../../../fixtures/admission/pool.js';
import { fixture } from '../../../fixtures/admission/pool.js';
import { release } from '../../../fixtures/admission/pool.js';
import { worker } from '../../../fixtures/admission/pool.js';

test('gate.io-browser-admission-resources.q3-a-live-stalled-holder-keeps: [Q3] a live stalled holder keeps its place beyond the lease timeout', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'stalled-holder', stallMs: 22_000, env: { TZ: 'UTC' } });
  assert.equal((await event(holder)).acquired, 'stalled-holder');
  const waiter = worker(box, { agent: 'queued-behind-live-holder', env: { TZ: 'Pacific/Honolulu', PATH: '/usr/bin' } });
  assert.equal((await event(waiter)).waiting, 1);
  await assert.rejects(event(waiter, 20_500), /worker timed out/u, 'a live OS process must not be evicted when its heartbeat pauses'); // budget: declared 22000ms holder stall; observe it still held at 20500ms.
  assert.equal((await event(holder, 5_000)).resumed, true); // budget: hang ceiling for the stalled holder resume handshake; no throughput claim.
  await release(holder);
  assert.equal((await event(waiter)).acquired, 'queued-behind-live-holder');
  await release(waiter);
});

test('gate.io-browser-admission-resources.q3-an-unreadable-process-identity-keeps: [Q3] an unreadable process identity keeps a live holder', { skip: !SANDBOX_EXEC }, async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'sandbox-live-holder', stallMs: 27_000 });
  assert.equal((await acquired(holder)).acquired, 'sandbox-live-holder');
  const waiter = worker(box, { agent: 'sandbox-live-waiter', sandboxProcessInfo: true });
  assert.equal((await event(waiter)).waiting, 1);
  await assert.rejects(event(waiter, 20_500), /worker timed out/u, 'denied process-info access is not proof that a live PID died'); // budget: declared 22000ms holder stall with denied process-info access; observe at 20500ms.
  assert.equal((await event(holder, 8_000)).resumed, true); // budget: hang ceiling for the stalled holder resume handshake; no throughput claim.
  await release(holder);
  assert.equal((await acquired(waiter)).acquired, 'sandbox-live-waiter');
  await release(waiter);
});

test('gate.io-browser-admission-resources.q3-an-unreadable-process-identity-still: [Q3] an unreadable process identity still releases a dead holder', { skip: !SANDBOX_EXEC }, async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'sandbox-dead-holder' });
  assert.equal((await acquired(holder)).acquired, 'sandbox-dead-holder');
  holder.kill('SIGKILL');
  const { signal } = await holder.finished;
  holder.lines.close();
  assert.equal(signal, 'SIGKILL');
  const waiter = worker(box, { agent: 'sandbox-dead-waiter', sandboxProcessInfo: true });
  assert.equal((await acquired(waiter)).acquired, 'sandbox-dead-waiter');
  await release(waiter);
});
