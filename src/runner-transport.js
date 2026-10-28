/** Bounded transport health observations never execute or certify a project's tests [C7]. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { guiSession } from './gui-session.js';

/** Give a health observation the same credential-forwarding limits as a worker connection. */
function environment() {
  const env = { LC_ALL: 'C', LANG: 'C', TZ: 'UTC' };
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SSH_AUTH_SOCK', 'TMPDIR', 'SystemRoot', 'WINDIR']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

/** Quote one configured executable without interpreting its contents as remote shell code. */
function word(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

/** Confirm SSH and the configured Node answer a fresh nonce; this does not attest worker cleanup or test success. */
export async function probeRunnerTransport(runner, { observeGui = false } = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.@:\[\]-]{0,254}$/u.test(runner?.host ?? '')
    || runner.node !== undefined && (typeof runner.node !== 'string' || /[\u0000-\u001f\u007f]/u.test(runner.node)
      || !(runner.node === 'node' || runner.node.startsWith('/')))) {
    return { healthy: false, reason: 'invalid runner destination' };
  }
  const nonce = randomUUID();
  const desktop = observeGui ? `/* pullboard registration GUI probe */const {spawnSync}=require('node:child_process');const guiSession=${guiSession.toString()};` : '';
  const script = `${desktop}process.stdout.write(JSON.stringify({nonce:${JSON.stringify(nonce)},node:process.versions.node${observeGui ? ',gui:guiSession()' : ''}}))`;
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes',
    '-o', 'SendEnv=-*', '-o', 'ConnectTimeout=2', '--', runner.host,
    `${word(runner.node ?? 'node')}${observeGui ? ' --input-type=commonjs' : ''} -e ${word(script)}`];
  const child = spawn('ssh', args, { env: environment(), stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', error = null, timedOut = false, kill;
  /** Keep a misbehaving transport bounded without changing any native execution budget. */
  const stop = () => {
    child.kill('SIGTERM');
    kill ??= setTimeout(() => child.kill('SIGKILL'), 500);
  };
  const timer = setTimeout(() => { timedOut = true; stop(); }, 3_000);
  child.stdout.on('data', bytes => { stdout = (stdout + bytes).slice(0, 4097); if (stdout.length > 4096) stop(); });
  child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-4096); });
  child.once('error', failure => { error = failure.code ?? failure.name; });
  const result = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  clearTimeout(timer); clearTimeout(kill);
  let reply;
  try { reply = JSON.parse(stdout); } catch { /* A missing or foreign answer is unknown health. */ }
  const version = /^(\d+)\.(\d+)\./u.exec(reply?.node ?? '');
  const healthy = !error && !timedOut && result.code === 0 && !result.signal && reply?.nonce === nonce
    && version && (Number(version[1]) > 22 || Number(version[1]) === 22 && Number(version[2]) >= 13);
  // Arbitrary stderr is deliberately not returned by a health-only probe; the failed job retains its sanitized diagnostics.
  return { healthy: Boolean(healthy), ...(observeGui ? { gui: healthy && typeof reply?.gui === 'boolean' ? reply.gui : null } : {}), command: ['ssh', ...args.slice(0, -1), `${runner.node ?? 'node'} [nonce health observation]`],
    ...result, error, timedOut, stderrBytes: Buffer.byteLength(stderr), reason: healthy ? 'configured Node answered nonce' : 'transport health not confirmed' };
}

/** Accept only controller-issued exact-job identities; absence is legacy custody, never proof of cleanup. */
export function recoveryIdentity(value) {
  return value?.version === 1 && /^[A-Za-z0-9_-]{1,100}$/u.test(value.request ?? '')
    && /^[a-f0-9-]{36}$/u.test(value.nonce ?? '') && /^[a-f0-9]{64}$/u.test(value.tooling ?? '');
}

/** Persist an exact job completion only after its worker has verified descendants, groups and lease release. */
export function recordRunnerCompletion(root, identity) {
  if (!recoveryIdentity(identity)) return;
  const directory = join(root, 'recovery');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, identity.request + '.json');
  const temporary = file + '.tmp';
  writeFileSync(temporary, JSON.stringify({ ...identity, clean: true }) + '\n', { mode: 0o600 });
  renameSync(temporary, file);
}

/** A fresh worker answers readiness and reads only the exact completion requested by its controller. */
export function runnerHealthReply(root, request) {
  const base = { version: 1, nonce: request?.nonce, worker: true, cleanup: false };
  const identities = Array.isArray(request?.previous) ? request.previous : [request?.previous];
  if (!identities.length || identities.length > 128 || !identities.every(recoveryIdentity)) return { ...base, reason: 'missing exact request ID or completion record' };
  for (const identity of identities) {
    try {
      const file = join(root, 'recovery', identity.request + '.json');
      if (!statSync(file).isFile() || statSync(file).size > 4096) return { ...base, reason: 'invalid exact completion record' };
      const actual = JSON.parse(readFileSync(file, 'utf8'));
      if (actual.clean === true && recoveryIdentity(actual)
        && ['request', 'nonce', 'tooling'].every(key => actual[key] === identity[key])) {
        continue;
      }
    } catch { /* A missing or unreadable certificate never means that the old job drained. */ }
    return { ...base, reason: 'missing exact completion record' };
  }
  return { ...base, cleanup: true, reason: 'exact worker cleanup completed' };
}
