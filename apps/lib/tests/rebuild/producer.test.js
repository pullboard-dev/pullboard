/** A stale accepted-inventory identity rebuilds from the pinned commit's own tooling through a real producer instead of staying pending [C7]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { after } from 'node:test';
import { test } from 'node:test';
import {
  acceptedCellsIdentity,
  nudgeAcceptedCells,
  readAcceptedCells,
  toolingIsPinned,
} from '../../../../packages/gate/index.js';
import { acceptedInventoryKey } from '../../../../packages/codemap/index.js';
import { cleanupFixtureChildren } from '../../../cli/tests/fixtures/child.js';
import {
  isolateMachine,
  modifiedToolingCopy,
  toolingRepo,
} from '../fixtures/test/rebuild.js';

after(cleanupFixtureChildren);

/** Wait for the detached producer to exit, then read its ready record if it published one. */
async function published(child, file) {
  child.ref();
  await once(child, 'exit');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

test('clause 2: a producer nudged from a modified tooling copy records the pinned commit\'s checker and preloads [C7]', { timeout: 590_000 }, async t => {
  isolateMachine(t);
  const { root, commit } = toolingRepo(t, { runnable: true });
  const copy = modifiedToolingCopy(t, 'modified tooling copy');
  const identity = acceptedCellsIdentity(root, commit, { pinned: true }), key = acceptedInventoryKey(identity);
  assert.equal(toolingIsPinned(root, commit), true, 'this checkout carries the pinned tooling');
  const child = await nudgeAcceptedCells(root, pathToFileURL(join(copy, 'apps/cli/src/io/landing/audit.js')), commit);
  assert.ok(child, 'a producer was started from the copy');
  const record = await published(child, join(identity.directory, `${key}.ready.json`));
  const failure = [join(identity.directory, `${key}.failure.json`), join(identity.directory, `${commit}.failure.json`)].find(existsSync) ?? '';
  assert.ok(record, `the producer published a ready record: ${failure ? readFileSync(failure, 'utf8') : 'no failure recorded'}`);
  assert.equal(record.checker, identity.checker, 'the recorded checker is the pinned commit\'s, not the copy\'s');
  assert.equal(record.preloads, identity.preloads);
  assert.equal(readAcceptedCells(root, commit).descriptor?.checker, identity.checker);
});
