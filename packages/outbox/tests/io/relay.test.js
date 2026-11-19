/** @pullboard-test-loads src/relay-outbox.js */
/** @pullboard-test-input source-cell outbox kernel keys */
// fixture-subject: queueMove on a link whose board key is corrupt, over a real private link folder
/** Sealed local outbox compatibility uses the actual old reader, not an imitation of its version check [B26,H16,H17]. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  fileURLToPath,
  pathToFileURL,
} from 'node:url';
import {
  ITEM_SLOTS,
  queueMove,
  readOutbox,
  writeOutbox,
} from '../../src/io/relay.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import {
  runFixtureExecFile,
  runFixtureGit,
} from '../../../../apps/cli/tests/fixtures/child.js';

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const OLD = '876df36c23a63993b371d4d85b9cf3b54f8ed38d';

test('outbox.relay.reserve-item-names-its-item: clause 1: the relay lists name reserveItem as an ordered operation whose first argument is an item number [C7]', () => {
  assert.deepEqual(ITEM_SLOTS.reserveItem, [[0]]);
  assert.deepEqual(ITEM_SLOTS.reserveItem, ITEM_SLOTS.holdItem);
});

test('outbox.relay.legacy-readable: legacy numeric outboxes remain readable and an old reader refuses new result bindings [B26,H16,H17]', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-outbox-format-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // The accepted old source tree is unpacked whole, so its own imports resolve inside it and not against the moved cells.
  const archive = join(directory, 'old-src.tar');
  runFixtureGit(['archive', '-o', archive, OLD, 'src'], { cwd: ROOT });
  runFixtureExecFile('tar', ['-xf', archive, '-C', directory]);
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
  const oldModule = join(directory, 'src/relay-outbox.js');
  const old = await import(pathToFileURL(oldModule).href);
  const file = join(directory, 'outbox.sealed');
  const key = randomBytes(32);
  const board = randomBytes(16).toString('hex');
  const legacy = { version: 1, base: { tables: {} }, baseSequence: 0,
    moves: [{ move: { id: 'old-add', operation: 'addItem' }, visible: 7 }], results: {} };
  await writeOutbox(file, key, board, legacy);
  assert.deepEqual(await old.readOutbox(file, key, board), legacy);
  assert.deepEqual(await readOutbox(file, key, board), legacy);
  const modern = { ...legacy, moves: [{ move: { id: 'handoff', operation: 'openHandoff' },
    created: [{ resultPath: ['item'], item: 8 }] }] };
  await writeOutbox(file, key, board, modern);
  assert.equal((await readOutbox(file, key, board)).version, 2);
  await assert.rejects(old.readOutbox(file, key, board), error => error.code === 'RELAY_OUTBOX',
    'the actual old reader refuses the new local format instead of silently ignoring result paths');
  const numeric = { ...legacy, moves: [{ move: { id: 'outside', operation: 'intakeOutside' },
    created: [{ resultPath: [], item: 9 }] }] };
  await writeOutbox(file, key, board, numeric);
  assert.equal((await readOutbox(file, key, board)).version, 2,
    'a non-add creator uses the new format even when its item result is numeric');
  await assert.rejects(old.readOutbox(file, key, board), error => error.code === 'RELAY_OUTBOX');
  const queued = { ...legacy, moves: [{ move: { id: 'queued-outside', operation: 'intakeOutside' } }] };
  await writeOutbox(file, key, board, queued);
  assert.equal((await readOutbox(file, key, board)).version, 2,
    'the initial queued creator is fenced before a local result has been captured');
  await assert.rejects(old.readOutbox(file, key, board), error => error.code === 'RELAY_OUTBOX');
});

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
