/** Independent feature branches must own independent registry contracts [C7,V4]. */
import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../child.js';
import { runFixtureChild } from '../../child.js';
import { runFixtureChildAsync } from '../../child.js';
import { unpackRelease } from '../../release/archive.js';
import { historyProblems } from './history.js';
import {
  ENGINE_FOLDER,
  assignEngineNumbers,
  readEngineLeaves,
} from '../../../../../../packages/state/src/io/engine/numbers.js';
import { repoPath } from '../../../../../../packages/kernel/light.js';

/** Run real Git or a real registry child and preserve its diagnostics. */
function run(root, command, args, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.NODE_TEST_CONTEXT;
  const result = runFixtureChild(command, args, { cwd: root, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

/** Commit fixture files in its own initialized repository with an explicit fixture identity. */
function commit(root, message) {
  run(root, 'git', ['add', '.']);
  run(root, 'git', ['-c', 'user.name=Registry Fixture', '-c', 'user.email=registry@example.test', 'commit', '-m', message]);
}

/** Add one source move, one engine leaf and no shared registry or history edit. */
function addFeature(root, name, symbol) {
  writeFileSync(join(root, `packages/state/src/logic/engines/${name}-engine.js`), `import { unassignedEngine } from './engine-next.js';\nexport const ${symbol} = unassignedEngine();\n`);
  writeFileSync(join(root, `packages/moves/src/logic/moves/${name}.js`), `import { ${symbol} } from '../../../../state/src/logic/engines/${name}-engine.js';
/** Return this feature's discovered engine without changing a shared number. */
function minimumEngine() { return ${symbol}; }
/** Bind the explicit options actor. */
function actor(move) { return move.args[1]?.agentId ?? null; }
export default { operation: '${name}', engine: ${symbol}, minimumEngine, actor,
itemIdFirstArgument: true, nextSteps: { ${name.toUpperCase()}: 'repair the independent ${name} move' } };
`);

}

/** The registry suite as a child in `root`, with the merge case switched off so the child cannot recurse; settles to the child's result. */
function registryChild(root) {
  const env = { ...process.env, PULLBOARD_REGISTRY_MERGE_CHILD: '1' };
  delete env.NODE_TEST_CONTEXT;
  return runFixtureChildAsync(process.execPath, ['--test', '--test-reporter=tap', 'apps/cli/journeys/move/registry.test.js'],
    { cwd: root, env, maxBuffer: 32 * 1024 * 1024 });
}

/** Register the same-base merge proof without recursively running itself in its fixture. */
export function installRegistryMergeCase() {
  if (process.env.PULLBOARD_REGISTRY_MERGE_CHILD === '1') return;
  test('history allocation reads source bytes without executing code or following source symlinks [C7,V4]', t => {
    const root = mkdtempSync(join(tmpdir(), 'pullboard-registry-source-only-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'src/moves'), { recursive: true });
    mkdirSync(join(root, 'packages/state/data/history'), { recursive: true });
    writeFileSync(join(root, 'packages/state/data/history/legacy.json'), '{}');
    const engines = join(root, 'packages/state/src/logic/engines');
    mkdirSync(engines, { recursive: true });
    writeFileSync(join(engines, 'base-engine.js'), 'export const BASE_ENGINE = 148;\n');
    /** Build a leaf placeholder without importing any candidate module. */
    const pending = name => `import { unassignedEngine } from './engine-next.js';\nexport const ${name}_ENGINE = unassignedEngine();\n`;
    writeFileSync(join(engines, 'alpha-engine.js'), pending('ALPHA'));
    const source = "throw new Error('CANDIDATE_SOURCE_MUST_NEVER_EXECUTE');\n";
    writeFileSync(join(root, 'src/moves/sample.js'), source);
    assert.deepEqual(assignEngineNumbers(root).assigned, [{ name: 'ALPHA_ENGINE', number: 149 }]);
    const frozen = readFileSync(join(root, 'packages/state/data/history/149.json'), 'utf8');
    assert.equal(JSON.parse(frozen).declarations['sample.js'], source, 'the producer freezes bytes without evaluating declarations');
    writeFileSync(join(root, 'outside.txt'), 'PRIVATE_FIXTURE_CONTENT');
    symlinkSync(join(root, 'outside.txt'), join(root, 'src/moves/external.js'));
    writeFileSync(join(engines, 'beta-engine.js'), pending('BETA'));
    assert.throws(() => assignEngineNumbers(root), /regular move declaration/u, 'a candidate symlink cannot copy unrelated local bytes into history');
    assert.equal(existsSync(join(root, 'packages/state/data/history/150.json')), false, 'the refused source is never persisted in a record');
    assert.equal(readFileSync(join(engines, 'beta-engine.js'), 'utf8'), pending('BETA'), 'source refusal restores the exact placeholder bytes');
    unlinkSync(join(root, 'src/moves/external.js'));
    assert.deepEqual(assignEngineNumbers(root).assigned, [{ name: 'BETA_ENGINE', number: 150 }], 'fixing the source permits an ordinary retry');
    assert.equal(JSON.parse(readFileSync(join(root, 'packages/state/data/history/150.json'), 'utf8')).engine, 150);
    writeFileSync(join(engines, 'gamma-engine.js'), pending('GAMMA'));
    const collision = join(root, 'packages/state/data/history/151.json');
    writeFileSync(collision, 'EXISTING_RECORD_BYTES');
    assert.throws(() => assignEngineNumbers(root), { code: 'EEXIST' }, 'allocation never overwrites an existing record');
    assert.equal(readFileSync(collision, 'utf8'), 'EXISTING_RECORD_BYTES');
    assert.equal(readFileSync(join(engines, 'gamma-engine.js'), 'utf8'), pending('GAMMA'), 'record collision restores the exact placeholder too');
    unlinkSync(collision);
    assert.deepEqual(assignEngineNumbers(root).assigned, [{ name: 'GAMMA_ENGINE', number: 151 }], 'resolving the collision permits an ordinary retry');

    assert.equal(readFileSync(join(root, 'packages/state/data/history/149.json'), 'utf8'), frozen, 'allocation never rewrites the preceding frozen record');
  });

  test('a 0.9.3 board with its record only under src/move-history is read there and numbered into the new folder [C7,V4]', t => {
    const root = privateFixtureFiles('pullboard-registry-old-folder-').root;
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'src/moves'), { recursive: true });
    mkdirSync(join(root, 'src/move-history'), { recursive: true });
    writeFileSync(join(root, 'src/move-history/legacy.json'), '{}');
    const engines = join(root, 'packages/state/src/logic/engines');
    mkdirSync(engines, { recursive: true });
    writeFileSync(join(engines, 'base-engine.js'), 'export const BASE_ENGINE = 10;\n');
    writeFileSync(join(engines, 'alpha-engine.js'), "import { unassignedEngine } from './engine-next.js';\nexport const ALPHA_ENGINE = unassignedEngine();\n");
    writeFileSync(join(root, 'src/moves/sample.js'), 'export const sample = 1;\n');
    const result = assignEngineNumbers(root);
    assert.deepEqual(result.assigned, [{ name: 'ALPHA_ENGINE', number: 11 }]);
    assert.ok(result.files.includes('packages/state/data/history/11.json'), 'new snapshots go to the new folder only');
    assert.equal(existsSync(join(root, 'src/move-history/11.json')), false, 'the old folder is never written');
  });

  // The merge proof starts when the file loads, so its child suites run while this file's other cases do; the case below only awaits it [C7].
  const mergeProof = (async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pullboard-registry-merge-'));
    try {
      const root = join(directory, 'repo');
      mkdirSync(root);
      unpackRelease('HEAD', root);
      run(root, 'git', ['init', '-b', 'main']);
      // The base is a landed snapshot: seal its existing placeholders before the two independent feature moves.
      run(root, process.execPath, ['--input-type=module', '-e',
        "import {assignEngineNumbers} from './packages/state/src/io/engine/numbers.js'; assignEngineNumbers(process.cwd());"]);
      commit(root, 'fixture base');
      run(root, 'git', ['checkout', '-b', 'alpha']);
      addFeature(root, 'seedMergeAlpha', 'SEED_MERGE_ALPHA_ENGINE');
      commit(root, 'first independent move');
      run(root, 'git', ['checkout', '-b', 'beta', 'main']);
      addFeature(root, 'seedMergeBeta', 'SEED_MERGE_BETA_ENGINE');
      commit(root, 'second independent move');
      run(root, 'git', ['-c', 'user.name=Registry Fixture', '-c', 'user.email=registry@example.test', 'merge', '--no-edit', 'alpha']);
      assert.equal(run(root, 'git', ['diff', '--name-only', '--diff-filter=U']), '', 'the two feature contracts merge without hand editing');
      const shared = ['packages/state/src/io/engine.js', 'packages/store/src/io/board/ports.js', 'apps/cli/src/logic/step/words.js', 'apps/cli/tests/fixtures/move/registry/baseline.json', 'packages/state/data/history'];
      assert.equal(run(root, 'git', ['diff', 'main', '--', ...shared]), '', 'neither move edits a consumer or the legacy golden');
      // The three registry-suite runs (merged, allocated, edited record) each judge their own copy of the tree, so they run side by side instead of one after another [C7].
      const mergedCopy = join(directory, 'merged');
      cpSync(root, mergedCopy, { recursive: true });
      const mergedRun = registryChild(mergedCopy);
      // Allocation is the normal landing producer, not a hand-written record in either feature.
      const allocation = JSON.parse(run(root, process.execPath, ['--input-type=module', '-e',
        "import {assignEngineNumbers} from './packages/state/src/io/engine/numbers.js'; console.log(JSON.stringify(assignEngineNumbers(process.cwd())));"]));
      assert.equal(allocation.assigned.length, 2);
      const numbers = allocation.assigned.map(entry => entry.number);
      assert.equal(numbers[1], numbers[0] + 1, 'independent placeholders take distinct consecutive landing allocations');
      for (const number of numbers) assert.ok(allocation.files.includes(`packages/state/data/history/${number}.json`));
      run(root, 'git', ['add', '.']);
      run(root, 'git', ['-c', 'user.name=Registry Fixture', '-c', 'user.email=registry@example.test', 'commit', '--amend', '--no-edit']);
      assert.equal(run(root, 'git', ['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(' ').length, 3, 'allocated records belong to the real merge commit, as at landing');
      const allocatedCopy = join(directory, 'allocated');
      cpSync(root, allocatedCopy, { recursive: true });
      const allocatedRun = registryChild(allocatedCopy);
      const leaves = readEngineLeaves(join(root, 'packages/state/src/logic/engines'));
      const git = (...args) => run(root, 'git', args);
      const frozen = `packages/state/data/history/${numbers[0]}.json`;
      const bytes = readFileSync(join(root, frozen), 'utf8');
      writeFileSync(join(root, frozen), `${bytes} `);
      assert.ok(historyProblems(root, leaves, git).includes(`frozen engine record changed: ${frozen}`), 'editing a shipped record fails even when its JSON meaning is unchanged');
      const editedCopy = join(directory, 'edited');
      cpSync(root, editedCopy, { recursive: true });
      const negativeRun = registryChild(editedCopy);

      writeFileSync(join(root, frozen), bytes);
      assert.deepEqual(historyProblems(root, leaves, git), [], 'restoring the exact bytes restores the guard');
      const legacy = 'packages/state/data/history/legacy.json';
      const legacyBytes = readFileSync(join(root, legacy), 'utf8');
      const historical = JSON.parse(legacyBytes).engines.slice(0, 2);
      const originalLeaves = historical.map(entry => readFileSync(repoPath(root, `${ENGINE_FOLDER}/${entry.file}`), 'utf8'));
      for (const [index, entry] of historical.entries()) writeFileSync(repoPath(root, `${ENGINE_FOLDER}/${entry.file}`),
        originalLeaves[index].replace(`= ${entry.number};`, `= ${historical[1 - index].number};`));
      assert.ok(historyProblems(root, readEngineLeaves(join(root, ENGINE_FOLDER)), git).some(problem => problem.startsWith('historical engine identity changed:')), 'swapping distinct legacy numbers fails despite retaining uniqueness');
      for (const [index, entry] of historical.entries()) writeFileSync(repoPath(root, `${ENGINE_FOLDER}/${entry.file}`), originalLeaves[index]);
      assert.deepEqual(historyProblems(root, readEngineLeaves(join(root, ENGINE_FOLDER)), git), []);

      writeFileSync(join(root, legacy), `${legacyBytes} `);
      assert.ok(historyProblems(root, leaves, git).includes(`frozen engine record changed: ${legacy}`), 'the one legacy record is frozen too');

      const [merged, allocated, negative] = await Promise.all([mergedRun, allocatedRun, negativeRun]);
      assert.equal(merged.status, 0, `${merged.stdout}\n${merged.stderr}`);
      assert.match(merged.stdout, /# fail 0\b/u, 'the merged tree passes every nonrecursive registry oracle');
      assert.equal(allocated.status, 0, `${allocated.stdout}\n${allocated.stderr}`);
      assert.match(allocated.stdout, /# fail 0\b/u, 'the allocated merged tree passes every registry oracle too');
      assert.equal(negative.status, 1, `${negative.stdout}\n${negative.stderr}`);
      assert.match(negative.stdout, /frozen engine record changed/u, 'the real registry check rejects the edited record');
      assert.match(negative.stdout, /# fail 1\b/u, 'only the immutable-history guard is red');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  })();
  mergeProof.catch(() => {});
  test('two move items from one main merge without a snapshot conflict [C7,V4]', async () => {
    await mergeProof;
  });
}
