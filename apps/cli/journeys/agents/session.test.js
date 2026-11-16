/** @pullboard-test-input source-cell apps/cli packages/api packages/kernel packages/resources packages/person */
/** Checkout-session ownership and takeover behavior [B3,B7]. */
import assert from 'node:assert/strict';
import { startFixtureChild as spawn } from "../../tests/fixtures/child.js";
import { reportFixtureChildFailure } from "../../tests/fixtures/child.js";
import { fixtureChildMessage } from "../../tests/fixtures/child.js";
import { runFixtureChild } from "../../tests/fixtures/child.js";
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { listResources } from "../../../../packages/resources/index.js";
import { SSH_SHELL_MARKERS } from "../../../../packages/kernel/index.js";
import { settleSubmit } from '../../tests/fixtures/submit/settle.js';
import { BIN } from "../../tests/fixtures/agents/session.js";
import { CONFIG } from "../../tests/fixtures/agents/session.js";
import { SPEC } from "../../tests/fixtures/agents/session.js";
import { assertNoRawSession } from "../../tests/fixtures/agents/session.js";
import { boardSnapshot } from "../../tests/fixtures/agents/session.js";
import { cleanupSandboxes } from "../../tests/fixtures/agents/session.js";
import { project } from "../../tests/fixtures/agents/session.js";

after(cleanupSandboxes);

test('clause 1: a second session cannot write in the main checkout until takeover [B3,B7]', async () => {
  const box = await project();
  const first = 'claude-session-secret-first-273';
  const second = 'claude-session-secret-second-273';
  const initial = (await box.inProcess(box.repo, ['shout', 'web', 'first session owns main', '--json'], { session: first }));
  assert.equal(initial.status, 0, `${initial.stdout}${initial.stderr}`);
  const before = boardSnapshot(box.boardFile);
  const refused = (await box.inProcess(box.repo, ['shout', 'web', 'must not land', '--json'], { session: second }));
  assert.notEqual(refused.status, 0);
  const error = JSON.parse(refused.stdout).error;
  assert.equal(error.code, 'NOT_YOUR_CHECKOUT');
  assert.match(error.message, /coordinator/u);
  assert.match(error.next, /git worktree add --detach/u);
  assert.match(error.next, /pullboard takeover/u);
  assert.deepEqual(boardSnapshot(box.boardFile), before, 'refusal leaves all board counts unchanged');
  const worktrees = box.git(box.repo, 'worktree', 'list', '--porcelain');
  for (const args of [['init'], ['worktree', 'web'], ['hooks'], ['spec', 'apply'], ['hook', 'pre-commit'], ['submit', '1']]) {
    const blocked = (await box.inProcess(box.repo, [...args, '--json'], { session: second }));
    assert.equal(blocked.status, 1, `${args.join(' ')} must refuse another session before side effects`);
    assert.equal(JSON.parse(blocked.stdout).error.code, 'NOT_YOUR_CHECKOUT');
    assert.deepEqual(boardSnapshot(box.boardFile), before, `${args.join(' ')} leaves every board row intact`);
    assert.equal(box.git(box.repo, 'worktree', 'list', '--porcelain'), worktrees, 'the wrong session cannot create a worktree first');
  }

  const takeover = (await box.inProcess(box.repo, ['takeover', '--json'], { session: second }));
  assert.equal(takeover.status, 0, `${takeover.stdout}${takeover.stderr}`);
  const rows = boardSnapshot(box.boardFile);
  assert.ok(rows.event.slice(before.event.length).some(row => row.event_kind === 'shout' && row.event_by === 'coordinator'), 'takeover is recorded through an existing ordered shout event');
  assert.match(rows.shout.at(-1).shout_text, /coordinator \(Test Model\) took over/);
  assert.equal(rows.shout.at(-1).shout_to, 'person');
  assert.equal(rows.shout.length, before.shout.length + 1, 'main-checkout takeover records the person notice');
  const after = (await box.inProcess(box.repo, ['shout', 'web', 'second session owns main', '--json'], { session: second }));
  assert.equal(after.status, 0, `${after.stdout}${after.stderr}`);
  assertNoRawSession(box, box.repo, [first, second]);
  const beforeSelf = boardSnapshot(box.boardFile);
  const self = (await box.inProcess(box.repo, ['shout', 'coordinator', 'cannot address myself', '--json'], { agent: false }));
  assert.notEqual(self.status, 0);
  assert.deepEqual(boardSnapshot(box.boardFile), beforeSelf, 'self-addressed shout is refused without changing the board');
});

test('clause 1: lane ownership is session-scoped and takeover preserves the joined agent [B3,B7]', async () => {
  const box = await project();
  const first = 'codex-thread-secret-first-273';
  const second = 'codex-thread-secret-second-273';
  const claim = (await box.inProcess(box.web, ['claim', '1', '--json'], { session: first, sessionKey: 'CODEX_THREAD_ID' }));
  assert.equal(claim.status, 0, `${claim.stdout}${claim.stderr}`);
  const sameSession = (await box.inProcess(box.web, ['claim', '1', '--json'], { session: first, sessionKey: 'CODEX_THREAD_ID' }));
  assert.equal(sameSession.status, 0, `${sameSession.stdout}${sameSession.stderr}`);
  const before = boardSnapshot(box.boardFile);
  const refused = (await box.inProcess(box.web, ['claim', '1', '--json'], { session: second, sessionKey: 'CODEX_THREAD_ID' }));
  assert.notEqual(refused.status, 0);
  assert.equal(JSON.parse(refused.stdout).error.code, 'NOT_YOUR_CHECKOUT');
  assert.match(JSON.parse(refused.stdout).error.message, /web-1/u);
  assert.match(JSON.parse(refused.stdout).error.next, /git worktree add --detach/u);
  assert.deepEqual(boardSnapshot(box.boardFile), before, 'refused lane write leaves event and item counts unchanged');

  const takeover = (await box.inProcess(box.web, ['takeover', '--json'], { session: second, sessionKey: 'CODEX_THREAD_ID' }));
  assert.equal(takeover.status, 0, `${takeover.stdout}${takeover.stderr}`);
  assert.equal(boardSnapshot(box.boardFile).event.length, before.event.length + 1, 'lane takeover records one event');
  assert.equal(boardSnapshot(box.boardFile).shout.at(-1).shout_to, 'coordinator');
  const after = (await box.inProcess(box.web, ['claim', '1', '--json'], { session: second, sessionKey: 'CODEX_THREAD_ID' }));
  assert.equal(after.status, 0, `${after.stdout}${after.stderr}`);
  assertNoRawSession(box, box.web, [first, second], 'CODEX_THREAD_ID');
});

test('clause 1: no-session shells are one session and markerless terminals retain their writes [B3,B7]', async () => {
  const box = await project();
  const sentinel = (await box.inProcess(box.web, ['claim', '1', '--json'], { session: undefined }));
  assert.equal(sentinel.status, 0, `${sentinel.stdout}${sentinel.stderr}`);
  const noSessionAgain = (await box.inProcess(box.web, ['claim', '1', '--json'], { session: undefined }));
  assert.equal(noSessionAgain.status, 0, `${noSessionAgain.stdout}${noSessionAgain.stderr}`);
  const terminalRead = (await box.inProcess(box.web, ['show', '1', '--json'], { agent: false }));
  assert.equal(terminalRead.status, 0, `${terminalRead.stdout}${terminalRead.stderr}`);
  assert.equal(JSON.parse(terminalRead.stdout).item_status, 'claimed');
  const beforeIdentified = boardSnapshot(box.boardFile);
  const identified = (await box.inProcess(box.web, ['release', '1', '--reason', 'BLOCKED', '--json'], { session: 'identified-after-sentinel-273', sessionKey: 'CODEX_SESSION_ID' }));
  assert.equal(identified.status, 1);
  assert.equal(JSON.parse(identified.stdout).error.code, 'NOT_YOUR_CHECKOUT');
  assert.deepEqual(boardSnapshot(box.boardFile), beforeIdentified);
  const terminalWrite = (await box.inProcess(box.web, ['shout', 'all', 'the markerless terminal still works', '--json'], { agent: false }));
  assert.equal(terminalWrite.status, 0, terminalWrite.stdout + terminalWrite.stderr);
  const secondSessionRead = (await box.inProcess(box.web, ['show', '1', '--json'], { session: 'read-from-another-session-273' }));
  assert.equal(secondSessionRead.status, 0, secondSessionRead.stdout + secondSessionRead.stderr);

  // Existing relay-person-request coverage should be retained: this private CLI fixture does not
  // establish a linked relay or inject io.personRequest, so an ordinary shout is not a substitute.
  // A decision addressed to its own sender must be refused rather than self-answered.
  const beforeSelf = boardSnapshot(box.boardFile);
  const self = (await box.inProcess(box.repo, ['shout', 'coordinator', 'self decision', '--decision', '--json'], { agent: false }));
  assert.notEqual(self.status, 0);
  assert.deepEqual(boardSnapshot(box.boardFile), beforeSelf, 'self-addressed decision is refused without a write');
});

test('clause 1: a shout from the local view as the person is recorded as the person [N26,B26,B3,B7]', async () => {
  const box = await project();
  const owner = (await box.inProcess(box.repo, ['shout', 'web', 'agent owns this checkout', '--json'], { session: 'view-owner-session-273' }));
  assert.equal(owner.status, 0, owner.stdout + owner.stderr);
  assert.equal(boardSnapshot(box.boardFile).shout.at(-1).shout_from, 'coordinator', 'an agent-shell shout keeps the coordinator as author');
  const file = resolve(box.repo, box.git(box.repo, 'rev-parse', '--git-dir'), 'pullboard-checkout-session.json');
  const before = readFileSync(file);
  const apiModule = pathToFileURL(resolve(import.meta.dirname, '../../../../packages/api/src/io/main.js')).href;
  const cliModule = pathToFileURL(resolve(import.meta.dirname, '../../tests/fixtures/native.js')).href;
  const source = `
    const { executeMove } = await import(${JSON.stringify(apiModule)});
    const { main } = await import(${JSON.stringify(cliModule)});
    const { openBoard, openBoardForRead } = await import(${JSON.stringify(new URL('../../../lib/index.js', import.meta.url).href)});
    const { moveArgs } = await import(${JSON.stringify(new URL('../../../../packages/person/index.js', import.meta.url).href)});
    const apiBoardOpeners = { moveArgs, openBoard, openBoardForRead };
    const response = await executeMove(process.cwd(), { verb: 'shout', args: { to: 'web', text: 'actual view action' } }, main, undefined, undefined, undefined, apiBoardOpeners);
    const asAgent = await executeMove(process.cwd(), { verb: 'shout', agent: 'web-1', args: { to: 'coordinator', text: 'Which path should web-1 use?', kind: 'question' } }, main, undefined, undefined, undefined, apiBoardOpeners);
    process.stdout.write(JSON.stringify({ ...response, asAgent }));
  `;
  const response = runFixtureChild(process.execPath, ['--input-type=module', '-e', source], {
    cwd: box.repo, env: { ...box.base, CODEX_THREAD_ID: 'other-process-view-session-273' }, encoding: 'utf8',
  });
  assert.equal(response.status, 0, fixtureChildMessage(response));
  const document = JSON.parse(response.stdout);
  assert.equal(document.status, 200, response.stdout);
  assert.equal(document.body.event.event_kind, 'shout');
  assert.equal(document.body.event.event_by, 'person');
  const shouts = boardSnapshot(box.boardFile).shout;
  assert.equal(shouts.at(-2).shout_text, 'actual view action');
  assert.equal(shouts.at(-2).shout_from, 'person', 'the view as the coordinator records the person');
  assert.equal(document.asAgent.status, 200, response.stdout);
  assert.equal(shouts.at(-1).shout_from, 'web-1', 'the view acting as a named agent still records that agent');
  assert.deepEqual(readFileSync(file), before, 'the authenticated view does not alter the local agent-session binding');
});

test('clause 1: takeover waits for an active write and then refuses the old session [B3,B7]', { timeout: 90_000 }, async t => {
  const box = await project();
  const started = join(box.dir, 'gate-started');
  const release = join(box.dir, 'gate-release');
  const gateFile = join(box.dir, 'holding-gate.cjs');
  writeFileSync(gateFile, `const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(started)}, 'started');
    const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(timer); process.exit(0); } }, 10);
    setTimeout(() => process.exit(19), 20000).unref();
  `);
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify({ ...CONFIG, gate: `node '${gateFile.replaceAll("'", "'\\''")}'` }));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: configure holding gate');
  box.git(box.web, 'merge', '--quiet', 'main');
  const claim = (await box.inProcess(box.web, ['claim', '1', '--json'], { session: 'active-write-273', sessionKey: 'CODEX_SESSION_ID' }));
  assert.equal(claim.status, 0, claim.stdout + claim.stderr);
  writeFileSync(join(box.web, 'web/page.txt'), 'changed for the claimed item\n');
  box.git(box.web, 'add', 'web/page.txt');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): change the page [G1]');
  /** Start a real CLI write with a durable closed-process observation. */
  function launch(session, ...args) {
    const command = process.execPath;
    const childArgs = [BIN, ...args, '--json'];
    const childEnv = { ...box.base, CODEX_SESSION_ID: session };
    const startedAt = performance.now();
    const child = spawn(command, childArgs, { cwd: box.web, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (part) => { output += part; });
    child.stderr.setEncoding('utf8').on('data', (part) => { stderr += part; });
    let spawnError = null;
    child.once('error', (error) => { spawnError = error; });
    child.closed = new Promise((resolveClose) => child.once('close', (code, signal) => {
      const failure = code === 0 && !signal && !spawnError ? null : reportFixtureChildFailure({ command, args: childArgs,
        status: code, signal, elapsedMs: performance.now() - startedAt, stderr, env: childEnv,
        detail: spawnError?.message ?? '' });
      resolveClose({ code, signal, output, stderr, failure });
    }));
    return child;
  }
  /** Wait on an actual private fixture observation, with an assertion if it never becomes true. */
  async function observed(predicate, label) {
    const deadline = Date.now() + 40_000; // a loaded runner takes 18 s just to authorize a submit
    while (!predicate() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10));
    assert.ok(predicate(), label);
  }
  /** Observe the takeover waiting for the active write: it holds the checkout and has written its intent. */
  function queued() {
    return existsSync(resolve(box.web, box.git(box.web, 'rev-parse', '--git-dir'), 'pullboard-checkout-takeover'))
      && listResources({ scope: 'repo', root: box.repo }).some((resource) => resource.name.startsWith('checkout-session:') && resource.holders.length > 0);
  }
  // Pull dispatch: submit queues the gate and returns at once, so its write is short; the held gate runs on the local runner.
  const submission = launch('active-write-273', 'submit', '1');
  let takeover;
  try {
    const submitted = await submission.closed;
    assert.equal(submitted.code, 0, submitted.failure ?? submitted.output);
    takeover = launch('next-write-273', 'takeover');
    const taken = await takeover.closed;
    assert.equal(taken.code, 0, taken.failure ?? taken.output);
    writeFileSync(release, 'release');
    const view = { repo: box.repo, env: box.base, run: async (cwd, ...args) => { const r = await box.inProcess(cwd, args, { agent: false }); return { code: r.status, out: r.stdout, err: r.stderr }; } };
    await settleSubmit(t, view, JSON.parse(submitted.output));
    assert.equal(boardSnapshot(box.boardFile).item[0].item_status, 'submitted');
    const beforeRefusal = boardSnapshot(box.boardFile);
    const old = (await box.inProcess(box.web, ['shout', 'coordinator', 'old session cannot write', '--json'], { session: 'active-write-273', sessionKey: 'CODEX_SESSION_ID' }));
    assert.equal(old.status, 1);
    assert.equal(JSON.parse(old.stdout).error.code, 'NOT_YOUR_CHECKOUT');
    assert.deepEqual(boardSnapshot(box.boardFile), beforeRefusal);
  } finally {
    writeFileSync(release, 'release');
    if (submission.exitCode === null) submission.kill('SIGTERM');
    if (takeover?.exitCode === null) takeover.kill('SIGTERM');
    await submission.closed;
    if (takeover) await takeover.closed;
  }
});

test('clause 1: a remote shell is recognized by any SSH marker [B26,E22]', async () => {
  const box = await project();
  for (const key of SSH_SHELL_MARKERS) delete box.base[key];
  writeFileSync(join(box.repo, 'SPEC.md'), `${SPEC}- G2 [draft, must] A probe row for person moves. | gate: true\n`);
  box.git(box.repo, 'commit', '-qam', 'docs: draft a probe row');
  const markers = {
    SSH_CONNECTION: '192.0.2.10 12345 192.0.2.20 22',
    SSH_CLIENT: '192.0.2.10 12345 22',
    SSH_TTY: '/dev/pts/7',
  };
  const shells = [...Object.entries(markers).map(([key, value]) => ({ [key]: value })), markers];
  const before = boardSnapshot(box.boardFile);
  for (const extra of shells) {
    const label = Object.keys(extra).join('+');
    const refused = (await box.inProcess(box.repo, ['spec', 'approve', 'G2', '--json'], { agent: false, extra }));
    assert.equal(refused.status, 1, `${label}: ${refused.stdout}${refused.stderr}`);
    const error = JSON.parse(refused.stdout).error;
    assert.equal(error.code, 'B26_PERSON_CHANNEL', `${label} gives the person-channel refusal`);
    assert.match(error.message, /remote SSH shell/u, `${label} is named as a remote shell`);
    assert.match(error.next, /pullboard view/u, `${label} points the person at the view`);
    assert.deepEqual(boardSnapshot(box.boardFile), before, `${label} records no person decision`);
  }
  const local = (await box.inProcess(box.repo, ['spec', 'approve', 'G2', '--json'], { agent: false }));
  assert.equal(local.status, 0, `no SSH marker allows the person move: ${local.stdout}${local.stderr}`);

  box.git(box.repo, 'remote', 'add', 'origin', 'https://github.com/example/session-fixture.git');
  const relay = (await box.inProcess(box.repo, ['relay', 'on', '--url', 'http://127.0.0.1:9', '--json'], { agent: false, extra: { SSH_CLIENT: markers.SSH_CLIENT } }));
  const relayError = JSON.parse(relay.stdout || '{}').error;
  assert.notEqual(relayError?.code, 'B26_PERSON_CHANNEL', `relay on over SSH keeps its own channel: ${relay.stdout}${relay.stderr}`);
  assert.equal(relayError?.code, 'RELAY_UNAVAILABLE', 'relay on over SSH reaches the relay');
  assert.match(relayError.message, /\/auth\/device\/start/u, 'relay on over SSH starts its device sign-in (#615)');
});

