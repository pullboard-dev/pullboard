/** The watchdog worker's program text: a stuck test or test file is killed with a diagnostic from outside its event loop. */
export const watchdogSource = `
const { parentPort } = require('node:worker_threads');
const { writeSync } = require('node:fs');
const timers = new Map();
const finished = [];
parentPort.on('message', (message) => {
  if (message.type === 'stop') {
    const active = timers.get(message.id);
    if (active) {
      clearTimeout(active.timer);
      if (active.probe) clearTimeout(active.probe);
      if (active.name !== undefined) finished.push({ name: active.name, ms: Date.now() - active.startedAt });
    }
    timers.delete(message.id);
    return;
  }
  if (message.type === 'file-diagnostic-update') {
    const active = timers.get(message.id);
    if (active) {
      active.handles = message.handles;
      active.observedAt = message.observedAt;
      active.updated = true;
    }
    return;
  }
  if (message.type === 'start-file') {
    const active = { handles: message.handles, observedAt: Date.now(), updated: false, timer: null, probe: null };
    active.probe = setTimeout(() => {
      parentPort.postMessage({ type: 'file-diagnostic-request', id: message.id });
    }, Math.max(0, message.timeoutMs - 50));
    active.timer = setTimeout(() => {
      const ports = active.handles.ports.length ? active.handles.ports.join(', ') : 'none';
      const handles = active.handles.types.length ? active.handles.types.join(', ') : 'none';
      const ageMs = Date.now() - active.observedAt;
      const freshness = active.updated ? 'latest responsive snapshot' : 'fallback; main thread did not answer';
      writeSync(2, 'run-tests: test file "' + message.file + '" failed: its process did not exit within ' +
        message.timeoutMs + 'ms file-exit timeout; listening ports: ' + ports + '; live handles: ' + handles +
        '; live-handle snapshot age: ' + ageMs + 'ms (' + freshness + ')\\n');
      try { process.kill(message.pid, 'SIGKILL'); } catch { /* The timed-out test-file process already exited. */ }
    }, message.timeoutMs);
    timers.set(message.id, active);
    return;
  }
  if (message.type !== 'start') return;
  const startedAt = Date.now();
  const timer = setTimeout(() => {
    const elapsedMs = Date.now() - startedAt;
    writeSync(2, 'run-tests: test "' + message.name + '" in ' + message.file +
      ' failed: it ran ' + (elapsedMs / 1000).toFixed(1) + 's, past the ' +
      message.timeoutMs + 'ms per-test timeout; finished cases ' + JSON.stringify(finished) + '\\n');
    try { process.kill(message.pid, 'SIGKILL'); } catch { /* The timed-out test process already exited. */ }
  }, message.timeoutMs);
  timers.set(message.id, { timer, name: message.name, startedAt });
});
`;
