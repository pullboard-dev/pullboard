/** The land job's proof: run the items' ledger-proved test files on the merged tree, reusing every ledger hit [P7]. */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { join } from 'node:path';
import { relative } from 'node:path';
import { timeoutDetail } from './deadline.js';
import { watchDeadline } from './deadline.js';

// The run-tests ledger variable (packages/gate LEDGER_HITS_ENV), named here so the runner bundle stays free of the gate package.
const LEDGER_HITS_ENV = 'PULLBOARD_LEDGER_HITS';
// An enclosing run's reuse, stage, store or hit settings never reach the landing proof: it plans from its own checkout.
const INHERITED = /^PULLBOARD_(TEST_(ACTIONS|STAGE|REUSE|RESULT_\w+)|LEDGER_HITS)$/u;
const REUSED = /^# reused [0-9a-f]{64} from ledger \(/u;
// The file a ledger hit names, for the per-file account landing.reuseGateReceipts keeps [C7,#9244].
const REUSED_FILE = /^# reused [0-9a-f]{64} from ledger \((.+)\)$/u;
const ACCOUNT_FILES = 200;
// A file main fails at its identical inputKey: charged to main, never run, so it holds no landing [P7].
const MAIN_RED = /^# main red [0-9a-f]{64} from ledger \(/u;
// A run-tests refusal ("run-tests: [NO_POLICY] ...") or a failing test ("not ok 3 - name" and its error lines): the red's cause [P7].
const REFUSAL = /^run-tests: \[[A-Z][A-Z0-9_]*\]/u;
const NOT_OK = /^\s*not ok \d+/u;
// The run-tests waiver variable (packages/gate LANDING_WAIVERS_ENV): a run keeps going past a failure a live waiver covers.
const LANDING_WAIVERS_ENV = 'PULLBOARD_LANDING_WAIVERS';
const CAUSE_LINES = 12, CAUSE_CHARS = 600;
// The most of a red run's output its log keeps, both streams in arrival order.
const LOG_CHARS = 4_000_000;

/**
 * Write a red proof's whole output to a file that outlives the job's checkout, so a cause can be read after the
 * receipt's short detail: the receipt keeps only a tail, which can start mid-JSON. Null when the file cannot be written.
 *
 * @param {string} root - The landing checkout, whose .git folder holds the log when no folder is named.
 * @param {string} command - The runner command that ran.
 * @param {string} output - The run's stdout and stderr in arrival order.
 * @param {NodeJS.ProcessEnv} env - Where PULLBOARD_LAND_LOG_DIR may name the log folder.
 * @returns {string | null} The log's absolute path.
 */
function keepLog(root, command, output, env) {
  try {
    const dir = env.PULLBOARD_LAND_LOG_DIR || join(root, '.git', 'land-red-logs');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `proof-${new Date().toISOString().replace(/[:.]/gu, '-')}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.log`);
    writeFileSync(path, `$ ${command}\n${output}`);
    return path;
  } catch { return null; }
}

/**
 * Read a red run's failing tests from its TAP, strictly: every `not ok` line with the file its YAML block locates, and
 * top-level `# fail` counts that add up to exactly those lines. Null when anything is unaccounted: a refusal, a
 * cancelled test, a failure with no file inside the checkout, or counts that disagree, since only named test failures
 * can be waived [B3,R3].
 *
 * @param {string} output - The run's whole stdout and stderr.
 * @param {string} root - The merged checkout the run judged.
 * @returns {{ file: string, name: string }[] | null}
 */
export function accountedRed(output, root) {
  const failures = [];
  let active = null, yaml = null, counted = 0, summaries = 0;
  // A test runner may print the checkout's real path (macOS /private/var for /var), so either names a file inside it.
  let real = root;
  try { real = realpathSync(root); } catch { /* the given root stands */ }
  const inside = path => [root, real].map(base => relative(base, path)).find(file => file && !file.startsWith('../') && !isAbsolute(file)) ?? null;
  for (const line of output.split('\n')) {
    if (REFUSAL.test(line) || /^# cancelled [1-9]/u.test(line)) return null;
    if (yaml !== null) {
      if (line === `${yaml}...`) { yaml = null; continue; }
      const location = /^\s*location:\s*['"]?(.+?):\d+(?::\d+)?['"]?\s*$/u.exec(line);
      if (active && location) {
        const file = isAbsolute(location[1]) ? inside(location[1]) : location[1].replace(/^\.\//u, '');
        if (file && !file.startsWith('../')) active.file = file;
      }
      continue;
    }
    const block = /^(\s*)---\s*$/u.exec(line);
    if (block) { yaml = block[1]; continue; }
    const failed = /^\s*not ok\s+\d+\s+-\s+(.*)$/u.exec(line);
    if (failed) { active = { name: failed[1].replace(/\s+#.*$/u, ''), file: null }; failures.push(active); continue; }
    if (/^\s*ok\s+\d+/u.test(line)) active = null;
    const count = /^# fail (\d+)\s*$/u.exec(line);
    if (count) { counted += Number(count[1]); summaries++; }
  }
  return summaries && failures.length && counted === failures.length && failures.every(row => row.file) ? failures : null;
}

/**
 * Pair every failure of a red landing proof with the person's waiver covering it, live at `now`; null when one is not
 * covered. A file waiver covers its file, a name waiver its test name, so a waiver never hides another red [B3,R3,#655].
 *
 * @param {{ file: string, name: string }[] | null} failures
 * @param {{ id: string, kind: string, test: string, until: string, reason?: string }[]} waivers - The job's payload waivers.
 * @param {number} now
 * @returns {{ file: string, name: string, waiver: string }[] | null}
 */
export function waivedRed(failures, waivers, now) {
  if (!failures?.length || !Array.isArray(waivers) || !waivers.length) return null;
  const live = waivers.filter(waiver => Date.parse(waiver?.until) > now);
  const covered = failures.map(failure => ({ ...failure, waiver: live.findLast(waiver => waiver.kind === 'file' ? waiver.test === failure.file : waiver.test === failure.name)?.id }));
  return covered.every(row => typeof row.waiver === 'string') ? covered : null;
}

/**
 * The test files a red run's TAP names as failing, sorted, and each failing case's `not ok` line: what a reopened item's
 * builder reads and the durable landing log keeps. Lenient where accountedRed is strict: a file it cannot place is skipped.
 *
 * @param {string} output - The run's whole stdout and stderr.
 * @param {string} root - The merged checkout the run judged.
 * @returns {{ files: string[], cases: string[] }}
 */
export function redSummary(output, root) {
  let real = root;
  try { real = realpathSync(root); } catch { /* the given root stands */ }
  const files = new Set(), cases = [];
  let waiting = false;
  for (const line of output.split('\n')) {
    if (NOT_OK.test(line)) { waiting = true; cases.push(line.trim()); continue; }
    const location = waiting ? /^\s*location:\s*['"]?(.+?):\d+(?::\d+)?['"]?\s*$/u.exec(line) : null;
    if (!location) continue;
    waiting = false;
    const file = isAbsolute(location[1]) ? [root, real].map(base => relative(base, location[1])).find(row => row && !row.startsWith('../') && !isAbsolute(row)) : location[1].replace(/^\.\//u, '');
    if (file) files.add(file);
  }
  return { files: [...files].sort(), cases };
}

/** Quote one word for the shell the runner command runs in. */
function shellWord(word) {
  return /^[\w./@:=+-]+$/u.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

/**
 * The landing check that proves `proof.files` on the merged tree: the project's runner command over those files, with
 * the board's hit list, so run-tests reuses a file whose inputKey and context class a ledger row proved and runs only
 * the misses. A file whose import closure main changed has a new inputKey, so it misses and runs; a file main fails at
 * its identical inputKey (`ledger.mainRed`) is main's red and is counted, not run. The hit list goes in
 * on the run's stdin, never as a file: run-tests reuses nothing in a dirty tree, and the runner keeps no state file.
 *
 * @param {{ runner: string, files: string[], ledger?: { contexts: string[], files: Array<[string, string, number]>, mainRed?: Array<[string, string, number]> } | null }} proof
 * A red whose every failure a live person waiver covers is ok and names them as `waived`: the landing goes ahead, waived, not green [#655].
 * @param {{ env?: NodeJS.ProcessEnv, waivers?: { id: string, kind: string, test: string, until: string }[], now?: () => number, deadline?: () => { at: number, ms: number } | null }} [options] - waivers: the job's payload waivers;
 * reuseGate (landing.reuseGateReceipts, off by default): the receipt's proof adds `hits` (the hit list's size), `reusedFiles` (each file a ledger hit covered, capped) and `dirty` (changed paths in the tree, the one thing that makes run-tests ignore every hit) [C7,#9244].
 * deadline: when the landing's checks must be done; a proof still running then has its process tree stopped and returns `timeout: true`, never a red [C7,#7820].
 * failures: a red's failing tests by file, when its TAP accounts for every one (accountedRed), else absent.
 * failed: a red's failing files and case lines, and the path of the file holding its whole output [#8499].
 * @returns {(context: { root: string }) => Promise<{ ok: boolean, detail: string | null, waived?: { file: string, name: string, waiver: string }[], failures?: { file: string, name: string }[], proof: { files: number, reused: number, ran: number, mainRed?: number } }>}
 */
export function ledgerProofCheck(proof, { env = process.env, waivers = [], now = Date.now, deadline = null, reuseGate = false } = {}) {
  return ({ root }) => new Promise(resolve => {
    // The per-file account: the hit list's size, the files it covered, and whether a dirty tree made run-tests ignore it [C7,#9244].
    const reusedFiles = [];
    const dirtyCount = new Promise(done => {
      if (!reuseGate || !proof.ledger?.files?.length) return done(0);
      let out = '';
      const git = spawn('git', ['status', '--porcelain', '-z', '--untracked-files=all'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
      git.stdout.on('data', chunk => { out += chunk.toString('utf8'); });
      git.on('error', () => done(0));
      git.on('close', () => done(out.split('\0').filter(Boolean).length));
    });
    const settle = result => dirtyCount.then(dirty => resolve(reuseGate ? { ...result, proof: { ...result.proof, hits: proof.ledger?.files?.length ?? 0, reusedFiles: reusedFiles.slice(0, ACCOUNT_FILES), ...(dirty ? { dirty } : {}) } } : result));
    const note = line => { const named = reuseGate ? REUSED_FILE.exec(line) : null; if (named) reusedFiles.push(named[1]); };
    const clean = Object.fromEntries(Object.entries(env).filter(([name]) => !INHERITED.test(name)));
    const command = `${proof.runner} ${proof.files.map(file => shellWord(`./${file}`)).join(' ')}`;
    const projected = waivers.map(({ kind, test }) => ({ kind, test }));
    const child = spawn(command, { shell: true, cwd: root, stdio: ['pipe', 'pipe', 'pipe'], env: { ...clean, [LEDGER_HITS_ENV]: '/dev/stdin', ...(projected.length ? { [LANDING_WAIVERS_ENV]: JSON.stringify(projected) } : {}) } });
    child.stdin.on('error', () => { /* A runner that never reads its hit list just runs every file. */ });
    child.stdin.end(JSON.stringify(proof.ledger ?? { contexts: [], files: [] }));
    // The whole TAP (stdout) is kept only when waivers could cover a red, to account every failure.
    let all = '';
    const keepAll = () => all.length < 400_000;
    let full = '';
    const record = chunk => { if (full.length < LOG_CHARS) full += chunk.toString('utf8'); };
    let tail = '', reused = 0, mainRed = 0, pending = '', errPending = '';
    // The first refusal wins over any failing test; a failing test keeps its name and the error lines after it.
    let refusal = null, failure = null, closed = false;
    const cause = line => {
      if (!refusal && REFUSAL.test(line)) refusal = line;
      else if (failure && !closed) { failure.push(line); closed = failure.length >= CAUSE_LINES || line.trim() === '...'; }
      else if (!failure && NOT_OK.test(line)) failure = [line];
    };
    const read = chunk => {
      record(chunk);
      const text = pending + chunk.toString('utf8');
      const lines = text.split('\n');
      pending = lines.pop();
      for (const line of lines) { if (REUSED.test(line)) { reused++; note(line); } if (MAIN_RED.test(line)) mainRed++; cause(line); }
      tail = (tail + chunk.toString('utf8')).slice(-2000);
      if (keepAll()) all += chunk.toString('utf8');
    };
    child.stdout.on('data', read);
    child.stderr.on('data', chunk => {
      record(chunk);
      const lines = (errPending + chunk.toString('utf8')).split('\n');
      errPending = lines.pop();
      for (const line of lines) cause(line);
      tail = (tail + chunk.toString('utf8')).slice(-2000);
    });
    let settled = false;
    const clear = watchDeadline(child, deadline, limitMs => {
      if (settled) return undefined;
      settled = true;
      const result = { ok: false, timeout: true, detail: timeoutDetail(`the landing proof (${proof.files.length} files, ${reused} reused so far)`, limitMs, tail), proof: { files: proof.files.length, reused, ran: proof.files.length - reused } };
      return () => settle(result);
    });
    const finish = (ok, detail, waived = null, failures = null, failed = null) => {
      clear();
      if (settled) return;
      settled = true;
      if (REUSED.test(pending)) { reused++; note(pending); }
      if (MAIN_RED.test(pending)) mainRed++;
      settle({ ok, detail, ...(waived ? { waived } : {}), ...(failures ? { failures } : {}), ...(failed ? { failed } : {}), proof: { files: proof.files.length, reused, ran: proof.files.length - reused - mainRed, ...(mainRed ? { mainRed } : {}) } });
    };
    child.on('error', error => finish(false, String(error.message).slice(0, 300)));
    // After stdio closes, so the last refusal or failing line is read before the receipt is written.
    child.on('close', (code, signal) => {
      if (code === 0) return finish(true, null);
      const waived = projected.length && code === 1 && !refusal ? waivedRed(accountedRed(all, root), waivers, now()) : null;
      if (waived) return finish(true, null, waived);
      cause(pending); cause(errPending);
      // A red names its failing files first, so the reopen note and the landing log say which file broke [C7].
      // A launcher's own JSON refusal (no TAP at all) keeps its code and message, never a test-red wrapper.
      const native = !refusal && !/^(?:TAP version |\s*(?:not )?ok \d+)/mu.test(all) ? /"code":\s*"([A-Z][A-Z0-9_]+)"[\s\S]*?"message":\s*"((?:[^"\\]|\\.)*)"/u.exec(all) : null;
      if (native) refusal = `run-tests: [${native[1]}] ${native[2]}`;
      const first = (refusal ?? failure?.join('\n') ?? '').trim().slice(0, CAUSE_CHARS);
      const red = refusal ? { files: [], cases: [] } : redSummary(all, root);
      const named = red.files.length ? `red in ${red.files.slice(0, 5).join(', ')}${red.files.length > 5 ? ` (+${red.files.length - 5} more)` : ''}; ` : '';
      // Every failure named with its file, or none: what a land job's contracts compare with the base [C7,#7458].
      const failures = code === 1 && !refusal ? accountedRed(all, root) : null;
      const log = keepLog(root, command, full, env);
      const logLine = log ? `\nfull log: ${log}` : '';
      const failed = { files: red.files, cases: red.cases.slice(0, 200), ...(log ? { log } : {}) };
      finish(false, `landing proof exited ${code ?? signal}: ${named}${first ? `${first}\n… ` : ''}${tail.slice(-300)}${red.cases.length ? `\nfailing cases:\n${red.cases.join('\n').slice(0, 4000)}` : ''}${logLine}`, null, failures, failed);
    });
  });
}
