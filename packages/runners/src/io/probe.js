/** The controller-side SSH health probe, apart from the transport the worker loads so the worker bundle leaves out its SSH and GUI-session closure [C7]. */
import { environmentAdapter } from '../../../env/index.js';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { spawnSsh } from '../../../transport/index.js';
import { guiSession } from '../../../gate/light.js';

/** Give a health observation the same credential-forwarding limits as a worker connection. */
function environment(source = environmentAdapter()) {
  const env = { LC_ALL: 'C', LANG: 'C', TZ: 'UTC' };
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SSH_AUTH_SOCK', 'TMPDIR', 'SystemRoot', 'WINDIR']) {
    if (source.has(key)) env[key] = source.get(key);
  }
  return env;
}

/**
 * Compare a runner's declared toolchains with the versions its probe reported.
 * Why: a job is admitted only where every toolchain exists, so a recorded toolchain must be one the runner really answers;
 * an empty declared version means any version serves, "22" serves 22.x.y, and "3.12" serves 3.12.z [C7].
 *
 * @param {Record<string, string>} declared - Toolchain name to declared version.
 * @param {Record<string, string | null> | undefined} reported - Toolchain name to the version the runner printed, or null when it did not answer.
 * @returns {{ verified: Record<string, string>, problems: { name: string, problem: 'missing' | 'wrong version', declared: string, found: string | null }[] }}
 */
export function toolchainVerdict(declared, reported) {
  const verified = {}, problems = [];
  for (const [name, want] of Object.entries(declared ?? {})) {
    const found = typeof reported?.[name] === 'string' ? reported[name] : null;
    if (found === null) problems.push({ name, problem: 'missing', declared: want, found });
    else if (want !== '' && found !== want && !found.startsWith(`${want}.`)) problems.push({ name, problem: 'wrong version', declared: want, found });
    else verified[name] = want;
  }
  return { verified, problems };
}

/** The fixed toolchain names a runner is asked about when none are declared by hand. */
export const DISCOVERABLE_TOOLCHAINS = Object.freeze(['python3', 'go', 'cargo', 'ruby', 'swift', 'java', 'mvn', 'gradle', 'deno', 'bun', 'php', 'mix', 'dotnet', 'cmake', 'ctest']);

/** The flag that prints a version: go and java do not take --version. */
const VERSION_FLAG = { go: 'version', java: '-version' };

/**
 * Find cargo through rustup when it is not on PATH, and return its version answer.
 * Why: Homebrew's rustup is keg-only, so cargo sits in a folder the job PATH lacks (#10386); asked only after the PATH answer failed [C7].
 */
function viaRustup(spawn) {
  try {
    const which = spawn('rustup', ['which', 'cargo'], { encoding: 'utf8', timeout: 1500 });
    const path = which && !which.error && which.status === 0 ? String(which.stdout ?? '').trim() : '';
    if (!isAbsolute(path) || /[\u0000-\u001f\u007f]/u.test(path)) return null;
    return spawn(path, ['--version'], { encoding: 'utf8', timeout: 1500 });
  } catch { return null; }
}

/**
 * Ask each known toolchain name for its version through the injected spawn and return name to version for those that answer.
 * Why: toolchains are declared by hand today, so most runners declare none and admission cannot route a Python job to the runner that has python3.
 * A command that is missing, exits non-zero, times out or prints no version is left out, never recorded empty [C7].
 *
 * @param {{ spawn?: (name: string, args: string[], options: object) => { status: number | null, stdout?: string, stderr?: string, error?: Error } }} [options] spawn defaults to child_process.spawnSync
 * @returns {Record<string, string>}
 */
export function discoverToolchains({ spawn = spawnSync } = {}) {
  const found = {};
  for (const name of DISCOVERABLE_TOOLCHAINS) {
    let result;
    try { result = spawn(name, [VERSION_FLAG[name] ?? '--version'], { encoding: 'utf8', timeout: 1500 }); } catch { continue; }
    if (name === 'cargo' && (!result || result.error || result.status !== 0)) result = viaRustup(spawn);
    if (!result || result.error || result.status !== 0) continue;
    const version = /\d+(?:\.\d+)+/u.exec(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)?.[0];
    if (version) found[name] = version;
  }
  return found;
}

/** Quote one configured executable without interpreting its contents as remote shell code. */
function word(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

/**
 * Confirm SSH and the configured Node answer a fresh nonce; this does not attest worker cleanup or test success.
 * `discover` asks the runner about every name in DISCOVERABLE_TOOLCHAINS and returns the versions it answered as `discovered` (#10376).
 * `timeoutMs` bounds the whole observation (default 3 s); a confirming probe after a failed call passes a longer
 * budget so a loaded runner is not mistaken for a dead one [C7].
 */
export async function probeRunnerTransport(runner, { observeGui = false, observeLoad = false, discoverNode = false, enrollSigningKey = false, toolchains, discover = false, timeoutMs = 3_000, spawn = spawnSsh } = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.@:\[\]-]{0,254}$/u.test(runner?.host ?? '')
    || runner.node !== undefined && (typeof runner.node !== 'string' || /[\u0000-\u001f\u007f]/u.test(runner.node)
      || !(runner.node === 'node' || runner.node.startsWith('/')))) {
    return { healthy: false, reason: 'invalid runner destination' };
  }
  const nonce = randomUUID();
  const names = discover ? [...DISCOVERABLE_TOOLCHAINS] : toolchains ? Object.keys(toolchains).filter(name => /^[a-z][a-z0-9+_-]{0,31}$/u.test(name)) : [];
  // Each declared toolchain prints its own version; a missing or failing command reports null.
  const checks = names.length ? `const tcRun=require('node:child_process');const tcOut={};for(const n of ${JSON.stringify(names)}){const r=tcRun.spawnSync(n,[n==='go'?'version':'--version'],{encoding:'utf8',timeout:1500});const m=r.error||r.status!==0?null:/(\\d+(?:\\.\\d+)*)/.exec((r.stdout||'')+(r.stderr||''));tcOut[n]=m?m[1]:null;}` : '';
  const desktop = observeGui || observeLoad || enrollSigningKey ? `/* pullboard registration GUI probe */const {spawnSync}=require('node:child_process');const guiSession=${guiSession.toString()};const os=require('node:os');` : '';
  // The signing snippet runs on the runner and reads the runner's own environment, not this process's.
  const signing = enrollSigningKey ? `const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');const remote=process['env'];const signingHome=remote.PULLBOARD_MACHINE_HOME||path.join(remote.HOME||os.homedir(),'.pullboard');if(!path.isAbsolute(signingHome))throw new Error('runner signing home must be absolute');fs.mkdirSync(signingHome,{recursive:true,mode:0o700});fs.chmodSync(signingHome,0o700);const pair=crypto.generateKeyPairSync('ed25519');const der=pair.publicKey.export({type:'spki',format:'der'});const enrolledPublicKey=der.toString('base64url');const keyId=crypto.createHash('sha256').update(der).digest('hex');const keyPath=path.join(signingHome,'runner-signing-'+keyId+'.pem');const temporary=keyPath+'.'+crypto.randomUUID()+'.tmp';try{fs.writeFileSync(temporary,pair.privateKey.export({type:'pkcs8',format:'pem'}),{flag:'wx',mode:0o600});fs.renameSync(temporary,keyPath);fs.chmodSync(keyPath,0o600);}finally{fs.rmSync(temporary,{force:true});}` : '';
  const answer = `process.stdout.write(JSON.stringify({nonce:${JSON.stringify(nonce)},node:process.versions.node${discoverNode || enrollSigningKey ? ',nodePath:process.execPath' : ''}${enrollSigningKey ? ",runtimeSha256:crypto.createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex')" : ''}${observeGui ? ',gui:guiSession(),cores:os.availableParallelism(),memoryMB:Math.floor(os.totalmem()/1048576)' : ''}${observeLoad ? ',cpuLoad:{at:new Date().toISOString(),busyPercent:busy,average:os.loadavg()}' : ''}${enrollSigningKey ? ',publicKey:enrolledPublicKey' : ''}${names.length ? ',toolchains:tcOut' : ''}}))`;
  // Both snapshots run on the destination; controller CPU counters never stand in for a runner.
  const script = observeLoad ? `${desktop}${signing}${checks}const first=os.cpus();setTimeout(()=>{const last=os.cpus();let idle=0,total=0;for(let i=0;i<last.length;i++){if(!first[i])continue;for(const key of Object.keys(last[i].times)){const delta=last[i].times[key]-first[i].times[key];total+=delta;if(key==='idle')idle+=delta;}}const busy=total>0?100*(1-idle/total):null;${answer}},100);` : `${desktop}${signing}${checks}${answer}`;
  const command = `${word(runner.node ?? 'node')}${observeGui || observeLoad || names.length ? ' --input-type=commonjs' : ''} -e ${word(script)}`;
  const remote = discoverNode ? 'exec "${SHELL:-/bin/sh}" -lc ' + word(command) : command;
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes',
    '-o', 'SendEnv=-*', '-o', `ConnectTimeout=${Math.max(2, Math.floor(timeoutMs / 1_000) - 1)}`, '--', runner.host, remote];
  const child = spawn(args, { env: environment(), stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', error = null, timedOut = false, kill;
  /** Keep a misbehaving transport bounded without changing any native execution budget. */
  const stop = () => {
    child.kill('SIGTERM');
    kill ??= setTimeout(() => child.kill('SIGKILL'), 500);
  };
  const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
  child.stdout.on('data', bytes => { stdout = (stdout + bytes).slice(0, 4097); if (stdout.length > 4096) stop(); });
  child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-4096); });
  child.once('error', failure => { error = failure.code ?? failure.name; });
  const result = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  clearTimeout(timer); clearTimeout(kill);
  let reply;
  try { reply = JSON.parse(stdout); } catch { /* A missing or foreign answer is unknown health. */ }
  const version = /^(\d+)\.(\d+)\./u.exec(reply?.node ?? '');
  const healthy = !error && !timedOut && result.code === 0 && !result.signal && reply?.nonce === nonce
    && version && (Number(version[1]) > 22 || Number(version[1]) === 22 && Number(version[2]) >= 13)
    && (!enrollSigningKey || typeof reply?.publicKey === 'string' && /^[A-Za-z0-9_-]{59}$/u.test(reply.publicKey));
  const cpu = reply?.cpuLoad;
  const measured = cpu && Number.isFinite(Date.parse(cpu.at)) && Number.isFinite(cpu.busyPercent) && cpu.busyPercent >= 0 && cpu.busyPercent <= 100
    && Array.isArray(cpu.average) && cpu.average.length === 3 && cpu.average.every(n => Number.isFinite(n) && n >= 0);
  // Arbitrary stderr is deliberately not returned by a health-only probe; the failed job retains its sanitized diagnostics.
  return { healthy: Boolean(healthy), ...(healthy && toolchains && !discover ? { toolchains: toolchainVerdict(toolchains, reply?.toolchains) } : {}), ...(healthy && discover ? { discovered: Object.fromEntries(DISCOVERABLE_TOOLCHAINS.flatMap(name => typeof reply?.toolchains?.[name] === 'string' ? [[name, reply.toolchains[name]]] : [])) } : {}), ...(healthy && (discoverNode || enrollSigningKey) && typeof reply?.nodePath === 'string' && isAbsolute(reply.nodePath) && !/[\u0000-\u001f\u007f]/u.test(reply.nodePath) ? { nodePath: reply.nodePath } : {}), ...(healthy && enrollSigningKey ? { publicKey: reply.publicKey } : {}), ...(healthy && enrollSigningKey && /^[a-f0-9]{64}$/u.test(reply?.runtimeSha256 ?? '') ? { runtimeSha256: reply.runtimeSha256 } : {}), ...(healthy && observeLoad && measured ? { cpuLoad: cpu } : {}), ...(observeGui ? { gui: healthy && typeof reply?.gui === 'boolean' ? reply.gui : null,
    ...(healthy && Number.isSafeInteger(reply?.cores) && reply.cores > 0 && Number.isSafeInteger(reply?.memoryMB) && reply.memoryMB > 0 ? { cores: reply.cores, memoryMB: reply.memoryMB } : {}) } : {}), command: ['ssh', ...args.slice(0, -1), `${runner.node ?? 'node'} [nonce health observation]`],
    ...result, error, timedOut, stderrBytes: Buffer.byteLength(stderr), reason: healthy ? 'configured Node answered nonce' : 'transport health not confirmed' };
}
