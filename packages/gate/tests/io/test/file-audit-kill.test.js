/** An audit budget row lifts the 180 s per-file kill to AUDIT_FILE_KILL_MS; other rows keep their own ms [C7]. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AUDIT_FILE_KILL_MS } from '../../../src/io/test/file/dispatch.js';
import { rowFileKillMs } from '../../../src/io/test/file/dispatch.js';

test('clause 1: an audit row lifts the per-file kill past 180 s to AUDIT_FILE_KILL_MS [C7]', () => {
  assert.equal(AUDIT_FILE_KILL_MS, 600_000);
  assert.equal(rowFileKillMs({ audit: true, ms: 240_000 }), AUDIT_FILE_KILL_MS);
  assert.equal(rowFileKillMs({ audit: true, ms: 1_000 }), AUDIT_FILE_KILL_MS);
  assert.ok(AUDIT_FILE_KILL_MS > 180_000);
});

test('clause 1: --no-file-limit lifts every file, a plain row keeps its own ms, no row sets none [C7]', () => {
  assert.equal(rowFileKillMs({ ms: 60_000 }, { PULLBOARD_TEST_NO_FILE_LIMIT: '1' }), AUDIT_FILE_KILL_MS);
  assert.equal(rowFileKillMs({ ms: 240_000 }), 240_000);
  assert.equal(rowFileKillMs({ ms: 60_000, audit: false }), 60_000);
  assert.equal(rowFileKillMs(undefined), undefined);
});
