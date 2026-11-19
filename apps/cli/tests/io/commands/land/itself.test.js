/** @pullboard-test-input apps/cli/src/io/commands/hold.js apps/cli/src/io/commands/land.js */
/** Automatic landing schedules its own next wake while verified items wait [C7,#2898]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import * as landCommand from '../../../../src/io/commands/land.js';
import { landingStats } from '../../../../../../packages/landing/index.js';
import { landingStatsLines } from '../../../../../../packages/landing/index.js';

test('cli.io-commands-land-itself.releasing-a-verified-item-hold-wakes-landing: releasing a verified item hold wakes landing the way an accept does [C7,#2898]', () => {
  const source = readFileSync(new URL('../../../../src/io/commands/hold.js', import.meta.url), 'utf8');
  assert.match(source, /item_status === 'verified'\) released = ctx/u);
  assert.match(source, /landAfterAcceptance\(released\)/u);
});

test('cli.io-commands-land-itself.n-6807-clause-2-neither-executeboardlanding-nor-landingbatchrunner: #6807 clause 2: neither executeBoardLanding nor landingBatchRunner is named in apps/cli/src or packages/landing/src [C7,#6807]', () => {
  const roots = ['../../../../src', '../../../../../../packages/landing/src'].map(path => fileURLToPath(new URL(path, import.meta.url)));
  const named = roots.flatMap(root => readdirSync(root, { recursive: true }).filter(file => file.endsWith('.js'))
    .filter(file => /\b(?:executeBoardLanding|landingBatchRunner)\b/u.test(readFileSync(join(root, file), 'utf8'))).map(file => join(root, file)));
  assert.deepEqual(named, []);
});

test('cli.io-commands-land-itself.n-6813-clauses-1-3-the-batch-step: #6813 clauses 1-3: the batch step is gone, its runner is named nowhere, and land.js only offers the land job [C7,#6813]', () => {
  const root = fileURLToPath(new URL('../../../../../../', import.meta.url));
  // Built from parts, so this test names neither the deleted path nor the deleted function itself.
  const step = ['packages/landing/src/io/step', 'batch.js'].join('/');
  assert.equal(execFileSync('git', ['ls-files', '--', step], { cwd: root, encoding: 'utf8' }), '', step);
  let named = '';
  try { named = execFileSync('git', ['grep', '-l', '-w', ['runLanding', 'Batch'].join('')], { cwd: root, encoding: 'utf8' }); }
  catch (error) { if (error.status !== 1) throw error; }
  assert.equal(named, '');
  // The command module exports the command and the accept-time offer, and nothing that runs or schedules a batch.
  assert.deepEqual(Object.keys(landCommand).sort(), ['landAfterAcceptance', 'run']);
});

const NOW = Date.parse('2026-11-18T12:00:00Z');
/** `count` landed batches updated an hour ago, each proved the given way. */
const landed = (count, composition) => Array.from({ length: count }, (_, index) => ({ id: `${composition}-${index}`, state: 'landed', updatedAt: '2026-11-18T11:00:00Z', exactTree: { composition } }));

test('cli.io-commands-land-itself.retest-share-counts: clause 1: land --stats counts same-tree and re-proved landings of the last 7 days and prints the retest share per 100 [C7,#10778]', () => {
  const old = { id: 'old', state: 'landed', updatedAt: '2026-11-01T00:00:00Z', exactTree: { composition: 're-proved' } };
  const open = { id: 'open', state: 'blocked', updatedAt: '2026-11-18T11:00:00Z', exactTree: { composition: 're-proved' } };
  const stats = landingStats([...landed(3, 'same-tree'), ...landed(1, 're-proved'), old, open], { now: NOW });
  assert.deepEqual(stats, { days: 7, landings: 4, sameTree: 3, reProved: 1, retestShare: 25, stop: false });
  assert.deepEqual(landingStatsLines(stats), ['last 7 days: 4 landings, 3 same-tree, 1 re-proved; retest share 25 per 100 landings']);
  const source = readFileSync(new URL('../../../../src/io/commands/land.js', import.meta.url), 'utf8');
  assert.match(source, /values\.stats/u);
  assert.match(source, /store\.landingBatches\(board\)/u);
});

test('cli.io-commands-land-itself.retest-share-stop: clause 2: a retest share above 45 per 100 landings prints a STOP line naming the U159 stop condition [C7,#10778]', () => {
  const above = landingStats([...landed(11, 'same-tree'), ...landed(9, 're-proved')], { now: NOW });
  assert.equal(above.retestShare, 45);
  assert.equal(above.stop, false, '45 is the limit, not above it');
  const over = landingStats([...landed(10, 'same-tree'), ...landed(9, 're-proved')], { now: NOW });
  assert.equal(over.retestShare, 47.4);
  assert.equal(over.stop, true);
  assert.match(landingStatsLines(over)[1], /^STOP: U159 stop condition, the retest share 47\.4 per 100 landings is above 45$/u);
});

test('cli.io-commands-land-itself.retest-share-off: clause 3: with landing.composedEquality off, land --stats is refused with a message naming the setting [C7,#10778]', async () => {
  await assert.rejects(() => landCommand.run({}, { values: { stats: true } }), error => error.code === 'STATS_OFF' && /landing\.composedEquality/u.test(error.message));
});
