/** Private runtime records that let an unattended CLI hand off its live view link. */
import { spawnSync } from './windows-child-process.js';
import { Refused } from './refused.js';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  join,
} from 'node:path';
import {
  LOOPBACK,
  lastPort,
} from './serve.js';
import { registryFile } from './projects.js';
import { fetchLocal } from './local-fetch.js';

/** The per-port record keeps the secret out of CLI output and mode 0600 on disk. */
function sessionFile(port) {
  return join(dirname(registryFile()), `view-${port}.json`);
}

/** Read a valid persisted session record, or return null when none is usable. */
function readSession(port) {
  try {
    const record = JSON.parse(readFileSync(sessionFile(port), 'utf8'));
    if (record.port !== port || !Number.isInteger(record.pid) || record.pid < 1
      || typeof record.secret !== 'string' || typeof record.boundAt !== 'string'
      || (record.scopeCommonDir !== undefined && (typeof record.scopeCommonDir !== 'string' || !record.scopeCommonDir))) return null;
    return record;
  } catch {
    return null;
  }
}

/** Atomically store a private session record and update the default port when auto-selected. */
export function rememberView(view, { rememberPort = false } = {}) {
  const file = sessionFile(view.port);
  const temporary = `${file}.${process.pid}.tmp`;
  const pointer = join(dirname(registryFile()), 'view.json');
  const pointerTemporary = `${pointer}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(temporary, `${JSON.stringify(view)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
    if (rememberPort) {
      writeFileSync(pointerTemporary, `${JSON.stringify({ port: view.port })}\n`, { mode: 0o600 });
      chmodSync(pointerTemporary, 0o600);
      renameSync(pointerTemporary, pointer);
    }
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch { /* Preserve the original failure. */ }
    try { rmSync(pointerTemporary, { force: true }); } catch { /* Preserve the original failure. */ }
    try { rmSync(file, { force: true }); } catch { /* Preserve the original failure. */ }
    throw error;
  }
}

/** Remove the record only when it still belongs to this process and port. */
export function forgetView(port) {
  try {
    if (readSession(port)?.pid === process.pid) rmSync(sessionFile(port), { force: true });
  } catch {
    // A stale record is harmless because reuse also checks the live process and HTTP response.
  }
}

/** Find an authenticated listener only when its saved project scope matches this caller. */
export async function runningView(port = 0, expectedScopeCommonDir = null) {
  const candidatePort = port || lastPort();
  const view = candidatePort ? readSession(candidatePort) : null;
  if (!view || (view.scopeCommonDir ?? null) !== (expectedScopeCommonDir ?? null)) return null;
  try {
    process.kill(view.pid, 0);
    const response = await fetchLocal(`http://${LOOPBACK}:${view.port}/api/v1/boards?k=${encodeURIComponent(view.secret)}`, {
      signal: AbortSignal.timeout(1_000),
      redirect: 'manual',
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const listing = await response.json();
    if (!Array.isArray(listing.boards) || !Array.isArray(listing.warnings)) return null;
    return { url: `http://${LOOPBACK}:${view.port}/?k=${view.secret}`, port: view.port, pid: view.pid, boundAt: view.boundAt };
  } catch {
    return null;
  }
}

/** Resolve a thread label to its program without exposing script paths or command arguments. */
function listenerProgram(pid, listedName) {
  if (!/^(?:node-)?MainThread$/u.test(listedName)) return listedName;
  try {
    let command;
    if (process.platform === 'linux') {
      command = readFileSync(`/proc/${pid}/cmdline`).toString('utf8').split('\0', 1)[0];
    } else {
      // macOS comm is the executable path, so spaces in that path are not mistaken for arguments.
      const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8', timeout: 2_000 });
      if (result.status !== 0) return 'a program';
      command = result.stdout;
    }
    return basename(String(command).trim()).replace(/[\u0000-\u001f\u007f]/gu, '').trim() || 'a program';
  } catch { return 'a program'; }
}

/**
 * Name the process listening on a loopback port, when this machine can tell. Only the system's
 * listener table (lsof) can say who owns a port: a recorded view pid that is still alive may be a
 * reused pid, so the record only labels a listener lsof already confirmed. Without lsof, or when
 * it names no listener, this returns null and the caller gives the fix without a pid.
 * Only the pid and the executable's own name are kept, since arguments can carry secrets.
 *
 * @param {number} port
 * @returns {{ pid: number, name: string } | null}
 */
export function portHolder(port) {
  return readPortHolder(port).holder;
}

/** Inspect only a listener's public identity; nonblocking filesystem probes keep dead mounts out of port diagnosis. */
function readPortHolder(port) {
  /** Keep the failed target and OS code, never process arguments or arbitrary tool output. */
  const unavailable = reason => ({ holder: null, issue: `could not read the listener on port ${port} (lsof ${reason})` });
  const lsof = ['/usr/sbin/lsof', '/usr/bin/lsof'].find((file) => existsSync(file));
  if (!lsof) return unavailable('not installed');
  const listed = spawnSync(lsof, ['-b', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'], { encoding: 'utf8', timeout: 2_000 });
  if (listed.error || listed.status !== 0) return unavailable(listed.error?.code ?? `exit ${listed.status}`);
  const pids = [...String(listed.stdout ?? '').matchAll(/^p(\d+)$/gmu)].map((match) => Number(match[1]));
  if (pids.length !== 1 || !Number.isInteger(pids[0]) || pids[0] < 1) return unavailable('no single listener reported');
  const pid = pids[0];
  if (readSession(port)?.pid === pid) return { holder: { pid, name: 'pullboard view' }, issue: '' };
  const listedName = /^c(.+)$/mu.exec(listed.stdout)?.[1]?.trim() || 'a program';
  return { holder: { pid, name: listenerProgram(pid, listedName) }, issue: '' };
}

/** Keep the original busy-port recovery while naming a failed listener lookup instead of inventing a process to stop. */
export function busyViewPortRefusal(port, hosted) {
  if (!hosted) return new Refused('PORT_BUSY', `port ${port} is in use: name another with --port N, or use --port 0 to take a free one`);
  const { holder, issue } = readPortHolder(port);
  const stop = holder && (process.platform === 'win32' ? `taskkill /PID ${holder.pid} /T` : `kill ${holder.pid}`);
  const identity = holder ? ` by ${holder.name} (pid ${holder.pid})` : issue ? ` (${issue})` : '';
  return new Refused('PORT_BUSY', `port ${port} is in use${identity}, and pullboard.dev looks for your view on that port: stop ${holder ? `it with ${stop}` : 'the other view there'}, then run pullboard view again`);
}
