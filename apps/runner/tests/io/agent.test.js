/** The runner agent claims queued jobs by rename, runs them on files, and honours cancel and a stale wanted file [C7,#5467]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { watch } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { agentVersion } from '../../src/io/agent.js';
import { runnerAgentStartCommand } from '../../src/io/agent.js';
import { sourceCacheJobGone } from '../../../../packages/resources/index.js';
import { privateFixtureFiles } from '../../../cli/tests/fixtures/child.js';
import { HOST } from '../../../cli/tests/fixtures/runner/ssh.js';
import { installSshStandIn } from '../../../cli/tests/fixtures/runner/ssh.js';

/** A grandchild that notes the TERM it receives, which only a signal to the whole process group delivers. */
const GRANDCHILD = '(trap "echo gone > gone; exit" TERM; sleep 60 & echo $! > grand.pid; wait) & wait';
const FAST = 'PULLBOARD_AGENT_POLL=0.1 PULLBOARD_AGENT_IDLE_SECONDS=3 PULLBOARD_AGENT_WANTED_SECONDS=2 PULLBOARD_AGENT_CORES=1000';

/** A private runner root plus the ssh stand-in that starts the agent exactly as an enqueue would. */
function machine(t, settings = FAST) {
  const base = privateFixtureFiles('pb-agent-').root;
  const bin = join(base, 'bin');
  const home = join(base, 'home');
  for (const dir of [bin, home, join(base, 'cwd')]) mkdirSync(dir);
  const ssh = installSshStandIn({ bin, worker: join(base, 'cwd'), home, machineHome: join(home, '.pullboard'), requests: join(base, 'requests') });
  const root = join(home, '.pullboard-runner');
  const start = version => execFileSync(ssh, ['--', HOST, `${settings} ${runnerAgentStartCommand('', version)}`], { stdio: 'ignore' });
  const agentPid = () => Number(existsSync(join(root, 'agent.lock', 'pid')) ? readFileSync(join(root, 'agent.lock', 'pid'), 'utf8') : 0);
  t.after(() => {
    const pid = agentPid();
    if (pid) try { process.kill(pid, 'SIGTERM'); } catch { /* Already gone. */ }
    for (const id of ['queue', 'running']) {
      for (const job of existsSync(join(root, id)) ? execFileSync('ls', [join(root, id)], { encoding: 'utf8' }).split('\n').filter(Boolean) : []) {
        const jobPid = Number(existsSync(join(root, id, job, 'pid')) ? readFileSync(join(root, id, job, 'pid'), 'utf8') : 0);
        if (jobPid) try { process.kill(-jobPid, 'SIGKILL'); } catch { /* Already gone. */ }
      }
    }
    rmSync(base, { recursive: true, force: true });
  });
  return { root, start, agentPid };
}

/** Build a job folder whole under a dot name, then rename it into queue/, as an enqueue does. */
function enqueue(root, id, { command, input = '', extra = {} }) {
  const tmp = join(root, 'queue', `.tmp-${id}`);
  mkdirSync(tmp, { recursive: true });
  writeFileSync(join(tmp, 'command'), command);
  writeFileSync(join(tmp, 'input'), input);
  for (const [name, text] of Object.entries(extra)) writeFileSync(join(tmp, name), text);
  renameSync(tmp, join(root, 'queue', id));
}

/** Resolve when a condition holds, rechecking on every file event under the runner root; fail with the label after ms. */
function until(label, root, condition, ms = 15_000) {
  return new Promise((resolve, reject) => {
    mkdirSync(root, { recursive: true });
    const watcher = watch(root, { recursive: true }, () => check());
    const timer = setTimeout(() => finish(new Error(`timed out waiting for ${label}`)), ms);
    function finish(error) { watcher.close(); clearTimeout(timer); if (error) reject(error); else resolve(); }
    function check() { if (condition()) finish(); }
    check();
  });
}

const exitOf = (root, id) => JSON.parse(readFileSync(join(root, 'done', id, 'exit'), 'utf8'));

test('a queued job is claimed by rename and runs on file stdin, stdout and stderr with a heartbeat [C7,#5467]', async t => {
  const { root, start } = machine(t);
  mkdirSync(join(root, 'queue'), { recursive: true });
  enqueue(root, 'job1', { command: 'cat; echo err >&2; echo "$PULLBOARD_QUEUE_JOB" > folder.txt; sleep 1', input: 'frame-bytes' });
  start();
  await until('the job to run', root, () => existsSync(join(root, 'running', 'job1', 'beat')));
  assert.ok(!existsSync(join(root, 'queue', 'job1')), 'claim moved the row out of queue/');
  const owner = JSON.parse(readFileSync(join(root, 'running', 'job1', 'owner.json'), 'utf8'));
  assert.ok(Number.isInteger(owner.pid) && owner.pid > 0);
  await until('the job to finish', root, () => existsSync(join(root, 'done', 'job1', 'exit')));
  const done = join(root, 'done', 'job1');
  assert.equal(readFileSync(join(done, 'out.bin'), 'utf8'), 'frame-bytes');
  assert.equal(readFileSync(join(done, 'control.log'), 'utf8'), 'err\n');
  assert.equal(readFileSync(join(done, 'folder.txt'), 'utf8').trim(), join(root, 'running', 'job1'));
  assert.deepEqual({ code: exitOf(root, 'job1').code, signal: exitOf(root, 'job1').signal }, { code: 0, signal: null });
});

test('a failing job records its exit code and cancel stops its whole process group [C7,#5467]', async t => {
  const { root, start } = machine(t);
  mkdirSync(join(root, 'queue'), { recursive: true });
  enqueue(root, 'bad', { command: 'exit 7' });
  enqueue(root, 'long', { command: GRANDCHILD });
  start();
  await until('the failing job to finish', root, () => existsSync(join(root, 'done', 'bad', 'exit')));
  assert.equal(exitOf(root, 'bad').code, 7);
  const grand = join(root, 'running', 'long', 'grand.pid');
  await until('the grandchild to start', root, () => existsSync(grand) && readFileSync(grand, 'utf8').trim() !== '');
  writeFileSync(join(root, 'running', 'long', 'cancel'), '');
  await until('the canceled job to finish', root, () => existsSync(join(root, 'done', 'long', 'exit')));
  assert.deepEqual({ signal: exitOf(root, 'long').signal, reason: exitOf(root, 'long').reason }, { signal: 'SIGTERM', reason: 'canceled' });
  await until('the grandchild to receive the group signal', root, () => existsSync(join(root, 'done', 'long', 'gone')));
});

test('a stale wanted file ends a running job and stops a queued one before it starts [C7,#5467]', async t => {
  const { root, start } = machine(t);
  mkdirSync(join(root, 'queue'), { recursive: true });
  enqueue(root, 'run', { command: GRANDCHILD, extra: { wanted: '' } });
  start();
  const grand = join(root, 'running', 'run', 'grand.pid');
  await until('the job to run', root, () => existsSync(grand) && readFileSync(grand, 'utf8').trim() !== '');
  const past = new Date(Date.now() - 60_000);
  utimesSync(join(root, 'running', 'run', 'wanted'), past, past);
  await until('the unwanted job to finish', root, () => existsSync(join(root, 'done', 'run', 'exit')));
  assert.deepEqual({ signal: exitOf(root, 'run').signal, reason: exitOf(root, 'run').reason }, { signal: 'SIGTERM', reason: 'wanted-expired' });
  await until('the grandchild to receive the group signal', root, () => existsSync(join(root, 'done', 'run', 'gone')));
  enqueue(root, 'never', { command: 'touch ran', extra: { wanted: '', cancel: '' } });
  await until('the canceled row to be settled', root, () => existsSync(join(root, 'done', 'never', 'exit')));
  assert.equal(exitOf(root, 'never').reason, 'canceled-before-start');
  assert.ok(!existsSync(join(root, 'done', 'never', 'ran')));
});

test('one agent holds agent.lock and it exits when idle, freeing the lock for the next start [C7,#5467]', async t => {
  const { root, start, agentPid } = machine(t);
  start();
  await until('the agent lock', root, () => agentPid() > 0);
  const first = agentPid();
  start();
  assert.equal(agentPid(), first, 'a second start leaves the live agent in charge');
  await until('the idle agent to release the lock', root, () => !existsSync(join(root, 'agent.lock')), 10_000);
  start();
  await until('a new agent', root, () => agentPid() > 0 && agentPid() !== first);
});

test('a worker command that reads its capsule then execs node still sees the rest of the input file [C7,#5467]', async t => {
  const { root, start } = machine(t);
  mkdirSync(join(root, 'queue'), { recursive: true });
  const reader = 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(s))';
  const head = 'const b=Buffer.alloc(3);require("fs").readSync(0,b,0,3,null)';
  enqueue(root, 'frame', { command: `node -e '${head}' && exec node -e '${reader}'`, input: 'AAAspec-frame\nrest' });
  start();
  await until('the job to finish', root, () => existsSync(join(root, 'done', 'frame', 'exit')));
  assert.equal(readFileSync(join(root, 'done', 'frame', 'out.bin'), 'utf8'), 'spec-frame\nrest');
});

test('a runner at or above its core count takes no new job, says why, and pulls again once load drops [C7,#5578]', async t => {
  const { root } = machine(t);
  const loadFile = join(root, '..', 'load-now');
  const setLoad = value => { writeFileSync(`${loadFile}.tmp`, `${value}\n`); renameSync(`${loadFile}.tmp`, loadFile); };
  setLoad('12.5');
  const settings = `${FAST} PULLBOARD_AGENT_CORES=10 PULLBOARD_AGENT_LOAD_FILE=${loadFile}`;
  mkdirSync(join(root, 'queue'), { recursive: true });
  enqueue(root, 'held', { command: 'echo ran', input: '' });
  execFileSync('sh', ['-c', `${settings} ${runnerAgentStartCommand(root)}`], { stdio: 'ignore' });
  await until('the hold report', root, () => existsSync(join(root, 'load')) && /state=hold load=12.5 cores=10/.test(readFileSync(join(root, 'load'), 'utf8')));
  setLoad('12.6');
  await until('a later tick that still held', root, () => /state=hold load=12.6 /.test(readFileSync(join(root, 'load'), 'utf8')));
  assert.ok(existsSync(join(root, 'queue', 'held')) && !existsSync(join(root, 'running', 'held')), 'the job stays queued while load is above cores');
  setLoad('9.99');
  await until('the job to run once load is under cores', root, () => existsSync(join(root, 'done', 'held', 'exit')));
  assert.match(readFileSync(join(root, 'load'), 'utf8'), /state=ok load=9.99 cores=10/);
});

test('an agent records the digest of its own script, and a start with another digest hands over without losing a running job [C7,#5590]', async t => {
  const { root, start, agentPid } = machine(t, `${FAST} PULLBOARD_AGENT_IDLE_SECONDS=30 PULLBOARD_AGENT_WANTED_SECONDS=60`);
  mkdirSync(join(root, 'queue'), { recursive: true });
  assert.match(agentVersion(), /^[0-9a-f]{16}$/);
  enqueue(root, 'long', { command: 'sleep 3; echo finished' });
  start('old-digest');
  await until('the job to run', root, () => existsSync(join(root, 'running', 'long', 'beat')));
  const first = agentPid();
  assert.equal(readFileSync(join(root, 'agent.lock', 'version'), 'utf8').trim(), 'old-digest');
  start('old-digest');
  assert.equal(agentPid(), first, 'a start with the same digest leaves the live agent alone');
  assert.ok(!existsSync(join(root, 'wanted-version')));
  enqueue(root, 'after', { command: 'echo new-agent' });
  start('new-digest');
  await until('the live agent to be asked', root, () => existsSync(join(root, 'wanted-version')));
  assert.ok(existsSync(join(root, 'queue', 'after')), 'the leaving agent claims nothing new');
  assert.ok(existsSync(join(root, 'running', 'long')), 'the running job is not touched');
  await until('the running job to finish whole', root, () => existsSync(join(root, 'done', 'long', 'exit')));
  assert.deepEqual({ code: exitOf(root, 'long').code, signal: exitOf(root, 'long').signal }, { code: 0, signal: null });
  assert.equal(readFileSync(join(root, 'done', 'long', 'out.bin'), 'utf8'), 'finished\n');
  await until('the queued job to run on the new agent', root, () => existsSync(join(root, 'done', 'after', 'exit')));
  assert.equal(readFileSync(join(root, 'done', 'after', 'out.bin'), 'utf8'), 'new-agent\n');
  assert.notEqual(agentPid(), first);
  assert.equal(readFileSync(join(root, 'agent.lock', 'version'), 'utf8').trim(), 'new-digest');
  assert.ok(!existsSync(join(root, 'wanted-version')));
});

/** Run a script in a child that stays alive on its own (it reads a stdin that never ends); resolves its stderr on demand. */
function liveChild(t, source, env) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `process.stdin.resume();\n${source}`], { stdio: ['pipe', 'ignore', 'pipe'], env: { ...process.env, ...env } });
  let stderr = '';
  const heard = [];
  child.stderr.on('data', chunk => { stderr += chunk; for (const wake of heard.splice(0)) wake(); });
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
  /** Resolve once the child's stderr matches. */
  const hears = pattern => new Promise(resolve => { const check = () => (pattern.test(stderr) ? resolve() : heard.push(check)); check(); });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* Already gone. */ } });
  return { exited, hears, stderr: () => stderr };
}

test('a worker whose job folder disappears ends itself within a minute, whatever it is doing [C7,#5593]', async t => {
  const base = privateFixtureFiles('pb-orphan-').root;
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const folder = join(base, 'running-job');
  mkdirSync(folder);
  const orphan = pathToFileURL(join(import.meta.dirname, '../../src/io/worker/orphan.js')).href;
  const { exited, hears, stderr } = liveChild(t, `import { watchJobFolder } from ${JSON.stringify(orphan)};
    watchJobFolder({ workerId: 'job-1', transportDrop() { console.error('dropped'); } }, { graceMs: 200 });
    console.error('watching');`, { PULLBOARD_QUEUE_JOB: folder });
  await hears(/watching/);
  rmSync(folder, { recursive: true });
  await hears(/dropped/);
  assert.match(stderr(), /PULLBOARD_RUNNER_ORPHAN job-1/);
  assert.equal(await exited, 1, 'a worker stuck in cleanup is ended after its grace');
});

test('a source-cache pin is freed once its job directory is gone, even held by a live worker with a never-expiring beat [C7,#5593]', async t => {
  const base = privateFixtureFiles('pb-pin-').root;
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const runnerRoot = join(base, 'runner');
  const jobs = join(runnerRoot, 'jobs', 'job-1-abc');
  mkdirSync(jobs, { recursive: true });
  const pin = agent => ({ kind: 'source-cache', agent, repo: runnerRoot });
  assert.equal(sourceCacheJobGone(pin('pullboard-ssh-cache-job-1')), false, 'a present job directory keeps its pin');
  assert.equal(sourceCacheJobGone({ ...pin('pullboard-ssh-cache-job-1'), kind: 'gate' }), false, 'only source-cache pins are judged');
  assert.equal(sourceCacheJobGone(pin('someone-else')), false, 'a holder that is not a runner job is never judged');
  rmSync(jobs, { recursive: true });
  assert.equal(sourceCacheJobGone(pin('pullboard-ssh-return-job-1')), true);
  mkdirSync(jobs, { recursive: true });
  const resources = pathToFileURL(join(import.meta.dirname, '../../../../packages/resources/index.js')).href;
  const take = (agent, mark) => `import { takeResource } from ${JSON.stringify(resources)};
    import { writeFileSync } from 'node:fs';
    await takeResource({ name: 'repo-x', capacity: 1, scope: 'machine', root: ${JSON.stringify(runnerRoot)}, repo: ${JSON.stringify(runnerRoot)}, agent: ${JSON.stringify(agent)}, kind: 'source-cache' });
    writeFileSync(${JSON.stringify(join(base, mark))}, 'x'); console.error('took');`;
  const env = { PULLBOARD_MACHINE_HOME: join(base, 'home') };
  const holder = liveChild(t, take('pullboard-ssh-cache-job-1', 'holder'), env);
  await holder.hears(/took/);
  rmSync(jobs, { recursive: true });
  const next = liveChild(t, take('pullboard-ssh-pin-job-2', 'waiter'), env);
  await next.hears(/took/);
  assert.ok(existsSync(join(base, 'waiter')), 'the next job takes the freed pin while the orphan still lives');
});
