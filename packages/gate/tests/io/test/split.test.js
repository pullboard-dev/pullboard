/** @pullboard-test-input test-tree */
/** One split command moves every per-file registry row to the new files, and refuses a rising budget [C7]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { splitRegistries } from '../../../src/io/test/split.js';
import { CELL_METRICS } from '../../../../codemap/index.js';
import { readCellLintBaseline } from '../../../../codemap/index.js';
import { privateFixtureFiles } from '../../fixtures/child.js';

const OLD = 'apps/cli/journeys/demo/old.test.js';
const NEW = 'apps/cli/journeys/demo/old/part.test.js';
const HELPER = 'apps/cli/tests/fixtures/demo/part.js';
const LINTS = 'packages/codemap/data/baselines/lints';
const json = value => JSON.stringify(value, null, 2) + '\n';
const digest = text => createHash('sha256').update(text).digest('hex');
// Scanned source lines, joined at run time so this file's own text never carries the sites.
const LAUNCH = ['box', ".run(repo, 'add', 'web');"].join('');
const SLEEP = ['await sl', 'eep(30);'].join('');
const OPEN = ['open', "Board(join(dir, 'board.sqlite'));"].join('');

/** A tree with the original test, one row in every registry and a hash-bound lint baseline. */
function tree() {
  const fixture = privateFixtureFiles('pullboard-split-registries-');
  const { write } = fixture;
  write(OLD, [LAUNCH, LAUNCH, SLEEP, OPEN, ''].join('\n'));
  write('packages/gate/data/baselines/cli-launches.json', json({ 'apps/other.test.js': { launch: 1 }, [OLD]: { launch: 2 } }));
  write('packages/gate/data/baselines/test-waits-baseline.json', json({ [OLD]: { sleep: 1 } }));
  write('packages/gate/data/tests/test-fixtures.json', json({ [OLD]: { 'raw-cli': 2 } }));
  write('packages/gate/src/io/board/baseline.js', `/** Ceiling. */\nexport const BOARD_FILE_BASELINE = {\n  "apps/other.test.js": 2,\n  "${OLD}": 1,\n};\n`);
  write('packages/gate/data/tests/test-journeys.json', json({ version: 1, files: { [OLD]: { cells: ['app:cli'], reasons: ['runs the CLI'] } } }));
  write('packages/gate/data/tests/tiers.json', json({ version: 1, files: [{ file: 'apps/a.test.js', tier: 'T1' }, { file: OLD, tier: 'T3' }, { file: 'apps/z.test.js', tier: 'T1' }] }));
  write('apps/view/src/logic/roles.js', `export const VIEW_TEST_ROLES = Object.freeze({\n  '${OLD}': { kind: 'journey', reason: 'Real Chrome {layout}.' },\n  'apps/cli/journeys/x.test.js': { kind: 'logic', reason: 'x' }\n});\n`);
  write('pullboard.json', json({ lanes: { view: { owns: ['apps/view/', OLD] }, core: { owns: ['apps/'] } } }));
  write('packages/codemap/data/plan/path-map/demo.json', json({ 'test/old.test.js': OLD }));
  const shards = { fileSize: { [OLD]: 207, 'apps/big.js': 40 }, boundaries: { [`${OLD}->apps/x.js`]: 1, [`${OLD}->src/gone.js`]: 1 }, strays: { [OLD]: 1 } };
  const descriptor = { version: 2, metrics: {} };
  for (const metric of CELL_METRICS) {
    const allowances = shards[metric] ?? {}, file = `${LINTS}/${metric}-001.json`, bytes = json({ version: 1, metric, allowances });
    if (shards[metric]) write(file, bytes);
    descriptor.metrics[metric] = { count: Object.values(allowances).reduce((a, b) => a + b, 0), shards: shards[metric] ? [{ file, sha256: digest(bytes) }] : [] };
  }
  write(`${LINTS}/index.json`, json(descriptor));
  const payload = { version: 1, cell: 'demo', baseSha256: digest(json(descriptor)), metrics: { fileSize: { remove: [OLD], allowances: { [OLD]: 200 } } } };
  write(`${LINTS}/cells/demo.json`, json({ ...payload, sha256: digest(json(payload)) }));
  return fixture;
}

/** The measured lint debt after the split, and main's before it. */
const lints = async () => ({
  report: { metrics: { fileSize: { findings: [{ key: NEW, count: 120 }] }, boundaries: { findings: [{ key: `${OLD}->apps/x.js`, count: 1 }, { key: `${NEW}->apps/x.js`, count: 1 }] } } },
  base: { metrics: { fileSize: { findings: [{ key: OLD, count: 150 }] }, boundaries: { findings: [{ key: `${OLD}->apps/x.js`, count: 1 }, { key: `${OLD}->apps/y.js`, count: 1 }] } } },
});
/** The tier classifier's rows for the split files. */
const tiers = () => ({ files: [{ file: OLD, tier: 'T3' }, { file: NEW, tier: 'T2' }] });

test('a split moves every per-file registry row to its new files in one command [C7]', async () => {
  const fixture = tree(), { root, write, read } = fixture;
  try {
    write(OLD, [LAUNCH, ''].join('\n'));
    write(NEW, [LAUNCH, SLEEP, OPEN, ''].join('\n'));
    write(HELPER, 'export const part = 1;\n');
    const effective = readCellLintBaseline(root);
    const { rows, written } = await splitRegistries(root, OLD, [NEW, HELPER], { lints: async () => ({ ...await lints(), effective }), tiers });
    const text = file => read(file).toString('utf8'), data = file => JSON.parse(text(file));
    assert.deepEqual(data('packages/gate/data/baselines/cli-launches.json'), { 'apps/other.test.js': { launch: 1 }, [OLD]: { launch: 1 }, [NEW]: { launch: 1 } }, 'launches are counted per new file and keep their total');
    assert.deepEqual(data('packages/gate/data/baselines/test-waits-baseline.json'), { [NEW]: { sleep: 1 } }, 'the wait moved with its code');
    assert.deepEqual(data('packages/gate/data/tests/test-fixtures.json'), { [OLD]: { 'raw-cli': 1 }, [NEW]: { 'raw-cli': 1 } }, 'fixture ceilings follow the measured sites');
    assert.match(text('packages/gate/src/io/board/baseline.js'), new RegExp(`"apps/other.test.js": 2,\\n  "${NEW}": 1,\\n\\};`, 'u'), 'the board-file ceiling names the new file only');
    assert.deepEqual(Object.keys(data('packages/gate/data/tests/test-journeys.json').files), [OLD, NEW], 'the new test inherits the journey row; the helper is no test');
    assert.deepEqual(data('packages/gate/data/tests/tiers.json').files.map(row => `${row.file}:${row.tier}`), ['apps/a.test.js:T1', `${OLD}:T3`, `${NEW}:T2`, 'apps/z.test.js:T1'], 'tiers are classified in place');
    assert.match(text('apps/view/src/logic/roles.js'), new RegExp(`"${NEW}": \\{ kind: 'journey', reason: 'Real Chrome \\{layout\\}.' \\},\\n  'apps/cli/journeys/x.test.js'`, 'u'), 'the view role is copied whole');
    assert.deepEqual(data('pullboard.json').lanes.view.owns, ['apps/view/', OLD, NEW, HELPER], 'the owning lane keeps every piece');
    assert.deepEqual(data('pullboard.json').lanes.core.owns, ['apps/'], 'a lane that never named the file is untouched');
    const baseline = readCellLintBaseline(root);
    assert.deepEqual(baseline.metrics.fileSize.allowances, { [NEW]: 120, 'apps/big.js': 40 }, 'file size is measured per file; the cell delta for the old file is dropped');
    assert.deepEqual(baseline.metrics.boundaries.allowances, { [`${OLD}->apps/x.js`]: 1, [`${NEW}->apps/x.js`]: 1 }, 'edges are measured per file and stale ones go');
    assert.deepEqual(baseline.metrics.strays.allowances, {}, 'a stray the lint no longer finds is removed');
    assert.equal(baseline.metrics.fileSize.count, 160, 'the index count is the sum of its allowances');
    assert.ok(written.includes(`${LINTS}/index.json`) && written.includes(`${LINTS}/cells/demo.json`), 'the index and cell deltas are rebound');
    assert.ok(rows.every(row => !row.rose), 'no budget rose');
    assert.deepEqual(rows.find(row => row.registry === 'lint fileSize'), { registry: 'lint fileSize', before: 150, after: 120, rose: false }, 'the lint budget is main\'s measured debt');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a split that raises any budget writes nothing [C7]', async () => {
  const fixture = tree(), { root, write, read } = fixture;
  try {
    write(OLD, [LAUNCH, ''].join('\n'));
    write(NEW, [LAUNCH, SLEEP, SLEEP, ''].join('\n'));
    const before = read('packages/gate/data/baselines/test-waits-baseline.json').toString('utf8');
    const effective = readCellLintBaseline(root);
    await assert.rejects(splitRegistries(root, OLD, [NEW], { lints: async () => ({ ...await lints(), effective }), tiers }),
      error => error.code === 'SPLIT_RATCHET' && /waits 1 -> 2 \(sleep\)/u.test(error.message) && Boolean(error.next));
    assert.equal(read('packages/gate/data/baselines/test-waits-baseline.json').toString('utf8'), before, 'the ceiling is unchanged');
    assert.deepEqual(readCellLintBaseline(root), effective, 'the lint baseline is unchanged');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a split that deletes a path-map target refuses with the next step [C7]', async () => {
  const fixture = tree(), { root, write } = fixture;
  try {
    rmSync(`${root}/${OLD}`);
    write(NEW, [LAUNCH, ''].join('\n'));
    await assert.rejects(splitRegistries(root, OLD, [NEW], { lints: null, tiers }), error => error.code === 'SPLIT_PATH_MAP' && error.next.includes(`keep ${OLD}`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
