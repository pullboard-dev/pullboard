/** A private SSH stand-in executes the pinned runner capsule without contacting a host [C7,O5]. */
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SECRET = ['fixture', 'runner', 'secret', 'must', 'stay', 'local'].join('-');
export const HOST = 'fixture-host';

/** Quote one literal value for the fixture's POSIX shell command. */
export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/**
 * Make a local ssh stand-in that executes the actual worker command in a second private machine.
 * It appends "dispatched" and "returned" to <requests>.phases so a round trip can be timed by phase,
 * and `hold` ('dispatch', 'run' or 'return') keeps it alive at that phase, as a stuck runner would.
 * `stderrLog` also copies the worker's stderr, so a test can read its result receipt, and `nodeOptions` reaches the
 * worker's own Node process, so a test can force an ordering inside it.
 */
export function installSshStandIn({ bin, worker, home, machineHome, requests, starts, nodeCommand = 'node', dropFirst = false, healthDown = false, dropAfterMarker, hold = '', stderrLog, nodeOptions = '', invalidSpec = false }) {
  const ssh = join(bin, 'ssh');
  const source = `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
const argv = process.argv.slice(2);
const divider = argv.indexOf('--');
const host = divider >= 0 ? argv[divider + 1] : '';
const remoteCommand = divider >= 0 ? argv[divider + 2] : '';
const requests = ${JSON.stringify(requests)};
const starts = ${JSON.stringify(starts ?? '')};
const worker = ${JSON.stringify(worker)};
const home = ${JSON.stringify(home)};
const machineHome = ${JSON.stringify(machineHome)};
const configuredNode = ${JSON.stringify(`${shellQuote(nodeCommand)} --input-type=module -e `)};
const dropAfterMarker = ${JSON.stringify(dropAfterMarker ?? '')};
const secret = ${JSON.stringify(SECRET)};
const call = existsSync(requests) ? readFileSync(requests, 'utf8').split('\\n').filter(Boolean).length + 1 : 1;
const stdinHash = createHash('sha256');
let stdinBytes = 0;
process.stdin.on('data', part => { stdinBytes += part.length; stdinHash.update(part); });
const record = extra => appendFileSync(requests, JSON.stringify({ call, host,
  options: divider < 0 ? [] : argv.slice(0, divider), remoteHasSecret: remoteCommand.includes(secret),
  framed: divider >= 0 && argv[divider] === '--', remoteCommandPresent: Boolean(remoteCommand),
  remoteStartsWithConfiguredNode: remoteCommand.startsWith(configuredNode),
  remoteHasLocalPath: remoteCommand.includes(${JSON.stringify(worker)}),
  remoteHasSourceHome: remoteCommand.includes(${JSON.stringify(home)}),
  remoteHasSourceMachineHome: remoteCommand.includes(${JSON.stringify(machineHome)}), ...extra }) + '\\n');
/** Wait for the concrete setup marker and allow a finished worker to cancel its wait. */
const waitForMarker = path => {
  let cancel = () => {};
  const promise = new Promise((resolve, reject) => {
    if (existsSync(path)) return resolve(true);
    let poll, timer;
    let settled = false;
    const finish = (error, found = true) => {
      if (settled) return;
      settled = true;
      clearInterval(poll); clearTimeout(timer); error ? reject(error) : resolve(found);
    };
    cancel = () => finish(null, false);
    const check = () => { if (existsSync(path)) finish(); };
    poll = setInterval(check, 20); // budget: observe actual setup readiness without relying on notifications.
    timer = setTimeout(() => finish(new Error('setup marker hang ceiling exceeded')), 20_000); // budget: unchanged SSH-to-setup handshake ceiling.
    check();
  });
  return { promise, cancel: () => cancel() };
};
let cancelDropWait = () => {};
if (host !== ${JSON.stringify(HOST)} && host !== ${JSON.stringify(`${HOST}-drop`)} && host !== ${JSON.stringify(`${HOST}-setup`)}) {
  record({ refused: true, stdinBytes }); process.exit(255);
}
if (${JSON.stringify(healthDown)} && !remoteCommand.startsWith(configuredNode)) {
  record({ healthProbeFailed: true, stdinBytes }); process.exit(255);
}
if (starts) appendFileSync(starts, JSON.stringify({ call, host }) + '\\n');
const phases = requests + '.phases';
const hold = ${JSON.stringify(hold)};
const holdHere = () => new Promise(() => { setInterval(() => {}, 60_000); });
if (hold === 'dispatch') await holdHere();
appendFileSync(phases, 'dispatched\\n');
if (hold === 'run') await holdHere();
${dropFirst ? `if (host.endsWith('-drop') && call === 1) {
  process.stdin.once('data', () => {
    record({ dropped: true, stdinBytes, stdinSha256: stdinHash.digest('hex') }); process.exit(255);
  });
  process.stdin.resume();
} else` : ''} {
  const env = { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR,
    PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: machineHome, LANG: 'C', LC_ALL: 'C', TZ: 'UTC',
    ...(${JSON.stringify(nodeOptions)} ? { NODE_OPTIONS: ${JSON.stringify(nodeOptions)} } : {}) };
  // Replace the marker-driven shell so the injected HUP reaches the actual worker process.
  const child = spawn('/bin/sh', ['-c', remoteCommand], { cwd: worker, env,
    stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
${stderrLog ? `  child.stderr.on('data', part => appendFileSync(${JSON.stringify(stderrLog)}, part));\n` : ''}${invalidSpec ? `  child.stdin.write('2\\n{}'); // Keep this owned pipe open: a refused worker must close it itself.
  process.stdin.resume();` : '  process.stdin.pipe(child.stdin);'}
  let droppedAfterSetup = false;
  if (dropAfterMarker) {
    const waiting = waitForMarker(dropAfterMarker);
    cancelDropWait = waiting.cancel;
    waiting.promise.then(found => {
      if (found === false) return;
      droppedAfterSetup = true;
      process.kill(child.pid, 'SIGHUP');
    }, error => { record({ setupMarkerError: error.message }); child.kill('SIGKILL'); });
  }
  child.once('error', error => { record({ spawnError: error.code ?? error.name, stdinBytes }); process.exitCode = 255; });
  child.once('close', (code, signal) => {
${invalidSpec ? '    process.stdin.destroy(); child.stdin.destroy();' : ''}
    appendFileSync(phases, 'returned\\n');
    if (hold === 'return') setInterval(() => {}, 60_000);
    cancelDropWait();
    record({ workerStarted: true, code, signal, stdinBytes, stdinSha256: stdinHash.digest('hex'),
      droppedAfterSetup,
      secretInLocalSshEnv: Object.hasOwn(process.env, 'PULLBOARD_RUNNER_FIXTURE_SECRET'),
      localPoolMarkerInLocalSshEnv: Object.hasOwn(process.env, 'PULLBOARD_GATE_SLOT_POOL'),
      localHeldMarkerInLocalSshEnv: Object.hasOwn(process.env, 'PULLBOARD_GATE_SLOT_HELD'),
      localTokenMarkerInLocalSshEnv: Object.hasOwn(process.env, 'PULLBOARD_GATE_SLOT_TOKEN'),
      localMachineHomeInSshEnv: Object.hasOwn(process.env, 'PULLBOARD_MACHINE_HOME') });
    process.exitCode = signal ? 128 : (code ?? 255);
  });
}
`;
  writeFileSync(ssh, source, { mode: 0o700 });
  chmodSync(ssh, 0o700);
  return ssh;
}
