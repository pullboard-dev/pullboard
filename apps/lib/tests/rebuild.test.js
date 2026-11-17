/** A stale accepted-inventory identity rebuilds from the pinned commit's own tooling instead of staying pending [C7]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { cleanupFixtureChildren } from '../../cli/tests/fixtures/child.js';
import { pathToFileURL } from 'node:url';
import { after } from 'node:test';
import { test } from 'node:test';
import {
  acceptedCellsIdentity,
  nudgeAcceptedCells,
} from '../../../packages/gate/index.js';
import { acceptedInventoryKey } from '../../../packages/codemap/index.js';
import {
  isolateMachine,
  toolingRepo,
} from './fixtures/test/rebuild.js';

after(cleanupFixtureChildren);

test('lib.rebuild.nudgeacceptedcells-treats-a-ready-record-whose-checker: clause 1: nudgeAcceptedCells treats a ready record whose checker differs from the identity as absent and starts a producer [C7]', { timeout: 120_000 }, async t => {
  isolateMachine(t);
  const { root, commit } = toolingRepo(t);
  const identity = acceptedCellsIdentity(root, commit, { pinned: true }), key = acceptedInventoryKey(identity);
  mkdirSync(identity.directory, { recursive: true });
  writeFileSync(join(identity.directory, `${key}.inventory.gz`), 'x');
  const stat = { bytes: 1, modified: 0 };
  const seed = { version: 1, tree: identity.tree, checker: '0'.repeat(64), preloads: identity.preloads, key, ...stat };
  writeFileSync(join(identity.directory, `${key}.ready.json`), JSON.stringify(seed));
  const missing = await nudgeAcceptedCells(root, pathToFileURL(join(root, 'bin/no-such-worker.js')), commit).catch(error => error);
  assert.ok(missing && missing !== null, 'a stale ready record must not read as ready: the nudge must try a producer');
  assert.ok(readFileSync(join(identity.directory, `${key}.owner.json`), 'utf8').includes(identity.tree), 'the producer ownership was recorded');
});
