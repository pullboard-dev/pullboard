/** Compile cell-analysis source only; no module linking or evaluation is permitted [C7,P3]. */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { fileSystemAdapter } from '../../../../../fs/index.js';
import vm from 'node:vm';

const fs = fileSystemAdapter();

const [directory, parentText, mode, sequenceText, budgetText] = process.argv.slice(2);
const parent = Number(parentText), MAX_BYTES = 2 ** 26;
// Bound retained V8 module records by source volume and count, then retire the entire compiler isolate.
const SOURCE_BUDGET = 4 * 1024 * 1024, MODULE_BUDGET = 128;
// Keep each supervisor's recorded child-spawn journal comfortably below its bounded runner limit.
// A caller may pass a smaller budget so a test reaches the rotation in a few batches; the default is the production bound.
const SUPERVISOR_BUDGET = Math.min(256, Number.isSafeInteger(Number(budgetText)) && Number(budgetText) > 0 ? Number(budgetText) : 256);
let sequence = Number(sequenceText ?? 0), watcher = null, timer = null, sourceBytes = 0, modules = 0;

/** End this owned worker when its parent or transport disappears. */
function stop() { watcher?.close(); if (timer) clearInterval(timer); process.exit(1); }

/** Return V8's existing compilation and import observations without executing candidate code. */
function compile(source) {
  try {
    const module = new vm.SourceTextModule(source);
    return { compiles: true, imports: module.moduleRequests
      ? module.moduleRequests.map(request => request.specifier) : module.dependencySpecifiers };
  } catch { return { compiles: false, imports: [] }; }
}

/** Consume only the next bounded regular request, and publish its result atomically. */
function scan() {
  const id = sequence + 1, file = join(directory, `request-${id}.json`);
  let stat;
  try { stat = fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return; return stop(); }
  try {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) return stop();
    const request = JSON.parse(fs.readFile(file, 'utf8'));
    if (request?.version !== 1 || request.id !== id || !Array.isArray(request.sources)
      || request.sources.some(source => typeof source !== 'string')) return stop();
    const output = JSON.stringify({ version: 1, id, results: request.sources.map(compile) });
    if (Buffer.byteLength(output) > MAX_BYTES) return stop();
    const temporary = join(directory, `reply-${id}.tmp`);
    fs.writeFile(temporary, output, { flag: 'wx', mode: 0o600 });
    fs.rename(temporary, join(directory, `reply-${id}.json`));
    sequence = id;
    sourceBytes += request.sources.reduce((sum, source) => sum + Buffer.byteLength(source), 0);
    modules += request.sources.length;
    if (sourceBytes >= SOURCE_BUDGET || modules >= MODULE_BUDGET) {
      const rotation = join(directory, 'rotation.tmp');
      fs.writeFile(rotation, JSON.stringify({ version: 1, pid: process.pid, sequence }), { mode: 0o600 });
      fs.rename(rotation, join(directory, 'rotation.json'));
      watcher?.close();
      if (timer) clearInterval(timer);
      process.exit(0);
    }
  } catch { stop(); }
}

/** Keep custody bounded even when a parent is terminated between batches. */
function checkParent() { if (process.ppid !== parent) stop(); }

/** Observe the compiler outside its isolate, so even a fatal V8 exit leaves an actual status and stderr. */
function supervise() {
  let child, finished = false, terminating = false, rotations = 0;
  /** Publish only this owned child's observed outcome, never an inferred successful reply. */
  function finish(code, signal, error) {
    if (finished) return;
    finished = true;
    if (timer) clearInterval(timer);
    try {
      const temporary = join(directory, 'exit.tmp');
      fs.writeFile(temporary, JSON.stringify({ version: 1, code, signal, ...(error ? { error } : {}) }), { mode: 0o600 });
      fs.rename(temporary, join(directory, 'exit.json'));
    } catch { /* The owning caller may already have removed its completed transport. */ }
  }
  /** Terminate only the compiler spawned by this supervisor. */
  const terminate = () => { terminating = true; child?.kill('SIGKILL'); };
  /** Continue the next request in a fresh compiler only after the owned worker's clean rotation. */
  function launch() {
    const log = fs.open(join(directory, 'stderr.log'), 'a', 0o600);
    try {
      child = spawn(process.execPath, ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning',
        fileURLToPath(import.meta.url), directory, String(process.pid), '--compile', String(sequence)],
        { stdio: ['ignore', 'ignore', log] });
    } finally { fs.close(log); }
    const current = child;
    const identity = join(directory, 'compiler.tmp');
    fs.writeFile(identity, JSON.stringify({ version: 1, pid: child.pid, supervisor: process.pid }), { mode: 0o600 });
    fs.rename(identity, join(directory, 'compiler.json'));
    child.once('error', error => finish(null, null, error.message));
    child.once('close', (code, signal) => {
      if (finished) return;
      if (!terminating && code === 0 && signal === null) {
        try {
          const rotation = JSON.parse(fs.readFile(join(directory, 'rotation.json'), 'utf8'));
          if (rotation?.version === 1 && rotation.pid === current.pid
            && Number.isSafeInteger(rotation.sequence) && rotation.sequence > sequence) {
            sequence = rotation.sequence;
            fs.rm(join(directory, 'rotation.json'));
            if (++rotations >= SUPERVISOR_BUDGET) {
              const temporary = join(directory, 'supervisor-rotation.tmp');
              fs.writeFile(temporary, JSON.stringify({ version: 1, pid: process.pid, sequence }), { mode: 0o600 });
              fs.rename(temporary, join(directory, 'supervisor-rotation.json'));
              finished = true;
              if (timer) clearInterval(timer);
              process.exit(0);
            }
            launch();
            return;
          }
        } catch { /* An absent or invalid rotation never authorizes another compiler. */ }
      }
      finish(code, signal);
    });
  }
  process.once('SIGTERM', terminate);
  process.once('SIGINT', terminate);
  // budget: preserve the existing one-second parent-custody check; this is not a compile deadline.
  timer = setInterval(() => { if (process.ppid !== parent) terminate(); }, 1_000);
  launch();
}

if (!directory || !Number.isSafeInteger(parent) || parent <= 0 || process.ppid !== parent
  || !Number.isSafeInteger(sequence) || sequence < 0) stop();
if (mode === '--supervise') supervise();
else try {
  watcher = fs.watch(directory, scan);
  watcher.on('error', stop);
  // Budget: check parent custody once a second while this private worker is otherwise idle.
  timer = setInterval(() => { checkParent(); scan(); }, 1_000);
  scan();
} catch { stop(); }
