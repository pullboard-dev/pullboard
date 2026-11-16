import { fileURLToPath } from 'node:url';
import { checkReceiptKey } from '../../../../git/index.js';
import { readCheckReceipt } from '../../../../git/index.js';
import { writeCheckReceipt } from '../../../../git/index.js';
import { receiptLine } from '../../../../git/index.js';
/** Cache the cells checks per exact repository state so a repeat on unchanged inputs replays in well under a second [C7]. */
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { statSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { gitSpawnSync } from '../../../../git/index.js';
import { storeName } from '../store-names.js';

const KEEP = 60;

/** Run git quietly in a directory; null when it fails, so an odd checkout simply misses the cache. */
function git(root, args) {
  const run = gitSpawnSync(args, { cwd: root, encoding: 'buffer', maxBuffer: 1 << 28, env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_OPTIONAL_LOCKS: '0' } });
  return run.status === 0 ? run.stdout : null;
}

/**
 * Whether this board turned the cells cache on: pullboard.json "cells.cache" is true; off by default.
 * The setting is read straight from the file so a cache hit never loads the whole config.
 */
export function cellsCacheEnabled(root) {
  try { return JSON.parse(readFileSync(join(root, 'pullboard.json'), 'utf8'))?.cells?.cache === true; } catch { return false; }
}

/**
 * A digest of the exact state the checks read: the commit, its tree, the dirty diff against HEAD and
 * every untracked file's bytes, plus the Node version. Null when the state cannot be read exactly.
 *
 * @returns {string|null}
 */
export function cellsStateKey(root) {
  const head = git(root, ['rev-parse', 'HEAD', 'HEAD^{tree}']);
  const diff = git(root, ['diff', 'HEAD', '--binary', '--no-ext-diff']);
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (!head || !diff || !untracked) return null;
  const hash = createHash('sha256').update(head).update('\0').update(process.version).update('\0').update(diff).update('\0');
  for (const name of untracked.toString().split('\0').filter(Boolean).sort()) {
    try { hash.update(name).update('\0').update(readFileSync(join(root, name))).update('\0'); } catch { return null; }
  }
  return hash.digest('hex');
}

/** The per-checkout cache folder, inside the git directory so it is never tracked or shared. */
function cacheDir(root) {
  const path = git(root, ['rev-parse', '--git-path', 'pullboard-cells-cache']);
  return path ? resolve(root, path.toString().trim()) : null;
}

/** Run fn with console.log and console.error recorded in order; its returned exit code is kept. */
function capture(fn) {
  const lines = [], log = console.log, error = console.error;
  console.log = (...args) => { lines.push(['out', args.map(String).join(' ')]); };
  console.error = (...args) => { lines.push(['err', args.map(String).join(' ')]); };
  try { return { code: fn(), lines }; } finally { console.log = log; console.error = error; }
}

/** Print recorded lines through the console in their original order. */
function replay(lines) {
  for (const [stream, text] of lines) (stream === 'err' ? console.error : console.log)(text);
}

/** Drop the oldest entries beyond the keep limit; failures only leave extra files. */
function prune(dir) {
  try {
    const files = readdirSync(dir).map(name => ({ name, time: statSync(join(dir, name)).mtimeMs })).sort((a, b) => b.time - a.time);
    for (const { name } of files.slice(KEEP)) rmSync(join(dir, name), { force: true });
  } catch { /* Pruning is best effort. */ }
}

/**
 * Run a cells check, or replay its saved output and exit code when the exact state, mode and arguments
 * were seen before. A thrown refusal is never saved. With the cache off this is just fn().
 *
 * @param {string} root checkout root
 * @param {string[]} label mode and arguments that name the run
 * @param {() => number} fn the real check; prints with console.log/console.error and returns an exit code
 * @param {{ enabled?: boolean, code?: string[] }} [options] checker entry modules outside this cache library
 * @returns {number}
 */
export function cachedCellsRun(root, label, fn, options = {}) {
  const enabled = options.enabled ?? cellsCacheEnabled(root);
  const key = enabled ? checkReceiptKey(root, { kind: 'lint', definition: label, config: {}, code: [fileURLToPath(import.meta.url), ...(options.code ?? [])] }) : null;
  const receipt = readCheckReceipt(root, key);
  if (receipt?.result?.code === 0 && Array.isArray(receipt.result.lines)) {
    replay(receipt.result.lines);
    console.error(receiptLine(receipt));
    return 0;
  }
  // An opaque checker entry never falls through to a legacy result with an unknown definition.
  if (enabled && options.code?.length && !key) return fn();
  const state = enabled ? cellsStateKey(root) : null, dir = state ? cacheDir(root) : null;
  if (!state || !dir) return fn();
  const file = join(dir, `${storeName(createHash('sha256').update(JSON.stringify([state, label, key?.checkDigest, key?.configDigest])).digest('hex'))}`);
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    if (Number.isInteger(saved.code) && Array.isArray(saved.lines)) {
      if (saved.code === 0) writeCheckReceipt(root, key, { result: saved });
      replay(saved.lines); return saved.code;
    }
  } catch { /* A missing or damaged entry is a miss. */ }
  const { code, lines } = capture(fn);
  if (code === 0) writeCheckReceipt(root, key, { result: { code, lines } });
  replay(lines);
  try {
    mkdirSync(dir, { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ code, lines }));
    renameSync(temp, file);
    prune(dir);
  } catch { /* A failed save only costs the next run a miss. */ }
  return code;
}
