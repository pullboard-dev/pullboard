import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { relative } from 'node:path';
import { resolve } from 'node:path';

const run = promisify(execFile);

/**
 * Restart a long-running server on fresh code when the checkout it runs from moves to another commit (#6157).
 * The old server stops listening, lets in-flight requests finish for up to `drain` ms, then calls `relaunch` (the same
 * server on the same port, from the new code) and settles `restarted`, so its caller exits.
 * Why: a process started before a landing lazily imports the landing's modules against the ones it loaded at start,
 * and from 12 Nov 12:15Z every board read failed that way until a hand restart; a fresh process loads one tree.
 * Leases live on the board, never in the process, so a runner's lease outlives the restart.
 * With `affects`, a move that changes nothing the server loads is only noted: no restart and no gap in listening.
 *
 * @param {{ root: string, revision: () => string | null, close: () => Promise<unknown>,
 *   relaunch: () => Promise<{ pid: number | null }> | { pid: number | null }, interval?: number, drain?: number,
 *   affects?: (from: string, to: string) => boolean | Promise<boolean>, log?: (line: string) => void }} options revision reads the commit the code at root is at, null when it cannot tell.
 * @returns {{ restarted: Promise<{ from: string, to: string, pid: number | null }>, stop: () => void }}
 */
export function restartOnCodeMove({ root, revision, close, relaunch, affects = () => true, interval = 5_000, drain = 20_000, log = (line) => process.stderr.write(line + '\n') }) {
  let from = revision();
  let timer = null;
  let settle;
  const restarted = new Promise((done) => { settle = done; });
  const check = async () => {
    timer = null;
    const to = revision();
    if (!to || to === from) { schedule(); return; }
    if (!await affects(from, to)) { from = to; schedule(); return; }
    log(`pullboard: the code at ${root} moved from ${from.slice(0, 10)} to ${to.slice(0, 10)}; restarting on the new code`);
    let drained;
    await Promise.race([close(), new Promise((done) => { drained = setTimeout(done, drain); })]);
    clearTimeout(drained);
    const { pid } = await relaunch();
    log(`pullboard: restarted as process ${pid ?? 'unknown'}`);
    settle({ from, to, pid });
  };
  const schedule = () => { timer = setTimeout(check, interval); timer.unref(); };
  // Code outside a Git checkout has no commit to watch: it serves as it did.
  if (from) schedule();
  return { restarted, stop: () => { if (timer) clearTimeout(timer); timer = null; } };
}

/** Relative import, dynamic import and require specifiers a module names literally. */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\(\s*)['"](\.{1,2}\/[^'"]+)['"]/gu;

/** Every file a server started from `entries` can load: the relative imports and requires it names, followed to a fixed point. */
export function servedClosure(entries) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const file = resolve(queue.pop());
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    if (!/\.(?:m?js|cjs)$/u.test(file)) continue;
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    for (const match of text.matchAll(SPECIFIER)) queue.push(join(dirname(file), match[1]));
  }
  return seen;
}

/**
 * The `affects` rule for a server run from `entries` in the checkout at `root`: a landing restarts it only when it changes
 * a file in the server's module closure, or package.json. Docs and unrelated cells change nothing the process loaded.
 * Anything it cannot tell (Git failing) restarts, as before.
 * @returns {(from: string, to: string) => Promise<boolean>}
 */
export function servedModuleMoved({ root, entries }) {
  return async (from, to) => {
    let changed;
    try { changed = (await run('git', ['diff', '--name-only', '--no-renames', from, to], { cwd: root })).stdout.split('\n').filter(Boolean); }
    catch { return true; }
    const served = new Set([...servedClosure(entries)].map(file => relative(root, file)));
    return changed.some(file => file === 'package.json' || served.has(file) || !existsSync(join(root, file)));
  };
}
