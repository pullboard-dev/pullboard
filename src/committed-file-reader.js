/** Read pinned committed text files through one fresh Git batch, never a candidate's working bytes [N19,D1]. */
import { spawn } from './windows-child-process.js';
import { cleanGitEnvironment } from './git.js';
import { Refused } from './refused.js';

/** Keep one child for sequential dependent file requests, and drain it on success or the original read failure. */
export async function withCommittedFiles(root, action) {
  const child = spawn('git', ['--no-replace-objects', 'cat-file', '--batch'], {
    cwd: root, env: cleanGitEnvironment(), stdio: ['pipe', 'pipe', 'pipe'],
  });
  const finished = new Promise(resolve => {
    child.once('error', error => resolve({ error }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  // The read/exit result reports a broken pipe without an unrelated unhandled stream error.
  child.stdin.on('error', () => {});
  child.stderr.resume();
  const chunks = child.stdout[Symbol.asyncIterator]();
  let buffer = Buffer.alloc(0);
  let failed = false;
  const files = new Map();
  /** Collect exactly the bytes the Git header declares, retaining anything for the next frame. */
  async function bytes(size) {
    while (buffer.length < size) {
      const chunk = await chunks.next();
      if (chunk.done) throw new Refused('NO_POLICY', 'committed resume sources could not be read; inspect them with pullboard resume --diagnostics');
      buffer = Buffer.concat([buffer, chunk.value]);
    }
    const result = buffer.subarray(0, size);
    buffer = buffer.subarray(size);
    return result;
  }
  /** Read a bounded metadata line without treating file contents as Git protocol. */
  async function header() {
    for (;;) {
      const end = buffer.indexOf(10);
      if (end >= 0) return (await bytes(end + 1)).subarray(0, end).toString('utf8');
      if (buffer.length > 8192) throw new Refused('NO_POLICY', 'the committed-file response header is invalid; run pullboard doctor');
      const chunk = await chunks.next();
      if (chunk.done) throw new Refused('NO_POLICY', 'the committed-file reader stopped; inspect the project with pullboard doctor');
      buffer = Buffer.concat([buffer, chunk.value]);
    }
  }
  /** Request only an exact commit and one ordinary file path; a missing blob keeps existing fallback behavior. */
  async function readOne(commit, file) {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(commit ?? '') || typeof file !== 'string' || /[\r\n\0]/u.test(file)) {
      throw new Refused('NO_POLICY', 'the committed resume source is not a valid file reference; run pullboard resume --diagnostics');
    }
    const key = `${commit}:${file}`;
    if (files.has(key)) return files.get(key);
    child.stdin.write(`${key}\n`);
    const line = await header();
    if (line === `${key} missing`) { files.set(key, null); return null; }
    const matched = /^(?:[0-9a-f]{40}|[0-9a-f]{64}) blob ([0-9]+)$/u.exec(line);
    const size = matched ? Number(matched[1]) : NaN;
    if (!Number.isSafeInteger(size) || size < 0 || size > 32 * 1024 * 1024) {
      throw new Refused('NO_POLICY', 'the committed resume source is not a bounded regular file; run pullboard resume --diagnostics');
    }
    const source = (await bytes(size)).toString('utf8');
    if ((await bytes(1))[0] !== 10) throw new Refused('NO_POLICY', 'the committed-file response is incomplete; run pullboard doctor');
    files.set(key, source);
    return source;
  }
  let pending = Promise.resolve();
  /** Serialize requests so concurrent consumers cannot cross the batch response frames. */
  function read(commit, file) {
    const result = pending.then(() => readOne(commit, file));
    pending = result.catch(() => {});
    return result;
  }
  try { return await action(read); }
  catch (error) { failed = true; throw error; }
  finally {
    await pending;
    child.stdin.end();
    let drainError;
    try {
      // The iterator retains ownership of stdout even after a rejected frame; resume() does not drain it.
      while (!(await chunks.next()).done) { /* Discard remaining framed bytes after input closes. */ }
    } catch (error) { drainError = error; }
    const result = await finished;
    if (!failed && (drainError || result.error || result.code !== 0)) throw new Refused('NO_POLICY', 'the committed-file reader failed; inspect the project with pullboard resume --diagnostics');
  }
}
