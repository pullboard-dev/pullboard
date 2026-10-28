/** Import-cut filing uses the committed plan, real CLI and real source graphs [C7,D3,CD64]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';
import { runFixtureChild } from './fixture-child.js';
import { importCuts } from '../src/cells-plan-cuts.js';
import { cutItemCommands } from '../src/cells-plan-cuts.js';
import { cutBrief } from '../src/cells-plan-cuts.js';
import { checkCuts } from '../bin/cells-plan-cuts.js';
import { writePlan } from '../bin/cells-plan.js';
import { computePlan } from '../bin/cells-plan.js';

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
    writePlan(box.repo, PLAN);
    const dry = runFixtureChild(process.execPath, [BIN, '--file-cuts'], { cwd: box.repo, env: box.env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    assert.equal(dry.status, 0, dry.stdout + dry.stderr);
    assert.equal(dry.stdout.split('\n').filter(line => line.startsWith('pullboard ')).length, groups.length);
    for (const group of groups) for (const edge of group.edges) assert.equal(dry.stdout.split(`[${edge.id}]`).length - 1, 1, edge.id);
    assert.deepEqual(JSON.parse(box.run(box.repo, 'list', 'core', '--all', '--json').out).items, [], 'default mode leaves the real private board empty');
  });

  test('a cell with more cuts than one brief holds files with every edge, or a pointer, under the limit [C7,D3,CD64]', () => {
    const edge = n => ({ id: `wide->deep:${n}`, from: `src/wide-${n}.js`, to: `src/deep-${n}.js`, how: n % 2 ? 'invert the dependency by passing the provider operation or state through an explicit caller-supplied port' : 'move the shared pure definition below both cells, retaining the provider front door' });
    const group = (count) => { const edges = Array.from({ length: count }, (_, n) => edge(n)); return { cell: 'wide', edges, files: [...new Set(edges.flatMap(e => [e.from, e.to]))].sort() }; };
    const compact = cutBrief(group(50), 'node bin/cells-plan.js --cuts wide && npm run gate');
    assert.ok(compact.length <= 8000 && compact.includes('strategy by letter'), `fifty edges keep every edge, each strategy once: ${compact.length}`);
    for (const e of group(50).edges) assert.ok(compact.includes(`[${e.id}] ${e.from} -> ${e.to} (`), e.id);
    const pointer = cutBrief(group(400), 'node bin/cells-plan.js --cuts wide && npm run gate');
    assert.ok(pointer.length <= 8000 && pointer.includes('node bin/cells-plan.js --cuts wide.'), `four hundred edges point to the full list: ${pointer.length}`);
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
    const shared = `${lower.root}/src/core/extracted.js`;
    put(shared, 'export const detached = true;\n');
    put('path-map.json', JSON.stringify({ [edge.to]: shared }));
    put(edge.from, `import ${JSON.stringify('../' + shared)}; export const detached = true;\n`);
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'fixture: extract shared code into the lower cell');
    assert.deepEqual(checkCuts(root, plan, group.cell), [], 'actual lower-cell ownership wins over the extracted definition historic alias');
    put(shared, `export * from ${JSON.stringify('../../../../' + edge.to)};\n`);
    assert.ok(checkCuts(root, plan, group.cell).some(problem => problem.includes(`${shared} -> ${edge.to}`)), 'moving a forwarding shim into a lower planned cell cannot conceal the original dependency');
    put(shared, 'export const detached = true;\n');
    assert.deepEqual(checkCuts(root, plan, group.cell), [], 'restoring a genuine pure extraction restores the cut');
    put('src/cut-forward.js', `export * from ${JSON.stringify(target)};\n`);
    put(edge.from, "import './cut-forward.js'; export const detached = true;\n");
    assert.match(checkCuts(root, plan, group.cell).join('\n'), /cut-forward.js -> /u, 'an unassigned forwarding shim cannot hide the same provider');
    const provider = plan.cells.find(cell => cell.name === edge.target);
    put(provider.frontDoor, `export * from ${JSON.stringify('../../' + edge.to)};\n`);
    put(edge.from, `import ${JSON.stringify('../' + provider.frontDoor)}; export const detached = true;\n`);
    assert.match(checkCuts(root, plan, group.cell).join('\n'), new RegExp(provider.frontDoor.replaceAll('.', '\\.')), 'a new provider front door remains the forbidden cell');
    put(edge.from, "await import(name); export const detached = true;\n");
    assert.ok(checkCuts(root, plan, group.cell).some(problem => problem.includes('cannot prove')), 'a computed loader cannot claim the cut is proven');
  });
}
