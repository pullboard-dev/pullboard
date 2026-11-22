/** @pullboard-test-input source-cell packages/items apps/cli packages/store */
/** @pullboard-world-pin reads the items light door and four CLI/store source files to verify selected reader exports. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import * as read from '../../light.js';
import { writeItemMarker } from '../../src/io/claim.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { runFixtureSetupGit } from '../../../gate/tests/fixtures/child.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

test('items.claim.folder-identity-gone: clause 1: src/item-folder-identity.js is gone and no tracked file imports it [C7,#3554]', () => {
  const listed = spawnSync('git', ['ls-files', '--', 'src/item-folder-identity.js'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(listed.stdout, '', 'the shim is deleted');
  const found = spawnSync('git', ['grep', '-l', '-E', '-e', "from[[:space:]]+['\"][^'\"]*src/item-folder-identity\\.js['\"]", '--', '*.js', ':(exclude)packages/codemap/data/plan/'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(found.status, 1, `git grep finds no importer, got ${found.status}: ${found.stdout}`);
});

test('items.claim.plan-and-edges-pass: clause 2: the cells plan check and the cells edges check pass, the edges check without the light-door cold-load measure that its own tests prove [C7,#3554]', () => {
  for (const script of ['packages/codemap/src/io/cells/scripts/plan.js', 'packages/gate/src/io/edges.js']) execFileSync(process.execPath, [script, ...(script.endsWith('plan.js') ? ['--check'] : ['--no-cold-load'])], { cwd: ROOT, stdio: 'pipe' });
});

test('items.io-claim.show-read-boundary: clause 1: CLI and store queries use selected dependency, timing, identity and derived-family exports from the items light door, while family projection stays synchronous and identity follows the live claim [C7]', t => {
  const consumers = [
    ['apps/cli/src/io/read.js', ['seatFamily', 'dependencyReferences', 'dependencyLabel', 'dependencyValues']],
    ['apps/cli/src/io/commands/show.js', ['frozenCheckTiming']],
    ['apps/cli/src/io/item/folder/identity.js', ['ITEM_MARKER_FILE', 'itemFolderIdentity', 'itemFolderPath']],
    ['packages/store/src/io/board/query.js', ['withDerivedFamily', 'withDerivedFamilies']],
  ].map(([path, names]) => [path, names, readFileSync(join(ROOT, path), 'utf8')]);
  const light = readFileSync(join(ROOT, 'packages/items/light.js'), 'utf8');
  const definingLeaves = {
    dependencyReferences: './src/logic/dependencies.js', dependencyLabel: './src/logic/dependencies.js', dependencyValues: './src/logic/dependencies.js',
    frozenCheckTiming: './src/logic/check/timing.js', ITEM_MARKER_FILE: './src/io/claim.js', itemFolderIdentity: './src/io/claim.js', itemFolderPath: './src/io/claim.js',
    seatFamily: './src/io/declaration.js', withDerivedFamily: './src/io/declaration.js', withDerivedFamilies: './src/io/declaration.js',
  };
  for (const [name, sourcePath] of Object.entries(definingLeaves)) {
    const leafExport = new RegExp(String.raw`export\s+\{[^}]*\b${name}\b[^}]*\}\s+from ['"]${sourcePath.replaceAll('.', '\\.') }['"]`, 'su');
    assert.match(light, leafExport, `${name} is exported from its defining leaf`);
  }
  for (const [path, names, source] of consumers) for (const name of names) {
    const fromLight = new RegExp(String.raw`(?:import|export)\s+\{[^}]*\b${name}\b[^}]*\}\s+from ['"][^'"]*items/light\.js['"]`, 'su');
    const fromIndex = new RegExp(String.raw`(?:import|export)\s+\{[^}]*\b${name}\b[^}]*\}\s+from ['"][^'"]*items/index\.js['"]`, 'su');
    assert.match(source, fromLight, `${path} reads ${name} from the selective light door`);
    assert.doesNotMatch(source, fromIndex, `${path} does not read ${name} from the broad index`);
  }
  assert.match(consumers[2][2], /writeItemMarker[\s\S]*items\/light\.js/u, 'the existing marker writer stays on its current door');

  const board = { executionEngineVersion: 0, db: { prepare: () => ({ get: () => ({ family: 'OpenAI' }) }) } };
  const projected = read.withDerivedFamily(board, { agent_id: 'core-1', name: 'seat' });
  assert.deepEqual(projected, { agent_id: 'core-1', name: 'seat', agent_family: 'OpenAI' });
  assert.equal(projected instanceof Promise, false, 'family projection is synchronous');

  const { root, write } = privateFixtureFiles('items-read-door-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const seat = join(root, 'seat');
  const item = read.itemFolderPath(seat, 7);
  runFixtureSetupGit(['init', '-q'], { cwd: seat });
  runFixtureSetupGit(['config', 'user.name', 'Pullboard test'], { cwd: seat });
  runFixtureSetupGit(['config', 'user.email', 'pullboard-test@example.invalid'], { cwd: seat });
  write('seat/README.md', 'fixture\n');
  runFixtureSetupGit(['add', 'README.md'], { cwd: seat });
  runFixtureSetupGit(['commit', '-qm', 'fixture'], { cwd: seat });
  runFixtureSetupGit(['worktree', 'add', '-qb', 'core/item-7', item], { cwd: seat });
  writeItemMarker(item, 'core-1', 7);
  let owner = 'core-1';
  const claimBoard = {
    db: {
      prepare: sql => ({
        get: value => {
          if (sql.includes('LEFT JOIN board_meta model')) return { agent_id: value, agent_lane: 'core', agent_path: seat, agent_route: 'mid', agent_model: 'test' };
          if (sql.includes('item_status, item_owner, item_built_by')) return { item_status: 'claimed', item_owner: owner, item_built_by: null };
          return null;
        },
      }),
    },
  };
  assert.equal(read.itemFolderIdentity(claimBoard, item)?.agent.agent_id, 'core-1', 'the live owner resolves the item folder');
  owner = 'core-2';
  assert.equal(read.itemFolderIdentity(claimBoard, item), null, 'the same marker stops resolving after the live claim moves');
});
