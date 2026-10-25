/** The view uses the actual device authorization and all-board linking path without a terminal [H5,N26]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import * as setup from '../src/relay-setup.js';
import { relayClientFixture } from './relay-client-fixture.js';
import { createDeviceKeys, signDeviceEnrollment } from '../src/relay-device-keys.js';
import { runFixtureChild, runFixtureGit, startFixtureChild } from './fixture-child.js';
import { AGENT_SHELL_MARKERS, SSH_SHELL_MARKERS } from '../src/person.js';

/** Run the public view adapter in a process whose complete home, registry and boards are private. */
async function viewScenario(box, mode) {
  const setupModule = pathToFileURL(resolve(import.meta.dirname, '../src/relay-setup.js')).href;
  const relayModule = pathToFileURL(resolve(import.meta.dirname, '../src/relay.js')).href;
  const cliModule = pathToFileURL(resolve(import.meta.dirname, '../src/cli.js')).href;
  const fixtureModule = pathToFileURL(resolve(import.meta.dirname, 'fixture-child.js')).href;
  const machineModule = pathToFileURL(resolve(import.meta.dirname, '../src/relay-machine.js')).href;
  return box.script(`
import assert from 'node:assert/strict';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as setup from ${JSON.stringify(setupModule)};
import { relayLinkAvailability } from ${JSON.stringify(relayModule)};
import { main } from ${JSON.stringify(cliModule)};
import { runFixtureGit } from ${JSON.stringify(fixtureModule)};
import { updateRelayMachine } from ${JSON.stringify(machineModule)};
const root = ${JSON.stringify(box.root)};
const relayUrl = ${JSON.stringify(box.origin)};
const mode = ${JSON.stringify(mode)};
const shouldLink = ['linked','pairing-cleanup-refused','excluded'].includes(mode);
const expectedLinked = mode === 'excluded' ? 1 : 2;
const other = join(dirname(root), 'second-view-board');
mkdirSync(other);
for (const args of [['init','-q','-b','main'], ['-c','commit.gpgsign=false','commit','--allow-empty','-q','-m','chore: private view board'],
  ['remote','add','origin','git@github.com:fixture/repository-2.git']]) runFixtureGit(args, {cwd:other,env:process.env});
const quiet = {cwd:other,stdin:process.stdin,stdout:{isTTY:false,write(){}},stderr:{write(){}}};
assert.equal(await main(['init','--json'], quiet), 0, 'the second board is registered through the production CLI');
const links = [root,other].map(repo => join(repo,'.git','pullboard','relay.json'));
for (const repo of [root,other]) assert.deepEqual(relayLinkAvailability(repo),{linked:false,unlinking:false});
if (mode === 'excluded') updateRelayMachine(state => { state.excluded.push(other); });
let intentId;
let linkingCancelRefused = false;
let releasePairingDelete;
let pairingDeleteStarted = false;
let holdPairingDelete = mode === 'linked';
let releaseDeviceCancel;
let deviceCancelStarted = false;
let holdDeviceCancel = true;
let corruptInstructions = ['invalid-url','cleanup-refused'].includes(mode);
const originalFetch = globalThis.fetch;
const starting = new AbortController();
globalThis.fetch = async (input, options) => {
  const address = new URL(input instanceof Request ? input.url : input);
  if (mode === 'abort-start' && address.pathname === '/auth/device/start') {
    starting.abort();
    throw new DOMException('private start aborted', 'AbortError');
  }
  if (shouldLink && address.pathname === '/auth/boards/link' && !linkingCancelRefused) {
    assert.equal(setup.viewSignInStatus(intentId).state, 'linking');
    await assert.rejects(setup.cancelViewSignIn(intentId), {code:'VIEW_SIGN_IN_LINKING'});
    linkingCancelRefused = true;
  }
  if (holdPairingDelete && options?.method === 'DELETE' && address.pathname.startsWith('/api/v1/devices/enrollments/')) {
    pairingDeleteStarted = true;
    await new Promise(resolve => { releasePairingDelete = resolve; });
  }
  if (corruptInstructions && address.pathname === '/auth/device/start') {
    const response = await originalFetch(input,options);
    const body = await response.json();
    body.verificationURL = 'https://example.invalid/login/device';
    return new Response(JSON.stringify(body),{status:response.status,headers:response.headers});
  }
  if (corruptInstructions && holdDeviceCancel && address.pathname === '/auth/device/cancel') {
    deviceCancelStarted = true;
    await new Promise(resolve => { releaseDeviceCancel = resolve; });
    if (mode === 'cleanup-refused') return new Response(JSON.stringify({version:1,cancelled:false}),{status:200});
  }
  if (mode === 'pairing-cleanup-refused' && options?.method === 'DELETE'
    && address.pathname.startsWith('/api/v1/devices/enrollments/')) {
    return new Response(JSON.stringify({version:1,error:{code:'UNAVAILABLE',message:'private cleanup unavailable'}}),{status:503});
  }
  return originalFetch(input,options);
};
/** Await a state transition; this is a hang ceiling, never a performance assertion. */
async function until(read) {
  const deadline = Date.now()+20000;
  do {
    const found = read();
    if (found) return found;
    await new Promise(done => setTimeout(done,25));
  } while (Date.now()<deadline);
  assert.fail('the private view operation did not reach its expected state');
}
/** Scan private fixture files in bounded chunks; no session or device ticket belongs on disk. */
function containsPersonMaterial(directory) {
  for (const entry of readdirSync(directory,{withFileTypes:true})) {
    const path = join(directory,entry.name);
    if (entry.isDirectory()) { if (containsPersonMaterial(path)) return true; continue; }
    if (!entry.isFile()) continue;
    const fd = openSync(path,'r');
    const chunk = Buffer.alloc(65536);
    let tail = '';
    try {
      let length;
      while ((length=readSync(fd,chunk,0,chunk.length,null))) {
        const text = tail+chunk.subarray(0,length).toString('latin1');
        if (/(?:ps_|pd_|pg_)[A-Za-z0-9_-]{43}/u.test(text)) return true;
        tail = text.slice(-96);
      }
    } finally { closeSync(fd); }
  }
  return false;
}
try {
  if (corruptInstructions) {
    let settled = false;
    const pending = setup.startViewSignIn({relayUrl}).then(
      () => { settled = true; assert.fail('foreign provider instructions must be refused'); },
      error => { settled = true; return error; });
    try {
      await until(() => deviceCancelStarted);
      assert.equal(settled,false,'the error must wait for real ticket cleanup');
      assert.equal(links.some(existsSync),false);
    } finally { holdDeviceCancel = false; releaseDeviceCancel?.(); }
    const error = await pending;
    assert.equal(error.code,mode === 'cleanup-refused' ? 'OAUTH_CLEANUP' : 'VIEW_SIGN_IN_RESPONSE');
    corruptInstructions = false;
    const recovery = await setup.startViewSignIn({relayUrl});
    intentId = recovery.intentId;
    const cancelled = await setup.cancelViewSignIn(intentId);
    assert.equal(cancelled.state,'cancelled','finished failed startup does not leave a busy view');
    assert.equal(links.some(existsSync),false);
    assert.equal(containsPersonMaterial(dirname(root)),false);
    process.stdout.write(JSON.stringify({state:error.code,linked:0,storedPersonMaterial:false}));
  } else if (mode === 'abort-start') {
    await assert.rejects(setup.startViewSignIn({relayUrl,signal:starting.signal}), {code:'OAUTH_CANCELLED'});
    assert.equal(links.some(existsSync),false,'a cancelled start does not link a board');
    assert.equal(containsPersonMaterial(dirname(root)),false,'no private session or ticket is saved');
    process.stdout.write(JSON.stringify({state:'cancelled',linked:0,storedPersonMaterial:false}));
  } else {
    const instructions = await setup.startViewSignIn({relayUrl});
    intentId = instructions.intentId;
    assert.deepEqual(Object.keys(instructions).sort(),['expiresAt','intentId','userCode','verificationURL']);
    assert.equal(new URL(instructions.verificationURL).pathname,'/login/device');
    assert.equal(instructions.userCode,'TEST-ONLY');
    assert.equal(setup.viewSignInStatus(intentId).state,'waiting');
    await assert.rejects(setup.startViewSignIn({relayUrl}),{code:'VIEW_SIGN_IN_BUSY'});
    let final;
    if (mode === 'cancel') {
      final = await setup.cancelViewSignIn(intentId);
      assert.equal(final.state,'cancelled');
    } else if (shouldLink) {
      const pairing = await until(() => setup.viewSignInStatus(intentId).state === 'pairing');
      assert.equal(pairing,true);
      const publicStatus = setup.viewSignInStatus(intentId);
      assert.equal(publicStatus.boards.length,2);
      if (mode === 'excluded') {
        assert.equal(publicStatus.boards.find(board => board.root === root)?.outcome,'linked');
        const skipped = publicStatus.boards.find(board => board.root === other);
        assert.equal(skipped?.outcome,'skipped','an excluded registered board still has an explicit result');
        assert.match(skipped.reason,/Excluded from automatic linking/u);
      } else assert.ok(publicStatus.boards.every(board => board.outcome === 'linked'));
      assert.ok(!JSON.stringify(publicStatus).includes('#device='),'public status never contains the pairing capability');
      assert.ok(!/(?:ps_|pd_|pg_)[A-Za-z0-9_-]{43}/u.test(JSON.stringify(publicStatus)));
      const navigation = setup.viewSignInPairingNavigation(intentId);
      assert.equal(new URL(navigation.url).origin,relayUrl);
      assert.ok(new URL(navigation.url).hash.startsWith('#device='),'only the trusted view redirect accessor returns pairing navigation');
      assert.equal(linkingCancelRefused,true,'linking finishes as one batch despite a cancel request');
      const cancellation = setup.cancelViewSignIn(intentId);
      try {
        if (mode === 'linked') {
          await until(() => pairingDeleteStarted);
          assert.equal(setup.viewSignInStatus(intentId).state,'pairing','cleanup has not completed yet');
          assert.throws(() => setup.viewSignInPairingNavigation(intentId),{code:'VIEW_PAIRING_NOT_READY'},
            'navigation is revoked while the real enrollment deletion is still pending');
        }
      } finally { releasePairingDelete?.(); }
      final = await cancellation;
      assert.equal(final.state,'pairing-stopped');
      assert.equal(final.pairingCleanup,mode === 'pairing-cleanup-refused' ? 'unconfirmed' : 'confirmed');
      if (mode === 'pairing-cleanup-refused') assert.equal(final.error.code,'VIEW_PAIRING_CLEANUP',
        'unconfirmed remote deletion remains visible to the user');
      assert.equal(final.boards.filter(board => board.outcome === 'linked').length,expectedLinked);
      for (const repo of [root,other]) assert.deepEqual(relayLinkAvailability(repo),{linked:!(mode === 'excluded' && repo === other),unlinking:false});
      const saved = readFileSync(links[0],'utf8');
      try {
        writeFileSync(links[0],JSON.stringify({...JSON.parse(saved),unlinking:true}));
        assert.deepEqual(relayLinkAvailability(root),{linked:false,unlinking:true},
          'the lightweight read preserves pending unlink cleanup eligibility');
      } finally { writeFileSync(links[0],saved); }
      assert.throws(() => setup.viewSignInPairingNavigation(intentId),{code:'VIEW_PAIRING_NOT_READY'});
    } else {
      final = await until(() => {
        const status=setup.viewSignInStatus(intentId);
        return ['declined','expired','done'].includes(status.state) ? status : null;
      });
      assert.equal(final.state,mode);
    }
    const linked = links.filter(existsSync).length;
    assert.equal(linked,shouldLink ? expectedLinked : 0,'only confirmed sign-in may link eligible boards');
    assert.equal(containsPersonMaterial(dirname(root)),false,'neither the person session nor the relay ticket is written to any fixture file');
    process.stdout.write(JSON.stringify({state:final.state,linked,storedPersonMaterial:false}));
  }
} finally {
  holdPairingDelete = false;
  releasePairingDelete?.();
  holdDeviceCancel = false;
  releaseDeviceCancel?.();
  if (intentId) await setup.cancelViewSignIn(intentId);
  globalThis.fetch = originalFetch;
}
`);
}

test("the view's sign-in links every board without a terminal or a stored session [H5,N26]", async (t) => {
  assert.equal(typeof setup.startViewSignIn, 'function', 'core exposes a view sign-in adapter');
  assert.equal(typeof setup.viewSignInStatus, 'function');
  assert.equal(typeof setup.cancelViewSignIn, 'function');
  for (const mode of ['linked', 'cancel', 'declined', 'expired', 'abort-start', 'invalid-url', 'cleanup-refused', 'pairing-cleanup-refused', 'excluded']) {
    await t.test(mode, async (t) => {
      const box = await relayClientFixture(t);
      box.providerState.deviceAuthorized = ['linked','pairing-cleanup-refused','excluded'].includes(mode);
      box.providerState.deviceDeclined = mode === 'declined';
      box.providerState.deviceExpired = mode === 'expired';
      const before = box.providerCalls.filter(call => call.path === '/login/device/code').length;
      const result = await viewScenario(box, mode);
      assert.equal(result.code, 0, result.failure ?? 'the private view scenario failed');
      const outcome = result.document;
      assert.equal(outcome.linked, ['linked','pairing-cleanup-refused','excluded'].includes(mode) ? (mode === 'excluded' ? 1 : 2) : 0);
      assert.equal(outcome.storedPersonMaterial, false);
      const after = box.providerCalls.filter(call => call.path === '/login/device/code').length;
      assert.equal(after - before, mode === 'abort-start' ? 0 : ['invalid-url','cleanup-refused'].includes(mode) ? 2 : 1, 'one device sign-in serves each attempt, including explicit recovery after invalid instructions');
    });
  }
});

const CLI = resolve(import.meta.dirname, '../bin/pullboard.js');

/** Pair a stand-in phone through the real relay: Node signs the same enrollment the phone page sends. */
async function pairPhone(box, t) {
  const child = startFixtureChild(process.execPath, [CLI, 'relay', 'on', '--all', '--url', box.origin, '--name', 'Kitchen computer', '--json'], { cwd: box.root, env: box.env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  const exited = new Promise(done => child.once('close', done));
  const machineFile = join(box.env.PULLBOARD_HOME, 'relay-machine/state.json');
  const deadline = Date.now() + 20_000; // A hang ceiling for the foreground setup, never a performance assertion.
  let pending = null;
  while (!pending && Date.now() < deadline) {
    if (existsSync(machineFile)) pending = JSON.parse(readFileSync(machineFile, 'utf8')).pending;
    if (!pending) await new Promise(done => setTimeout(done, 25));
  }
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
async function phoneAndJoinedComputer(t) {
  const box = await relayClientFixture(t);
  const phone = await pairPhone(box, t);
  const printed = await box.cli('relay', 'pair');
  assert.equal(printed.code, 0, 'the linked computer prints a one-time code');
  const joined = await box.otherDeviceJoin(printed.document.code, 'Study computer');
  return { box, phone, joined };
}

/** Run relay devices on the linked computer and keep its text lines and its board name. */
async function devicesText(box, args) {
  const cliModule = JSON.stringify(pathToFileURL(resolve(import.meta.dirname, '../src/cli.js')).href);
  const projectsModule = JSON.stringify(pathToFileURL(resolve(import.meta.dirname, '../src/projects.js')).href);
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

test('relay devices names phones and joined computers with paired date and boards [H17]', async (t) => {
  const { box, phone, joined } = await phoneAndJoinedComputer(t);
  const { lines, names } = await devicesText(box, []);
  const day = value => new Date(value).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  const board = names[0];
  const phoneLine = lines.find(line => line.startsWith('Kitchen phone (phone): '));
  assert.ok(phoneLine, 'the phone is named by its label');
  assert.match(phoneLine, new RegExp(`^Kitchen phone \\(phone\\): paired ${day(phone.createdAt)}, last seen (?!unknown)[^;]+; reads ${board}$`, 'u'),
    'the phone line has its paired date, a last seen time and the board it reads');
  const computerLine = lines.find(line => line.includes('(computer): '));
  assert.ok(computerLine, 'the joined computer is listed on the linked computer');
  assert.match(computerLine, new RegExp(`^Study computer \\(computer\\): joined ${day(Date.now())}, last seen (?!unknown)[^;]+; reads ${board}$`, 'u'),
    'the joined computer is named by the person, with its joined date, last seen and board');
  assert.equal(lines.length, 2, 'one line each, with no ids');
  assert.ok(!/[0-9a-f]{64}/u.test(lines.join('\n')) && !lines.join('\n').includes(phone.deviceId), 'ids and fingerprints stay out of the default view');
  const verbose = await devicesText(box, ['--verbose']);
  assert.ok(verbose.lines.some(line => line.includes(phone.deviceId) && /fingerprint [0-9a-f]{64}$/u.test(line)), '--verbose adds the phone id and fingerprint');
  const json = await box.cli('relay', 'devices');
  assert.equal(json.code, 0, 'relay devices --json succeeds');
  const [phoneJson] = json.document.devices;
  assert.equal(json.document.devices.length, 1, 'the linked computer lists its one paired phone');
  assert.deepEqual([phoneJson.deviceId, phoneJson.label, phoneJson.pairedHere, phoneJson.createdAt, phoneJson.revoked, phoneJson.boards],
    [phone.deviceId, 'Kitchen phone', true, phone.createdAt, false, [board]], 'JSON names the phone with its paired date, status and board');
  assert.ok(Number.isSafeInteger(phoneJson.seen), 'JSON carries the relay last seen time');
  assert.ok(!('fingerprint' in phoneJson) && !/[0-9a-f]{64}/u.test(JSON.stringify(json.document)), 'default JSON leaves the fingerprint out');
  const verboseJson = await box.cli('relay', 'devices', '--verbose');
  assert.match(verboseJson.document.devices[0].fingerprint, /^[0-9a-f]{64}$/u, 'JSON adds the fingerprint only with --verbose');
  // The joined computer never paired the phone: it lists it by short id from the relay, with its status and board.
  const there = await joined.cli('relay', 'devices');
  assert.equal(there.code, 0, 'relay devices succeeds on the joined computer');
  assert.equal(there.document.computers[0].name, 'Kitchen computer', 'on --all retains the explicit computer name');
  assert.equal(there.document.devices.length, 1, "the joined computer lists the linked computer's phone");
  const [phoneThere] = there.document.devices;
  assert.deepEqual([phoneThere.deviceId, phoneThere.pairedHere, phoneThere.label, phoneThere.revoked, phoneThere.boards],
    [phone.deviceId, false, null, false, [joined.joined.name]], 'the joined computer knows the phone by id, paired on another computer');
  assert.ok(Number.isSafeInteger(phoneThere.seen) && !('fingerprint' in phoneThere), 'it carries last seen and no fingerprint');
  const plain = plainCommand(joined.root, joined.env, ['relay', 'devices']);
  const shown = await plain.done;
  assert.equal(shown.code, 0, shown.stderr);
  const otherLine = shown.stdout.split('\n').find(line => line.includes('(phone): '));
  assert.match(otherLine ?? '', new RegExp(`^Phone ${phone.deviceId.slice(-8)} \\(phone\\): paired on another computer, last seen (?!unknown)[^;]+; reads ${joined.joined.name}$`, 'u'),
    'the joined computer says the phone was paired on another computer, with its short id, last seen and board');

  // Revoke through a separate authenticated person request, leaving this computer's local
  // pairing record intact. A stale local roster must not claim the phone still reads this board.
  const person = await box.phoneSession();
  const headers = { authorization: 'Bearer ' + person.token };
  const revoked = await fetch(box.origin + '/api/v1/devices/' + phone.deviceId, { method: 'DELETE', headers });
  assert.equal(revoked.status, 200, 'an authenticated external revoke removes the remote device grant');
  const phoneGrant = await fetch(box.origin + '/api/v1/devices/' + phone.deviceId + '/boards', { headers });
  assert.equal(phoneGrant.status, 403, 'the revoked phone cannot read its board grants');
  assert.equal((await phoneGrant.json()).error.code, 'DEVICE_REVOKED', 'the relay fails closed for the revoked phone');
  const afterRevoke = await box.cli('relay', 'devices');
  assert.equal(afterRevoke.code, 0, 'the local roster remains available after the remote revoke');
  assert.equal(afterRevoke.document.devices.length, 1, 'the paired phone remains in local pairing history');
  const [stillPaired] = afterRevoke.document.devices;
  assert.deepEqual([stillPaired.deviceId, stillPaired.pairedHere, stillPaired.label, stillPaired.revoked],
    [phone.deviceId, true, 'Kitchen phone', true], 'the local phone entry remains and reflects revocation');
  assert.deepEqual(stillPaired.boards, [], 'the revoked phone no longer appears to read a board');
  const afterRevokeThere = await joined.cli('relay', 'devices');
  assert.equal(afterRevokeThere.code, 0, 'the other computer can still read its device roster');
  assert.deepEqual(afterRevokeThere.document.devices, [], 'the other computer does not restore the revoked phone from local history');
});

test('relay off names joined computers by the person-given name [H17]', async (t) => {
  const { box, joined } = await phoneAndJoinedComputer(t);
  const off = await box.cli('relay', 'off');
  assert.equal(off.code, 0, 'relay off unlinks this computer');
  assert.deepEqual(off.document.joined, ['Study computer'], 'the joined computer is named by the person');
  assert.deepEqual(off.document.affectedMachines, [joined.machine], 'the stable machine id stays beside the name');
  assert.ok(off.document.notice.includes('If you approve deletion, joined computers Study computer lose the shared copy'),
    'the warning names the joined computer by its explicit name before the phone approves the delete');
});

test('relay join names the board it joined [H17]', async (t) => {
  const { joined } = await phoneAndJoinedComputer(t);
  const { name, board, notice } = joined.joined;
  assert.equal(typeof name, 'string');
  assert.equal(notice, 'Joined ' + name + '. This brought one board; for another, run pullboard relay pair in that board on the linked computer. Run pullboard status to read it.',
    'join names the board and says it brought one board');
  assert.ok(!notice.includes(board), 'the board id stays out of the join message');
});

test('relay help lists every relay command, with a whole example [H17]', () => {
  const printed = spawnSync(process.execPath, [CLI, 'relay', '--help'], { cwd: tmpdir(), encoding: 'utf8' });
  assert.equal(printed.status, 0, printed.stderr);
  const [usage, rest] = printed.stdout.split('\nFlags:\n');
  for (const command of ['relay [status|on|off|pair|join <code>]', 'relay on --all', 'relay devices', 'relay revoke <device>',
    'relay tokens', 'relay revoke <token-id>', 'relay recover --skip <sequence>']) {
    assert.ok(usage.includes('pullboard ' + command), 'relay help lists pullboard ' + command);
  }
  const example = rest.split('\nExample:\n')[1].trim();
  assert.equal(example, 'pullboard relay on --all', 'the example is one whole command a person can paste');
  assert.ok(!/--all \[/u.test(rest), 'flags name --all alone');
});

test('relay pair labels the code for a computer and the QR for a phone [H17]', async (t) => {
  const box = await relayClientFixture(t);
  await box.link();
  const cliModule = pathToFileURL(resolve(import.meta.dirname, '../src/cli.js')).href;
  const result = await box.script(`
import { main } from ${JSON.stringify(cliModule)};
let output = '';
const streams = { cwd: ${JSON.stringify(box.root)}, stdout: { write: part => { output += part; } }, stderr: { write() {} } };
const code = await main(['relay', 'pair'], streams);
process.stdout.write(JSON.stringify({ code, lines: output.split('\\n') }));
`);
  assert.equal(result.code, 0, 'the private pair script completes');
  const { code, lines } = result.document;
  assert.equal(code, 0, 'relay pair publishes a code');
  const board = JSON.parse(readFileSync(box.linkFile, 'utf8')).board;
  const computer = lines.findIndex(line => line.startsWith('For another computer: '));
  assert.ok(computer >= 0, 'the one-time code is labelled for another computer');
  assert.match(lines[computer], new RegExp('run pullboard init, then pullboard relay join ' + board + '\\.[A-Za-z0-9_.-]+ --url '
    + box.origin.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') + '\\. The code works once, for 10 minutes\\.$', 'u'),
    'the computer line is the relay join command for this relay');
  const phone = lines.findIndex(line => line.startsWith('For a phone: scan this QR code'));
  assert.ok(phone > computer, 'the QR is labelled for a phone');
  assert.ok(lines[phone].includes(box.origin + '/#board=' + board), 'the phone link uses the relay this board is linked to');
  assert.ok((lines[phone + 1] ?? '').startsWith('\u001b[30;47m'), 'the QR follows its phone label');
  assert.ok(!lines.join('\n').includes('app.pullboard.dev'), 'a board on another relay never points at the hosted default');
});

test('the approval wait names the phone in local time once [H17]', async (t) => {
  const box = await relayClientFixture(t);
  await box.link();
  const module = name => JSON.stringify(pathToFileURL(resolve(import.meta.dirname, '../src/' + name)).href);
  const fixtureModule = JSON.stringify(pathToFileURL(resolve(import.meta.dirname, 'fixture-child.js')).href);
  const result = await box.script(`
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { main } from ${module('cli.js')};
import { readRelayMachine, updateRelayMachine } from ${module('relay-machine.js')};
import { runFixtureGit } from ${fixtureModule};
process.env.TZ = 'America/Chicago';
const root = ${JSON.stringify(box.root)};
const link = JSON.parse(readFileSync(${JSON.stringify(box.linkFile)}, 'utf8'));
const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', pair.publicKey);
updateRelayMachine(state => {
  state.autoLink = true;
  state.owner = { account: link.account, url: link.url };
  state.devices.push({ deviceId: 'device-' + 'a'.repeat(32), account: link.account, url: link.url, fingerprint: 'b'.repeat(64),
    label: 'Kitchen phone', createdAt: new Date().toISOString(), publicKey: { kty, crv, x, y } });
});
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const address = new URL(input instanceof Request ? input.url : input);
  // The stand-in phone never answers, so the link request stays pending.
  if (address.pathname.startsWith('/api/v1/devices/')) {
    const body = address.pathname === '/api/v1/devices/approvals' ? { version: 1 } : { version: 1, approval: { state: 'pending' } };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return originalFetch(input, options);
};
const other = join(dirname(root), 'waiting-board');
mkdirSync(other);
for (const args of [['init','-q','-b','main'], ['-c','commit.gpgsign=false','commit','--allow-empty','-q','-m','chore: waiting board'],
  ['remote','add','origin','git@github.com:fixture/repository-2.git']]) runFixtureGit(args, { cwd: other, env: process.env });
let errors = '';
const streams = { cwd: other, stdin: process.stdin, stdout: { isTTY: false, write() {} }, stderr: { write: part => { errors += part; } } };
const codes = [];
for (const argv of [['init'], ['status'], ['list']]) codes.push(await main(argv, streams));
globalThis.fetch = originalFetch;
const approval = readRelayMachine().approvals.find(entry => entry.root.endsWith('waiting-board'));
const expected = new Date(approval.context.expires).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: 'America/Chicago' });
process.stdout.write(JSON.stringify({ codes, lines: errors.split('\\n').filter(line => line.includes('waiting for phone approval')),
  expected, iso: new Date(approval.context.expires).toISOString() }));
`);
  assert.equal(result.code, 0, 'the private approval-wait script completes');
  const { codes, lines, expected, iso } = result.document;
  assert.deepEqual(codes, [0, 0, 0], 'init, status and list complete while the link waits');
  assert.equal(lines.length, 1, 'three commands in a row print the wait once');
  assert.equal(lines[0], 'waiting for phone approval: approve linking waiting-board on Kitchen phone by ' + expected + '; local work continues.',
    'the wait names the phone and the expiry in local time');
  assert.ok(!lines[0].includes(iso), 'the expiry is never printed in UTC');
});

/** Run the production CLI in plain words, with a finite hang ceiling and stdout kept as text. */
function plainCommand(root, env, args) {
  const child = startFixtureChild(process.execPath, [resolve(import.meta.dirname, '../bin/pullboard.js'), ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = { stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8').on('data', value => { output.stdout += value; });
  child.stderr.setEncoding('utf8').on('data', value => { output.stderr += value; });
  const done = new Promise((resolveResult, reject) => {
    child.once('error', reject);
    child.once('close', code => resolveResult({ code, ...output }));
  });
  return { child, output, done };
}

test('relay on --all says who signed in, what it linked and what it waits for [H5,I1]', async (t) => {
  const box = await relayClientFixture(t);
  const second = join(dirname(box.root), 'second-board');
  mkdirSync(second);
  for (const args of [['init', '-q', '-b', 'main'], ['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-q', '-m', 'fixture base'],
    ['remote', 'add', 'origin', 'git@github.com:fixture/repository-2.git']]) {
    assert.equal(runFixtureChild('git', args, { cwd: second, env: box.env }).status, 0);
  }
  assert.equal(runFixtureChild(process.execPath, [resolve(import.meta.dirname, '../bin/pullboard.js'), 'init', '--json'], { cwd: second, env: box.env }).status, 0,
    'the second board registers through the actual init command');
  const setup = plainCommand(box.root, box.env, ['relay', 'on', '--all', '--url', box.origin]);
  t.after(async () => { if (setup.child.exitCode === null) setup.child.kill('SIGTERM'); await setup.done; });
  const deadline = Date.now() + 20_000; // budget: hang ceiling for the loopback sign-in, two links and the first pairing poll.
  // Every pairing line is written before the first enrollment poll, so that poll marks the wait.
  while (!box.calls.some(call => call.method === 'GET' && call.path.startsWith('/api/v1/devices/enrollments/'))) {
    assert.ok(Date.now() < deadline && setup.child.exitCode === null, 'relay on --all reaches its pairing wait');
    await new Promise(done => setTimeout(done, 25));
  }
  setup.child.kill('SIGINT');
  const finished = await setup.done;
  assert.equal(finished.code, 0, 'Ctrl-C during the pairing wait keeps the links and exits cleanly');
  const waiting = finished.stdout.split('Boards linked; phone pairing stopped.')[0];
  const lines = waiting.split('\n');
  assert.ok(lines.includes('Signed in to GitHub as fixture-user.'), 'it names the GitHub account it signed in as');
  assert.ok(lines.includes('Linked repo.') && lines.includes('Linked second-board.'), 'it names each board it linked');
  assert.ok(lines.includes('Linked 2 of 2 registered boards.'), 'it says how many registered boards it linked');
  assert.ok(lines.includes('Now waiting for a phone to pair. On your phone, scan the code below or open this link.'), 'it says what it waits for');
  const pairLink = lines.find(line => line.startsWith('Pair your phone once: '));
  assert.match(pairLink ?? '', /^Pair your phone once: http:\/\/127\.0\.0\.1:\d+\/#device=/u, 'it gives the pairing link beside the code');
  assert.match(waiting, /^To skip pairing, press Ctrl-C\. The linked boards stay linked, and pullboard relay on --all gives a fresh code later\./mu,
    'it says how to skip the wait');
  assert.ok(lines.indexOf('Signed in to GitHub as fixture-user.') < lines.indexOf('Linked repo.')
    && lines.indexOf('Linked 2 of 2 registered boards.') < lines.indexOf('Now waiting for a phone to pair. On your phone, scan the code below or open this link.'),
    'it says each step in the order it happens');
  assert.doesNotMatch(finished.stdout + finished.stderr, /\b(?:ps|pm|pa|pd|pg)_[A-Za-z0-9_-]{20,}/u, 'no token or session is printed');
  assert.equal((finished.stdout.match(/#device=/gu) ?? []).length, 1, 'the pairing secret appears only in the one existing link');

  const board = JSON.parse(readFileSync(join(box.root, '.git/pullboard/relay.json'), 'utf8')).board;
  const relayRequests = (from) => box.calls.slice(from).map(call => `${call.method} ${call.path.replace(/[0-9a-f]{32}/gu, '<board>')}`);
  const beforeStatus = box.calls.length;
  const status = plainCommand(box.root, box.env, ['relay', 'status']);
  const shown = await status.done;
  const statusRequests = relayRequests(beforeStatus);
  assert.equal(shown.code, 0, `pullboard relay status runs: ${shown.stderr}`);
  const statusLine = shown.stdout.split('\n').find(line => line.startsWith('relay: ')) ?? '';
  assert.ok(statusLine.startsWith(`relay: repo (board ${board}) `), `relay status names the linked board: ${statusLine}`);
  assert.ok(statusLine.includes(' is linked for GitHub fixture-user; '), `relay status names the linked account: ${statusLine}`);
  assert.match(statusLine, /; sequence \d+; \d+ pending uploads$/u, 'relay status still gives the sequence and pending uploads');
  const beforePlain = box.calls.length;
  const plain = await plainCommand(box.root, box.env, ['relay']).done;
  assert.equal(plain.code, 0, plain.stderr);
  assert.equal(plain.stdout, shown.stdout, 'plain pullboard relay prints the same status');
  assert.ok(statusRequests.length > 0, 'relay status syncs with the relay before it reports');
  assert.deepEqual(statusRequests, relayRequests(beforePlain), 'relay status makes the same relay requests as plain relay');
});

/** Run one CLI command in plain words inside a private home, returning its exit code and both streams. */
function relayOffCommand(cwd, env, args) {
  const result = runFixtureChild(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8' });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Build a set-up-once machine with the relay off, a board with an agent worktree, and optionally a stale registry entry. */
function relayOffWorktree(t, { stale }) {
  const scratch = mkdtempSync(join(tmpdir(), 'pullboard-relay-off-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const home = join(scratch, 'home');
  mkdirSync(home, { mode: 0o700 });
  const env = { ...process.env, HOME: home, PULLBOARD_HOME: join(home, '.pullboard'), PULLBOARD_MACHINE_HOME: join(scratch, 'machine'),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Relay Fixture', GIT_AUTHOR_EMAIL: 'relay-fixture@example.com',
    GIT_COMMITTER_NAME: 'Relay Fixture', GIT_COMMITTER_EMAIL: 'relay-fixture@example.com' };
  for (const name of ['PULLBOARD_RELAY_KEY', 'PULLBOARD_RELAY_TOKEN', ...AGENT_SHELL_MARKERS, ...SSH_SHELL_MARKERS]) delete env[name];
  /** Make one committed repository with a GitHub origin, registered through the production CLI. */
  const board = name => {
    const root = join(scratch, name);
    mkdirSync(root);
    for (const args of [['init', '-q', '-b', 'main'], ['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-q', '-m', 'chore: ' + name],
      ['remote', 'add', 'origin', 'git@github.com:fixture/' + name + '.git']]) runFixtureGit(args, { cwd: root, env });
    const init = relayOffCommand(root, env, ['init', '--json']);
    assert.equal(init.code, 0, init.stderr);
    runFixtureGit(['add', '-A'], { cwd: root, env });
    runFixtureGit(['-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', 'chore: pullboard files'], { cwd: root, env });
    return root;
  };
  const root = board('repo');
  if (stale) {
    // A registered folder that is no longer a git work tree, like a deleted scratch clone.
    const gone = board('stale-scratch');
    rmSync(join(gone, '.git'), { recursive: true, force: true });
  }
  // Set up once, then the relay is off: auto-link stays on for the owner, and no board on this machine is linked.
  const machine = JSON.stringify(pathToFileURL(resolve(import.meta.dirname, '../src/relay-machine.js')).href);
  const saved = runFixtureChild(process.execPath, ['--input-type=module', '-e',
    `import { updateRelayMachine } from ${machine}; updateRelayMachine(state => { state.autoLink = true; state.owner = { account: 'fixture-account', url: 'http://127.0.0.1:9' }; });`],
  { cwd: root, env, encoding: 'utf8' });
  assert.equal(saved.status, 0, saved.stderr);
  const worktree = join(scratch, 'repo-core-1');
  runFixtureGit(['worktree', 'add', '-q', '-b', 'core/1', worktree], { cwd: root, env });
  const joined = relayOffCommand(worktree, env, ['join', 'review', '--model', 'fixture-model']);
  assert.equal(joined.code, 0, joined.stderr);
  return { worktree, env };
}

test('a move from an agent worktree prints no relay-link line [C6,H5]', (t) => {
  for (const stale of [true, false]) {
    const { worktree, env } = relayOffWorktree(t, { stale });
    const move = relayOffCommand(worktree, env, ['spec', 'draft', 'A fixture row', '--section', 'G']);
    const label = stale ? 'with a stale registry entry' : 'the control with no stale entry';
    assert.equal(move.code, 0, `the move succeeds ${label}: ${move.stderr}`);
    assert.doesNotMatch(move.stdout + move.stderr, /not linked|NOT_A_REPO|not inside a git work tree/u, `the move prints only its result ${label}`);
    assert.equal(move.stderr, '', `the move writes nothing to stderr ${label}`);
  }
});
