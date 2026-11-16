/** Local first: ordinary moves stay local while a seat registration waits, the relay stalls, or GitHub answers 403 [H21,H5,H16,H8]. */
/** @pullboard-test-input source-cell apps/cli apps/relay apps/lib store outbox */
import assert from 'node:assert/strict';
import {
  dirname,
  join,
} from 'node:path';
import test from 'node:test';
import { ACCESS_WINDOW_MS } from '../../../../relay/index.js';
import {
  runFixtureChildAsync,
  runFixtureGit,
} from '../../../tests/fixtures/child.js';
import { fixtureJoinArgv } from '../../../tests/fixtures/testkit.js';
import {
  CLI,
  FIXTURE_MODEL,
  eventually,
  linkedBoard,
  local,
  outboxEmpty,
  senderLog,
  shoutTexts,
} from '../../../tests/fixtures/relay/local-first.js';

test('a seat registration waits for relay authority while ordinary moves and reads stay local [H21,H5,H16]', async t => {
  const { box, env } = await linkedBoard(t);
  const agentPath = join(dirname(box.root), 'local-first-registration-agent');
  runFixtureGit(['worktree', 'add', '-q', '-b', 'agent/local-first-registration', agentPath], { cwd: box.root, env: box.env });

  let releaseRegistration;
  const registrationResponse = new Promise(resolve => { releaseRegistration = resolve; });
  let registrationReached = false;
  box.beforeNextMove(async () => {
    registrationReached = true;
    await registrationResponse;
  });
  // Process-level: the join stays pending, a detached child, while the test keeps running other commands.
  const joining = runFixtureChildAsync(process.execPath,
    [...fixtureJoinArgv(CLI), box.lane, '--model', FIXTURE_MODEL, '--json'], { cwd: agentPath, env });
  let joinResult;
  try {
    await eventually('the genuine agent registration reaches the relay', () => registrationReached,
      () => `join exit code: ${joining.child.exitCode ?? 'still running'}`);
    assert.equal(joining.child.exitCode, null, 'join stays pending while the relay holds its registration response');

    const text = 'An ordinary move while registration waits for authority';
    await local(box, t, box.root, env, 'registration-held-shout', ['shout', 'all', text]);
    const status = await local(box, t, box.root, env, 'registration-held-status', ['status']);
    assert.deepEqual(status.document.relay.outbox.map(move => move.operation), ['shout'], 'status reads the local move without waiting for registration');
    const exported = await local(box, t, box.root, env, 'registration-held-export', ['export']);
    assert.equal(shoutTexts(exported.document).filter(row => row === text).length, 1, 'the ordinary move is present locally while registration is pending');
  } finally {
    releaseRegistration();
    joinResult = await joining;
  }
  assert.equal(joinResult.status, 0, joinResult.context);
  assert.match(JSON.parse(joinResult.stdout).agent, new RegExp(`^${box.lane}-[1-9][0-9]*$`, 'u'), 'the real join completes in its configured lane after the authority response is released');
  await eventually('the background sender delivers the ordinary move after registration completes', () => outboxEmpty(box), () => senderLog(env));
});

test('a stalled relay never delays a move: it is recorded and queued, not refused [H21,H5]', async t => {
  const { box, env } = await linkedBoard(t);
  box.stallApi();
  t.after(() => box.stallApi(false));
  const text = 'Saved while the relay does not answer';
  await local(box, t, box.root, env, 'stalled-move', ['shout', 'all', text]);
  const second = await local(box, t, box.root, env, 'stalled-add', ['add', box.lane, 'Added while the relay does not answer']);
  assert.ok(Number.isSafeInteger(second.document.item.item_id), 'an add returns its item at once');
  const status = await local(box, t, box.root, env, 'stalled-status', ['status']);
  assert.deepEqual(status.document.relay.outbox.map(move => move.operation), ['shout', 'addItem'], 'both moves wait in order');
  assert.ok(status.document.relay.behind >= 2, 'status counts the queued moves');
  const exported = await local(box, t, box.root, env, 'stalled-export', ['export']);
  assert.equal(shoutTexts(exported.document).filter(row => row === text).length, 1);
});

test('a GitHub 403 never refuses or delays a move: it is recorded and queued, then sent once access returns [H21,H8]', async t => {
  const { box, env } = await linkedBoard(t);
  // End the relay's cached grant, so the sender's next send really asks GitHub, which now answers 403.
  box.advanceAuthorization(ACCESS_WINDOW_MS + 1);
  box.providerState.access = false;
  const permission = () => box.providerCalls.filter(call => call.path.endsWith('/permission')).length;
  const asked = permission();
  const text = 'Saved while GitHub refuses access';
  await local(box, t, box.root, env, 'denied-move', ['shout', 'all', text]);
  await eventually('the sender asks GitHub, which answers 403', () => permission() > asked);
  const status = await local(box, t, box.root, env, 'denied-status', ['status']);
  assert.deepEqual(status.document.relay.outbox?.map(move => move.operation), ['shout'], 'the move stays queued after the 403');
  assert.equal(status.document.relay.outboxRefusals, undefined, 'a 403 refuses nothing');
  const exported = await local(box, t, box.root, env, 'denied-export', ['export']);
  assert.equal(shoutTexts(exported.document).filter(row => row === text).length, 1, 'the move is recorded here');

  box.providerState.access = true;
  box.advanceAuthorization(ACCESS_WINDOW_MS + 1);
  await local(box, t, box.root, env, 'restored-status', ['status']);
  await eventually('the sender sends the move once GitHub answers again', () => outboxEmpty(box), () => senderLog(env));
});

