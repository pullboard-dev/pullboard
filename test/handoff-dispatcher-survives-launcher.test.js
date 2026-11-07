import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { waitForCondition } from './runner-fixture-state.js';
import { privateFixtureFiles } from './fixture-child.js';

/** Prove the machine dispatcher survives a command ending and receives no agent session environment [C7]. */
test('a handoff dispatcher is re-parented and survives its launcher process tree [C7]', async t => {
  const root = privateFixtureFiles('pullboard-handoff-dispatcher-').root;
  const machine = join(root, 'machine');
  const tools = join(root, 'tools');
  const entryDir = join(tools, 'bin');
  const marker = join(root, 'dispatcher.json');
  mkdirSync(entryDir, { recursive: true });
  /** @pullboard-world-pin the real detach launcher is the unit under test */
  copyFileSync(join(import.meta.dirname, '../bin/handoff-worker-detach.js'), join(entryDir, 'handoff-worker-detach.js'));
  writeFileSync(join(entryDir, 'handoff-worker-dispatcher.js'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, session: process.env.AGENT_SESSION_TOKEN ?? null, home: process.env.PULLBOARD_MACHINE_HOME }));\nsetInterval(() => {}, 60_000);\n`);
  const module = pathToFileURL(join(import.meta.dirname, '../packages/resources/src/shell/handoff-worker-cap.js')).href;
  const launch = `process.env.PULLBOARD_MACHINE_HOME=${JSON.stringify(machine)}; process.env.AGENT_SESSION_TOKEN='private-session'; const { ensureHandoffDispatcher }=await import(${JSON.stringify(module)}); await ensureHandoffDispatcher(${JSON.stringify(tools)}, ${JSON.stringify(root)});`;
  const launcher = spawn(process.execPath, ['--input-type=module', '-e', launch], { cwd: root, detached: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, PULLBOARD_MACHINE_HOME: machine, AGENT_SESSION_TOKEN: 'private-session' } });
  const stderr = [];
  launcher.stderr.on('data', chunk => stderr.push(chunk));
  let dispatcherPid;
  try {
    await new Promise((resolve, reject) => {
      launcher.once('error', reject);
      launcher.once('close', code => code === 0 ? resolve() : reject(new Error(Buffer.concat(stderr).toString('utf8') || `launcher exited ${code}`)));
    });
    const receipt = JSON.parse(readFileSync(join(machine, 'handoff-queue', 'dispatcher.json'), 'utf8'));
    dispatcherPid = receipt.pid;
    await waitForCondition(() => existsSync(marker), 'detached dispatcher started', { signal: t.signal });
    const record = JSON.parse(readFileSync(marker, 'utf8'));
    assert.equal(record.pid, dispatcherPid);
    assert.equal(record.session, null, 'agent session variables are not inherited');
    assert.equal(record.home, machine, 'machine state selection is preserved');
    const parent = spawnSync('ps', ['-o', 'ppid=', '-p', String(dispatcherPid)], { encoding: 'utf8' });
    assert.equal(parent.status, 0, 'dispatcher process is still alive after the launching command exits');
    assert.notEqual(Number(parent.stdout.trim()), launcher.pid, 'dispatcher is not a child of the launching process');
    try { process.kill(-launcher.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    process.kill(dispatcherPid, 0);
    assert.equal(JSON.parse(readFileSync(marker, 'utf8')).session, null);
  } finally {
    if (dispatcherPid) { try { process.kill(dispatcherPid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    rmSync(root, { recursive: true, force: true });
  }
});
