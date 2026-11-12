/** The land job's proof: run the items' ledger-proved test files on the merged tree, reusing every ledger hit [P7]. */
import { spawn } from 'node:child_process';

// The run-tests ledger variable (packages/gate LEDGER_HITS_ENV), named here so the runner bundle stays free of the gate package.
const LEDGER_HITS_ENV = 'PULLBOARD_LEDGER_HITS';
// An enclosing run's reuse, stage, store or hit settings never reach the landing proof: it plans from its own checkout.
const INHERITED = /^PULLBOARD_(TEST_(ACTIONS|STAGE|REUSE|RESULT_\w+)|LEDGER_HITS)$/u;
const REUSED = /^# reused [0-9a-f]{64} from ledger \(/u;

/** Quote one word for the shell the runner command runs in. */
function shellWord(word) {
  return /^[\w./@:=+-]+$/u.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

/**
 * The landing check that proves `proof.files` on the merged tree: the project's runner command over those files, with
 * the board's hit list, so run-tests reuses a file whose inputKey and context class a ledger row proved and runs only
 * the misses. A file whose import closure main changed has a new inputKey, so it misses and runs. The hit list goes in
 * on the run's stdin, never as a file: run-tests reuses nothing in a dirty tree, and the runner keeps no state file.
 *
 * @param {{ runner: string, files: string[], ledger?: { contexts: string[], files: Array<[string, string, number]> } | null }} proof
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 * @returns {(context: { root: string }) => Promise<{ ok: boolean, detail: string | null, proof: { files: number, reused: number, ran: number } }>}
 */
export function ledgerProofCheck(proof, { env = process.env } = {}) {
  return ({ root }) => new Promise(resolve => {
    const clean = Object.fromEntries(Object.entries(env).filter(([name]) => !INHERITED.test(name)));
    const command = `${proof.runner} ${proof.files.map(file => shellWord(`./${file}`)).join(' ')}`;
    const child = spawn(command, { shell: true, cwd: root, stdio: ['pipe', 'pipe', 'pipe'], env: { ...clean, [LEDGER_HITS_ENV]: '/dev/stdin' } });
    child.stdin.on('error', () => { /* A runner that never reads its hit list just runs every file. */ });
    child.stdin.end(JSON.stringify(proof.ledger ?? { contexts: [], files: [] }));
    let tail = '', reused = 0, pending = '';
    const read = chunk => {
      const text = pending + chunk.toString('utf8');
      const lines = text.split('\n');
      pending = lines.pop();
      for (const line of lines) if (REUSED.test(line)) reused++;
      tail = (tail + text).slice(-2000);
    };
    child.stdout.on('data', read);
    child.stderr.on('data', chunk => { tail = (tail + chunk.toString('utf8')).slice(-2000); });
    const finish = (ok, detail) => {
      if (REUSED.test(pending)) reused++;
      resolve({ ok, detail, proof: { files: proof.files.length, reused, ran: proof.files.length - reused } });
    };
    child.on('error', error => finish(false, String(error.message).slice(0, 300)));
    child.on('exit', (code, signal) => finish(code === 0, code === 0 ? null : `landing proof exited ${code ?? signal}: ${tail.slice(-300)}`));
  });
}
