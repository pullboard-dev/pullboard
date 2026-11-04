/** Drain actual direct children before a completed test worker exits, without guessing ownership from PIDs [C7]. */
import { channel } from 'node:diagnostics_channel';
import { appendFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export const DEFAULT_TEST_FILE_TIMEOUT_MS = 30_000;
export const TEST_CHILD_CLEANUP_FAILED = 'test-child-cleanup-unverified';

/** Read the per-file exit ceiling so a completed file cannot keep the gate open. */
export function testFileTimeoutMs(value = process.env.PULLBOARD_TEST_FILE_TIMEOUT_MS) {
  if (value === undefined) return DEFAULT_TEST_FILE_TIMEOUT_MS;
  if (!/^[1-9][0-9]*$/u.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 2_147_483_647) {
    throw new Error('PULLBOARD_TEST_FILE_TIMEOUT_MS must be a positive integer no greater than 2147483647 milliseconds');
  }
  return Number(value);
}

/** Describe listening ports and live handle types when the test-file exit ceiling expires. */
export function activeHandleSummary() {
  const handles = process._getActiveHandles();
  const ports = [];
  const types = [];
  for (const handle of handles) {
    const type = handle?.constructor?.name ?? 'Unknown';
    types.push(type);
    if (typeof handle?.address !== 'function' || !handle.listening) continue;
    try {
      const address = handle.address();
      if (address && typeof address === 'object' && typeof address.port === 'number') {
        ports.push(`${address.address}:${address.port}`);
      }
    } catch { /* A handle may close while its diagnostic is collected. */ }
  }
  return { ports: [...new Set(ports)].slice(0, 20), types: [...new Set(types)].slice(0, 20) };
}

/** Wait on real ChildProcess close events after all test hooks, within the existing file-cleanup ceiling. */
export function installTestChildDrain({ sandbox, timeoutMs, onStart = () => {}, onEnd = () => {}, write = text => process.stderr.write(text) }) {
  const live = new Set();
  let draining = false;
  let abandoned = false;
  const children = channel('child_process');
  const lifecycle = channel('pullboard:test-child-drain');
  /** Retain the actual child until its OS exit; a deferred IPC or pipe close cannot keep a dead writer pending. */
  function observe({ process: child }) {
    if (!child || typeof child.once !== 'function') return;
    let closed;
    const record = { child, closed: new Promise(resolve => { closed = resolve; }) };
    live.add(record);
    /** Release one exact child, including a spawn failure with no process to drain. */
    function finish() { live.delete(record); closed(); }
    child.once('exit', finish);
    child.once('close', finish);
    child.once('error', () => { if (!child.pid) finish(); });
  }
  children.subscribe(observe);
  process.once('exit', () => children.unsubscribe(observe));
  process.on('beforeExit', async () => {
    if (draining || abandoned || !live.size) return;
    draining = true;
    onStart();
    const owned = new Set();
    let timer;
    let complete = true;
    let marker;
    try {
      marker = join(sandbox, TEST_CHILD_CLEANUP_FAILED + '-' + randomUUID());
      appendFileSync(marker, 'owned child cleanup pending\n');
      const deadline = new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); });
      while (live.size) {
        const batch = [...live].filter(record => {
          if (typeof record.child.exitCode === 'number' || typeof record.child.signalCode === 'string') {
            live.delete(record);
            return false;
          }
          return true;
        });
        if (!batch.length) break;
        for (const record of batch) { owned.add(record); record.child.ref(); }
        lifecycle.publish({ phase: 'waiting', children: batch.length, pids: batch.map(record => record.child.pid) });
        complete = await Promise.race([Promise.all(batch.map(record => record.closed)).then(() => true), deadline]);
        if (!complete) break;
      }
      if (!complete) {
        abandoned = true;
        // Keep the directory for the ordinary sweep while an owned child might still recreate it.
        write(`run-tests: SANDBOX_CLEANUP_DEFERRED: owned test children did not exit (${[...live].map(record => `pid=${record.child.pid},exit=${record.child.exitCode},signal=${record.child.signalCode}`).join('; ')}); the test outcome stands\n`);
      } else rmSync(marker, { force: true });
    } catch (error) {
      abandoned = true;
      write(`run-tests: SANDBOX_CLEANUP_DEFERRED: child drain ${error.code ?? error.name}; the test outcome stands\n`);
    } finally {
      clearTimeout(timer);
      for (const { child } of owned) {
        child.unref();
        for (const stream of [child.stdin, child.stdout, child.stderr, child.channel]) stream?.unref?.();
      }
      draining = false;
      onEnd();
    }
  });
}
