/** @pullboard-test-loads src/relay-outbox.js */
/** Sealed local outbox compatibility uses the actual old reader, not an imitation of its version check [B26,H16,H17]. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  mkdtempSync,
  rmSync,
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
  readOutbox,
  writeOutbox,
} from '../../src/io/relay.js';
import {
  runFixtureExecFile,
  runFixtureGit,
} from '../../../../apps/cli/tests/fixtures/child.js';

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const OLD = '876df36c23a63993b371d4d85b9cf3b54f8ed38d';

test('legacy numeric outboxes remain readable and an old reader refuses new result bindings [B26,H16,H17]', async t => {
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
