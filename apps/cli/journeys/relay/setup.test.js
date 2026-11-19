/** Relay setup commands: help, pair, the approval wait and relay on --all [H17,H5,I1]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  dirname,
  join,
  resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import {
  startViewSignIn,
  viewSignInStatus,
  cancelViewSignIn,
  viewSignInPairingNavigation,
} from '../../../../packages/link/index.js';
const setup = { startViewSignIn, viewSignInStatus, cancelViewSignIn, viewSignInPairingNavigation };
import { relayClientFixture } from '../../tests/fixtures/relay/client.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import {
  runFixtureChild,
  runFixtureGit,
} from '../../tests/fixtures/child.js';
import {
  plainCommand,
} from '../../tests/fixtures/relay/setup.js';

test('cli.journeys-relay-setup.relay-help-lists-every-relay-command: relay help lists every relay command, with a whole example [H17]', async () => {
  const printed = await runCliInProcess(['relay', '--help'], { cwd: tmpdir() });
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

test('cli.journeys-relay-setup.relay-pair-labels-the-code-for: relay pair labels the code for a computer and the QR for a phone [H17]', async (t) => {
  const box = await relayClientFixture(t);
  await box.link();
  const cliModule = pathToFileURL(resolve(import.meta.dirname, '../../tests/fixtures/native.js')).href;
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

test('cli.journeys-relay-setup.the-approval-wait-names-the-phone: the approval wait names the phone in local time once [H17]', async (t) => {
  const box = await relayClientFixture(t);
  await box.link();
  const linkModule = JSON.stringify(new URL('../../../../packages/link/index.js', import.meta.url).href);
  const fixtureModule = JSON.stringify(pathToFileURL(resolve(import.meta.dirname, '../../tests/fixtures/child.js')).href);
  const result = await box.script(`
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { main } from ${JSON.stringify(new URL('../../tests/fixtures/native.js', import.meta.url).href)};
import { readRelayMachine, updateRelayMachine } from ${linkModule};
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

test('cli.journeys-relay-setup.relay-on-all-says-who-signed: relay on --all says who signed in, what it linked and what it waits for [H5,I1]', async (t) => {
  const box = await relayClientFixture(t);
  const second = join(dirname(box.root), 'second-board');
  mkdirSync(second);
  for (const args of [['init', '-q', '-b', 'main'], ['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-q', '-m', 'fixture base'],
    ['remote', 'add', 'origin', 'git@github.com:fixture/repository-2.git']]) {
    assert.equal(runFixtureChild('git', args, { cwd: second, env: box.env }).status, 0);
  }
  assert.equal((await runCliInProcess(['init', '--json'], { cwd: second, env: box.env })).status, 0,
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
