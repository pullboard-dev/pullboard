/** Local first: one background sender per machine, and a conflict found on sync is refused at replay [H21,H5,H15,H16]. */
/** @pullboard-test-input source-cell apps/cli apps/relay apps/lib store outbox */
import assert from 'node:assert/strict';
import {
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import {
  dirname,
  join,
} from 'node:path';
import test from 'node:test';
import { runFixtureGit } from '../../../tests/fixtures/child.js';
import { relayClientFixture } from '../../../tests/fixtures/relay/client.js';
import { senderProcesses } from '../../../tests/fixtures/relay/sender.js';
import { runCliInProcess } from '../../../tests/fixtures/process.js';
import {
  FIXTURE_MODEL,
  SAMPLE_MS,
  enableOutbox,
  eventually,
  linkedBoard,
  loadedBudgetMs,
  local,
  outboxEmpty,
  senderLog,
  seat,
  shoutTexts,
} from '../../../tests/fixtures/relay/local-first.js';

test('cli.journeys-relay-local-sender.one-background-sender-per-machine-sends: one background sender per machine sends each new move once, asks GitHub once per window, pulls other machines\' moves, and the relay reads none [H21,H5,H15]', async t => {
  const { box, env } = await linkedBoard(t);
  const printed = await box.cliLocal('relay', 'pair');
  const other = await box.otherDeviceJoin(printed.document.code, undefined, { inProcess: true });
  const permission = () => box.providerCalls.filter(call => call.path.endsWith('/permission')).length;
  const asked = permission();
  const acks = box.moveAcks.length;

  const texts = ['first burst move', 'second burst move', 'third burst move'];
  let senders = 0, otherFixtures = 0;
  const sampling = setInterval(() => {
    const observed = senderProcesses(box.root);
    senders = Math.max(senders, observed.owned.length);
    otherFixtures = Math.max(otherFixtures, observed.others);
  }, SAMPLE_MS);
  const budgetMs = await loadedBudgetMs(texts.length);
  try {
    await Promise.all(texts.map((text, index) => local(box, t, box.root, env, `burst-${index}`, ['shout', 'all', text], budgetMs)));
    await eventually('the sender sends the burst', () => outboxEmpty(box), () => senderLog(env));
  } finally { clearInterval(sampling); }
  t.diagnostic(JSON.stringify({ privateFixtureSenderPeak: senders, otherFixtureWorkersObserved: otherFixtures }));
  assert.equal(senders, 1, 'one sender ran for this private fixture machine, however many commands nudged it');
  const sent = box.moveAcks.slice(acks);
  assert.equal(new Set(sent.map(ack => ack.event_id)).size, sent.length, 'no sequence was sent twice');
  assert.ok(permission() - asked <= 1, `the relay asked GitHub at most once for the burst (${permission() - asked})`);

  const there = await other.cli('export');
  assert.equal(there.code, 0, there.failure);
  for (const text of texts) assert.equal(shoutTexts(there.document).filter(row => row === text).length, 1, `the other machine holds "${text}" once`);

  // An agent seat on the other machine moves; its main checkout does not hold this board's coordinator (E19).
  const otherPath = join(dirname(other.root), 'other-agent');
  runFixtureGit(['worktree', 'add', '-q', '-b', 'agent/other', otherPath], { cwd: other.root, env: other.env });
  const joined = await other.cliAtLocal(otherPath, 'join', box.lane, '--model', FIXTURE_MODEL);
  assert.equal(joined.code, 0, joined.failure);
  const reply = 'a move from the other machine';
  const shouted = await other.cliAtLocal(otherPath, 'shout', 'all', reply);
  assert.equal(shouted.code, 0, shouted.failure);
  const otherStatus = await other.cli('status');
  assert.equal(otherStatus.document.relay.outbox, undefined, 'the other machine sent its move');
  await eventually('the sender pulls the other machine\'s move with no sync here', async () => {
    const here = await local(box, t, box.root, env, 'pulled-export', ['export']);
    return shoutTexts(here.document).includes(reply);
  }, () => senderLog(env));

  const relayFiles = [];
  const walk = (path) => {
    for (const name of readdirSync(path)) {
      const file = join(path, name);
      if (statSync(file).isDirectory()) walk(file); else relayFiles.push(file);
    }
  };
  walk(box.relayDirectory);
  assert.ok(relayFiles.length > 0, 'the relay stored the board');
  for (const file of relayFiles) {
    const bytes = readFileSync(file);
    for (const text of [...texts, reply]) assert.equal(bytes.includes(text), false, `the relay cannot read "${text}" in ${file}`);
  }
});

test('cli.journeys-relay-local-sender.a-conflict-found-on-sync-is: a conflict found on sync is refused at replay with a code naming the winner, and its agent is told once [H21,H16]', async t => {
  const box = await relayClientFixture(t);
  enableOutbox(box);
  await box.link();
  const contested = (await box.cliLocal('add', box.lane, 'Claimed on two machines')).document.item.item_id;
  const printed = await box.cliLocal('relay', 'pair');
  const other = await box.otherDeviceJoin(printed.document.code);
  const here = await seat(box, 'here-agent');
  const otherPath = join(dirname(other.root), 'there-agent');
  runFixtureGit(['worktree', 'add', '-q', '-b', 'agent/there', otherPath], { cwd: other.root, env: other.env });
  const there = await other.cliAtLocal(otherPath, 'join', box.lane, '--model', FIXTURE_MODEL, '--route', 'strong');
  assert.equal(there.code, 0, there.failure);
  const winner = there.document.agent;

  await box.stopRelay();
  const queued = await box.cliAtLocal(here.path, 'claim', String(contested));
  assert.equal(queued.code, 0, `the claim succeeds here at once, with no up-front coordination: ${queued.failure}; ${JSON.stringify(queued.document?.error ?? queued.document?.refusal ?? null)}`);
  await box.restartRelay();
  const won = await other.cliAtLocal(otherPath, 'claim', String(contested));
  assert.equal(won.code, 0, won.failure);

  const synced = await box.cliLocal('status');
  assert.equal(synced.code, 0, synced.failure);
  const [refused] = synced.document.relay.outboxRefusals ?? [];
  assert.ok(refused, 'the later claim is refused when it replays');
  assert.equal(refused.code, 'HELD', 'the refusal carries the engine\'s own code');
  assert.equal(refused.move, `claim #${contested} by ${here.id}`);
  assert.ok(refused.earlier.some(move => move.move === `claim #${contested} by ${winner}`), 'the refusal names the winning claim and its agent');

  // The agent whose claim lost is told on its next command, once.
  const told = await runCliInProcess(['status'], { cwd: here.path, env: box.env });
  assert.equal(told.code, 0, told.stderr);
  assert.match(told.stderr, new RegExp(`\\[RELAY_OUTBOX_REFUSED\\] the queued move claim #${contested} by ${here.id} .*\\[HELD\\].*won by sequence \\d+ claim #${contested} by ${winner}`, 'u'));
  const again = await runCliInProcess(['status'], { cwd: here.path, env: box.env });
  assert.doesNotMatch(again.stderr, /RELAY_OUTBOX_REFUSED/u, 'the notice is said once');

  for (const machine of [box, other]) {
    const exported = await machine.cli('export');
    const item = exported.document.tables.item.find(row => row.item_id === contested);
    assert.equal(item.item_owner, winner, 'both machines agree the first claim the relay ordered won');
  }
});

