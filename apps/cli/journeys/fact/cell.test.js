/** @pullboard-world-pin: the lint clause reads the shipped cell fixture and its helpers to prove they never import the CLI. */
/** The cell fixture builds a real project without the CLI, and a lint keeps it that way [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellBoard } from '../../../../packages/store/tests/fixtures/cell.js';
import { cellRepo } from '../../../../packages/store/tests/fixtures/cell.js';
import { CELL_CONFIG } from '../../../../packages/store/tests/fixtures/cell.js';
import { cellClaim } from '../../../../packages/store/tests/fixtures/cell.js';
import { cellItem } from '../../../../packages/store/tests/fixtures/cell.js';
import { cellSandbox } from '../../../../packages/store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../packages/store/tests/fixtures/cell.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { criterionFreezer } from '../../../../packages/moves/index.js';
import { getItem } from '../../../../packages/store/index.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { FIXTURE_MODEL } from '../../tests/fixtures/testkit.js';

const FORBIDDEN = [
  ['apps/cli/pullboard.js', /\/apps\/cli\/pullboard\.js['"]/u],
  ['an apps/cli module outside the shared fixtures', /\/apps\/cli\/(?!tests\/fixtures\/)[^'"]*['"]/u],
  ['apps/cli/tests/fixtures/e2e.js', /\/e2e\.js['"]/u],
];
/** The library front door is forbidden to the cell fixture itself; its shared helper (testkit.js) opens boards through it. */
const FIXTURE_FORBIDDEN = ['the library front door apps/lib/index.js', /\/apps\/lib\/index\.js['"]/u];

/** The static import and re-export specifiers of one module, comments and strings left aside. */
function specifiers(source) {
  return [...source.matchAll(/^\s*(?:import|export)\b[^'"]*?\bfrom\s*(['"])([^'"]+)\1|^\s*import\s*(['"])([^'"]+)\3/gmu)].map(match => match[2] ?? match[4]);
}

test('clause 1: cellRepo commits pullboard.json and SPEC.md in a real Git repo with no hooks, and cellBoard opens the real schema [C7]', t => {
  const repo = cellRepo(t);
  assert.deepEqual(JSON.parse(readFileSync(join(repo.root, 'pullboard.json'), 'utf8')), CELL_CONFIG);
  assert.equal(runFixtureGit(['ls-files'], { cwd: repo.root, encoding: 'utf8' }).trim().split('\n').sort().join(' '), 'SPEC.md pullboard.json');
  assert.equal(runFixtureGit(['rev-parse', 'HEAD'], { cwd: repo.root, encoding: 'utf8' }).trim(), repo.commit);
  assert.doesNotMatch(readFileSync(join(repo.root, '.git', 'config'), 'utf8'), /hooksPath/iu, 'no hooks path is configured');
  const hooks = join(repo.root, '.git', 'hooks');
  assert.deepEqual(existsSync(hooks) ? readdirSync(hooks).filter(name => !name.endsWith('.sample')) : [], [], 'no hook is installed');
  const board = cellBoard(t, repo.boardFile);
  const tables = board.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
  for (const table of ['item', 'agent', 'event', 'board_meta']) assert.ok(tables.includes(table), table);
  assert.ok(existsSync(repo.boardFile), 'the board is a real SQLite file in the repository');
});

test('clause 1: the cell fixture and its helpers import no CLI entry, no apps/cli module and not the library front door [C7]', () => {
  const pending = [new URL('../../../../packages/store/tests/fixtures/cell.js', import.meta.url)], seen = new Set();
  while (pending.length) {
    const url = pending.shift(), name = url.pathname;
    if (seen.has(name)) continue;
    seen.add(name);
    const source = readFileSync(url, 'utf8');
    assert.doesNotMatch(source, /import\s*\*\s*as\s+[\w$]+\s+from\s*['"][^'"]*\/index\.js['"]/u, `${name} takes a namespace of a front door`);
    for (const specifier of specifiers(source)) {
      for (const [label, pattern] of FORBIDDEN) assert.doesNotMatch(`'${specifier}'`, pattern, `${name} imports ${label}: ${specifier}`);
      if (seen.size === 1) assert.doesNotMatch(`'${specifier}'`, FIXTURE_FORBIDDEN[1], `${name} imports ${FIXTURE_FORBIDDEN[0]}: ${specifier}`);
      if (specifier.startsWith('.') && !specifier.endsWith('/index.js')) pending.push(new URL(specifier, url));
    }
  }
  assert.ok([...seen].some(file => file.endsWith('/tests/fixtures/testkit.js')) && [...seen].some(file => file.endsWith('/tests/fixtures/child.js')), [...seen].join(', '));
});

test('clause 2: cellSeat and cellItem leave the seat and item rows join and add leave, through the store moves [C7]', t => {
  const repo = cellRepo(t);
  const board = cellBoard(t, repo.boardFile);
  const coordinator = cellSeat(board, { lane: 'coordinator', path: repo.root });
  const seat = cellSeat(board, { lane: 'web', path: join(repo.root, 'web-seat') });
  assert.deepEqual([coordinator.id, coordinator.agent_lane, coordinator.agent_path], ['coordinator', 'coordinator', repo.root]);
  assert.deepEqual([seat.id, seat.agent_lane, seat.agent_route, seat.agent_path], ['web-1', 'web', 'strong', join(repo.root, 'web-seat')]);
  const item = cellItem(board, { lane: 'web', title: 'Render the page', criterion: '1. The page renders. [test]', specIds: ['G1'] });
  assert.deepEqual([item.item_id, item.item_status, item.item_lane, item.item_title], [1, 'open', 'web', 'Render the page']);
});

test('clause 3: cellClaim freezes the criterion with the claim move\'s one freezer, the text and digest pullboard claim freezes [B2,C7]', t => {
  const repo = cellRepo(t);
  const board = cellBoard(t, repo.boardFile);
  cellSeat(board, { lane: 'coordinator', path: repo.root });
  const seat = cellSeat(board, { lane: 'web', path: join(repo.root, 'web-seat') });
  const item = cellItem(board, { lane: 'web', title: 'Render the page', criterion: '1. The page renders. [test]', specIds: ['G1'] });
  const expected = criterionFreezer({ root: repo.root, isMain: true, config: CELL_CONFIG }, { board })(item);
  cellClaim(board, item.item_id, seat, { root: repo.root });
  const claimed = getItem(board, item.item_id);
  assert.deepEqual([claimed.item_status, claimed.item_owner, claimed.item_claim_head], ['claimed', seat.id, repo.commit]);
  assert.equal(claimed.item_frozen, expected.text);
  assert.equal(claimed.item_frozen_digest, expected.digest);
  assert.equal(JSON.parse(claimed.item_frozen).policy, undefined, 'the freeze holds the bar alone, no policy pin [B4]');
});

test('clause 1: cellSandbox\'s env equals the e2e sandbox\'s env except PATH, the per-run dir paths and the fixture model its seats share [C7]', t => {
  const cell = cellSandbox(t);
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const e2e = helpers.sandbox();
  const perRun = ['PATH', 'PULLBOARD_HOME', 'PULLBOARD_MACHINE_HOME', 'PULLBOARD_MODEL'];
  assert.deepEqual(Object.keys(cell.env).sort(), Object.keys(e2e.env).sort());
  for (const key of Object.keys(e2e.env)) if (!perRun.includes(key)) assert.equal(cell.env[key], e2e.env[key], key);
  assert.equal(cell.env.PATH, process.env.PATH, 'no pullboard shim is put on PATH');
  assert.equal(cell.env.PULLBOARD_HOME, join(cell.dir, 'pullboard-home'));
  assert.equal(cell.env.PULLBOARD_MACHINE_HOME, join(cell.dir, 'machine-home'));
  assert.equal(cell.env.PULLBOARD_MODEL, FIXTURE_MODEL, 'the session model is the one cellSeat registers seats with, so a cell project agrees with its own seats');
  assert.equal(cell.env.PULLBOARD_USAGE_CHECKPOINT, 'inline');
  assert.equal(cell.env.PULLBOARD_INFRA_RETRY_BACKOFF_MS, '0');
});
