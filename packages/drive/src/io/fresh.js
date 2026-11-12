import { spawn } from 'node:child_process';

/**
 * Restart a long-running server on fresh code when the checkout it runs from moves to another commit (#6157).
 * The old process stops listening, lets in-flight requests finish for up to `drain` ms, then starts `command()`
 * (the same server on the same port) detached and settles `restarted`, so its caller exits.
 * Why: a process started before a landing lazily imports the landing's modules against the ones it loaded at start,
 * and from 12 Nov 12:15Z every board read failed that way until a hand restart; a fresh process loads one tree.
 * Leases live on the board, never in the process, so a runner's lease outlives the restart.
 *
 * @param {{ root: string, revision: () => string | null, close: () => Promise<unknown>, command: () => string[],
 *   interval?: number, drain?: number, log?: (line: string) => void, spawnProcess?: typeof spawn }} options
 *   revision reads the commit the code at root runs from, null when it cannot tell.
 * @returns {{ restarted: Promise<{ from: string, to: string, pid: number | undefined }>, stop: () => void }}
 */
export function restartOnCodeMove({ root, revision, close, command, interval = 5_000, drain = 20_000, log = (line) => process.stderr.write(line + '\n'), spawnProcess = spawn }) {
  const from = revision();
  let timer = null;
  let settle;
  const restarted = new Promise((done) => { settle = done; });
  const check = async () => {
    timer = null;
    const to = revision();
    if (!to || to === from) { schedule(); return; }
    log(`pullboard: the code at ${root} moved from ${from.slice(0, 10)} to ${to.slice(0, 10)}; restarting on the new code`);
    let drained;
    await Promise.race([close(), new Promise((done) => { drained = setTimeout(done, drain); })]);
    clearTimeout(drained);
    const [file, ...args] = command();
    const child = spawnProcess(file, args, { detached: true, stdio: 'inherit', env: process.env });
    child.unref();
    settle({ from, to, pid: child.pid });
  };
  const schedule = () => { timer = setTimeout(check, interval); timer.unref(); };
  // Code outside a Git checkout has no commit to watch: it serves as it did.
  if (from) schedule();
  return { restarted, stop: () => { if (timer) clearTimeout(timer); timer = null; } };
}
