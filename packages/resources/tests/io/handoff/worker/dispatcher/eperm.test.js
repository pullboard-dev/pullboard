/** @pullboard-test-input source-tree */
/** The gate dispatcher never exits on a kill it may not send (EPERM) or that meets a replaced process (ESRCH) [C7,#3727]. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { handoffDispatcherLog } from '../../../../../index.js';
import { queueHandoffLaunch } from '../../../../../index.js';
import { reserveHandoffTicket } from '../../../../../index.js';
import { temporaryDirectory } from '../../../../../../../apps/cli/tests/fixtures/board.js';
import { waitForCondition } from '../../../../../../../apps/cli/tests/fixtures/runner/holders.js';

const DISPATCHER = fileURLToPath(new URL('../../../../../../../apps/lib/src/io/handoff/dispatcher.js', import.meta.url));
const RESOURCES = fileURLToPath(new URL('../../../../../index.js', import.meta.url));

/** A stand-in gate driver that records that it ran, then ends. */
const WORKER = `const fs = require('node:fs');
const path = require('node:path');
fs.writeFileSync(path.join(path.dirname(process.argv[2]), 'ran'), 'ran');
`;

/**
 * The real dispatcher loop in a process of its own. A stand-in worker the drain already tracks has recorded its result,
 * and the kill the drain sends to its process group fails with the given error code, as a replaced pid does; every other
 * kill is the real one. The job row and the gate admission are stand-ins; the drain and the worker launches are shipped.
 */
const RUN = `import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const { runDispatcher } = await import(${JSON.stringify(pathToFileURL(DISPATCHER).href)});
const { drainHandoffQueue } = await import(${JSON.stringify(pathToFileURL(RESOURCES).href)});
const [dir, code] = process.argv.slice(1);
const FAKE = 2147483000;
const realKill = process.kill;
const sent = [];
process.kill = (pid, signal) => {
  if (pid === -FAKE) { sent.push(signal); writeFileSync(join(dir, 'sent.json'), JSON.stringify(sent)); throw Object.assign(new Error('kill ' + code), { code }); }
  return realKill.call(process, pid, signal);
};
mkdirSync(join(dir, 'fake'), { recursive: true });
writeFileSync(join(dir, 'fake', 'submission.json'), '{}');
const started = Date.now();
const entry = { job: 'fake', directory: join(dir, 'fake'), startedAt: 0, worker: { pid: FAKE }, slot: { release() {} }, get exited() { return Date.now() - started > 2500; } };
const row = { renew() {}, release() {}, retake() { return false; }, withDb() {} };
const drain = ports => { ports.running.set(entry.worker, entry); return drainHandoffQueue({ ...ports, resultGraceMs: 0, pollMs: 50 }); };
await runDispatcher({ row, drain, admission: { admit() {}, spawned() {}, unstarted() {}, entry: null }, onPass() {}, retryMs: 100 });
`;

for (const code of ['EPERM', 'ESRCH']) {
  test(`clause 1: a dispatcher whose kill to a worker group fails with ${code} logs it, drains on, and exits 0 [C7,#3727]`, { timeout: 60_000 }, async t => {
    const dir = realpathSync(temporaryDirectory('pullboard-dispatcher-eperm-'));
    const tools = join(dir, 'tools');
    mkdirSync(join(tools, 'apps/cli/src/io/gate'), { recursive: true });
    writeFileSync(join(tools, 'apps/cli/src/io/gate/drive.js'), WORKER);
    const saved = process.env.PULLBOARD_MACHINE_HOME;
    const home = join(dir, 'home');
    mkdirSync(home);
    process.env.PULLBOARD_MACHINE_HOME = home;
    t.after(() => {
      if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved;
      rmSync(dir, { recursive: true, force: true });
    });
    const job = join(dir, 'jobs', 'job1');
    mkdirSync(job, { recursive: true });
    writeFileSync(join(job, 'request.json'), JSON.stringify({ job: 'job1' }) + '\n');
    queueHandoffLaunch({ directory: job, tools, commonDir: dir, job: 'job1' }, await reserveHandoffTicket('job1'));
    const child = spawn(process.execPath, ['--input-type=module', '-e', RUN, dir, code], { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, PULLBOARD_MACHINE_HOME: home } });
    const stderr = [];
    child.stderr.on('data', chunk => stderr.push(chunk));
    t.after(() => { try { child.kill('SIGKILL'); } catch { /* already ended */ } });
    const exited = new Promise(resolve => child.once('close', (exitCode, signal) => resolve({ exitCode, signal })));
    await waitForCondition(() => existsSync(join(job, 'ran')), 'the queued gate worker to start after the refused kill', { signal: t.signal });
    const end = await exited;
    const text = Buffer.concat(stderr).toString('utf8');
    assert.equal(end.exitCode, 0, `the dispatcher drained its queue and ended normally: ${text}`);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'sent.json'), 'utf8')), ['SIGTERM'], 'the refused group is signalled once, then left alone');
    const log = existsSync(handoffDispatcherLog()) ? readFileSync(handoffDispatcherLog(), 'utf8') : '';
    assert.doesNotMatch(log + text, /dispatcher failed/u, 'the kill never ended the dispatcher');
    if (code === 'EPERM') assert.match(log, /refused: EPERM; treated as not this dispatcher's worker/u, 'the refusal is logged');
  });
}
