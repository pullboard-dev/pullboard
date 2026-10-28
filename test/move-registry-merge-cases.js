/** Independent feature branches must own independent registry contracts [C7,V4]. */
import assert from 'node:assert/strict';
import {
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
import { runFixtureChild } from './fixture-child.js';
import { unpackRelease } from './release-archive.js';
import { historyProblems } from './move-registry-history.js';
import { readEngineLeaves } from '../src/engine-numbers.js';
import { assignEngineNumbers } from '../src/engine-numbers.js';

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
  writeFileSync(join(root, `src/${name}-engine.js`), `import { unassignedEngine } from './engine-next.js';\nexport const ${symbol} = unassignedEngine();\n`);
  writeFileSync(join(root, `src/moves/${name}.js`), `import { ${symbol} } from '../${name}-engine.js';
/** Return this feature's discovered engine without changing a shared number. */
function minimumEngine() { return ${symbol}; }
/** Bind the explicit options actor. */
function actor(move) { return move.args[1]?.agentId ?? null; }
export default { operation: '${name}', engine: ${symbol}, minimumEngine, actor,
itemIdFirstArgument: true, nextSteps: { ${name.toUpperCase()}: 'repair the independent ${name} move' } };
`);

}

/** Register the same-base merge proof without recursively running itself in its fixture. */
export function installRegistryMergeCase() {
  if (process.env.PULLBOARD_REGISTRY_MERGE_CHILD === '1') return;
  test('history allocation reads source bytes without executing code or following source symlinks [C7,V4]', t => {
    const root = mkdtempSync(join(tmpdir(), 'pullboard-registry-source-only-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'src', 'moves'), { recursive: true });
    mkdirSync(join(root, 'src', 'move-history'));
    writeFileSync(join(root, 'src', 'move-history', 'legacy.json'), '{}');
    writeFileSync(join(root, 'src', 'base-engine.js'), 'export const BASE_ENGINE = 148;\n');
    /** Build a leaf placeholder without importing any candidate module. */
    const pending = name => `import { unassignedEngine } from './engine-next.js';\nexport const ${name}_ENGINE = unassignedEngine();\n`;
    writeFileSync(join(root, 'src', 'alpha-engine.js'), pending('ALPHA'));
    const source = "throw new Error('CANDIDATE_SOURCE_MUST_NEVER_EXECUTE');\n";
    writeFileSync(join(root, 'src', 'moves', 'sample.js'), source);
    assert.deepEqual(assignEngineNumbers(root).assigned, [{ name: 'ALPHA_ENGINE', number: 149 }]);
    const frozen = readFileSync(join(root, 'src', 'move-history', '149.json'), 'utf8');
    assert.equal(JSON.parse(frozen).declarations['sample.js'], source, 'the producer freezes bytes without evaluating declarations');
    writeFileSync(join(root, 'outside.txt'), 'PRIVATE_FIXTURE_CONTENT');
    symlinkSync(join(root, 'outside.txt'), join(root, 'src', 'moves', 'external.js'));
    writeFileSync(join(root, 'src', 'beta-engine.js'), pending('BETA'));
    assert.throws(() => assignEngineNumbers(root), /regular move declaration/u, 'a candidate symlink cannot copy unrelated local bytes into history');
    assert.equal(existsSync(join(root, 'src', 'move-history', '150.json')), false, 'the refused source is never persisted in a record');
    assert.equal(readFileSync(join(root, 'src', 'beta-engine.js'), 'utf8'), pending('BETA'), 'source refusal restores the exact placeholder bytes');
    unlinkSync(join(root, 'src', 'moves', 'external.js'));
    assert.deepEqual(assignEngineNumbers(root).assigned, [{ name: 'BETA_ENGINE', number: 150 }], 'fixing the source permits an ordinary retry');
    assert.equal(JSON.parse(readFileSync(join(root, 'src', 'move-history', '150.json'), 'utf8')).engine, 150);
    writeFileSync(join(root, 'src', 'gamma-engine.js'), pending('GAMMA'));
    const collision = join(root, 'src', 'move-history', '151.json');
    writeFileSync(collision, 'EXISTING_RECORD_BYTES');
    assert.throws(() => assignEngineNumbers(root), { code: 'EEXIST' }, 'allocation never overwrites an existing record');
    assert.equal(readFileSync(collision, 'utf8'), 'EXISTING_RECORD_BYTES');
    assert.equal(readFileSync(join(root, 'src', 'gamma-engine.js'), 'utf8'), pending('GAMMA'), 'record collision restores the exact placeholder too');
    unlinkSync(collision);
    assert.deepEqual(assignEngineNumbers(root).assigned, [{ name: 'GAMMA_ENGINE', number: 151 }], 'resolving the collision permits an ordinary retry');

    assert.equal(readFileSync(join(root, 'src', 'move-history', '149.json'), 'utf8'), frozen, 'allocation never rewrites the preceding frozen record');
  });

  test('two move items from one main merge without a snapshot conflict [C7,V4]', t => {
    const directory = mkdtempSync(join(tmpdir(), 'pullboard-registry-merge-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const root = join(directory, 'repo');
    mkdirSync(root);
    unpackRelease('HEAD', root);
    run(root, 'git', ['init', '-b', 'main']);
    commit(root, 'fixture base');
    run(root, 'git', ['checkout', '-b', 'alpha']);
    addFeature(root, 'seedMergeAlpha', 'SEED_MERGE_ALPHA_ENGINE');
    commit(root, 'first independent move');
    run(root, 'git', ['checkout', '-b', 'beta', 'main']);
    addFeature(root, 'seedMergeBeta', 'SEED_MERGE_BETA_ENGINE');
    commit(root, 'second independent move');
    run(root, 'git', ['-c', 'user.name=Registry Fixture', '-c', 'user.email=registry@example.test', 'merge', '--no-edit', 'alpha']);
    assert.equal(run(root, 'git', ['diff', '--name-only', '--diff-filter=U']), '', 'the two feature contracts merge without hand editing');
    const shared = ['src/engine.js', 'src/relay-sender.js', 'src/next-step-words.js', 'test/move-registry-baseline.json', 'src/move-history'];
    assert.equal(run(root, 'git', ['diff', 'main', '--', ...shared]), '', 'neither move edits a consumer or the legacy golden');
    const output = run(root, process.execPath, ['--test', '--test-reporter=tap', 'test/move-registry.test.js'], { PULLBOARD_REGISTRY_MERGE_CHILD: '1' });
    assert.match(output, /# fail 0\b/u, 'the merged tree passes every nonrecursive registry oracle');
    // Allocation is the normal landing producer, not a hand-written record in either feature.
    const allocation = JSON.parse(run(root, process.execPath, ['--input-type=module', '-e',
      "import {assignEngineNumbers} from './src/engine-numbers.js'; console.log(JSON.stringify(assignEngineNumbers(process.cwd())));"]));
    assert.equal(allocation.assigned.length, 2);
    const numbers = allocation.assigned.map(entry => entry.number);
    assert.equal(numbers[1], numbers[0] + 1, 'independent placeholders take distinct consecutive landing allocations');
    for (const number of numbers) assert.ok(allocation.files.includes(`src/move-history/${number}.json`));
    run(root, 'git', ['add', '.']);
    run(root, 'git', ['-c', 'user.name=Registry Fixture', '-c', 'user.email=registry@example.test', 'commit', '--amend', '--no-edit']);
    assert.equal(run(root, 'git', ['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(' ').length, 3, 'allocated records belong to the real merge commit, as at landing');
    const allocatedOutput = run(root, process.execPath, ['--test', '--test-reporter=tap', 'test/move-registry.test.js'], { PULLBOARD_REGISTRY_MERGE_CHILD: '1' });
    assert.match(allocatedOutput, /# fail 0\b/u, 'the allocated merged tree passes every registry oracle too');
    const leaves = readEngineLeaves(join(root, 'src'));
    const git = (...args) => run(root, 'git', args);
    const frozen = `src/move-history/${numbers[0]}.json`;
    const bytes = readFileSync(join(root, frozen), 'utf8');
    writeFileSync(join(root, frozen), `${bytes} `);
    assert.ok(historyProblems(root, leaves, git).includes(`frozen engine record changed: ${frozen}`), 'editing a shipped record fails even when its JSON meaning is unchanged');
    const env = { ...process.env, PULLBOARD_REGISTRY_MERGE_CHILD: '1' };
    delete env.NODE_TEST_CONTEXT;
    const negative = runFixtureChild(process.execPath, ['--test', '--test-reporter=tap', 'test/move-registry.test.js'],
      { cwd: root, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    assert.equal(negative.status, 1, `${negative.stdout}\n${negative.stderr}`);
    assert.match(negative.stdout, /frozen engine record changed/u, 'the real registry check rejects the edited record');
    assert.match(negative.stdout, /# fail 1\b/u, 'only the immutable-history guard is red');

    writeFileSync(join(root, frozen), bytes);
    assert.deepEqual(historyProblems(root, leaves, git), [], 'restoring the exact bytes restores the guard');
    const legacy = 'src/move-history/legacy.json';
    const legacyBytes = readFileSync(join(root, legacy), 'utf8');
    const historical = JSON.parse(legacyBytes).engines.slice(0, 2);
    const originalLeaves = historical.map(entry => readFileSync(join(root, 'src', entry.file), 'utf8'));
    for (const [index, entry] of historical.entries()) writeFileSync(join(root, 'src', entry.file),
      originalLeaves[index].replace(`= ${entry.number};`, `= ${historical[1 - index].number};`));
    assert.ok(historyProblems(root, readEngineLeaves(join(root, 'src')), git).some(problem => problem.startsWith('historical engine identity changed:')), 'swapping distinct legacy numbers fails despite retaining uniqueness');
    for (const [index, entry] of historical.entries()) writeFileSync(join(root, 'src', entry.file), originalLeaves[index]);
    assert.deepEqual(historyProblems(root, readEngineLeaves(join(root, 'src')), git), []);

    writeFileSync(join(root, legacy), `${legacyBytes} `);
    assert.ok(historyProblems(root, leaves, git).includes(`frozen engine record changed: ${legacy}`), 'the one legacy record is frozen too');

  });
}
