/** @pullboard-test-input source-tree packages/codemap/data/plan/** */
/** Temporary import debt has an explicit removal owner, UTC expiry and visible shim count [C7]. */
import { importsIn } from '../../../index.js';
import { commonJsIn } from '../../../index.js';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { computePlan as modelComputePlan } from '../../../../codemap/index.js';
import { writePlan as modelWritePlan } from '../../../../codemap/index.js';
import { readPathMap } from '../../../../codemap/index.js';
import { tryGit } from '../../../../git/index.js';
import { importCuts } from '../../../../codemap/index.js';
import { cellLintReport } from '../../../../codemap/index.js';
import { runFixtureChild } from '../../fixtures/child.js';
import { runFixtureGit } from '../../fixtures/child.js';

/** Compute the plan with the plain Git reader; a fixture repository needs no snapshot-aware reads. */
const computePlan = root => modelComputePlan(root, { tryGit });
/** Write the plan with the plain path-map and Git readers. */
const writePlan = (root, plan) => modelWritePlan(root, plan, { readPathMap, tryGit });

/** Build a committed real Git graph whose earlier cell has one forbidden later import. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-temporary-edges-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let committed = false;
  /** Write actual source and policy bytes in the private checkout; once the fixture is committed, commit each change so the cut check reads it from the tracked snapshot. */
  function put(file, text) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
    if (committed) for (const args of [['add', '-A'], ['commit', '-qm', `fixture ${file}`]]) runFixtureGit(args, { cwd: root, env, encoding: 'utf8' });
  }
  put('package.json', JSON.stringify({ type: 'module', bin: { fixture: 'src/board.js' } }));
  put('src/board.js', "import { claims } from './claims.js'; export const board = () => claims;\n");
  put('src/claims.js', "import { board } from './board.js'; export const claims = () => board;\n");
  put('packages/codemap/data/plan/seed.json', JSON.stringify({ source: 'fixture', sha256: 'none', order: ['store', 'items'],
    cells: { store: ['src/board.js'], items: ['src/claims.js'] }, tests: {} }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  for (const args of [['init', '-q'], ['add', '-A'], ['commit', '-qm', 'fixture']]) runFixtureGit(args, { cwd: root, env, encoding: 'utf8' });
  const plan = computePlan(root), group = importCuts(plan)[0];
  writePlan(root, plan);
  for (const args of [['add', '-A'], ['commit', '-qm', 'fixture plan']]) runFixtureGit(args, { cwd: root, env, encoding: 'utf8' });
  committed = true;
  const edge = group.edges[0];
  const declaration = { importer: edge.from, target: edge.to, contractItem: 1737,
    expires: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10) };
  /** Exercise the actual production command, retaining its status and named diagnostics. */
  function check() {
    return runFixtureChild(process.execPath, [fileURLToPath(new URL('../../../../codemap/src/io/cells/scripts/plan.js', import.meta.url)), '--cuts', group.cell], { cwd: root, env, encoding: 'utf8' });
  }
  /** Replace the one committed-policy input without mocking the scanner. */
  function policy(edges) { put('packages/codemap/data/plan/temporary-edges.json', JSON.stringify({ version: 1, edges })); }
  return { root, put, check, policy, declaration };
}

test('gate.io-edges-temporary.the-actual-cut-command-accepts-only: the actual cut command accepts only declared temporary edges and retains unlisted imports [C7]', t => {
  const box = fixture(t);
  let result = box.check();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /still imports later/u);
  box.policy([box.declaration]);
  result = box.check();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const other = box.declaration.importer === 'src/board.js' ? 'src/claims.js' : 'src/board.js';
  box.put(box.declaration.importer, `import './unlisted.js'; export const value = 1;\n`);
  box.put('src/unlisted.js', `export * from './${other.slice(4)}';\n`);
  result = box.check();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /src\/unlisted.js/u);
});

test('gate.io-edges-temporary.missing-contracts-invalid-dates-expired-entries: missing contracts, invalid dates, expired entries and duplicates fail by edge name [C7]', t => {
  const box = fixture(t);
  for (const [change, expected] of [[{ contractItem: null }, /contract item/u], [{ expires: '2026-02-30' }, /real UTC date/u],
    [{ expires: '2000-01-01' }, /expired/u], [{ importer: '../escape.js' }, /repository module paths/u]]) {
    box.policy([{ ...box.declaration, ...change }]);
    const result = box.check();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, expected);
    assert.ok(result.stderr.includes(box.declaration.target), result.stderr);
  }
  box.policy([box.declaration, box.declaration]);
  assert.match(box.check().stderr, /duplicate temporary edge/u);
  box.put('packages/codemap/data/plan/temporary-edges.json', '{');
  assert.match(box.check().stderr, /invalid JSON/u);
});

test('gate.io-edges-temporary.each-declared-edge-remains-visible-as: each declared edge remains visible as shim debt, including expired debt [C7]', t => {
  const box = fixture(t), before = cellLintReport(box.root, { importsIn, commonJsIn }).metrics.shims.count;
  box.policy([box.declaration]);
  let report = cellLintReport(box.root, { importsIn, commonJsIn });
  assert.equal(report.metrics.shims.count, before + 1);
  const row = report.metrics.shims.findings.find(row => row.key.startsWith('temporary:'));
  assert.equal(row.key, `temporary:${box.declaration.importer}->${box.declaration.target}`);
  assert.match(row.detail, /contract #1737; expires/u);
  box.policy([{ ...box.declaration, expires: '2000-01-01' }]);
  report = cellLintReport(box.root, { importsIn, commonJsIn });
  assert.equal(report.metrics.shims.count, before + 1, 'expiration never erases debt');
  assert.ok(report.unknown.some(row => row.reason.includes('expired')));
});
