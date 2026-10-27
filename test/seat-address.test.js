/** Stable seat destinations use existing sealed relay grants and preserve inbox isolation [H2,H16,N26]. */
import assert from 'node:assert/strict';
import { readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  UNREAD_SHOUT_SQL,
  unreadShoutBindings,
} from '../src/shout-audience.js';
import { fileURLToPath } from 'node:url';
import { runFixtureGit } from './fixture-child.js';
import { relayClientFixture } from './relay-client-fixture.js';

/** Require a real public command result without exposing private relay credentials. */
function document(result) {
  assert.equal(result.code, 0, result.document?.error?.code ?? result.failure);
  return result.document;
}

/** Make an ordinary joined seat in a private Git worktree with its device's own environment. */
async function seat(box, root, environment, name, cli) {
  const path = join(root, '..', name);
  runFixtureGit(['worktree', 'add', '--detach', path, 'main'], { cwd: root, env: environment });
  const joined = document(await cli(path, 'join', box.lane, '--model', 'fixture-agent'));
  return { path, id: joined.agent };
}

test("a message sent to a seat address lands in that seat's inbox and nowhere else [H2,H16,N26]", async t => {
  const box = await relayClientFixture(t);
  // Install the actual CLI in this private PATH so project commits exercise its normal hooks.
  symlinkSync(fileURLToPath(new URL('../bin/pullboard.js', import.meta.url)), join(box.env.PATH, 'pullboard'));
  runFixtureGit(['add', '-A'], { cwd: box.root, env: box.env });
  runFixtureGit(['commit', '-m', 'chore: commit private seat-address policy'], { cwd: box.root, env: box.env });
  const recipient = await seat(box, box.root, box.env, 'recipient', box.cliAt);
  const initial = document(await box.cliAt(recipient.path, 'whoami'));
  assert.match(initial.address, /^pullboard:[0-9a-f]{32}:[A-Za-z0-9_-]+$/u, 'each real joined seat exposes its stable board-bound address');

  await box.link();
  const pairing = document(await box.cli('relay', 'pair'));
  const second = await box.otherDeviceJoin(pairing.code);
  const sender = await seat(box, second.root, second.env, 'sender', second.cliAt);
  const sent = document(await second.cliAt(sender.path, 'shout', initial.address, 'An authenticated remote message'));
  const inbox = document(await box.cliAt(recipient.path, 'inbox'));
  const received = inbox.shouts.find(row => row.shout_id === sent.id);
  assert.equal(received?.shout_to, recipient.id);
  assert.equal(received?.shout_from, sender.id, 'sender comes from the authenticated remote seat');
  assert.equal(received?.shout_text, 'An authenticated remote message');
  assert.ok(!document(await box.cli('inbox')).shouts.some(row => row.shout_id === sent.id), 'the coordinator is not the addressee');
  assert.ok(!document(await second.cliAt(sender.path, 'inbox')).shouts.some(row => row.shout_id === sent.id), 'the sender is not the addressee');
  assert.equal(document(await box.cliAt(recipient.path, 'whoami')).address, initial.address, 'pairing and synchronization do not rename a seat');

  const foreign = initial.address.replace(/^pullboard:[0-9a-f]{32}:/u, 'pullboard:ffffffffffffffffffffffffffffffff:');
  const ungranted = await second.cliAt(sender.path, 'shout', foreign, 'Must not be delivered');
  assert.notEqual(ungranted.code, 0);
  assert.equal(ungranted.document.error.code, 'SEAT_ADDRESS_BOARD');

  const link = JSON.parse(readFileSync(join(second.root, '.git', 'pullboard', 'relay.json'), 'utf8'));
  const tokenId = link.agentTokens[sender.id].id;
  const person = await box.phoneSession();
  const revoked = await fetch(box.origin + '/auth/tokens/revoke', { method: 'POST',
    headers: { authorization: 'Bearer ' + person.token, 'content-type': 'application/json' }, body: JSON.stringify({ id: tokenId }) });
  assert.equal(revoked.status, 200, 'the real owner revokes only this private sender grant');
  const queued = document(await second.cliAt(sender.path, 'shout', initial.address, 'After revocation'));
  const summaryFile = join(second.root, '.git', 'pullboard', 'relay-outbox.summary.json');
  const waiting = JSON.parse(readFileSync(summaryFile, 'utf8'));
  assert.ok(waiting.moves.some(move => move.operation === 'shout' && move.actor === sender.id),
    'an unknown remote revocation does not block the local-first queue');
  assert.ok(readFileSync(join(second.root, '.git', 'pullboard', 'relay-outbox.sealed')).length > 0,
    'the accepted local move has a durable sealed outbox, not a delivery acknowledgment');

  const synced = document(await second.cliAt(sender.path, 'relay', 'status'));
  assert.ok(synced.diagnostics?.some(line => line.includes(`the relay token of ${sender.id} was revoked on this board`)),
    'the sender is told when replay obtains a fresh refusal');
  assert.equal(JSON.parse(readFileSync(join(second.root, '.git', 'pullboard', 'relay.json'), 'utf8'))
    .agentTokens[sender.id].revoked, true, 'the confirmed refusal fences this seat locally');
  assert.deepEqual(JSON.parse(readFileSync(summaryFile, 'utf8')).moves, waiting.moves,
    'the refused send retains its pending history');
  const denied = await second.cliAt(sender.path, 'shout', initial.address, 'After known revocation');
  assert.notEqual(denied.code, 0, 'a known revoked grant cannot queue another message');
  assert.equal(denied.document.error.code, 'TOKEN_REVOKED');
  const senderInbox = await second.cliAt(sender.path, 'inbox');
  assert.notEqual(senderInbox.code, 0, 'a revoked seat cannot record native inbox delivery');
  assert.equal(senderInbox.document.error.code, 'TOKEN_REVOKED');
  const replica = new DatabaseSync(join(second.root, '.git', 'pullboard', 'board.sqlite'), { readOnly: true });
  let localInbox;
  try {
    // Inspect the real sender replica with the inbox's canonical audience query without recording a delivery.
    const agent = replica.prepare('SELECT * FROM agent WHERE agent_id=?').get(sender.id);
    localInbox = replica.prepare(`SELECT * ${UNREAD_SHOUT_SQL}`).all(...unreadShoutBindings(0, sender.id, agent.agent_lane));
  } finally { replica.close(); }
  for (const rows of [document(await box.cliAt(recipient.path, 'inbox')).shouts,
    document(await box.cli('inbox')).shouts, localInbox]) {
    assert.ok(!rows.some(row => row.shout_id === queued.id
      || ['After revocation', 'After known revocation'].includes(row.shout_text)),
    'neither revoked message reaches a genuine recipient, coordinator or sender inbox');
  }
});
