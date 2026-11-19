/** @pullboard-test-input apps/cli/src/io/disk/use.js */
/** Retention walks a folder of 200000 entries without a stack overflow, in its own file so the slow setup runs alone [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pruneDisk } from '../../../../src/io/disk/use.js';
import { DAYS } from '../../../fixtures/disk-use.js';
import { NOW } from '../../../fixtures/disk-use.js';
import { fixture } from '../../../fixtures/disk-use.js';

test('cli.io-disk-use-walk.retention-walks-a-folder-of-200000-entries: retention walks a folder of 200000 entries without a stack overflow and finds its newest file [C7]', (t) => {
  const dir = fixture(t);
  const big = join(dir, 'flake-evidence', 'flake-big-6666');
  mkdirSync(big, { recursive: true });
  for (let i = 0; i < 200_000; i++) {
    const file = join(big, `f${i}`);
    writeFileSync(file, '');
    utimesSync(file, DAYS(90), DAYS(90));
  }
  // The one fresh file is the newest; if the walk lost it the entry would look 90 days old and be removed.
  utimesSync(join(big, 'f123456'), DAYS(5), DAYS(5));
  const result = pruneDisk(dir, { now: NOW, dryRun: true });
  assert.ok(!result.removed.some(row => row.entry === 'flake-big-6666'), 'a folder holding a fresh file is not aged');
  assert.ok(result.removed.some(row => row.entry === 'flake-old-5555'), 'an all-old folder is still removed');
});
