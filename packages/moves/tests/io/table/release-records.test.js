/** @pullboard-test-input source-cell packages/moves */
/** @pullboard-world-pin reads the release records reader's own source to prove it names no recorded event id to skip. The reader replays every recorded release or lists it as unreplayable with a reason, and no single event is exempt by its id [C7,#9833]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const SOURCE = readFileSync(new URL('../../../src/io/table/release-records.js', import.meta.url), 'utf8');

test('moves.io-table-release-records.no-skipped-event-ids: clause 1: release-records.js holds no list of skipped recorded event ids [C7,#9833]', () => {
  assert.doesNotMatch(SOURCE, /\b\d{5,}\b/u, 'no recorded event id is written into the reader');
  assert.doesNotMatch(SOURCE, /\b(?:SKIP|SKIPPED|IGNORE|IGNORED)[A-Z_]*\b/u, 'no skip list is named in the reader');
});
