/** Run a bounded shell under identity-checked process custody before returning its result [E27]. */
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  dirname,
  join,
} from 'node:path';
import { createDescendantTracker } from './runner-custody.js';
import { testRuntimeOption } from './execution-environment.js';

const request = JSON.parse(readFileSync(0, 'utf8'));
if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 2_147_483_647) throw new Error('invalid shell timeout');
// A spool that cannot be created must refuse before there is any command to stop.
writeFileSync(request.outputFile, '', { mode: 0o600, flag: 'wx' });
const directory = mkdtempSync(join(tmpdir(), 'pullboard-timed-shell-'));
let tracker;
let phase = 'starting';
let lastState = 0;
const stateFile = join(dirname(request.outputFile), 'cleanup-state.json');
/** Persist the current custody reason so an unresolved drain remains inspectable without weakening it. */
function reportState(force = false) {
  if (!force && Date.now() - lastState < 1_000) return;
  lastState = Date.now();
  try { writeFileSync(stateFile, JSON.stringify({ at: new Date().toISOString(), phase, ...(tracker?.cleanupState() ?? {}) }) + '\n', { mode: 0o600 }); }
  catch { process.stderr.write('timed gate: cleanup state could not be written; retain the worker and inspect its private output directory\n'); }
}
tracker = createDescendantTracker(directory, { tick: () => reportState(), warn: () => reportState(true) });
const recorder = testRuntimeOption();
const env = { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, tracker.nodeOptions, recorder].filter(Boolean).join(' '), PULLBOARD_RUNNER_PRELOAD: tracker.nodeOptions };
const child = spawn('/bin/sh', ['-c', request.command], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
tracker.registerRoot(child.pid);
tracker.observe();
reportState(true);
let timedOut = false;
let overflow = false;
let error = null;
let bytes = 0;
let stopping;
const closed = new Promise(resolveClose => {
  child.once('error', cause => { error = cause.message; resolveClose({ status: null, signal: null }); });
  child.once('close', (status, signal) => resolveClose({ status, signal }));
});

/** Drain only currently proven descendants and root groups; ambiguity keeps custody rather than freeing a lease. */
function stop() {
  stopping ??= (async () => {
    phase = 'descendants'; reportState(true);
    await tracker.stopDescendants();
    phase = 'root group'; reportState(true);
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      const deadline = Date.now() + 2_000;
      for (;;) {
        const sent = tracker.signalOwnedGroup(child.pid, signal);
        if (sent === false) break;
        if (sent === true && Date.now() >= deadline) break;
        await new Promise(resolvePause => setTimeout(resolvePause, 50));
      }
    }
    await closed;
    phase = 'verification'; reportState(true);
    await tracker.verifyAfterGroups();
    phase = 'drained'; reportState(true);
  })();
  return stopping;
}

/** Retain the gate's merged output within its existing one-GiB bound. */
function capture(chunk) {
  bytes += chunk.length;
  if (bytes > 2 ** 30) { overflow = true; void stop(); }
  else if (!error) {
    try { appendFileSync(request.outputFile, chunk); }
    catch (cause) { error = cause.code ?? 'TIMED_OUTPUT_WRITE'; void stop(); }
  }
}
child.stdout.on('data', capture);
child.stderr.on('data', capture);
child.once('exit', () => { void stop(); });
const timer = setTimeout(() => { timedOut = true; void stop(); }, request.timeoutMs);
process.on('SIGTERM', () => { timedOut = true; void stop(); });
process.on('SIGHUP', () => { timedOut = true; void stop(); });
const result = await closed;
clearTimeout(timer);
await stop();
tracker.stopMonitoring();
rmSync(directory, { recursive: true, force: true });
process.stdout.write(JSON.stringify({ ...result, timedOut, overflow, error }));
