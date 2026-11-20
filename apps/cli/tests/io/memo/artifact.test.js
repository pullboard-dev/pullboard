/** Shared fixture memos ride in the analysis artifact, never the request, and a runner is not sent a memo it holds [C7]. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { deserialize } from 'node:v8';
import { serialize } from 'node:v8';
import { gunzipSync } from 'node:zlib';
import { gzipSync } from 'node:zlib';
import { absorbFixtureMemo } from '../../../src/io/memo.js';
import { keepRunnerFixtureMemo } from '../../../src/io/memo.js';
import { runnerFixtureMemos } from '../../../src/io/memo.js';
import { withFixtureMemos } from '../../../src/io/memo.js';
import { privateFixtureFiles } from '../../fixtures/child.js';

/** A memo carried as data under `name`, holding the given keys, padded with `pad` incompressible bytes per entry. */
function memo(name, keys, pad = 0) {
  const entries = new Map(keys.map(key => [key, { reads: [], result: serialize({ key, pad: randomBytes(pad) }) }]));
  return { name, data: gzipSync(serialize({ version: 1, entries })).toString('base64') };
}

/** A private folder removed after the test. */
function folder(t, prefix) {
  const files = privateFixtureFiles(prefix);
  t.after(() => rmSync(files.root, { recursive: true, force: true }));
  return files.root;
}

/** An accepted inventory bundle as submitCellsInventory makes it: serialized artifacts named by their digest. */
function inventory(directory) {
  const bytes = serialize({ version: 1, artifacts: [{ commit: 'a'.repeat(40), bytes: Buffer.from('inventory') }] });
  const digest = createHash('sha256').update(bytes).digest('hex');
  return { file: join(directory, `${digest}.bundle`), bytes, digest, descriptor: { version: 1, digest, sources: [{ commit: 'a'.repeat(40), descriptor: {} }] } };
}

const FIRST = `${'1'.repeat(64)}.v8.gz`, SECOND = `${'2'.repeat(64)}.v8.gz`;

test('cli.io-memo-artifact.clause-1-and-2-two-large-shared: clause 1 and 2: two large shared memos ride in the artifact bundle, and the runner seeds from it [C7]', t => {
  const store = folder(t, 'fixture-memo-artifact-store-'), runner = folder(t, 'fixture-memo-artifact-runner-');
  absorbFixtureMemo(store, memo(FIRST, ['a', 'b'], 120 * 1024));
  absorbFixtureMemo(store, memo(SECOND, ['c', 'd'], 120 * 1024));
  const base = inventory(store);
  const carried = withFixtureMemos(base, 'runner-1', store);
  assert.notEqual(carried, base);
  assert.equal(carried.digest, createHash('sha256').update(carried.bytes).digest('hex'), 'the bundle is named by its digest');
  assert.equal(carried.descriptor.digest, carried.digest);
  assert.deepEqual(carried.descriptor.sources, base.descriptor.sources);
  assert.deepEqual(readFileSync(carried.file), carried.bytes);
  const bundle = deserialize(carried.bytes);
  assert.deepEqual(bundle.artifacts, deserialize(base.bytes).artifacts, 'the inventory artifacts are unchanged');
  assert.ok(carried.bytes.length > 400 * 1024, 'the memos are in the artifact frame, outside the 1 MiB request spec');
  runnerFixtureMemos({ cellsCacheDirectory: kind => join(runner, kind) }, carried.file);
  for (const name of [FIRST, SECOND]) assert.ok(deserialize(gunzipSync(readFileSync(join(runner, 'fixtures', name)))).entries.size === 2, `${name} seeded`);
});

test('cli.io-memo-artifact.a-memo-the-runner-last-returned-with: clause 1: a memo the runner last returned with the same digest is not sent to it again [C7]', t => {
  const store = folder(t, 'fixture-memo-artifact-held-');
  const held = memo(FIRST, ['a']);
  absorbFixtureMemo(store, held);
  const base = inventory(store);
  keepRunnerFixtureMemo({ fixtureMemo: { ...held } }, store, 'runner-1');
  assert.equal(withFixtureMemos(base, 'runner-1', store), base, 'runner-1 already holds the stored memo');
  assert.notEqual(withFixtureMemos(base, 'runner-2', store), base, 'runner-2 does not');
  absorbFixtureMemo(store, memo(FIRST, ['b']));
  const grown = deserialize(withFixtureMemos(base, 'runner-1', store).bytes);
  assert.deepEqual(grown.fixtureMemos.map(row => row.name), [FIRST], 'a grown memo is sent again');
  assert.equal(withFixtureMemos(null, 'runner-1', store), null, 'no inventory, no artifact');
});
