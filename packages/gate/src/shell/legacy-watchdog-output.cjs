/** Observe native test worker output before Node buffers reporter events [C7,V10]. */
const { channel } = require('node:diagnostics_channel');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { DefaultSerializer } = require('node:v8');

/** Separate raw stdout from Node's length-framed test protocol, including split headers. */
function rawOutputObserver(notify) {
  const serializer = new DefaultSerializer();
  serializer.writeHeader();
  const header = serializer.releaseBuffer();
  let pending = Buffer.alloc(0);
  return chunk => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length) {
      const start = pending.indexOf(header);
      if (start < 0) {
        const tail = pending.at(-1) === header[0] ? 1 : 0;
        if (pending.length > tail) notify();
        pending = tail ? pending.subarray(-1) : Buffer.alloc(0);
        break;
      }
      if (start) { notify(); pending = pending.subarray(start); }
      if (pending.length < header.length + 4) break;
      const size = pending.readUInt32BE(header.length) + header.length + 4;
      if (pending.length < size) break;
      pending = pending.subarray(size);
    }
  };
}

/** Only the native test parent observes its own Node workers; each marker is keyed by worker PID. */
function observeLegacyWorkers(directory) {
  if (process.env.PULLBOARD_LEGACY_DEBUG) process.stderr.write(`legacy parent ${process.pid} ctx=${process.env.NODE_TEST_CONTEXT} args=${JSON.stringify(process.execArgv)} dir=${directory}\n`);
  if (!directory || process.env.NODE_TEST_CONTEXT === 'child-v8' || !process.execArgv.includes('--test')) return;
  channel('child_process').subscribe(({ process: child }) => {
    child.once('spawn', () => {
      if (process.env.PULLBOARD_LEGACY_DEBUG) process.stderr.write(`legacy spawn ${child.pid} args=${JSON.stringify(child.spawnargs)}\n`);
      if (child.spawnfile !== process.execPath || !Number.isSafeInteger(child.pid)
        || !/\.[cm]?js$/u.test(child.spawnargs?.at(-1) ?? '')) return;
      const marker = join(directory, String(child.pid));
      let last = 0;
      const output = () => {
        const now = Date.now();
        if (now - last < 250) return;
        last = now;
        if (process.env.PULLBOARD_LEGACY_DEBUG) process.stderr.write(`legacy output ${marker}\n`);
        try { writeFileSync(marker, ''); } catch { /* Supervision remains conservative when a marker cannot be written. */ }
      };
      child.stdout?.on('data', rawOutputObserver(output));
      child.stderr?.on('data', output);
    });
  });
}

observeLegacyWorkers(process.env.PULLBOARD_LEGACY_WATCHDOG_DIR);

module.exports = { rawOutputObserver, observeLegacyWorkers };
