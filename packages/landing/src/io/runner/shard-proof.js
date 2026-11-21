/** A land job's proof run as shards on other runners: pin the merged commit under a landing ref, offer the files as shard jobs, wait for every receipt [C7,#7818]. */
import { tryGit } from '../../../../git/index.js';
import { timeoutDetail } from './deadline.js';

/** The ref a land job pins its merged commit under, which a shard's runner fetches (#8198): the job id with each character git refuses in a ref name (its colons) made a hyphen. */
export const landingRef = job => `refs/pullboard/landing/${String(job).replaceAll(/[^\w.-]/gu, '-')}`;
// Budget: the waiting land job reads its shards' receipts this often; each read is one small board call, and each pass renews the lease.
const POLL_MS = 2_000;
const NO_PUSH_OPTIONS = /does not support push options/u;
const FAILING_CASES = 4000;

const CACHE_SUMMARY = /^(?:# )?test cache: (\d+) files, (\d+) reused, (\d+) ran;/mu;
const REUSED_FILE = /^# reused [0-9a-f]{64} from ledger \((.+)\)$/mu;
const ACCOUNT_FILES = 200;

/**
 * What one posted shard reused from the results the gate recorded: the reused count its proof phase's test cache summary
 * prints, and the files named by the ledger-hit lines the phase's output tail still holds. Why: a shard receipt carries only
 * the tail of its output, so the count is exact and the file list is what that tail kept [C7,#9515].
 *
 * @param {{ receipt?: { gate?: { phases?: { role: string, tail?: string }[] } } } | null} posted
 * @returns {{ reused: number | null, files: string[] }}
 */
export function shardReuse(posted) {
  const tail = String((posted?.receipt?.gate?.phases ?? []).find(phase => phase.role === 'proof')?.tail ?? '');
  const summary = CACHE_SUMMARY.exec(tail);
  return { reused: summary ? Number(summary[2]) : null, files: [...tail.matchAll(new RegExp(REUSED_FILE.source, 'gmu'))].map(row => row[1]) };
}

/**
 * The proof files that declare an exclusive timing runner: a git grep over the proof's own files in the merged checkout for the leading-comment line (a comment line before the file's first code line). It never reaches the gate door, which would pull the CLI into this cell.
 *
 * @param {string} root
 * @param {string[]} files
 * @returns {Promise<string[]>}
 */
export async function timingFilesOf(root, files) {
  const found = new Set();
  for (let at = 0; at < files.length; at += 200) {
    const read = tryGit(root, ['grep', '-n', '-E', '^[ \\t]*(//|/?\\*+)[ \\t]*@pullboard-test-timing[ \\t]*\\r?$', '--', ...files.slice(at, at + 200)]);
    for (const line of read.stdout.split('\n')) {
      const [file, row] = line.split(':');
      if (!file) continue;
      // The first line that is not a comment or blank ends the leading comments; a declaration must come before it.
      const code = tryGit(root, ['grep', '-n', '-v', '-m', '1', '-E', '^[ \\t]*(//|/\\*|\\*|$)', '--', file]).stdout.split('\n')[0].split(':');
      if (code.length < 3 || Number(row) < Number(code[1])) found.add(file);
    }
  }
  return files.filter(file => found.has(file));
}

/** Sleep without leaving a timer behind once the wait ends. */
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Whether one posted shard receipt is green, as the gate's combined receipt reads it: its status and its proof phase both 0 and the gate green.
 *
 * @param {{ receipt?: { status?: number, gate?: { green?: boolean, phases?: { role: string, status: number }[] } } } | null} posted
 * @returns {boolean}
 */
export function shardGreen(posted) {
  const gate = posted?.receipt?.gate ?? {};
  return posted?.receipt?.status === 0 && gate.green === true && (gate.phases ?? []).find(phase => phase.role === 'proof')?.status === 0;
}

/**
 * The detail a red set of shards names, as ledgerProofCheck names a red run: the failing files first, then each failing case.
 *
 * @param {{ job: string, posted: object | null }[]} reds
 * @param {number} total - How many shards the proof split into.
 * @returns {{ detail: string, failures: { file: string, name: string }[] | null, output: string }}
 */
export function redShardDetail(reds, total) {
  const phases = reds.map(({ posted }) => (posted?.receipt?.gate?.phases ?? []).find(phase => phase.role === 'proof') ?? null);
  const failures = phases.flatMap(phase => Array.isArray(phase?.failures) ? phase.failures.filter(row => typeof row?.file === 'string') : []);
  const named = [...new Set([...failures.map(row => row.file), ...phases.flatMap(phase => Array.isArray(phase?.failedFiles) ? phase.failedFiles : [])].map(file => String(file).replace(/^\.\//u, '')))].sort();
  const cases = failures.map(row => `not ok - ${row.name}`);
  const tails = reds.map(({ job, posted }, at) => `shard ${job}: ${String(posted?.receipt?.gate?.error ?? phases[at]?.tail ?? 'no proof phase posted').slice(-300)}`);
  const where = named.length ? `red in ${named.slice(0, 5).join(', ')}${named.length > 5 ? ` (+${named.length - 5} more)` : ''}; ` : '';
  const detail = `landing proof red in ${reds.length} of ${total} shard jobs (${reds.map(row => row.job).join(', ')}): ${where}${tails.join('\n').slice(0, 600)}${cases.length ? `\nfailing cases:\n${cases.join('\n').slice(0, FAILING_CASES)}` : ''}`;
  return { detail, failures: failures.length ? failures.map(({ file, name }) => ({ file, name })) : null, output: `${tails.join('\n')}\n${cases.join('\n')}` };
}

/**
 * Pin the merged commit under the job's landing ref on the trunk remote, with the landing permit's push options when it takes them.
 *
 * @returns {{ ok: boolean, detail?: string }}
 */
function pinMerged(root, { remote, job, options = [] }) {
  const push = extra => tryGit(root, ['push', '--porcelain', '--quiet', '--force', ...extra, remote, `HEAD:${landingRef(job)}`]);
  const first = push(options.flatMap(option => ['-o', option]));
  const pushed = options.length && first.status !== 0 && NO_PUSH_OPTIONS.test(first.stderr) ? push([]) : first;
  return pushed.status === 0 ? { ok: true } : { ok: false, detail: (pushed.stderr || pushed.stdout).slice(0, 240) };
}

/**
 * The proof of a land job when its shards are on: push the merged commit to refs/pullboard/landing/<job>, offer the proof's
 * files as shard jobs through the board, and wait until every shard has posted; green only when all are, else the red shards'
 * failing cases. A proof the board does not split (within one runner's cores), a board that refuses the offer, or a ref the
 * remote refuses runs the files here as the single-runner proof does, so turning shards on never stops a landing.
 *
 * @param {{ runner: string, files: string[], ledger?: object | null }} proof
 * @param {{ job: string, remote: string, cores: number, gate: { run: string[], entry: string },
 *   offer: (request: { merged: string, ref: string, plan: { runner: string, files: string[], cores: number, timing?: string[] }, gate: { run: string[], entry: string, commits: string[] } }) => Promise<{ sharded: boolean, shards: string[] }> | { sharded: boolean, shards: string[] },
 *   receipts: (shards: string[]) => Promise<{ job: string, posted: object | null }[]> | { job: string, posted: object | null }[],
 *   timingFiles?: (root: string, files: string[]) => Promise<string[]> | string[], pushOptions?: () => string[], pollMs?: number, wait?: (ms: number) => Promise<void>, now?: () => number,
 *   deadline?: () => { at: number, ms: number } | null }} shard
 * @param {(root: string) => Promise<object>} local - Runs the whole proof on this runner.
 * @returns {(context: { root: string, base: string, renew?: () => Promise<boolean> | boolean }) => Promise<object>}
 */
export function shardedProofCheck(proof, shard, local) {
  const { job, remote, cores, gate, offer, receipts, pushOptions = () => [], pollMs = POLL_MS, wait = pause, now = Date.now, deadline = () => null, reuseGate = false, timingFiles = timingFilesOf } = shard;
  return async context => {
    const merged = tryGit(context.root, ['rev-parse', 'HEAD']).stdout;
    // A declared timing file is offered as shards even when the files fit the cores, so the board can give it an exclusive runner; a board that does not split them answers sharded: false and the proof runs here.
    const timing = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(merged) ? await timingFiles(context.root, proof.files) : [];
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(merged) || (proof.files.length <= cores && !timing.length)) return local(context);
    const pinned = pinMerged(context.root, { remote, job, options: pushOptions() });
    if (!pinned.ok) return local(context);
    let offered;
    try { offered = await offer({ merged, ref: landingRef(job), ...(reuseGate ? { reuse: true } : {}), plan: { runner: proof.runner, files: proof.files, cores, ...(timing.length ? { timing } : {}) }, gate: { run: gate.run, entry: gate.entry, commits: [context.base] } }); } catch { return local(context); }
    if (!offered?.sharded || !Array.isArray(offered.shards) || !offered.shards.length) return local(context);
    const posted = new Map(), total = offered.shards.length;
    const counts = { files: proof.files.length, reused: 0, ran: proof.files.length, shards: total };
    // The wait ends by its own condition: every shard posted, a red one posted, or the deadline passed.
    while (posted.size < total) {
      if (context.renew && !await context.renew()) return { ok: false, timeout: true, detail: 'the land job\'s lease moved to another runner while its shards ran', proof: counts };
      for (const row of await receipts(offered.shards.filter(id => !posted.has(id)))) if (row.posted?.receipt) posted.set(row.job, row.posted);
      // A red shard ends the wait at once: the landing is red whatever the others still run.
      const reds = offered.shards.filter(id => posted.has(id) && !shardGreen(posted.get(id))).map(id => ({ job: id, posted: posted.get(id) }));
      if (reds.length) return { ok: false, ...redShardDetail(reds, total), proof: counts };
      const limit = deadline();
      if (posted.size < total && limit && now() >= limit.at) return { ok: false, timeout: true, detail: timeoutDetail(`the landing proof's ${total} shards (${posted.size} posted)`, limit.ms, ''), proof: counts };
      if (posted.size < total) await wait(pollMs);
    }
    // The shards' own cache summaries say how many files they reused from the gate's results; one missing summary leaves the count unknown, so it stays 0 rather than guessed.
    const reuse = offered.shards.map(id => shardReuse(posted.get(id)));
    if (reuse.every(row => row.reused !== null)) {
      const reused = reuse.reduce((total, row) => total + row.reused, 0);
      Object.assign(counts, { reused, ran: counts.files - reused });
    }
    if (reuseGate) Object.assign(counts, { reusedFiles: reuse.flatMap(row => row.files).slice(0, ACCOUNT_FILES) });
    return { ok: true, detail: null, proof: counts };
  };
}
