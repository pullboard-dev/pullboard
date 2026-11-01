/** Compile cell-analysis source only; no module linking or evaluation is permitted [C7,P3]. */
import { lstatSync, readFileSync, renameSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const [directory, parentText] = process.argv.slice(2);
const parent = Number(parentText), MAX_BYTES = 2 ** 26;
let sequence = 0, watcher = null, timer = null;

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
  try { stat = lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return; return stop(); }
  try {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) return stop();
    const request = JSON.parse(readFileSync(file, 'utf8'));
    if (request?.version !== 1 || request.id !== id || !Array.isArray(request.sources)
      || request.sources.some(source => typeof source !== 'string')) return stop();
    const output = JSON.stringify({ version: 1, id, results: request.sources.map(compile) });
    if (Buffer.byteLength(output) > MAX_BYTES) return stop();
    const temporary = join(directory, `reply-${id}.tmp`);
    writeFileSync(temporary, output, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, join(directory, `reply-${id}.json`));
    sequence = id;
  } catch { stop(); }
}

/** Keep custody bounded even when a parent is terminated between batches. */
function checkParent() { if (process.ppid !== parent) stop(); }

if (!directory || !Number.isSafeInteger(parent) || parent <= 0 || process.ppid !== parent) stop();
try {
  watcher = watch(directory, scan);
  watcher.on('error', stop);
  // Budget: check parent custody once a second while this private worker is otherwise idle.
  timer = setInterval(checkParent, 1_000);
  scan();
} catch { stop(); }
