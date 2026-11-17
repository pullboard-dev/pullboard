/** The batched process identity refresh runs off the event loop and caches exactly what the synchronous refresh does [C7,#3837]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { freshIdentity } from '../../../src/io/identities.js';
import { processIdentity } from '../../../src/io/identities.js';
import { refreshIdentitiesAsync } from '../../../src/io/identities.js';

test('resources.probe.a-ps-that-is-still-running: clause 1: a ps that is still running leaves the event loop free, so other callbacks keep running while it runs [C7]', async () => {
  let turns = 0, stopped = false;
  /** Another part of the process asking for the loop: it only advances while nothing blocks it. */
  const spin = () => { turns += 1; if (!stopped) setImmediate(spin); };
  setImmediate(spin);
  let turnsDuringPs = 0;
  // A ps standing in for the real one at load: it prints only after the loop has turned three times while it was pending.
  const read = async () => {
    while (turns < 3) await new Promise(resolve => setImmediate(resolve));
    turnsDuringPs = turns;
    return '';
  };
  try { await refreshIdentitiesAsync([process.pid + 100_000], { read }); }
  finally { stopped = true; }
  assert.ok(turnsDuringPs >= 3, 'the loop turned while ps was pending');
});

test('resources.probe.the-real-batched-ps-runs-as: clause 1: the real batched ps runs as a child process and caches an identity for a live process [C7]', async () => {
  await refreshIdentitiesAsync([process.pid]);
  const identity = processIdentity(process.pid);
  assert.equal(typeof identity?.started, 'string');
  assert.equal(identity.zombie, false);
});

test('resources.probe.the-asynchronously-cached-identity-equals-the: clause 2: the asynchronously cached identity equals the synchronous read for a live process, a live child and an exited process [C7]', async () => {
  await refreshIdentitiesAsync([process.pid]);
  assert.deepEqual(processIdentity(process.pid), freshIdentity(process.pid), 'this process');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    await once(child, 'spawn');
    await refreshIdentitiesAsync([child.pid]);
    assert.deepEqual(processIdentity(child.pid), freshIdentity(child.pid), 'a live child');
  } finally { child.kill(); await once(child, 'exit'); }
  // A process that exited before any read: the live child's read above stays current for the 3 s cache window, so a PID never cached is the exited case.
  const gone = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  await once(gone, 'exit');
  await refreshIdentitiesAsync([gone.pid, process.pid]);
  assert.deepEqual(processIdentity(gone.pid), freshIdentity(gone.pid), 'a process that has exited');
});
