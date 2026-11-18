/** @pullboard-test-input source-cell packages/stats */
/** The stats history file has one path function, and the checkpoint writer builds its path through it [C7,#8623]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { appendTimeCheckpoint } from '../../../src/io/time/history.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { statsHistoryFile } from '../../../src/io/time/history.js';

const CHECKPOINT = join(import.meta.dirname, '../../../src/io/time/checkpoint.js');

test('stats.time.history-path: clause 1: statsHistoryFile names the history file under the common dir and checkpoint.js builds its path through it [C7]', () => {
  assert.equal(statsHistoryFile('/x/.git'), join('/x/.git', 'pullboard', 'stats-history.jsonl'));
  const source = readFileSync(CHECKPOINT, 'utf8');
  assert.match(source, /statsHistoryFile\(ctx\.info\.commonDir\)/u);
  assert.equal(/STATS_HISTORY_FILE|stats-history\.jsonl/u.test(source), false, 'checkpoint.js names the file nowhere');
});

test('stats.time.history-append: clause 2: appendTimeCheckpoint writes a line to the file statsHistoryFile names [C7]', t => {
  const scratch = privateFixtureFiles('stats-history-');
  t.after(() => rmSync(scratch.root, { recursive: true, force: true }));
  const file = statsHistoryFile(scratch.root);
  appendTimeCheckpoint(file, '{"a":1}');
  appendTimeCheckpoint(file, '{"a":2}');
  assert.equal(readFileSync(file, 'utf8'), '{"a":1}\n{"a":2}\n');
});
