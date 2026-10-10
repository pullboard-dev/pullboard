/** Same-user agents keep working while only the paired phone holds person authority [H5,H16,H17,B26]. */
import assert from 'node:assert/strict';
import { startFixtureChild as spawn, runFixtureChild as spawnSync } from './fixture-child.js';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { AGENT_SHELL_MARKERS, SSH_SHELL_MARKERS } from '../src/person.js';
import { ENGINE_VERSION } from '../src/machine.js';
import { relayClientFixture } from './relay-client-fixture.js';
import { findChromeExecutable, startChrome } from './relay-browser-fixture.js';

const CLI = resolve(import.meta.dirname, '../bin/pullboard.js');

/** Run a real native command while allowing a phone tap before the foreground process finishes. */
function command(root, environment, args) {
  const child = spawn(process.execPath, [CLI, ...args, '--json'], { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', part => { output += part; });
  child.stderr.resume();
  const done = new Promise((resolveResult, reject) => {
    child.once('close', (code, signal) => {
      if (signal) return reject(new Error(child.fixtureFailure));
      try { resolveResult({ code, document: JSON.parse(output) }); }
      catch { reject(new Error(child.fixtureFailure ?? 'private native command returned invalid JSON for ' + args[0])); }
    });
  });
  return { child, done };
}

/** Poll an actual persisted or HTTP-observed condition without retrying a move. */
async function waitFor(read, message, milliseconds = 30000) {
  const deadline = Date.now() + milliseconds;
  do {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => { setTimeout(resolve, 25); });
  } while (Date.now() < deadline);
  assert.fail(message);
}

/** Inspect every regular client file without following symlinks outside the private fixture. */
function assertNoPersonPower(directory) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (stat.isDirectory()) assertNoPersonPower(path);
    else if (stat.isFile()) assert.equal(/(?:ps_|pg_)[A-Za-z0-9_-]{43}/u.test(readFileSync(path).toString('latin1')), false,
      'no client file stores a person session or native grant');
  }
}

/** Run actual private Git with fixed identity and no credential-bearing diagnostics. */
function git(root, env, ...args) {
  const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, 'private Git ' + args[0] + ' succeeds: ' + result.stderr.replace(/(?:ps_|pm_|pa_|pg_)[A-Za-z0-9_-]{43}/gu, '[private credential]'));
  return result.stdout.trim();
}

test('same-user agents never act as their person while the phone approves native actions [H5,H16,H17,B26]', {
  timeout: 180000,
}, async t => {
  assert.ok(findChromeExecutable(), 'the security proof requires actual Chrome');
  const box = await relayClientFixture(t);
  symlinkSync('/bin/sh', join(box.env.PATH, 'sh'));
  writeFileSync(join(box.env.PATH, 'pullboard'), '#!/bin/sh\nexec node ' + "'" + CLI.replaceAll("'", "'\\''") + "'" + ' "$@"\n', { mode: 0o700 });
  const personEnv = { ...box.env };
  for (const key of [...AGENT_SHELL_MARKERS, ...SSH_SHELL_MARKERS]) delete personEnv[key];
  const machineFile = join(box.env.PULLBOARD_HOME, 'relay-machine/state.json');
  const fixtureSource = join(box.root, 'src/security-fixture.js');
  mkdirSync(join(box.root, 'src'), { recursive: true });
  writeFileSync(fixtureSource, 'export const ready = true;\n');
  const configFile = join(box.root, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  const buildLane = 'core';
  config.lanes[buildLane] = { owns: ['src/'], specs: ['G'] };
  config.gate = 'node --check src/security-fixture.js';
  writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
  writeFileSync(join(box.root, 'SPEC.md'), readFileSync(join(box.root, 'SPEC.md'), 'utf8') + '\n- G1 [approved, must] A private security fixture parses. | gate: node --check src/security-fixture.js\n');
  git(box.root, personEnv, 'add', '-A');
  git(box.root, personEnv, 'commit', '-q', '-m', 'test(fixture): prepare native security proof [G1]');
  const item = await box.cli('add', buildLane, 'native scoped work', '--specs', 'G1', '--criterion', 'the private source parses');
  assert.equal(item.code, 0);
  const itemId = item.document.item.item_id;

  const setup = command(box.root, personEnv, ['relay', 'on', '--all', '--url', box.origin]);
  t.after(async () => { if (setup.child.exitCode === null) setup.child.kill('SIGTERM'); await setup.done.catch(() => {}); });
  const pending = await waitFor(() => existsSync(machineFile) && JSON.parse(readFileSync(machineFile)).pending,
    'foreground setup publishes the one-use phone enrollment');
  const chrome = await startChrome();
  t.after(() => chrome.close());
  const phone = await box.phoneSession();
  await chrome.send('Network.setCookie', { name: 'pb_session', value: phone.token, url: box.origin, httpOnly: true, sameSite: 'Lax' });
  await chrome.navigate(box.origin + '/#device=' + pending.locator + '.' + pending.secret);
  assert.equal((await setup.done).code, 0, 'one foreground sign-in links and pairs without saving the session');
  await chrome.waitFor("document.querySelector('#phone-approvals') !== null");
  const machine = JSON.parse(readFileSync(machineFile));
  const link = JSON.parse(readFileSync(box.linkFile));
  assert.match(link.token, /^pm_[A-Za-z0-9_-]{43}$/u);
  assert.equal(Object.hasOwn(machine, 'session'), false);
  assertNoPersonPower(box.root); assertNoPersonPower(box.env.HOME);

  const joined = await command(box.root, personEnv, ['worktree', buildLane]).done;
  assert.equal(joined.code, 0, 'machine credential enrolls the real agent without a tap: ' + joined.document.error?.code + ' ' + joined.document.error?.message);
  const agentRoot = joined.document.path;
  const agentId = joined.document.agent;
  const agentEnv = { ...personEnv, AI_AGENT: '1', CODEX_SHELL: '1', CODEX_THREAD_ID: 'private-security-agent', SSH_CONNECTION: '127.0.0.1 1 127.0.0.1 2' };
  const approvedBefore = box.calls.filter(call => call.path.endsWith('/authorize')).length;
  const claim = await command(agentRoot, agentEnv, ['claim', String(itemId)]).done;
  assert.equal(claim.code, 0, 'the SSH agent claims with its own PA while the phone remains active');
  writeFileSync(join(agentRoot, 'src/security-fixture.js'), 'export const ready = true;\nexport const built = true;\n');
  git(agentRoot, agentEnv, 'add', 'src/security-fixture.js');
  git(agentRoot, agentEnv, 'commit', '-q', '-m', 'feat(fixture): prove scoped agent submit [G1]');
  const submitted = await command(agentRoot, agentEnv, ['submit', String(itemId)]).done;
  assert.equal(submitted.code, 0, 'the SSH agent submits a clean native commit with its gate green');
  assert.equal((await command(agentRoot, agentEnv, ['shout', 'coordinator', 'scoped agent completed its work']).done).code, 0);
  assert.equal(box.calls.filter(call => call.path.endsWith('/authorize')).length, approvedBefore, 'agent enroll/claim/submit/shout asks for no phone approval');
  assertNoPersonPower(box.root); assertNoPersonPower(box.env.HOME);
  const state = JSON.parse(readFileSync(box.linkFile));
  const pa = state.agentTokens[agentId];
  assert.match(pa.token, /^pa_[A-Za-z0-9_-]{43}$/u);
  const listed = await command(agentRoot, agentEnv, ['relay', 'tokens']).done;
  assert.equal(listed.code, 0, 'board-scoped token ids need no tap');
  assert.equal(listed.document.tokens.some(row => Object.hasOwn(row, 'token') || Object.hasOwn(row, 'hash')), false);
  const nativeCalls = box.calls.filter(call => !call.browser).length;
  const denied = await command(agentRoot, agentEnv, ['relay', 'revoke', machine.devices[0].deviceId]).done;
  assert.equal(denied.code, 1);
  assert.equal(denied.document.error.code, 'B26_PERSON_CHANNEL');
  assert.equal(box.calls.filter(call => !call.browser).length, nativeCalls, 'an agent shell refuses before every approval/network request');

  await t.test('saved PM and PA never acquire HTTP person authority [H16,B26]', async () => {
    const other = await box.additionalBoard('independent board remains private');
    for (const token of [state.token, pa.token]) {
      const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'x-pullboard-engine': String(ENGINE_VERSION) };
      const inventory = await fetch(box.origin + '/auth/boards', { headers });
      assert.equal(inventory.status, 200);
      assert.deepEqual((await inventory.json()).boards.map(value => value.id), [state.board]);
      for (const [path, body, method = 'POST'] of [
        ['/auth/boards/link', { board: 'c'.repeat(32), repository: 'fixture/repository' }],
        ['/auth/machines', { board: state.board, machine: 'forged-machine' }],
        ['/auth/tokens/revoke', { id: phone.id }],
        ['/auth/tokens', { board: other.id, agent: 'cross-board' }],
        ['/api/v1/boards/' + state.board + '/requests', { sequence: 1, sealed: 'AA' }],
        ['/api/v1/devices/' + machine.devices[0].deviceId, undefined, 'DELETE'],
        ['/api/v1/boards/' + other.id + '/state', undefined, 'GET'],
      ]) {
        const response = await fetch(box.origin + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
        assert.ok(response.status >= 400 && response.status < 500, 'a stored credential cannot exercise ' + method + ' ' + path);
      }
      const cookie = await fetch(box.origin + '/auth/boards', { headers: { cookie: 'pb_session=' + token } });
      assert.equal(cookie.status, 401, 'a saved delegate cannot become the phone cookie');
    }
  });

  await t.test('the paired phone still sends person intent through the actual page [H12,H16,B26]', async () => {
    await chrome.navigate(box.origin + '/#board=' + state.board + '&key=' + readFileSync(box.keyFile, 'utf8').trim());
    await chrome.waitFor('typeof data !== "undefined" && !!data?.project && !!transport');
    await chrome.evaluate(`document.querySelector('[data-tab=shouts]').click(); document.querySelector('#shout-to').value='coordinator'; document.querySelector('#shout-text').value='PRIVATE_PHONE_PERSON_ACTION'; document.querySelector('#shout-form').requestSubmit(); true`);
    await chrome.waitFor('data.project.personRequests?.some(row => row.move?.args?.text === "PRIVATE_PHONE_PERSON_ACTION")');
    assert.equal((await command(agentRoot, agentEnv, ['status']).done).code, 0, 'the native machine fulfils the ordered phone request while the agent keeps working');
    const exported = await command(box.root, personEnv, ['export']).done;
    assert.equal(exported.code, 0);
    assert.equal(exported.document.tables.shout.filter(row => row.shout_from === 'person' && row.shout_text === 'PRIVATE_PHONE_PERSON_ACTION').length, 1);
    assertNoPersonPower(box.root); assertNoPersonPower(agentRoot); assertNoPersonPower(box.env.HOME);
  });

  await t.test('native token revocation needs exactly one phone tap and the grant cannot replay [H16,B26]', async () => {
    const revoke = command(box.root, personEnv, ['relay', 'revoke', pa.id]);
    t.after(async () => { if (revoke.child.exitCode === null) revoke.child.kill('SIGTERM'); await revoke.done.catch(() => {}); });
    await chrome.waitFor("[...document.querySelectorAll('.phone-approval')].some(node => node.textContent.includes(" + JSON.stringify(pa.id) + '))');
    const before = box.calls.filter(call => call.path.endsWith('/authorize')).length;
    assertNoPersonPower(box.root); assertNoPersonPower(box.env.HOME);
    await chrome.evaluate("[...document.querySelectorAll('.phone-approval')].find(node => node.textContent.includes(" + JSON.stringify(pa.id) + ')).querySelector("button").click()');
    assert.equal((await revoke.done).code, 0);
    assert.equal(box.calls.filter(call => call.path.endsWith('/authorize')).length, before + 1, 'one tap issues one grant');
    const execution = box.transit.findLast(record => record.path.endsWith('/execute'));
    const replay = await fetch(box.origin + execution.path, { method: 'POST', headers: { authorization: 'Bearer ' + state.token,
      'content-type': 'application/json', 'x-pullboard-engine': String(ENGINE_VERSION) }, body: execution.request });
    assert.notEqual(replay.status, 200, 'the exact already consumed grant refuses replay');
    assert.equal((await replay.json()).error.code, 'PHONE_APPROVAL_USED');
    assertNoPersonPower(box.root); assertNoPersonPower(box.env.HOME);
  });
  await t.test('native device revocation needs one phone tap and offline agent unlink always works [H5,H16,H17,B26]', async () => {
    const target = machine.devices[0].deviceId;
    const revoke = command(box.root, personEnv, ['relay', 'revoke', target]);
    t.after(async () => { if (revoke.child.exitCode === null) revoke.child.kill('SIGTERM'); await revoke.done.catch(() => {}); });
    await chrome.waitFor("[...document.querySelectorAll('.phone-approval')].some(node => node.textContent.includes(" + JSON.stringify(target) + '))');
    const before = box.calls.filter(call => call.path.endsWith('/authorize')).length;
    assertNoPersonPower(box.root); assertNoPersonPower(box.env.HOME);
    await chrome.evaluate("[...document.querySelectorAll('.phone-approval')].find(node => node.textContent.includes(" + JSON.stringify(target) + ')).querySelector("button").click()');
    assert.equal((await revoke.done).code, 0);
    assert.equal(box.calls.filter(call => call.path.endsWith('/authorize')).length, before + 1);
    assert.equal(JSON.parse(readFileSync(machineFile)).devices.length, 0);
    await box.stopRelay();
    const calls = box.calls.length;
    const off = await command(agentRoot, agentEnv, ['relay', 'off']).done;
    assert.equal(off.code, 0, 'an offline SSH agent can always stop local syncing');
    assert.equal(existsSync(box.linkFile), false);
    assert.match(off.document.notice, /relay copy stays until you approve/u);
    assert.equal(box.calls.length, calls, 'local unlink needs no reachable relay and no phone tap');
    assertNoPersonPower(box.root); assertNoPersonPower(agentRoot); assertNoPersonPower(box.env.HOME);
  });

});
