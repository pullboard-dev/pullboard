/** Reuse one generated stress board per generator version, so only the first run on a runner pays the generation time [N26]. */
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cpSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { statSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { userInfo } from 'node:os';
import { basename } from 'node:path';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateStressBoard } from './generate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STORE = join(HERE, '../../../../../../packages/store');

/** Every .js file under a directory, sorted, so the hash is stable. */
function sources(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === 'node_modules' || entry.name === 'tests') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(path));
    else if (/\.(js|mjs|sql)$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** Hash of the generator, the store it writes through, and the inputs: any change builds a fresh board. */
function cacheKey(inputs) {
  const hash = createHash('sha256').update(JSON.stringify(inputs));
  for (const file of [join(HERE, 'generate.mjs'), ...sources(STORE)]) hash.update(file.slice(HERE.length)).update(readFileSync(file));
  return hash.digest('hex').slice(0, 24);
}

/** Replace the cached workspace path with the copy's inside every string of a manifest. */
function repath(value, from, to) {
  if (typeof value === 'string') return value.split(from).join(to);
  if (Array.isArray(value)) return value.map(entry => repath(entry, from, to));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, repath(v, from, to)]));
  return value;
}

/**
 * The runner's own cache folder: a test run's TMPDIR is deleted with the run, so the cache lives beside the runner's other
 * caches under the real home (HOME is remapped inside test runs).
 */
export function stressCacheRoot() { return join(userInfo().homedir, '.pullboard-runner', 'cache', 'stress-boards'); }

/** Point the small text files that name the board's old path (the project registry, setup records) at the copy. */
function repathFiles(dir, from, to) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { repathFiles(path, from, to); continue; }
    if (!entry.isFile() || /\.sqlite/.test(entry.name) || statSync(path).size > 1_000_000) continue;
    const text = readFileSync(path, 'utf8');
    if (text.includes(from)) writeFileSync(path, text.split(from).join(to));
  }
}

/**
 * Resolve once `marker` exists. Polls instead of fs.watch: a watcher armed after the build finished, or on a folder
 * that did not yet exist, never fires, which left a run silent at under 1% CPU until the file kill [C7].
 */
export function waitForMarker(marker, pollMs = 500, maxMs = 150_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (existsSync(marker)) { clearInterval(timer); resolve(); }
      else if (Date.now() - started > maxMs) { clearInterval(timer); reject(new Error(`Refused(STRESS_BOARD_COLD, tab-speed stage "board generation" saw no cache marker in ${maxMs / 1000} s; rerun this file)`)); }
    }, pollMs);
    if (existsSync(marker)) { clearInterval(timer); resolve(); }
  });
}

/** What a cold call waits on: the detached build's exit, or the marker appearing from another run's build. */
let pending = null;

/** Same result as generateStressBoard, but copied from the runner's cache; removeStressBoard cleans the copy. */
export function cachedStressBoard(inputs) {
  // Returns null while a cold build runs; the caller waits with awaitStressBoard.
  const cache = join(stressCacheRoot(), cacheKey(inputs));
  const marker = join(cache, 'complete');
  if (!existsSync(marker)) {
    // A cold runner builds the board in a detached process: a test run killed at its file budget must not kill the build,
    // so the next run finds the cache. This run waits for it as long as it can.
    const lock = `${cache}.lock`;
    let fresh = false;
    try { mkdirSync(lock); fresh = true; } catch { fresh = Date.now() - statSync(lock).mtimeMs > 600_000; }
    if (fresh) {
      const child = spawn(process.execPath, [join(HERE, 'stress-cache-build.mjs'), JSON.stringify(inputs), cache, lock], { detached: true, stdio: 'ignore' });
      pending = new Promise(resolve => child.once('exit', resolve));
    } else {
      pending = waitForMarker(marker);
    }
    return null;
  }
  const built = readFileSync(marker, 'utf8').trim(), source = join(cache, basename(built));
  const workspace = join(tmpdir(), `pullboard-stress-${randomUUID()}`);
  cpSync(source, workspace, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(workspace, 'stress-board.json'), 'utf8'));
  const env = JSON.parse(readFileSync(join(workspace, 'env.json'), 'utf8'));
  rmSync(join(workspace, 'env.json'));
  for (const part of ['home', 'machine-home', join('board', '.git', 'pullboard')]) repathFiles(join(workspace, part), built, workspace);
  return { ...repath(manifest, built, workspace), parent: tmpdir(), workspace, env: repath(env, built, workspace) };
}

/** Build the cache from a detached process; node:test's per-file budget cannot kill it. */
export function buildStressCache(inputs, cache) {
  const staging = join(stressCacheRoot(), `building-${process.pid}-${Date.now()}`);
  mkdirSync(staging, { recursive: true });
  const made = generateStressBoard({ ...inputs, parent: staging });
  writeFileSync(join(made.workspace, 'env.json'), JSON.stringify(made.env));
  writeFileSync(join(staging, 'complete'), `${made.workspace}\n`);
  try { renameSync(staging, cache); } catch { rmSync(staging, { recursive: true, force: true }); }
}

/** The cached board, waiting (while a cold build runs) until the runner's file budget would end the test anyway. */
export async function awaitStressBoard(inputs) {
  const board = cachedStressBoard(inputs);
  if (board) return board;
  await pending;
  const built = cachedStressBoard(inputs);
  if (!built) throw new Error('Refused(STRESS_BOARD_COLD, the stress board cache build did not finish; rerun this file)');
  return built;
}
