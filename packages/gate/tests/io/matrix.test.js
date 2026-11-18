/** @pullboard-test-input test-tree */
/** @pullboard-test-input docs-tree */
/** @pullboard-world-pin: clauses 1 and 2 read the harness folder and docs/architecture.md to keep the matrix, its harnesses and its page in step. */
/**
 * The pipeline hop matrix stays honest [C7]: every hop names a harness that exists or NONE, every harness file is in
 * the matrix, docs/architecture.md lists every hop, and the runner turns harness results and live receipts into
 * PASS, FAIL and NONE rows the same way every time. The harnesses themselves are slow and run only through
 * packages/gate/src/io/matrix.js; this test runs none of them.
 */
import assert from 'node:assert/strict';
import {
  existsSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  APP_HARNESSES,
  HARNESS_FILES,
  HOPS,
  harnessFile,
  matrixRows,
  parseArgs,
  renderMatrix,
} from '../../src/io/matrix.js';

const ROOT = join(import.meta.dirname, '../../../..');
const HARNESSES = join(ROOT, 'packages/gate/tests/fixtures/pipeline');

/**
 * The lines of the architecture page's pipeline hop section.
 *
 * @returns {string[]}
 */
function hopSection() {
  const lines = readFileSync(join(ROOT, 'docs', 'architecture.md'), 'utf8').split('\n');
  const start = lines.indexOf('## Pipeline hops: Build → Gate → Review → Land');
  assert.ok(start >= 0, 'the architecture page has the pipeline hop section');
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines.slice(start + 1, end < 0 ? lines.length : end);
}

test('gate.io-matrix.every-hop-names-an-existing: every hop names an existing harness or none, and every harness file is a hop\'s [C7]', () => {
  const helpers = new Set(['kit.js', 'project.js']);
  const files = readdirSync(HARNESSES, { recursive: true }).filter(name => name.endsWith('.js') && !helpers.has(name)).map(name => name.replace(/\.js$/u, ''));
  const named = new Set(HOPS.map(hop => hop.harness).filter(Boolean));
  for (const name of named) assert.ok(existsSync(harnessFile(name)), `hop harness ${name} exists`);
  const mapped = new Set(named.values().map(name => HARNESS_FILES[name]));
  for (const name of files) assert.ok(mapped.has(name), `harness ${name} proves a hop in the matrix`);
  assert.equal(new Set(HOPS.map(hop => hop.id)).size, HOPS.length, 'hop ids are unique');
  for (const hop of HOPS.filter(entry => entry.fix)) assert.match(hop.fix, /^[0-9a-f]{10,40}$/u, `${hop.id} names the fix commit its repro fails before`);
});

test('gate.io-matrix.the-architecture-page-lists-every: the architecture page lists every hop with its harness, and NONE exactly where no harness exists [C7]', () => {
  const rows = hopSection().filter(line => line.startsWith('| ') && !line.startsWith('| Hop') && !line.startsWith('|---'));
  for (const hop of HOPS) {
    const row = rows.find(line => line.includes(`<a id="hop-${hop.id}"></a>`));
    assert.ok(row, `the page has a row for ${hop.id}`);
    if (hop.harness) {
      const moved = APP_HARNESSES[hop.harness];
      assert.ok(row.includes(moved ?? `packages/gate/tests/fixtures/pipeline/${HARNESS_FILES[hop.harness]}.js`), `${hop.id}'s row names its harness`);
    }
    else assert.match(row, /\| NONE \|/u, `${hop.id}'s row says NONE: no harness is real debt`);
  }
  assert.equal(rows.length, HOPS.length, 'one row per hop, no others');
});

test('gate.io-matrix.the-runner-reads-harness-rows: the runner reads harness rows into PASS, FAIL and NONE, fails a leak, and marks a row current only when live agrees [C7]', () => {
  const runs = new Map([
    ['e2e', { code: 0, tail: '', rows: [{ hop: 'claim', status: 'PASS', ms: 900, measured: 'claimed', cause: '' }] }],
    ['board-commands', { code: 1, tail: 'error: \'next wall 520 over 200\'', rows: [
      { hop: 'command-latency', status: 'FAIL', ms: 520, measured: 'next 1674 modules 520 ms', cause: 'next wall 520 over 200' },
    ] }],
    ['dead-worker-requeue', { code: 0, tail: '', rows: [{ hop: 'dead-requeue', status: 'PASS', ms: 1600, measured: 'requeued', cause: '' }] }],
    ['proof-lanes', { code: 1, tail: 'no process this harness started outlives it by 30000 ms', rows: [{ hop: 'proof-lanes', status: 'PASS', ms: 10, measured: 'at most 3', cause: '' }] }],
    ['analysis-on-runner', { code: 0, tail: '', rows: [{ hop: 'analysis-on-runner', status: 'PASS', ms: 40, measured: 'one runner job', cause: '' }] }],
    ['live-driver', { code: 1, tail: '  error: \'Cannot find module x\'\n', rows: [] }],
  ]);
  const live = { phases: [{ phase: 'requeue', gates: 22, p50Ms: 101_000 }], causes: [] };
  const rows = Object.fromEntries(matrixRows(runs, live).map(row => [row.id, row]));
  assert.equal(rows.claim.status, 'PASS');
  assert.equal(rows.claim.current, true, 'a passing hop with no live receipt is current');
  assert.equal(rows['command-latency'].status, 'FAIL');
  assert.equal(rows['dead-requeue'].status, 'PASS');
  assert.equal(rows['dead-requeue'].current, false, 'a live requeue p50 of 101 s disagrees with the 20 s bound');
  assert.equal(rows['proof-lanes'].status, 'FAIL', 'a harness whose child outlived it fails its hop');
  assert.equal(rows['live-driver'].status, 'FAIL', 'a hop its harness never reported fails with the harness\'s error');
  assert.match(rows['live-driver'].cause, /Cannot find module/u);
  assert.equal(rows['analysis-on-runner'].status, 'PASS', 'a hop with a mapped harness reports what the harness printed');
  assert.equal(rows['runner-spec'].status, 'SKIPPED', 'a harness left out with --only is not a pass');
  // Every hop has a harness now, so the NONE rendering is checked on a row emptied of its result.
  const noHarness = Object.values(rows).map(row => (row.id === 'analysis-on-runner' ? { ...row, status: 'NONE', ms: null, measured: '', cause: '', current: false } : row));
  const text = renderMatrix(noHarness, { at: 'now', against: null, live: true });
  assert.match(text, /dead worker → requeue +PASS +1\.6s +requeued +live: requeue p50 1m41s over 22 gates \(disagrees\)/u);
  assert.match(text, /analysis job on runner +NONE +no harness/u);
  assert.deepEqual(parseArgs(['--only', 'e2e,proof-lanes', '--live', '--since', '6h']), { only: ['e2e', 'proof-lanes'], live: true, since: '6h', against: null, json: false });
  assert.throws(() => parseArgs(['--fast']), /unknown argument --fast/u);
});
