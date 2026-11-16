/** Local first: ordinary moves and reads stay local while a seat registration waits for relay authority [H21,H5,H16]. */
/** @pullboard-test-input source-cell apps/cli apps/relay apps/lib store outbox */
import assert from 'node:assert/strict';
import {
  dirname,
  join,
} from 'node:path';
import test from 'node:test';
import {
  runFixtureChildAsync,
  runFixtureGit,
} from '../../../tests/fixtures/child.js';
import { stopSender } from '../../../tests/fixtures/relay/sender.js';
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

  // The join runs in this worktree, so the sender it starts has this folder as its cwd. The fixture's cleanup stops only senders in the main checkout and then removes the scratch folder; a live sender left here kept that removal retrying until the runner's kill [H21,H16].
  try {
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
      // Budget: far past a join on a loaded runner, so a hung join fails its assertion with its output instead of ending the file at the runner's kill.
      const overdue = setTimeout(() => joining.child.kill('SIGKILL'), 90_000);
      try { joinResult = await joining; } finally { clearTimeout(overdue); }
    }
    assert.equal(joinResult.status, 0, joinResult.context);
    assert.match(JSON.parse(joinResult.stdout).agent, new RegExp(`^${box.lane}-[1-9][0-9]*$`, 'u'), 'the real join completes in its configured lane after the authority response is released');
    await eventually('the background sender delivers the ordinary move after registration completes', () => outboxEmpty(box), () => senderLog(env));
  } finally {
    await stopSender(agentPath);
  }
});
