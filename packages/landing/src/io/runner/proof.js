/** The land job's proof: run the items' ledger-proved test files on the merged tree, reusing every ledger hit [P7]. */
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { relative } from 'node:path';

// The run-tests ledger variable (packages/gate LEDGER_HITS_ENV), named here so the runner bundle stays free of the gate package.
const LEDGER_HITS_ENV = 'PULLBOARD_LEDGER_HITS';
// An enclosing run's reuse, stage, store or hit settings never reach the landing proof: it plans from its own checkout.
const INHERITED = /^PULLBOARD_(TEST_(ACTIONS|STAGE|REUSE|RESULT_\w+)|LEDGER_HITS)$/u;
const REUSED = /^# reused [0-9a-f]{64} from ledger \(/u;
// A file main fails at its identical inputKey: charged to main, never run, so it holds no landing [P7].
const MAIN_RED = /^# main red [0-9a-f]{64} from ledger \(/u;
// A run-tests refusal ("run-tests: [NO_POLICY] ...") or a failing test ("not ok 3 - name" and its error lines): the red's cause [P7].
const REFUSAL = /^run-tests: \[[A-Z][A-Z0-9_]*\]/u;
const NOT_OK = /^\s*not ok \d+/u;
// The run-tests waiver variable (packages/gate LANDING_WAIVERS_ENV): a run keeps going past a failure a live waiver covers.
const LANDING_WAIVERS_ENV = 'PULLBOARD_LANDING_WAIVERS';
const CAUSE_LINES = 12, CAUSE_CHARS = 600;

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
 * @param {{ env?: NodeJS.ProcessEnv, waivers?: { id: string, kind: string, test: string, until: string }[], now?: () => number }} [options] - waivers: the job's payload waivers.
 * @returns {(context: { root: string }) => Promise<{ ok: boolean, detail: string | null, waived?: { file: string, name: string, waiver: string }[], proof: { files: number, reused: number, ran: number, mainRed?: number } }>}
 */
export function ledgerProofCheck(proof, { env = process.env, waivers = [], now = Date.now } = {}) {
  return ({ root }) => new Promise(resolve => {
    const clean = Object.fromEntries(Object.entries(env).filter(([name]) => !INHERITED.test(name)));
    const command = `${proof.runner} ${proof.files.map(file => shellWord(`./${file}`)).join(' ')}`;
    const projected = waivers.map(({ kind, test }) => ({ kind, test }));
    const child = spawn(command, { shell: true, cwd: root, stdio: ['pipe', 'pipe', 'pipe'], env: { ...clean, [LEDGER_HITS_ENV]: '/dev/stdin', ...(projected.length ? { [LANDING_WAIVERS_ENV]: JSON.stringify(projected) } : {}) } });
    child.stdin.on('error', () => { /* A runner that never reads its hit list just runs every file. */ });
    child.stdin.end(JSON.stringify(proof.ledger ?? { contexts: [], files: [] }));
    // The whole TAP (stdout) is kept only when waivers could cover a red, to account every failure.
    let all = '';
    let tail = '', reused = 0, mainRed = 0, pending = '', errPending = '';
    // The first refusal wins over any failing test; a failing test keeps its name and the error lines after it.
    let refusal = null, failure = null, closed = false;
    const cause = line => {
      if (!refusal && REFUSAL.test(line)) refusal = line;
      else if (failure && !closed) { failure.push(line); closed = failure.length >= CAUSE_LINES || line.trim() === '...'; }
      else if (!failure && NOT_OK.test(line)) failure = [line];
    };
    const read = chunk => {
      const text = pending + chunk.toString('utf8');
      const lines = text.split('\n');
      pending = lines.pop();
      for (const line of lines) { if (REUSED.test(line)) reused++; if (MAIN_RED.test(line)) mainRed++; cause(line); }
      tail = (tail + chunk.toString('utf8')).slice(-2000);
      if (projected.length) all += chunk.toString('utf8');
    };
    child.stdout.on('data', read);
    child.stderr.on('data', chunk => {
      const lines = (errPending + chunk.toString('utf8')).split('\n');
      errPending = lines.pop();
      for (const line of lines) cause(line);
      tail = (tail + chunk.toString('utf8')).slice(-2000);
    });
    const finish = (ok, detail, waived = null) => {
      if (REUSED.test(pending)) reused++;
      if (MAIN_RED.test(pending)) mainRed++;
      resolve({ ok, detail, ...(waived ? { waived } : {}), proof: { files: proof.files.length, reused, ran: proof.files.length - reused - mainRed, ...(mainRed ? { mainRed } : {}) } });
    };
    child.on('error', error => finish(false, String(error.message).slice(0, 300)));
    // After stdio closes, so the last refusal or failing line is read before the receipt is written.
    child.on('close', (code, signal) => {
      if (code === 0) return finish(true, null);
      const waived = projected.length && code === 1 && !refusal ? waivedRed(accountedRed(all, root), waivers, now()) : null;
      if (waived) return finish(true, null, waived);
      cause(pending); cause(errPending);
      const first = (refusal ?? failure?.join('\n') ?? '').trim().slice(0, CAUSE_CHARS);
      finish(false, `landing proof exited ${code ?? signal}: ${first ? `${first}\n… ` : ''}${tail.slice(-300)}`);
    });
  });
}
