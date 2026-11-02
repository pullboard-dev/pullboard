/** Compile private source records without linking, evaluating or executing their code [C7,P3]. */
import { lstatSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { watch } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const MAX_BYTES = 2 ** 26;
const [directory, parentText] = process.argv.slice(2);
const parent = Number(parentText);
let sequence = 0;
let watcher = null;
let parentWatch = null;

/** End this owned compiler when its parent or private protocol is no longer available. */
function stop() {
  watcher?.close();
  if (parentWatch) clearInterval(parentWatch);
  process.exit(1);
}

/** Compile one module without linking or evaluating it, retaining the existing V8 result shape. */
function compile(source) {
  try {
    const module = new vm.SourceTextModule(source);
    return { compiles: true, imports: module.moduleRequests
      ? module.moduleRequests.map(request => request.specifier) : module.dependencySpecifiers };
  } catch { return { compiles: false, imports: [] }; }
}

/** Read only the next regular request created by this compiler's parent, retaining the old input semantics. */
function readRequest(id) {
  const file = join(directory, `request-${id}.json`);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('invalid request');
  const request = JSON.parse(readFileSync(file, 'utf8'));
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).sort().join(',') !== 'id,sources,version'
    || request.version !== 1 || request.id !== id || !Array.isArray(request.sources)
    || request.sources.some(source => typeof source !== 'string')) throw new Error('invalid request');
  return request.sources;
}

/** Publish one bounded reply atomically; failures carry no source text or exception diagnostics. */
function writeReply(id, reply) {
  let body = JSON.stringify(reply);
  if (Buffer.byteLength(body) > MAX_BYTES) body = JSON.stringify({ version: 1, id, error: 'parser failed' });
  const temporary = join(directory, `reply-${id}.tmp`);
  writeFileSync(temporary, body, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, join(directory, `reply-${id}.json`));
}

/** Drain sequential requests; watching before the initial scan closes the first-request race. */
function scan() {
  try {
    const ids = readdirSync(directory).filter(name => /^request-[1-9][0-9]*\.json$/u.test(name))
      .map(name => Number(name.slice(8, -5))).filter(id => id > sequence).sort((a, b) => a - b);
    for (const id of ids) {
      if (!Number.isSafeInteger(id) || id !== sequence + 1) return stop();
      let reply;
      try { reply = { version: 1, id, results: readRequest(id).map(compile) }; }
      catch { reply = { version: 1, id, error: 'parser failed' }; }
      writeReply(id, reply);
      sequence = id;
    }
  } catch { stop(); }
}

/** Check actual parent custody rather than allowing a detached parser to remain alive indefinitely. */
function checkParent() {
  if (process.ppid !== parent) return stop();
  try { process.kill(parent, 0); }
  catch { stop(); }
}

if (!directory || !Number.isSafeInteger(parent) || parent <= 0 || process.ppid !== parent) stop();
try {
  watcher = watch(directory, scan);
  watcher.on('error', stop);
  // A hint carries no source or result authority; scan validates the next regular request.
  process.on('message', () => scan());
  process.on('disconnect', stop);
  // Budget: check parent custody each second between compile batches; no operational worker is touched.
  parentWatch = setInterval(() => {
    checkParent();
    scan();
  }, 1_000);
  checkParent();
  scan();
} catch { stop(); }
