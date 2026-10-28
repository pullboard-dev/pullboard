/** Bounded transport health observations never execute or certify a project's tests [C7]. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
