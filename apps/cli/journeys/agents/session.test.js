/** @pullboard-test-input source-cell apps/cli packages/kernel */
/** Checkout-session ownership and takeover behavior [B3,B7]. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { SSH_SHELL_MARKERS } from "../../../../packages/kernel/index.js";
import { SPEC } from "../../tests/fixtures/agents/session.js";
import { assertNoRawSession } from "../../tests/fixtures/agents/session.js";
import { boardSnapshot } from "../../tests/fixtures/agents/session.js";
import { cleanupSandboxes } from "../../tests/fixtures/agents/session.js";
import { project } from "../../tests/fixtures/agents/session.js";

after(cleanupSandboxes);

test('cli.journeys-agents-session.a-second-session-cannot-write-in: clause 1: a second session cannot write in the main checkout until takeover [B3,B7]', async () => {
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

test('cli.journeys-agents-session.lane-ownership-is-session-scoped-and: clause 1: lane ownership is session-scoped and takeover preserves the joined agent [B3,B7]', async () => {
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

test('cli.journeys-agents-session.no-session-shells-are-one-session: clause 1: no-session shells are one session and markerless terminals retain their writes [B3,B7]', async () => {
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

test('cli.journeys-agents-session.a-remote-shell-is-recognized-by: clause 1: a remote shell is recognized by any SSH marker [B26,E22]', async () => {
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

