/** One real machine setup reaches current and future projects through one phone key [H5,H15,H17]. */
import assert from 'node:assert/strict';
import { startFixtureChild as spawn, runFixtureChild as spawnSync } from './fixture-child.js';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { relayClientFixture } from './relay-client-fixture.js';
import { startChrome, findChromeExecutable } from './relay-browser-fixture.js';

const CLI = resolve(import.meta.dirname, '../bin/pullboard.js');

/** Poll a real state change with a finite deadline and no retries of the operation being tested. */
async function waitFor(read, message, timeout = 20_000) {
  const until = Date.now() + timeout;
  do {
    const result = read();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < until);
  assert.fail(message);
}

/** Launch the production CLI against an isolated real repository and retain only private diagnostics. */
function command(root, env, args) {
  const child = spawn(process.execPath, [CLI, ...args, '--json'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
  child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
  const done = new Promise((resolveResult, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (signal || code !== 0) {
        const failure = child.fixtureFailure;
        if (signal) return reject(new Error(failure));
      }
      let document;
      try { document = JSON.parse(stdout); } catch { return reject(new Error('The private setup command did not return JSON.')); }
      resolveResult({ code, document, stderr, failure: child.fixtureFailure });
    });
  });
  return { child, done };
}

/** Initialize an independent committed project with origin in place before its registration. */
async function project(box, name) {
  const root = join(dirname(box.root), name);
  mkdirSync(root);
  for (const args of [['init', '-q', '-b', 'main'], ['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-q', '-m', 'fixture base'],
    ['remote', 'add', 'origin', 'git@github.com:fixture/repository.git']]) {
    assert.equal(spawnSync('git', args, { cwd: root, env: box.env }).status, 0);
  }
  const initialized = await command(root, box.env, ['init']).done;
  assert.equal(initialized.code, 0, 'the additional project registers through the actual init command');
  return root;
}

/** Read one private link without exposing credentials in test diagnostics. */
function link(root) { return JSON.parse(readFileSync(join(root, '.git/pullboard/relay.json'), 'utf8')); }

/** Inspect the actual persisted browser key without exporting its private half. */
function browserDeviceExpression() {
  return `new Promise((resolve, reject) => { const request = indexedDB.open('pullboard-relay-device-v1', 1);
    request.onsuccess = () => { const db=request.result; const transaction=db.transaction('keys'); const read=transaction.objectStore('keys').get('device');
      read.onsuccess = () => { const value=read.result; db.close(); resolve({id:value.deviceId,extractable:value.privateKey.extractable}); }; read.onerror=reject; }; request.onerror=reject; })`;
}

test('set up once links three registered boards, later registration and a persistent phone without another pairing [H5,H15,H17]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  let chrome;
  let setup;
  t.after(async () => {
    await chrome?.close();
    if (setup?.child.exitCode === null) setup.child.kill('SIGTERM');
    await setup?.done.catch(() => {});
  });
  const box = await relayClientFixture(t);
  const second = await project(box, 'second-project');
  const third = await project(box, 'third-project');
  const machineFile = join(box.env.PULLBOARD_HOME, 'relay-machine/state.json');
  setup = command(box.root, box.env, ['relay', 'on', '--all', '--url', box.origin]);
  const pending = await waitFor(() => {
    if (!existsSync(machineFile)) return null;
    return JSON.parse(readFileSync(machineFile, 'utf8')).pending;
  }, 'the foreground setup publishes one pending phone enrollment');
  const roots = [box.root, second, third];
  assert.ok(roots.every(root => existsSync(join(root, '.git/pullboard/relay.json'))), 'all three boards linked before first phone enrollment');
  assert.equal(box.calls.filter(call => call.path === '/auth/device/start').length, 1, 'one GitHub device sign-in covers the entire machine');

  const profileDirectory = join(dirname(box.root), 'phone-profile');
  chrome = await startChrome({ profileDirectory });
  assert.equal((await chrome.send('Network.setCookie', { name: 'pb_session', value: link(box.root).token, url: box.origin, httpOnly: true, sameSite: 'Lax' })).success, true);
  await chrome.navigate(box.origin + '/#device=' + pending.locator + '.' + pending.secret);
  const completed = await setup.done;
  assert.equal(completed.code, 0);
  assert.equal(completed.document.linked.length, 3);
  assert.equal(completed.document.paired, true);
  await chrome.waitFor("document.querySelectorAll('#proj-list .proj.repo').length === 3");
  assert.equal(await chrome.evaluate('location.hash'), '', 'the one-use secret is stripped from browser history');
  const device = await chrome.evaluate(browserDeviceExpression());
  assert.equal(device.extractable, false, 'the private phone key is persisted non-extractable in IndexedDB');
  assert.equal(JSON.parse(readFileSync(machineFile, 'utf8')).devices[0].deviceId, device.id);
  assert.equal(JSON.parse(readFileSync(machineFile, 'utf8')).pending, null);

  const fourth = await project(box, 'fourth-project');
  const allRoots = [...roots, fourth];
  assert.equal(existsSync(join(fourth, '.git/pullboard/relay.json')), true, 'registration actually creates the future relay link');
  assert.equal(link(fourth).account, '7', 'registration alone linked the fourth project with the saved account');
  assert.equal(box.calls.filter(call => call.path === '/auth/device/start').length, 1, 'no second machine sign-in');
  await chrome.navigate(box.origin);
  await chrome.waitFor("document.querySelectorAll('#proj-list .proj.repo').length === 4");
  assert.deepEqual(await chrome.evaluate(browserDeviceExpression()), device, 'a new page retrieves the same private device key');
  await chrome.close();
  rmSync(join(profileDirectory, 'DevToolsActivePort'), { force: true });
  chrome = await startChrome({ profileDirectory });
  assert.equal((await chrome.send('Network.setCookie', { name: 'pb_session', value: link(box.root).token, url: box.origin, httpOnly: true, sameSite: 'Lax' })).success, true);
  await chrome.navigate(box.origin);
  await chrome.waitFor("document.querySelectorAll('#proj-list .proj.repo').length === 4");
  assert.deepEqual(await chrome.evaluate(browserDeviceExpression()), device, 'a new browser process retrieves the original non-extractable key');
  for (const root of allRoots) {
    const board = link(root).board;
    assert.equal(await chrome.evaluate(`Object.hasOwn(JSON.parse(localStorage.getItem('pullboard.relay.keys.v1')), ${JSON.stringify(board)})`), true,
      'the actual browser unwrapped each board key, including the later board');
  }

  // Every CLI invocation is a new process. The saved settings and device eliminate renewed setup.
  const resumed = await command(box.root, box.env, ['relay', 'on', '--all']).done;
  assert.equal(resumed.code, 0);
  assert.equal(resumed.document.linked.length, 4);
  assert.equal(resumed.document.paired, true);
  assert.equal(box.calls.filter(call => call.path === '/auth/device/start').length, 1);
  assert.deepEqual(await chrome.evaluate(browserDeviceExpression()), device);

  const publicBytes = Buffer.concat(box.transit.flatMap(record => [record.request, record.response]));
  const durableBytes = readFileSync(join(box.relayDirectory, 'devices.sqlite'));
  assert.equal(publicBytes.includes(pending.secret), false, 'the pairing secret never reaches the relay');
  for (const root of allRoots) {
    const raw = readFileSync(join(box.env.PULLBOARD_HOME, 'relay-keys', link(root).board + '.key'), 'utf8').trim();
    assert.equal(publicBytes.includes(raw), false, 'no clear board key in actual relay traffic');
    assert.equal(durableBytes.includes(raw), false, 'no clear board key in relay device records');
    assert.equal(durableBytes.includes(Buffer.from(raw, 'base64url')), false, 'no raw board-key bytes in relay records');
  }
  assert.equal((await command(fourth, box.env, ['relay', 'off']).done).code, 0);
  assert.equal((await command(fourth, box.env, ['init']).done).code, 0);
  assert.equal(existsSync(join(fourth, '.git/pullboard/relay.json')), false, 'an excluded board stays off on later registration');
  const stillExcluded = await command(box.root, box.env, ['relay', 'on', '--all']).done;
  assert.equal(stillExcluded.code, 0);
  assert.equal(stillExcluded.document.linked.length, 3, 'machine setup does not undo an explicit board opt-out');
  assert.equal((await command(fourth, box.env, ['relay', 'on', '--url', box.origin]).done).code, 0);
  assert.equal(JSON.parse(readFileSync(machineFile, 'utf8')).excluded.includes(fourth), false, 'explicit board linking clears its opt-out');
  await chrome.navigate(box.origin);
  await chrome.waitFor("document.querySelectorAll('#proj-list .proj.repo').length === 4");
  assert.deepEqual(await chrome.evaluate(browserDeviceExpression()), device, 'the paired phone opens a relinked board with its new wrapped key');
  const revoked = await command(box.root, box.env, ['relay', 'revoke', device.id]).done;
  assert.equal(revoked.code, 0);
  assert.match(revoked.document.notice, /already received remain known/u);
  assert.equal(JSON.parse(readFileSync(machineFile, 'utf8')).devices.length, 0);
});


test('set up once keeps completed links on interruption and names partial failures [H5,H17]', async t => {
  const box = await relayClientFixture(t);
  const bad = await project(box, 'invalid-origin-project');
  assert.equal(spawnSync('git', ['remote', 'set-url', 'origin', 'https://invalid.example/repository.git'], { cwd: bad, env: box.env }).status, 0);
  const file = join(box.env.PULLBOARD_HOME, 'relay-machine/state.json');
  const started = command(box.root, box.env, ['relay', 'on', '--all', '--url', box.origin]);
  t.after(async () => { if (started.child.exitCode === null) started.child.kill('SIGTERM'); await started.done.catch(() => {}); });
  await waitFor(() => box.calls.some(call => call.method === 'GET' && call.path.startsWith('/api/v1/devices/enrollments/')),
    'first pairing is waiting in the foreground');
  started.child.kill('SIGINT');
  const partial = await started.done;
  assert.equal(partial.code, 1, 'a named project failure produces a nonzero status even when the other board linked');
  assert.equal(partial.document.linked.length, 1);
  assert.equal(partial.document.failed[0].root, bad);
  assert.match(partial.document.failed[0].reason, /GitHub/u);
  assert.equal(partial.document.paired, false);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).pending, null, 'interruption leaves no half device enrollment');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).devices.length, 0);
  const retained = link(box.root).board;
  assert.equal(spawnSync('git', ['remote', 'set-url', 'origin', 'git@github.com:fixture/repository.git'], { cwd: bad, env: box.env }).status, 0);
  const before = box.calls.length;
  const retry = command(box.root, box.env, ['relay', 'on', '--all']);
  t.after(async () => { if (retry.child.exitCode === null) retry.child.kill('SIGTERM'); await retry.done.catch(() => {}); });
  await waitFor(() => box.calls.slice(before).some(call => call.method === 'GET' && call.path.startsWith('/api/v1/devices/enrollments/')),
    'a later process can obtain a fresh pairing link without repeating sign-in');
  retry.child.kill('SIGINT');
  const completed = await retry.done;
  assert.equal(completed.code, 0, 'successful links exit zero even when phone pairing was interrupted');
  assert.equal(completed.document.linked.length, 2);
  assert.equal(link(box.root).board, retained, 'rerunning setup keeps the existing board and key');
  assert.equal(box.calls.filter(call => call.path === '/auth/device/start').length, 1);
});

test('set up once reports a newly registered project when its stored session is gone [H5,H17]', async t => {
  const box = await relayClientFixture(t);
  const machine = new URL('../src/relay-machine.js', import.meta.url).href;
  const saved = await box.script(`import { updateRelayMachine } from ${JSON.stringify(machine)};
    updateRelayMachine(state => {state.autoLink=true;state.session=null;}); console.log(JSON.stringify({saved:true}));`);
  assert.equal(saved.code, 0);
  const unlinked = await project(box, 'needs-signin-project');
  assert.equal(existsSync(join(unlinked, '.git/pullboard/relay.json')), false);
  const message = 'not linked: needs-signin-project (sign in again: pullboard relay on --all)';
  const doctor = await command(unlinked, box.env, ['doctor']).done;
  assert.equal(doctor.document.problems.some(problem => problem.message === message), true);
  const resume = await command(unlinked, box.env, ['resume']).done;
  assert.equal(resume.document.relayProblems.some(problem => problem.message === message), true);
  assert.equal(box.calls.filter(call => call.path === '/auth/device/start').length, 0, 'registration never silently starts another GitHub sign-in');
});
