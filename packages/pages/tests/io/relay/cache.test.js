/** The relay page cache acknowledges each uploaded object while another process writes the same cache [H16]. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { temporaryDirectory } from '../../../../store/tests/fixtures/tmp.js';
import { createRelayPageCache } from '../../../index.js';
import { snapshotSourceId } from '../../../index.js';

test('[H16] an acknowledge after another connection commits mid-upload is recorded, not refused database is locked', (t) => {
  const home = realpathSync(temporaryDirectory('pullboard-page-cache-'));
  const saved = process.env.PULLBOARD_HOME;
  process.env.PULLBOARD_HOME = home;
  t.after(() => { if (saved === undefined) delete process.env.PULLBOARD_HOME; else process.env.PULLBOARD_HOME = saved; });
  const cache = createRelayPageCache({ board: 'a'.repeat(32), url: 'https://relay.example' });
  t.after(() => cache.close());
  const leaf = randomBytes(64), root = randomBytes(64);
  cache.put({ id: snapshotSourceId(leaf), sequence: 1, bytes: leaf, children: [] });
  cache.put({ id: snapshotSourceId(root), sequence: 1, bytes: root, children: [snapshotSourceId(leaf)] });
  const source = 'b'.repeat(64);
  cache.prepare(source, { id: snapshotSourceId(root), sequence: 1, bytes: root.byteLength });
  // A second process (another pullboard command) commits to the cache while this upload is between objects.
  const other = new DatabaseSync(cache.file);
  t.after(() => other.close());
  const acknowledged = [];
  for (const object of cache.pending(source)) {
    other.exec("INSERT INTO notice VALUES ('s" + acknowledged.length + "', 1)");
    cache.acknowledge(object.id);
    acknowledged.push(object.id);
  }
  assert.equal(acknowledged.length, 2, 'both objects of the prepared graph were streamed');
  assert.deepEqual([...cache.pending(source)], [], 'every acknowledged object left the pending set');
});
