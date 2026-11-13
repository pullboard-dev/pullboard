/** Import-cut filing uses the committed plan, real CLI and real source graphs [C7,D3,CD64]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { copyFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../e2e.js';
import { runFixtureChild } from '../child.js';
import { importCuts } from '../../../../../packages/codemap/index.js';
import { cutItemCommands } from '../../../../../packages/codemap/index.js';
import { cutBrief } from '../../../../../packages/codemap/index.js';
import { readPathMap } from '../../../../../packages/codemap/index.js';
import { mappedPath } from '../../../../../packages/codemap/index.js';
import { checkCuts } from '../../../../../packages/codemap/src/io/cells/plan/cuts.js';
import { retiredProblems } from '../../../../../packages/codemap/index.js';
import { writePlan } from '../../../../../packages/codemap/index.js';
import { computePlan } from '../../../../../packages/codemap/index.js';

/** Initialize a private real board with the same citation vocabulary as the generated cut items. */
function board(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('test ! -f RED', helpers.sandbox(), { withWorktree: false });
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  config.lanes = { core: { owns: ['src/', 'bin/', 'test/'], specs: ['C7', 'D3'] } };
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify(config));
  writeFileSync(join(box.repo, 'SPEC.md'), readFileSync(join(box.repo, 'SPEC.md'), 'utf8') + '\n- C7 [approved, must] Checks run. | gate: review\n- D3 [approved, must] One doctrine applies. | gate: review\n');
  writeFileSync(join(box.repo, 'DOCTRINE.md'), readFileSync(join(box.repo, 'DOCTRINE.md'), 'utf8') + '\n- CD64 [approved, must] Cells restructure leaf first. | gate: review\n');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: private cut filing board [C7,D3]');
  return box;
}

/** Register bounded real-board and graph controls in the existing frozen cells-plan test file. */
export function installCutCases({ PLAN, BIN, fixture, git }) {
  test('testkit is test support and production imports are refused by name [C7,D3,CD64]', t => {
    const { root, put } = fixture(t), plan = computePlan(root), group = importCuts(plan)[0], edge = group.edges[0];
    put(edge.from, 'export const detached = true;\n');
    put('package.json', JSON.stringify({ type: 'module', imports: { '#testkit/*': './packages/testkit/src/*' } }));
    put('packages/testkit/src/helper.js', `import ${JSON.stringify('../../../' + edge.to)}; export const helper = true;\n`);
    put('test/consumer.test.js', "import '#testkit/helper.js';\n");
    assert.deepEqual(checkCuts(root, plan, group.cell), [], 'test support can import later cells without entering the production cut');
    put('src/cli.js', "import '#testkit/helper.js';\n");
    assert.match(checkCuts(root, plan, group.cell).join('\n'), /production imports testkit: src\/cli\.js -> packages\/testkit\/src\/helper\.js/u);
  });

  test('retired anchors preserve provenance only while both endpoints and their live imports are absent [C7,D3,CD64]', t => {
    const { root, put } = fixture(t), plan = computePlan(root), group = importCuts(plan)[0], edge = group.edges[0];
    const provider = plan.cells.find(cell => cell.name === edge.target);
    const index = provider.paths.findIndex(row => row[0] === edge.to);
    const original = provider.paths.splice(index, 1)[0];
    plan.retired = [{ cell: provider.name, row: [...original] }];
    put(edge.from, 'export const detached = true;\n');
    rmSync(join(root, edge.to));
    assert.deepEqual(retiredProblems(root, plan), []);
    assert.equal(importCuts(plan)[0].edges[0].to, edge.to, 'historical declaration keeps its exact source identity');
    assert.deepEqual(plan.retired[0].row, original, 'future target and placement provenance are unchanged');
    assert.deepEqual(checkCuts(root, plan, group.cell), []);
    put(original[1], 'export const present = true;\n');
    assert.ok(retiredProblems(root, plan).some(problem => problem.includes(original[1])), 'an existing future target cannot retire');
    rmSync(join(root, original[1]));
    put(original[0], 'export const present = true;\n');
    assert.ok(retiredProblems(root, plan).some(problem => problem.includes(original[0])), 'an existing original cannot retire');
    rmSync(join(root, original[0]));
    symlinkSync('missing-retired-target', join(root, original[0]));
    assert.ok(retiredProblems(root, plan).some(problem => problem.includes(original[0])), 'a dangling symlink is not an absent original');
    rmSync(join(root, original[0]));
    put(edge.from, `import ${JSON.stringify('./' + edge.to.slice('src/'.length))};\n`);
    assert.ok(retiredProblems(root, plan).some(problem => problem.includes('live import')), 'a dangling live import does not become a retired exemption');
    put(edge.from, `import ${JSON.stringify('../' + original[1])};\n`);
    assert.ok(retiredProblems(root, plan).some(problem => problem.includes(original[1])), 'a live import of the absent future target also refuses');
    put('package.json', JSON.stringify({ type: 'module', imports: { '#retired': './' + original[0] } }));
    put(edge.from, "import '#retired';\n");
    assert.ok(retiredProblems(root, plan).some(problem => problem.includes(original[0])), 'a real package import alias cannot conceal a retired endpoint');
    put(edge.from, `import ${JSON.stringify('../' + provider.frontDoor)};\n`);
    put(provider.frontDoor, 'export const replacement = true;\n');
    assert.deepEqual(retiredProblems(root, plan), []);
    assert.ok(checkCuts(root, plan, group.cell).some(problem => problem.includes(provider.frontDoor)), 'actual replacement backedges remain refused');
  });
  test('the committed plan dry run names every cut occurrence once without filing or a move dependency [C7,D3,CD64]', t => {
    const groups = importCuts(PLAN), commands = cutItemCommands(PLAN);
    const expected = PLAN.cells.flatMap(cell => cell.cuts.flatMap(link => link.edges));
    assert.deepEqual(groups.flatMap(group => group.edges.map(edge => `${edge.from}->${edge.to}`)).sort(), [...expected].sort());
    assert.equal(expected.length, PLAN.totals.cutImports);
    assert.equal(groups.length, new Set(PLAN.cells.flatMap(cell => cell.cuts.map(link => link.cell))).size);
    assert.equal(new Set(groups.flatMap(group => group.edges.map(edge => edge.id))).size, expected.length);
    for (const { group, args } of commands) {
      assert.equal(args.includes('--after'), false, 'disjoint cut work does not wait on #1395 or another move');
      assert.match(args[args.indexOf('--check') + 1], /--cuts .+ && npm run gate$/u);
      const brief = args[args.indexOf('--brief') + 1];
      assert.ok(brief.length <= 8000, `the ${group.cell} brief fits the board's brief limit: ${brief.length}`);
      if (brief.includes(`--cuts ${group.cell}.`)) continue;
      for (const file of group.files) assert.ok(brief.includes(`- ${file}\n`) || brief.endsWith(`- ${file}`));
      for (const edge of group.edges) assert.ok(brief.includes(`[${edge.id}] ${edge.from} -> ${edge.to}`), edge.id);
    }
    const box = board(t);
    // Preserve the real aliases and mapped bodies, so entry claims inspect the same source as the real plan.
    const checkout = join(import.meta.dirname, '../../../../..');
    const map = readPathMap(checkout);
    const entryMap = {};
    const entryFiles = new Set();
    for (const { path } of PLAN.entries ?? []) {
      const target = mappedPath(map, path);
      if (target !== path) entryMap[path] = target;
      for (const file of new Set([path, target])) {
        entryFiles.add(file);
        const destination = join(box.repo, file);
        mkdirSync(join(destination, '..'), { recursive: true });
        // The move retired the old entry path from the checkout; its alias keeps the moved body, as the mapped path does.
        copyFileSync(join(checkout, existsSync(join(checkout, file)) ? file : target), destination);
      }
    }
    writeFileSync(join(box.repo, 'path-map.json'), JSON.stringify(entryMap));
    box.git(box.repo, 'add', '--', 'path-map.json', ...entryFiles);
    box.git(box.repo, 'commit', '-q', '-m', 'test: preserve real entry aliases [C7,D3]');
    writePlan(box.repo, PLAN);
    const dry = runFixtureChild(process.execPath, [BIN, '--file-cuts'], { cwd: box.repo, env: box.env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    assert.equal(dry.status, 0, dry.stdout + dry.stderr);
    assert.equal(dry.stdout.split('\n').filter(line => line.startsWith('pullboard ')).length, groups.length);
    for (const group of groups) for (const edge of group.edges) assert.equal(dry.stdout.split(`[${edge.id}]`).length - 1, 1, edge.id);
    assert.deepEqual(JSON.parse(box.run(box.repo, 'list', 'core', '--all', '--json').out).items, [], 'default mode leaves the real private board empty');
    const missing = PLAN.entries.find(entry => entry.path.startsWith('bin/'));
    const unplaced = structuredClone(PLAN);
    unplaced.stays = unplaced.stays.filter(row => row.path !== missing.path);
    for (const cell of unplaced.cells) cell.paths = cell.paths.filter(([from]) => from !== missing.path);
    assert.throws(() => writePlan(box.repo, unplaced), error => error.code === 'CELLS_ENTRY' && error.message.includes(missing.path),
      'an actual entry without file placement is still refused by name');
  });

  test('a cell with more cuts than one brief holds files with every edge, or a pointer, under the limit [C7,D3,CD64]', () => {
    const edge = n => ({ id: `wide->deep:${n}`, from: `src/wide-${n}.js`, to: `src/deep-${n}.js`, how: n % 2 ? 'invert the dependency by passing the provider operation or state through an explicit caller-supplied port' : 'move the shared pure definition below both cells, retaining the provider front door' });
    const group = (count) => { const edges = Array.from({ length: count }, (_, n) => edge(n)); return { cell: 'wide', edges, files: [...new Set(edges.flatMap(e => [e.from, e.to]))].sort() }; };
    const compact = cutBrief(group(50), 'node packages/codemap/src/io/cells/scripts/plan.js --cuts wide && npm run gate');
    assert.ok(compact.length <= 8000 && compact.includes('strategy by letter'), `fifty edges keep every edge, each strategy once: ${compact.length}`);
    for (const e of group(50).edges) assert.ok(compact.includes(`[${e.id}] ${e.from} -> ${e.to} (`), e.id);
    const pointer = cutBrief(group(400), 'node packages/codemap/src/io/cells/scripts/plan.js --cuts wide && npm run gate');
    assert.ok(pointer.length <= 8000 && pointer.includes('node packages/codemap/src/io/cells/scripts/plan.js --cuts wide.'), `four hundred edges point to the full list: ${pointer.length}`);
  });

  test('filing import-cut items is idempotent on a real private board with no #1395 dependency [C7,D3,CD64]', t => {
    const { root } = fixture(t), plan = computePlan(root), groups = importCuts(plan);
    assert.equal(groups.length, 1, 'the real fixture cycle has one importing cell to cut');
    const box = board(t);
    writePlan(box.repo, plan);
    /** Invoke the production plan CLI with the private real board and unchanged joined CLI shim. */
    const file = () => runFixtureChild(process.execPath, [BIN, '--file-cuts', '--yes'], { cwd: box.repo, env: box.env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    const first = file();
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const before = JSON.parse(box.run(box.repo, 'list', 'core', '--all', '--json').out).items;
    assert.equal(before.length, 1);
    assert.equal(before[0].item_after, '', 'the actual filed item can start before move tooling');
    assert.match(before[0].item_check, /--cuts .+ && npm run gate$/u);
    const second = file();
    assert.equal(second.status, 0, second.stdout + second.stderr);
    assert.match(second.stdout, /import cuts already #/u);
    const after = JSON.parse(box.run(box.repo, 'list', 'core', '--all', '--json').out).items;
    assert.deepEqual(after.map(item => [item.item_id, item.item_title, item.item_after, item.item_brief]), before.map(item => [item.item_id, item.item_title, item.item_after, item.item_brief]));
  });

  test('the cut check rejects direct imports and hidden shims but accepts an actual removed dependency [C7,D3,CD64]', t => {
    const { root, put } = fixture(t), plan = computePlan(root), group = importCuts(plan)[0];
    writePlan(root, plan);
    const red = runFixtureChild(process.execPath, [BIN, '--cuts', group.cell], { cwd: root, encoding: 'utf8' });
    assert.equal(red.status, 1, red.stdout + red.stderr);
    assert.match(red.stderr, /still imports later/u);
    assert.ok(checkCuts(root, plan, group.cell).length > 0, 'the real original edge is red');
    const edge = group.edges[0];
    const target = `./${edge.to.slice('src/'.length)}`;
    put(edge.from, 'export const detached = true;\n');
    assert.deepEqual(checkCuts(root, plan, group.cell), [], 'the actual dependency is gone');
    const green = runFixtureChild(process.execPath, [BIN, '--cuts', group.cell], { cwd: root, encoding: 'utf8' });
    assert.equal(green.status, 0, green.stdout + green.stderr);
    const lower = plan.cells.find(cell => cell.order < group.order);
    const shared = `${lower.root}/src/logic/extracted.js`;
    put(shared, 'export const detached = true;\n');
    put('path-map.json', JSON.stringify({ [edge.to]: shared }));
    put(edge.from, `import ${JSON.stringify('../' + shared)}; export const detached = true;\n`);
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'fixture: extract shared code into the lower cell');
    assert.deepEqual(checkCuts(root, plan, group.cell), [], 'actual lower-cell ownership wins over the extracted definition historic alias');
    put(shared, `import ${JSON.stringify('../../../../' + edge.to)};\nexport const detached = true;\n`);
    assert.deepEqual(checkCuts(root, plan, group.cell), [], 'the lower cell owns its genuine later import, so this cut passes independently');
    put(shared, 'await import(name);\n');
    assert.ok(checkCuts(root, plan, group.cell).some(problem => problem.includes('cannot prove')),
      'a lower-cell computed-loader forwarder still blocks this cut');
    put(shared, `export * from ${JSON.stringify('../../../../' + edge.to)};\n`);
    assert.ok(checkCuts(root, plan, group.cell).some(problem => problem.includes(`${shared} -> ${edge.to}`)), 'moving a forwarding shim into a lower planned cell cannot conceal the original dependency');
    put(shared, 'export const detached = true;\n');
    assert.deepEqual(checkCuts(root, plan, group.cell), [], 'restoring a genuine pure extraction restores the cut');
    put('src/cut-forward.js', `import ${JSON.stringify(target)};\nexport const detached = true;\n`);
    put(edge.from, "import './cut-forward.js'; export const detached = true;\n");
    assert.deepEqual(checkCuts(root, plan, group.cell), [], 'an unassigned genuine module has its own later import, outside this cut');
    put('src/cut-forward.js', `export * from ${JSON.stringify(target)};\n`);
    assert.match(checkCuts(root, plan, group.cell).join('\n'), /cut-forward.js -> /u, 'an unassigned forwarding shim cannot hide the same provider');
    const provider = plan.cells.find(cell => cell.name === edge.target);
    put(provider.frontDoor, `export * from ${JSON.stringify('../../' + edge.to)};\n`);
    put(edge.from, `import ${JSON.stringify('../' + provider.frontDoor)}; export const detached = true;\n`);
    assert.match(checkCuts(root, plan, group.cell).join('\n'), new RegExp(provider.frontDoor.replaceAll('.', '\\.')), 'a new provider front door remains the forbidden cell');
    put(edge.from, "await import(name); export const detached = true;\n");
    assert.ok(checkCuts(root, plan, group.cell).some(problem => problem.includes('cannot prove')), 'a computed loader cannot claim the cut is proven');
  });

  test('declared loaders retain lower and later edges through transitive forwarding shims [C7,D3,CD64]', t => {
    const { root, put } = fixture(t), plan = computePlan(root), group = importCuts(plan)[0], edge = group.edges[0];
    const lower = plan.cells.find(cell => cell.order < group.order);
    const shared = `${lower.root}/src/logic/loader.js`, bridge = `${lower.root}/src/logic/bridge.js`;
    const leaf = `${lower.root}/src/logic/leaf.js`, lowerGlob = `${lower.root}/src/logic/leaf*.js`;
    put(leaf, 'export const value = true;\n');
    put(edge.from, `/** @pullboard-module-loads ${lowerGlob} */\nexport async function load(name) { return import(name); }\n`);
    assert.deepEqual(checkCuts(root, plan, group.cell), [], 'a declared own loader into a lower cell passes');
    put(edge.from, `/** @pullboard-module-loads ${edge.to} */\nexport async function load(name) { return import(name); }\n`);
    assert.ok(checkCuts(root, plan, group.cell).some(problem => problem.includes(`${edge.from} -> ${edge.to}`)), 'a declared later-cell edge is reported');
    put(edge.from, 'export async function load(name) { return import(name); }\n');
    assert.ok(checkCuts(root, plan, group.cell).some(problem => problem.includes('cannot prove')), 'an undeclared loader stays unknown');
    put(edge.from, `import ${JSON.stringify('../' + shared)}; export const value = true;\n`);
    put(shared, `/** @pullboard-module-loads ${edge.to} */\nawait import(name);\n`);
    assert.ok(checkCuts(root, plan, group.cell).some(problem => problem.includes(`${shared} -> ${edge.to}`)), 'the rejected lower-cell declared forwarding counterexample remains visible');
    put(shared, `/** @pullboard-module-loads ${bridge} */\nawait import(name);\n`);
    put(bridge, `export * from ${JSON.stringify('../../../../' + edge.to)};\n`);
    assert.ok(checkCuts(root, plan, group.cell).some(problem => problem.includes(`${bridge} -> ${edge.to}`)), 'declared then literal forwarding retains the transitive later edge');
    put(bridge, `/** @pullboard-module-loads ${edge.to} */\nawait import(name);\n`);
    assert.ok(checkCuts(root, plan, group.cell).some(problem => problem.includes(`${bridge} -> ${edge.to}`)), 'two declared forwarding hops retain the later edge');
    put(bridge, `/** @pullboard-module-loads ${leaf} */\nawait import(name);\n`);
    assert.deepEqual(checkCuts(root, plan, group.cell), [], 'a transitive lower-only declared chain passes');
    for (const declaration of ['src/missing/*.js', '../outside.js', `${leaf} src/missing.js`]) {
      put(bridge, `/** @pullboard-module-loads ${declaration} */\nawait import(name);\n`);
      assert.ok(checkCuts(root, plan, group.cell).some(problem => problem.includes('cannot prove')), `invalid declaration remains unknown: ${declaration}`);
    }
    put(edge.from, `/** @pullboard-module-loads ${leaf} */\nimport './missing.js'; export async function load(name) { return import(name); }\n`);
    assert.ok(checkCuts(root, plan, group.cell).some(problem => problem.includes('cannot prove')), 'a declaration cannot erase an unrelated unresolved literal import');
  });

  test('closed historical cuts accept exact lower ownership while higher or missing placement still refuses [C7,D3,CD64]', t => {
    const { root, put } = fixture(t), plan = computePlan(root), group = importCuts(plan)[0], edge = group.edges[0];
    const importer = plan.cells.find(cell => cell.name === group.cell);
    const original = plan.cells.find(cell => cell.name === edge.target);
    const index = original.paths.findIndex(row => row[0] === edge.to);
    const row = original.paths.splice(index, 1)[0], extracted = 'src/lower-extracted.js';
    const body = readFileSync(join(root, edge.to), 'utf8');
    row[1] = extracted; importer.paths.push(row);
    put(extracted, body); rmSync(join(root, edge.to));
    put(edge.from, "import './lower-extracted.js'; export const native = true;\n");
    assert.equal(importCuts(plan)[0].edges[0].to, edge.to, 'the original cut identity is retained');
    assert.deepEqual(checkCuts(root, plan, group.cell), [], 'actual lower ownership closes the historical cut without an alias');
    const higher = structuredClone(plan), higherImporter = higher.cells.find(cell => cell.name === importer.name);
    const moved = higherImporter.paths.splice(higherImporter.paths.findIndex(value => value[0] === edge.to), 1)[0];
    higher.cells.find(cell => cell.order > original.order).paths.push(moved);
    assert.throws(() => importCuts(higher), /cut import is outside its named cells/u, 'later ownership cannot close an earlier historical cut');
    const missing = structuredClone(plan);
    missing.cells.find(cell => cell.name === importer.name).paths = importer.paths.filter(value => value[0] !== edge.to);
    assert.throws(() => importCuts(missing), /cut import is outside its named cells/u, 'missing historical placement never grants an exemption');
    put(original.frontDoor, 'export const real = true;\n');
    put(edge.from, `import ${JSON.stringify('../' + original.frontDoor)}; export const native = true;\n`);
    assert.ok(checkCuts(root, plan, group.cell).some(problem => problem.includes(original.frontDoor)),
      'an actual live later-cell backedge still refuses after a valid lower extraction');
  });

}
