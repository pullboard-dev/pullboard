/** The land job's proof: run the items' ledger-proved test files on the merged tree, reusing every ledger hit [P7]. */
import { spawn } from 'node:child_process';

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
const CAUSE_LINES = 12, CAUSE_CHARS = 600;

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
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 * @returns {(context: { root: string }) => Promise<{ ok: boolean, detail: string | null, proof: { files: number, reused: number, ran: number, mainRed?: number } }>}
 */
export function ledgerProofCheck(proof, { env = process.env } = {}) {
  return ({ root }) => new Promise(resolve => {
    const clean = Object.fromEntries(Object.entries(env).filter(([name]) => !INHERITED.test(name)));
    const command = `${proof.runner} ${proof.files.map(file => shellWord(`./${file}`)).join(' ')}`;
    const child = spawn(command, { shell: true, cwd: root, stdio: ['pipe', 'pipe', 'pipe'], env: { ...clean, [LEDGER_HITS_ENV]: '/dev/stdin' } });
    child.stdin.on('error', () => { /* A runner that never reads its hit list just runs every file. */ });
    child.stdin.end(JSON.stringify(proof.ledger ?? { contexts: [], files: [] }));
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
    };
    child.stdout.on('data', read);
    child.stderr.on('data', chunk => {
      const lines = (errPending + chunk.toString('utf8')).split('\n');
      errPending = lines.pop();
      for (const line of lines) cause(line);
      tail = (tail + chunk.toString('utf8')).slice(-2000);
    });
    const finish = (ok, detail) => {
      if (REUSED.test(pending)) reused++;
      if (MAIN_RED.test(pending)) mainRed++;
      resolve({ ok, detail, proof: { files: proof.files.length, reused, ran: proof.files.length - reused - mainRed, ...(mainRed ? { mainRed } : {}) } });
    };
    child.on('error', error => finish(false, String(error.message).slice(0, 300)));
    // After stdio closes, so the last refusal or failing line is read before the receipt is written.
    child.on('close', (code, signal) => {
      if (code === 0) return finish(true, null);
      cause(pending); cause(errPending);
      const first = (refusal ?? failure?.join('\n') ?? '').trim().slice(0, CAUSE_CHARS);
      finish(false, `landing proof exited ${code ?? signal}: ${first ? `${first}\n… ` : ''}${tail.slice(-300)}`);
    });
  });
}
