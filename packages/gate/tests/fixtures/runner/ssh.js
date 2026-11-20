/** A private SSH stand-in executes the pinned runner capsule without contacting a host [C7,O5]. */
import {
  chmodSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { installRemoteNohup } from './agent-host.js';
import { startAgentHost } from './agent-host.js';

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
 * `workerHealthDown` also fails every pinned-worker recovery probe, restart included, as an unreachable host does; `healthDown` alone fails only non-worker commands, and `registrationDown` fails the registration and measurement probes.
 * `stderrLog` also copies the worker's stderr, so a test can read its result receipt, and `nodeOptions` reaches the
 * worker's own Node process, so a test can force an ordering inside it.
 */
export function installSshStandIn({ bin, worker, home, machineHome, requests, starts, nodeCommand = 'node', dropFirst = false, healthDown = false, registrationDown = false, workerHealthDown = false, dropAfterMarker, hold = '', stderrLog, nodeOptions = '', registrationNodeOptions = '', invalidSpec = false, healthFailures = 0, deferFirstWorker = '', deferredFrame = '', hosts = [HOST, `${HOST}-drop`, `${HOST}-setup`] }) {
  const ssh = join(bin, 'ssh');
  const agentHost = startAgentHost(bin), remoteBin = installRemoteNohup(bin);
  const source = `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { handAgentStart } from ${JSON.stringify(new URL('./agent-host.js', import.meta.url).href)};
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
const argv = process.argv.slice(2);
const divider = argv.indexOf('--');
const host = divider >= 0 ? argv[divider + 1] : '';
const remoteCommand = divider >= 0 ? argv[divider + 2] : '';
const registrationGuiProbe = remoteCommand.includes('/* pullboard registration GUI probe */');
// A pull-mode runner is sent short scripts, not a worker launch: only an enqueue is a dispatch, and the agent it starts runs the worker [C7,#5537].
const pullEnqueue = remoteCommand.includes('IFS= read -r ROW') && remoteCommand.includes('/queue/');
const pullAux = !pullEnqueue && ['echo "agent $A"', 'for d in done running queue', 'source.pack.ready', 'rm -rf "$R/done/', '/cancel"'].some(part => remoteCommand.includes(part));
const workerHealthProbe = remoteCommand.includes(' --health ');
// Registration observations are real transports, recorded separately from job/dispatch statistics.
const requests = ${JSON.stringify(requests)} + (registrationGuiProbe ? '.gui-probes' : workerHealthProbe ? '.health-probes' : pullAux ? '.pull' : '');
const starts = registrationGuiProbe || workerHealthProbe || pullAux ? '' : ${JSON.stringify(starts ?? '')};
const worker = ${JSON.stringify(worker)};
const home = ${JSON.stringify(home)};
const machineHome = ${JSON.stringify(machineHome)};
const configuredNode = ${JSON.stringify(`${shellQuote(nodeCommand)} --input-type=module -e `)};
const dropAfterMarker = registrationGuiProbe || workerHealthProbe || pullAux ? '' : ${JSON.stringify(dropAfterMarker ?? '')};
const secret = ${JSON.stringify(SECRET)};
const call = existsSync(requests) ? readFileSync(requests, 'utf8').split('\\n').filter(Boolean).length + 1 : 1;
const stdinHash = createHash('sha256');
let stdinBytes = 0;
process.stdin.on('data', part => { stdinBytes += part.length; stdinHash.update(part); });
const record = extra => appendFileSync(requests, JSON.stringify({ call, host, ...(registrationGuiProbe ? { registrationGuiProbe: true } : {}),
  options: divider < 0 ? [] : argv.slice(0, divider), remoteHasSecret: remoteCommand.includes(secret),
  framed: divider >= 0 && argv[divider] === '--', remoteCommandPresent: Boolean(remoteCommand),
  remoteStartsWithConfiguredNode: remoteCommand.startsWith(configuredNode), ...(pullEnqueue ? { pullEnqueue: true } : {}),
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
if (!${JSON.stringify(hosts)}.includes(host)) {
  record({ refused: true, stdinBytes }); process.exit(255);
}
// Registration may discover an absolute Node path through a login shell; only generic health probes fail here.
const workerCommand = remoteCommand.includes(' --input-type=module -e ');
if (${JSON.stringify(registrationDown)} && registrationGuiProbe) {
  record({ healthProbeFailed: true, stdinBytes }); process.exit(255);
}
if (${JSON.stringify(healthDown)} && !registrationGuiProbe && !workerCommand) {
  record({ healthProbeFailed: true, stdinBytes }); process.exit(255);
}
if (workerHealthProbe && (${JSON.stringify(workerHealthDown)} || call <= ${JSON.stringify(healthFailures)})) { record({ healthProbeFailed: true, stdinBytes }); process.exit(255); }
// An unreachable host fails the worker restart a lost transport now tries too [C7,#3128].
if (remoteCommand.includes(' --restart ') && ${JSON.stringify(workerHealthDown)}) { record({ healthProbeFailed: true, stdinBytes }); process.exit(255); }
if (!registrationGuiProbe && !workerHealthProbe && !pullAux && ${JSON.stringify(deferFirstWorker)} && call === 1) {
  writeFileSync(${JSON.stringify(deferFirstWorker)}, remoteCommand);
  await new Promise(resolve => {
    // stdin carries the tooling capsule record, then the work frame record; keep each for an exact replay.
    let frame = Buffer.alloc(0), capsule = null;
    process.stdin.on('data', part => {
      frame = Buffer.concat([frame, part]);
      for (;;) {
        const newline = frame.indexOf(10);
        if (newline < 0) return;
        const size = Number(frame.subarray(0,newline).toString('ascii'));
        if (!Number.isSafeInteger(size) || size < 1 || size > (capsule ? 1048576 : 4194304)) process.exit(255);
        if (frame.length < newline+1+size) return;
        const record = frame.subarray(0,newline+1+size);
        frame = frame.subarray(newline+1+size);
        if (!capsule) { capsule = record; writeFileSync(${JSON.stringify(deferFirstWorker)} + '.capsule', capsule); continue; }
        writeFileSync(${JSON.stringify(deferredFrame)},record); resolve(); return;
      }
    });
    process.stdin.resume();
  });
  record({ deferredBeforeLaunch: true, stdinBytes }); process.exit(255);
}
if (starts) appendFileSync(starts, JSON.stringify({ call, host }) + '\\n');
const phases = requests + '.phases';
const hold = registrationGuiProbe || workerHealthProbe ? '' : ${JSON.stringify(hold)};
const holdHere = () => new Promise(() => { setInterval(() => {}, 60_000); });
// A worker launch that never completes: a controller launch hangs; a pulled job is queued but its agent is never started.
let skipAgent = false;
const holdWorker = async () => { if (pullEnqueue) skipAgent = true; else await holdHere(); };
const launchesWorker = remoteCommand.startsWith(configuredNode) || pullEnqueue;
const AGENT_TAIL = '\\n) </dev/null >/dev/null 2>&1 &', QUEUED = '\\necho "queued';
const SHELL_HEAD = '\\n/bin/sh -c ', SHELL_TAIL = ' </dev/null >/dev/null 2>&1';
// The enqueue's agent start: the bare '( nohup' line, or since #10985 that same text as one quoted /bin/sh -c word.
const agentSpan = command => {
  const shell = command.indexOf(SHELL_HEAD + "'( ");
  if (shell >= 0) {
    const end = command.indexOf(QUEUED, shell), line = end > shell ? command.slice(shell, end) : '';
    if (!line.endsWith("'" + SHELL_TAIL)) return null;
    const inner = line.slice(SHELL_HEAD.length + 1, -SHELL_TAIL.length - 1).split("'\\\\''").join("'");
    return inner.endsWith(AGENT_TAIL) ? { start: shell, end, agent: inner.slice(2, -AGENT_TAIL.length) } : null;
  }
  const start = command.indexOf('\\n( nohup'), end = command.indexOf(AGENT_TAIL + QUEUED);
  return start >= 0 && end > start ? { start, end: end + AGENT_TAIL.length, agent: command.slice(start + 3, end) } : null;
};
const withoutAgent = command => { const span = agentSpan(command); return span ? command.slice(0, span.start) + command.slice(span.end) : command; };
/** The enqueue's agent start line, without its trailing '&', for the box's agent host to run as its child. */
const agentLine = command => (agentSpan(command)?.agent ?? '').replace(/\\s*&\\s*$/u, '');
if (hold === 'dispatch') await holdHere();
appendFileSync(phases, 'dispatched\\n');
if (hold === 'run') await holdHere();
${dropFirst ? `if (!registrationGuiProbe && !workerHealthProbe && !pullAux && host.endsWith('-drop') && call === 1) {
  process.stdin.once('data', () => {
    record({ dropped: true, stdinBytes, stdinSha256: stdinHash.digest('hex') }); process.exit(255);
  });
  process.stdin.resume();
} else` : ''} {
  const env = { PATH: ${JSON.stringify(remoteBin)} + ':' + process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR,
    PULLBOARD_FIXTURE_BOARD: '1', PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: machineHome, PULLBOARD_AGENT_IDLE_SECONDS: '30', PULLBOARD_AGENT_CORES: '4096', LANG: 'C', LC_ALL: 'C', TZ: 'UTC',
    ...((registrationGuiProbe || workerHealthProbe ? ${JSON.stringify(registrationNodeOptions)} : ${JSON.stringify(nodeOptions)})
      ? { NODE_OPTIONS: registrationGuiProbe || workerHealthProbe ? ${JSON.stringify(registrationNodeOptions)} : ${JSON.stringify(nodeOptions)} } : {}) };
  // Replace the marker-driven shell so the injected HUP reaches the actual worker process.
  // A real ssh -T remote has no controlling terminal; detached gives the shell its own session, or the runner's tty makes BSD nohup refuse to start the agent (#6734).
  // PATH starts with a remote-style nohup: macOS nohup fails in a LaunchDaemon, as on a pull runner (#6917).
  // PULLBOARD_AGENT_CORES: the agent holds jobs while load >= cores, which at runner load 18-50 never claims a stand-in job.
  // An enqueue's backgrounded agent would outlive this shell and leave the test's process tree; on pull runners that
  // orphan died at once and its job sat queued (#6917). Enqueue without it, then hand its line to the box's agent host.
  const agent = pullEnqueue && !skipAgent ? agentLine(remoteCommand) : '';
  const child = spawn('/bin/sh', ['-c', pullEnqueue ? withoutAgent(remoteCommand) : remoteCommand], { cwd: worker, env, detached: true,
    stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.pipe(process.stdout);
  // READY and ordinary results stream; only a held-return fault withholds its receipt.
  let pendingStderr = '', receipt = '';
  child.stderr.on('data', part => {
    pendingStderr += part.toString();
    for (;;) {
      const newline = pendingStderr.indexOf('\\n');
      if (newline < 0) break;
      const line = pendingStderr.slice(0, newline + 1);
      pendingStderr = pendingStderr.slice(newline + 1);
      if (hold === 'return' && line.startsWith('PULLBOARD_RUNNER_RESULT ')) receipt += line;
      else process.stderr.write(line);
    }
  });
${stderrLog ? `  child.stderr.on('data', part => { if (!registrationGuiProbe && !workerHealthProbe) appendFileSync(${JSON.stringify(stderrLog)}, part); });\n` : ''}${invalidSpec ? `  if (!registrationGuiProbe && !workerHealthProbe) {
    // Forward the tooling capsule record unchanged, then replace the work frame with an invalid one.
    let buffered = Buffer.alloc(0), forwarded = false;
    process.stdin.on('data', part => {
      if (forwarded) return;
      buffered = Buffer.concat([buffered, part]);
      const newline = buffered.indexOf(10);
      if (newline < 0) return;
      const size = Number(buffered.subarray(0, newline).toString('ascii'));
      if (buffered.length < newline + 1 + size) return;
      forwarded = true;
      child.stdin.write(buffered.subarray(0, newline + 1 + size));
      child.stdin.write('2\\n{}'); // Keep this owned pipe open: a refused worker must close it itself.
    });
    process.stdin.resume();
  } else process.stdin.pipe(child.stdin); // Health and registration probes carry their capsule on stdin too.` : '  process.stdin.pipe(child.stdin);'}
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
  child.once('close', async (code, signal) => {
    process.stdin.destroy(); child.stdin.destroy(); // a real ssh ends when its remote command does, even if the controller's pipe stays open
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
    if (pendingStderr) process.stderr.write(pendingStderr);
    if (hold !== 'return' && receipt) process.stderr.write(receipt);
    if (agent && code === 0 && !signal && !await handAgentStart(${JSON.stringify(agentHost)}, { command: agent, cwd: worker, env })) {
      // No host took it: start it as the enqueue did, backgrounded.
      await new Promise(resolve => spawn('/bin/sh', ['-c', agent + ' &'], { cwd: worker, env, detached: true, stdio: 'ignore' }).once('close', resolve).once('error', resolve));
    }
    process.exitCode = signal ? 128 : (code ?? 255);
  });
}
`;
  writeFileSync(ssh, source, { mode: 0o700 });
  chmodSync(ssh, 0o700);
  return ssh;
}

/** Install a registration-only private SSH transport for settings/placement tests that never dispatch a job. */
export function installRegistrationProbeStandIn({ bin, observations = join(bin, 'registration-probes.jsonl') }) {
  const source = `#!/usr/bin/env node
import {appendFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
const args=process.argv.slice(2),divider=args.indexOf('--');
const host=divider<0?'':args[divider+1],command=divider<0?'':args[divider+2];
if(!command.includes('/* pullboard registration GUI probe */'))process.exit(255);
const env={...process.env};delete env.NODE_OPTIONS;delete env.NODE_TEST_CONTEXT;
const child=spawn('/bin/sh',['-c',command],{env,stdio:['ignore','pipe','pipe']});
child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
child.on('error',()=>{process.exitCode=255;});
child.on('close',(code,signal)=>{
  appendFileSync(${JSON.stringify(observations)},JSON.stringify({host,registrationGuiProbe:true,code,signal})+'\\n');
  process.exitCode=signal?128:code??255;
});
`;
  const file = join(bin, 'ssh');
  writeFileSync(file, source);
  chmodSync(file, 0o755);
  return file;
}
