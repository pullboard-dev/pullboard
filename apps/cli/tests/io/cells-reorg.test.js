/** @pullboard-test-input source-cell apps/cli */
/** cellsReorgReason names reorg work from the title, path map and shims only, never from plan files [C7,#11310]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cellsReorgReason } from '../../src/io/cells-reorg.js';

const SOURCE = fileURLToPath(new URL('../../src/io/cells-reorg.js', import.meta.url));
const CHECKS = fileURLToPath(new URL('../../src/io/cells-submit-checks.js', import.meta.url));
const same = () => new Map([['old/a.js', 'new/a.js']]);

test('cli.io-cells-reorg.plan-files-name-no-reorg: clause 1: an item that edits a plan shard or plan-data file gets null, a path-map change still returns its reason [C7,#11310]', () => {
  const files = ['packages/codemap/data/plan/cells.json', 'packages/codemap/data/plan/05-cli.json', 'packages/codemap/data/plan/seed.json'];
  assert.equal(cellsReorgReason({ title: 'Edit a body', changed: files, beforeMap: same(), afterMap: same() }), null);
  assert.equal(cellsReorgReason({ title: 'Edit a body', changed: files, beforeMap: same(), afterMap: new Map() }), 'the item changes path-map.json');
});

test('cli.io-cells-reorg.no-plan-readers: clause 2: cells-reorg.js has no planReorg, dataReorg or planData function and reads no plan file [C7,#11310]', () => {
  const text = readFileSync(SOURCE, 'utf8');
  assert.doesNotMatch(text, /\b(?:planReorg|dataReorg|planData)\b/u);
  // The one plan path left is the location a fixture warning names when it has none; nothing opens it.
  assert.deepEqual(text.split('\n').filter(line => line.includes('data/plan/') && !line.includes('return warning(')), []);
});

test('cli.io-cells-reorg.submit-checks-call-without-plan-rows: clause 3: inspectCellsSnapshotProblems calls cellsReorgReason without before, after or readData [C7,#11310]', () => {
  const call = /cellsReorgReason\(\{[^}]*\}\)/u.exec(readFileSync(CHECKS, 'utf8'))?.[0] ?? '';
  assert.ok(call, 'the call is present');
  assert.doesNotMatch(call, /\b(?:before|after|readData)\b\s*[:,}]/u);
});
