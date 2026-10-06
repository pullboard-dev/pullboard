/**
 * Products (S11, S12): named groups of spec rows in pullboard.json. Which product a row, an item or
 * a lane belongs to is read from the spec each time; status prints each product's standing, and
 * spec check catches an entry that names no row.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import * as store from '../src/board.js';
import { configProblems, defaults } from '../src/config.js';
import { names, productProblems, productsOfItem, productsOfLane, productsOfRow, productSummaries } from '../src/products.js';
import { parseSpec } from '../src/spec.js';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
const SHA = 'a'.repeat(40);

const SPEC = `# Demo spec

## B · Board
- B1 [approved, must] Claims are leases. | gate: test
- B2 [draft, must] Two agents never hold one item.
- B3 [wont] Items can be deleted.

## BX · Extras
- BX1 [draft, must] A row in a section whose letters start the same.

## N · Commands
- N1 [approved, must] next claims work. | gate: test
- N26 [draft, must] The view lists projects.
- N26.1 [draft, aim] The view lists them in a sidebar.
`;

const PRODUCTS = { Core: ['B', 'N1'], View: ['N26'] };

const CONFIG = {
  ...defaults(),
  gate: 'true',
  lanes: { board: { owns: ['src/'], specs: ['B'] }, web: { owns: ['web/'], specs: ['N26'] } },
  products: PRODUCTS,
};

const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * A freeze that digests the title, as the real one digests the criterion.
 *
 * @param {any} item
 * @returns {{ text: string, digest: string }}
 */
const freeze = (item) => ({ text: item.item_title, digest: `digest:${item.item_title}` });

test('an entry names a row by its id and sub-ids, or a whole section by its letters [S11]', () => {
  assert.equal(names('B', 'B1'), true);
  assert.equal(names('B', 'B16'), true);
  assert.equal(names('B', 'BX1'), false, 'section letters name their own section only');
  assert.equal(names('N26', 'N26'), true);
  assert.equal(names('N26', 'N26.1'), true, 'an id names its sub-ids');
  assert.equal(names('N26', 'N261'), false);
  assert.equal(names('N2', 'N26'), false);
});

test('rows, items and lanes belong to the products that name them, and nothing stores it [S12]', () => {
  const spec = parseSpec(SPEC);
  assert.deepEqual(productsOfRow(CONFIG, 'B2'), ['Core']);
  assert.deepEqual(productsOfRow(CONFIG, 'N26.1'), ['View']);
  assert.deepEqual(productsOfRow(CONFIG, 'BX1'), []);
  assert.deepEqual(productsOfItem(CONFIG, { item_spec_ids: 'B1,N26' }), ['Core', 'View']);
  assert.deepEqual(productsOfItem(CONFIG, { item_spec_ids: '' }), []);
  assert.deepEqual(productsOfLane(CONFIG, spec, 'board'), ['Core']);
  assert.deepEqual(productsOfLane(CONFIG, spec, 'web'), ['View']);
  const moved = { ...CONFIG, products: { Core: ['B', 'N1', 'N26'], View: [] } };
  assert.deepEqual(productsOfItem(moved, { item_spec_ids: 'N26.1' }), ['Core'], 'changing the list moves the item, with nothing else to update');
  assert.deepEqual(productsOfLane(moved, spec, 'web'), ['Core']);
});

test('config refuses products that are not named lists of spec ids or section letters [S11]', () => {
  const problems = (products) => configProblems({ ...defaults(), products });
  assert.deepEqual(problems({ Core: ['B'] }).filter((problem) => problem.includes('product')), []);
  assert.ok(problems(['B']).some((problem) => problem.startsWith('"products" maps product names')));
  assert.ok(problems({ Core: 'B' }).some((problem) => problem.startsWith('product "Core"')));
  assert.ok(problems({ Core: [] }).some((problem) => problem.startsWith('product "Core"')));
  assert.ok(problems({ Core: ['B', 7] }).some((problem) => problem.startsWith('product "Core"')));
  assert.deepEqual(productProblems({ products: { Core: ['B', 'Q9'] } }, parseSpec(SPEC)), ['product "Core": "Q9" names no row in the spec']);
});

test('in a real repo, status prints each product, and spec check fails on an entry that names no row [S11, S12]', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-products-')));
  dirs.push(dir);
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Agent',
    GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent',
    GIT_COMMITTER_EMAIL: 'agent@example.com',
    PULLBOARD_HOME: join(dir, 'home'),
  };
  const git = (...args) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8', stdio: 'pipe' });
  const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: repo, env, encoding: 'utf8' });
  const writeConfig = (products) => writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'true', lanes: CONFIG.lanes, products }, null, 2));
  git('init', '-q', '-b', 'main');
  writeConfig(PRODUCTS);
  writeFileSync(join(repo, 'SPEC.md'), SPEC);
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: a spec with two products');

  const board = store.openBoard(join(repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    store.register(board, { lane: 'coordinator', path: repo });
    store.register(board, { lane: 'board', path: join(dir, 'board-1') });
    store.register(board, { lane: 'web', path: join(dir, 'web-1') });
    const add = (lane, title, specs) => store.addItem(board, { by: 'coordinator', lane, title, specIds: specs });
    const claim = (id, agentId, lane) => store.claim(board, id, { agentId, lane, leaseMs: 7_200_000, freeze });
    const leases = add('board', 'Leases', ['B1']);
    claim(leases, 'board-1', 'board');
    store.submit(board, leases, { agentId: 'board-1', commit: SHA, tree: 't' });
    store.verify(board, leases, { agentId: 'web-1', decision: 'ACCEPT', head: SHA, digest: 'digest:Leases', policy: 'any', note: 'reverted the lease check; its test went red; restored' });
    claim(add('board', 'Holders', ['B2']), 'board-1', 'board');
    const sidebar = add('web', 'Sidebar', ['N26.1']);
    claim(sidebar, 'web-1', 'web');
    store.submit(board, sidebar, { agentId: 'web-1', commit: SHA, tree: 't' });
    add('web', 'Projects', ['N26']);
    add('board', 'Next', ['N1']);
  } finally {
    store.closeBoard(board);
  }

  const status = run('status');
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /^product Core: 3 rows, 2 approved, 1 cited by accepted items; items 1 open, 1 building, 0 awaiting verification, 1 verified$/m);
  assert.match(status.stdout, /^product View: 2 rows, 0 approved, 0 cited by accepted items; items 1 open, 0 building, 1 awaiting verification, 0 verified$/m);

  assert.equal(run('spec', 'check').status, 0);
  writeConfig({ ...PRODUCTS, View: ['N26', 'Q9'] });
  const typo = run('spec', 'check');
  assert.equal(typo.status, 1);
  assert.match(typo.stdout, /error: product "View": "Q9" names no row in the spec/);

  writeConfig({});
  assert.doesNotMatch(run('status').stdout, /^product /m, 'no products, no product lines');
});

test('a product counts rows in force only, and items by the state the board reads [S12]', () => {
  const spec = parseSpec(SPEC);
  const items = [
    { item_spec_ids: 'B1', item_status: 'verified' },
    { item_spec_ids: 'B3', item_status: 'open' },
    { item_spec_ids: 'N26', item_status: 'withdrawn' },
  ];
  const [core, view] = productSummaries(CONFIG, spec, items);
  assert.deepEqual(core, { name: 'Core', rows: 3, approved: 2, proven: 1, items: { open: 0, claimed: 0, submitted: 0, verified: 1 } }, 'B3 is wont: out of the rows, and the item citing only it is out too');
  assert.deepEqual(view.items, { open: 0, claimed: 0, submitted: 0, verified: 0 }, 'withdrawn items are left out');
});
