/** @pullboard-test-input source-cell packages/outbox */
// fixture-subject: flushOutbox on a link folder that holds a key-free outbox, over a real private folder and a stand-in relay that is down
/** flushOutbox folds the key-free outbox into the sealed outbox once the board key reads again, and leaves it alone while the key stays unreadable [C7,#9894]. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { Refused } from '../../../../kernel/index.js';
import { flushOutbox } from '../../../src/io/relay.js';
import { outboxFile } from '../../../src/io/relay.js';
import { queueMove } from '../../../src/io/relay.js';
import { readOutbox } from '../../../src/io/relay.js';

const BOARD = 'c'.repeat(32);
const BAD_KEY = 'not-a-board-key';
const MOVES = ['one', 'two', 'three'].map(name => ({ id: `move-${name}`, operation: 'addItem', actor: 'seat-a', args: [{ title: `Added ${name}` }] }));

/** Run `work` with the environment session key set as given, putting the environment back after. */
async function withKey(key, work) {
  const saved = { token: process.env.PULLBOARD_RELAY_TOKEN, key: process.env.PULLBOARD_RELAY_KEY };
  process.env.PULLBOARD_RELAY_TOKEN = 'pm_' + 'x'.repeat(43);
  process.env.PULLBOARD_RELAY_KEY = key;
  try { return await work(); } finally {
    for (const [name, value] of [['PULLBOARD_RELAY_TOKEN', saved.token], ['PULLBOARD_RELAY_KEY', saved.key]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
}

/** A link folder whose key was unreadable while three moves were made: they wait in relay-outbox.unsealed.json, as the key-free queue writes them. */
async function unsealedLink() {
  const { root } = privateFixtureFiles('pullboard-outbox-fold-');
  const link = { root, file: join(root, 'relay.json'), state: { board: BOARD, sequence: 4 }, io: { relayQueueOnFailure: () => true },
    senderPolicy: { credentialActor: move => move.actor, relayMoveActor: () => null }, localRecords: () => 0, saveLink: () => undefined,
    request: async () => { throw new Refused('RELAY_UNAVAILABLE', 'the relay is down'); } };
  await withKey(BAD_KEY, async () => {
    for (const move of MOVES) await queueMove(link, { operation: 'addItem', args: move.args, move, error: new Error('relay down'), applyLocally: () => ({ added: 1 }), quiet: true });
  });
  return { link, root, unsealed: join(root, 'relay-outbox.unsealed.json'), done: () => rmSync(root, { recursive: true, force: true }) };
}

test('outbox.relay-unsealed.folds-in-file-order: clause 1: with relay.queueOnFailure on and a readable key, flushOutbox seals every entry of relay-outbox.unsealed.json into the outbox in file order and removes the file only after the sealed write [C7,#9894]', async () => {
  const run = await unsealedLink();
  try {
    assert.equal(JSON.parse(readFileSync(run.unsealed, 'utf8')).length, MOVES.length, 'the three moves wait in the key-free file');
    const key = randomBytes(32);
    await withKey(key.toString('base64url'), async () => {
      await assert.rejects(flushOutbox(run.link), error => error.code === 'RELAY_UNAVAILABLE', 'the flush goes on to the relay, which is down');
      const sealed = await readOutbox(outboxFile(run.link.file), key, BOARD);
      assert.deepEqual(sealed.moves.map(entry => entry.move.id), MOVES.map(move => move.id), 'every entry is sealed in file order');
      assert.equal(existsSync(run.unsealed), false, 'the key-free file is gone once the sealed write holds the entries');
      await assert.rejects(flushOutbox(run.link), error => error.code === 'RELAY_UNAVAILABLE');
      assert.equal((await readOutbox(outboxFile(run.link.file), key, BOARD)).moves.length, MOVES.length, 'a second flush seals nothing twice');
    });
  } finally { run.done(); }
});

test('outbox.relay-unsealed.unreadable-key-leaves-file: clause 2: with the key still unreadable, flushOutbox leaves the unsealed file untouched [C7,#9894]', async () => {
  const run = await unsealedLink();
  try {
    const before = readFileSync(run.unsealed);
    await withKey(BAD_KEY, () => flushOutbox(run.link));
    assert.deepEqual(readFileSync(run.unsealed), before, 'the file is byte for byte as it was');
    assert.equal(existsSync(outboxFile(run.link.file)), false, 'no sealed outbox was written');
  } finally { run.done(); }
});
