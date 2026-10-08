/** Collect private command output through pipes; dependency files are never size-limited [V18,V2]. */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const { command, timeout, pidFile } = JSON.parse(readFileSync(0, 'utf8'));
const LIMIT = 8 * 1024 * 1024;
const HALF = LIMIT / 2;
let head = Buffer.alloc(0);
let tail = Buffer.alloc(0);
let bytes = 0;
let timedOut = false;
let error = null;

/** Drain every byte while retaining only the beginning and end of the combined output. */
function capture(chunk) {
  bytes += chunk.length;
  const take = Math.min(chunk.length, HALF - head.length);
  if (take) head = Buffer.concat([head, chunk.subarray(0, take)]);
  const rest = chunk.subarray(take);
  if (rest.length) tail = Buffer.concat([tail, rest]).subarray(-HALF);
}

const child = spawn('sh', ['-c', `(\n${command}\n) 2>&1`], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
if (child.pid) writeFileSync(pidFile, String(child.pid), { mode: 0o600 });

/** Stop the command's entire process group, including background descendants that retain pipes. */
function stop() {
  if (child.pid) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* The group has already exited. */ }
  }
}

const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
child.stdout.on('data', capture);
child.stderr.on('data', capture);
child.once('error', cause => { error = { code: cause.code ?? 'CHECK_RUNNER' }; });
child.once('exit', stop);
child.once('close', (status, signal) => {
  clearTimeout(timer);
  stop();
  const marker = bytes > LIMIT ? '\n[output capped at 8 MiB; middle omitted]\n' : '';
  const output = head.toString('utf8') + marker + tail.toString('utf8');
  process.stdout.write(JSON.stringify({ status, signal, error: timedOut ? { code: 'ETIMEDOUT' } : error, output }));
});
