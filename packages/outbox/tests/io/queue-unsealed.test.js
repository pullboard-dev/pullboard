/** @pullboard-test-input source-cell outbox kernel keys */
// fixture-subject: queueMove on a link whose board key is corrupt, over a real private link folder
/** With relay.queueOnFailure on and a corrupt board key, queueMove keeps the move in a key-free file and applies it locally [C7,#9893,#9411]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { queueMove } from '../../src/io/relay.js';

const BOARD = 'b'.repeat(32);
const BAD_KEY = 'not-a-board-key';
const MOVE = { id: 'move-1', operation: 'addItem', actor: 'seat-a', args: [{ title: 'Added while the key was bad' }] };

/** A link folder, a corrupt environment key and a link whose `applyLocally` counts its calls; `queueOnFailure` is the setting. */
async function attempt(queueOnFailure) {
  const { root } = privateFixtureFiles('pullboard-outbox-unsealed-');
  const saved = { token: process.env.PULLBOARD_RELAY_TOKEN, key: process.env.PULLBOARD_RELAY_KEY, home: process.env.PULLBOARD_MACHINE_HOME };
  process.env.PULLBOARD_RELAY_TOKEN = 'pm_' + 'x'.repeat(43);
  process.env.PULLBOARD_RELAY_KEY = BAD_KEY;
  process.env.PULLBOARD_MACHINE_HOME = root;
  const calls = [];
  const link = { root, file: join(root, 'relay.json'), state: { board: BOARD, sequence: 4 }, io: { relayQueueOnFailure: () => queueOnFailure },
    senderPolicy: { credentialActor: move => move.actor, relayMoveActor: () => null }, localRecords: () => undefined };
  let outcome;
  try { outcome = await queueMove(link, { operation: 'addItem', args: MOVE.args, move: MOVE, error: new Error('relay down'), applyLocally: () => { calls.push(1); return { added: 1 }; }, quiet: true }).then(value => ({ value }), error => ({ error })); }
  finally {
    for (const [name, value] of [['PULLBOARD_RELAY_TOKEN', saved.token], ['PULLBOARD_RELAY_KEY', saved.key], ['PULLBOARD_MACHINE_HOME', saved.home]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
  return { root, calls, file: join(root, 'relay-outbox.unsealed.json'), outcome, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('clause 1: with relay.queueOnFailure on and a corrupted board key, queueMove writes the move to relay-outbox.unsealed.json with mode 0o600 and runs applyLocally once [C7,#9893]', async () => {
  const run = await attempt(true);
  try {
    assert.deepEqual(run.outcome.value, { added: 1 }, 'the local command committed and returned its result');
    assert.equal(run.calls.length, 1, 'applyLocally ran once');
    assert.equal(statSync(run.file).mode & 0o777, 0o600);
    const entries = JSON.parse(readFileSync(run.file, 'utf8'));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].move.id, MOVE.id);
  } finally { run.done(); }
});

test('clause 2: the unsealed file holds no key material [C7,#9893]', async () => {
  const run = await attempt(true);
  try {
    const text = readFileSync(run.file, 'utf8');
    assert.equal(text.includes(BAD_KEY), false, 'the key text is not in the file');
    assert.equal(text.includes(process.env.PULLBOARD_RELAY_KEY ?? '\u0000'), false);
    assert.equal(/key/iu.test(Object.keys(JSON.parse(text)[0]).join(' ')), false, 'no entry field is a key');
  } finally { run.done(); }
});

test('clause 3: with relay.queueOnFailure off the same corrupted key still refuses as today and writes nothing [C7,#9893]', async () => {
  const run = await attempt(false);
  try {
    assert.equal(run.outcome.error?.code, 'SEAL_KEY');
    assert.equal(run.calls.length, 0, 'the move was not applied');
    assert.equal(existsSync(run.file), false);
  } finally { run.done(); }
});
