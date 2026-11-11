/** Relay setup helpers shared by the relay setup, devices and view sign-in tests: a paired phone, a joined computer and plain CLI runs. */
import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
  watch,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import { relayClientFixture } from './client.js';
import {
  createDeviceKeys,
  signDeviceEnrollment,
} from '../../../../../packages/keys/index.js';
import { startFixtureChild } from '../child.js';

export const CLI = resolve(import.meta.dirname, '../../../pullboard.js');

/**
 * The pending phone enrollment once the foreground setup writes it: a watch on the home, settled by the file
 * appearing or by the setup exiting first (then null, and the caller's assertion names it).
 */
function pendingEnrollment(machineFile, home, exited) {
  const read = () => (existsSync(machineFile) ? JSON.parse(readFileSync(machineFile, 'utf8')).pending ?? null : null);
  const now = read();
  if (now) return Promise.resolve(now);
  return new Promise((resolve) => {
    const watcher = watch(home, { recursive: true }, () => {
      const found = read();
      if (!found) return;
      watcher.close(); resolve(found);
    });
    exited.then(() => { watcher.close(); resolve(read()); });
    const first = read();
    if (first) { watcher.close(); resolve(first); }
  });
}

/** Pair a stand-in phone through the real relay: Node signs the same enrollment the phone page sends. */
export async function pairPhone(box, t) {
  const child = startFixtureChild(process.execPath, [CLI, 'relay', 'on', '--all', '--url', box.origin, '--name', 'Kitchen computer', '--json'], { cwd: box.root, env: box.env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  const exited = new Promise(done => child.once('close', done));
  const machineFile = join(box.env.PULLBOARD_HOME, 'relay-machine/state.json');
  const pending = await pendingEnrollment(machineFile, box.env.PULLBOARD_HOME, exited);
  assert.ok(pending, 'the foreground setup publishes one phone enrollment');
  const headers = { authorization: 'Bearer ' + (await box.phoneSession()).token, 'content-type': 'application/json' };
  const identity = await (await fetch(box.origin + '/api/v1/devices/session', { headers })).json();
  const keys = await createDeviceKeys();
  const createdAt = new Date().toISOString();
  const body = await signDeviceEnrollment(pending.secret, { v: 1, account: identity.account, locator: pending.locator,
    deviceId: keys.deviceId, publicKey: keys.publicKey, label: 'Kitchen phone', createdAt });
  const enrolled = await fetch(box.origin + '/api/v1/devices/enrollments/' + pending.locator, { method: 'PUT', headers, body: JSON.stringify(body) });
  assert.equal(enrolled.status, 200, 'the relay carries the signed enrollment');
  assert.equal(await exited, 0, 'the foreground setup pairs the phone');
  const wraps = await fetch(box.origin + '/api/v1/devices/' + keys.deviceId + '/boards', { headers });
  assert.equal(wraps.status, 200, 'the paired phone reads its board keys once');
  return { deviceId: keys.deviceId, createdAt };
}

/** Pair a phone and join a second computer to this board, the walkthrough's path 5. */
export async function phoneAndJoinedComputer(t) {
  const box = await relayClientFixture(t);
  const phone = await pairPhone(box, t);
  const printed = await box.cli('relay', 'pair');
  assert.equal(printed.code, 0, 'the linked computer prints a one-time code');
  const joined = await box.otherDeviceJoin(printed.document.code, 'Study computer');
  return { box, phone, joined };
}

/** Run relay devices on the linked computer and keep its text lines and its board name. */
export async function devicesText(box, args) {
  const cliModule = JSON.stringify(pathToFileURL(resolve(import.meta.dirname, '../native.js')).href);
  const projectsModule = JSON.stringify(pathToFileURL(resolve(import.meta.dirname, '../../../../../packages/seats/index.js')).href);
  const result = await box.script(`
import { main } from ${cliModule};
import { listApiProjects } from ${projectsModule};
let output = '';
const streams = { cwd: ${JSON.stringify(box.root)}, stdout: { write: part => { output += part; } }, stderr: { write() {} } };
const code = await main(${JSON.stringify(['relay', 'devices', ...args])}, streams);
process.stdout.write(JSON.stringify({ code, lines: output.trim().split('\\n'), names: listApiProjects().map(project => project.name) }));
`);
  assert.equal(result.code, 0, 'the private relay devices script completes');
  assert.equal(result.document.code, 0, 'relay devices succeeds');
  return result.document;
}

/** Run the production CLI in plain words, with a finite hang ceiling and stdout kept as text. */
export function plainCommand(root, env, args) {
  const child = startFixtureChild(process.execPath, [resolve(import.meta.dirname, '../../../pullboard.js'), ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = { stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8').on('data', value => { output.stdout += value; });
  child.stderr.setEncoding('utf8').on('data', value => { output.stderr += value; });
  const done = new Promise((resolveResult, reject) => {
    child.once('error', reject);
    child.once('close', code => resolveResult({ code, ...output }));
  });
  return { child, output, done };
}
