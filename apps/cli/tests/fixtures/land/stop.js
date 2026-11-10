/** Exercise real landing-stop decisions against controlled observations and a private live child [Q1,Q3,C7]. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { stop } from '../../../../../packages/landing/index.js';
import { parseProcessCensus } from '../../../../../packages/kernel/light.js';
import { startFixtureChild } from '../child.js';

const GROUP = 41001;

/** One observer row; these synthetic PIDs are never passed to a real signal function. */
function row(pid, changes = {}) {
  return { pid, ppid: GROUP, pgid: GROUP, started: 'Fri Oct 23 16:00:00 2026',
    processSha256: 'a'.repeat(64), state: 'S', ...changes };
}

/** A process census with the same indexed shape as the real ps observer. */
function censusRows(...rows) { return new Map(rows.map(entry => [entry.pid, entry])); }

/** Model the guardian-dead fallback with a previously recorded member; every signal goes only to an observer. */
function observedStop(finalRows) {
  const member = row(GROUP + 1, { ppid: 1 });
  const original = censusRows(member, row(GROUP + 2, { ppid: member.pid }));
  const snapshots = [original, original, finalRows];
  const signals = [];
  const logs = [];
  stop({ pid: GROUP, exitCode: 0, signalCode: null }, member, {
    read: () => { assert.ok(snapshots.length, 'the stop never invents another observation'); return snapshots.shift(); },
    kill: (pid, signal) => signals.push([pid, signal]),
    log: text => logs.push(text),
  });
  assert.equal(snapshots.length, 0);
  return { signals, logs };
}

/** Missing original identity evidence never licenses a broadcast; a retained process lifetime still attributes the group. */
export async function assertLandingStopIdentity() {
  const unattributed = row(GROUP, { ppid: 1, started: 'Fri Oct 23 16:01:00 2026', processSha256: 'b'.repeat(64) });
  const outcomes = [
    observedStop(censusRows(unattributed)),
    observedStop(censusRows(unattributed, row(GROUP + 1, { started: unattributed.started }))),
    observedStop(censusRows(unattributed, row(GROUP + 1, { processSha256: unattributed.processSha256 }))),
    observedStop(censusRows(unattributed, row(GROUP + 1, { pgid: GROUP + 10 }))),
    observedStop(null),
  ];
  for (const outcome of outcomes) {
    assert.deepEqual(outcome.signals, [[GROUP + 1, 'SIGKILL'], [GROUP + 2, 'SIGKILL']], 'a group with no original identity witness receives no negative-PGID signal');
    assert.match(outcome.logs.join('\n'), /skipp.*(?:identity|census|witness)/iu, 'the missing attribution is explained, not claimed drained or proven reused');
  }
  for (const witness of [row(GROUP + 1, { ppid: 91 }), row(GROUP + 1, { state: 'Z' })]) {
    const original = observedStop(censusRows(unattributed, witness));
    assert.deepEqual(original.signals, [[GROUP + 1, 'SIGKILL'], [GROUP + 2, 'SIGKILL'], [-GROUP, 'SIGKILL']],
      'a recorded original identity remains a reservation witness despite reparenting or becoming a zombie');
    assert.deepEqual(original.logs, []);
  }
  await stopPrivateChild();
}

/** A fresh, handshaken detached child proves the real observer and real signal path still clean up owned work. */
async function stopPrivateChild() {
  const child = startFixtureChild(process.execPath, ['-e', "process.send('ready'); setInterval(() => {}, 1000);"], {
    detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  // budget: private cleanup must finish within ten seconds, including the ready handshake.
  const deadline = AbortSignal.timeout(10_000);
  const closed = once(child, 'close', { signal: deadline });
  void closed.catch(() => { /* The ready await reports a spawn error before close is awaited. */ });
  try {
    const [message] = await once(child, 'message', { signal: deadline });
    assert.equal(message, 'ready');
    stop(child, undefined, { parseProcessCensus });
    const [, signal] = await closed;
    assert.equal(signal, 'SIGKILL', 'the real owned process group is stopped');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const cleanup = once(child, 'close');
      child.kill('SIGKILL');
      await cleanup;
    }
  }
}
