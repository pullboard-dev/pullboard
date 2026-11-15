/** Relay setup commands: help, pair, the approval wait, relay on --all and moves from an agent worktree [H17,H5,I1,C6]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
  AGENT_SHELL_MARKERS,
  SSH_SHELL_MARKERS,
} from '../../../../packages/kernel/index.js';
import {
  plainCommand,
} from '../../tests/fixtures/relay/setup.js';

test('relay help lists every relay command, with a whole example [H17]', async () => {
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

test('relay pair labels the code for a computer and the QR for a phone [H17]', async (t) => {
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

test('the approval wait names the phone in local time once [H17]', async (t) => {
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

test('relay on --all says who signed in, what it linked and what it waits for [H5,I1]', async (t) => {
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

/** Run one CLI command in plain words inside a private home, returning its exit code and both streams. */
async function relayOffCommand(cwd, env, args) {
  const result = await runCliInProcess(args, { cwd, env });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Build a set-up-once machine with the relay off, a board with an agent worktree, and optionally a stale registry entry. */
async function relayOffWorktree(t, { stale }) {
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
  const board = async name => {
    const root = join(scratch, name);
    mkdirSync(root);
    for (const args of [['init', '-q', '-b', 'main'], ['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-q', '-m', 'chore: ' + name],
      ['remote', 'add', 'origin', 'git@github.com:fixture/' + name + '.git']]) runFixtureGit(args, { cwd: root, env });
    const init = await relayOffCommand(root, env, ['init', '--json']);
    assert.equal(init.code, 0, init.stderr);
    runFixtureGit(['add', '-A'], { cwd: root, env });
    runFixtureGit(['-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', 'chore: pullboard files'], { cwd: root, env });
    return root;
  };
  const root = await board('repo');
  if (stale) {
    // A registered folder that is no longer a git work tree, like a deleted scratch clone.
    const gone = await board('stale-scratch');
    rmSync(join(gone, '.git'), { recursive: true, force: true });
  }
  // Process-level case: the one-off module script below needs its own node process, so it stays a launched process.
  // Set up once, then the relay is off: auto-link stays on for the owner, and no board on this machine is linked.
  const machine = JSON.stringify(pathToFileURL(resolve(import.meta.dirname, '../../../../packages/link/index.js')).href);
  const saved = runFixtureChild(process.execPath, ['--input-type=module', '-e',
    `import { updateRelayMachine } from ${machine}; updateRelayMachine(state => { state.autoLink = true; state.owner = { account: 'fixture-account', url: 'http://127.0.0.1:9' }; });`],
  { cwd: root, env, encoding: 'utf8' });
  assert.equal(saved.status, 0, saved.stderr);
  const worktree = join(scratch, 'repo-core-1');
  runFixtureGit(['worktree', 'add', '-q', '-b', 'core/1', worktree], { cwd: root, env });
  const joined = await relayOffCommand(worktree, env, ['join', 'review', '--model', 'fixture-model']);
  assert.equal(joined.code, 0, joined.stderr);
  return { worktree, env };
}

test('a move from an agent worktree prints no relay-link line [C6,H5]', async (t) => {
  for (const stale of [true, false]) {
    const { worktree, env } = await relayOffWorktree(t, { stale });
    const move = await relayOffCommand(worktree, env, ['spec', 'draft', 'A fixture row', '--section', 'G']);
    const label = stale ? 'with a stale registry entry' : 'the control with no stale entry';
    assert.equal(move.code, 0, `the move succeeds ${label}: ${move.stderr}`);
    assert.doesNotMatch(move.stdout + move.stderr, /not linked|NOT_A_REPO|not inside a git work tree/u, `the move prints only its result ${label}`);
    assert.equal(move.stderr, '', `the move writes nothing to stderr ${label}`);
  }
});
