/** A separate process that keeps writing one unused row of a fixture board, so a test can watch what a waiting command does under other seats' writes [C7,#11794]. */
import { spawn } from 'node:child_process';

/** The writer's own program: one unused board_meta row, replaced every `every` ms until `for` ms have passed, then exit. */
const WRITER = [
  "import { DatabaseSync } from 'node:sqlite';",
  "const [file, every, until] = process.argv.slice(1);",
  "const db = new DatabaseSync(file);",
  "db.exec('PRAGMA busy_timeout = 5000');",
  "const end = Date.now() + Number(until);",
  "let count = 0;",
  "const timer = setInterval(() => {",
  "  if (Date.now() >= end) { clearInterval(timer); db.close(); return; }",
  "  try { db.exec(`INSERT OR REPLACE INTO board_meta (meta_key, meta_value) VALUES ('fixture_noise', '${count += 1}')`); } catch { /* a busy board skips this write */ }",
  "}, Number(every));",
].join('\n');

/**
 * Start the writer on a board file without waiting for it; changes nothing a seat can take.
 *
 * @param {string} file The board file.
 * @param {{ everyMs?: number, forMs?: number }} [options] The write interval and how long to keep writing.
 * @returns {Promise<{ code: number|null, err: string }>} The writer's exit, settled when it ends.
 */
export function startBoardWriter(file, { everyMs = 50, forMs = 5000 } = {}) {
  return new Promise((done, fail) => {
    const proc = spawn(process.execPath, ['--input-type=module', '-e', WRITER, file, String(everyMs), String(forMs)], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr.on('data', chunk => { err += chunk; });
    proc.on('error', fail);
    proc.on('close', code => done({ code, err }));
  });
}
