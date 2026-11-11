/** A runner quarantine message names the waited process and its parent chain [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanupProcessText } from '../index.js';
import { cleanupTimeoutDetails } from '../index.js';
import { readCleanupTimeoutDetails } from '../index.js';

/** One scripted census row; only the parent link and executable name matter to the chain. */
function row(pid, ppid, command) {
  return [pid, { pid, ppid, command }];
}

test('the quarantine message names a process two levels below the job root and its parents [C7]', () => {
  const census = new Map([row(1, 0, '/sbin/launchd'), row(100, 1, '/usr/bin/node'), row(200, 100, '/bin/sh'), row(300, 200, '/usr/bin/sleep')]);
  const state = {
    workerId: 'chain-job', cleanupStage: 'descendants', ownedChildren: new Map(),
    cleanupDetails: () => ({ roots: [{ pid: 100, started: 'Mon Nov 2 01:00:00 2026', command: '/usr/bin/node' }],
      live: [{ pid: 300, started: 'Mon Nov 2 01:00:05 2026', command: '/usr/bin/sleep' }] }),
  };
  const details = cleanupTimeoutDetails(state, census);
  const waited = details.processes.find(process => process.pid === 300);
  assert.deepEqual(waited.parents, [{ pid: 200, command: '/bin/sh' }, { pid: 100, command: '/usr/bin/node' }], 'the chain stops at the job root');
  const received = readCleanupTimeoutDetails(Buffer.from(JSON.stringify(details)).toString('base64'), 'chain-job');
  assert.deepEqual(received, details, 'the chain survives the controller handshake');
  const message = cleanupProcessText(received);
  assert.match(message, /pid=300 command="\/usr\/bin\/sleep"[^;]*parents=\[pid=200 command="\/bin\/sh" <- pid=100 command="\/usr\/bin\/node"\]/u);
});

test('a chain without a job root ends at launchd, and an unreadable census leaves no parents [C7]', () => {
  const census = new Map([row(1, 0, '/sbin/launchd'), row(200, 1, '/bin/sh'), row(300, 200, '/usr/bin/sleep')]);
  const state = { workerId: 'orphan-job', cleanupStage: 'descendants', ownedChildren: new Map([[300, { pid: 300, command: '/usr/bin/sleep' }]]) };
  assert.deepEqual(cleanupTimeoutDetails(state, census).processes[0].parents,
    [{ pid: 200, command: '/bin/sh' }, { pid: 1, command: '/sbin/launchd' }]);
  assert.deepEqual(cleanupTimeoutDetails(state, null).processes[0].parents, []);
});
